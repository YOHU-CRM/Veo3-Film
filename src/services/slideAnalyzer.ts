/**
 * Nhận diện các KHỐI ĐỐI TƯỢNG trên một ảnh slide / infographic (nền trắng hoặc nền đậm)
 * bằng xử lý ảnh trong trình duyệt (không tốn API, không cần mạng).
 *
 * Cách làm: tìm các cạnh (nơi màu đổi đột ngột) -> làm dày -> gom thành cụm -> mỗi cụm là một khối
 * (tiêu đề, thẻ, ô số liệu, ghi chú...). Trả về toạ độ chuẩn hoá 0..1 + màu nền xung quanh để "che"
 * khối đó trước khi nó xuất hiện.
 */

export interface SlideRegion {
  x: number; // 0..1
  y: number;
  w: number;
  h: number;
  /** màu nền ngay quanh khối, dạng 'rgb(r,g,b)' */
  bg: string;
}

interface Box { x0: number; y0: number; x1: number; y1: number }

const GRID_W = 480;
const EDGE_THRESHOLD = 24;
const MIN_AREA_RATIO = 0.004;
const MAX_REGIONS = 10;

export function detectSlideRegions(img: CanvasImageSource & { width?: number; height?: number }, naturalW: number, naturalH: number): SlideRegion[] {
  if (!naturalW || !naturalH) return [];
  const gw = GRID_W;
  const gh = Math.max(8, Math.round((GRID_W * naturalH) / naturalW));
  const cv = document.createElement('canvas');
  cv.width = gw;
  cv.height = gh;
  const c = cv.getContext('2d', { willReadFrequently: true });
  if (!c) return [];
  c.imageSmoothingEnabled = true;
  c.drawImage(img, 0, 0, gw, gh);
  let data: Uint8ClampedArray;
  try {
    data = c.getImageData(0, 0, gw, gh).data;
  } catch {
    return []; // ảnh bị chặn CORS -> bỏ qua hiệu ứng
  }

  const gray = new Float32Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }

  // 1) cạnh
  const edge = new Uint8Array(gw * gh);
  for (let y = 0; y < gh - 1; y++) {
    for (let x = 0; x < gw - 1; x++) {
      const i = y * gw + x;
      const g = Math.abs(gray[i] - gray[i + 1]) + Math.abs(gray[i] - gray[i + gw]);
      if (g > EDGE_THRESHOLD) edge[i] = 1;
    }
  }

  // 2) Cắt kiểu "XY-cut": tìm các khoảng trống (không có cạnh) giữa các khối rồi cắt đệ quy
  const total = gw * gh;
  const MIN_GAP_ROW = 4; // khoảng trống tối thiểu giữa 2 hàng (ô lưới)
  const MIN_GAP_COL = 4; // giữa 2 cột (lớn hơn để không tách từng từ)
  const area = (b: Box) => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);

  const segments = (lo: number, hi: number, minGap: number, has: (i: number) => boolean): [number, number][] => {
    const segs: [number, number][] = [];
    let start = -1;
    let gap = 0;
    let lastFull = -1;
    for (let i = lo; i <= hi; i++) {
      if (has(i)) {
        if (start < 0) start = i;
        lastFull = i;
        gap = 0;
      } else if (start >= 0) {
        gap++;
        if (gap >= minGap) {
          segs.push([start, lastFull]);
          start = -1;
          gap = 0;
        }
      }
    }
    if (start >= 0) segs.push([start, lastFull]);
    return segs;
  };

  const tighten = (b: Box): Box | null => {
    let x0 = b.x1, y0 = b.y1, x1 = b.x0, y1 = b.y0;
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        if (edge[y * gw + x]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    return x1 >= x0 && y1 >= y0 ? { x0, y0, x1, y1 } : null;
  };

  const leaves: Box[] = [];
  const cut = (box: Box, depth: number) => {
    const b = tighten(box);
    if (!b) return;
    const big = area(b) / total > 0.15; // khối lớn (cả trang): được cắt theo cả hàng lẫn cột
    const wide = b.x1 - b.x0 > gw * 0.55; // một hàng ngang rộng: chỉ cắt theo cột (thẻ 1,2,3,4...)
    if (depth < 6 && (big || wide)) {
      if (big) {
        // bỏ qua 2 ô sát mép khi đếm (viền khung ngoài chạy suốt chiều cao sẽ che mất khoảng trống)
        const rows = segments(b.y0, b.y1, MIN_GAP_ROW, (y) => {
          for (let x = b.x0 + 4; x <= b.x1 - 4; x++) if (edge[y * gw + x]) return true;
          return false;
        });
        if (rows.length >= 2) {
          rows.forEach(([a, c]) => cut({ x0: b.x0, x1: b.x1, y0: a, y1: c }, depth + 1));
          return;
        }
      }
      const cols = segments(b.x0, b.x1, MIN_GAP_COL, (x) => {
        const from = big ? b.y0 + 4 : b.y0;
        const to = big ? b.y1 - 4 : b.y1;
        for (let y = from; y <= to; y++) if (edge[y * gw + x]) return true;
        return false;
      });
      if (cols.length >= 2) {
        cols.forEach(([a, c]) => cut({ x0: a, x1: c, y0: b.y0, y1: b.y1 }, depth + 1));
        return;
      }
    }
    leaves.push(b);
  };
  cut({ x0: 0, y0: 0, x1: gw - 2, y1: gh - 2 }, 0);

  // 3) bỏ khối quá nhỏ (đường kẻ mảnh, chấm lẻ)
  let boxes = leaves.filter((b) => area(b) / total >= MIN_AREA_RATIO && b.y1 - b.y0 >= 4 && b.x1 - b.x0 >= 4);

  // 4) quá nhiều khối: gộp 2 khối liền kề (theo thứ tự đọc) gần nhau nhất
  const gapBetween = (a: Box, b: Box) => {
    const dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1));
    const dy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));
    return dx + dy;
  };
  while (boxes.length > MAX_REGIONS) {
    let bi = 0, bg = Infinity;
    for (let i = 0; i < boxes.length - 1; i++) {
      const g = gapBetween(boxes[i], boxes[i + 1]);
      if (g < bg) { bg = g; bi = i; }
    }
    const a = boxes[bi], b = boxes[bi + 1];
    boxes.splice(bi, 2, { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
  }

  if (boxes.length < 2) return [];

  // 7) màu nền quanh khối
  const colorAround = (b: Box): string => {
    const rs: number[] = [], gs: number[] = [], bs: number[] = [];
    const add = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= gw || y >= gh) return;
      const i = (y * gw + x) * 4;
      rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
    };
    for (let k = 1; k <= 3; k++) {
      for (let x = b.x0 - k; x <= b.x1 + k; x++) { add(x, b.y0 - k); add(x, b.y1 + k); }
      for (let y = b.y0 - k; y <= b.y1 + k; y++) { add(b.x0 - k, y); add(b.x1 + k, y); }
    }
    if (!rs.length) return 'rgb(255,255,255)';
    const med = (arr: number[]) => { arr.sort((p, q) => p - q); return arr[arr.length >> 1]; };
    return `rgb(${med(rs)},${med(gs)},${med(bs)})`;
  };

  // nới nhẹ khung để che sạch viền mờ / bóng đổ quanh khối
  const padX = 4, padTop = 4, padBottom = 8;
  return boxes.map((b) => {
    const x0 = Math.max(0, b.x0 - padX), y0 = Math.max(0, b.y0 - padTop);
    const x1 = Math.min(gw, b.x1 + 1 + padX), y1 = Math.min(gh, b.y1 + 1 + padBottom);
    return {
      x: x0 / gw,
      y: y0 / gh,
      w: (x1 - x0) / gw,
      h: (y1 - y0) / gh,
      bg: colorAround({ x0, y0, x1: x1 - 1, y1: y1 - 1 }),
    };
  });
}
