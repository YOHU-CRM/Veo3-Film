/**
 * Nhận một nắm file bất kỳ -> trả về đã phân loại sẵn:
 * video, ảnh, âm thanh, văn bản kịch bản (từ PDF/TXT/SRT). ZIP được mở ra và phân loại tiếp.
 * Không đụng tới state giao diện: chỉ trả dữ liệu để component quyết định.
 */
import { classifyFile } from './classify';
import { expandZip } from './zip';

export interface IngestResult {
  videos: File[];
  images: File[];
  audios: File[];
  /** Mỗi phần tử = nội dung chữ của 1 file kịch bản (PDF/TXT/SRT) */
  scripts: Array<{ name: string; text: string }>;
  warnings: string[];
  /** Số file ZIP đã mở */
  zipsOpened: number;
}

export interface IngestOptions {
  /** Hàm đọc chữ PDF (tách riêng để trình duyệt tự cấp worker của pdf.js) */
  readPdf?: (file: File) => Promise<{ text: string; scanned: boolean }>;
}

export async function ingestFiles(input: File[], opts: IngestOptions = {}): Promise<IngestResult> {
  const res: IngestResult = { videos: [], images: [], audios: [], scripts: [], warnings: [], zipsOpened: 0 };

  const queue: File[] = [];
  for (const f of input) {
    if (classifyFile(f.name, f.type) === 'zip') {
      const z = await expandZip(f, f.name);
      res.zipsOpened++;
      res.warnings.push(...z.warnings);
      queue.push(...z.files);
    } else {
      queue.push(f);
    }
  }

  for (const f of queue) {
    switch (classifyFile(f.name, f.type)) {
      case 'video': res.videos.push(f); break;
      case 'image': res.images.push(f); break;
      case 'audio': res.audios.push(f); break;
      case 'text': {
        const text = (await f.text()).trim();
        if (text) res.scripts.push({ name: f.name, text });
        break;
      }
      case 'pdf': {
        if (!opts.readPdf) { res.warnings.push(`Chưa đọc được PDF "${f.name}" trong môi trường này.`); break; }
        try {
          const r = await opts.readPdf(f);
          if (r.scanned || !r.text) {
            res.warnings.push(`PDF "${f.name}" là dạng ảnh scan (không có chữ để đọc). Hãy dán kịch bản vào hoặc dùng PDF có chữ.`);
          } else {
            res.scripts.push({ name: f.name, text: r.text });
          }
        } catch (e: any) {
          res.warnings.push(`Không đọc được PDF "${f.name}": ${e?.message || 'file hỏng'}.`);
        }
        break;
      }
      case 'ignore': break;
      default: res.warnings.push(`Không nhận ra loại file: ${f.name}`);
    }
  }
  return res;
}

export { classifyFile, classifyAudio, classifyAudioBatch } from './classify';
export { splitScriptToScenes } from './script';
