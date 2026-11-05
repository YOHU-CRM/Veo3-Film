/**
 * [MỚI] sceneVision.ts — AI "nhìn" ảnh/video của từng cảnh để:
 *  (A) viết lời thoại ĐÚNG nội dung từng cảnh, độ dài vừa thời lượng cảnh
 *  (C) gán từng câu phụ đề của voice dài vào đúng cảnh → hình chuyển cảnh đúng lúc lời chuyển ý
 * Tối ưu: gom TẤT CẢ cảnh vào 1 lần gọi, ảnh thu nhỏ ≤512px; lỗi → dự phòng không dùng AI.
 */
import { GoogleGenAI } from '@google/genai';
import { processKeys } from './gemini';
import type { SubtitleCue } from './subtitleCues';

const VISION_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];
const MAX_SIDE = 512;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

export interface SceneVisual {
  url: string;
  isImage?: boolean;
  /** số giây dự kiến của cảnh */
  seconds: number;
  /** [MỚI] đoạn video được giữ lại (giây) — chụp khung trong các đoạn này */
  segments?: [number, number][];
  /** [MỚI] mô tả dựng cảnh của người dùng — AI viết lời bám theo */
  note?: string;
}

/* ─────────── [MỚI] Chụp khung hình thu nhỏ (base64 JPEG) ─────────── */

function canvasToB64(src: CanvasImageSource, w: number, h: number): string {
  const k = Math.min(1, MAX_SIDE / Math.max(w, h, 1));
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));
  const cv = document.createElement('canvas');
  cv.width = cw;
  cv.height = ch;
  const ctx = cv.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(src, 0, 0, cw, ch);
  return cv.toDataURL('image/jpeg', 0.7).split(',')[1] || '';
}

/** [MỚI] Lấy 1 khung (ảnh) hoặc `count` khung rải đều (video) của 1 cảnh */
export async function captureSceneFrames(sv: SceneVisual, count = 3): Promise<string[]> {
  if (!sv.url) return [];
  if (sv.isImage) {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.src = sv.url;
    await new Promise<void>((r) => { im.onload = () => r(); im.onerror = () => r(); });
    if (!im.naturalWidth) return [];
    const b = canvasToB64(im, im.naturalWidth, im.naturalHeight);
    return b ? [b] : [];
  }
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  v.src = sv.url;
  await new Promise<void>((r) => { v.onloadeddata = () => r(); v.onerror = () => r(); setTimeout(r, 8000); });
  const dur = v.duration;
  if (!isFinite(dur) || dur <= 0 || !v.videoWidth) return [];
  const out: string[] = [];
  // [SỬA] có đoạn giữ lại → chỉ chụp trong các đoạn đó
  const segs = sv.segments && sv.segments.length ? sv.segments : [[0, dur] as [number, number]];
  const total = segs.reduce((a, [x, y]) => a + (y - x), 0) || dur;
  const at = (v: number) => {
    let acc = 0;
    for (const [x, y] of segs) { if (v <= acc + (y - x)) return x + (v - acc); acc += y - x; }
    return segs[segs.length - 1][1];
  };
  for (let i = 0; i < count; i++) {
    const t = at(total * ((i + 0.5) / count));
    await new Promise<void>((r) => {
      const done = () => { v.removeEventListener('seeked', done); r(); };
      v.addEventListener('seeked', done);
      v.currentTime = Math.min(dur - 0.05, t);
      setTimeout(done, 3000);
    });
    const b = canvasToB64(v, v.videoWidth, v.videoHeight);
    if (b) out.push(b);
  }
  v.removeAttribute('src');
  v.load();
  return out;
}

/** [MỚI] Chụp khung cho mọi cảnh; tự giảm số khung khi nhiều cảnh để giữ 1 request gọn */
export async function captureAllScenes(list: SceneVisual[], onStep?: (i: number, n: number) => void): Promise<string[][]> {
  const perVideo = list.length > 30 ? 1 : list.length > 15 ? 2 : 3;
  const res: string[][] = [];
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    onStep?.(i + 1, list.length);
    let frames: string[] = [];
    try { frames = await captureSceneFrames(list[i], perVideo); } catch { frames = []; }
    const size = frames.reduce((a, f) => a + f.length, 0);
    if (total + size > MAX_TOTAL_BYTES) frames = frames.slice(0, 1);
    total += frames.reduce((a, f) => a + f.length, 0);
    res.push(frames);
  }
  return res;
}

/* ─────────── Gọi Gemini có ảnh (xoay vòng key như transcribeSegments) ─────────── */

export type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

export function buildSceneParts(frames: string[][], labels?: number[]): Part[] {
  const parts: Part[] = [];
  frames.forEach((fs, i) => {
    parts.push({ text: `=== CẢNH ${labels ? labels[i] : i + 1} ===${fs.length === 0 ? ' (không có hình)' : ''}` });
    fs.forEach((d) => parts.push({ inlineData: { mimeType: 'image/jpeg', data: d } }));
  });
  return parts;
}

export function parseJson<T>(raw: string): T {
  let s = (raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = Math.min(...['[', '{'].map((c) => (s.indexOf(c) < 0 ? Infinity : s.indexOf(c))));
  const b = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
  if (isFinite(a) && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s) as T;
}

export async function callVision(parts: Part[], keys: string[]): Promise<string> {
  const apiKeys = Array.from(new Set(processKeys(keys)));
  if (apiKeys.length === 0) throw new Error('Chưa có API key Gemini.');
  let lastErr: unknown = null;
  for (const key of apiKeys) {
    const ai = new GoogleGenAI({ apiKey: key });
    for (const model of VISION_MODELS) {
      try {
        const res = await ai.models.generateContent({
          model,
          contents: [{ role: 'user', parts }],
          config: { responseMimeType: 'application/json', temperature: 0.4 },
        });
        const txt = res.text || '';
        if (txt.trim()) return txt;
        throw new Error('EMPTY_RESPONSE');
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw new Error('AI không phân tích được hình cảnh: ' + (lastErr instanceof Error ? lastErr.message : String(lastErr ?? '')));
}

/** [MỚI] Số từ phù hợp để đọc vừa `seconds` giây (TTS VN ~2.6 từ/giây, EN ~2.4) */
export function wordsForSeconds(seconds: number, lang: 'VN' | 'EN'): number {
  const rate = lang === 'VN' ? 2.6 : 2.4;
  return Math.max(6, Math.round(Math.max(2, seconds - 0.4) * rate));
}

/* ─────────── (A) [MỚI] Viết lời thoại theo đúng hình từng cảnh ─────────── */

export async function writeSceneScripts(
  scenes: SceneVisual[],
  frames: string[][],
  topic: string,
  lang: 'VN' | 'EN',
  keys: string[],
): Promise<string[]> {
  const n = scenes.length;
  // [SỬA] kèm mô tả dựng cảnh của người dùng để lời nhắc đúng thứ cần nhấn mạnh
  const plan = scenes.map((s, i) => `Cảnh ${i + 1}: ${s.seconds.toFixed(1)} giây → khoảng ${wordsForSeconds(s.seconds, lang)} từ` +
    (s.note && s.note.trim() ? ` | yêu cầu dựng: "${s.note.trim()}" (lời phải nhắc tới đúng thứ được nhấn mạnh)` : '')).join('\n');
  const prompt =
    `Bạn là biên kịch lời dẫn (voiceover) cho video mạng xã hội. Phía trên là hình của ${n} cảnh theo đúng thứ tự.\n` +
    (topic.trim() ? `Chủ đề / yêu cầu của người dùng: "${topic.trim()}"\n` : '') +
    `NHIỆM VỤ: viết đúng ${n} đoạn lời dẫn, đoạn thứ k nói ĐÚNG nội dung đang thấy trong hình CẢNH k ` +
    `(người, vật, hành động, chữ trên ảnh/slide), nối mạch thành một câu chuyện liền từ đầu đến cuối.\n` +
    `ĐỘ DÀI (bắt buộc, để giọng đọc vừa khít thời lượng cảnh):\n${plan}\n` +
    `Ngôn ngữ: ${lang === 'VN' ? 'tiếng Việt' : 'English'}. Không mô tả kiểu "trong hình là...", hãy kể tự nhiên. Không dùng emoji, hashtag, ký hiệu đặc biệt.\n` +
    `Trả về DUY NHẤT mảng JSON ${n} chuỗi: ["lời cảnh 1", "lời cảnh 2", ...]`;
  const raw = await callVision([...buildSceneParts(frames), { text: prompt }], keys);
  const arr = parseJson<unknown[]>(raw);
  if (!Array.isArray(arr)) throw new Error('AI trả về sai định dạng lời thoại');
  const out = arr.map((x) => String(typeof x === 'object' && x ? (x as { text?: string }).text ?? '' : x ?? '').trim());
  while (out.length < n) out.push('');
  return out.slice(0, n);
}

/* ─────────── (C) [MỚI] Gán câu phụ đề của voice dài vào đúng cảnh ─────────── */

/**
 * Chuẩn hoá bảng gán: bắt đầu cảnh 1, không giảm dần, không nhảy cóc cảnh (mỗi bước +0 hoặc +1),
 * và nếu số câu ≥ số cảnh thì câu cuối rơi vào cảnh cuối → cảnh nào cũng có lời.
 */
function normalizeAssignment(raw: number[], cueCount: number, sceneCount: number): number[] {
  const a: number[] = [];
  const full = cueCount >= sceneCount;
  let prev = 0;
  for (let i = 0; i < cueCount; i++) {
    let v = Math.round(Number(raw[i]));
    if (!isFinite(v)) v = prev;
    const lo = full ? Math.max(prev, sceneCount - (cueCount - i)) : prev;
    const hi = Math.min(prev + 1, i, sceneCount - 1);
    v = i === 0 ? 0 : Math.max(lo, Math.min(hi, v));
    a.push(v);
    prev = v;
  }
  return a;
}

/** [MỚI] Dự phòng không AI: chia câu theo tỉ lệ số giây đã đặt của từng cảnh */
export function assignCuesByDuration(cues: SubtitleCue[], seconds: number[]): number[] {
  const total = seconds.reduce((x, y) => x + y, 0) || 1;
  const t0 = cues.length ? cues[0].start : 0;
  const span = (cues.length ? cues[cues.length - 1].end : 1) - t0 || 1;
  const edges: number[] = [];
  let acc = 0;
  seconds.forEach((s) => { acc += s; edges.push(t0 + (acc / total) * span); });
  const raw = cues.map((c) => {
    const mid = (c.start + c.end) / 2;
    const k = edges.findIndex((e) => mid < e);
    return k < 0 ? seconds.length - 1 : k;
  });
  return normalizeAssignment(raw, cues.length, seconds.length);
}

/** [MỚI] AI xem hình các cảnh + đọc các câu phụ đề → trả về cảnh (0-based) cho từng câu */
export async function assignCuesToScenes(cues: SubtitleCue[], frames: string[][], keys: string[]): Promise<number[]> {
  const n = frames.length;
  const list = cues.map((c, i) => `${i + 1}. ${c.text}`).join('\n');
  const prompt =
    `Phía trên là hình của ${n} cảnh video theo thứ tự. Dưới đây là ${cues.length} câu lời dẫn theo đúng thứ tự đọc:\n${list}\n\n` +
    `Hãy gán mỗi câu vào cảnh mà hình ảnh khớp nội dung nhất. Quy tắc: thứ tự cảnh KHÔNG được giảm dần theo thứ tự câu; ` +
    `câu 1 thuộc cảnh 1; cảnh nào cũng phải có ít nhất 1 câu (nếu số câu ≥ số cảnh).\n` +
    `Trả về DUY NHẤT mảng JSON ${cues.length} số nguyên (số cảnh, bắt đầu từ 1): [1,1,2,3,...]`;
  const raw = await callVision([...buildSceneParts(frames), { text: prompt }], keys);
  const arr = parseJson<unknown[]>(raw);
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('AI trả về sai định dạng gán cảnh');
  return normalizeAssignment(arr.map((x) => Number(x) - 1), cues.length, n);
}

/**
 * [MỚI] Từ bảng gán câu→cảnh, tính thời lượng từng cảnh sao cho cảnh chuyển đúng lúc câu đầu của cảnh kế bắt đầu.
 * Ranh giới đặt giữa quãng nghỉ (giữa end câu trước và start câu sau). Cảnh không có câu → giữ giây cũ.
 */
export function sceneDurationsFromCues(
  cues: SubtitleCue[],
  assign: number[],
  fallbackSeconds: number[],
  startAt: number,
): { durations: number[]; texts: string[] } {
  const n = fallbackSeconds.length;
  const texts: string[] = Array.from({ length: n }, () => '');
  const firstCue: number[] = Array(n).fill(-1);
  const lastCue: number[] = Array(n).fill(-1);
  assign.forEach((s, i) => {
    if (firstCue[s] < 0) firstCue[s] = i;
    lastCue[s] = i;
    texts[s] = texts[s] ? `${texts[s]} ${cues[i].text}` : cues[i].text;
  });
  const boundary = (s: number): number => {
    // lúc bắt đầu cảnh s (s ≥ 1)
    const fi = firstCue[s];
    if (fi <= 0) return NaN;
    return (cues[fi - 1].end + cues[fi].start) / 2;
  };
  const durations: number[] = [];
  let t = startAt;
  for (let s = 0; s < n; s++) {
    let end: number;
    if (s === n - 1) {
      const li = lastCue[s] >= 0 ? lastCue[s] : cues.length - 1;
      end = (cues[li]?.end ?? t + fallbackSeconds[s]) + 0.6;
    } else {
      end = boundary(s + 1);
      if (!isFinite(end)) end = t + fallbackSeconds[s];
    }
    const d = Math.max(1, end - t);
    durations.push(Math.round(d * 100) / 100);
    t += d;
  }
  return { durations, texts };
}
