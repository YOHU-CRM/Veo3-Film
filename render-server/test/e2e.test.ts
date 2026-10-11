/**
 * Kiểm thử đầu-cuối: upload -> dựng -> kiểm tra MP4 thật bằng ffprobe/ffmpeg.
 * Chạy: npm test (trong thư mục render-server)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildTimeline } from '../../shared/render/plan';
import type { RenderManifest, RenderSettings } from '../../shared/render/types';

const PORT = 5071;
process.env.PORT = String(PORT);
process.env.RENDER_WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yohu-e2e-work-'));
process.env.RENDER_PRESET = 'ultrafast';
const BASE = `http://127.0.0.1:${PORT}`;

const { FFMPEG, FFPROBE } = await import('../src/binaries');
let server: import('node:http').Server;
const media = fs.mkdtempSync(path.join(os.tmpdir(), 'yohu-e2e-media-'));
const f = (n: string) => path.join(media, n);

function ff(args: string[]) {
  const r = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
  assert.equal(r.status, 0, String(r.stderr));
}
function probeJson(file: string, extra: string[] = []) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...extra, file]);
  return JSON.parse(String(r.stdout));
}
/** Mức âm (dB) của dải 220Hz (nhạc nền) trong đoạn [from, from+len] */
function bgmLevel(file: string, from: number, len: number): number {
  const r = spawnSync(FFMPEG, [
    '-hide_banner', '-ss', String(from), '-t', String(len), '-i', file,
    '-af', 'bandpass=f=220:width_type=h:w=40,volumedetect', '-vn', '-f', 'null', '-',
  ]);
  const m = String(r.stderr).match(/mean_volume:\s*(-?[\d.]+) dB/);
  assert.ok(m, 'không đọc được mức âm: ' + r.stderr);
  return parseFloat(m![1]);
}

before(async () => {
  // Video mẫu (có kèm tiếng riêng để kiểm tra tiếng gốc KHÔNG lọt vào phim)
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=8', '-f', 'lavfi', '-i', 'sine=f=3000:duration=8',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f('Veo3_clip_01.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('Veo3_clip_02.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('Veo3_clip_03.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('Veo3_clip_04.mp4')]);
  fs.writeFileSync(f('hong.mp4'), Buffer.from('đây không phải video, chỉ là chữ lộn xộn'.repeat(50)));
  ff(['-f', 'lavfi', '-i', 'sine=f=1000:duration=4:sample_rate=24000', '-af', 'volume=0.5', f('voice_01.wav')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=1000:duration=6:sample_rate=24000', '-af', 'volume=0.5', f('voice_03.wav')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=220:duration=9', '-af', 'volume=0.8', f('nhac.mp3')]);

  process.env.RENDER_PRESET = 'ultrafast';
  ({ server } = await import('../src/index'));
  await new Promise(r => setTimeout(r, 500));
});

after(() => { server?.close(); fs.rmSync(media, { recursive: true, force: true }); });

const settings: RenderSettings = {
  aspectRatio: '16:9', fitMode: 'blur', quality: '1080p',
  enableSubtitles: true, subtitleStyle: 'yellow_stroke', enableBgm: true, bgmVolume: 20,
};

async function submit(manifest: RenderManifest, files: Record<string, string>) {
  const fd = new FormData();
  fd.append('manifest', JSON.stringify(manifest));
  for (const [field, p] of Object.entries(files)) fd.append(field, await fs.openAsBlob(p), path.basename(p));
  const res = await fetch(`${BASE}/jobs`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json() as any };
}
async function waitDone(id: string) {
  for (let i = 0; i < 600; i++) {
    const info = await (await fetch(`${BASE}/jobs/${id}`)).json() as any;
    if (info.status === 'done' || info.status === 'error') return info;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('quá thời gian chờ');
}

test('health: máy dựng báo sẵn sàng, có phụ đề và sidechain', async () => {
  const h = await (await fetch(`${BASE}/health`)).json() as any;
  assert.equal(h.ok, true);
  assert.equal(h.subtitles, true);
  assert.equal(h.sidechain, true);
});

test('dựng phim đầy đủ: nhiều tỉ lệ, voice, phụ đề, nhạc nền, 1 file hỏng', async () => {
  const manifest: RenderManifest = {
    settings,
    hasBgm: true,
    scenes: [
      { id: 's1', hasVideo: true, hasVoice: true, subtitleText: 'Xin chào các bạn, đây là cảnh đầu tiên của bộ phim.', videoName: 'Veo3_clip_01.mp4', voiceName: 'voice_01.wav' },
      { id: 's2', hasVideo: true, hasVoice: false, subtitleText: 'Cảnh dọc 9:16 sẽ có nền mờ.', videoName: 'Veo3_clip_02.mp4' },
      { id: 's3', hasVideo: true, hasVoice: false, videoName: 'hong.mp4' },
      { id: 's4', hasVideo: true, hasVoice: true, subtitleText: 'Voice dài hơn clip nên clip phải lặp lại. Phụ đề tự chia câu theo thời gian đọc.', videoName: 'Veo3_clip_03.mp4', voiceName: 'voice_03.wav' },
      { id: 's5', hasVideo: true, hasVoice: false, videoName: 'Veo3_clip_04.mp4' },
    ],
  };
  const files = {
    v_s1: f('Veo3_clip_01.mp4'), a_s1: f('voice_01.wav'),
    v_s2: f('Veo3_clip_02.mp4'),
    v_s3: f('hong.mp4'),
    v_s4: f('Veo3_clip_03.mp4'), a_s4: f('voice_03.wav'),
    v_s5: f('Veo3_clip_04.mp4'),
    bgm: f('nhac.mp3'),
  };
  const sub = await submit(manifest, files);
  assert.equal(sub.status, 202, JSON.stringify(sub.body));

  const info = await waitDone(sub.body.id);
  assert.equal(info.status, 'done', info.error);
  assert.ok(info.warnings.some((w: string) => w.includes('Cảnh 3') && w.includes('hỏng')), 'phải cảnh báo file hỏng: ' + info.warnings);

  // Kế hoạch mong đợi (bỏ cảnh hỏng)
  const timeline = buildTimeline([
    { id: 's1', videoDuration: 8, videoWidth: 1280, videoHeight: 720, voiceDuration: 4, subtitleText: 'x' },
    { id: 's2', videoDuration: 5, videoWidth: 720, videoHeight: 1280 },
    { id: 's4', videoDuration: 3, videoWidth: 1920, videoHeight: 1080, voiceDuration: 6 },
    { id: 's5', videoDuration: 6, videoWidth: 1280, videoHeight: 720 },
  ], settings);

  const out = path.join(media, 'ket_qua.mp4');
  const dl = await fetch(`${BASE}/jobs/${sub.body.id}/result?download=1&name=Phim%20Test`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition') || '', /Phim_Test\.mp4/);
  fs.writeFileSync(out, Buffer.from(await dl.arrayBuffer()));

  const p = probeJson(out);
  const v = p.streams.find((s: any) => s.codec_type === 'video');
  const a = p.streams.find((s: any) => s.codec_type === 'audio');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.width, 1920);
  assert.equal(v.height, 1080);
  assert.equal(v.pix_fmt, 'yuv420p');
  assert.ok(a, 'phải có âm thanh');
  assert.equal(a.codec_name, 'aac');
  assert.ok(Math.abs(parseFloat(p.format.duration) - timeline.totalDuration) < 0.25,
    `thời lượng ${p.format.duration} vs kế hoạch ${timeline.totalDuration}`);

  // Số khung hình đúng từng khung (không trôi hình)
  const frames = probeJson(out, ['-count_frames', '-select_streams', 'v:0']).streams[0].nb_read_frames;
  const expectedFrames = timeline.scenes.reduce((s, x) => s + x.frames, 0);
  assert.equal(parseInt(frames, 10), expectedFrames);

  // faststart: moov nằm trước mdat để xem được ngay khi đang tải
  const head = fs.readFileSync(out).subarray(0, 4096).toString('latin1');
  assert.ok(head.indexOf('moov') > 0 && head.indexOf('moov') < (head.indexOf('mdat') === -1 ? Infinity : head.indexOf('mdat')), 'MP4 phải faststart');

  // Tiếng gốc 3000Hz của clip KHÔNG được lọt vào phim
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', out, '-af', 'bandpass=f=3000:width_type=h:w=100,volumedetect', '-vn', '-f', 'null', '-']);
  const m = String(r.stderr).match(/max_volume:\s*(-?[\d.]+|-inf) dB/);
  assert.ok(m && (m[1] === '-inf' || parseFloat(m[1]) < -45), 'tiếng gốc của clip bị lọt vào phim: ' + m?.[1]);

  // Nhạc tự giảm khi có voice: voice cảnh 1 trong khoảng 0.1–4.1s; cảnh 2 (5s, không voice) bắt đầu 4.5s
  const s1 = timeline.scenes[0], s2 = timeline.scenes[1];
  const withVoice = bgmLevel(out, 1.8, 1.8);                       // voice đang đọc
  const noVoice = bgmLevel(out, s2.start + 1.2, 2.0);              // chỉ có nhạc
  console.log(`   nhạc khi có voice: ${withVoice} dB | khi không voice: ${noVoice} dB | chênh ${(noVoice - withVoice).toFixed(1)} dB`);
  assert.ok(noVoice - withVoice >= 9, `nhạc phải giảm >= 9dB khi có voice, thực tế ${(noVoice - withVoice).toFixed(1)}dB`);

  // Lưu 2 khung hình để xem phụ đề + nền mờ
  ff(['-ss', String(s1.start + 1.5), '-i', out, '-frames:v', '1', f('frame_landscape.png')]);
  ff(['-ss', String(s2.start + 2.0), '-i', out, '-frames:v', '1', f('frame_portrait.png')]);
  const keep = process.env.KEEP_FRAMES;
  if (keep) { fs.copyFileSync(f('frame_landscape.png'), path.join(keep, 'frame_landscape.png')); fs.copyFileSync(f('frame_portrait.png'), path.join(keep, 'frame_portrait.png')); }

  // Dọn thư mục sau khi xóa job
  const del = await (await fetch(`${BASE}/jobs/${sub.body.id}`, { method: 'DELETE' })).json() as any;
  assert.equal(del.ok, true);
});

test('dọc 9:16 1080p + hộp phụ đề trắng, không nhạc, không voice', async () => {
  const manifest: RenderManifest = {
    settings: { ...settings, aspectRatio: '9:16', subtitleStyle: 'white_box', enableBgm: false },
    hasBgm: false,
    scenes: [{ id: 'a', hasVideo: true, hasVoice: false, subtitleText: 'Phim dọc cho TikTok.' }],
  };
  const sub = await submit(manifest, { v_a: f('Veo3_clip_04.mp4') });
  const info = await waitDone(sub.body.id);
  assert.equal(info.status, 'done', info.error);
  assert.equal(info.result.width, 1080);
  assert.equal(info.result.height, 1920);
});

test('toàn bộ file hỏng -> lỗi dễ hiểu, không treo', async () => {
  const manifest: RenderManifest = {
    settings, hasBgm: false,
    scenes: [{ id: 'x', hasVideo: true, hasVoice: false, videoName: 'hong.mp4' }],
  };
  const sub = await submit(manifest, { v_x: f('hong.mp4') });
  const info = await waitDone(sub.body.id);
  assert.equal(info.status, 'error');
  assert.match(info.error, /Không có video hợp lệ/);
});

test('yêu cầu sai định dạng bị từ chối rõ ràng', async () => {
  const fd = new FormData();
  fd.append('manifest', '{"hello":1}');
  const res = await fetch(`${BASE}/jobs`, { method: 'POST', body: fd });
  assert.equal(res.status, 400);
  const body = await res.json() as any;
  assert.ok(body.error);
});

test('hủy tác vụ đang chờ/chạy', async () => {
  const manifest: RenderManifest = {
    settings, hasBgm: false,
    scenes: [{ id: 'c', hasVideo: true, hasVoice: false }],
  };
  const sub = await submit(manifest, { v_c: f('Veo3_clip_01.mp4') });
  const del = await (await fetch(`${BASE}/jobs/${sub.body.id}`, { method: 'DELETE' })).json() as any;
  assert.equal(del.ok, true);
  const after = await fetch(`${BASE}/jobs/${sub.body.id}`);
  assert.equal(after.status, 404);
});
