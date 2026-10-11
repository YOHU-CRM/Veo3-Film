/**
 * Dựng 1 cảnh ẢNH thành đoạn MP4 trên máy dựng.
 * Dùng chính mã chuyển động ảnh của giao diện (shared/imageMotion): ảnh được tách thành các khối chữ/thẻ/hình,
 * chuyển động bằng điểm ảnh gốc nên chữ không bao giờ bị đổi. Khung hình được vẽ bằng @napi-rs/canvas rồi
 * đẩy thẳng vào FFmpeg qua đường ống (rawvideo) – nhanh hơn thời gian thực, không cần trình duyệt.
 * Thư viện canvas là tùy chọn: thiếu nó thì chỉ các cảnh ảnh bị bỏ qua (kèm cảnh báo), cảnh video vẫn dựng bình thường.
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';

import {
  ImageMotionScene, prepareImage, createBackdrop, drawImageSceneFrame,
  type FitMode, type MotionStyle,
} from '../../shared/imageMotion';
import { FFMPEG } from './binaries';
import { UserError } from './proc';

const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let canvasLib: any | null | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lib(): any | null {
  if (canvasLib !== undefined) return canvasLib;
  try { canvasLib = require('@napi-rs/canvas'); } catch { canvasLib = null; }
  return canvasLib;
}

/** Máy dựng có xử lý được cảnh ảnh không (đã cài @napi-rs/canvas)? */
export const imagesSupported = (): boolean => !!lib();

export interface ImageInfo { width: number; height: number }

/** Đọc kích thước ảnh; trả null nếu ảnh hỏng hoặc không có thư viện. */
export async function probeImage(file: string): Promise<ImageInfo | null> {
  const L = lib();
  if (!L) return null;
  try {
    const img = await L.loadImage(fs.readFileSync(file));
    if (!img.width || !img.height) return null;
    return { width: img.width, height: img.height };
  } catch { return null; }
}

export interface ImageSegmentOptions {
  imagePath: string;
  /** tên file đầu ra (tương đối so với cwd) */
  outName: string;
  cwd: string;
  width: number;
  height: number;
  frames: number;
  fps: number;
  fit: FitMode;
  style: MotionStyle;
  /** đổi hướng zoom giữa các cảnh ảnh chụp */
  variant: number;
  /** file phụ đề .ass (tương đối so với cwd) hoặc null */
  assFile: string | null;
  preset: string;
  crf: string;
  signal?: AbortSignal;
  onSeconds?: (seconds: number) => void;
}

export async function renderImageSegment(o: ImageSegmentOptions): Promise<void> {
  const L = lib();
  if (!L) throw new UserError('Máy dựng chưa cài thư viện xử lý ảnh. Hãy chạy lại "npm install" trong thư mục render-server.');
  if (o.signal?.aborted) throw new Error('ABORTED');

  const factory = (w: number, h: number) => L.createCanvas(w, h);
  const img = await L.loadImage(fs.readFileSync(o.imagePath));
  const prepared = await prepareImage(img, { factory });
  const motion = new ImageMotionScene(prepared, { duration: o.frames / o.fps, style: o.style, variant: o.variant, factory });

  const canvas = L.createCanvas(o.width, o.height);
  const ctx = canvas.getContext('2d');
  const backdrop = o.fit === 'blur' ? createBackdrop(factory, o.width, o.height) : undefined;
  backdrop?.update(prepared.orig);

  const tail = o.assFile ? `,ass=${o.assFile}:fontsdir=fonts` : '';
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-nostats',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${o.width}x${o.height}`, '-r', String(o.fps), '-i', 'pipe:0',
    '-vf', `setsar=1,format=yuv420p${tail}`,
    '-frames:v', String(o.frames), '-r', String(o.fps), '-an',
    '-c:v', 'libx264', '-preset', o.preset, '-crf', o.crf, '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-g', '60', '-bf', '2',
    o.outName,
  ];
  const child = spawn(FFMPEG, args, { cwd: o.cwd, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let stderrTail = '';
  child.stderr.on('data', (c: Buffer) => { stderrTail = (stderrTail + c.toString('utf8')).slice(-4000); });
  let spawnError: Error | null = null;
  child.on('error', e => { spawnError = e; });
  child.stdin.on('error', () => { /* ffmpeg đóng sớm: lỗi sẽ được báo qua mã thoát */ });
  const closed = new Promise<number>(resolve => child.on('close', code => resolve(code ?? -1)));
  const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* đã thoát */ } };
  o.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    let last: Buffer | null = null;
    let draining: Promise<unknown> | null = null;
    for (let i = 0; i < o.frames; i++) {
      if (o.signal?.aborted) throw new Error('ABORTED');
      if (spawnError) break;
      const t = i / o.fps;
      let rgba: Buffer;
      if (last && motion.isStaticAt(t)) {
        rgba = last; // đoạn giữ khung cuối: khung giống hệt nhau, không cần vẽ lại
      } else {
        drawImageSceneFrame(ctx, motion, t, o.width, o.height, o.fit, backdrop);
        rgba = typeof canvas.data === 'function'
          ? canvas.data()
          : Buffer.from(ctx.getImageData(0, 0, o.width, o.height).data.buffer);
        last = rgba;
      }
      // Vẽ khung kế tiếp trong lúc FFmpeg còn đang nhận khung trước (chỉ chờ ngay trước khi ghi)
      if (draining) await draining;
      draining = child.stdin.write(rgba) ? null : once(child.stdin, 'drain');
      if (i % 10 === 0) o.onSeconds?.(t);
    }
    if (draining) await draining;
    child.stdin.end();
    const code = await closed;
    if (o.signal?.aborted) throw new Error('ABORTED');
    if (spawnError) throw new UserError(`Không chạy được FFmpeg. Hãy chạy lại "npm install" trong thư mục render-server. Chi tiết: ${(spawnError as Error).message}`);
    if (code !== 0) throw new Error(`ffmpeg (cảnh ảnh) thoát với mã ${code}: ${stderrTail.trim()}`);
    o.onSeconds?.(o.frames / o.fps);
  } catch (e) {
    onAbort();
    throw e;
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
  }
}
