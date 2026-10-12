/** Xử lý kết quả nhận dạng giọng nói (hàm thuần, test được bằng Node). */

export interface TranscriptCue { start: number; end: number; text: string }

/**
 * Chuyển chuỗi trả về của AI thành danh sách dòng phụ đề sạch:
 *  - chịu được ```json ... ```, chữ thừa trước/sau
 *  - thời gian không hợp lệ -> bỏ; âm/lố quá độ dài file -> kéo về trong khoảng
 *  - sắp xếp, không cho các dòng chồng lên nhau
 */
export function parseTranscriptJson(raw: string, durationSec?: number): TranscriptCue[] {
  let t = (raw || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  let arr: any;
  try { arr = JSON.parse(t.slice(a, b + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];

  const max = durationSec && durationSec > 0 ? durationSec : Infinity;
  const cues: TranscriptCue[] = [];
  for (const it of arr) {
    const text = typeof it?.text === 'string' ? it.text.replace(/\s+/g, ' ').trim() : '';
    const s = Number(it?.start), e = Number(it?.end);
    if (!text || !Number.isFinite(s) || !Number.isFinite(e)) continue;
    const start = Math.max(0, Math.min(s, max));
    const end = Math.max(start + 0.2, Math.min(e, max));
    cues.push({ start, end, text });
  }
  cues.sort((x, y) => x.start - y.start);
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].start < cues[i - 1].end) cues[i - 1].end = Math.max(cues[i - 1].start + 0.1, cues[i].start);
  }
  return cues;
}

/** Tên loại âm thanh mà Gemini hiểu */
export function geminiAudioMime(type: string, name = ''): string {
  const t = (type || '').toLowerCase();
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (t.includes('wav') || ext === 'wav') return 'audio/wav';
  if (t.includes('mpeg') || t.includes('mp3') || ext === 'mp3') return 'audio/mp3';
  if (t.includes('aac') || t.includes('m4a') || t.includes('mp4') || ext === 'm4a' || ext === 'aac') return 'audio/aac';
  if (t.includes('ogg') || t.includes('opus') || ext === 'ogg' || ext === 'opus') return 'audio/ogg';
  if (t.includes('flac') || ext === 'flac') return 'audio/flac';
  return t.startsWith('audio/') ? t : 'audio/wav';
}
