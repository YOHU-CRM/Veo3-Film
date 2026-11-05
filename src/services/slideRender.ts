/**
 * Vẽ SLIDE CHỮ trực tiếp bằng canvas (chữ vector, vẽ đúng độ phân giải video xuất ra → nét, không vỡ).
 * Dùng chung cho: ảnh xem trước trong ô tạo slide, và lúc dựng video (có hiệu ứng đánh máy, hiện từng ý...).
 *
 * Bố cục giống PowerPoint: tiêu đề + gạch đầu dòng, slide tiêu đề, ảnh bên phải/trái, ảnh nền toàn trang, trích dẫn.
 */
import { isMarkerToken } from './subtitleCues';

export type SlideLayoutKind = 'auto' | 'text' | 'title' | 'photo-right' | 'photo-left' | 'photo-full' | 'quote';
export type SlideAnim = 'typewriter' | 'bullets' | 'fade' | 'none';

export interface SlideTheme {
  name: string;
  bg: [string, string];
  accent: string;
  text: string;
  sub: string;
  light: boolean;
}

export const SLIDE_THEMES: SlideTheme[] = [
  { name: 'Đêm tím', bg: ['#0b1020', '#1e1b4b'], accent: '#818cf8', text: '#ffffff', sub: '#e5e7f5', light: false },
  { name: 'Ngọc lam', bg: ['#04201f', '#0f172a'], accent: '#2dd4bf', text: '#ffffff', sub: '#e2f5f1', light: false },
  { name: 'Hoàng hôn', bg: ['#1a1410', '#2e1065'], accent: '#fbbf24', text: '#ffffff', sub: '#f5eedd', light: false },
  { name: 'Hồng tím', bg: ['#0b1226', '#3b0764'], accent: '#f472b6', text: '#ffffff', sub: '#f3e3f1', light: false },
  { name: 'Trắng sạch', bg: ['#ffffff', '#e8edff'], accent: '#4f46e5', text: '#0f172a', sub: '#334155', light: true },
  { name: 'Xanh doanh nghiệp', bg: ['#0c4a6e', '#082f49'], accent: '#38bdf8', text: '#ffffff', sub: '#e0f2fe', light: false },
  { name: 'Đỏ đô', bg: ['#2a0a12', '#4a0d1d'], accent: '#fb7185', text: '#ffffff', sub: '#fde4e8', light: false },
];

export interface TextSlideSpec {
  title: string;
  paras: string[];
  layout: SlideLayoutKind;
  /** chỉ số bảng màu; -1 = tự động theo thứ tự slide */
  theme: number;
  anim: SlideAnim;
  photoUrl?: string;
  credit?: string;
  index: number;
  total: number;
}

export interface SlidePhotoRef {
  img: CanvasImageSource;
  w: number;
  h: number;
}

const FONT = '"Outfit", "Inter", "Segoe UI", Roboto, Arial, sans-serif';

interface LineItem {
  text: string;
  x: number;
  y: number;
  size: number;
  weight: number;
  role: 'title' | 'body' | 'sub';
  /** nhóm hiệu ứng: 0 = tiêu đề, 1.. = từng đoạn */
  group: number;
  bullet: boolean;
  charStart: number;
  center: boolean;
  italic?: boolean;
}

interface Rect { x: number; y: number; w: number; h: number }

export interface SlideLayout {
  kind: Exclude<SlideLayoutKind, 'auto'> | 'photo-top';
  items: LineItem[];
  totalChars: number;
  groups: number;
  photo?: Rect;
  bullets: boolean;
  u: number;
  quoteMark?: { x: number; y: number; size: number };
  accentBar?: { x: number; y: number; w: number; h: number; center: boolean };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOut = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);

export function themeOf(spec: TextSlideSpec): SlideTheme {
  const i = spec.theme >= 0 ? spec.theme : spec.index;
  return SLIDE_THEMES[((i % SLIDE_THEMES.length) + SLIDE_THEMES.length) % SLIDE_THEMES.length];
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) {
      lines.push(line);
      line = w;
    } else {
      line = t;
    }
  }
  if (line) lines.push(line);
  // ký hiệu đầu dòng (I. / 2. / a)) không nằm cuối dòng
  for (let i = 0; i < lines.length - 1; i++) {
    const ws = lines[i].split(' ');
    const last = ws[ws.length - 1];
    if (isMarkerToken(last) && (ws.length === 1 || /[.;:!?…]["”’)\]]?$/.test(ws[ws.length - 2]))) {
      ws.pop();
      lines[i] = ws.join(' ');
      lines[i + 1] = `${last} ${lines[i + 1]}`;
    }
  }
  return lines;
}

export function computeLayout(ctx: CanvasRenderingContext2D, spec: TextSlideSpec, W: number, H: number, reserve: number, hasPhoto: boolean): SlideLayout {
  const u = Math.min(W, H) / 1080;
  const portrait = H > W * 1.15;
  const title = (spec.title || '').trim();
  const paras = (spec.paras || []).map((p) => p.trim()).filter(Boolean);

  let kind: SlideLayout['kind'];
  const want = spec.layout || 'auto';
  if (want === 'auto') {
    if (hasPhoto) kind = portrait ? 'photo-top' : 'photo-right';
    else if (title && paras.length === 0) kind = 'title';
    else if (!title && paras.length === 1) kind = 'quote';
    else kind = 'text';
  } else if ((want === 'photo-right' || want === 'photo-left' || want === 'photo-full') && !hasPhoto) {
    kind = 'text';
  } else if ((want === 'photo-right' || want === 'photo-left') && portrait) {
    kind = 'photo-top';
  } else {
    kind = want;
  }

  const padX = (portrait ? 70 : 120) * u;
  const top = (portrait ? 150 : 130) * u;
  const bottom = H - Math.max(reserve, 0) - 90 * u;
  const areaH = Math.max(200 * u, bottom - top);

  let textRect: Rect = { x: padX, y: top, w: W - padX * 2, h: areaH };
  let photo: Rect | undefined;
  if (kind === 'photo-right') {
    photo = { x: W * 0.54, y: top - 10 * u, w: W * 0.46 - padX, h: areaH + 10 * u };
    textRect = { x: padX, y: top, w: W * 0.54 - padX - 50 * u, h: areaH };
  } else if (kind === 'photo-left') {
    photo = { x: padX, y: top - 10 * u, w: W * 0.46 - padX, h: areaH + 10 * u };
    textRect = { x: W * 0.46 + 50 * u, y: top, w: W - (W * 0.46 + 50 * u) - padX, h: areaH };
  } else if (kind === 'photo-top') {
    const ph = areaH * 0.4;
    photo = { x: padX, y: top - 20 * u, w: W - padX * 2, h: ph };
    textRect = { x: padX, y: top - 20 * u + ph + 40 * u, w: W - padX * 2, h: areaH - ph - 20 * u };
  } else if (kind === 'photo-full') {
    textRect = { x: padX + 20 * u, y: top, w: W - (padX + 20 * u) * 2, h: areaH };
  }

  const items: LineItem[] = [];
  let charStart = 0;
  const center = kind === 'title' || kind === 'quote';
  const cx = textRect.x + textRect.w / 2;
  const tx = center ? cx : textRect.x;

  // ── tiêu đề ──
  const titleSizes = kind === 'title' ? [132, 118, 104, 92, 80, 68] : kind === 'quote' ? [54, 48, 42] : [84, 76, 68, 60, 54, 48];
  let titleLines: string[] = [];
  let titleSize = titleSizes[titleSizes.length - 1] * u;
  if (title) {
    for (const s of titleSizes) {
      ctx.font = `800 ${s * u}px ${FONT}`;
      const l = wrap(ctx, title, textRect.w);
      titleLines = l;
      titleSize = s * u;
      if (l.length <= (kind === 'title' ? 4 : 3)) break;
    }
  }
  const titleLH = titleSize * 1.18;
  const titleBlockH = title ? titleLines.length * titleLH + (kind === 'quote' ? 24 * u : 70 * u) : 0;

  // ── nội dung ──
  const multi = paras.length > 1 && kind !== 'quote' && kind !== 'title';
  const bodySizes = kind === 'title' ? [50, 44, 38, 34] : kind === 'quote' ? [74, 66, 58, 52, 46, 40, 34] : [52, 46, 41, 37, 33, 30, 27];
  const indent = multi ? 54 * u : 0;
  let chosen = bodySizes[bodySizes.length - 1];
  let bodyLines: { text: string; bullet: boolean; group: number }[] = [];
  let bodyH = 0;
  const gapOf = (sz: number) => sz * 0.4;
  for (const s of bodySizes) {
    ctx.font = `${kind === 'quote' ? 600 : 500} ${s * u}px ${FONT}`;
    const lines: { text: string; bullet: boolean; group: number }[] = [];
    paras.forEach((p, pi) => {
      const first = p.split(' ')[0];
      const hasMarker = isMarkerToken(first);
      const w = wrap(ctx, p, textRect.w - indent - (kind === 'quote' ? 120 * u : 0));
      w.forEach((ln, i) => lines.push({ text: ln, bullet: multi && i === 0 && !hasMarker, group: pi + 1 }));
    });
    const h = lines.length * s * u * 1.38 + (multi ? paras.length * gapOf(s) * u : 0);
    chosen = s;
    bodyLines = lines;
    bodyH = h;
    if (titleBlockH + h <= textRect.h) break;
  }
  const bodySize = chosen * u;

  // căn dọc: slide tiêu đề / trích dẫn / có ảnh → giữa; còn lại → sát trên như PowerPoint
  const contentH = titleBlockH + bodyH + (kind === 'quote' ? 90 * u : 0);
  let y = textRect.y;
  if (kind === 'title' || kind === 'quote' || kind === 'photo-full') y = textRect.y + Math.max(0, (textRect.h - contentH) / 2);
  else if (photo) y = textRect.y + Math.max(0, Math.min(40 * u, (textRect.h - contentH) / 2));

  let quoteMark: SlideLayout['quoteMark'];
  if (kind === 'quote') {
    quoteMark = { x: cx, y: y, size: 190 * u };
    y += 90 * u;
  }

  let accentBar: SlideLayout['accentBar'];
  if (title) {
    titleLines.forEach((ln) => {
      items.push({ text: ln, x: tx, y, size: titleSize, weight: 800, role: kind === 'quote' ? 'sub' : 'title', group: 0, bullet: false, charStart, center });
      charStart += ln.length + 1;
      y += titleLH;
    });
    if (kind !== 'quote') {
      accentBar = { x: center ? cx - 90 * u : textRect.x, y: y + 8 * u, w: 180 * u, h: 8 * u, center };
      y += 70 * u;
    } else {
      y += 24 * u;
    }
  }

  let lastGroup = -1;
  bodyLines.forEach((ln) => {
    if (multi && ln.group !== lastGroup && lastGroup !== -1) y += gapOf(chosen) * u;
    lastGroup = ln.group;
    items.push({
      text: ln.text,
      x: tx + (center ? 0 : indent),
      y,
      size: bodySize,
      weight: kind === 'quote' ? 600 : 500,
      role: 'body',
      group: title ? ln.group : ln.group - 1,
      bullet: ln.bullet,
      charStart,
      center,
      italic: kind === 'quote',
    });
    charStart += ln.text.length + 1;
    y += bodySize * 1.38;
  });

  return {
    kind,
    items,
    totalChars: Math.max(1, charStart),
    groups: paras.length + (title ? 1 : 0),
    photo,
    bullets: multi,
    u,
    quoteMark,
    accentBar,
  };
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawCover(ctx: CanvasRenderingContext2D, photo: SlidePhotoRef, x: number, y: number, w: number, h: number) {
  const sc = Math.max(w / photo.w, h / photo.h);
  const dw = photo.w * sc;
  const dh = photo.h * sc;
  ctx.drawImage(photo.img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

export interface DrawSlideOptions {
  /** false = chữ "đánh máy" được thay bằng hiện dần từng ý (tự động) */
  typewriter: boolean;
  /** vẽ thêm số trang góc phải (mặc định có) */
  pageNumber?: boolean;
}

/**
 * Vẽ 1 khung hình của slide.
 * @param t   giây đã trôi qua kể từ đầu cảnh (dùng số rất lớn để vẽ bản "đã gõ xong")
 * @param dur tổng số giây của cảnh (để tính tốc độ đánh máy cho vừa đủ số giây)
 */
export function drawSlide(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  spec: TextSlideSpec,
  layout: SlideLayout,
  photo: SlidePhotoRef | null,
  t: number,
  dur: number,
  opt: DrawSlideOptions
) {
  const th = themeOf(spec);
  const u = layout.u;
  ctx.save();
  const base = ctx.globalAlpha; // giữ độ mờ của hiệu ứng chuyển cảnh bên ngoài
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  // nền
  if (layout.kind === 'photo-full' && photo) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    drawCover(ctx, photo, 0, 0, W, H);
    const ov = ctx.createLinearGradient(0, 0, 0, H);
    ov.addColorStop(0, 'rgba(0,0,0,0.45)');
    ov.addColorStop(1, 'rgba(0,0,0,0.78)');
    ctx.fillStyle = ov;
    ctx.fillRect(0, 0, W, H);
  } else {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, th.bg[0]);
    g.addColorStop(1, th.bg[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const gl = ctx.createRadialGradient(W * 0.85, H * 0.12, 0, W * 0.85, H * 0.12, Math.max(W, H) * 0.5);
    gl.addColorStop(0, `${th.accent}${th.light ? '22' : '33'}`);
    gl.addColorStop(1, `${th.accent}00`);
    ctx.fillStyle = gl;
    ctx.fillRect(0, 0, W, H);
  }
  const photoFull = layout.kind === 'photo-full';
  const textMain = photoFull ? '#ffffff' : th.text;
  const textSub = photoFull ? '#f1f5f9' : th.sub;

  // khung ảnh
  if (layout.photo && photo && !photoFull) {
    const p = layout.photo;
    const a = easeOut(t / 0.8);
    ctx.save();
    ctx.globalAlpha = base * a;
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 36 * u;
    ctx.shadowOffsetY = 12 * u;
    ctx.fillStyle = '#000';
    roundRectPath(ctx, p.x, p.y, p.w, p.h, 26 * u);
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = base * a;
    roundRectPath(ctx, p.x, p.y, p.w, p.h, 26 * u);
    ctx.clip();
    drawCover(ctx, photo, p.x, p.y, p.w, p.h);
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = base * a;
    ctx.strokeStyle = `${th.accent}aa`;
    ctx.lineWidth = 4 * u;
    roundRectPath(ctx, p.x, p.y, p.w, p.h, 26 * u);
    ctx.stroke();
    ctx.restore();
  }
  if (spec.credit && photo && (layout.photo || photoFull)) {
    ctx.save();
    ctx.font = `500 ${21 * u}px ${FONT}`;
    ctx.fillStyle = photoFull || !th.light ? 'rgba(229,231,245,0.72)' : 'rgba(51,65,85,0.75)';
    ctx.textAlign = 'right';
    let cr = spec.credit;
    const maxW = photoFull ? W * 0.6 : layout.photo!.w;
    while (cr.length > 8 && ctx.measureText(cr).width > maxW) cr = cr.slice(0, -2);
    const cxr = photoFull ? W - 60 * u : layout.photo!.x + layout.photo!.w;
    const cyr = photoFull ? H * 0.04 + 60 * u : layout.photo!.y + layout.photo!.h + 12 * u;
    ctx.fillText(cr === spec.credit ? cr : cr + '…', cxr, cyr);
    ctx.restore();
  }

  // số trang
  if (opt.pageNumber !== false && spec.total > 1) {
    ctx.save();
    ctx.font = `700 ${30 * u}px ${FONT}`;
    ctx.fillStyle = th.accent;
    ctx.textAlign = 'right';
    ctx.fillText(`${spec.index + 1} / ${spec.total}`, W - 90 * u, 56 * u);
    ctx.restore();
  }

  // hiệu ứng chữ
  let anim: SlideAnim = spec.anim || 'typewriter';
  if (anim === 'typewriter' && !opt.typewriter) anim = 'bullets';
  const total = layout.totalChars;
  const typeStart = Math.min(0.45, dur * 0.08);
  // gõ vừa đủ số giây: xong ở ~72% thời lượng cảnh (để còn thời gian đọc), nhưng không chậm hơn 6 ký tự/giây
  const typeDur = Math.max(0.8, Math.min(dur * 0.72, total / 6));
  const p = clamp01((t - typeStart) / typeDur);
  const vis = Math.floor(p * total);
  const groups = layout.groups;
  const step = Math.min(1.0, Math.max(0.35, (dur * 0.6) / Math.max(1, groups)));

  // thanh nhấn dưới tiêu đề
  if (layout.accentBar) {
    const b = layout.accentBar;
    let a = 1;
    if (anim === 'typewriter') a = clamp01(vis / Math.max(1, layout.items.find((i) => i.role === 'title')?.text.length || 1));
    else if (anim === 'bullets') a = easeOut((t - 0.1) / 0.5);
    else if (anim === 'fade') a = easeOut(t / 0.7);
    ctx.fillStyle = th.accent;
    ctx.fillRect(b.x, b.y, b.w * a, b.h);
  }
  if (layout.quoteMark) {
    const q = layout.quoteMark;
    ctx.save();
    ctx.font = `800 ${q.size}px ${FONT}`;
    ctx.fillStyle = `${th.accent}`;
    ctx.globalAlpha = base * (anim === 'none' ? 0.9 : 0.9 * easeOut(t / 0.6));
    ctx.textAlign = 'center';
    ctx.fillText('“', q.x, q.y - q.size * 0.2);
    ctx.restore();
  }

  let cursorDone = false;
  layout.items.forEach((it) => {
    let n = it.text.length;
    let alpha = 1;
    let dy = 0;
    if (anim === 'typewriter') {
      n = Math.max(0, Math.min(it.text.length, vis - it.charStart));
      if (n <= 0 && !(vis === 0 && it.charStart === 0)) return;
    } else if (anim === 'bullets') {
      const start = 0.3 + it.group * step;
      const a = easeOut((t - start) / 0.55);
      if (a <= 0) return;
      alpha = a;
      dy = (1 - a) * 26 * u;
    } else if (anim === 'fade') {
      alpha = easeOut(t / 0.7);
      if (alpha <= 0) return;
    }

    ctx.save();
    ctx.globalAlpha = base * alpha;
    ctx.font = `${it.italic ? 'italic ' : ''}${it.weight} ${it.size}px ${FONT}`;
    ctx.fillStyle = it.role === 'title' ? textMain : it.role === 'sub' ? th.accent : textSub;
    ctx.textAlign = 'left';
    const full = ctx.measureText(it.text).width;
    const x0 = it.center ? it.x - full / 2 : it.x;
    const y0 = it.y + dy;

    if (it.bullet) {
      ctx.fillStyle = th.accent;
      ctx.beginPath();
      ctx.arc(it.x - 30 * u, y0 + it.size * 0.58, 8.5 * u, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = it.role === 'title' ? textMain : textSub;
    }
    const shown = it.text.slice(0, n);
    if (photoFull) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 10 * u;
    }
    ctx.fillText(shown, x0, y0);

    // con trỏ nhấp nháy ở chỗ đang gõ
    if (anim === 'typewriter' && !cursorDone && n < it.text.length + 1 && vis >= it.charStart && vis <= it.charStart + it.text.length) {
      const typing = p < 1;
      if (typing || t - (typeStart + typeDur) < 1.6) {
        const blink = typing || Math.floor(t * 2.2) % 2 === 0;
        if (blink) {
          const wv = ctx.measureText(shown).width;
          ctx.shadowBlur = 0;
          ctx.fillStyle = th.accent;
          ctx.fillRect(x0 + wv + 4 * u, y0 + it.size * 0.1, Math.max(3, 4 * u), it.size * 0.95);
        }
      }
      cursorDone = true;
    }
    ctx.restore();
  });

  ctx.restore();
}

/** Vẽ bản "đã gõ xong" thành ảnh (xem trước + ảnh dự phòng) */
export async function renderSlideBlob(
  spec: TextSlideSpec,
  photo: SlidePhotoRef | null,
  W = 1920,
  H = 1080,
  type = 'image/png',
  quality?: number
): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  const layout = computeLayout(ctx, spec, W, H, 0, !!photo);
  drawSlide(ctx, W, H, spec, layout, photo, 1e9, 1e9, { typewriter: true });
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Không tạo được ảnh slide'))), type, quality);
  });
}
