/**
 * imageMotion/plan.ts
 * Lập "kịch bản" chuyển động từ kết quả phân tích: khối nào vào trước, kiểu vào, khi nào lóe sáng.
 * Thuần toán học (không DOM) -> test được trong Node.
 */
import type { AnalysisResult, BlockKind, MotionBlock } from './analyze';

export type MotionStyle = 'auto' | 'text-safe' | 'kenburns' | 'none';
export type InKind = 'up' | 'left' | 'right' | 'pop' | 'wipe' | 'fade';
export type RGB = [number, number, number];

export interface BlockPlan {
  inKind: InKind;
  start: number;
  dur: number;
  /** lóe sáng lướt qua chữ và/hoặc viền sáng quanh khối (có thể có cả hai cùng lúc) */
  emphasis?: Array<{ kind: 'shine' | 'glow'; start: number; end: number; color: RGB }>;
}

export interface MotionPlan {
  /** true = chế độ "giữ nguyên chữ tuyệt đối": chỉ trượt / hiện dần / quét hiện / viền sáng NGOÀI khối; không đổi màu chữ, không phóng thu */
  strict: boolean;
  mode: 'slide' | 'photo' | 'none';
  duration: number;
  blocks: BlockPlan[];
  /** từ thời điểm này mọi khối đã về đúng vị trí gốc -> vẽ thẳng ảnh gốc */
  holdStart: number;
}

export const cl = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const ease = (x: number) => 1 - Math.pow(1 - cl(x), 3);
export const easeInOut = (x: number) => { x = cl(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
export const pop = (x: number) => { x = cl(x); const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };

function inKindFor(kind: BlockKind, b: MotionBlock, W: number): InKind {
  switch (kind) {
    case 'header': return 'left';
    case 'label': return 'fade';
    case 'footer': return 'up';
    case 'text': return 'wipe';
    case 'badge': return 'pop';
    case 'card': {
      const cx = b.x + b.w / 2;
      if (b.w > W * 0.75) return 'up';
      return cx < W / 2 ? 'left' : 'right';
    }
    default: return 'up';
  }
}

const DUR_BY: Record<InKind, number> = { up: 0.65, left: 0.8, right: 0.8, pop: 0.8, wipe: 1.1, fade: 0.5 };

export function buildPlan(a: AnalysisResult, durationSec: number, style: MotionStyle = 'auto'): MotionPlan {
  const T = Math.max(1.5, durationSec);
  let mode: MotionPlan['mode'] = a.mode;
  if (style === 'text-safe') mode = a.blocks.length > 0 ? 'slide' : 'photo';
  if (style === 'kenburns') mode = 'photo';
  if (style === 'none') mode = 'none';
  const strict = style === 'text-safe';
  if (mode !== 'slide') return { strict, mode, duration: T, blocks: [], holdStart: 0 };

  const blocks = a.blocks;
  const n = blocks.length;
  const kinds = blocks.map((b) => {
    const k = inKindFor(b.kind, b, a.width);
    return strict && k === 'pop' ? 'up' : k; // chế độ an toàn: không phóng to/thu nhỏ khối chứa chữ
  });

  // ── Giai đoạn 1: các khối lần lượt xuất hiện theo thứ tự đọc ──
  const tScale = clamp(T / 7, 0.55, 1.4);
  const dur = kinds.map((k) => DUR_BY[k] * tScale);
  const revealStart = 0.04 * T;
  const revealEnd = 0.52 * T;
  const body = blocks.map((b, i) => i).filter((i) => !['header', 'label', 'footer'].includes(blocks[i].kind));
  const starts = new Array<number>(n).fill(0);
  const span = Math.max(0.1, revealEnd - revealStart - 0.8 * tScale);
  const step = body.length > 1 ? Math.min(0.7 * tScale, span / (body.length - 1)) : 0;
  const firstBody = revealStart + 0.35 * tScale;
  body.forEach((i, k) => { starts[i] = firstBody + k * step; });
  blocks.forEach((b, i) => {
    if (b.kind === 'header') starts[i] = revealStart;
    else if (b.kind === 'label') starts[i] = revealStart + 0.15 * tScale;
    else if (b.kind === 'footer') starts[i] = Math.min(revealEnd, firstBody + body.length * step + 0.1);
  });
  const reveal: BlockPlan[] = blocks.map((_, i) => ({ inKind: kinds[i], start: starts[i], dur: dur[i] }));
  let lastIn = 0;
  reveal.forEach((r) => { lastIn = Math.max(lastIn, r.start + r.dur); });

  // ── Giai đoạn 2: lóe sáng tuần tự các khối chính (bỏ qua chữ nhỏ để không bị vệt mờ) ──
  const bigEnough = (i: number) => blocks[i].h >= a.height * 0.055 && (blocks[i].kind !== 'badge' || blocks[i].h >= a.height * 0.12);
  let pool = body.filter(bigEnough);
  if (pool.length === 0) pool = body.slice();
  const keyIdx = pool
    .slice()
    .sort((p, q) => blocks[q].area - blocks[p].area)
    .slice(0, 6)
    .sort((p, q) => p - q);
  const e0 = Math.max(lastIn + 0.25 * tScale, 0.56 * T);
  const e1 = 0.9 * T;
  let holdStart = lastIn + 0.1;
  const GOLD: RGB = [255, 214, 120];
  const WHITE: RGB = [255, 255, 255];
  if (T >= 3 && keyIdx.length > 0 && e1 - e0 > 0.6) {
    const k = keyIdx.length;
    const len = Math.min(1.3 * tScale, ((e1 - e0) / k) * 1.7);
    const gap = k > 1 ? (e1 - e0 - len) / (k - 1) : 0;
    keyIdx.forEach((i, j) => {
      const s0 = e0 + j * gap;
      const b = blocks[i];
      const em: NonNullable<BlockPlan['emphasis']> = [];
      const solid = b.fill > 0.7; // thanh / khối đặc: lóe sáng trắng
      if (b.kind === 'text') {
        // chữ: vầng sáng không dùng (tránh vệt), lóe sáng lướt qua. Chế độ an toàn: không đổi màu chữ -> chỉ vầng sáng
        if (strict) em.push({ kind: 'glow', start: s0, end: s0 + len, color: lighten(b.color) });
        else em.push({ kind: 'shine', start: s0, end: s0 + len, color: solid ? WHITE : lighten(mix(b.color, GOLD, 0.35)) });
      } else if (b.kind === 'card') {
        em.push({ kind: 'glow', start: s0, end: s0 + len, color: b.color });
        if (!strict) em.push({ kind: 'shine', start: s0, end: s0 + len, color: GOLD });
      } else {
        em.push({ kind: 'glow', start: s0, end: s0 + len, color: b.color });
      }
      reveal[i].emphasis = em;
      holdStart = Math.max(holdStart, s0 + len + 0.05);
    });
  }
  return { strict, mode: 'slide', duration: T, blocks: reveal, holdStart: Math.min(holdStart, T) };
}

function clamp(v: number, a: number, b: number) { return v < a ? a : v > b ? b : v; }
function mix(a: RGB, b: RGB, t: number): RGB { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(Math.round) as RGB; }
function lighten(c: RGB): RGB { return mix(c, [255, 245, 215], 0.45); }

// ───────────────────────── trạng thái khối tại thời điểm t ─────────────────────────

export interface BlockState {
  visible: boolean;
  alpha: number;
  dx: number;
  dy: number;
  scale: number;
  /** 0..1: tiến độ quét hiện (chỉ dùng cho 'wipe'), null nếu không quét */
  wipe: number | null;
  shine: { u: number; color: RGB } | null;
  glow: { k: number; color: RGB } | null;
  /** true khi khối đã về đúng vị trí gốc, không còn hiệu ứng */
  atRest: boolean;
}

export function stateAt(bp: BlockPlan, t: number, W: number, H: number): BlockState {
  const hidden: BlockState = { visible: false, alpha: 0, dx: 0, dy: 0, scale: 1, wipe: null, shine: null, glow: null, atRest: false };
  if (t < bp.start) return hidden;
  const p = cl((t - bp.start) / bp.dur);
  let alpha = 1, dx = 0, dy = 0, scale = 1;
  let wipe: number | null = null;
  switch (bp.inKind) {
    case 'up': alpha = cl(p * 1.8); dy = (1 - ease(p)) * H * 0.055; break;
    case 'left': alpha = cl(p * 1.8); dx = -(1 - ease(p)) * W * 0.075; break;
    case 'right': alpha = cl(p * 1.8); dx = (1 - ease(p)) * W * 0.075; break;
    case 'pop': alpha = cl(p * 2.4); scale = 0.5 + 0.5 * pop(p); break;
    case 'wipe': alpha = cl(p * 4); wipe = ease(p); dx = -(1 - ease(p)) * W * 0.04; break;
    case 'fade': alpha = ease(p); break;
  }
  let shine: BlockState['shine'] = null;
  let glow: BlockState['glow'] = null;
  for (const e of bp.emphasis ?? []) {
    if (t >= e.start && t <= e.end) {
      const u = (t - e.start) / (e.end - e.start);
      if (e.kind === 'shine') shine = { u, color: e.color };
      else glow = { k: Math.pow(Math.sin(Math.PI * u), 2), color: e.color };
    }
  }
  const atRest = p >= 1 && !shine && !glow;
  return { visible: true, alpha, dx, dy, scale, wipe, shine, glow, atRest };
}

/** Ken Burns: zoom chậm + trượt nhẹ. Trả về hệ số phóng và độ lệch (tính theo tỷ lệ cạnh ảnh). */
export function kenBurns(t: number, T: number, variant = 0) {
  const u = easeInOut(cl(t / T));
  const zoomIn = variant % 2 === 0;
  const z = zoomIn ? 1 + 0.08 * u : 1.08 - 0.08 * u;
  const dirs = [[-0.012, -0.008], [0.012, -0.008], [-0.012, 0.008], [0.012, 0.008]];
  const d = dirs[variant % dirs.length];
  return { zoom: z, px: d[0] * (u - 0.5) * 2, py: d[1] * (u - 0.5) * 2 };
}
