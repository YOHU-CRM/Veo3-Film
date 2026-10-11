/**
 * imageMotion/analyze.ts
 *
 * Phân tích MỘT ảnh (slide / thẻ / infographic) để dựng hiệu ứng chuyển động mà KHÔNG làm đổi chữ:
 *   1. Ước lượng nền (mở xám cỡ lớn trên ảnh thu nhỏ) -> tìm vùng "nội dung" (chữ, thẻ, hình).
 *   2. Gom vùng nội dung thành các KHỐI (dòng chữ, thẻ, vòng tròn, thanh...) theo thứ tự đọc.
 *   3. Mỗi khối được cắt nguyên điểm ảnh gốc (chỉ dịch chuyển / mờ dần / lóe sáng, không vẽ lại).
 *   4. Vá nền sạch (pull-push inpainting) ở chỗ khối rời đi để lộ nền tự nhiên.
 *
 * Mọi thứ ở đây là hàm thuần trên mảng RGBA, không phụ thuộc DOM -> chạy được cả trong Node để test.
 */

export interface RGBAImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type BlockKind = 'header' | 'label' | 'footer' | 'text' | 'card' | 'badge' | 'item';

export interface MotionBlock {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** số điểm ảnh nội dung (không tính phần vá) */
  area: number;
  /** area / (w*h) */
  fill: number;
  kind: BlockKind;
  /** màu đậm nhất của khối (dùng cho vầng sáng) */
  color: [number, number, number];
  /** RGBA w*h*4: màu gốc + alpha (đã làm mềm mép) */
  layer: Uint8ClampedArray;
}

export interface AnalysisResult {
  mode: 'slide' | 'photo';
  /** tỷ lệ điểm ảnh bị coi là nội dung (0..1) */
  fgRatio: number;
  width: number;
  height: number;
  /** ảnh gốc nhưng vùng của các khối đã được thay bằng nền vá sạch */
  base: Uint8ClampedArray;
  /** các khối theo thứ tự đọc (trên->dưới, trái->phải) */
  blocks: MotionBlock[];
}

// ───────────────────────── tiện ích số học ─────────────────────────

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

// ───────────────────────── 1. Nền: "mở xám" cỡ lớn ─────────────────────────

/** Lọc cực trị trượt 1D bằng hàng đợi đơn điệu: O(n). */
function slide1D(src: Float32Array, n: number, stride: number, offset: number, r: number, isMin: boolean, out: Float32Array) {
  const dq = new Int32Array(n);
  let head = 0, tail = 0;
  const better = (a: number, b: number) => (isMin ? a <= b : a >= b);
  // out[i] = cực trị trên [i-r, i+r]
  let nextIn = 0;
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i + r);
    while (nextIn <= hi) {
      const v = src[offset + nextIn * stride];
      while (tail > head && better(v, src[offset + dq[tail - 1] * stride])) tail--;
      dq[tail++] = nextIn;
      nextIn++;
    }
    while (dq[head] < i - r) head++;
    out[offset + i * stride] = src[offset + dq[head] * stride];
  }
}

/** Lọc cực trị hình vuông (tách 2 lượt). */
function extremum2D(src: Float32Array, w: number, h: number, r: number, isMin: boolean): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) slide1D(src, w, 1, y * w, r, isMin, tmp);
  for (let x = 0; x < w; x++) slide1D(tmp, h, w, x, r, isMin, out);
  return out;
}

/**
 * Mặt nạ "nội dung nổi hơn nền".
 * Nền tối: nội dung sáng hơn nền; nền sáng: nội dung tối hơn nền.
 * Nền = phép mở (hoặc đóng) xám với phần tử cấu trúc ~ 22% cạnh dài -> mọi vật hẹp hơn mức đó đều bị loại,
 * nhờ vậy thẻ, chữ, vòng tròn không ảnh hưởng đến ước lượng nền (khác với đa thức hay bị lệch ở khe hẹp).
 */
function bgExcessMask(img: RGBAImage, thr: number): Uint8Array {
  const { data, width: w, height: h } = img;
  const f = Math.max(1, Math.round(Math.max(w, h) / 480));
  const lw = Math.max(2, Math.ceil(w / f)), lh = Math.max(2, Math.ceil(h / f));
  const lum = new Float32Array(lw * lh);
  const cnt = new Float32Array(lw * lh);
  const L = (p: number) => 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  let borderSum = 0, borderN = 0;
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  for (let y = 0; y < h; y++) {
    const cy = Math.min(lh - 1, Math.floor(y / f));
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const v = L(p);
      const q = cy * lw + Math.min(lw - 1, Math.floor(x / f));
      lum[q] += v; cnt[q]++;
      if (x < band || y < band || x >= w - band || y >= h - band) { borderSum += v; borderN++; }
    }
  }
  for (let i = 0; i < lum.length; i++) lum[i] = cnt[i] ? lum[i] / cnt[i] : 0;
  const dark = borderSum / Math.max(1, borderN) < 140;
  const r = Math.max(6, Math.round(0.11 * Math.max(lw, lh)));
  // dark: mở (min rồi max) ; sáng: đóng (max rồi min)
  const open = dark
    ? extremum2D(extremum2D(lum, lw, lh, r, true), lw, lh, r, false)
    : extremum2D(extremum2D(lum, lw, lh, r, false), lw, lh, r, true);

  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, Math.min(lh - 1, (y + 0.5) / f - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(lh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, Math.min(lw - 1, (x + 0.5) / f - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(lw - 1, x0 + 1), tx = fx - x0;
      const bgL = (open[y0 * lw + x0] * (1 - tx) + open[y0 * lw + x1] * tx) * (1 - ty)
                + (open[y1 * lw + x0] * (1 - tx) + open[y1 * lw + x1] * tx) * ty;
      const v = L((y * w + x) * 4);
      const excess = dark ? v - bgL : bgL - v;
      if (excess > thr) mask[y * w + x] = 1;
    }
  }
  return mask;
}

// ───────────────────────── 2. Hình thái học ─────────────────────────

/** Giãn nở hình chữ nhật (2 lượt, độ phức tạp O(n)). */
export function dilateBox(src: Uint8Array, w: number, h: number, rx: number, ry: number): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const pre = new Int32Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) {
    pre[0] = 0;
    for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + src[y * w + x];
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - rx);
      const b = Math.min(w, x + rx + 1);
      tmp[y * w + x] = pre[b] - pre[a] > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    pre[0] = 0;
    for (let y = 0; y < h; y++) pre[y + 1] = pre[y] + tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const a = Math.max(0, y - ry);
      const b = Math.min(h, y + ry + 1);
      out[y * w + x] = pre[b] - pre[a] > 0 ? 1 : 0;
    }
  }
  return out;
}

// ───────────────────────── 3. Vá nền (pull-push) ─────────────────────────

/**
 * Điền các điểm ảnh có mask=1 bằng giá trị nội suy từ vùng xung quanh (mask=0).
 * Trả về RGBA: chỗ mask=0 giữ nguyên ảnh gốc, chỗ mask=1 là nền vá mượt.
 */
export function pullPushFill(src: Uint8ClampedArray, mask: Uint8Array, w: number, h: number): Uint8ClampedArray {
  interface Lv { w: number; h: number; c: Float32Array; a: Float32Array }
  const lv0: Lv = { w, h, c: new Float32Array(w * h * 3), a: new Float32Array(w * h) };
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) {
      lv0.a[i] = 1;
      lv0.c[i * 3] = src[i * 4];
      lv0.c[i * 3 + 1] = src[i * 4 + 1];
      lv0.c[i * 3 + 2] = src[i * 4 + 2];
    }
  }
  const levels: Lv[] = [lv0];
  // PULL
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const f = levels[levels.length - 1];
    const cw = Math.max(1, Math.ceil(f.w / 2));
    const ch = Math.max(1, Math.ceil(f.h / 2));
    const n: Lv = { w: cw, h: ch, c: new Float32Array(cw * ch * 3), a: new Float32Array(cw * ch) };
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        let sa = 0, s0 = 0, s1 = 0, s2 = 0, cnt = 0;
        for (let dy = 0; dy < 2; dy++) {
          const yy = y * 2 + dy;
          if (yy >= f.h) continue;
          for (let dx = 0; dx < 2; dx++) {
            const xx = x * 2 + dx;
            if (xx >= f.w) continue;
            const q = yy * f.w + xx;
            cnt++;
            sa += f.a[q];
            s0 += f.c[q * 3];
            s1 += f.c[q * 3 + 1];
            s2 += f.c[q * 3 + 2];
          }
        }
        const o = y * cw + x;
        n.a[o] = sa / cnt;
        n.c[o * 3] = s0 / cnt;
        n.c[o * 3 + 1] = s1 / cnt;
        n.c[o * 3 + 2] = s2 / cnt;
      }
    }
    levels.push(n);
  }
  // đỉnh kim tự tháp: nếu chưa có dữ liệu thì dùng xám trung bình
  const top = levels[levels.length - 1];
  if (top.a[0] < 1e-6) { top.c[0] = 40; top.c[1] = 50; top.c[2] = 70; top.a[0] = 1; }
  else { top.c[0] /= top.a[0]; top.c[1] /= top.a[0]; top.c[2] /= top.a[0]; top.a[0] = 1; }

  // PUSH
  for (let L = levels.length - 2; L >= 0; L--) {
    const f = levels[L];
    const co = levels[L + 1]; // đã được điền đầy (a = 1, c = màu thật)
    for (let y = 0; y < f.h; y++) {
      const fy = clamp((y + 0.5) / 2 - 0.5, 0, co.h - 1);
      const y0 = Math.floor(fy), y1 = Math.min(co.h - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < f.w; x++) {
        const q = y * f.w + x;
        const a = f.a[q];
        if (a >= 1) continue;
        const fx = clamp((x + 0.5) / 2 - 0.5, 0, co.w - 1);
        const x0 = Math.floor(fx), x1 = Math.min(co.w - 1, x0 + 1), tx = fx - x0;
        for (let c = 0; c < 3; c++) {
          const v00 = co.c[(y0 * co.w + x0) * 3 + c];
          const v10 = co.c[(y0 * co.w + x1) * 3 + c];
          const v01 = co.c[(y1 * co.w + x0) * 3 + c];
          const v11 = co.c[(y1 * co.w + x1) * 3 + c];
          const interp = (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
          // f.c đang ở dạng "nhân sẵn a" -> (c + (1-a)*interp) là màu thật
          f.c[q * 3 + c] = f.c[q * 3 + c] + (1 - a) * interp;
        }
        f.a[q] = 1;
      }
    }
  }

  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (mask[i]) {
      out[i * 4] = lv0.c[i * 3];
      out[i * 4 + 1] = lv0.c[i * 3 + 1];
      out[i * 4 + 2] = lv0.c[i * 3 + 2];
    } else {
      out[i * 4] = src[i * 4];
      out[i * 4 + 1] = src[i * 4 + 1];
      out[i * 4 + 2] = src[i * 4 + 2];
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}

// ───────────────────────── 4. Khối ─────────────────────────

interface RawBlock {
  x0: number; y0: number; x1: number; y1: number; // [x0,x1) [y0,y1)
  area: number;
  members: number[];
  /** khung kín (thẻ, ô viên thuốc): có vùng trống bị bao quanh */
  container?: boolean;
}

/** Gom nhóm bằng union-find khi hộp (đã nới `pad`) chồng nhau. */
function mergeOverlaps(boxes: RawBlock[], pad: number): RawBlock[] {
  let list = boxes;
  let changed = true;
  while (changed) {
    changed = false;
    const used = new Array(list.length).fill(false);
    const next: RawBlock[] = [];
    for (let i = 0; i < list.length; i++) {
      if (used[i]) continue;
      let cur = list[i];
      used[i] = true;
      let grown = true;
      while (grown) {
        grown = false;
        for (let j = 0; j < list.length; j++) {
          if (used[j]) continue;
          const o = list[j];
          if (cur.x0 - pad < o.x1 && o.x0 - pad < cur.x1 && cur.y0 - pad < o.y1 && o.y0 - pad < cur.y1) {
            cur = {
              x0: Math.min(cur.x0, o.x0), y0: Math.min(cur.y0, o.y0),
              x1: Math.max(cur.x1, o.x1), y1: Math.max(cur.y1, o.y1),
              area: cur.area + o.area, members: cur.members.concat(o.members),
              container: !!(cur.container || o.container),
            };
            used[j] = true;
            grown = true;
            changed = true;
          }
        }
      }
      next.push(cur);
    }
    list = next;
  }
  return list;
}

/** Loại nhiễu: chấm nhỏ và đường kẻ mảnh (ví dụ lưới nền). Trả về số điểm ảnh còn lại. */
function cleanFg(fg: Uint8Array, w: number, h: number, scale: number, tinyOut?: Uint8Array): number {
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const minDim = 6 * scale;
  const thin = Math.max(2, Math.round(2 * scale));
  let kept = 0;
  for (let s = 0; s < w * h; s++) {
    if (!fg[s] || seen[s]) continue;
    stack.length = 0;
    stack.push(s);
    seen[s] = 1;
    const members: number[] = [];
    let minx = w, miny = h, maxx = 0, maxy = 0;
    while (stack.length) {
      const q = stack.pop() as number;
      members.push(q);
      const x = q % w, y = (q - x) / w;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const n = yy * w + xx;
          if (fg[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
    }
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    const tiny = Math.max(bw, bh) < minDim && members.length < 30 * scale * scale;
    const line = (bw >= 40 * scale && bh <= thin) || (bh >= 40 * scale && bw <= thin);
    if (tiny || line) {
      for (const q of members) fg[q] = 0;
      // chấm nhỏ (dấu câu, dấu chấm trên chữ i, dấu · ngăn cách) - KHÔNG phải đường kẻ: giữ lại để đi cùng dòng chữ
      if (tiny && !line && tinyOut) for (const q of members) tinyOut[q] = 1;
    } else kept += members.length;
  }
  return kept;
}

/** Cụm có vùng trống bị bao kín (thẻ / ô viên thuốc) trên lưới ô thô. */
function isContainer(dil: Uint8Array, cw: number, ch: number, cx0: number, cy0: number, cx1: number, cy1: number): boolean {
  const bw = cx1 - cx0, bh = cy1 - cy0;
  if (bw < 3 || bh < 3) return false;
  const outside = new Uint8Array(bw * bh);
  const st: number[] = [];
  const tryPush = (x: number, y: number) => {
    const q = y * bw + x;
    if (!outside[q] && !dil[(cy0 + y) * cw + cx0 + x]) { outside[q] = 1; st.push(q); }
  };
  for (let x = 0; x < bw; x++) { tryPush(x, 0); tryPush(x, bh - 1); }
  for (let y = 0; y < bh; y++) { tryPush(0, y); tryPush(bw - 1, y); }
  while (st.length) {
    const q = st.pop() as number;
    const x = q % bw, y = (q - x) / bw;
    if (x > 0) tryPush(x - 1, y);
    if (x < bw - 1) tryPush(x + 1, y);
    if (y > 0) tryPush(x, y - 1);
    if (y < bh - 1) tryPush(x, y + 1);
  }
  let enclosed = 0;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const q = y * bw + x;
    if (!outside[q] && !dil[(cy0 + y) * cw + cx0 + x]) enclosed++;
  }
  return enclosed / (bw * bh) > 0.2;
}

function classify(b: { x: number; y: number; w: number; h: number; fill: number; container?: boolean }, W: number, H: number): BlockKind {
  const aspect = b.w / b.h;
  if (b.y + b.h < H * 0.14 && b.x + b.w > W * 0.8 && b.w < W * 0.2) return 'label';
  if (b.y + b.h < H * 0.14 && b.h < H * 0.08) return 'header';
  if (b.y > H * 0.86 && b.h < H * 0.09) return 'footer';
  if (b.container && aspect > 2 && b.h < H * 0.14) return 'item';
  if (aspect > 3.2 && b.h < H * 0.26) return 'text';
  if (!b.container && aspect > 2.2 && b.h < H * 0.4 && b.fill < 0.7) return 'text';
  if (aspect > 0.6 && aspect < 1.7 && b.w < W * 0.42 && b.w > W * 0.025 && b.fill > 0.45) return 'badge';
  if (b.w > W * 0.15 && b.h > H * 0.09) return 'card';
  return 'item';
}

/** thứ tự đọc: gom theo hàng (chồng lấn dọc >= 40% chiều cao nhỏ hơn) rồi sắp theo x */
function readingOrder<T extends { x: number; y: number; w: number; h: number }>(list: T[]): T[] {
  const sorted = [...list].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Array<{ top: number; bottom: number; items: T[] }> = [];
  for (const b of sorted) {
    const row = rows.find((r) => {
      const overlap = Math.min(r.bottom, b.y + b.h) - Math.max(r.top, b.y);
      return overlap >= 0.4 * Math.min(r.bottom - r.top, b.h);
    });
    if (row) {
      row.items.push(b);
      row.top = Math.min(row.top, b.y);
      row.bottom = Math.max(row.bottom, b.y + b.h);
    } else {
      rows.push({ top: b.y, bottom: b.y + b.h, items: [b] });
    }
  }
  rows.sort((a, b) => a.top - b.top);
  const sameCol = (a: { x: number }, b: { x: number }) => Math.abs(a.x - b.x) < 24;
  return rows.flatMap((r) => r.items.sort((a, b) => (sameCol(a, b) ? a.y - b.y : a.x - b.x)));
}

export interface AnalyzeOptions {
  /** ngưỡng điểm ảnh nội dung so với nền vá (tổng |ΔRGB|) */
  threshold?: number;
  /** nếu tỷ lệ nội dung vượt mức này -> coi là ảnh chụp (photo) */
  photoRatio?: number;
  /** chỉ để gỡ lỗi: nhận mặt nạ trung gian */
  onDebug?: (d: { mask0: Uint8Array; fg: Uint8Array; B1: Uint8ClampedArray; stage?: string; raws?: Array<{ x0: number; y0: number; x1: number; y1: number; area: number; container?: boolean }> }) => void;
}

export function analyzeImage(img: RGBAImage, opts: AnalyzeOptions = {}): AnalysisResult {
  const { data, width: w, height: h } = img;
  const T1 = opts.threshold ?? 18;
  const photoRatio = opts.photoRatio ?? 0.5;
  const scale = Math.max(w, h) / 1920;
  const r3 = Math.max(2, Math.round(3 * scale));

  const photo = (ratio: number): AnalysisResult => ({
    mode: 'photo', fgRatio: ratio, width: w, height: h, base: data, blocks: [],
  });

  // 1) nền (mở xám cỡ lớn) + vùng nội dung
  const mask0 = bgExcessMask(img, 15);
  const m0d = dilateBox(mask0, w, h, r3, r3);

  // 2) vá nền cục bộ rồi lấy lại vùng nội dung chính xác hơn
  const B1 = pullPushFill(data, m0d, w, h);
  const fg = new Uint8Array(w * h);
  let fgCount = 0;
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    const d = Math.abs(data[p] - B1[p]) + Math.abs(data[p + 1] - B1[p + 1]) + Math.abs(data[p + 2] - B1[p + 2]);
    if (d > T1 && mask0[i]) { fg[i] = 1; fgCount++; }
  }
  opts.onDebug?.({ mask0, fg, B1 });
  const fgRatio = fgCount / (w * h);
  if (fgRatio > photoRatio || fgCount === 0) return photo(fgRatio);

  // 2b) loại chấm nhỏ & đường lưới mảnh
  const edge = Math.max(3, Math.round(4 * scale));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < edge || y < edge || x >= w - edge || y >= h - edge) fg[y * w + x] = 0;
    }
  }
  const tinyDots = new Uint8Array(w * h);
  const kept = cleanFg(fg, w, h, scale, tinyDots);
  if (kept === 0) return photo(fgRatio);

  // 3) gom khối: (a) cụm nhỏ ở lưới thô, (b) ghép các từ thành dòng chữ, (c) gộp hộp chồng nhau
  const f = Math.max(2, Math.round(Math.max(w, h) / 480));
  const cw = Math.ceil(w / f);
  const ch = Math.ceil(h / f);
  const cells = new Uint8Array(cw * ch);
  for (let y = 0; y < h; y++) {
    const cy = Math.floor(y / f);
    for (let x = 0; x < w; x++) if (fg[y * w + x]) cells[cy * cw + Math.floor(x / f)] = 1;
  }
  const minArea = Math.max(30, Math.round(40 * scale * scale));
  const pad = r3 + 3;
  let hx = Math.max(1, Math.floor((4 * scale) / f));
  let hy = Math.max(1, Math.floor((6 * scale) / f));

  let raws: RawBlock[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const dil = dilateBox(cells, cw, ch, hx, hy);
    const comp = new Int32Array(cw * ch).fill(-1);
    const cbox: Array<[number, number, number, number]> = [];
    const stack: number[] = [];
    let nComp = 0;
    for (let s0 = 0; s0 < cw * ch; s0++) {
      if (!dil[s0] || comp[s0] >= 0) continue;
      comp[s0] = nComp;
      stack.push(s0);
      let x0 = cw, y0 = ch, x1 = 0, y1 = 0;
      while (stack.length) {
        const q = stack.pop() as number;
        const qx = q % cw, qy = (q - qx) / cw;
        if (qx < x0) x0 = qx;
        if (qx + 1 > x1) x1 = qx + 1;
        if (qy < y0) y0 = qy;
        if (qy + 1 > y1) y1 = qy + 1;
        if (qx > 0 && dil[q - 1] && comp[q - 1] < 0) { comp[q - 1] = nComp; stack.push(q - 1); }
        if (qx < cw - 1 && dil[q + 1] && comp[q + 1] < 0) { comp[q + 1] = nComp; stack.push(q + 1); }
        if (qy > 0 && dil[q - cw] && comp[q - cw] < 0) { comp[q - cw] = nComp; stack.push(q - cw); }
        if (qy < ch - 1 && dil[q + cw] && comp[q + cw] < 0) { comp[q + cw] = nComp; stack.push(q + cw); }
      }
      cbox.push([x0, y0, x1, y1]);
      nComp++;
    }
    const acc: RawBlock[] = [];
    for (let i = 0; i < nComp; i++) {
      const [x0, y0, x1, y1] = cbox[i];
      acc.push({ x0: w, y0: h, x1: 0, y1: 0, area: 0, members: [i], container: isContainer(dil, cw, ch, x0, y0, x1, y1) });
    }
    for (let y = 0; y < h; y++) {
      const crow = Math.floor(y / f) * cw;
      for (let x = 0; x < w; x++) {
        if (!fg[y * w + x]) continue;
        const id = comp[crow + Math.floor(x / f)];
        if (id < 0) continue;
        const a = acc[id];
        a.area++;
        if (x < a.x0) a.x0 = x;
        if (x + 1 > a.x1) a.x1 = x + 1;
        if (y < a.y0) a.y0 = y;
        if (y + 1 > a.y1) a.y1 = y + 1;
      }
    }
    let list = acc.filter((a) => a.area >= minArea);

    // (b) ghép các từ cùng hàng thành dòng chữ (không ghép khung kín như thẻ / ô viên thuốc)
    const smallH = h * 0.14;
    const eligible = (r: RawBlock) => {
      const bh = r.y1 - r.y0, bw = r.x1 - r.x0;
      return !r.container && (bh <= smallH || (bh <= h * 0.42 && r.area / (bw * bh) < 0.6));
    };
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const A = list[i], B = list[j];
          if (!eligible(A) || !eligible(B)) continue;
          const ha = A.y1 - A.y0, hb = B.y1 - B.y0;
          const vOverlap = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
          if (vOverlap < 0.5 * Math.min(ha, hb)) continue;
          const gap = Math.max(0, Math.max(A.x0, B.x0) - Math.min(A.x1, B.x1));
          const mh = Math.max(ha, hb);
          if (gap > (mh <= smallH ? 1.1 : 0.3) * mh) continue;
          list[i] = {
            x0: Math.min(A.x0, B.x0), y0: Math.min(A.y0, B.y0), x1: Math.max(A.x1, B.x1), y1: Math.max(A.y1, B.y1),
            area: A.area + B.area, members: A.members.concat(B.members),
          };
          list.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
    // (c) hộp chồng nhau (chữ nằm trong thẻ...) -> một khối
    raws = mergeOverlaps(list, pad);
    if (raws.length <= 60) break;
    hx *= 2; hy *= 2;
  }
  if (raws.length === 0) return photo(fgRatio);

  // 4) dựng layer + mặt nạ cho từng khối
  const ordered = readingOrder(
    raws.map((r) => ({ x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0, raw: r })),
  );
  const union = new Uint8Array(w * h);
  const blocks: MotionBlock[] = [];

  ordered.forEach((o, id) => {
    const bx0 = Math.max(0, o.x - pad), by0 = Math.max(0, o.y - pad);
    const bx1 = Math.min(w, o.x + o.w + pad), by1 = Math.min(h, o.y + o.h + pad);
    const bw = bx1 - bx0, bh = by1 - by0;
    // mặt nạ cục bộ
    const local = new Uint8Array(bw * bh);
    let area = 0;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const gi = (by0 + y) * w + bx0 + x;
        if (fg[gi]) { local[y * bw + x] = 1; area++; }
        else if (tinyDots[gi]) {
          const gx = bx0 + x, gy = by0 + y;
          if (gx >= o.x && gx < o.x + o.w && gy >= o.y && gy < o.y + o.h) local[y * bw + x] = 1;
        }
      }
    }
    // lấp lỗ kín (ruột thẻ, tâm vòng tròn): loang từ rìa qua vùng trống
    const outside = new Uint8Array(bw * bh);
    const st: number[] = [];
    const push = (x: number, y: number) => {
      const q = y * bw + x;
      if (!local[q] && !outside[q]) { outside[q] = 1; st.push(q); }
    };
    for (let x = 0; x < bw; x++) { push(x, 0); push(x, bh - 1); }
    for (let y = 0; y < bh; y++) { push(0, y); push(bw - 1, y); }
    while (st.length) {
      const q = st.pop() as number;
      const qx = q % bw, qy = (q - qx) / bw;
      if (qx > 0) push(qx - 1, qy);
      if (qx < bw - 1) push(qx + 1, qy);
      if (qy > 0) push(qx, qy - 1);
      if (qy < bh - 1) push(qx, qy + 1);
    }
    for (let q = 0; q < bw * bh; q++) if (!local[q] && !outside[q]) local[q] = 1;

    // alpha: lõi giãn r3 (=1 tuyệt đối), mép mềm thêm ~2px
    const core = dilateBox(local, bw, bh, r3, r3);
    const wide = dilateBox(local, bw, bh, r3 + 1, r3 + 1);
    const layer = new Uint8ClampedArray(bw * bh * 4);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const q = y * bw + x;
        // làm mềm 3x3 trên mặt nạ "wide"
        let s = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= bh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= bw) continue;
            s += wide[yy * bw + xx]; c++;
          }
        }
        let a = s / c;
        if (core[q]) a = 1;
        const gp = ((by0 + y) * w + bx0 + x) * 4;
        layer[q * 4] = data[gp];
        layer[q * 4 + 1] = data[gp + 1];
        layer[q * 4 + 2] = data[gp + 2];
        layer[q * 4 + 3] = Math.round(a * 255);
        if (a > 0) union[(by0 + y) * w + bx0 + x] = 1;
      }
    }

    // màu đậm nhất (cho vầng sáng)
    let sr = 0, sg = 0, sb = 0, sw = 0;
    for (let q = 0; q < bw * bh; q++) {
      if (!local[q]) continue;
      const r = layer[q * 4], g = layer[q * 4 + 1], b = layer[q * 4 + 2];
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      if (sat > 90) { const wgt = sat; sr += r * wgt; sg += g * wgt; sb += b * wgt; sw += wgt; }
    }
    const color: [number, number, number] = sw > 0
      ? [Math.round(sr / sw), Math.round(sg / sw), Math.round(sb / sw)]
      : [150, 205, 255];

    const fill = area / (o.w * o.h);
    blocks.push({
      id, x: bx0, y: by0, w: bw, h: bh, area, fill,
      kind: classify({ x: o.x, y: o.y, w: o.w, h: o.h, fill, container: o.raw.container }, w, h),
      color, layer,
    });
  });

  // 5) nền vá sạch cho vùng của mọi khối
  const base = pullPushFill(data, union, w, h);
  return { mode: 'slide', fgRatio, width: w, height: h, base, blocks };
}
