/**
 * imageMotion/renderer.ts
 * Vẽ khung hình tại thời điểm t cho một ảnh tĩnh -> chuyển động "an toàn cho chữ":
 *  - Chữ/thẻ/hình là các mảnh điểm ảnh gốc: chỉ trượt, mờ dần, quét hiện, lóe sáng, viền sáng.
 *  - Không bao giờ vẽ lại hay làm méo chữ. Khung cuối cùng = đúng ảnh gốc.
 *  - Ảnh chụp (photo) tự động chuyển sang Ken Burns (zoom/pan nhẹ).
 * Vẽ hoàn toàn bằng Canvas 2D (GPU) nên rất nhẹ: mỗi khung chỉ vài lệnh drawImage.
 */
import { analyzeImage, type AnalysisResult } from './analyze';
import { buildPlan, kenBurns, stateAt, type BlockState, type MotionPlan, type MotionStyle } from './plan';

// Kiểu canvas được nới lỏng để cùng một mã chạy được ở trình duyệt (DOM/Offscreen) và ở Node (@napi-rs/canvas).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCanvas = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Ctx2D = any;
export type CanvasFactory = (w: number, h: number) => AnyCanvas;
export interface Rect { x: number; y: number; w: number; h: number }

export const defaultCanvasFactory: CanvasFactory = (w, h) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (typeof g.document !== 'undefined') {
    const c = g.document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  return new g.OffscreenCanvas(w, h);
};

const ctxOf = (c: AnyCanvas, readback = false): Ctx2D =>
  c.getContext('2d', readback ? { willReadFrequently: true } : undefined);

const nextTick = () => new Promise<void>((r) => setTimeout(r, 0));

export interface PreparedImage {
  width: number;
  height: number;
  /** ảnh gốc (đã co về kích thước làm việc) */
  orig: AnyCanvas;
  /** ảnh gốc với vùng các khối đã được vá nền */
  base: AnyCanvas;
  analysis: AnalysisResult;
  blockCanvases: AnyCanvas[];
}

export interface PrepareOptions {
  factory?: CanvasFactory;
  /** cạnh dài nhất khi phân tích/dựng (mặc định 2400) */
  maxSize?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ImageSource = any;

/** Phân tích ảnh một lần, dùng lại cho xem trước và dựng phim. */
export async function prepareImage(source: ImageSource, opts: PrepareOptions = {}): Promise<PreparedImage> {
  const factory = opts.factory ?? defaultCanvasFactory;
  const maxSize = opts.maxSize ?? 2400;
  const sw = (source.naturalWidth || source.width || 0) as number;
  const sh = (source.naturalHeight || source.height || 0) as number;
  if (!sw || !sh) throw new Error('Không đọc được kích thước ảnh');
  const k = Math.min(1, maxSize / Math.max(sw, sh));
  const W = Math.max(2, Math.round(sw * k));
  const H = Math.max(2, Math.round(sh * k));

  const orig = factory(W, H);
  const octx = ctxOf(orig, true);
  octx.drawImage(source, 0, 0, W, H);
  const id = octx.getImageData(0, 0, W, H);

  await nextTick(); // nhường luồng UI trước phần tính toán nặng
  const analysis = analyzeImage({ data: id.data, width: W, height: H });

  let base: AnyCanvas = orig;
  const blockCanvases: AnyCanvas[] = [];
  if (analysis.mode === 'slide') {
    base = factory(W, H);
    const bctx = ctxOf(base);
    const bd = bctx.createImageData(W, H);
    bd.data.set(analysis.base);
    bctx.putImageData(bd, 0, 0);
    for (const b of analysis.blocks) {
      const c = factory(b.w, b.h);
      const cctx = ctxOf(c);
      const d = cctx.createImageData(b.w, b.h);
      d.data.set(b.layer);
      cctx.putImageData(d, 0, 0);
      blockCanvases.push(c);
    }
  }
  return { width: W, height: H, orig, base, analysis, blockCanvases };
}

export interface SceneOptions {
  duration: number;
  style?: MotionStyle;
  /** đổi hướng Ken Burns giữa các cảnh */
  variant?: number;
  factory?: CanvasFactory;
}

export class ImageMotionScene {
  readonly plan: MotionPlan;
  private scratch: AnyCanvas | null = null;
  private scratchW = 0;
  private scratchH = 0;
  private readonly factory: CanvasFactory;
  private readonly variant: number;

  constructor(readonly prepared: PreparedImage, opts: SceneOptions) {
    this.factory = opts.factory ?? defaultCanvasFactory;
    this.variant = opts.variant ?? 0;
    this.plan = buildPlan(prepared.analysis, opts.duration, opts.style ?? 'auto');
  }

  get mode() { return this.plan.mode; }

  /** Từ thời điểm t khung hình không còn thay đổi (giữ khung cuối / ảnh đứng yên) -> có thể dùng lại khung trước. */
  isStaticAt(t: number): boolean {
    if (this.plan.mode === 'none') return true;
    return this.plan.mode === 'slide' && t >= this.plan.holdStart;
  }
  get blockCount() { return this.prepared.analysis.blocks.length; }

  /** Vẽ khung hình tại thời điểm t (giây) vào hình chữ nhật dest của ctx. */
  draw(ctx: Ctx2D, t: number, dest: Rect): void {
    const p = this.prepared;
    ctx.save();
    ctx.beginPath();
    ctx.rect(dest.x, dest.y, dest.w, dest.h);
    ctx.clip();
    if (this.plan.mode === 'slide') {
      if (t >= this.plan.holdStart) ctx.drawImage(p.orig, dest.x, dest.y, dest.w, dest.h);
      else this.drawSlide(ctx, t, dest);
    } else if (this.plan.mode === 'photo') {
      const kb = kenBurns(t, this.plan.duration, this.variant);
      const dw = dest.w * kb.zoom, dh = dest.h * kb.zoom;
      ctx.drawImage(p.orig, dest.x - (dw - dest.w) / 2 + kb.px * dest.w, dest.y - (dh - dest.h) / 2 + kb.py * dest.h, dw, dh);
    } else {
      ctx.drawImage(p.orig, dest.x, dest.y, dest.w, dest.h);
    }
    ctx.restore();
  }

  private drawSlide(ctx: Ctx2D, t: number, dest: Rect) {
    const p = this.prepared;
    const sx = dest.w / p.width, sy = dest.h / p.height;
    ctx.drawImage(p.base, dest.x, dest.y, dest.w, dest.h);
    const blocks = p.analysis.blocks;
    for (let i = 0; i < blocks.length; i++) {
      const st = stateAt(this.plan.blocks[i], t, p.width, p.height);
      if (!st.visible || st.alpha <= 0.002) continue;
      this.drawBlock(ctx, i, st, dest, sx, sy);
    }
  }

  private getScratch(w: number, h: number): { c: AnyCanvas; ctx: Ctx2D } {
    if (!this.scratch || this.scratchW < w || this.scratchH < h) {
      this.scratchW = Math.max(w, this.scratchW);
      this.scratchH = Math.max(h, this.scratchH);
      this.scratch = this.factory(this.scratchW, this.scratchH);
    }
    return { c: this.scratch, ctx: ctxOf(this.scratch) };
  }

  private drawBlock(ctx: Ctx2D, i: number, st: BlockState, dest: Rect, sx: number, sy: number) {
    const b = this.prepared.analysis.blocks[i];
    const cv = this.prepared.blockCanvases[i];
    let src: AnyCanvas = cv;

    const wiping = st.wipe !== null && st.wipe < 1;
    if (wiping || st.shine) {
      const { c, ctx: sc } = this.getScratch(b.w, b.h);
      sc.globalCompositeOperation = 'source-over';
      sc.clearRect(0, 0, this.scratchW, this.scratchH);
      sc.drawImage(cv, 0, 0);
      if (wiping) {
        const soft = Math.max(24, b.h * 0.35);
        const edge = (st.wipe as number) * (b.w + soft);
        const g = sc.createLinearGradient(edge - soft, 0, edge, 0);
        g.addColorStop(0, 'rgba(0,0,0,1)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        sc.globalCompositeOperation = 'destination-in';
        sc.fillStyle = g;
        sc.fillRect(0, 0, b.w, b.h);
      }
      if (st.shine) {
        const pos = -250 + st.shine.u * (b.w + 0.4 * b.h + 500);
        const env = Math.sqrt(Math.sin(Math.PI * st.shine.u));
        const [r, gC, bC] = st.shine.color;
        const g = sc.createLinearGradient(pos - 110, 0, pos + 110, 88);
        g.addColorStop(0, `rgba(${r},${gC},${bC},0)`);
        g.addColorStop(0.5, `rgba(${r},${gC},${bC},${(0.85 * env).toFixed(3)})`);
        g.addColorStop(1, `rgba(${r},${gC},${bC},0)`);
        sc.globalCompositeOperation = 'source-atop';
        sc.fillStyle = g;
        sc.fillRect(0, 0, b.w, b.h);
      }
      sc.globalCompositeOperation = 'source-over';
      src = c;
    }

    ctx.save();
    ctx.globalAlpha = st.alpha;
    ctx.translate(dest.x + (b.x + b.w / 2 + st.dx) * sx, dest.y + (b.y + b.h / 2 + st.dy) * sy);
    ctx.scale(sx * st.scale, sy * st.scale);
    const draw = () => ctx.drawImage(src, 0, 0, b.w, b.h, -b.w / 2, -b.h / 2, b.w, b.h);
    if (st.glow) {
      const [r, g, bl] = st.glow.color;
      const k = st.glow.k;
      const unit = Math.min(sx, sy);
      ctx.shadowColor = `rgba(${r},${g},${bl},${Math.min(1, 0.95 * k).toFixed(3)})`;
      ctx.shadowBlur = Math.max(1, 38 * unit * k);
      draw();
      ctx.shadowColor = `rgba(${r},${g},${bl},${Math.min(1, 1.0 * k).toFixed(3)})`;
      ctx.shadowBlur = Math.max(1, 12 * unit * k);
    }
    draw();
    ctx.restore();
  }
}

// ───────────────────────── tiện ích bố cục ─────────────────────────

/** Hình chữ nhật đích của ảnh trong khung (contain / cover). */
export function fitRect(srcW: number, srcH: number, dstW: number, dstH: number, mode: 'contain' | 'cover'): Rect {
  const s = mode === 'cover' ? Math.max(dstW / srcW, dstH / srcH) : Math.min(dstW / srcW, dstH / srcH);
  const w = srcW * s, h = srcH * s;
  return { x: (dstW - w) / 2, y: (dstH - h) / 2, w, h };
}
