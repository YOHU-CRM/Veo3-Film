/**
 * Quy trình dựng phim bằng FFmpeg.
 *
 *   1. Đọc & kiểm tra từng file (hỏng/thiếu -> bỏ qua kèm cảnh báo, không làm hỏng cả phim)
 *   2. Lập timeline (dùng chung với giao diện: shared/render/plan.ts)
 *   3. Dựng từng cảnh thành 1 đoạn MP4 (mỗi lần 1 cảnh -> RAM thấp, video lớn vẫn chạy)
 *   4. Nối các đoạn (copy, không mã hóa lại)
 *   5. Làm âm thanh: voice đặt đúng vị trí + nhạc nền tự giảm khi có voice
 *   6. Ghép hình + tiếng -> MP4 (faststart)
 *   7. Kiểm tra kết quả
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTimeline } from '../../shared/render/plan';
import type { RenderManifest, SceneSpec, Timeline, TimelineScene } from '../../shared/render/types';
import { buildAss } from './ass';
import { FFMPEG } from './binaries';
import { probeMedia } from './probe';
import { imagesSupported, probeImage, renderImageSegment } from './imageScene';
import { runFfmpeg, UserError } from './proc';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = path.resolve(HERE, '../fonts');

export interface RenderContext {
  /** Thư mục làm việc của job */
  dir: string;
  manifest: RenderManifest;
  /** fieldname -> đường dẫn file đã upload */
  files: Map<string, string>;
  signal: AbortSignal;
  report: (percent: number, message: string) => void;
  warn: (message: string) => void;
}

export interface RenderOutput {
  outputPath: string;
  duration: number;
  sizeBytes: number;
  width: number;
  height: number;
}

const PRESET = process.env.RENDER_PRESET || 'veryfast';
const CRF = process.env.RENDER_CRF || '20';

/** Đường dẫn tương đối (dấu /) để tránh lỗi ký tự ổ đĩa của Windows trong filter */
const rel = (dir: string, file: string) => path.relative(dir, file).split(path.sep).join('/');

interface UsableScene {
  id: string;
  label: string;
  kind: 'video' | 'image';
  /** cảnh video: file video; cảnh ảnh: file ảnh */
  videoPath: string;
  motionStyle?: import('../../shared/imageMotion').MotionStyle;
  voicePath?: string;
  spec: SceneSpec;
}

// ─────────────────────────── 1. Kiểm tra file ───────────────────────────

async function collectUsableScenes(ctx: RenderContext): Promise<UsableScene[]> {
  const usable: UsableScene[] = [];
  const total = ctx.manifest.scenes.length;

  for (let i = 0; i < total; i++) {
    const sc = ctx.manifest.scenes[i];
    const label = `Cảnh ${i + 1}`;
    ctx.report(1 + Math.round((i / Math.max(1, total)) * 6), `Đang kiểm tra file (${i + 1}/${total})...`);

    const isImage = sc.kind === 'image';
    const videoPath = ctx.files.get(isImage ? `i_${sc.id}` : `v_${sc.id}`);
    let mediaW = 0, mediaH = 0, mediaDuration = 0;
    if (isImage) {
      if (!sc.hasImage || !videoPath) {
        if (sc.hasVoice) ctx.warn(`${label}: có voice nhưng chưa có ảnh nên đã bỏ qua cảnh này.`);
        continue;
      }
      if (!imagesSupported()) {
        ctx.warn(`${label}: máy dựng chưa cài thư viện xử lý ảnh nên đã bỏ qua cảnh ảnh (chạy lại "npm install" trong render-server).`);
        continue;
      }
      const iInfo = await probeImage(videoPath);
      if (!iInfo) {
        ctx.warn(`${label}: file ảnh "${sc.imageName ?? ''}" bị hỏng hoặc không đọc được nên đã bỏ qua.`);
        continue;
      }
      mediaW = iInfo.width; mediaH = iInfo.height; mediaDuration = sc.imageDuration ?? 0;
    } else {
      if (!sc.hasVideo || !videoPath) {
        if (sc.hasVoice) ctx.warn(`${label}: có voice nhưng chưa có video nên đã bỏ qua cảnh này.`);
        continue;
      }
      const vInfo = await probeMedia(videoPath, ctx.signal);
      if (!vInfo || !vInfo.hasVideo || vInfo.duration < 0.1) {
        ctx.warn(`${label}: file video "${sc.videoName ?? ''}" bị hỏng hoặc không đọc được nên đã bỏ qua.`);
        continue;
      }
      mediaW = vInfo.width; mediaH = vInfo.height; mediaDuration = vInfo.duration;
    }

    let voicePath: string | undefined;
    let voiceDuration: number | undefined;
    if (sc.hasVoice) {
      const p = ctx.files.get(`a_${sc.id}`);
      const aInfo = p ? await probeMedia(p, ctx.signal) : null;
      if (aInfo && aInfo.hasAudio && aInfo.duration > 0.1) {
        voicePath = p;
        voiceDuration = aInfo.duration;
      } else {
        ctx.warn(`${label}: file voice "${sc.voiceName ?? ''}" bị hỏng hoặc không đọc được, cảnh này sẽ không có tiếng đọc.`);
      }
    }

    usable.push({
      id: sc.id,
      label,
      kind: isImage ? 'image' : 'video',
      motionStyle: sc.motionStyle,
      videoPath,
      voicePath,
      spec: {
        id: sc.id,
        kind: isImage ? 'image' : 'video',
        imageDuration: isImage ? sc.imageDuration : undefined,
        videoDuration: mediaDuration,
        videoWidth: mediaW,
        videoHeight: mediaH,
        voiceDuration,
        subtitleText: sc.subtitleText,
      },
    });
  }
  return usable;
}

// ─────────────────────────── 3. Dựng từng cảnh ───────────────────────────

function buildVideoGraph(
  fit: 'blur' | 'cover' | 'contain',
  W: number,
  H: number,
  clipW: number,
  clipH: number,
  assFile: string | null,
): string {
  const sameRatio = Math.abs(clipW / clipH - W / H) < 0.01;
  const tail = assFile ? `,ass=${assFile}:fontsdir=fonts` : '';
  const head = '[0:v]fps=30,';

  if (sameRatio) {
    return `${head}scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv420p${tail}[v]`;
  }
  if (fit === 'cover') {
    return `${head}scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1,format=yuv420p${tail}[v]`;
  }
  if (fit === 'contain') {
    return `${head}scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p${tail}[v]`;
  }
  // blur: nền mờ lấp đầy khung + clip nguyên vẹn ở giữa. Làm mờ trên ảnh nhỏ cho nhanh.
  const bw = Math.max(16, Math.round(W / 8));
  const bh = Math.max(16, Math.round(H / 8));
  return [
    `${head}split=2[a][b]`,
    `[a]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=4,scale=${W}:${H},eq=brightness=-0.12[bg]`,
    `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p${tail}[v]`,
  ].join(';');
}

async function renderSegments(
  ctx: RenderContext,
  usable: UsableScene[],
  timeline: Timeline,
): Promise<string[]> {
  const { settings } = ctx.manifest;
  const totalFrames = timeline.scenes.reduce((a, s) => a + s.frames, 0);
  const segments: string[] = [];
  let doneFrames = 0;
  let imageIndex = 0;

  for (const scene of timeline.scenes) {
    const src = usable[scene.index];
    const segName = `seg_${String(scene.index).padStart(4, '0')}.mp4`;
    const segPath = path.join(ctx.dir, segName);

    let assFile: string | null = null;
    if (scene.cues.length > 0) {
      assFile = `sub_${String(scene.index).padStart(4, '0')}.ass`;
      fs.writeFileSync(
        path.join(ctx.dir, assFile),
        buildAss(scene.cues, settings.subtitleStyle, timeline.width, timeline.height),
        'utf8',
      );
    }

    ctx.report(
      8 + Math.round((doneFrames / totalFrames) * 62),
      `Đang dựng cảnh ${scene.index + 1}/${timeline.scenes.length}...`,
    );

    if (src.kind === 'image') {
      await renderImageSegment({
        imagePath: src.videoPath, outName: segName, cwd: ctx.dir,
        width: timeline.width, height: timeline.height, frames: scene.frames, fps: timeline.fps,
        fit: settings.fitMode, style: src.motionStyle ?? 'auto', variant: imageIndex++,
        assFile, preset: PRESET, crf: CRF, signal: ctx.signal,
        onSeconds: sec => ctx.report(
          8 + Math.round(((doneFrames + Math.min(scene.frames, sec * timeline.fps)) / totalFrames) * 62),
          `Đang dựng cảnh ${scene.index + 1}/${timeline.scenes.length}...`,
        ),
      });
      try { fs.rmSync(src.videoPath, { force: true }); } catch { /* bỏ qua */ }
      segments.push(segName);
      doneFrames += scene.frames;
      continue;
    }

    const graph = buildVideoGraph(
      settings.fitMode, timeline.width, timeline.height,
      src.spec.videoWidth, src.spec.videoHeight, assFile,
    );

    await runFfmpeg(FFMPEG, [
      '-stream_loop', '-1',
      '-i', rel(ctx.dir, src.videoPath),
      '-filter_complex', graph,
      '-map', '[v]',
      '-frames:v', String(scene.frames),
      '-r', String(timeline.fps),
      '-an',
      '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF,
      '-pix_fmt', 'yuv420p', '-profile:v', 'high',
      '-g', '60', '-bf', '2',
      segName,
    ], {
      cwd: ctx.dir,
      signal: ctx.signal,
      onSeconds: sec => {
        const f = Math.min(scene.frames, sec * timeline.fps);
        ctx.report(
          8 + Math.round(((doneFrames + f) / totalFrames) * 62),
          `Đang dựng cảnh ${scene.index + 1}/${timeline.scenes.length}...`,
        );
      },
    });

    // Xóa file gốc của cảnh ngay khi dựng xong để tiết kiệm ổ đĩa
    try { fs.rmSync(src.videoPath, { force: true }); } catch { /* bỏ qua */ }

    segments.push(segName);
    doneFrames += scene.frames;
  }
  return segments;
}

// ─────────────────────────── 4. Nối các đoạn ───────────────────────────

async function concatSegments(ctx: RenderContext, segments: string[]): Promise<string> {
  ctx.report(71, 'Đang nối các cảnh...');
  const listFile = path.join(ctx.dir, 'concat.txt');
  fs.writeFileSync(listFile, segments.map(s => `file '${s}'`).join('\n') + '\n', 'utf8');
  await runFfmpeg(FFMPEG, [
    '-f', 'concat', '-safe', '0', '-i', 'concat.txt',
    '-c', 'copy', 'video_all.mp4',
  ], { cwd: ctx.dir, signal: ctx.signal });
  for (const s of segments) { try { fs.rmSync(path.join(ctx.dir, s), { force: true }); } catch { /* bỏ qua */ } }
  return 'video_all.mp4';
}

// ─────────────────────────── 5. Âm thanh ───────────────────────────

/** Mức âm lượng nhạc khi có voice (so với lúc không có voice) */
export const DUCK_LEVEL = 0.22; // ≈ -13 dB
const DUCK_RAMP_DOWN = 0.3;     // giây: nhạc hạ xuống TRƯỚC khi voice bắt đầu
const DUCK_RAMP_UP = 0.6;       // giây: nhạc trồi lại SAU khi voice dứt

/**
 * Biểu thức FFmpeg cho hệ số âm lượng nhạc nền theo thời gian t.
 * Biết trước từng đoạn voice nằm ở giây nào nên làm "giảm nhạc theo lịch" –
 * ổn định, không phụ thuộc giọng to hay nhỏ như bộ nén sidechain.
 */
export function duckExpression(windows: Array<{ start: number; end: number }>): string {
  if (windows.length === 0) return '1';
  const terms = windows.map(w => {
    const a = w.start - DUCK_RAMP_DOWN;
    const b = w.end + DUCK_RAMP_UP;
    return `min(1,max(0,(t-${a.toFixed(3)})/${DUCK_RAMP_DOWN}))*min(1,max(0,(${b.toFixed(3)}-t)/${DUCK_RAMP_UP}))`;
  });
  return `1-${(1 - DUCK_LEVEL).toFixed(3)}*min(1,${terms.join('+')})`;
}

/**
 * Âm thanh = voice (đặt đúng thời điểm của từng cảnh) + nhạc nền.
 * Nhạc nền tự hạ xuống khi có voice rồi trồi lại sau đó.
 */
export function buildAudioGraph(
  voices: Array<{ inputIndex: number; startSec: number; duration: number }>,
  bgmInputIndex: number | null,
  bgmVolume: number,
  total: number,
): string {
  const fmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
  const lines: string[] = [];

  if (voices.length > 0) {
    voices.forEach((v, i) => {
      const ms = Math.max(0, Math.round(v.startSec * 1000));
      lines.push(`[${v.inputIndex}:a]${fmt},adelay=${ms}|${ms}[v${i}]`);
    });
    const labels = voices.map((_, i) => `[v${i}]`).join('');
    lines.push(
      voices.length === 1
        ? `[v0]apad=whole_dur=${total.toFixed(3)}[vm]`
        : `${labels}amix=inputs=${voices.length}:normalize=0:duration=longest,apad=whole_dur=${total.toFixed(3)}[vm]`,
    );
  }

  if (bgmInputIndex !== null) {
    const vol = Math.max(0, Math.min(1, bgmVolume / 100));
    const fadeOutStart = Math.max(0, total - 2);
    const duck = duckExpression(voices.map(v => ({ start: v.startSec, end: v.startSec + v.duration })));
    const duckFilter = voices.length > 0 ? `volume='${duck}':eval=frame,` : '';
    lines.push(
      `[${bgmInputIndex}:a]${fmt},atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,volume=${vol.toFixed(3)},` +
      `${duckFilter}afade=t=in:st=0:d=1,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=2[bg]`,
    );
    lines.push(voices.length > 0 ? '[vm][bg]amix=inputs=2:normalize=0:duration=longest[mix]' : '[bg]anull[mix]');
  } else {
    lines.push('[vm]anull[mix]');
  }

  lines.push(`[mix]atrim=0:${total.toFixed(3)},alimiter=limit=0.95[aout]`);
  return lines.join(';\n');
}

async function buildAudio(
  ctx: RenderContext,
  usable: UsableScene[],
  timeline: Timeline,
): Promise<string> {
  ctx.report(74, 'Đang xử lý giọng đọc và nhạc nền...');
  const { settings } = ctx.manifest;
  const total = timeline.totalDuration;

  const args: string[] = [];
  const voices: Array<{ inputIndex: number; startSec: number; duration: number }> = [];
  let idx = 0;
  for (const scene of timeline.scenes) {
    const src = usable[scene.index];
    if (src.voicePath && scene.voiceOffset !== null) {
      args.push('-i', rel(ctx.dir, src.voicePath));
      voices.push({ inputIndex: idx++, startSec: scene.start + scene.voiceOffset, duration: scene.voiceDuration });
    }
  }

  let bgmIndex: number | null = null;
  const bgmPath = settings.enableBgm ? ctx.files.get('bgm') : undefined;
  if (bgmPath) {
    const info = await probeMedia(bgmPath, ctx.signal);
    if (info?.hasAudio) {
      args.push('-stream_loop', '-1', '-i', rel(ctx.dir, bgmPath));
      bgmIndex = idx++;
    } else {
      ctx.warn('File nhạc nền bị hỏng hoặc không đọc được nên phim được dựng không có nhạc nền.');
    }
  }

  const common = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', 'audio.m4a'];
  const onSeconds = (sec: number) => ctx.report(74 + Math.round(Math.min(1, sec / total) * 10), 'Đang xử lý giọng đọc và nhạc nền...');

  if (voices.length === 0 && bgmIndex === null) {
    // Không có âm thanh: tạo track im lặng để phim phát được ở mọi nơi
    await runFfmpeg(FFMPEG, [
      '-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo', ...common,
    ], { cwd: ctx.dir, signal: ctx.signal });
    return 'audio.m4a';
  }

  fs.writeFileSync(
    path.join(ctx.dir, 'audio.fc'),
    buildAudioGraph(voices, bgmIndex, settings.bgmVolume, total),
    'utf8',
  );
  // Dùng file script để không bị giới hạn độ dài dòng lệnh (Windows ~8000 ký tự) khi có hàng trăm cảnh
  await runFfmpeg(FFMPEG, [
    ...args,
    '-filter_complex_script', 'audio.fc',
    '-map', '[aout]',
    ...common,
  ], { cwd: ctx.dir, signal: ctx.signal, onSeconds });
  return 'audio.m4a';
}

// ─────────────────────────── Chính ───────────────────────────

export async function renderMovie(ctx: RenderContext): Promise<RenderOutput> {
  // Máy dựng cần có ổ đĩa trống: ước lượng = 2 x dung lượng file đầu vào + 500MB
  try {
    let inputBytes = 0;
    for (const f of ctx.files.values()) inputBytes += fs.statSync(f).size;
    const st = fs.statfsSync(ctx.dir);
    const free = Number(st.bavail) * Number(st.bsize);
    if (free < inputBytes * 2 + 500 * 1024 * 1024) {
      throw new UserError(
        `Ổ đĩa không đủ chỗ trống để dựng phim (còn ${(free / 1e9).toFixed(1)} GB). Hãy giải phóng dung lượng rồi thử lại.`,
      );
    }
  } catch (e) {
    if (e instanceof UserError) throw e;
  }

  const usable = await collectUsableScenes(ctx);
  if (usable.length === 0) {
    throw new UserError('Không có video hợp lệ để dựng. Hãy kiểm tra lại các file video đã tải lên.');
  }

  const timeline = buildTimeline(usable.map(u => u.spec), ctx.manifest.settings);

  // Font phụ đề (copy vào thư mục job để dùng đường dẫn tương đối)
  if (timeline.scenes.some(s => s.cues.length > 0)) {
    const fontDst = path.join(ctx.dir, 'fonts');
    fs.mkdirSync(fontDst, { recursive: true });
    for (const f of fs.readdirSync(FONTS_DIR)) {
      if (/\.(ttf|otf)$/i.test(f)) fs.copyFileSync(path.join(FONTS_DIR, f), path.join(fontDst, f));
    }
  }

  const segments = await renderSegments(ctx, usable, timeline);
  const videoAll = await concatSegments(ctx, segments);
  const audio = await buildAudio(ctx, usable, timeline);

  ctx.report(86, 'Đang đóng gói MP4...');
  await runFfmpeg(FFMPEG, [
    '-i', videoAll, '-i', audio,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c', 'copy', '-movflags', '+faststart',
    '-t', timeline.totalDuration.toFixed(3),
    'output.mp4',
  ], { cwd: ctx.dir, signal: ctx.signal });

  ctx.report(95, 'Đang kiểm tra kết quả...');
  const outputPath = path.join(ctx.dir, 'output.mp4');
  const info = await probeMedia(outputPath, ctx.signal);
  if (!info || !info.hasVideo) throw new Error('Kết quả dựng không đọc được');
  if (Math.abs(info.duration - timeline.totalDuration) > 1.0) {
    throw new Error(`Thời lượng kết quả (${info.duration.toFixed(1)}s) lệch so với kế hoạch (${timeline.totalDuration.toFixed(1)}s)`);
  }
  if (info.width !== timeline.width || info.height !== timeline.height) {
    throw new Error(`Kích thước kết quả ${info.width}x${info.height} khác kế hoạch ${timeline.width}x${timeline.height}`);
  }
  if (!info.hasAudio) ctx.warn('Phim không có track âm thanh.');

  // Dọn file trung gian, chỉ giữ output.mp4
  for (const f of [videoAll, audio, 'concat.txt', 'audio.fc']) {
    try { fs.rmSync(path.join(ctx.dir, f), { force: true }); } catch { /* bỏ qua */ }
  }

  return {
    outputPath,
    duration: info.duration,
    sizeBytes: fs.statSync(outputPath).size,
    width: info.width,
    height: info.height,
  };
}

export type { TimelineScene };
