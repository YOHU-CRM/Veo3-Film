import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSceneNumber, resolveOutputSize, splitSubtitleText, allocateCues,
  buildTimeline, estimateTotalDuration, sceneDuration, FPS, VOICE_LEAD, VOICE_TAIL,
} from './plan';
import type { RenderSettings, SceneSpec } from './types';

const settings: RenderSettings = {
  aspectRatio: '16:9', fitMode: 'blur', quality: '1080p',
  enableSubtitles: true, subtitleStyle: 'yellow_stroke', enableBgm: true, bgmVolume: 20,
};

test('parseSceneNumber: tên file thực tế', () => {
  assert.equal(parseSceneNumber('Veo3_clip_05.mp4'), 5);
  assert.equal(parseSceneNumber('veo3-scene2.mp4'), 2);
  assert.equal(parseSceneNumber('Cảnh 12.mov'), 12);
  assert.equal(parseSceneNumber('canh_7.mp4'), 7);
  assert.equal(parseSceneNumber('IMG_0023.mp4'), 23);
  assert.equal(parseSceneNumber('1771117397469_7.mp4'), 7);
  assert.equal(parseSceneNumber('final_1080p_3.mp4'), 3);
  assert.equal(parseSceneNumber('3_1080p.mp4'), 3);
  assert.equal(parseSceneNumber('voice_09.wav'), 9);
  assert.equal(parseSceneNumber('Scene_1.png'), 1);
  assert.equal(parseSceneNumber('intro.mp4'), null);
  assert.equal(parseSceneNumber('veo3.mp4'), null);
});

test('resolveOutputSize: 1080p/720p/4k đúng và số chẵn', () => {
  assert.deepEqual(resolveOutputSize('16:9', '1080p', { width: 1280, height: 720 }), { width: 1920, height: 1080 });
  assert.deepEqual(resolveOutputSize('9:16', '1080p', { width: 1280, height: 720 }), { width: 1080, height: 1920 });
  assert.deepEqual(resolveOutputSize('1:1', '1080p', { width: 1280, height: 720 }), { width: 1080, height: 1080 });
  assert.deepEqual(resolveOutputSize('16:9', '720p', { width: 1920, height: 1080 }), { width: 1280, height: 720 });
  assert.deepEqual(resolveOutputSize('16:9', '4k', { width: 1920, height: 1080 }), { width: 3840, height: 2160 });
  assert.deepEqual(resolveOutputSize('original', '1080p', { width: 720, height: 1280 }), { width: 1080, height: 1920 });
  assert.deepEqual(resolveOutputSize('original', 'original', { width: 721, height: 1281 }), { width: 722, height: 1282 });
});

test('splitSubtitleText: không vượt quá độ dài và không mất chữ', () => {
  const text = 'Có những buổi sáng, ta thức dậy và chợt nhận ra rằng mọi thứ đã thay đổi từ lúc nào không hay. Nhưng không sao cả!';
  const pieces = splitSubtitleText(text, 40);
  assert.ok(pieces.length >= 2);
  for (const p of pieces) assert.ok(p.length <= 40, `quá dài: ${p}`);
  assert.equal(pieces.join(' ').replace(/\s+/g, ' '), text);
});

test('allocateCues: liên tục, không chồng lấn, phủ kín khoảng thời gian', () => {
  const cues = allocateCues(['Câu một khá dài một chút', 'Hai', 'Câu ba cũng dài'], 0.1, 6.1);
  assert.equal(cues[0].start, 0.1);
  assert.ok(Math.abs(cues[cues.length - 1].end - 6.1) < 1e-9);
  for (let i = 1; i < cues.length; i++) assert.equal(cues[i].start, cues[i - 1].end);
  for (const c of cues) assert.ok(c.end - c.start >= 0.8 - 1e-9);
});

test('allocateCues: quá nhiều mảnh so với thời gian -> gộp bớt', () => {
  const cues = allocateCues(['a b c', 'd e f', 'g h i', 'j k l'], 0, 2);
  for (const c of cues) assert.ok(c.end - c.start >= 0.8 - 1e-9);
});

test('buildTimeline: thời lượng khớp ước tính và là bội số khung hình', () => {
  const scenes: SceneSpec[] = [
    { id: 'a', videoDuration: 8, videoWidth: 1280, videoHeight: 720, voiceDuration: 4.2, subtitleText: 'Xin chào các bạn.' },
    { id: 'b', videoDuration: 3, videoWidth: 1280, videoHeight: 720, voiceDuration: 6.0, subtitleText: 'Câu thứ hai. Nó dài hơn clip.' },
    { id: 'c', videoDuration: 5.01, videoWidth: 1280, videoHeight: 720 },
  ];
  const t = buildTimeline(scenes, settings);
  assert.equal(t.width, 1920);
  assert.equal(t.height, 1080);
  assert.ok(Math.abs(t.totalDuration - estimateTotalDuration(scenes)) < 1e-9);
  assert.equal(t.scenes[0].loop, false);   // clip 8s > 4.6s cần
  assert.equal(t.scenes[1].loop, true);    // clip 3s < 6.4s cần
  assert.equal(t.scenes[2].voiceOffset, null);
  let acc = 0;
  for (const s of t.scenes) {
    assert.ok(Math.abs(s.start - acc) < 1e-9);
    assert.equal(s.frames, Math.round(s.duration * FPS));
    acc += s.duration;
  }
  // phụ đề nằm trong cảnh
  for (const s of t.scenes) for (const c of s.cues) assert.ok(c.start >= 0 && c.end <= s.duration + 1e-9);
});

test('buildTimeline: tắt phụ đề -> không có cue', () => {
  const t = buildTimeline(
    [{ id: 'a', videoDuration: 4, videoWidth: 1920, videoHeight: 1080, subtitleText: 'abc' }],
    { ...settings, enableSubtitles: false },
  );
  assert.equal(t.scenes[0].cues.length, 0);
});

// ───────────────────────── Cảnh ảnh ─────────────────────────

test('cảnh ảnh: không voice -> theo số giây đặt, tối thiểu 2.5s, không lặp', () => {
  const settings: RenderSettings = { aspectRatio: '16:9', fitMode: 'blur', quality: '1080p', enableSubtitles: false, subtitleStyle: 'yellow_stroke', enableBgm: false, bgmVolume: 20 };
  const tl = buildTimeline([
    { id: 'a', kind: 'image', videoDuration: 7, videoWidth: 1920, videoHeight: 1080, imageDuration: 7 },
    { id: 'b', kind: 'image', videoDuration: 1, videoWidth: 1920, videoHeight: 1080, imageDuration: 1 },
  ], settings);
  assert.equal(tl.scenes[0].duration, 7);
  assert.equal(tl.scenes[1].duration, 2.5);
  assert.equal(tl.scenes[0].loop, false);
  assert.equal(tl.totalDuration, 9.5);
});

test('cảnh ảnh: có voice -> theo voice (+ lead/tail), khớp ước tính', () => {
  const settings: RenderSettings = { aspectRatio: '16:9', fitMode: 'blur', quality: '1080p', enableSubtitles: false, subtitleStyle: 'yellow_stroke', enableBgm: false, bgmVolume: 20 };
  const specs = [{ id: 'a', kind: 'image' as const, videoDuration: 7, videoWidth: 1920, videoHeight: 1080, voiceDuration: 6 }];
  const tl = buildTimeline(specs, settings);
  assert.ok(Math.abs(tl.scenes[0].duration - (VOICE_LEAD + 6 + VOICE_TAIL)) < 1 / FPS);
  assert.equal(tl.totalDuration, estimateTotalDuration(specs));
});

test('ảnh lớn làm khung gốc: cạnh dài bị giới hạn 1920', () => {
  const settings: RenderSettings = { aspectRatio: 'original', fitMode: 'blur', quality: 'original', enableSubtitles: false, subtitleStyle: 'yellow_stroke', enableBgm: false, bgmVolume: 20 };
  const tl = buildTimeline([{ id: 'a', kind: 'image', videoDuration: 7, videoWidth: 4000, videoHeight: 3000 }], settings);
  assert.ok(Math.max(tl.width, tl.height) <= 1920);
  assert.ok(Math.abs(tl.width / tl.height - 4 / 3) < 0.01);
});


// ───────── Thứ tự ưu tiên thời lượng: người dùng đặt > giọng đọc > ảnh/clip ─────────
test('thời lượng: người dùng đặt thắng giọng đọc và clip', () => {
  const d = sceneDuration({ kind: 'video', videoDuration: 12, voiceDuration: 5, userDuration: 8 });
  assert.equal(d.source, 'user');
  assert.equal(d.seconds, 8);
});

test('thời lượng: không đặt thì theo giọng đọc (có đệm đầu/cuối)', () => {
  const d = sceneDuration({ kind: 'video', videoDuration: 12, voiceDuration: 5 });
  assert.equal(d.source, 'voice');
  assert.ok(Math.abs(d.seconds - (VOICE_LEAD + 5 + VOICE_TAIL)) < 1e-9);
});

test('thời lượng: không voice thì ảnh theo số giây mặc định, video theo clip gốc', () => {
  assert.equal(sceneDuration({ kind: 'image', videoDuration: 0, imageDuration: 6 }).source, 'image');
  assert.equal(sceneDuration({ kind: 'image', videoDuration: 0, imageDuration: 6 }).seconds, 6);
  const v = sceneDuration({ kind: 'video', videoDuration: 9.5 });
  assert.equal(v.source, 'clip');
  assert.equal(v.seconds, 9.5);
});

test('thời lượng: đặt 0 hoặc âm thì bỏ qua, quay về tự động', () => {
  assert.equal(sceneDuration({ kind: 'video', videoDuration: 4, userDuration: 0 }).source, 'clip');
  assert.equal(sceneDuration({ kind: 'video', videoDuration: 4, userDuration: -3 }).source, 'clip');
});

test('timeline: cảnh đặt thời lượng ngắn hơn voice thì cảnh đúng bằng số đặt, clip ngắn hơn thì lặp', () => {
  const specs: SceneSpec[] = [
    { id: 'a', kind: 'video', videoDuration: 3, videoWidth: 1920, videoHeight: 1080, voiceDuration: 9, userDuration: 5 },
    { id: 'b', kind: 'video', videoDuration: 3, videoWidth: 1920, videoHeight: 1080, userDuration: 7 },
  ];
  const tl = buildTimeline(specs, settings);
  assert.ok(Math.abs(tl.scenes[0].duration - 5) < 1 / FPS + 1e-9);
  assert.ok(Math.abs(tl.scenes[1].duration - 7) < 1 / FPS + 1e-9);
  assert.equal(tl.scenes[1].loop, true);
  assert.ok(Math.abs(estimateTotalDuration(specs) - tl.totalDuration) < 1e-6);
});
