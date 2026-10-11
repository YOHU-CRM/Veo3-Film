import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSplitPoints, planSplitByWeights, encodeWav } from './audioTools';

/** Âm thanh mô phỏng: nói 6.5s rồi lặng 0.6s, lặp lại */
function fakeVoice(totalSec: number, sr = 16000) {
  const x = new Float32Array(sr * totalSec);
  const silences: number[] = [];
  let t = 0;
  while (t < totalSec) {
    for (let i = 0; i < 6.5 * sr && Math.round(t * sr) + i < x.length; i++) x[Math.round(t * sr) + i] = 0.3 * Math.sin(i * 0.05);
    silences.push(t + 6.5 + 0.3);
    t += 7.1;
  }
  return { x, sr, silences };
}
const nearest = (c: number, s: number[]) => Math.min(...s.map(v => Math.abs(v - c)));

test('chia theo số giây: mọi điểm cắt rơi vào chỗ lặng', () => {
  const { x, sr, silences } = fakeVoice(60);
  for (const seg of [7, 8, 10]) {
    const cuts = planSplitPoints(x, sr, seg);
    assert.ok(cuts.length >= 4);
    for (const c of cuts) assert.ok(nearest(c, silences) < 0.5, `seg ${seg}: cắt ${c.toFixed(2)} lệch chỗ lặng`);
  }
});

test('chia theo số giây: tắt snap thì cắt đúng từng N giây', () => {
  const { x, sr } = fakeVoice(40);
  const cuts = planSplitPoints(x, sr, 8, { snap: false });
  assert.deepEqual(cuts.map(c => Math.round(c)), [8, 16, 24, 32]);
});

test('chia theo tỉ lệ: đúng N đoạn, dùng HẾT giọng đọc, tỉ lệ khớp trọng số (khi tắt snap)', () => {
  const { x, sr } = fakeVoice(60);
  const cuts = planSplitByWeights(x, sr, [1, 2, 3], { snap: false });
  assert.equal(cuts.length, 2);
  assert.ok(Math.abs(cuts[0] - 10) < 1e-6);
  assert.ok(Math.abs(cuts[1] - 30) < 1e-6);
});

test('chia theo tỉ lệ: bật snap vẫn ra N-1 điểm cắt tăng dần, nằm trong giọng đọc', () => {
  const { x, sr, silences } = fakeVoice(60);
  const cuts = planSplitByWeights(x, sr, [1, 1, 1, 1, 1, 1, 1, 1], {});
  assert.equal(cuts.length, 7);
  for (let i = 1; i < cuts.length; i++) assert.ok(cuts[i] > cuts[i - 1]);
  assert.ok(cuts[0] > 0 && cuts[cuts.length - 1] < 60);
  for (const c of cuts) assert.ok(nearest(c, silences) < 1.5);
});

test('encodeWav: đúng kích thước và tiêu đề RIFF', async () => {
  const x = new Float32Array(16000 * 2);
  const buf = await encodeWav([x], 16000, 0, 2).arrayBuffer();
  assert.equal(buf.byteLength, 44 + 16000 * 2 * 2);
  assert.equal(new TextDecoder().decode(new Uint8Array(buf, 0, 4)), 'RIFF');
});
