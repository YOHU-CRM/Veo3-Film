/** Đọc PDF trong trình duyệt: cấp sẵn worker của pdf.js (do Vite đóng gói) */
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { extractPdfText } from './pdf';

export const readPdfInBrowser = (file: File) => extractPdfText(file, { workerSrc });

export interface PdfPages {
  /** Mỗi trang là 1 file PNG, tên có số trang để xếp đúng thứ tự */
  files: File[];
  /** Chữ của từng trang (có thể rỗng nếu trang là ảnh) */
  pageTexts: string[];
  truncated: boolean;
}

/** Vẽ từng trang PDF thành ảnh PNG (chiều ngang ~1600px) để làm cảnh phim */
export async function renderPdfPages(file: File, opts: { maxPages?: number; targetWidth?: number } = {}): Promise<PdfPages> {
  const maxPages = opts.maxPages ?? 60;
  const targetWidth = opts.targetWidth ?? 1600;
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
  const base = file.name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'pdf';
  const total = Math.min(doc.numPages, maxPages);
  const files: File[] = [];
  const pageTexts: string[] = [];

  for (let p = 1; p <= total; p++) {
    const page = await doc.getPage(p);
    const v1 = page.getViewport({ scale: 1 });
    const scale = Math.min(3, targetWidth / v1.width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Trình duyệt không hỗ trợ vẽ trang PDF.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    const blob: Blob = await new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('Không tạo được ảnh trang ' + p))), 'image/png'));
    // Tên: <tên-pdf>-trang-001.png (có từ "trang" để số trang được hiểu là thứ tự cảnh)
    files.push(new File([blob], `${base}-trang-${String(p).padStart(3, '0')}.png`, { type: 'image/png' }));

    const content = await page.getTextContent();
    pageTexts.push((content.items as any[]).map(i => (typeof i.str === 'string' ? i.str : '')).join(' ').replace(/\s+/g, ' ').trim());
    page.cleanup();
  }
  await doc.destroy();
  return { files, pageTexts, truncated: doc.numPages > maxPages };
}
