/**
 * Kiểm thử cảnh ẢNH trên máy dựng: dựng phim thật rồi đo bằng ffprobe/ffmpeg.
 * Chạy: npm test (trong thư mục render-server)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCanvas } from '@napi-rs/canvas';

import { buildTimeline } from '../../shared/render/plan';
import type { RenderManifest, RenderSettings } from '../../shared/render/types';

const PORT = 5073;
process.env.PORT = String(PORT);
process.env.RENDER_WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yohu-img-work-'));
process.env.RENDER_PRESET = 'ultrafast';
const BASE = `http://127.0.0.1:${PORT}`;

const { FFMPEG, FFPROBE } = await import('../src/binaries');
let server: import('node:http').Server;
const media = fs.mkdtempSync(path.join(os.tmpdir(), 'yohu-img-media-'));
const f = (n: string) => path.join(media, n);

function ff(args: string[]) {
  const r = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
  assert.equal(r.status, 0, String(r.stderr));
}
function probeJson(file: string) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  return JSON.parse(String(r.stdout));
}
/** PSNR (dB) giữa khung hình tại giây `at` của video và ảnh gốc cùng kích thước */
function psnrAt(video: string, at: number, image: string): number {
  const frame = f(`frame_${Math.round(at * 100)}.png`);
  ff(['-ss', String(at), '-i', video, '-frames:v', '1', frame]);
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', frame, '-i', image, '-lavfi', 'psnr', '-f', 'null', '-']);
  const m = String(r.stderr).match(/average:([\d.]+|inf)/);
  assert.ok(m, 'không đo được PSNR: ' + r.stderr);
  return m![1] === 'inf' ? 99 : parseFloat(m![1]);
}

/** Slide mẫu: nền tối, tiêu đề, 2 thẻ có chữ tiếng Việt có dấu, một dòng chú thích */
function makeSlide(file: string) {
  const c = createCanvas(1920, 1080); const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 1080); g.addColorStop(0, '#0b1730'); g.addColorStop(1, '#0a2a55');
  x.fillStyle = g; x.fillRect(0, 0, 1920, 1080);
  x.fillStyle = '#ffffff'; x.font = 'bold 110px sans-serif'; x.fillText('KIỂM TRA CHỮ ĐỪNG ĐỔI', 120, 260);
  const cards = [[120, 400, 'Giảm 40% nhân công', '#f58a1f'], [1000, 400, 'Rút ngắn 50% thời gian', '#1ab5ff']];
  for (const [cx, cy, txt, col] of cards as [number, number, string, string][]) {
    x.fillStyle = 'rgba(255,255,255,0.08)'; x.fillRect(cx, cy, 800, 300);
    x.strokeStyle = col; x.lineWidth = 6; x.strokeRect(cx, cy, 800, 300);
    x.fillStyle = col; x.font = 'bold 90px sans-serif'; x.fillText('≈50%', cx + 40, cy + 130);
    x.fillStyle = '#ffffff'; x.font = 'bold 54px sans-serif'; x.fillText(txt, cx + 40, cy + 220);
  }
  x.fillStyle = '#aab8d2'; x.font = '40px sans-serif'; x.fillText('Số liệu mục tiêu theo thuyết minh dự án', 120, 980);
  fs.writeFileSync(file, c.toBuffer('image/png'));
}
/** Ảnh "chụp": gradient màu mượt phủ kín khung (không có chữ) */
function makePhoto(file: string) {
  const c = createCanvas(1600, 1200); const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 1600, 1200); g.addColorStop(0, '#d9822b'); g.addColorStop(0.5, '#3a8fb7'); g.addColorStop(1, '#2d5d3a');
  x.fillStyle = g; x.fillRect(0, 0, 1600, 1200);
  for (let i = 0; i < 400; i++) { x.fillStyle = `rgba(${(i * 37) % 255},${(i * 91) % 255},${(i * 53) % 255},0.25)`; x.beginPath(); x.arc((i * 211) % 1600, (i * 131) % 1200, 20 + (i % 70), 0, 7); x.fill(); }
  fs.writeFileSync(file, c.toBuffer('image/jpeg'));
}

before(async () => {
  makeSlide(f('slide_01.png'));
  makePhoto(f('anh_02.jpg'));
  fs.writeFileSync(f('hong.png'), Buffer.from('không phải ảnh'.repeat(40)));
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('clip_03.mp4')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=1000:duration=5:sample_rate=24000', '-af', 'volume=0.5', f('voice_01.wav')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=220:duration=9', '-af', 'volume=0.8', f('nhac.mp3')]);
  ({ server } = await import('../src/index'));
  await new Promise(r => setTimeout(r, 500));
});
after(() => { server?.close(); fs.rmSync(media, { recursive: true, force: true }); });

const base: RenderSettings = {
  aspectRatio: '16:9', fitMode: 'blur', quality: '1080p',
  enableSubtitles: false, subtitleStyle: 'yellow_stroke', enableBgm: false, bgmVolume: 20,
};

async function submit(manifest: RenderManifest, files: Record<string, string>) {
  const fd = new FormData();
  fd.append('manifest', JSON.stringify(manifest));
  for (const [field, p] of Object.entries(files)) fd.append(field, await fs.openAsBlob(p), path.basename(p));
  const res = await fetch(`${BASE}/jobs`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json() as any };
}
async function waitDone(id: string) {
  for (let i = 0; i < 900; i++) {
    const info = await (await fetch(`${BASE}/jobs/${id}`)).json() as any;
    if (info.status === 'done' || info.status === 'error') return info;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('quá thời gian chờ');
}
async function downloadResult(id: string, out: string) {
  const res = await fetch(`${BASE}/jobs/${id}/result`);
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
}

test('health: máy dựng báo hỗ trợ cảnh ảnh', async () => {
  const h = await (await fetch(`${BASE}/health`)).json() as any;
  assert.equal(h.ok, true);
  assert.equal(h.images, true);
});

test('cảnh ảnh slide: dựng đúng thời lượng/kích thước và khung cuối GIỐNG ẢNH GỐC (chữ không đổi)', async () => {
  const manifest: RenderManifest = {
    settings: base, hasBgm: false,
    scenes: [{ id: 'i1', kind: 'image', hasVideo: false, hasImage: true, imageDuration: 6, motionStyle: 'auto', hasVoice: false, imageName: 'slide_01.png' }],
  };
  const sub = await submit(manifest, { i_i1: f('slide_01.png') });
  assert.equal(sub.status, 202, JSON.stringify(sub.body));
  const info = await waitDone(sub.body.id);
  assert.equal(info.status, 'done', info.error);
  assert.deepEqual([info.result.width, info.result.height], [1920, 1080]);
  assert.ok(Math.abs(info.result.duration - 6) < 0.2, `thời lượng ${info.result.duration}`);

  const out = f('out_slide.mp4');
  await downloadResult(sub.body.id, out);
  const p = probeJson(out);
  assert.equal(p.streams.find((s: any) => s.codec_type === 'video').codec_name, 'h264');
  // khung đầu: chưa có chữ (đang vào) -> khác ảnh gốc; khung cuối: phải trùng ảnh gốc
  const early = psnrAt(out, 0.15, f('slide_01.png'));
  const late = psnrAt(out, 5.8, f('slide_01.png'));
  // Mức trần do nén H.264: mã hóa thẳng ảnh gốc thành video đứng yên với cùng cài đặt rồi đo
  const still = f('still.mp4');
  ff(['-loop', '1', '-i', f('slide_01.png'), '-t', '3', '-r', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', still]);
  const ceiling = psnrAt(still, 2.5, f('slide_01.png'));
  console.log(`#   PSNR: khung đầu ${early.toFixed(1)} dB (đang vào) | khung cuối ${late.toFixed(1)} dB | mức trần nén H.264 (ảnh đứng yên) ${ceiling.toFixed(1)} dB`);
  // Khung cuối chỉ được kém mức trần nén tối đa 1 dB => chữ/hình giữ nguyên như ảnh gốc
  assert.ok(late > ceiling - 1, `khung cuối lệch ảnh gốc hơn mức nén cho phép (PSNR ${late} vs trần ${ceiling})`);
  assert.ok(early < late - 6, 'khung đầu phải khác khung cuối (có chuyển động vào)');
});

test('phim hỗn hợp: ảnh slide + ảnh chụp + video + ảnh hỏng, có voice, phụ đề, nhạc nền', async () => {
  const manifest: RenderManifest = {
    settings: { ...base, enableSubtitles: true, enableBgm: true }, hasBgm: true,
    scenes: [
      { id: 'a', kind: 'image', hasVideo: false, hasImage: true, imageDuration: 7, hasVoice: true, subtitleText: 'Hệ sinh thái xây dựng thông minh, chữ giữ nguyên.', imageName: 'slide_01.png', voiceName: 'voice_01.wav' },
      { id: 'b', kind: 'image', hasVideo: false, hasImage: true, imageDuration: 3, motionStyle: 'kenburns', hasVoice: false, imageName: 'anh_02.jpg' },
      { id: 'c', kind: 'image', hasVideo: false, hasImage: true, imageDuration: 3, hasVoice: false, imageName: 'hong.png' },
      { id: 'd', hasVideo: true, hasVoice: false, videoName: 'clip_03.mp4' },
    ],
  };
  const sub = await submit(manifest, { i_a: f('slide_01.png'), a_a: f('voice_01.wav'), i_b: f('anh_02.jpg'), i_c: f('hong.png'), v_d: f('clip_03.mp4'), bgm: f('nhac.mp3') });
  assert.equal(sub.status, 202, JSON.stringify(sub.body));
  const info = await waitDone(sub.body.id);
  assert.equal(info.status, 'done', info.error);
  // kỳ vọng thời lượng = timeline dùng chung (ảnh hỏng bị bỏ qua)
  const tl = buildTimeline([
    { id: 'a', kind: 'image', videoDuration: 7, imageDuration: 7, videoWidth: 1920, videoHeight: 1080, voiceDuration: 5 },
    { id: 'b', kind: 'image', videoDuration: 3, imageDuration: 3, videoWidth: 1600, videoHeight: 1200 },
    { id: 'd', videoDuration: 4, videoWidth: 1280, videoHeight: 720 },
  ], manifest.settings);
  assert.ok(Math.abs(info.result.duration - tl.totalDuration) < 0.3, `thời lượng ${info.result.duration} vs kế hoạch ${tl.totalDuration}`);
  assert.ok(info.warnings.some((w: string) => w.includes('hong') || w.includes('Cảnh 3')), 'phải cảnh báo ảnh hỏng: ' + JSON.stringify(info.warnings));
  const out = f('out_mixed.mp4'); await downloadResult(sub.body.id, out);
  const p = probeJson(out);
  assert.ok(p.streams.some((s: any) => s.codec_type === 'audio'), 'phải có âm thanh');
  assert.equal(p.format.format_name.includes('mp4'), true);
});

test('thiếu file ảnh trong yêu cầu -> bỏ qua cảnh, không treo', async () => {
  const manifest: RenderManifest = {
    settings: base, hasBgm: false,
    scenes: [
      { id: 'x', kind: 'image', hasVideo: false, hasImage: true, imageDuration: 3, hasVoice: false },
      { id: 'y', hasVideo: true, hasVoice: false, videoName: 'clip_03.mp4' },
    ],
  };
  const sub = await submit(manifest, { v_y: f('clip_03.mp4') });
  const info = await waitDone(sub.body.id);
  assert.equal(info.status, 'done', info.error);
  assert.ok(Math.abs(info.result.duration - 4) < 0.3);
});
