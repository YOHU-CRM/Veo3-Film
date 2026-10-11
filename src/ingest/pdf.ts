/**
 * Đọc chữ trong PDF (miễn phí, chạy trong trình duyệt bằng pdf.js).
 * Chỉ đọc được PDF có lớp chữ; PDF là ảnh scan cần OCR (chưa hỗ trợ) -> trả scanned = true.
 */

export interface PdfTextResult {
  text: string;
  pages: number;
  /** Chữ của từng trang (đúng thứ tự trang) */
  pageTexts: string[];
  /** true: gần như không có chữ -> nhiều khả năng là PDF scan */
  scanned: boolean;
}

export async function extractPdfText(file: Blob, opts: { workerSrc?: string } = {}): Promise<PdfTextResult> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (opts.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = opts.workerSrc;

  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true });
  const doc = await task.promise;

  const pageTexts: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Gom các mảnh chữ thành dòng theo tọa độ dọc; dòng cách xa nhau => đoạn mới
    const rows: Array<{ y: number; parts: Array<{ x: number; s: string }> }> = [];
    for (const item of content.items as any[]) {
      if (typeof item.str !== 'string' || !item.str.trim()) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      const row = rows.find(r => Math.abs(r.y - y) < 3);
      if (row) row.parts.push({ x, s: item.str });
      else rows.push({ y, parts: [{ x, s: item.str }] });
    }
    rows.sort((a, b) => b.y - a.y);
    let prevY: number | null = null;
    const lines: string[] = [];
    for (const r of rows) {
      r.parts.sort((a, b) => a.x - b.x);
      const line = r.parts.map(x => x.s).join(' ').replace(/\s+/g, ' ').trim();
      if (prevY !== null && prevY - r.y > 24) lines.push(''); // khoảng trống lớn = đoạn mới
      lines.push(line);
      prevY = r.y;
    }
    pageTexts.push(lines.join('\n'));
    page.cleanup();
  }
  await task.destroy();

  const text = pageTexts.join('\n\n').trim();
  const perPage = text.replace(/\s/g, '').length / Math.max(1, doc.numPages);
  return { text, pages: doc.numPages, pageTexts, scanned: perPage < 20 };
}
