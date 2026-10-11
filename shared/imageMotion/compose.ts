/**
 * imageMotion/compose.ts
 * Ghép một cảnh ảnh vào khung phim: nền (đen / mờ), khớp khung (blur | cover | contain), chuyển động.
 * Dùng chung cho trình duyệt (browserEngine) và máy dựng FFmpeg (render-server).
 */
import { fitRect, type AnyCanvas, type CanvasFactory, type Ctx2D, type ImageMotionScene } from './renderer';

export type FitMode = 'blur' | 'cover' | 'contain';

/** Nền mờ rẻ: thu nhỏ ~96px rồi phóng to (nhẹ hơn nhiều so với filter blur lớn mỗi khung). */
export function createBackdrop(factory: CanvasFactory, targetW: number, targetH: number) {
  const tw = 96;
  const th = Math.max(16, Math.round((96 * targetH) / targetW));
  const tiny: AnyCanvas = factory(tw, th);
  const tctx: Ctx2D = tiny.getContext('2d');
  return {
    update(src: AnyCanvas) {
      try { tctx.drawImage(src, 0, 0, tw, th); } catch { /* nguồn chưa sẵn sàng */ }
    },
    paint(ctx: Ctx2D) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(tiny, 0, 0, targetW, targetH);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, targetW, targetH);
    },
  };
}

export type Backdrop = ReturnType<typeof createBackdrop>;

/** Vẽ khung hình của cảnh ảnh tại thời điểm t (giây) lên ctx kích thước W×H. */
export function drawImageSceneFrame(
  ctx: Ctx2D, motion: ImageMotionScene, tSec: number, W: number, H: number, fit: FitMode, backdrop?: Backdrop,
): void {
  const p = motion.prepared;
  const dest = fitRect(p.width, p.height, W, H, fit === 'cover' ? 'cover' : 'contain');
  // Ảnh đã phủ kín khung (cùng tỉ lệ hoặc 'cover') -> không cần vẽ nền đen/mờ phía sau (tiết kiệm 2 lần vẽ toàn khung mỗi khung hình)
  const covers = dest.x <= 0.5 && dest.y <= 0.5 && dest.w >= W - 1 && dest.h >= H - 1;
  if (!covers) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);
    if (fit === 'blur' && backdrop) backdrop.paint(ctx);
  }
  motion.draw(ctx, tSec, dest);
}
