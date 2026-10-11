/**
 * Phân loại file người dùng thả vào: video / ảnh / âm thanh / PDF / ZIP / văn bản kịch bản.
 * HÀM THUẦN (không phụ thuộc trình duyệt) nên test được bằng Node.
 */

export type FileKind = 'video' | 'image' | 'audio' | 'pdf' | 'zip' | 'text' | 'office' | 'legacy' | 'ignore' | 'unknown';

const EXT: Record<string, FileKind> = {
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video', m4v: 'video',
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', bmp: 'image',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', flac: 'audio', opus: 'audio',
  pdf: 'pdf', zip: 'zip',
  pptx: 'office', docx: 'office', xlsx: 'office',
  ppt: 'legacy', doc: 'legacy', xls: 'legacy', odt: 'legacy', odp: 'legacy', ods: 'legacy', rtf: 'legacy',
  txt: 'text', md: 'text', srt: 'text',
};

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function classifyFile(name: string, mime = ''): FileKind {
  const base = baseName(name);
  if (!base || base.startsWith('.') || /^(thumbs\.db|desktop\.ini)$/i.test(base)) return 'ignore';
  if (/(^|[\\/])__MACOSX([\\/]|$)/.test(name)) return 'ignore';

  const ext = (base.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (EXT[ext]) return EXT[ext];

  // Không đuôi / đuôi lạ -> dựa vào MIME
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'application/zip' || mime === 'application/x-zip-compressed') return 'zip';
  if (mime === 'text/plain') return 'text';
  return 'unknown';
}

// ─────────────────── Voice hay nhạc nền? ───────────────────

export type AudioRole = 'voice' | 'music';

export interface AudioProbe {
  name: string;
  duration: number;
  /** Số cảnh đọc từ tên file (null nếu không có) */
  number: number | null;
}

const MUSIC_WORDS = /(nh[aạ]c|music|bgm|background|soundtrack|instrumental|beat|\bsong\b|ambient|theme)/i;
const VOICE_WORDS = /(voice|gi[oọ]ng|narrat|\btts\b|l[oờ]i\s?(?:\w+\s)?(?:d[aẫ]n|tho[aạ]i|b[aì]nh)|\bvo\b|\bdoc\b|thuy[eế]t|thoai|thoại|dub)/i;

/** Một file âm thanh dài hơn mức này mà không có số cảnh thì nhiều khả năng là nhạc nền */
const LONG_AUDIO_SECONDS = 60;

export interface AudioClassification {
  role: AudioRole;
  /** true: hệ thống đoán (không chắc) -> nên nói rõ với người dùng */
  guessed: boolean;
}

export function classifyAudio(item: AudioProbe): AudioClassification {
  if (MUSIC_WORDS.test(item.name)) return { role: 'music', guessed: false };
  if (VOICE_WORDS.test(item.name)) return { role: 'voice', guessed: false };
  if (item.number !== null) return { role: 'voice', guessed: false };
  // Không có số cảnh, không có từ khóa
  return { role: item.duration >= LONG_AUDIO_SECONDS ? 'music' : 'voice', guessed: true };
}

/**
 * Chỉ giữ 1 file là nhạc nền. Ưu tiên file có tên nói rõ là nhạc; nếu không có thì
 * lấy file dài nhất. Các file còn lại chuyển thành voice (đánh dấu là "đoán").
 */
export function classifyAudioBatch(items: AudioProbe[]): Array<AudioClassification & { item: AudioProbe }> {
  const result = items.map(item => ({ ...classifyAudio(item), item }));
  const music = result.filter(r => r.role === 'music');
  if (music.length > 1) {
    const explicit = music.filter(r => !r.guessed);
    const pool = explicit.length > 0 ? explicit : music;
    const keep = pool.reduce((a, b) => (b.item.duration > a.item.duration ? b : a));
    for (const r of music) if (r !== keep) { r.role = 'voice'; r.guessed = true; }
  }
  return result;
}
