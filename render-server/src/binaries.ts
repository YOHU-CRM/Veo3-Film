import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

function firstExisting(...candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

function tryRequire(name: string): any {
  try { return require(name); } catch { return null; }
}

/** Thứ tự ưu tiên: biến môi trường -> bản đóng gói sẵn trong node_modules -> lệnh hệ thống */
export const FFMPEG: string =
  firstExisting(process.env.FFMPEG_PATH, tryRequire('ffmpeg-static') as string | null) ?? 'ffmpeg';

export const FFPROBE: string =
  firstExisting(process.env.FFPROBE_PATH, tryRequire('ffprobe-static')?.path) ?? 'ffprobe';
