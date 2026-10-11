/**
 * Tải + phân tích ảnh trong trình duyệt, có bộ nhớ đệm (xem trước và dựng phim dùng chung kết quả).
 */
import { ImageMotionScene, prepareImage, type MotionStyle, type PreparedImage } from '../../shared/imageMotion';

async function loadImageElement(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  if (typeof img.decode === 'function') {
    try { await img.decode(); return img; } catch { /* rơi xuống onload */ }
  }
  await new Promise<void>((resolve, reject) => {
    if (img.complete && img.naturalWidth) { resolve(); return; }
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Không tải được ảnh'));
  });
  return img;
}

const cache = new Map<string, Promise<PreparedImage>>();

/** Giữ tối đa 10 ảnh gần nhất. */
export function prepareImageFromUrl(url: string): Promise<PreparedImage> {
  const hit = cache.get(url);
  if (hit) { cache.delete(url); cache.set(url, hit); return hit; }
  const p = (async () => prepareImage(await loadImageElement(url)))();
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  while (cache.size > 10) cache.delete(cache.keys().next().value as string);
  return p;
}

export function releasePreparedImage(url: string) { cache.delete(url); }

/** Thông tin phân tích hiển thị cho người dùng (số khối, chế độ). */
export async function describeImageMotion(url: string, style: MotionStyle = 'auto') {
  const prepared = await prepareImageFromUrl(url);
  const scene = new ImageMotionScene(prepared, { duration: 7, style });
  return { width: prepared.width, height: prepared.height, mode: scene.mode, blocks: scene.blockCount };
}
