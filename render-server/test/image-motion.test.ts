/**
 * Kiểm thử bộ chuyển động ảnh (shared/imageMotion): nhận diện khối, không sót nội dung, chế độ an toàn chữ tuyệt đối.
 * Dùng slide tổng hợp tự vẽ nên không phụ thuộc file ảnh bên ngoài.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';

import { prepareImage, ImageMotionScene, analyzeImage, stateAt } from '../../shared/imageMotion';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const factory = (w: number, h: number): any => createCanvas(w, h);

/** Slide mẫu giống bộ slide thật: nền tối + lưới mờ, tiêu đề, ô viên thuốc, thẻ, vòng tròn, dấu · ngăn cách, chân trang */
function makeSlide() {
  const c = createCanvas(1920, 1080); const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 1080); g.addColorStop(0, '#0b1730'); g.addColorStop(1, '#0a2a55');
  x.fillStyle = g; x.fillRect(0, 0, 1920, 1080);
  x.strokeStyle = 'rgba(26,181,255,0.05)'; x.lineWidth = 1;
  for (let i = 0; i < 1920; i += 80) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 1080); x.stroke(); }
  for (let j = 0; j < 1080; j += 80) { x.beginPath(); x.moveTo(0, j); x.lineTo(1920, j); x.stroke(); }
  x.fillStyle = '#f58a1f'; x.font = 'bold 30px sans-serif'; x.fillText('BƯỚC 1 · AI THIẾT KẾ – DỰ TOÁN', 120, 80);
  x.fillStyle = '#ffffff'; x.font = 'bold 120px sans-serif'; x.fillText('GIẢM 40% NHÂN CÔNG', 120, 300);
  const pills: Array<[number, string]> = [[120, 'Nền tảng AI'], [520, 'Bê tông EPS'], [920, 'Gông 3D']];
  for (const [px, t] of pills) {
    x.strokeStyle = 'rgba(255,255,255,0.55)'; x.lineWidth = 3; x.beginPath(); x.roundRect(px, 380, 360, 70, 35); x.stroke();
    x.fillStyle = '#ffffff'; x.font = 'bold 34px sans-serif'; x.fillText(t, px + 40, 425);
  }
  for (const [cx, col] of [[120, '#f58a1f'], [1000, '#1ab5ff']] as Array<[number, string]>) {
    x.fillStyle = 'rgba(255,255,255,0.08)'; x.fillRect(cx, 520, 800, 300);
    x.strokeStyle = col; x.lineWidth = 6; x.strokeRect(cx, 520, 800, 300);
    x.fillStyle = col; x.font = 'bold 90px sans-serif'; x.fillText('≈50%', cx + 40, 650);
    x.fillStyle = '#ffffff'; x.font = 'bold 54px sans-serif'; x.fillText('giảm chi phí hoàn thiện', cx + 40, 740);
  }
  x.fillStyle = '#aab8d2'; x.font = '40px sans-serif'; x.fillText('Web + AI Chat · Quản lý bán hàng · Enterprise', 120, 980);
  return c;
}

function makePhoto() {
  const c = createCanvas(1600, 1200); const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 1600, 1200); g.addColorStop(0, '#d9822b'); g.addColorStop(0.5, '#3a8fb7'); g.addColorStop(1, '#2d5d3a');
  x.fillStyle = g; x.fillRect(0, 0, 1600, 1200);
  for (let i = 0; i < 500; i++) { x.fillStyle = `rgba(${(i * 37) % 255},${(i * 91) % 255},${(i * 53) % 255},0.3)`; x.beginPath(); x.arc((i * 211) % 1600, (i * 131) % 1200, 20 + (i % 70), 0, 7); x.fill(); }
  return c;
}

async function load(canvas: unknown) {
  return prepareImage(canvas, { factory });
}

test('nhận diện khối: tiêu đề, ô viên thuốc, thẻ, chân trang', async () => {
  const p = await load(makeSlide());
  const a = p.analysis;
  assert.equal(a.mode, 'slide');
  const kinds = a.blocks.map(b => b.kind);
  assert.ok(kinds.includes('text'), 'phải có khối chữ: ' + kinds);
  assert.equal(kinds.filter(k => k === 'card').length, 2, 'phải có đúng 2 thẻ: ' + kinds);
  assert.equal(kinds.filter(k => k === 'item').length, 3, '3 ô viên thuốc phải tách riêng: ' + kinds);
  assert.ok(kinds.includes('footer'), 'phải có chân trang');
});

test('không sót nội dung ở nền (không có chữ "ma" hiện sẵn trước khi khối xuất hiện)', async () => {
  const p = await load(makeSlide());
  const a = p.analysis;
  const again = analyzeImage({ data: a.base, width: a.width, height: a.height });
  const left = again.mode === 'photo' ? 0 : again.blocks.reduce((s, b) => s + b.area, 0);
  const total = a.blocks.reduce((s, b) => s + b.area, 0);
  assert.ok(left / total < 0.01, `còn sót ${left}px / ${total}px nội dung trong nền`);
});

test('dấu chấm nhỏ trong dòng chữ (·, dấu chấm trên chữ i) đi cùng dòng chữ, không bị bỏ lại nền', async () => {
  const p = await load(makeSlide());
  const a = p.analysis;
  // vùng dòng chân trang có 2 dấu "·": nền (base) trong vùng đó không được còn điểm sáng nào
  const foot = a.blocks.find(b => b.kind === 'footer')!;
  let bright = 0;
  for (let y = foot.y; y < foot.y + foot.h; y++) for (let x = foot.x; x < foot.x + foot.w; x++) {
    const i = (y * a.width + x) * 4;
    if (a.base[i] + a.base[i + 1] + a.base[i + 2] > 330) bright++;
  }
  assert.equal(bright, 0, `còn ${bright} điểm sáng của chữ/dấu trong nền ở chân trang`);
});

test('khung cuối = ảnh gốc, chính xác từng điểm ảnh', async () => {
  const src = makeSlide();
  const p = await load(src);
  const sc = new ImageMotionScene(p, { duration: 7, factory });
  const out = createCanvas(1920, 1080); const ctx = out.getContext('2d');
  sc.draw(ctx as unknown as object, 6.99, { x: 0, y: 0, w: 1920, h: 1080 });
  const A = ctx.getImageData(0, 0, 1920, 1080).data, B = src.getContext('2d').getImageData(0, 0, 1920, 1080).data;
  let max = 0; for (let i = 0; i < A.length; i++) max = Math.max(max, Math.abs(A[i] - B[i]));
  assert.equal(max, 0);
});

test('chế độ "tự động" giống video mẫu: chữ lớn quét hiện, có lóe sáng lướt qua chữ và viền sáng quanh thẻ', async () => {
  const p = await load(makeSlide());
  const auto = new ImageMotionScene(p, { duration: 7, style: 'auto', factory });
  const kinds = auto.plan.blocks.map(b => b.inKind);
  assert.ok(kinds.includes('wipe'), 'chữ lớn quét hiện: ' + kinds);
  assert.ok(auto.plan.blocks.some(b => b.emphasis?.some(e => e.kind === 'shine')), 'có lóe sáng lướt qua chữ');
  assert.ok(auto.plan.blocks.some(b => b.emphasis?.some(e => e.kind === 'glow')), 'có viền sáng quanh thẻ/ô');
  assert.equal(auto.plan.strict, false);
});

test('chế độ AN TOÀN CHỮ: không phóng to/thu nhỏ, không đổi màu chữ; chữ trong khối giữ nguyên từng điểm ảnh', async () => {
  const src = makeSlide();
  const p = await load(src);
  const safe = new ImageMotionScene(p, { duration: 7, style: 'text-safe', factory });
  assert.equal(safe.plan.strict, true);
  assert.ok(!safe.plan.blocks.some(b => b.inKind === 'pop'), 'không được có hiệu ứng phóng to (pop)');
  assert.ok(!safe.plan.blocks.some(b => b.emphasis?.some(e => e.kind === 'shine')), 'không được đổi màu chữ (shine)');
  // mọi thời điểm: scale luôn = 1
  for (let t = 0; t < 7; t += 0.1) {
    safe.plan.blocks.forEach(bp => assert.equal(stateAt(bp, t, 1920, 1080).scale, 1));
  }
  // lúc đang lóe viền sáng: lõi của khối (alpha = 255) phải trùng ảnh gốc từng điểm ảnh
  const A0 = src.getContext('2d').getImageData(0, 0, 1920, 1080).data;
  let checked = 0;
  safe.plan.blocks.forEach((bp, i) => {
    if (!bp.emphasis) return;
    const e = bp.emphasis[0];
    const t = (e.start + e.end) / 2;
    const st = stateAt(bp, t, 1920, 1080);
    if (!st.glow || st.dx !== 0 || st.dy !== 0) return;
    const out = createCanvas(1920, 1080); const ctx = out.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1920, 1080);
    safe.draw(ctx as unknown as object, t, { x: 0, y: 0, w: 1920, h: 1080 });
    const F = ctx.getImageData(0, 0, 1920, 1080).data;
    const b = p.analysis.blocks[i];
    let max = 0;
    for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
      if (b.layer[(y * b.w + x) * 4 + 3] !== 255) continue;
      const gi = ((b.y + y) * 1920 + b.x + x) * 4;
      for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(F[gi + c] - A0[gi + c]));
    }
    assert.ok(max <= 1, `khối #${i} lệch ${max} mức so với ảnh gốc khi đang sáng viền`);
    checked++;
  });
  assert.ok(checked >= 3, 'phải kiểm tra được ít nhất 3 khối, thực tế ' + checked);
});

test('ảnh chụp (không phải slide) tự chuyển sang zoom nhẹ, không cắt khối', async () => {
  const p = await load(makePhoto());
  assert.equal(p.analysis.mode, 'photo');
  const sc = new ImageMotionScene(p, { duration: 5, factory });
  assert.equal(sc.mode, 'photo');
  assert.equal(sc.blockCount, 0);
});
