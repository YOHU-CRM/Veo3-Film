/**
 * Tìm ảnh miễn phí từ Wikimedia Commons (kho ảnh mở, không cần khoá API, cho phép dùng trong trình duyệt).
 * Ảnh có giấy phép mở (CC / công cộng) → cần ghi nguồn; tool tự in dòng ghi nguồn dưới ảnh.
 */
export interface StockPhoto {
  id: string;
  url: string; // ảnh cỡ ~1280px
  thumb: string;
  width: number;
  height: number;
  credit: string;
}

const stripHtml = (s: string) => s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/\s+/g, ' ').trim();

export async function searchStockPhotos(query: string, limit = 8): Promise<StockPhoto[]> {
  const q = (query || '').trim();
  if (!q) return [];
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    generator: 'search',
    gsrnamespace: '6',
    gsrsearch: `${q} filetype:bitmap`,
    gsrlimit: String(Math.min(30, limit * 3)),
    prop: 'imageinfo',
    iiprop: 'url|extmetadata|size|mime',
    iiurlwidth: '1280',
  });
  const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params.toString()}`);
  if (!res.ok) throw new Error('Không kết nối được kho ảnh');
  const json = await res.json();
  const pages: any[] = Object.values(json?.query?.pages || {});
  pages.sort((a, b) => (a.index || 0) - (b.index || 0));
  const out: StockPhoto[] = [];
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii || !ii.thumburl) continue;
    if (!/^image\/(jpeg|png|webp)$/.test(ii.mime || '')) continue;
    if ((ii.width || 0) < 900 || (ii.height || 0) < 500) continue;
    const md = ii.extmetadata || {};
    const artist = stripHtml(md.Artist?.value || '') || 'Wikimedia Commons';
    const lic = stripHtml(md.LicenseShortName?.value || '');
    out.push({
      id: String(p.pageid),
      url: ii.thumburl,
      thumb: ii.thumburl,
      width: ii.thumbwidth || ii.width,
      height: ii.thumbheight || ii.height,
      credit: `Ảnh: ${artist.slice(0, 50)}${lic ? ' · ' + lic : ''} · Wikimedia Commons`,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Tải ảnh về để vẽ lên canvas (không làm "nhiễm" canvas nhờ CORS) */
export function loadPhotoFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Không tải được ảnh'));
    img.src = url;
  });
}

export function loadPhotoFromFile(file: Blob): Promise<{ img: HTMLImageElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Không đọc được ảnh')); };
    img.src = url;
  });
}
