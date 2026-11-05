/**
 * Phụ đề theo giọng đọc:
 *  - splitIntoCaptions: cắt lời thoại thành các dòng ngắn, đủ câu, KHÔNG cắt giữa ngoặc/ngoặc kép
 *  - cuesFromText: chia thời gian cho từng dòng theo độ dài chữ + nhịp ngắt câu (nói đến đâu chữ chạy đến đó)
 *  - analyzeSpeech: phân tích sóng âm, tìm chính xác những chỗ GIỌNG NGHỈ
 *  - cuesFromTextAligned / alignSegments: đặt chỗ xuống câu đúng vào chỗ giọng nghỉ
 *  - transcribeSegments: nhờ Gemini "nghe" file giọng đọc, trả về từng câu có mốc thời gian
 */
import { GoogleGenAI } from '@google/genai';
import { processKeys } from './gemini';

export interface SubtitleCue {
  /** giây, tính từ đầu cảnh (hoặc đầu file voice với cue toàn cục) */
  start: number;
  end: number;
  text: string;
}

const OPENERS = '([{“‘«';
const CLOSERS = ')]}”’»';

/* ─────────── Ký hiệu đầu dòng: 1. 2.  I. II. IV.  a) b)  Điều 1. ─────────── */

const MARKER_TOKEN = /^(?:[IVXLCDM]{1,7}|\d{1,3}|[a-zA-Z])[.)]$/;
const MARKER_LEAD_WORDS = /^(?:điều|mục|phần|chương|bước|khoản|điểm|bài|câu|section|step|part|chapter|article|no|số)$/i;

/** Từ này có dạng ký hiệu đầu dòng không (I. / II. / 1. / 2) / a) ...) */
export function isMarkerToken(tok: string): boolean {
  const t = tok.replace(/^[(\[“"']+/, '');
  if (!MARKER_TOKEN.test(t)) return false;
  // chữ thường 1 ký tự chỉ tính là ký hiệu khi có dấu ')' (a) b) c)) để không nhầm "vitamin a."
  if (/^[a-z][.]$/.test(t)) return false;
  return true;
}

/**
 * Từ ở vị trí idx có đúng là ký hiệu đầu dòng không?
 * Đúng khi: là từ đầu tiên, hoặc từ trước nó kết thúc bằng dấu câu (. ; : ! ? …), hoặc từ trước là "Điều/Mục/Phần/Bước...".
 */
export function isMarkerAt(words: string[], idx: number): boolean {
  if (!isMarkerToken(words[idx])) return false;
  if (idx === 0) return true;
  const prev = words[idx - 1];
  return /[.;:!?…]["”’)\]]?$/.test(prev) || MARKER_LEAD_WORDS.test(prev.replace(/[^\p{L}]/gu, ''));
}

/** Ngắt một dòng ngay TRƯỚC mỗi ký hiệu đầu dòng nằm giữa dòng (vd. "gồm: 1. A; 2. B" → "gồm:" | "1. A;" | "2. B") */
function splitBeforeMarkers(line: string): string[] {
  const words = line.split(' ');
  const out: string[] = [];
  let cur: string[] = [];
  words.forEach((w, i) => {
    const parenList = /^[a-zA-Z0-9]{1,2}\)$/.test(w) && /^[a-zA-Z0-9]{1,2}\)$/.test(words[0]); // a) ... b) ... c) trong cùng một dòng
    if (i > 0 && cur.length > 0 && (parenList || (isMarkerAt(words, i) && /[;:.!?…]["”’)\]]?$/.test(words[i - 1])))) {
      out.push(cur.join(' '));
      cur = [];
    }
    cur.push(w);
  });
  if (cur.length) out.push(cur.join(' '));
  return out;
}

/** Cắt văn bản thành các câu (chỉ cắt khi KHÔNG nằm trong ngoặc / ngoặc kép) */
function splitSentencesOneLine(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  let inStraightQuote = false;
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    buf += ch;
    if (ch === '"') inStraightQuote = !inStraightQuote;
    else if (OPENERS.includes(ch)) depth++;
    else if (CLOSERS.includes(ch)) depth = Math.max(0, depth - 1);

    const next = chars[i + 1];
    const atEnd = /[.!?…]/.test(ch) || ((ch === '"' || CLOSERS.includes(ch)) && /[.!?…]/.test(chars[i - 1] || ''));
    if (atEnd && depth === 0 && !inStraightQuote && (next === undefined || next === ' ')) {
      // "I." "2." "Điều 1." ở đầu câu là ký hiệu đề mục → KHÔNG ngắt ngay sau nó, giữ dính với chữ phía sau
      const words = buf.trim().split(' ');
      if (next !== undefined && isMarkerAt(words, words.length - 1)) continue;
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** Mỗi dòng xuống hàng là một ranh giới; ký hiệu đầu dòng luôn mở đầu một câu mới */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const t = line.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    for (const part of splitBeforeMarkers(t)) out.push(...splitSentencesOneLine(part));
  }
  return out;
}

/** Đang mở ngoặc / ngoặc kép mà chưa đóng? (để không cắt đôi nội dung trong ngoặc) */
function isUnbalanced(str: string): boolean {
  let depth = 0;
  let quotes = 0;
  for (const ch of str) {
    if (OPENERS.includes(ch)) depth++;
    else if (CLOSERS.includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === '"') quotes++;
  }
  return depth > 0 || quotes % 2 === 1;
}

/** Cắt một câu dài thành các cụm ≤ maxChars, ưu tiên ngắt ở dấu phẩy/chấm phẩy/hai chấm (ngoài ngoặc) */
function splitLongSentence(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) return [sentence];

  // vị trí có thể ngắt (ngoài ngoặc)
  const breaks: number[] = [];
  let depth = 0;
  let inQ = false;
  const chars = Array.from(sentence);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '"') inQ = !inQ;
    else if (OPENERS.includes(ch)) depth++;
    else if (CLOSERS.includes(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0 && !inQ && /[,;:–—]/.test(ch) && chars[i + 1] === ' ') breaks.push(i + 1);
  }

  if (breaks.length > 0) {
    // chọn điểm ngắt gần giữa nhất
    const mid = sentence.length / 2;
    const best = breaks.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a));
    const left = sentence.slice(0, best).trim();
    const right = sentence.slice(best).trim();
    if (left && right) return [...splitLongSentence(left, maxChars), ...splitLongSentence(right, maxChars)];
  }

  // không có dấu để ngắt: ngắt theo từ
  const words = sentence.split(' ');
  const parts: string[] = [];
  const total = Math.ceil(sentence.length / maxChars);
  const target = Math.ceil(sentence.length / total);
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (test.length > target && line && !(isUnbalanced(line) && test.length <= maxChars * 1.4)) {
      const lw = line.split(' ');
      if (lw.length > 1 && isMarkerAt(lw, lw.length - 1)) {
        // không để ký hiệu (I. / 2.) nằm cuối dòng: đẩy xuống đầu dòng sau
        const mk = lw.pop() as string;
        parts.push(lw.join(' '));
        line = `${mk} ${w}`;
      } else {
        parts.push(line);
        line = w;
      }
    } else {
      line = test;
    }
  }
  if (line) parts.push(line);
  return parts;
}

export function splitIntoCaptions(text: string, maxChars = 90): string[] {
  const clean = (text || '').trim();
  if (!clean) return [];
  const pieces: string[] = [];
  for (const s of splitSentences(clean)) pieces.push(...splitLongSentence(s, maxChars));

  // gộp các dòng quá ngắn vào dòng kế bên (nếu vẫn không vượt giới hạn)
  const merged: string[] = [];
  const startsWithMarker = (t: string) => isMarkerAt(t.split(' '), 0);
  const isBareMarker = (t: string) => t.split(' ').length === 1 && isMarkerToken(t);
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && isBareMarker(last)) {
      merged[merged.length - 1] = `${last} ${p}`; // ký hiệu đứng một mình → dính với chữ theo sau
    } else if (last && !startsWithMarker(p) && (last.length < 14 || p.length < 10) && last.length + 1 + p.length <= maxChars) {
      merged[merged.length - 1] = `${last} ${p}`;
    } else {
      merged.push(p);
    }
  }
  return merged;
}

/** Trọng số thời gian: số ký tự + "nghỉ" ở cuối câu/cụm */
function weightOf(line: string): number {
  let w = line.length;
  if (/[.!?…]["”’)\]]?$/.test(line)) w += 8;
  else if (/[,;:–—]$/.test(line)) w += 4;
  return Math.max(4, w);
}

/** Chia thời gian [start, end] cho các dòng phụ đề theo tốc độ nói */
export function cuesFromText(text: string, start: number, end: number, maxChars = 90): SubtitleCue[] {
  const lines = splitIntoCaptions(text, maxChars);
  if (lines.length === 0 || end <= start) return [];
  const weights = lines.map(weightOf);
  const sum = weights.reduce((a, b) => a + b, 0);
  const span = end - start;
  const cues: SubtitleCue[] = [];
  let t = start;
  lines.forEach((line, i) => {
    const d = (weights[i] / sum) * span;
    cues.push({ start: t, end: t + d, text: line });
    t += d;
  });
  return cues;
}

/** Tìm cue đang hiển thị tại thời điểm t (giây) */
export function findCue(cues: SubtitleCue[] | undefined, t: number): SubtitleCue | null {
  if (!cues || cues.length === 0) return null;
  for (let i = 0; i < cues.length; i++) {
    if (t >= cues[i].start && t < cues[i].end) return cues[i];
  }
  return null;
}

/* ───────────────────── Phân tích sóng âm: tìm chỗ giọng nghỉ ───────────────────── */

export interface SpeechMap {
  /** giây: lúc bắt đầu nói / dứt lời */
  start: number;
  end: number;
  duration: number;
  /** các quãng im lặng nằm giữa lời nói (ngắt câu, lấy hơi) */
  silences: { start: number; end: number }[];
}

const FRAME_SEC = 0.01;
const MIN_PAUSE_SEC = 0.14;

export async function analyzeSpeech(blob: Blob): Promise<SpeechMap> {
  const data = await blob.arrayBuffer();
  const Ctx = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new Ctx(1, 44100, 44100);
  const audio = await ctx.decodeAudioData(data.slice(0));
  const ch0 = audio.getChannelData(0);
  const ch1 = audio.numberOfChannels > 1 ? audio.getChannelData(1) : null;
  const sr = audio.sampleRate;
  const hop = Math.max(1, Math.round(sr * FRAME_SEC));
  const n = Math.floor(ch0.length / hop);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) {
      const v = ch1 ? (ch0[j] + ch1[j]) / 2 : ch0[j];
      sum += v * v;
    }
    rms[i] = Math.sqrt(sum / hop);
  }
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const p10 = sorted[Math.floor(n * 0.1)] || 0;
  const p95 = sorted[Math.floor(n * 0.95)] || 0;
  const thr = Math.max(p10 * 3, p95 * 0.06, 0.003);

  const voiced = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const m = Math.max(rms[i], rms[i - 1] ?? 0, rms[i + 1] ?? 0);
    voiced[i] = m > thr ? 1 : 0;
  }
  let first = voiced.indexOf(1);
  let last = voiced.lastIndexOf(1);
  if (first < 0) return { start: 0, end: audio.duration, duration: audio.duration, silences: [] };

  const silences: { start: number; end: number }[] = [];
  let i = first;
  while (i <= last) {
    if (voiced[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j <= last && !voiced[j]) j++;
    if ((j - i) * FRAME_SEC >= MIN_PAUSE_SEC) silences.push({ start: i * FRAME_SEC, end: j * FRAME_SEC });
    i = j;
  }
  return {
    start: first * FRAME_SEC,
    end: Math.min(audio.duration, (last + 1) * FRAME_SEC + 0.08),
    duration: audio.duration,
    silences,
  };
}

/** Các đoạn có tiếng nói (giữa các quãng nghỉ) */
function voicedSegments(sp: SpeechMap): [number, number][] {
  const segs: [number, number][] = [];
  let cur = sp.start;
  for (const s of sp.silences) {
    if (s.start > cur) segs.push([cur, s.start]);
    cur = s.end;
  }
  if (sp.end > cur) segs.push([cur, sp.end]);
  return segs;
}

/** Đổi "thời gian chỉ tính lúc có tiếng nói" thành thời gian thật của file */
function voicedToReal(segs: [number, number][], v: number): number {
  let acc = 0;
  for (const [a, b] of segs) {
    const len = b - a;
    if (v <= acc + len) return a + (v - acc);
    acc += len;
  }
  return segs.length ? segs[segs.length - 1][1] : 0;
}

function nearestSilence(
  sp: SpeechMap,
  target: number,
  minTime: number,
  window: number,
  used: Set<number>
): { start: number; end: number; idx: number } | null {
  let best: { start: number; end: number; idx: number } | null = null;
  let bestD = Infinity;
  sp.silences.forEach((s, idx) => {
    if (used.has(idx)) return;
    const mid = (s.start + s.end) / 2;
    if (mid <= minTime) return;
    const d = Math.abs(mid - target);
    // ưu tiên quãng nghỉ DÀI (ngắt câu thật) hơn quãng nghỉ ngắn giữa các từ
    const score = d - 2.5 * (s.end - s.start);
    if (d <= window && score < bestD) {
      best = { start: s.start, end: s.end, idx };
      bestD = score;
    }
  });
  return best;
}

/**
 * Biết sẵn lời thoại (kịch bản): chia thành các câu rồi đặt chỗ xuống câu đúng vào
 * những quãng giọng đọc thực sự nghỉ. Mỗi cảnh hiện nguyên câu, không mất cấu trúc ngoặc.
 */
export function cuesFromTextAligned(text: string, sp: SpeechMap, maxChars = 90): SubtitleCue[] {
  const lines = splitIntoCaptions(text, maxChars);
  if (lines.length === 0) return [];
  if (lines.length === 1 || sp.end <= sp.start) return cuesFromText(text, sp.start, Math.max(sp.end, sp.start + 1), maxChars);

  const w = lines.map(weightOf);
  const W = w.reduce((a, b) => a + b, 0);
  const segs = voicedSegments(sp);
  const V = segs.reduce((a, [x, y]) => a + (y - x), 0);

  const used = new Set<number>();
  const bounds: { t0: number; t1: number }[] = [];
  let cum = 0;
  let lastT = sp.start;
  for (let k = 1; k < lines.length; k++) {
    cum += w[k - 1];
    const target = voicedToReal(segs, (V * cum) / W);
    const sil = nearestSilence(sp, target, lastT + 0.3, 1.8, used);
    if (sil) {
      used.add(sil.idx);
      const t0 = sil.start + 0.04;
      const t1 = Math.max(t0, sil.end - 0.06);
      bounds.push({ t0, t1 });
      lastT = t1;
    } else {
      bounds.push({ t0: target, t1: target });
      lastT = target;
    }
  }

  const cues: SubtitleCue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const start = i === 0 ? Math.max(0, sp.start - 0.05) : bounds[i - 1].t1;
    const end = i === lines.length - 1 ? sp.end : bounds[i].t0;
    cues.push({ start, end: Math.max(end, start + 0.4), text: lines[i] });
  }
  return cues;
}

/**
 * Có các câu + mốc thời gian gợi ý từ AI nghe giọng: tinh chỉnh từng chỗ xuống câu
 * cho khớp đúng quãng giọng nghỉ gần nhất.
 */
export function alignSegments(
  segments: { start: number; end: number; text: string }[],
  sp: SpeechMap,
  maxChars = 90
): SubtitleCue[] {
  if (segments.length === 0) return [];
  const used = new Set<number>();
  const starts: number[] = [];
  const ends: number[] = [];
  let lastT = sp.start;
  const first = segments[0];
  starts.push(Math.abs(first.start - sp.start) < 1.5 ? Math.max(0, sp.start - 0.05) : first.start);
  for (let i = 1; i < segments.length; i++) {
    const target = (segments[i - 1].end + segments[i].start) / 2;
    const sil = nearestSilence(sp, target, lastT + 0.2, 1.2, used);
    if (sil) {
      used.add(sil.idx);
      ends.push(sil.start + 0.04);
      const st = Math.max(sil.start + 0.04, sil.end - 0.06);
      starts.push(st);
      lastT = st;
    } else {
      ends.push(Math.max(segments[i - 1].end, starts[i - 1] + 0.4));
      starts.push(Math.max(segments[i].start, ends[i - 1]));
      lastT = starts[i];
    }
  }
  const lastSeg = segments[segments.length - 1];
  ends.push(Math.abs(lastSeg.end - sp.end) < 1.5 ? sp.end : lastSeg.end);

  const cues: SubtitleCue[] = [];
  segments.forEach((sg, i) => {
    const s0 = starts[i];
    const e0 = Math.max(ends[i], s0 + 0.4);
    cues.push(...cuesFromText(sg.text, s0, e0, maxChars));
  });
  return cues;
}

/* ───────────────────── Nghe giọng đọc → câu có mốc thời gian (Gemini) ───────────────────── */

const TRANSCRIBE_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];
const MAX_INLINE_BYTES = 18 * 1024 * 1024;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('Không đọc được file âm thanh'));
    r.readAsDataURL(blob);
  });
}

function parseSegments(raw: string): { start: number; end: number; text: string }[] {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const first = s.indexOf('[');
  const last = s.lastIndexOf(']');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  const arr = JSON.parse(s);
  if (!Array.isArray(arr)) throw new Error('Kết quả phiên âm không đúng định dạng');
  const toSec = (v: unknown): number => {
    if (typeof v === 'number') return v;
    const str = String(v ?? '0').trim();
    if (str.includes(':')) {
      return str.split(':').reduce((acc, p) => acc * 60 + parseFloat(p || '0'), 0);
    }
    return parseFloat(str) || 0;
  };
  return arr
    .map((x: { start?: unknown; end?: unknown; text?: unknown }) => ({ start: toSec(x.start), end: toSec(x.end), text: String(x.text ?? '').trim() }))
    .filter((x) => x.text && x.end > x.start)
    .sort((a, b) => a.start - b.start);
}

/**
 * Nhờ Gemini nghe file giọng đọc và trả về TỪNG CÂU (đúng như người đọc ngắt nghỉ) kèm mốc thời gian gợi ý.
 * Xoay vòng nhiều API key như phần còn lại của ứng dụng.
 */
export async function transcribeSegments(
  blob: Blob,
  keys: string[]
): Promise<{ start: number; end: number; text: string }[]> {
  if (blob.size > MAX_INLINE_BYTES) {
    throw new Error('File giọng đọc quá lớn (>18MB). Hãy đổi sang mp3 hoặc cắt ngắn rồi thử lại.');
  }
  const apiKeys = Array.from(new Set(processKeys(keys)));
  if (apiKeys.length === 0) throw new Error('Chưa có API key Gemini để nhận dạng giọng nói.');

  const data = await blobToBase64(blob);
  const mimeType = blob.type && blob.type.startsWith('audio/') ? blob.type : 'audio/mpeg';
  const prompt =
    'Nghe file âm thanh và chép lại ĐÚNG NGUYÊN VĂN lời được nói (giữ đúng ngôn ngữ gốc). ' +
    'Chia thành từng CÂU HOÀN CHỈNH đúng theo chỗ người đọc ngắt nghỉ; giữ đủ dấu câu. ' +
    'Nếu người nói trích dẫn thì đặt trong ngoặc kép “...”, nếu giải thích thêm thì đặt trong ngoặc đơn (...); mở ngoặc nào phải đóng ngoặc đó. ' +
    'Trả về DUY NHẤT một mảng JSON: [{"start": <giây bắt đầu nói câu, số thập phân>, "end": <giây dứt câu>, "text": "<câu>"}]. ' +
    'Mốc thời gian phải khớp lúc người đó thực sự nói trong file. Không thêm lời giải thích nào khác.';

  let lastErr: unknown = null;
  for (const key of apiKeys) {
    const ai = new GoogleGenAI({ apiKey: key });
    for (const model of TRANSCRIBE_MODELS) {
      try {
        const res = await ai.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data } }, { text: prompt }] }],
          config: { responseMimeType: 'application/json', temperature: 0 },
        });
        const segs = parseSegments(res.text || '');
        if (segs.length === 0) throw new Error('Không nhận dạng được lời nói trong file');
        return segs;
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw new Error(
    'Không nhận dạng được giọng đọc: ' + (lastErr instanceof Error ? lastErr.message : String(lastErr ?? ''))
  );
}
