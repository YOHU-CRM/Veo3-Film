/** Đọc PDF trong trình duyệt: cấp sẵn worker của pdf.js (do Vite đóng gói) */
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { extractPdfText } from './pdf';

export const readPdfInBrowser = (file: File) => extractPdfText(file, { workerSrc });
