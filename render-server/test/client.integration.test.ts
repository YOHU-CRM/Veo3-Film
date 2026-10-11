/**
 * Chạy CHÍNH code phía giao diện (src/engine/remoteEngine.ts) với máy dựng thật,
 * để chắc chắn hợp đồng giữa hai phía (tên field, manifest, tiến độ, tải về, hủy) khớp nhau.
 * Node không có XMLHttpRequest nên dùng một lớp giả mỏng chạy bằng fetch.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PORT = 5072;
process.env.PORT = String(PORT);
process.env.RENDER_WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yohu-int-work-'));
process.env.RENDER_PRESET = 'ultrafast';
const BASE = `http://127.0.0.1:${PORT}`;

// ── Giả lập môi trường trình duyệt tối thiểu ──
const store = new Map<string, string>([['yohu_render_server_url', BASE]]);
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};
class FakeXHR {
  status = 0; responseText = '';
  onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null;
  upload: { onprogress: ((e: any) => void) | null } = { onprogress: null };
  private method = ''; private url = ''; private headers: Record<string, string> = {}; private ctrl = new AbortController();
  open(m: string, u: string) { this.method = m; this.url = u; }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  abort() { this.ctrl.abort(); this.onabort?.(); }
  send(body: FormData) {
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
    fetch(this.url, { method: this.method, body, headers: this.headers, signal: this.ctrl.signal })
      .then(async r => { this.status = r.status; this.responseText = await r.text(); this.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 2 }); this.onload?.(); })
      .catch(e => { if (e?.name !== 'AbortError') this.onerror?.(); });
  }
}
(globalThis as any).XMLHttpRequest = FakeXHR;

const { FFMPEG } = await import('../src/binaries');
const { pingEngine, renderRemote } = await import('../../src/engine/remoteEngine');
const { RenderCancelled } = await import('../../src/engine/types');

const media = fs.mkdtempSync(path.join(os.tmpdir(), 'yohu-int-media-'));
const f = (n: string) => path.join(media, n);
const ff = (a: string[]) => assert.equal(spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...a]).status, 0);
const asFile = (p: string) => new File([fs.readFileSync(p)], path.basename(p));
let server: import('node:http').Server;

before(async () => {
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('Veo3_clip_01.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('Veo3_clip_02.mp4')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=800:duration=3', f('voice_01.wav')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=200:duration=5', f('nhac.mp3')]);
  ({ server } = await import('../src/index'));
  await new Promise(r => setTimeout(r, 400));
});
after(() => { server?.close(); fs.rmSync(media, { recursive: true, force: true }); });

const baseSettings = {
  aspectRatio: '16:9' as const, fitMode: 'blur' as const, quality: '1080p' as const,
  enableSubtitles: true, subtitleStyle: 'yellow_stroke' as const, enableBgm: true, bgmVolume: 20,
};
const scene = (id: string, v: string, a?: string, text?: string) => ({
  id, videoFile: asFile(f(v)), videoUrl: 'blob:fake', videoName: v,
  videoDuration: 6, videoWidth: 1280, videoHeight: 720,
  ...(a ? { voiceFile: asFile(f(a)), voiceUrl: 'blob:fakevoice', voiceName: a, voiceDuration: 3 } : {}),
  subtitleText: text,
});

test('ping: giao diện nhận ra máy dựng', async () => {
  const h = await pingEngine();
  assert.ok(h && h.ok && h.subtitles);
});

test('giao diện -> máy dựng -> MP4: đúng tiến độ, kết quả, tải về, dọn dẹp', async () => {
  const progress: Array<[number, string]> = [];
  const res = await renderRemote(
    {
      scenes: [scene('scene_a1', 'Veo3_clip_01.mp4', 'voice_01.wav', 'Xin chào, đây là bài kiểm thử tích hợp.'), scene('scene_b2', 'Veo3_clip_02.mp4')],
      settings: baseSettings,
      bgm: { url: URL.createObjectURL(new Blob([fs.readFileSync(f('nhac.mp3'))])), name: 'nhac.mp3' },
    } as any,
    { signal: new AbortController().signal, onProgress: (p, m) => progress.push([p, m]) },
  ).catch(async e => { throw e; });

  assert.equal(res.engine, 'server');
  assert.equal(res.width, 1920);
  assert.equal(res.height, 1080);
  assert.equal(res.extension, 'mp4');
  // 3s voice + 0.4 = 3.4s ; cảnh 2 = 6s  -> 9.4s
  assert.ok(Math.abs(res.duration - 9.4) < 0.3, `thời lượng ${res.duration}`);

  const percents = progress.map(p => p[0]);
  assert.ok(percents.length > 3, 'phải có nhiều cập nhật tiến độ');
  assert.ok(percents.every((p, i) => i === 0 || p >= percents[i - 1] - 0.0001), 'tiến độ không được lùi: ' + percents.join(','));
  assert.ok(progress.some(([, m]) => /cảnh/i.test(m)), 'thông điệp tiến độ phải nói về cảnh');

  const play = await fetch(res.url, { headers: { Range: 'bytes=0-99' } });
  assert.equal(play.status, 206, 'xem video phải hỗ trợ Range (tua được)');
  const dl = await fetch(res.downloadUrl('Phim Của Tôi'));
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition') || '', /attachment; filename="Phim_C_a_T_i\.mp4"/);

  res.dispose();
  await new Promise(r => setTimeout(r, 300));
  assert.equal((await fetch(res.url)).status, 404, 'sau dispose phải xóa file trên máy dựng');
});

test('hủy giữa chừng -> RenderCancelled và máy dựng dọn sạch', async () => {
  const ctrl = new AbortController();
  const p = renderRemote(
    { scenes: [scene('scene_c3', 'Veo3_clip_01.mp4'), scene('scene_d4', 'Veo3_clip_02.mp4')], settings: { ...baseSettings, enableBgm: false } } as any,
    { signal: ctrl.signal, onProgress: () => {} },
  );
  setTimeout(() => ctrl.abort(), 900);
  await assert.rejects(p, (e: any) => e instanceof RenderCancelled);
});

test('máy dựng tắt -> ping trả null (giao diện sẽ dùng chế độ trình duyệt)', async () => {
  store.set('yohu_render_server_url', 'http://127.0.0.1:59999');
  assert.equal(await pingEngine(800), null);
  store.set('yohu_render_server_url', BASE);
});
