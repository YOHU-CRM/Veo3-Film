/**
 * Mở file ZIP ngay trong trình duyệt, từng file một (không nạp cả ZIP vào RAM).
 * Có giới hạn chống "bom ZIP": tối đa số file và tổng dung lượng giải nén.
 */
import { BlobReader, BlobWriter, ZipReader } from '@zip.js/zip.js';
import { baseName, classifyFile } from './classify';
import { parseSceneNumber } from '../../shared/render/plan';

export const MAX_ZIP_ENTRIES = 1500;
export const MAX_ZIP_UNCOMPRESSED_BYTES = 6 * 1024 ** 3;

const MIME: Record<string, string> = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', m4v: 'video/x-m4v',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', bmp: 'image/bmp',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', opus: 'audio/opus',
  pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain', md: 'text/plain', srt: 'text/plain',
};

export interface ZipResult {
  files: File[];
  warnings: string[];
}

/**
 * Tên file lấy từ ZIP: nếu tên file không có số cảnh nhưng thư mục chứa nó có
 * (vd "canh_03/video.mp4") thì ghép tên thư mục vào để vẫn xếp đúng thứ tự cảnh.
 */
export function zipEntryFileName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const base = parts[parts.length - 1] || path;
  if (parseSceneNumber(base) === null && parts.length >= 2) {
    const folder = parts[parts.length - 2];
    if (parseSceneNumber(folder) !== null) return `${folder}_${base}`;
  }
  return base;
}

export async function expandZip(zip: Blob, zipName = 'file.zip'): Promise<ZipResult> {
  const warnings: string[] = [];
  const files: File[] = [];

  const reader = new ZipReader(new BlobReader(zip), { useWebWorkers: false });
  try {
    const entries = (await reader.getEntries()).filter(e => !e.directory);
    if (entries.length > MAX_ZIP_ENTRIES) {
      return { files, warnings: [`"${zipName}" có quá nhiều file (${entries.length}), tối đa ${MAX_ZIP_ENTRIES}.`] };
    }
    const total = entries.reduce((a, e) => a + (e.uncompressedSize || 0), 0);
    if (total > MAX_ZIP_UNCOMPRESSED_BYTES) {
      return { files, warnings: [`"${zipName}" giải nén ra quá lớn (${(total / 1024 ** 3).toFixed(1)} GB). Hãy giải nén thủ công rồi kéo thả từng file.`] };
    }

    for (const entry of entries) {
      const kind = classifyFile(entry.filename);
      if (kind === 'ignore' || kind === 'unknown') continue;
      if (kind === 'zip') {
        warnings.push(`Bỏ qua file ZIP lồng bên trong: ${baseName(entry.filename)}`);
        continue;
      }
      if (entry.encrypted) {
        warnings.push(`"${zipName}" có mật khẩu, chưa hỗ trợ ZIP đặt mật khẩu.`);
        break;
      }
      const ext = (entry.filename.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
      const blob = await (entry as any).getData(new BlobWriter(MIME[ext] || ''));
      files.push(new File([blob], zipEntryFileName(entry.filename), { type: MIME[ext] || '' }));
    }
  } catch (e: any) {
    warnings.push(`Không đọc được "${zipName}": ${e?.message || 'file ZIP bị hỏng'}.`);
  } finally {
    await reader.close().catch(() => {});
  }
  return { files, warnings };
}
