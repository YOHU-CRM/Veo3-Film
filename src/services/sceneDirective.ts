/**
 * [MỚI] sceneDirective.ts — Hiểu "Mô tả dựng cảnh" người dùng viết bằng lời thường.
 *  - Video: giữ / bỏ các đoạn (nhiều đoạn, nhiều cách viết), N giây đầu/cuối, từ giây N trở đi...
 *  - Ảnh/video: hiệu ứng phóng to, khung sáng, làm tối xung quanh, gạch chân, hiện lần lượt, chuyển động chậm
 *  - Từ cần nhấn mạnh (trong ngoặc kép) → tô màu phụ đề + đọc nhấn giọng + hiệu ứng đúng lúc giọng nói tới
 * Cách hiểu: luật (nhanh, không tốn API) → câu khó / cần tìm vị trí trên hình thì gom 1 lần gọi AI.
 */
import { buildSceneParts, callVision, parseJson } from './sceneVision';

// [SỬA] thêm 'pop' = nảy/nhảy nhấn nhá vào thứ cần nhấn
export type EffectKind = 'zoom' | 'highlight' | 'spotlight' | 'underline' | 'reveal' | 'kenburns' | 'pop';
export const EFFECT_KINDS: EffectKind[] = ['zoom', 'highlight', 'spotlight', 'underline', 'reveal', 'kenburns', 'pop'];

/** Vùng trên hình, tỉ lệ 0-1 theo khung ảnh/video gốc */
export interface Box { x: number; y: number; w: number; h: number }

export interface SceneEffect {
  kind: EffectKind;
  box?: Box;
  /** thứ cần nhấn (chữ trong ngoặc / tên vật) — chưa có box thì AI tìm */
  target?: string;
  /** từ trong lời đọc: giọng nói tới đâu hiệu ứng chạy tới đó */
  word?: string;
  /** box ước lượng từ lời (trái/phải/trên/dưới) → khi dựng sẽ bám vào khối nhận diện gần nhất */
  approx?: boolean;
}

/** Mốc âm = tính từ cuối video; END = tới hết video */
export const END = 1e9;
export interface TimeRange { start: number; end: number }

export interface SceneDirective {
  srcText: string;
  keep: TimeRange[];
  cut: TimeRange[];
  effects: SceneEffect[];
  emphasis: string[];
  /** cần AI hiểu thêm (câu khó hoặc phải tìm vị trí trên hình) */
  needsAI: boolean;
  byAI?: boolean;
  /** [MỚI] cần AI nhưng chưa có API key Gemini → báo rõ cho người dùng */
  aiUnavailable?: boolean;
  /** [MỚI] phần mô tả công cụ CHƯA HIỂU (nguyên văn người dùng viết) */
  unclear?: string[];
  /** [MỚI] phần hiểu nhưng công cụ CHƯA LÀM ĐƯỢC */
  unsupported?: string[];
}

/* ─────────── Chuẩn hoá chữ ─────────── */

export function norm(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd');
}

const T = String.raw`(\d{1,2}:\d{1,2}(?::\d{1,2})?(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?!\s*[%x])\s*(?:s\b|giay\b|sec\b|d\b)?`;
const SEP = String.raw`\s*(?:-|den|toi|to|->|cho den)\s*(?:giay\s*)?`;

export function parseTime(v: string): number {
  const s = v.replace(',', '.');
  if (s.includes(':')) return s.split(':').reduce((a, p) => a * 60 + parseFloat(p || '0'), 0);
  return parseFloat(s) || 0;
}

const KEEP_WORDS = /\b(giu lai|giu|lay|chi dung|dung|su dung|trich|keep|use)\b/g;
const CUT_WORDS = /\b(bo|cat bo|cat|xoa|loai bo|loai|remove|delete|cut)\b/g;

/** Từ khoá giữ/bỏ gần nhất đứng TRƯỚC vị trí idx (mặc định: giữ) */
function modeAt(n: string, idx: number): 'keep' | 'cut' {
  const before = n.slice(0, idx);
  let k = -1;
  let c = -1;
  for (const m of before.matchAll(KEEP_WORDS)) k = m.index ?? k;
  for (const m of before.matchAll(CUT_WORDS)) c = m.index ?? c;
  return c > k ? 'cut' : 'keep';
}

/* ─────────── Vị trí bằng lời (trái/phải/trên/dưới/giữa/góc) ─────────── */

function boxFromPosition(n: string): Box | undefined {
  const left = /\b(ben trai|phia trai|goc trai|trai|left)\b/.test(n);
  const right = /\b(ben phai|phia phai|goc phai|phai|right)\b/.test(n);
  const top = /\b(phia tren|ben tren|goc tren|nua tren|tren|top)\b/.test(n);
  const bottom = /\b(phia duoi|ben duoi|goc duoi|nua duoi|duoi|bottom)\b/.test(n);
  const mid = /\b(chinh giua|o giua|giua|center)\b/.test(n);
  if (!left && !right && !top && !bottom && !mid) return undefined;
  const x = left ? 0 : right ? 0.5 : 0.25;
  const y = top ? 0 : bottom ? 0.5 : 0.25;
  const w = left || right ? 0.5 : mid ? 0.5 : 1;
  const h = top || bottom ? 0.5 : mid ? 0.5 : 1;
  return { x: left || right || mid ? x : 0, y: top || bottom || mid ? y : 0, w, h };
}

const EFFECT_PHRASES: [EffectKind, string[]][] = [
  ['spotlight', ['lam toi xung quanh', 'toi xung quanh', 'lam mo xung quanh', 'lam toi', 'spotlight', 'chi sang', 'roi sang']],
  // [SỬA] thêm từ thường dùng
  ['pop', ['nhay hieu ung', 'nhay len', 'nhay', 'nay len', 'nay', 'bat nhay', 'rung', 'lac', 'nhun', 'pop', 'bounce', 'giat']],
  ['zoom', ['phong to vao', 'phong to', 'phong lon', 'to len', 'to hon', 'lon hon', 'to ra', 'lon len', 'phong vao', 'zoom vao', 'zoom', 'keo gan', 'lai gan', 'can canh', 'day vao']],
  ['underline', ['gach chan', 'gach duoi', 'underline']],
  ['highlight', ['dong khung', 'khung sang', 'highlight', 'vien sang', 'lam noi bat', 'lam noi', 'to sang', 'khoanh', 'danh dau', 'nhap nhay', 'phat sang', 'sang len', 'loe sang', 'glow', 'nhan manh']],
  ['reveal', ['lan luot', 'tung o', 'tung khoi', 'tung y', 'tung phan', 'hien dan', 'reveal']],
  ['kenburns', ['chuyen dong cham', 'chuyen dong nhe', 'ken burns', 'kenburns', 'troi cham', 'lia cham']],
];
const EFFECT_RULES: [EffectKind, RegExp][] = EFFECT_PHRASES.map(([k, ph]) => [k, new RegExp(`\\b(${ph.filter((x) => x !== 'nhan manh').join('|')})\\b`)]);

const STOP = new Set(['vao', 'cho', 'cua', 'cai', 'phan', 'o', 'chu', 'hinh', 'anh', 'video', 'canh', 'nay', 'va', 'the', 'la', 'khi', 'luc', 'giong', 'doc', 'noi', 'toi', 'den', 'xung', 'quanh', 'ro', 'manh', 'hon', 'nhe', 'cham', 'chua', 'dong', 'nhan', 'thu', 'hieu', 'ung', 'len']);
const POS_WORDS = /^(ben|phia|goc|nua|trai|phai|tren|duoi|giua|chinh)$/;
const BREAK_WORDS = /^(va|khi|luc|roi|sau|truoc|trong|de)$/;

/** Tên vật cần nhấn (giữ nguyên chữ có dấu): các từ đứng sau cụm hiệu ứng, bỏ từ đệm/vị trí */
/** [MỚI] "chữ YOHU.app", "dòng chữ Giảm giá", "logo ABC" → thứ cần nhấn (giữ nguyên chữ gốc) */
function namedTarget(orig: string): string {
  const words = orig.split(/\s+/).filter(Boolean);
  const nw = words.map((w) => norm(w).replace(/[^a-z0-9⟨⟩]/g, ''));
  const effFirst = new Set(EFFECT_PHRASES.flatMap(([, ph]) => ph.map((x) => x.split(' ')[0])));
  for (let j = 0; j < nw.length; j++) {
    if (!['chu', 'logo', 'nut', 'tieude', 'slogan', 'ten'].includes(nw[j])) continue;
    const out: string[] = [];
    for (let k = j + 1; k < words.length && out.length < 4; k++) {
      if (effFirst.has(nw[k]) || BREAK_WORDS.test(nw[k]) || nw[k].startsWith('⟨q') || !nw[k]) break;
      if (out.length === 0 && STOP.has(nw[k])) continue;
      out.push(words[k].replace(/[,;:!?]+$/, ''));
      if (/[,;:!?]$/.test(words[k])) break;
    }
    if (out.length) return (nw[j] === 'logo' ? 'logo ' : '') + out.join(' ');
    if (nw[j] === 'logo') return 'logo';
  }
  return '';
}

function nounAfterEffect(orig: string): string {
  const words = orig.split(/\s+/).filter(Boolean);
  const nw = words.map((w) => norm(w).replace(/[^a-z0-9⟨⟩]/g, ''));
  for (const [, phrases] of EFFECT_PHRASES) {
    for (const ph of phrases) {
      const pw = ph.split(' ');
      for (let j = 0; j + pw.length <= nw.length; j++) {
        if (pw.every((x, k) => nw[j + k] === x)) {
          const out: string[] = [];
          for (let k = j + pw.length; k < words.length; k++) {
            if (BREAK_WORDS.test(nw[k]) || nw[k].startsWith('⟨q') || /^\d/.test(nw[k])) break;
            if (STOP.has(nw[k]) || POS_WORDS.test(nw[k]) || !nw[k]) { if (out.length) break; else continue; }
            out.push(words[k].replace(/[,.;:!?]+$/, ''));
            if (/[,.;:!?]$/.test(words[k]) || out.length >= 4) break;
          }
          if (out.length) return out.join(' ');
        }
      }
    }
  }
  return '';
}

/** [MỚI] Hiểu mô tả bằng luật — chạy ngay khi người dùng gõ */
export function parseDirectiveRules(text: string, isImage: boolean): SceneDirective {
  const src = (text || '').trim();
  const dir: SceneDirective = { srcText: src, keep: [], cut: [], effects: [], emphasis: [], needsAI: false };
  if (!src) return dir;

  // 1) Chữ trong ngoặc = thứ cần nhấn mạnh (tách ra trước để số trong ngoặc như "Giảm 50%" không bị hiểu là giây)
  const quoted: string[] = [];
  const unq = src.replace(/["“”«»]([^"“”«»]{1,80})["“”«»]|[‘’']([^‘’']{1,80})[‘’']/g, (_m, a, b) => {
    const q = String(a ?? b ?? '').trim();
    if (!q) return ' ';
    quoted.push(q);
    return ` ⟨q${quoted.length - 1}⟩ `;
  });
  let n = norm(unq).replace(/[–—~→]/g, '-').replace(/\s+/g, ' ');

  // 2) Đoạn thời gian: "5s-12s", "0:05 đến 0:12", "giây 20 tới 35"
  if (!isImage) {
    const rangeRe = new RegExp(String.raw`(?:tu\s*)?(?:giay\s*|doan\s*)?` + T + SEP + T, 'g');
    const ranges: { idx: number; r: TimeRange }[] = [];
    n = n.replace(rangeRe, (m, a, b, off: number) => {
      const s0 = parseTime(a);
      const e0 = parseTime(b);
      if (e0 > s0) ranges.push({ idx: off, r: { start: s0, end: e0 } });
      return ' '.repeat(m.length);
    });
    // "bỏ 3 giây đầu", "lấy 4 giây cuối"
    const relRe = new RegExp(T + String.raw`\s*(?:giay\s*)?(dau|cuoi)\b`, 'g');
    n = n.replace(relRe, (m, a, pos, off: number) => {
      const v = parseTime(a);
      if (v > 0) ranges.push({ idx: off, r: pos === 'dau' ? { start: 0, end: v } : { start: -v, end: END } });
      return ' '.repeat(m.length);
    });
    // "từ giây 8 trở đi / đến hết"
    const fromRe = new RegExp(String.raw`tu\s*(?:giay\s*)?` + T + String.raw`\s*(?:tro di|tro ve sau|den het|den cuoi|toi het|toi cuoi)?`, 'g');
    n = n.replace(fromRe, (m, a, off: number) => {
      ranges.push({ idx: off, r: { start: parseTime(a), end: END } });
      return ' '.repeat(m.length);
    });
    // "đến giây 10" (từ đầu)
    const toRe = new RegExp(String.raw`(?:den|toi)\s*giay\s*` + T, 'g');
    n = n.replace(toRe, (m, a, off: number) => {
      ranges.push({ idx: off, r: { start: 0, end: parseTime(a) } });
      return ' '.repeat(m.length);
    });
    ranges.sort((x, y) => x.idx - y.idx);
    const normFull = norm(unq).replace(/[–—~→]/g, '-').replace(/\s+/g, ' ');
    for (const { idx, r } of ranges) (modeAt(normFull, idx) === 'cut' ? dir.cut : dir.keep).push(r);
  }

  // 3) Hiệu ứng — [SỬA] hiểu theo TỪNG vế câu ("phóng to ô trái, gạch chân ô phải" = 2 hiệu ứng 2 vị trí)
  const unclear: string[] = [];
  const unsupported: string[] = [];
  const restore = (t: string) => t.replace(/⟨q(\d+)⟩/g, (_m, i) => `"${quoted[Number(i)] ?? ''}"`).replace(/\s+/g, ' ').trim();
  let lastTargets: string[] = [];
  const clauses = unq.split(/[,;\n]|\.(?=\s|$)|\s(?:và|va|rồi|roi|sau đó|sau do|then|and)\s/i).map((x) => x.trim()).filter(Boolean);
  for (const cl of clauses) {
    const cn = norm(cl);
    const qs = Array.from(cl.matchAll(/⟨q(\d+)⟩/g)).map((m) => quoted[Number(m[1])]).filter(Boolean);
    let kinds = EFFECT_RULES.filter(([, re]) => re.test(cn)).map(([k]) => k);
    if (/\bnhap nhay\b/.test(cn)) kinds = kinds.filter((k) => k !== 'pop'); // "nhấp nháy" = khung sáng, không phải nảy
    const wantsEmph = /(nhan manh|nhan giong|quan trong|noi bat)/.test(cn);
    if (kinds.length === 0 && (wantsEmph || qs.length) && isImage) kinds.push('highlight');
    const pos = boxFromPosition(cn);
    const noun = qs.length ? '' : (namedTarget(cl) || nounAfterEffect(cl)); // [SỬA] "chữ X" / tên vật, giữ nguyên chữ gốc
    let targets = qs.length ? qs : noun ? [noun] : [];
    // [MỚI] "…phát sáng và chữ to hơn" → vế sau nói "chữ" không kèm tên → dùng lại thứ vừa nhắc ở vế trước
    if (!targets.length && kinds.length && /\b(chu|no|do)\b/.test(cn) && lastTargets.length) targets = lastTargets;
    if (targets.length) lastTargets = targets;
    // [MỚI] vế câu không hiểu / chưa làm được → báo lại đúng nguyên văn
    const unsup = UNSUPPORTED.find(([re]) => re.test(cn));
    if (unsup && kinds.length === 0) { unsupported.push(`${restore(cl)} (${unsup[1]})`); continue; }
    const timeLike = !isImage && (/\d/.test(cn) && /(giay|\d\s*s\b|:|-|den|toi|dau|cuoi|doan)/.test(cn));
    const known = kinds.length > 0 || qs.length > 0 || wantsEmph || timeLike || FILLER.test(cn);
    if (!known) unclear.push(restore(cl));
    for (const k of kinds) {
      if (k === 'reveal' || k === 'kenburns') { dir.effects.push({ kind: k }); continue; }
      if (targets.length) targets.forEach((tg) => dir.effects.push({ kind: k, target: tg, word: tg, box: pos, approx: !!pos }));
      else dir.effects.push({ kind: k, box: pos, approx: !!pos });
    }
  }
  dir.emphasis = Array.from(new Set([...quoted, ...dir.effects.map((e) => e.target || '').filter(Boolean)])); // [SỬA] cả tên chữ không có ngoặc

  // 4) Cần AI khi: không hiểu được gì, hoặc phải tìm vị trí thứ cần nhấn trên hình
  const understood = dir.keep.length + dir.cut.length + dir.effects.length + dir.emphasis.length > 0
    || /\b(khop|vua|theo)\s*(voi\s*)?giong\b|\btu dong\b/.test(n);
  dir.unclear = unclear;
  dir.unsupported = unsupported;
  dir.needsAI = !understood || unclear.length > 0 || dir.effects.some((e) => e.target && !e.box); // [SỬA] còn vế chưa hiểu → nhờ AI
  return dir;
}

/** [MỚI] Câu đệm / yêu cầu mặc định — coi như đã hiểu */
const FILLER = /\b(ghep phan con lai|ghep lai|phan con lai|khop (voi )?giong|vua giong|theo giong|tu dong|binh thuong|nhu cu|giu nguyen)\b/;

/** [MỚI] Việc công cụ hiểu nhưng CHƯA làm được — báo rõ để người dùng biết */
const UNSUPPORTED: [RegExp, string][] = [
  [/\b(doi mau|mau nen|to mau|loc mau|filter|den trang|sepia)\b/, 'chưa hỗ trợ đổi màu'],
  [/\b(xoay|lat nguoc|lat ngang|lat doc)\b/, 'chưa hỗ trợ xoay/lật'],
  [/\b(them chu|chen chu|viet chu|them dong chu|them logo|chen logo|watermark)\b/, 'chưa hỗ trợ chèn chữ/logo mới'],
  [/\b(doi font|font chu|co chu phu de)\b/, 'chưa hỗ trợ đổi phông chữ'],
  [/\b(am thanh|tieng dong|tieng|hieu ung am|nhac)\b/, 'âm thanh chỉnh ở mục nhạc nền / voice'],
  [/\b(lam mo|blur|lam nhoe)\b/, 'chưa hỗ trợ làm mờ một vùng'],
  [/\b(tua nhanh|nhanh gap|tang toc)\b/, 'tốc độ video tự khớp theo giọng đọc'],
];

/**
 * [MỚI] Cảnh báo cho người dùng: phần chưa hiểu, chưa làm được, không tìm thấy trên hình,
 * từ cần nhấn không có trong lời thoại (hiệu ứng sẽ chạy theo thứ tự thay vì đúng lúc nói).
 */
export function directiveWarnings(dir: SceneDirective | undefined, sceneText: string, isVN: boolean): string[] {
  if (!dir || !dir.srcText) return [];
  const w: string[] = [];
  if (dir.unclear?.length) w.push((isVN ? 'Chưa hiểu: ' : 'Not understood: ') + dir.unclear.map((x) => `«${x}»`).join(', '));
  if (dir.unsupported?.length) w.push((isVN ? 'Chưa làm được: ' : 'Not supported: ') + dir.unsupported.map((x) => `«${x}»`).join(', '));
  if (dir.byAI) {
    const lost = dir.effects.filter((e) => e.target && !e.box).map((e) => e.target!);
    if (lost.length) w.push((isVN ? 'Không tìm thấy trên hình: ' : 'Not found in image: ') + lost.map((x) => `«${x}»`).join(', ') + (isVN ? ' → dùng khối tự nhận diện' : ''));
  }
  const nt = norm(sceneText).replace(/[^\p{L}\p{N} ]/gu, '');
  if (nt.trim()) {
    const miss = Array.from(new Set(dir.effects.map((e) => e.word || '').filter(Boolean)))
      .filter((x) => !nt.includes(norm(x).replace(/[^\p{L}\p{N} ]/gu, '')));
    if (miss.length) w.push((isVN ? 'Lời thoại không nhắc ' : 'Narration does not mention ') + miss.map((x) => `«${x}»`).join(', ') + (isVN ? ' → hiệu ứng chạy theo thứ tự, không đúng lúc nói' : ''));
  }
  return w;
}

/* ─────────── Đoạn video cuối cùng ─────────── */

function resolveT(v: number, dur: number): number {
  if (v >= END) return dur;
  return v < 0 ? Math.max(0, dur + v) : Math.min(v, dur);
}

/** [MỚI] Từ mô tả → các đoạn video được dùng (giây trong file gốc, theo thứ tự thời gian) */
export function segmentsFromDirective(dir: SceneDirective | undefined, dur: number): [number, number][] {
  if (!dur || dur <= 0) return [];
  let segs: [number, number][] = dir && dir.keep.length
    ? dir.keep.map((r) => [resolveT(r.start, dur), resolveT(r.end, dur)] as [number, number])
    : [[0, dur]];
  segs = segs.filter(([a, b]) => b - a > 0.05).sort((x, y) => x[0] - y[0]);
  // gộp đoạn chồng nhau
  const merged: [number, number][] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  // trừ các đoạn bỏ
  let out = merged;
  for (const c of dir?.cut ?? []) {
    const c0 = resolveT(c.start, dur);
    const c1 = resolveT(c.end, dur);
    if (c1 <= c0) continue;
    const next: [number, number][] = [];
    for (const [a, b] of out) {
      if (c1 <= a || c0 >= b) { next.push([a, b]); continue; }
      if (c0 > a) next.push([a, c0]);
      if (c1 < b) next.push([c1, b]);
    }
    out = next;
  }
  out = out.filter(([a, b]) => b - a > 0.1);
  return out.length ? out : [[0, dur]];
}

export const segmentsTotal = (segs: [number, number][]) => segs.reduce((a, [x, y]) => a + (y - x), 0);

/* ─────────── Dòng "Công cụ hiểu là: ..." ─────────── */

const fmt = (v: number) => {
  const m = Math.floor(v / 60);
  const s = v - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(s % 1 ? 1 : 0)}`;
};
const fmtR = (r: TimeRange) =>
  r.start < 0 ? `${-r.start}s cuối` : r.end >= END ? `${fmt(r.start)}→hết` : `${fmt(r.start)}–${fmt(r.end)}`;

export const EFFECT_LABEL: Record<EffectKind, { VN: string; EN: string }> = {
  zoom: { VN: 'Phóng to', EN: 'Zoom' },
  highlight: { VN: 'Khung sáng', EN: 'Highlight' },
  spotlight: { VN: 'Làm tối xung quanh', EN: 'Spotlight' },
  underline: { VN: 'Gạch chân', EN: 'Underline' },
  reveal: { VN: 'Hiện lần lượt', EN: 'Reveal' },
  kenburns: { VN: 'Chuyển động chậm', EN: 'Slow motion pan' },
  pop: { VN: 'Nảy nhấn nhá', EN: 'Pop / bounce' },
};

/** [MỚI] Mô tả lại bằng lời ngắn để người dùng kiểm tra công cụ hiểu đúng chưa */
export function describeDirective(dir: SceneDirective | undefined, dur: number, isImage: boolean, isVN: boolean): string {
  if (!dir || !dir.srcText) return '';
  const parts: string[] = [];
  if (!isImage) {
    if (dir.keep.length) parts.push((isVN ? 'Giữ ' : 'Keep ') + dir.keep.map(fmtR).join(' + '));
    if (dir.cut.length) parts.push((isVN ? 'Bỏ ' : 'Cut ') + dir.cut.map(fmtR).join(' + '));
    if (dur > 0 && dir.keep.length && dir.keep.every((r) => resolveT(r.start, dur) >= dur - 0.05)) {
      parts.push(isVN ? `⚠ đoạn giữ nằm ngoài độ dài video (${fmt(dur)})` : `⚠ kept range is beyond video length (${fmt(dur)})`);
    } else if (dur > 0 && (dir.keep.length || dir.cut.length)) {
      const segs = segmentsFromDirective(dir, dur);
      parts.push((isVN ? '→ dùng ' : '→ uses ') + segs.map(([a, b]) => `${fmt(a)}–${fmt(b)}`).join(', ') + ` (${segmentsTotal(segs).toFixed(1)}s)`);
    }
  }
  dir.effects.forEach((e) => {
    const lb = EFFECT_LABEL[e.kind][isVN ? 'VN' : 'EN'];
    const tg = e.target ? ` "${e.target}"` : e.box ? (isVN ? ' (vùng đã chọn)' : ' (area)') : '';
    const when = e.word ? (isVN ? ' lúc giọng nói tới' : ' when spoken') : '';
    parts.push(lb + tg + when);
  });
  if (dir.emphasis.length) parts.push((isVN ? 'Nhấn giọng + tô màu phụ đề: ' : 'Emphasis: ') + dir.emphasis.map((x) => `"${x}"`).join(', '));
  if (dir.needsAI) parts.push(isVN ? '⏳ AI sẽ xem hình để hiểu thêm' : '⏳ AI will refine');
  // [MỚI] báo rõ khi AI không chạy được
  if (dir.aiUnavailable) parts.push(isVN
    ? (parts.length ? '⚠ chưa có API key Gemini: vị trí lấy theo khối tự nhận diện trên ảnh' : '⚠ Chưa hiểu – cần API key Gemini để AI hiểu câu này, hoặc dùng từ: phóng to, khung sáng, làm tối xung quanh, gạch chân, hiện lần lượt, nảy + chữ "…"')
    : '⚠ no Gemini API key');
  if (!isImage && !dir.needsAI) parts.push(isVN ? 'tự khớp giọng đọc (dài → cắt, ngắn → chạy chậm)' : 'auto-fit to voice');
  if (!parts.length) return isVN ? 'Chưa hiểu mô tả' : 'Not understood';
  return (dir.byAI ? '🤖 ' : '') + parts.join(' · ');
}

/* ─────────── AI hiểu mô tả khó + tìm vị trí trên hình (1 lần gọi cho mọi cảnh) ─────────── */

export interface DirectiveAIItem {
  /** số thứ tự cảnh (1-based) để hiển thị */
  sceneNo: number;
  text: string;
  isImage: boolean;
  duration: number;
  frames: string[];
  ruled: SceneDirective;
}

type AIOut = {
  scene?: number;
  keep?: [number, number][];
  cut?: [number, number][];
  effects?: { kind?: string; box?: number[]; target?: string; word?: string }[];
  emphasis?: string[];
  unclear?: string[];
  unsupported?: string[];
};

const toBox = (b?: number[]): Box | undefined => {
  if (!Array.isArray(b) || b.length !== 4) return undefined;
  const [ymin, xmin, ymax, xmax] = b.map((v) => Math.max(0, Math.min(1000, Number(v) || 0)) / 1000);
  if (xmax - xmin < 0.01 || ymax - ymin < 0.01) return undefined;
  return { x: xmin, y: ymin, w: xmax - xmin, h: ymax - ymin };
};

/** [MỚI] Gửi các cảnh cần hiểu thêm cho AI trong 1 lần gọi; trả về mô tả đã hiểu theo đúng thứ tự items */
export async function resolveDirectivesAI(items: DirectiveAIItem[], keys: string[]): Promise<SceneDirective[]> {
  if (items.length === 0) return [];
  const list = items.map((it) =>
    `CẢNH ${it.sceneNo} (${it.isImage ? 'ảnh' : `video dài ${it.duration.toFixed(1)} giây`}): "${it.text}"`).join('\n');
  const prompt =
    `Bạn là trợ lý dựng phim. Phía trên là hình của các cảnh. Người dùng viết mô tả dựng cho từng cảnh:\n${list}\n\n` +
    `Hãy hiểu mô tả (viết kiểu gì cũng phải hiểu, kể cả viết tắt/sai chính tả như "45d" = 45 giây) và trả về DUY NHẤT mảng JSON, mỗi phần tử:\n` +
    `{"scene": số cảnh, "keep": [[giây bắt đầu, giây kết thúc], ...] (đoạn video GIỮ LẠI, rỗng nếu không nói), ` +
    `"cut": [[bắt đầu, kết thúc], ...] (đoạn video BỎ ĐI), ` +
    `"effects": [{"kind": "zoom|highlight|spotlight|underline|reveal|kenburns|pop", "box": [ymin, xmin, ymax, xmax] (toạ độ 0-1000 trên hình, của thứ cần nhấn; bỏ trống nếu không có), "target": "tên thứ cần nhấn", "word": "từ trong lời đọc để hiệu ứng chạy đúng lúc"}], ` +
    `"emphasis": ["các từ/cụm cần nhấn giọng và tô màu phụ đề"], ` +
    `"unclear": ["phần mô tả bạn KHÔNG hiểu (chép nguyên văn)"], ` +
    `"unsupported": ["phần hiểu nhưng công cụ KHÔNG làm được — công cụ chỉ có: giữ/bỏ đoạn video, zoom, highlight, spotlight, underline, reveal, kenburns, pop, nhấn mạnh chữ"]}\n` +
    `Nghĩa hiệu ứng: zoom=phóng to vào vùng; highlight=khung sáng/đóng khung; spotlight=làm tối xung quanh; underline=gạch chân; reveal=hiện lần lượt từng ô; kenburns=chuyển động chậm cả hình; pop=nảy/nhảy nhấn nhá vào thứ cần nhấn. ` +
    `"N giây cuối" của video dài D thì ghi [D-N, D]. Không thêm lời giải thích.`;
  const raw = await callVision([...buildSceneParts(items.map((i) => i.frames), items.map((i) => i.sceneNo)), { text: prompt }], keys);
  const arr = parseJson<AIOut[]>(raw);
  if (!Array.isArray(arr)) throw new Error('AI trả về sai định dạng mô tả cảnh');

  return items.map((it, k) => {
    const o = arr.find((x) => Number(x.scene) === it.sceneNo) ?? arr[k];
    if (!o) return { ...it.ruled, needsAI: false };
    const rg = (v?: [number, number][]) => (Array.isArray(v) ? v : [])
      .map((p) => ({ start: Number(p?.[0]) || 0, end: Number(p?.[1]) || 0 }))
      .filter((r) => r.end > r.start);
    const keep = it.isImage ? [] : rg(o.keep);
    const cut = it.isImage ? [] : rg(o.cut);
    const effects: SceneEffect[] = (Array.isArray(o.effects) ? o.effects : [])
      .filter((e) => EFFECT_KINDS.includes(e.kind as EffectKind))
      .map((e) => ({ kind: e.kind as EffectKind, box: toBox(e.box), target: e.target || undefined, word: e.word || e.target || undefined }));
    const emphasis = (Array.isArray(o.emphasis) ? o.emphasis : []).map(String).filter(Boolean);
    return {
      srcText: it.text,
      // AI không nói gì về phần nào thì giữ kết quả của luật cho phần đó
      keep: keep.length || cut.length ? keep : it.ruled.keep,
      cut: keep.length || cut.length ? cut : it.ruled.cut,
      effects: effects.length ? effects : it.ruled.effects,
      emphasis: emphasis.length ? emphasis : it.ruled.emphasis,
      needsAI: false,
      byAI: true,
      // [MỚI] AI báo phần chưa hiểu / chưa làm được
      unclear: (Array.isArray(o.unclear) ? o.unclear : []).map(String).filter(Boolean),
      unsupported: [...(it.ruled.unsupported ?? []), ...(Array.isArray(o.unsupported) ? o.unsupported : []).map(String).filter(Boolean)],
    };
  });
}
