/**
 * Video Render Engine & Scene Planning Service for AutoVideoCreator & FiveStepVideoCreator.
 * Dựng phim bằng Canvas + Web Audio ngay trên trình duyệt:
 *  - Cảnh là VIDEO hoặc ẢNH (slide, infographic...) - ảnh có hiệu ứng từng khối xuất hiện
 *  - Giao diện trình chiếu chuyên nghiệp (nền gradient, khung bo góc, chuyển cảnh mượt)
 *  - Voice dài 1 file: cắt tuần tự theo số giây từng cảnh, phần dư cuối bỏ
 *  - Phụ đề chạy theo đúng lời đọc (cue ngắn, theo thời gian thực của file voice)
 *  - Nhạc nền: mặc định êm, không nhảy âm lượng đột ngột (fade vào / fade ra)
 */
import { cuesFromText, findCue, isMarkerAt, type SubtitleCue } from './subtitleCues';
import { computeLayout, drawSlide, type TextSlideSpec, type SlideLayout, type SlidePhotoRef } from './slideRender';
import { detectSlideRegions, type SlideRegion } from './slideAnalyzer';
// [MỚI] hiệu ứng theo mô tả dựng cảnh / chọn tay / hiệu ứng chung
import { norm, type Box, type EffectKind, type SceneEffect } from './sceneDirective';

export type EngineKind = 'browser' | 'server';

export interface RenderResult {
  url: string;
  duration: number;
  sizeMB: number;
  width: number;
  height: number;
  extension: string;
  /** [MỚI] ảnh bìa (JPEG) chụp từ cảnh mở đầu */
  thumbnailUrl?: string;
  warnings: string[];
  dispose: () => void;
  downloadUrl: (filename: string) => string;
}

export class RenderCancelled extends Error {
  constructor(message = 'Movie render cancelled by user') {
    super(message);
    this.name = 'RenderCancelled';
  }
}

export interface RenderSceneInput {
  id: string;
  videoUrl: string;
  videoDuration?: number;
  videoWidth?: number;
  videoHeight?: number;
  /** true = cảnh là ẢNH (slide, infographic...). videoUrl khi đó là link ảnh. */
  isImage?: boolean;
  voiceUrl?: string;
  voiceDuration?: number;
  subtitleText?: string;
  /** Phụ đề đã có mốc thời gian (giây, tính từ đầu cảnh) - ưu tiên hơn subtitleText */
  subtitleCues?: SubtitleCue[];
  /** [MỚI] Thời lượng cảnh bắt buộc (giây) — dùng khi khớp cảnh theo lời của voice dài 1 file */
  targetDuration?: number;
  /** [MỚI] Đoạn video được dùng (giây trong file gốc), theo "Mô tả dựng cảnh"; trống = cả video */
  keepSegments?: [number, number][];
  /** [MỚI] Hiệu ứng riêng của cảnh: undefined = theo hiệu ứng chung, [] = không hiệu ứng */
  effects?: SceneEffect[];
  /** [MỚI] Từ/cụm cần nhấn mạnh: tô màu trong phụ đề */
  emphasis?: string[];
  /** [MỚI] Ảnh: số giây do người dùng chỉnh tay */
  manualSeconds?: boolean;
  /** Slide chữ: vẽ trực tiếp ở độ phân giải video (nét), có hiệu ứng đánh máy / hiện từng ý */
  textSlide?: TextSlideSpec;
}

export interface RenderOptions {
  scenes: RenderSceneInput[];
  settings: {
    aspectRatio: 'original' | '16:9' | '9:16' | '1:1';
    fitMode: 'blur' | 'cover' | 'contain';
    quality: 'original' | '1080p' | '720p' | '4k';
    enableSubtitles: boolean;
    subtitleStyle: 'yellow_stroke' | 'white_box';
    enableBgm: boolean;
    bgmVolume: number;
    /** 'presentation' (mặc định): nền gradient, khung bo góc, chuyển cảnh mượt. 'classic': kiểu cũ nền đen. */
    style?: 'presentation' | 'classic';
    /** Bật/tắt hiệu ứng chuyển cảnh (mặc định: bật) */
    transitions?: boolean;
    /** Ảnh slide: từng khối (thẻ, tiêu đề, số liệu...) lần lượt xuất hiện (mặc định: bật) */
    revealObjects?: boolean;
    /** Slide chữ: bật hiệu ứng đánh máy (tắt = chữ hiện dần từng ý, mặc định: bật) */
    typewriter?: boolean;
    /** Tăng nét tối ưu: chuẩn bị ảnh đúng cỡ khung + làm nét chữ nhỏ + tăng chất lượng nén */
    sharpText?: boolean;
    /** [MỚI] Hiệu ứng chung cho cảnh không có hiệu ứng riêng ('auto' = như cũ: ảnh slide hiện lần lượt theo revealObjects) */
    imageEffect?: 'auto' | 'none' | EffectKind;
    /** [MỚI] Tô màu từ cần nhấn mạnh trong phụ đề (mặc định: bật) */
    emphasisColor?: boolean;
    /** [MỚI] Chế độ Mạng xã hội 9:16: ảnh đúng tỉ lệ tràn màn hình, phụ đề ngắn, giữ cảnh cuối thêm 1.5s, ẩn thanh tiến trình */
    socialMode?: boolean;
    /** [MỚI] Vị trí phụ đề: % chiều cao tính từ trên xuống (tâm khối chữ). Bỏ trống = sát đáy như cũ */
    subtitleY?: number;
    /** [MỚI] Phụ đề sáng dần từng từ theo giọng đọc (karaoke) */
    karaoke?: boolean;
    /** [MỚI] Mức phóng clip video để lấp khung khi lệch tỉ lệ (chế độ Nền mờ / Viền đen): 0 = giữ đủ hình như cũ, 1 = tràn khung (cắt phần thừa) */
    fillAmount?: number;
    /** [MỚI] Vị trí giữ lại khi phải cắt phần thừa: 0 = trái/trên, 0.5 = giữa (mặc định), 1 = phải/dưới */
    focusX?: number;
    /** [MỚI] Giữ tiếng gốc của clip video (mặc định: tắt như cũ) */
    keepOriginalAudio?: boolean;
    /** [MỚI] Âm lượng tiếng gốc 0..1 (mặc định 1 = nguyên bản) */
    originalVolume?: number;
    /** [MỚI] Ghép 2 video song song: clip chính ở trên/giữa/dưới, phần trống chạy video thứ 2 (cần options.secondaryVideo) */
    splitScreen?: boolean;
    splitMainPos?: 'top' | 'middle' | 'bottom';
  };
  /** [MỚI] Video thứ 2 chạy song song (lặp lại, tắt tiếng) */
  secondaryVideo?: { url: string; name?: string };
  /** Tiêu đề phim: nếu có sẽ hiện thẻ mở đầu 2.5 giây */
  title?: string;
  bgm?: {
    url: string;
    name: string;
  };
  /**
   * Voice dài 1 file cho cả phim. Phát liền mạch từ giây startAt; mỗi cảnh dài đúng số giây đặt cho cảnh,
   * phần voice còn dư ở cuối bị bỏ.
   */
  masterVoice?: {
    url: string;
    startAt?: number;
  };
  /** Phụ đề có mốc thời gian theo FILE masterVoice (giây tính từ đầu file) */
  subtitleCues?: SubtitleCue[];
}

export interface RenderCallbacks {
  signal?: AbortSignal;
  onProgress?: (percent: number, message: string) => void;
}

/**
 * Parses scene number from filename (e.g. "scene_001.mp4", "clip-02.mp4", "cảnh 3.mp4", "01_intro.mp4")
 */
export function parseSceneNumber(filename: string): number | null {
  if (!filename) return null;
  const clean = filename.trim().toLowerCase();

  // 1. Prefix match: scene_1, cảnh 2, clip-03, part 4, ep5
  const prefixMatch = clean.match(/(?:scene|slide|c[aả]nh|clip|part|tap|ep|p)[_\-\s]*(\d+)/i);
  if (prefixMatch && prefixMatch[1]) {
    return parseInt(prefixMatch[1], 10);
  }

  // 2. Word boundary number match: "01_intro.mp4" or "video 2.mp4"
  const numberMatch = clean.match(/\b(\d+)\b/) || clean.match(/(\d+)/);
  if (numberMatch && numberMatch[1]) {
    return parseInt(numberMatch[1], 10);
  }

  return null;
}

/**
 * Estimates total duration of scenes in seconds considering video duration and voiceover padded time.
 * masterVoice = true: mỗi cảnh dài đúng số giây đã đặt (không phụ thuộc voice từng cảnh).
 */
export function estimateTotalDuration(
  scenes: { videoDuration?: number; voiceDuration?: number; targetDuration?: number }[],
  opts?: { masterVoice?: boolean }
): number {
  if (!scenes || scenes.length === 0) return 0;
  return scenes.reduce((acc, scene) => {
    if (scene.targetDuration && scene.targetDuration > 0) return acc + scene.targetDuration; // [SỬA] cảnh khớp theo lời
    const vDur = scene.videoDuration || 0;
    const voiceDur = opts?.masterVoice ? 0 : scene.voiceDuration || 0;
    if (voiceDur > 0) {
      return acc + Math.max(vDur || 5, voiceDur + 0.3);
    }
    return acc + (vDur || 5);
  }, 0);
}

/**
 * Detects whether a local high-performance rendering server is running,
 * falling back gracefully to 'browser' Canvas MediaRecorder mode.
 */
export async function detectEngine(): Promise<{ kind: EngineKind }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const res = await fetch('http://localhost:8080/health', {
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (res.ok) {
      return { kind: 'server' };
    }
  } catch {
    // Expected when server is not running locally
  }
  return { kind: 'browser' };
}

/* ───────────────────────── Giao diện trình chiếu ───────────────────────── */

const PALETTES: [string, string, string][] = [
  ['#0b1020', '#1e1b4b', '#818cf8'],
  ['#04201f', '#0f172a', '#2dd4bf'],
  ['#1a1410', '#2e1065', '#fbbf24'],
  ['#0b1226', '#3b0764', '#f472b6'],
];
const FONT_STACK = '"Outfit", "Inter", "Segoe UI", Roboto, Arial, sans-serif';
const INTRO_SECONDS = 2.5;
const TRANSITION_SECONDS = 0.6;
const OUTRO_FADE_SECONDS = 0.6;
const FRAME_MS = 1000 / 30;

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function roundedRectPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

function wrapLines(c: CanvasRenderingContext2D, text: string, maxW: number, maxLines = 3): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (c.measureText(test).width > maxW && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  // ký hiệu đầu dòng (I. / 2. / a)) không được nằm cuối dòng: đẩy xuống đầu dòng kế tiếp
  for (let i = 0; i < lines.length - 1; i++) {
    const w = lines[i].split(' ');
    if (w.length >= 1 && isMarkerAt(w, w.length - 1)) {
      const mk = w.pop() as string;
      lines[i] = w.join(' ');
      lines[i + 1] = `${mk} ${lines[i + 1]}`;
      if (!lines[i]) { lines.splice(i, 1); i--; }
    }
  }
  return lines.slice(0, maxLines);
}

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not initialize Canvas 2D context');
  return { canvas, ctx };
}

function drawGradientBackdrop(c: CanvasRenderingContext2D, w: number, h: number, pal: [string, string, string]) {
  const g = c.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, pal[0]);
  g.addColorStop(1, pal[1]);
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);

  const glow = c.createRadialGradient(w * 0.82, h * 0.15, 0, w * 0.82, h * 0.15, Math.max(w, h) * 0.6);
  glow.addColorStop(0, `${pal[2]}33`);
  glow.addColorStop(1, `${pal[2]}00`);
  c.fillStyle = glow;
  c.fillRect(0, 0, w, h);
}

function drawVignette(c: CanvasRenderingContext2D, w: number, h: number) {
  const v = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.max(w, h) * 0.75);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.38)');
  c.fillStyle = v;
  c.fillRect(0, 0, w, h);
}

const wrapCache = new Map<string, string[]>();

/* ───────────── [MỚI] Hiệu ứng cảnh: kế hoạch theo thời gian + vẽ ───────────── */

interface EffectPlan { kind: EffectKind; box: Box; t0: number; t1: number }
const FULL: Box = { x: 0, y: 0, w: 1, h: 1 };
const isFull = (b: Box) => b.x === 0 && b.y === 0 && b.w === 1 && b.h === 1;
const lerpBox = (a: Box, b: Box, k: number): Box => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k });

/** [MỚI] Vùng phóng: nới rộng quanh box, giữ đúng tỉ lệ khung gốc, không vượt mép */
function zoomTarget(b: Box): Box {
  const side = Math.min(0.8, Math.max(0.35, Math.max(b.w, b.h) * 1.3)); // [SỬA] luôn phóng thấy rõ (≤80% khung)
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return { x: Math.max(0, Math.min(1 - side, cx - side / 2)), y: Math.max(0, Math.min(1 - side, cy - side / 2)), w: side, h: side };
}

/** [MỚI] Thời điểm giọng đọc nói tới `word` (giây trong cảnh), -1 nếu không thấy */
function findWordTime(cues: SubtitleCue[], word: string, after: number): number {
  const w = norm(word).replace(/[^\p{L}\p{N} ]/gu, '').trim();
  if (!w) return -1;
  const tries = [w, w.split(' ').slice(0, 2).join(' ')];
  for (const t of tries) {
    for (const c of cues) {
      if (c.end <= after) continue;
      const txt = norm(c.text).replace(/[^\p{L}\p{N} ]/gu, '');
      const i = txt.indexOf(t);
      if (i >= 0) return Math.max(after, c.start + (i / Math.max(1, txt.length)) * (c.end - c.start));
    }
  }
  return -1;
}

/**
 * [MỚI] Lập lịch hiệu ứng của 1 cảnh:
 *  - có từ khoá → chạy đúng lúc giọng nói tới; không có → rải đều theo thời lượng cảnh
 *  - không có vùng → lần lượt từng khối nhận diện trên ảnh (tối đa 6), không có khối → giữa khung
 */
function buildEffectPlan(fx: SceneEffect[], regionsIn: SlideRegion[], cues: SubtitleCue[], duration: number): EffectPlan[] {
  // [SỬA] bỏ khối sát đáy ảnh (thường là ô chú thích có sẵn) để hiệu ứng không đè lên vùng phụ đề
  const regions = regionsIn.filter((r) => r.y + r.h / 2 < 0.85);
  const items: { kind: EffectKind; box: Box; word?: string }[] = [];
  for (const e of fx) {
    if (e.kind === 'reveal') continue;
    if (e.kind === 'kenburns') { items.push({ kind: e.kind, box: FULL }); continue; }
    if (e.box && e.approx && regions.length) {
      // [MỚI] vị trí ước lượng (trái/phải/trên/dưới) → bám vào khối nhận diện lớn nhất trong vùng đó
      const inBox = regions.filter((r) => {
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        return cx >= e.box!.x && cx <= e.box!.x + e.box!.w && cy >= e.box!.y && cy <= e.box!.y + e.box!.h;
      }).sort((p, q) => q.w * q.h - p.w * p.h);
      const r = inBox[0];
      items.push({ kind: e.kind, box: r ? { x: r.x, y: r.y, w: r.w, h: r.h } : e.box, word: e.word });
    } else if (e.box) items.push({ kind: e.kind, box: e.box, word: e.word });
    else if (regions.length) regions.slice(0, 6).forEach((r) => items.push({ kind: e.kind, box: { x: r.x, y: r.y, w: r.w, h: r.h } })); // (regions đã bỏ khối chú thích sát đáy)
    else items.push({ kind: e.kind, box: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }, word: e.word });
  }
  const timed = items.filter((i) => i.kind !== 'kenburns');
  const span = Math.max(1, duration * 0.85 - 0.4);
  let after = 0;
  const plan: EffectPlan[] = timed.map((it, k) => {
    let t0 = it.word ? findWordTime(cues, it.word, after) : -1;
    if (t0 < 0) t0 = 0.4 + (k * span) / Math.max(1, timed.length);
    after = t0;
    return { kind: it.kind, box: it.box, t0, t1: duration };
  }).sort((a, b) => a.t0 - b.t0);
  plan.forEach((p, k) => {
    const nx = plan.slice(k + 1).find((q) => q.t0 > p.t0 + 0.6);
    if (nx) p.t1 = Math.max(p.t0 + 1.2, nx.t0);
    // [SỬA] phóng to tự thu về sau ~2.4s (không giữ tới hết cảnh làm mất phần chữ còn lại)
    if (p.kind === 'zoom') {
      p.t0 = Math.max(0.2, Math.min(p.t0, duration - 2.9));
      p.t1 = Math.min(p.t1, p.t0 + 2.4);
    }
  });
  if (items.some((i) => i.kind === 'kenburns')) plan.unshift({ kind: 'kenburns', box: FULL, t0: 0, t1: duration });
  return plan;
}

/** [MỚI] Vùng hình đang hiển thị (phóng to / chuyển động chậm) tại giây `el` */
function viewAt(plan: EffectPlan[], el: number, duration: number): Box {
  let v = FULL;
  for (const p of plan) {
    if (el < p.t0) continue;
    if (p.kind === 'kenburns') {
      const k = easeInOut(clamp01(el / Math.max(0.1, duration)));
      v = { x: 0.035 * k, y: 0.03 * k, w: 1 - 0.07 * k, h: 1 - 0.07 * k };
    } else if (p.kind === 'pop') {
      // [MỚI] nảy: phóng nhẹ vào thứ cần nhấn 3 nhịp rồi về, trong ~1.5s
      const e = el - p.t0;
      if (e <= 1.5) v = lerpBox(v, zoomTarget(p.box), 0.35 * Math.abs(Math.sin((Math.PI * e) / 0.5)) * (1 - e / 1.5));
    } else if (p.kind === 'zoom') {
      const kin = easeInOut(clamp01((el - p.t0) / 0.8));
      const kout = p.t1 < duration - 0.05 ? easeInOut(clamp01((el - (p.t1 - 0.6)) / 0.6)) : 0;
      if (el <= p.t1 + 0.01) v = lerpBox(v, zoomTarget(p.box), kin * (1 - kout));
    }
  }
  return v;
}

/** [MỚI] Khung sáng / làm tối xung quanh / gạch chân — toạ độ theo vùng đang hiển thị */
function drawOverlays(c: CanvasRenderingContext2D, plan: EffectPlan[], view: Box, dx: number, dy: number, dw: number, dh: number, el: number, H: number, band?: [number, number]) {
  for (const p of plan) {
    if (p.kind !== 'highlight' && p.kind !== 'spotlight' && p.kind !== 'underline') continue;
    if (el < p.t0 || el > p.t1) continue;
    const a = clamp01((el - p.t0) / 0.3) * clamp01((p.t1 - el) / 0.3);
    if (a <= 0) continue;
    const rx = dx + ((p.box.x - view.x) / view.w) * dw;
    const ry = dy + ((p.box.y - view.y) / view.h) * dh;
    const rw = (p.box.w / view.w) * dw;
    let rh = (p.box.h / view.h) * dh;
    const pad = H * 0.008;
    // [MỚI] không vẽ khung hiệu ứng đè lên vùng phụ đề
    if (band && ry < band[1] && ry + rh > band[0]) {
      if (ry + rh / 2 >= band[0]) continue;
      rh = Math.max(0, band[0] - ry - pad * 2);
      if (rh < H * 0.02) continue;
    }
    c.save();
    c.globalAlpha *= a;
    if (p.kind === 'spotlight') {
      c.fillStyle = 'rgba(0,0,0,0.62)';
      c.beginPath();
      c.rect(dx, dy, dw, dh);
      c.rect(rx - pad, ry - pad, rw + pad * 2, rh + pad * 2);
      c.fill('evenodd');
      c.strokeStyle = 'rgba(255,255,255,0.85)';
      c.lineWidth = Math.max(2, H * 0.003);
      c.strokeRect(rx - pad, ry - pad, rw + pad * 2, rh + pad * 2);
    } else if (p.kind === 'highlight') {
      const pulse = 1 + 0.25 * Math.sin(el * 6);
      c.fillStyle = 'rgba(255,230,0,0.10)';
      roundedRectPath(c, rx - pad, ry - pad, rw + pad * 2, rh + pad * 2, H * 0.012);
      c.fill();
      c.shadowColor = '#FFE600';
      c.shadowBlur = H * 0.02 * pulse;
      c.strokeStyle = '#FFE600';
      c.lineWidth = Math.max(3, H * 0.005);
      c.stroke();
    } else {
      const grow = easeOut(clamp01((el - p.t0) / 0.5));
      const y = Math.min(ry + rh + pad, dy + dh - Math.max(4, H * 0.007)); // [SỬA] không vẽ ra ngoài khung
      c.strokeStyle = '#FFE600';
      c.lineCap = 'round';
      c.lineWidth = Math.max(4, H * 0.007);
      c.shadowColor = 'rgba(0,0,0,0.6)';
      c.shadowBlur = H * 0.006;
      c.beginPath();
      c.moveTo(rx, y);
      c.lineTo(rx + rw * grow, y);
      c.stroke();
    }
    c.restore();
  }
}

/** [MỚI] Phụ đề ngắn cho mạng xã hội: chia 1 câu dài thành cụm ≤ maxWords từ, thời gian theo số ký tự */
function chunkCue(cue: SubtitleCue, t: number, maxWords: number): SubtitleCue {
  const words = cue.text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords + 1) return cue;
  const n = Math.ceil(words.length / maxWords);
  const per = Math.ceil(words.length / n);
  const groups: string[] = [];
  for (let i = 0; i < words.length; i += per) groups.push(words.slice(i, i + per).join(' '));
  const total = groups.reduce((a, g) => a + g.length + 4, 0);
  let s0 = cue.start;
  for (const g of groups) {
    const d = ((g.length + 4) / total) * (cue.end - cue.start);
    if (t < s0 + d || g === groups[groups.length - 1]) return { start: s0, end: s0 + d, text: g };
    s0 += d;
  }
  return cue;
}

/** [MỚI] Cắt bớt các đoạn video cho vừa `dur` giây (bỏ phần cuối) */
function trimSegments(segs: [number, number][], dur: number): [number, number][] {
  const out: [number, number][] = [];
  let left = dur;
  for (const [a, b] of segs) {
    if (left <= 0.02) break;
    const len = Math.min(b - a, left);
    out.push([a, a + len]);
    left -= len;
  }
  return out.length ? out : segs.slice(0, 1);
}

/** [MỚI] Đánh dấu các từ thuộc cụm cần nhấn trong 1 dòng phụ đề */
function emphMarks(line: string, emph: string[][]): boolean[] {
  const toks = line.split(' ');
  const nt = toks.map((t) => norm(t).replace(/[^\p{L}\p{N}]/gu, ''));
  const marks = toks.map(() => false);
  for (const ph of emph) {
    if (!ph.length) continue;
    for (let i = 0; i + ph.length <= nt.length; i++) {
      if (ph.every((w, k) => nt[i + k] === w)) for (let k = 0; k < ph.length; k++) marks[i + k] = true;
    }
  }
  return marks;
}

/** [MỚI] Vẽ 1 dòng phụ đề, từ nhấn mạnh đổi màu */
function drawLineEmph(
  c: CanvasRenderingContext2D, ln: string, cx: number, y: number, base: string, hi: string, stroke: boolean, emph: string[][],
  karaoke?: { from: number; spoken: number; upcoming: string } // [MỚI] từ đã đọc = màu chính, từ sắp đọc = màu nhạt
) {
  const marks = emph.length ? emphMarks(ln, emph) : [];
  if (!marks.some(Boolean) && !karaoke) {
    if (stroke) c.strokeText(ln, cx, y);
    c.fillStyle = base;
    c.fillText(ln, cx, y);
    return;
  }
  const toks = ln.split(' ');
  const space = c.measureText(' ').width;
  const ws = toks.map((t) => c.measureText(t).width);
  let x = cx - (ws.reduce((a, b) => a + b, 0) + space * (toks.length - 1)) / 2;
  const align = c.textAlign;
  c.textAlign = 'left';
  toks.forEach((t, i) => {
    if (stroke) c.strokeText(t, x, y);
    const upcoming = karaoke ? karaoke.from + i >= karaoke.spoken : false;
    c.fillStyle = marks[i] ? hi : upcoming ? karaoke!.upcoming : base;
    c.fillText(t, x, y);
    x += ws[i] + space;
  });
  c.textAlign = align;
}

function drawSubtitle(
  c: CanvasRenderingContext2D,
  text: string,
  w: number,
  h: number,
  style: 'yellow_stroke' | 'white_box',
  accent: string,
  alpha: number,
  emphasis: string[] = [], // [SỬA] từ cần nhấn → đổi màu
  opt: { posY?: number; progress?: number; social?: boolean } = {} // [MỚI] vị trí (% chiều cao), karaoke, kiểu MXH
) {
  const emph = emphasis.map((p) => norm(p).split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean));
  const baseFont = Math.max(24, Math.round(Math.min(h * 0.038, w * (opt.social ? 0.068 : 0.06))));
  c.save();
  c.globalAlpha *= alpha;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const getLines = (fs: number): string[] => {
    c.font = `bold ${fs}px ${FONT_STACK}`;
    const key = `${w}|${fs}|${text}`;
    let l = wrapCache.get(key);
    if (!l) {
      l = wrapLines(c, text, w * 0.84, 8);
      if (wrapCache.size > 400) wrapCache.clear();
      wrapCache.set(key, l);
    }
    return l;
  };
  // hiện NGUYÊN câu: nếu dài quá 3 dòng thì thu nhỏ chữ chứ không cắt bớt
  let fontSize = baseFont;
  let lines = getLines(fontSize);
  if (lines.length > 3) {
    fontSize = Math.round(baseFont * 0.78);
    lines = getLines(fontSize);
  }
  c.font = `bold ${fontSize}px ${FONT_STACK}`;
  const lineH = fontSize * 1.3;
  const blockH = lines.length * lineH;
  // [SỬA] vị trí phụ đề do người dùng chọn (giữ trong khung, cách mép ≥4%)
  const baseY = opt.posY !== undefined
    ? Math.max(blockH / 2 + h * 0.04, Math.min(h - blockH / 2 - h * 0.04, (opt.posY / 100) * h))
    : h - Math.round(h * 0.085) - blockH / 2;
  const slide = (1 - alpha) * fontSize * 0.6;
  // [MỚI] karaoke: số từ đã đọc theo tiến độ câu
  const allWords = lines.join(' ').split(' ').filter(Boolean);
  const spoken = opt.progress === undefined ? undefined : Math.ceil(clamp01(opt.progress) * allWords.length);
  const kara = (lineIdx: number, upcoming: string) => {
    if (spoken === undefined) return undefined;
    const from = lines.slice(0, lineIdx).reduce((a, l) => a + l.split(' ').filter(Boolean).length, 0);
    return { from, spoken, upcoming };
  };

  if (style === 'yellow_stroke') {
    c.lineJoin = 'round';
    c.lineWidth = Math.max(4, Math.round(fontSize * 0.16));
    lines.forEach((ln, i) => {
      const y = baseY - blockH / 2 + lineH * (i + 0.5) + slide;
      c.strokeStyle = '#000000';
      drawLineEmph(c, ln, w / 2, y, '#FFE600', '#FF4D6D', true, emph, kara(i, '#FFFFFF'));
    });
  } else {
    const maxLineW = Math.max(...lines.map((l) => c.measureText(l).width));
    const padX = fontSize * 0.9;
    const padY = fontSize * 0.45;
    const boxW = maxLineW + padX * 2;
    const boxH = blockH + padY * 2;
    const bx = (w - boxW) / 2;
    const by = baseY - boxH / 2 + slide;
    c.fillStyle = 'rgba(8, 10, 24, 0.78)';
    roundedRectPath(c, bx, by, boxW, boxH, fontSize * 0.5);
    c.fill();
    c.fillStyle = accent;
    roundedRectPath(c, bx, by + boxH * 0.18, Math.max(4, fontSize * 0.14), boxH * 0.64, 3);
    c.fill();
    lines.forEach((ln, i) => {
      drawLineEmph(c, ln, w / 2, by + padY + lineH * (i + 0.5), '#FFE600', '#FF4D6D', false, emph, kara(i, 'rgba(255,255,255,0.9)'));
    });
  }
  c.restore();
}

/* ───────────────────────── Dựng phim ───────────────────────── */

interface LoadedScene {
  scene: RenderSceneInput;
  isImg: boolean;
  videoEl: HTMLVideoElement;
  imgEl: HTMLImageElement;
  media: HTMLVideoElement | HTMLImageElement;
  /** ảnh đã co về đúng cỡ khung và làm nét (chế độ tăng nét) */
  sharp?: HTMLCanvasElement;
  vW: number;
  vH: number;
  duration: number; // giây
  regions: SlideRegion[];
  cues?: SubtitleCue[]; // cue theo thời gian cảnh (không dùng khi có phụ đề toàn cục)
  voiceEl: HTMLAudioElement | null;
  voiceGain: GainNode | null;
  /** [MỚI] bộ chỉnh âm lượng tiếng gốc của clip (nếu bật giữ tiếng gốc) */
  origGain?: GainNode | null;
  blurBg?: HTMLCanvasElement; // nền mờ dựng sẵn (cảnh ảnh)
  textSlide?: TextSlideSpec;
  photo?: SlidePhotoRef | null;
  layoutCache?: Map<string, SlideLayout>;
  /** [MỚI] đoạn video phát (giây file gốc) + tốc độ để vừa thời lượng cảnh */
  segs: [number, number][];
  rate: number;
  /** [MỚI] lịch hiệu ứng + từ nhấn mạnh */
  plan: EffectPlan[];
  emphasis: string[];
}

/**
 * Renders a complete movie from video / image scenes, voiceovers, subtitles, and background music
 */
export async function renderMovie(
  options: RenderOptions,
  callbacks?: RenderCallbacks
): Promise<RenderResult> {
  const { scenes, bgm, masterVoice } = options;
  // [MỚI] Chế độ Mạng xã hội: luôn 9:16, tối thiểu Full HD 1080×1920
  const settings = options.settings.socialMode
    ? { ...options.settings, aspectRatio: '9:16' as const, quality: options.settings.quality === '4k' ? '4k' as const : '1080p' as const }
    : options.settings;
  const social = !!settings.socialMode;
  // [MỚI] Mức phóng lấp khung (0 = như cũ) và vị trí giữ lại khi cắt
  const fillAmt = typeof settings.fillAmount === 'number' && isFinite(settings.fillAmount) ? Math.min(1, Math.max(0, settings.fillAmount)) : 0;
  const focus = typeof settings.focusX === 'number' && isFinite(settings.focusX) ? Math.min(1, Math.max(0, settings.focusX)) : 0.5;
  // [MỚI] Tiếng gốc của clip + bố cục 2 video (mặc định tắt = như cũ)
  const keepOrigAudio = !!settings.keepOriginalAudio;
  const origVol = typeof settings.originalVolume === 'number' && isFinite(settings.originalVolume) ? Math.min(1, Math.max(0, settings.originalVolume)) : 1;
  const splitOn = !!settings.splitScreen && !!options.secondaryVideo?.url;
  const splitPos = settings.splitMainPos ?? 'top';
  // [MỚI] phụ đề ở sát đáy (kiểu cũ) thì mới chừa chỗ dưới khung hình
  const subsAtBottom = settings.subtitleY === undefined || settings.subtitleY >= 80;
  const { signal, onProgress } = callbacks || {};

  if (signal?.aborted) {
    throw new RenderCancelled();
  }

  if (!scenes || scenes.length === 0) {
    throw new Error('No scenes provided for video rendering');
  }

  onProgress?.(2, 'Initializing browser rendering engine...');

  // ── Độ phân giải đích ──
  let targetW = 1920;
  let targetH = 1080;
  const firstScene = scenes[0];
  const sourceW = firstScene.videoWidth || 1920;
  const sourceH = firstScene.videoHeight || 1080;

  if (settings.aspectRatio === 'original') {
    targetW = sourceW;
    targetH = sourceH;
  } else if (settings.aspectRatio === '16:9') {
    targetW = 1920;
    targetH = 1080;
  } else if (settings.aspectRatio === '9:16') {
    targetW = 1080;
    targetH = 1920;
  } else if (settings.aspectRatio === '1:1') {
    targetW = 1080;
    targetH = 1080;
  }

  if (settings.quality === '720p') {
    const ratio = targetW / targetH;
    if (targetW >= targetH) {
      targetW = 1280;
      targetH = Math.round(1280 / ratio);
    } else {
      targetH = 1280;
      targetW = Math.round(1280 * ratio);
    }
  } else if (settings.quality === '4k') {
    targetW = Math.min(3840, targetW * 2);
    targetH = Math.min(2160, targetH * 2);
  } else if (settings.quality === '1080p' && settings.aspectRatio === 'original') {
    // giữ nguyên tỉ lệ gốc, đưa cạnh dài về đúng Full HD (ảnh nhỏ hơn thì phóng lên để không bị mờ/vỡ khung hình)
    const k = 1920 / Math.max(targetW, targetH);
    targetW = Math.round(targetW * k);
    targetH = Math.round(targetH * k);
  }

  targetW = targetW % 2 === 0 ? targetW : targetW + 1;
  targetH = targetH % 2 === 0 ? targetH : targetH + 1;

  const presentation = (settings.style ?? 'presentation') === 'presentation';
  const useTransitions = presentation && settings.transitions !== false;
  const useReveal = presentation && settings.revealObjects !== false;
  const masterMode = !!masterVoice?.url;
  const globalCues = masterMode && options.subtitleCues && options.subtitleCues.length > 0 ? options.subtitleCues : undefined;

  // ── Canvas chính (không trong suốt = nhẹ hơn) ──
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const mainCtx = canvas.getContext('2d', { alpha: false });
  if (!mainCtx) throw new Error('Could not initialize Canvas 2D context');
  mainCtx.imageSmoothingEnabled = true;
  mainCtx.imageSmoothingQuality = 'high'; // thu/phóng ảnh mịn, chữ nét hơn

  // ── Âm thanh ──
  const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioCtx = new AudioCtxClass();
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
  const audioDest = audioCtx.createMediaStreamDestination();

  // Nhạc nền: âm lượng CỐ ĐỊNH theo thanh chỉnh, vào/ra êm (không đổi đột ngột giữa các cảnh)
  const bgmTarget = Math.max(0, Math.min(1, settings.bgmVolume / 100));
  let bgmAudioEl: HTMLAudioElement | null = null;
  let bgmGainNode: GainNode | null = null;
  if (settings.enableBgm && bgm?.url) {
    bgmAudioEl = new Audio(bgm.url);
    bgmAudioEl.loop = true;
    bgmAudioEl.crossOrigin = 'anonymous';
    const bgmSource = audioCtx.createMediaElementSource(bgmAudioEl);
    bgmGainNode = audioCtx.createGain();
    bgmGainNode.gain.value = 0;
    bgmSource.connect(bgmGainNode);
    bgmGainNode.connect(audioDest);
  }

  // Voice dài 1 file
  let masterEl: HTMLAudioElement | null = null;
  let masterGain: GainNode | null = null;
  if (masterMode && masterVoice) {
    masterEl = new Audio(masterVoice.url);
    masterEl.crossOrigin = 'anonymous';
    masterEl.preload = 'auto';
    const src = audioCtx.createMediaElementSource(masterEl);
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 1.0;
    src.connect(masterGain);
    masterGain.connect(audioDest);
    const el = masterEl;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      el.onloadedmetadata = done;
      el.onerror = done;
      setTimeout(done, 4000);
    });
    try {
      masterEl.currentTime = Math.max(0, masterVoice.startAt || 0);
    } catch {
      // bỏ qua
    }
  }

  // ── Luồng ghi hình: vẽ xong khung nào, yêu cầu ghi khung đó (đều khung, không giật) ──
  let canvasStream = canvas.captureStream(0);
  let vTrack = canvasStream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
  if (!vTrack || typeof vTrack.requestFrame !== 'function') {
    canvasStream.getTracks().forEach((t) => t.stop());
    canvasStream = canvas.captureStream(30);
    vTrack = undefined;
  }
  // Có tiếng thật không? Nếu KHÔNG (slide không voice, không nhạc nền) thì không gắn đường tiếng trống vào video:
  // đường tiếng không có mẫu âm thanh làm bộ ghi chờ mãi và chất đầy bộ nhớ → trình duyệt báo "Ôi, hỏng!".
  const hasAudio = masterMode || !!(settings.enableBgm && bgm?.url) || scenes.some((s) => !!s.voiceUrl)
    || (keepOrigAudio && scenes.some((s) => !s.isImage && !s.textSlide)); // [MỚI] tiếng gốc của clip video
  let silentKeep: ConstantSourceNode | null = null;
  if (hasAudio) {
    // luôn có tín hiệu cực nhỏ (không nghe thấy) để luồng âm thanh chảy đều, không bị đứng khi chưa tới đoạn voice
    try {
      silentKeep = audioCtx.createConstantSource();
      silentKeep.offset.value = 0.0003;
      silentKeep.connect(audioDest);
      silentKeep.start();
    } catch {
      silentKeep = null;
    }
  }
  const combinedStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...(hasAudio ? audioDest.stream.getAudioTracks() : []),
  ]);

  const supportedMimeTypes = hasAudio
    ? [
        'video/mp4;codecs=avc1,mp4a.40.2',
        'video/mp4',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
      ]
    : [
        'video/mp4;codecs=avc1',
        'video/mp4',
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
      ];
  const selectedMimeType = supportedMimeTypes.find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';

  const recordedChunks: Blob[] = [];
  const mediaRecorder = new MediaRecorder(combinedStream, {
    mimeType: selectedMimeType,
    videoBitsPerSecond: Math.round((settings.quality === '4k' ? 32000000 : settings.quality === '720p' ? 6000000 : 16000000) * (settings.sharpText !== false ? 1.6 : 1)),
    ...(hasAudio ? { audioBitsPerSecond: 192000 } : {}),
  });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };

  // [MỚI] Video thứ 2 chạy song song (bố cục 2 video): lặp lại, tắt tiếng, vẽ làm nền phía sau clip chính
  let secEl: HTMLVideoElement | null = null;
  if (splitOn && options.secondaryVideo?.url) {
    const sv = document.createElement('video');
    sv.crossOrigin = 'anonymous';
    sv.src = options.secondaryVideo.url;
    sv.muted = true;
    sv.loop = true;
    sv.playsInline = true;
    sv.preload = 'auto';
    await new Promise<void>((resolve) => {
      sv.onloadeddata = () => resolve();
      sv.onerror = () => resolve();
      setTimeout(resolve, 5000);
    });
    secEl = sv;
  }
  const secReady = () => !!secEl && secEl.readyState >= 2 && secEl.videoWidth > 0 && secEl.videoHeight > 0;

  const pushFrame = () => {
    if (vTrack && typeof vTrack.requestFrame === 'function') vTrack.requestFrame();
  };

  /** Vòng vẽ ổn định ~30 khung/giây: dùng requestAnimationFrame, dự phòng setInterval khi tab bị ẩn */
  const runFrames = (ms: number, draw: (elapsedMs: number) => void): Promise<void> =>
    new Promise<void>((resolve) => {
      const start = performance.now();
      let last = -1000;
      let nextAt = start + FRAME_MS;
      let raf = 0;
      let finished = false;
      let iv: ReturnType<typeof setInterval> | undefined;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (iv) clearInterval(iv);
        cancelAnimationFrame(raf);
        resolve();
      };
      const step = () => {
        if (finished) return;
        const now = performance.now();
        const el = now - start;
        if (signal?.aborted || el >= ms) {
          finish();
          return;
        }
        // [SỬA] nhịp khung đều ~30 hình/giây (lịch cố định, không trôi theo màn hình 60Hz)
        if (now >= nextAt - 4) {
          last = now;
          nextAt += FRAME_MS;
          if (now - nextAt > FRAME_MS * 2) nextAt = now + FRAME_MS;
          draw(el);
          pushFrame();
        }
        cancelAnimationFrame(raf);
        if (!document.hidden) raf = requestAnimationFrame(step);
      };
      iv = setInterval(() => {
        if (document.hidden || performance.now() - last > 120) step();
      }, 33);
      draw(0);
      pushFrame();
      last = performance.now();
      raf = requestAnimationFrame(step);
    });

  // ── Lớp dựng sẵn (không vẽ lại mỗi khung) ──
  const backdropCache = new Map<number, HTMLCanvasElement>();
  const getBackdrop = (idx: number) => {
    let b = backdropCache.get(idx);
    if (!b) {
      const made = makeCanvas(targetW, targetH);
      drawGradientBackdrop(made.ctx, targetW, targetH, PALETTES[idx]);
      b = made.canvas;
      backdropCache.set(idx, b);
    }
    return b;
  };
  const vignetteLayer = (() => {
    const made = makeCanvas(targetW, targetH);
    drawVignette(made.ctx, targetW, targetH);
    return made.canvas;
  })();
  const prev = makeCanvas(targetW, targetH);
  const blurSmall = makeCanvas(Math.max(48, Math.round(targetW / 24)), Math.max(48, Math.round(targetH / 24)));

  const hasAnySubs = (sc: LoadedScene) =>
    settings.enableSubtitles && (!!globalCues || (!!sc.cues && sc.cues.length > 0));

  /** [MỚI] Bố cục 2 video: chỉ áp dụng cho clip video khi video thứ 2 đã sẵn sàng */
  const splitActive = (sc: LoadedScene) => splitOn && secReady() && !sc.isImg && !sc.textSlide;
  /** [MỚI] Clip chính vừa khít khung (giữ đủ hình), đặt ở trên / giữa / dưới; phần trống để video thứ 2 hiện ra */
  const splitRect = (sc: LoadedScene) => {
    const fit = Math.min(targetW / sc.vW, targetH / sc.vH);
    const fw = sc.vW * fit;
    const fh = sc.vH * fit;
    const fx = (targetW - fw) / 2;
    const fy = splitPos === 'top' ? 0 : splitPos === 'bottom' ? targetH - fh : (targetH - fh) / 2;
    return { fx, fy, fw, fh, radius: 0 };
  };
  /** [MỚI] Vẽ video thứ 2 tràn khung (cắt giữa) làm nền */
  const drawSecondary = (c: CanvasRenderingContext2D) => {
    const sv = secEl;
    if (!sv || !secReady()) return;
    const k = Math.max(targetW / sv.videoWidth, targetH / sv.videoHeight);
    const w = sv.videoWidth * k;
    const h = sv.videoHeight * k;
    c.drawImage(sv, (targetW - w) / 2, (targetH - h) / 2, w, h);
  };

  const frameRect = (sc: LoadedScene, t: number) => {
    if (splitActive(sc)) return splitRect(sc);
    const subReserve = hasAnySubs(sc) && subsAtBottom ? targetH * 0.15 : 0; // [SỬA] theo vị trí phụ đề
    // ảnh/slide có chữ: khung lớn hơn và gần như không phóng to để chữ không bị nhoè do co giãn liên tục
    const margin = sc.isImg ? 0.975 : 0.93;
    const grow = 1 + (sc.isImg ? 0.012 : 0.02) * t;
    const containFit = Math.min(targetW / sc.vW, (targetH - subReserve) / sc.vH) * margin * grow;
    // [MỚI] Chỉ clip video, chỉ khi người dùng kéo "Mức phóng": nội suy giữa giữ đủ hình và tràn khung
    const useFill = fillAmt > 0 && !sc.isImg;
    const coverFit = Math.max(targetW / sc.vW, targetH / sc.vH) * grow;
    const fit = useFill ? containFit + (coverFit - containFit) * fillAmt : containFit;
    const fw = sc.vW * fit;
    const fh = sc.vH * fit;
    let fx = (targetW - fw) / 2;
    let fy = (targetH - subReserve - fh) / 2 + (subReserve ? targetH * 0.012 : -targetH * 0.012);
    if (useFill) {
      if (fw > targetW) fx = (targetW - fw) * focus;
      if (fh > targetH) fy = (targetH - fh) * focus;
    }
    return {
      fx,
      fy,
      fw,
      fh,
      radius: Math.min(targetW, targetH) * 0.022,
    };
  };

  // ── Tăng nét: co ảnh từng bậc về đúng cỡ khung rồi làm nét nhẹ (chữ nhỏ, PDF) ──
  const prepareSharp = (img: HTMLImageElement, vW: number, vH: number, withSubs: boolean): HTMLCanvasElement | undefined => {
    if (settings.sharpText === false || !(vW > 0 && vH > 0)) return undefined;
    try {
      const subReserve = withSubs ? targetH * 0.15 : 0;
      const fit = Math.min(targetW / vW, (targetH - subReserve) / vH) * 0.975 * 1.012;
      const dw = Math.max(2, Math.round(vW * fit));
      const dh = Math.max(2, Math.round(vH * fit));
      let cur: CanvasImageSource = img;
      let cw = vW;
      let ch = vH;
      while (cw / 2 >= dw && ch / 2 >= dh) {
        const nw = Math.round(cw / 2);
        const nh = Math.round(ch / 2);
        const step = makeCanvas(nw, nh);
        step.ctx.imageSmoothingEnabled = true;
        step.ctx.imageSmoothingQuality = 'high';
        step.ctx.drawImage(cur, 0, 0, nw, nh);
        cur = step.canvas;
        cw = nw;
        ch = nh;
      }
      const out = makeCanvas(dw, dh);
      out.ctx.imageSmoothingEnabled = true;
      out.ctx.imageSmoothingQuality = 'high';
      out.ctx.drawImage(cur, 0, 0, dw, dh);
      // làm nét (unsharp 4 hướng); ảnh phải phóng lên thì làm nét mạnh hơn
      const a = fit > 1 ? 0.9 : 0.55;
      const id = out.ctx.getImageData(0, 0, dw, dh);
      const src = id.data;
      const dst = new Uint8ClampedArray(src);
      const row = dw * 4;
      for (let y = 1; y < dh - 1; y++) {
        for (let x = 1; x < dw - 1; x++) {
          const i = y * row + x * 4;
          for (let k = 0; k < 3; k++) {
            const v = src[i + k] * (1 + 4 * a) - a * (src[i - 4 + k] + src[i + 4 + k] + src[i - row + k] + src[i + row + k]);
            dst[i + k] = v;
          }
        }
      }
      id.data.set(dst);
      out.ctx.putImageData(id, 0, 0);
      return out.canvas;
    } catch {
      return undefined;
    }
  };

  let loadOffset = masterVoice?.startAt || 0; // [MỚI] cộng dồn thời lượng cảnh (căn hiệu ứng theo voice dài)
  // ── Tải 1 cảnh (chạy trước khi tới lượt để chuyển cảnh liền mạch) ──
  const loadScene = async (scene: RenderSceneInput): Promise<LoadedScene> => {
    const sceneIdx = scenes.indexOf(scene); // [MỚI] vị trí cảnh (mở đầu / kết thúc)
    const isText = !!scene.textSlide;
    const isImg = !!scene.isImage || isText;
    const videoEl = document.createElement('video');
    const imgEl = new Image();
    let slidePhoto: SlidePhotoRef | null = null;
    if (isText) {
      const pu = scene.textSlide!.photoUrl;
      if (pu) {
        const pim = new Image();
        pim.crossOrigin = 'anonymous';
        pim.src = pu;
        await new Promise<void>((resolve) => {
          pim.onload = () => resolve();
          pim.onerror = () => resolve();
        });
        if (pim.naturalWidth > 0) slidePhoto = { img: pim, w: pim.naturalWidth, h: pim.naturalHeight };
      }
    } else if (isImg) {
      imgEl.crossOrigin = 'anonymous';
      imgEl.src = scene.videoUrl;
      await new Promise<void>((resolve) => {
        imgEl.onload = () => resolve();
        imgEl.onerror = () => resolve();
      });
    } else {
      videoEl.src = scene.videoUrl;
      videoEl.crossOrigin = 'anonymous';
      videoEl.muted = !keepOrigAudio; // [MỚI] giữ tiếng gốc: tiếng đi thẳng vào đường ghi (không phát ra loa)
      videoEl.playsInline = true;
      videoEl.loop = false;
      videoEl.preload = 'auto';
      await new Promise<void>((resolve) => {
        videoEl.onloadeddata = () => resolve();
        videoEl.onerror = () => resolve();
      });
    }
    const media = isImg ? imgEl : videoEl;
    const vW = isText ? targetW : (isImg ? imgEl.naturalWidth : videoEl.videoWidth) || scene.videoWidth || targetW;
    const vH = isText ? targetH : (isImg ? imgEl.naturalHeight : videoEl.videoHeight) || scene.videoHeight || targetH;

    // thời lượng cảnh
    // [MỚI] đoạn video dùng theo mô tả (giữ/bỏ), trống = cả video
    const vdur = isImg ? 0 : (videoEl.duration || scene.videoDuration || 5);
    let segs: [number, number][] = [];
    if (!isImg) {
      segs = (scene.keepSegments && scene.keepSegments.length ? scene.keepSegments : [[0, vdur] as [number, number]])
        .map(([a, b]) => [Math.max(0, Math.min(a, vdur)), Math.max(0, Math.min(b, vdur))] as [number, number])
        .filter(([a, b]) => b - a > 0.05);
      if (!segs.length) segs = [[0, vdur]];
    }
    const segTotal = segs.reduce((acc, [a, b]) => acc + (b - a), 0);
    const baseDur = (isImg ? 0 : segTotal) || scene.videoDuration || (isImg ? 6 : 5); // [SỬA] tính theo đoạn đã chọn
    let duration = baseDur;
    const voiceDuration = scene.voiceDuration || 0;
    if (scene.targetDuration && scene.targetDuration > 0) {
      // [SỬA] cảnh đã được khớp theo lời (voice dài): chuyển cảnh đúng lúc lời chuyển ý
      duration = scene.targetDuration;
    } else if (!masterMode && scene.voiceUrl && voiceDuration > 0) {
      duration = isImg
        // [SỬA] ảnh: dài đúng giọng đọc (đủ giọng, không đen); chỉnh tay dài hơn giọng thì theo tay
        ? Math.max(voiceDuration + 0.3, scene.manualSeconds ? baseDur : 0)
        : voiceDuration > baseDur ? voiceDuration + 0.3 : Math.min(baseDur, voiceDuration + 0.3); // video: giữ nguyên
    }

    // [SỬA - D] Khớp giọng đọc: video dài → cắt bớt phần cuối; video ngắn → chạy chậm cho vừa (tối thiểu 0.5x,
    // nếu vẫn thiếu thì giữ khung cuối — không bao giờ ra màn hình đen)
    let rate = 1;
    if (!isImg) {
      if (segTotal > duration + 0.02) segs = trimSegments(segs, duration);
      else if (segTotal < duration - 0.05) rate = Math.max(0.5, segTotal / duration);
      videoEl.defaultPlaybackRate = rate;
      videoEl.playbackRate = rate;
    }
    // [MỚI] MXH: giữ cảnh cuối thêm 1.5s để người xem kịp đọc lời kêu gọi (video dừng ở khung cuối)
    if (social && sceneIdx === scenes.length - 1) duration += 1.5;
    const sceneStart = loadOffset; // [MỚI] mốc bắt đầu cảnh trong file voice dài
    loadOffset += duration;

    // voice riêng của cảnh
    let voiceEl: HTMLAudioElement | null = null;
    let voiceGain: GainNode | null = null;
    if (!masterMode && scene.voiceUrl) {
      voiceEl = new Audio(scene.voiceUrl);
      voiceEl.crossOrigin = 'anonymous';
      voiceEl.preload = 'auto';
      const vs = audioCtx.createMediaElementSource(voiceEl);
      voiceGain = audioCtx.createGain();
      voiceGain.gain.value = 1.0;
      vs.connect(voiceGain);
      voiceGain.connect(audioDest);
    }

    // [MỚI] Tiếng gốc của clip → đường ghi (âm lượng theo thanh chỉnh, mặc định nguyên bản)
    let origGain: GainNode | null = null;
    if (keepOrigAudio && !isImg) {
      try {
        const os = audioCtx.createMediaElementSource(videoEl);
        origGain = audioCtx.createGain();
        origGain.gain.value = origVol;
        os.connect(origGain);
        origGain.connect(audioDest);
      } catch (err) {
        console.warn('Original audio routing failed:', err);
        origGain = null;
        videoEl.muted = true; // không nối được thì tắt tiếng, tránh phát ra loa
      }
    }

    // phụ đề theo thời gian cảnh
    let cues: SubtitleCue[] | undefined;
    if (!globalCues) {
      if (scene.subtitleCues && scene.subtitleCues.length > 0) {
        cues = scene.subtitleCues;
      } else if (scene.subtitleText && scene.subtitleText.trim()) {
        const speechEnd = !masterMode && voiceDuration > 0 ? Math.min(voiceDuration, duration) : duration * 0.92;
        cues = cuesFromText(scene.subtitleText, 0.1, Math.max(0.8, speechEnd));
      }
    }

    // [SỬA] hiệu ứng của cảnh: mô tả/chọn tay > hiệu ứng chung ('auto' = như cũ)
    let fx: SceneEffect[] = [];
    const isFirstOrLast = sceneIdx === 0 || sceneIdx === scenes.length - 1;
    if (!isText) {
      if (scene.effects !== undefined) fx = scene.effects;
      else {
        const g = settings.imageEffect ?? 'auto';
        fx = g === 'none' ? [] : g === 'auto' ? (isImg && useReveal ? [{ kind: 'reveal' }] : []) : [{ kind: g }];
      }
    }
    // [MỚI] cảnh mở đầu / kết thúc: không "hiện lần lượt" (mở đầu phải thấy ngay, cảnh kết phải đọc được đủ)
    if (isFirstOrLast) fx = fx.filter(e => e.kind !== 'reveal');
    const wantReveal = fx.some(e => e.kind === 'reveal');
    const needRegions = wantReveal || fx.some(e => (!e.box || e.approx) && e.kind !== 'reveal' && e.kind !== 'kenburns');

    // nhận diện các khối trên ảnh slide
    let detected: SlideRegion[] = [];
    if (isImg && !isText && needRegions && settings.fitMode !== 'cover' && imgEl.naturalWidth > 0) {
      try {
        detected = detectSlideRegions(imgEl, imgEl.naturalWidth, imgEl.naturalHeight);
      } catch {
        detected = [];
      }
    }
    const regions: SlideRegion[] = wantReveal && presentation ? detected : [];

    // [MỚI] lịch hiệu ứng theo lời đọc (voice dài: lấy phần phụ đề thuộc cảnh này)
    const timingCues: SubtitleCue[] = cues ?? (globalCues
      ? globalCues.filter(q => q.end > sceneStart && q.start < sceneStart + duration).map(q => ({ ...q, start: q.start - sceneStart, end: q.end - sceneStart }))
      : []);
    const plan = buildEffectPlan(fx, detected, timingCues, duration);
    const emphasis = settings.emphasisColor === false ? [] : Array.from(new Set([
      ...(scene.emphasis ?? []),
      ...fx.map(e => e.word || '').filter(Boolean),
    ]));

    const sharp = isImg && !isText && settings.fitMode !== 'cover' && presentation ? prepareSharp(imgEl, vW, vH, subsAtBottom && !!settings.enableSubtitles && (!!globalCues || (!!cues && cues.length > 0))) : undefined;
    const loaded: LoadedScene = { sharp, scene, isImg, videoEl, imgEl, media, vW, vH, duration, regions, cues, voiceEl, voiceGain, origGain, textSlide: scene.textSlide, photo: slidePhoto, layoutCache: new Map(), segs, rate, plan, emphasis };

    // nền mờ dựng sẵn cho ảnh (chế độ blur)
    if (isImg && !isText && presentation && settings.fitMode === 'blur') {
      blurSmall.ctx.drawImage(imgEl, 0, 0, blurSmall.canvas.width, blurSmall.canvas.height);
      const bg = makeCanvas(targetW, targetH);
      bg.ctx.imageSmoothingEnabled = true;
      bg.ctx.drawImage(blurSmall.canvas, 0, 0, targetW, targetH);
      loaded.blurBg = bg.canvas;
    }
    return loaded;
  };

  const releaseScene = (sc: LoadedScene) => {
    sc.sharp = undefined;
    try {
      sc.origGain?.disconnect(); // [MỚI] nhả đường tiếng gốc của cảnh đã xong
    } catch {
      // dọn dẹp
    }
    if (!sc.isImg) {
      try {
        sc.videoEl.pause();
        sc.videoEl.removeAttribute('src');
        sc.videoEl.load();
      } catch {
        // dọn dẹp
      }
    }
    if (sc.voiceEl) {
      try {
        sc.voiceEl.pause();
        sc.voiceEl.removeAttribute('src');
        sc.voiceEl.load();
      } catch {
        // dọn dẹp
      }
    }
  };

  // ── Vẽ slide chữ (nét, có hiệu ứng) ──
  const drawTextScene = (c: CanvasRenderingContext2D, sc: LoadedScene, elapsedSec: number) => {
    const reserve = hasAnySubs(sc) && subsAtBottom ? targetH * 0.15 : 0; // [SỬA] theo vị trí phụ đề
    const key = `${targetW}x${targetH}x${Math.round(reserve)}`;
    let lay = sc.layoutCache!.get(key);
    if (!lay) {
      lay = computeLayout(c, sc.textSlide!, targetW, targetH, reserve, !!sc.photo);
      sc.layoutCache!.set(key, lay);
    }
    drawSlide(c, targetW, targetH, sc.textSlide!, lay, sc.photo || null, elapsedSec, sc.duration, { typewriter: settings.typewriter !== false });
  };

  /** [MỚI] MXH: ảnh/video đúng tỉ lệ khung (lệch <10%) → tràn màn hình, không lồng khung bo góc */
  const fullBleed = (sc: LoadedScene) =>
    social && !sc.textSlide && sc.vW > 0 && sc.vH > 0 && Math.abs((sc.vW / sc.vH) / (targetW / targetH) - 1) < 0.1;
  /** [MỚI] dải phụ đề (để hiệu ứng không vẽ đè lên) */
  const subBand: [number, number] | undefined = !settings.enableSubtitles ? undefined
    : settings.subtitleY !== undefined
      ? [(settings.subtitleY / 100 - 0.1) * targetH, (settings.subtitleY / 100 + 0.1) * targetH]
      : [targetH * 0.78, targetH];

  /** [MỚI] Vẽ hình chính theo vùng đang hiển thị (phóng to dùng ảnh gốc cho nét) + lớp hiệu ứng */
  const drawMediaFx = (c: CanvasRenderingContext2D, sc: LoadedScene, el: number, dx: number, dy: number, dw: number, dh: number, useSharp: boolean): Box => {
    const view = viewAt(sc.plan, el, sc.duration);
    if (isFull(view)) {
      c.drawImage(useSharp && sc.sharp ? sc.sharp : sc.media, dx, dy, dw, dh);
    } else {
      c.drawImage(sc.media, view.x * sc.vW, view.y * sc.vH, view.w * sc.vW, view.h * sc.vH, dx, dy, dw, dh);
    }
    return view;
  };

  // ── Vẽ 1 khung hình của cảnh ──
  const drawSceneFrame = (sc: LoadedScene, sIdx: number, elapsedMs: number, isLast: boolean, sceneMs: number) => {
    const c = mainCtx;
    const t = clamp01(elapsedMs / sceneMs);
    const elapsedSec = elapsedMs / 1000;
    const pal = PALETTES[sIdx % PALETTES.length];
    const transitionKind = sIdx % 3;

    // phụ đề hiện tại
    let cue: SubtitleCue | null = null;
    let cueAge = 1;
    if (settings.enableSubtitles) {
      if (globalCues && masterEl) {
        cue = findCue(globalCues, masterEl.currentTime);
        if (cue) cueAge = masterEl.currentTime - cue.start;
      } else if (sc.cues) {
        cue = findCue(sc.cues, elapsedSec);
        if (cue) cueAge = elapsedSec - cue.start;
      }
    }
    // [MỚI] MXH: câu dài → cụm ≤6 từ; karaoke: tiến độ đọc trong cụm
    let subOpt: { posY?: number; progress?: number; social?: boolean } = { posY: settings.subtitleY, social };
    if (cue) {
      const nowT = globalCues && masterEl ? masterEl.currentTime : elapsedSec;
      if (social) {
        const ch = chunkCue(cue, nowT, 6);
        if (ch !== cue) { cueAge = nowT - ch.start + (ch.start > cue.start ? 1 : 0); cue = ch; }
      }
      if (settings.karaoke) subOpt = { ...subOpt, progress: (nowT - cue.start) / Math.max(0.2, cue.end - cue.start) };
    }

    // ── Kiểu cũ ──
    if (!presentation) {
      c.fillStyle = '#000000';
      c.fillRect(0, 0, targetW, targetH);
      if (sc.textSlide) {
        drawTextScene(c, sc, elapsedSec);
      } else if (splitActive(sc)) { // [MỚI] bố cục 2 video: video 2 làm nền, clip chính ở trên/giữa/dưới
        drawSecondary(c);
        const sr = splitRect(sc);
        const view = drawMediaFx(c, sc, elapsedSec, sr.fx, sr.fy, sr.fw, sr.fh, false);
        drawOverlays(c, sc.plan, view, sr.fx, sr.fy, sr.fw, sr.fh, elapsedSec, targetH, subBand);
      } else if (settings.fitMode === 'cover' || fullBleed(sc)) { // [SỬA] MXH: tràn màn hình
        const scale = Math.max(targetW / sc.vW, targetH / sc.vH);
        const dx = (targetW - sc.vW * scale) / 2, dy = (targetH - sc.vH * scale) / 2, dw = sc.vW * scale, dh = sc.vH * scale;
        const view = drawMediaFx(c, sc, elapsedSec, dx, dy, dw, dh, false); // [SỬA] hiệu ứng
        drawOverlays(c, sc.plan, view, dx, dy, dw, dh, elapsedSec, targetH, subBand);
      } else {
        if (settings.fitMode === 'blur') {
          blurSmall.ctx.drawImage(sc.media, 0, 0, blurSmall.canvas.width, blurSmall.canvas.height);
          c.save();
          c.globalAlpha = 0.6;
          c.drawImage(blurSmall.canvas, 0, 0, targetW, targetH);
          c.restore();
        }
        const rContain = Math.min(targetW / sc.vW, targetH / sc.vH);
        const useFillC = fillAmt > 0 && !sc.isImg; // [MỚI] mặc định 0 = như cũ
        const r = useFillC ? rContain + (Math.max(targetW / sc.vW, targetH / sc.vH) - rContain) * fillAmt : rContain;
        const dw = sc.vW * r, dh = sc.vH * r;
        const dx = useFillC && dw > targetW ? (targetW - dw) * focus : (targetW - dw) / 2;
        const dy = useFillC && dh > targetH ? (targetH - dh) * focus : (targetH - dh) / 2;
        const view = drawMediaFx(c, sc, elapsedSec, dx, dy, dw, dh, false); // [SỬA] hiệu ứng
        drawOverlays(c, sc.plan, view, dx, dy, dw, dh, elapsedSec, targetH, subBand);
      }
      if (cue) drawSubtitle(c, cue.text, targetW, targetH, settings.subtitleStyle, '#FFE600', 1, sc.emphasis, subOpt);
      return;
    }

    // ── Kiểu trình chiếu ──
    const tIn = useTransitions ? clamp01(elapsedMs / (TRANSITION_SECONDS * 1000)) : 1;
    const inProgress = easeInOut(tIn);
    const hasPrev = useTransitions && sIdx > 0 && tIn < 1;

    if (hasPrev) c.drawImage(prev.canvas, 0, 0, targetW, targetH);

    c.save();
    if (hasPrev) {
      c.globalAlpha = inProgress;
      if (transitionKind === 1) {
        c.translate((1 - inProgress) * targetW * 0.07, 0);
      } else if (transitionKind === 2) {
        const z = 1.06 - 0.06 * inProgress;
        c.translate(targetW / 2, targetH / 2);
        c.scale(z, z);
        c.translate(-targetW / 2, -targetH / 2);
      }
    }

    if (sc.textSlide) {
      drawTextScene(c, sc, elapsedSec);
    } else {
    // 1) Nền
    if (splitActive(sc)) {
      drawSecondary(c); // [MỚI] bố cục 2 video: video thứ 2 làm nền
    } else if (settings.fitMode === 'blur') {
      if (sc.blurBg) {
        c.drawImage(sc.blurBg, 0, 0, targetW, targetH);
      } else {
        blurSmall.ctx.drawImage(sc.media, 0, 0, blurSmall.canvas.width, blurSmall.canvas.height);
        c.imageSmoothingEnabled = true;
        c.drawImage(blurSmall.canvas, 0, 0, targetW, targetH);
      }
      const tint = c.createLinearGradient(0, 0, targetW, targetH);
      tint.addColorStop(0, `${pal[0]}d9`);
      tint.addColorStop(1, `${pal[1]}b3`);
      c.fillStyle = tint;
      c.fillRect(0, 0, targetW, targetH);
    } else {
      c.drawImage(getBackdrop(sIdx % PALETTES.length), 0, 0);
    }

    // 2) Hình chính
    if ((settings.fitMode === 'cover' || fullBleed(sc)) && !splitActive(sc)) { // [SỬA] MXH: ảnh đúng tỉ lệ tràn màn hình
      const kb = 1 + (fullBleed(sc) ? 0.015 : sc.isImg ? 0.07 : 0.045) * t; // ảnh thiết kế sẵn: chỉ trôi rất nhẹ, không cắt chữ
      const scale = Math.max(targetW / sc.vW, targetH / sc.vH) * kb;
      const dx = (targetW - sc.vW * scale) / 2, dy = (targetH - sc.vH * scale) / 2, dw = sc.vW * scale, dh = sc.vH * scale;
      const view = drawMediaFx(c, sc, elapsedSec, dx, dy, dw, dh, false); // [SỬA] hiệu ứng
      drawOverlays(c, sc.plan, view, dx, dy, dw, dh, elapsedSec, targetH, subBand);
    } else {
      const { fx, fy, fw, fh, radius } = frameRect(sc, t);

      // bóng đổ
      c.save();
      c.shadowColor = 'rgba(0,0,0,0.5)';
      c.shadowBlur = Math.min(targetW, targetH) * 0.04;
      c.shadowOffsetY = Math.min(targetW, targetH) * 0.012;
      c.fillStyle = '#0b0f1e';
      roundedRectPath(c, fx, fy, fw, fh, radius);
      c.fill();
      c.restore();

      c.save();
      roundedRectPath(c, fx, fy, fw, fh, radius);
      c.clip();
      const view = drawMediaFx(c, sc, elapsedSec, fx, fy, fw, fh, true); // [SỬA] phóng to / chuyển động chậm

      // hiệu ứng từng khối xuất hiện (ảnh slide)
      if (sc.isImg && sc.regions.length > 0 && isFull(view)) {
        const n = sc.regions.length;
        const startAt = useTransitions && sIdx > 0 ? 0.75 : 0.45;
        const endAt = Math.max(startAt + 1, sc.duration * 0.75);
        const step = Math.max(0.25, Math.min(1.1, (endAt - startAt) / n));
        const anim = 0.6;
        const rects = sc.regions.map((r) => ({
          rx: fx + r.x * fw,
          ry: fy + r.y * fh,
          rw: r.w * fw,
          rh: r.h * fh,
        }));
        const prog = sc.regions.map((_, k) => easeOut(clamp01((elapsedSec - (startAt + k * step)) / anim)));

        // che các khối chưa xuất hiện bằng màu nền xung quanh
        sc.regions.forEach((r, k) => {
          if (prog[k] >= 1) return;
          const q = rects[k];
          c.fillStyle = r.bg;
          c.fillRect(q.rx - 1, q.ry - 1, q.rw + 2, q.rh + 2);
        });
        // vẽ lại các khối đang xuất hiện (trượt nhẹ từ dưới lên + hiện dần)
        sc.regions.forEach((r, k) => {
          if (prog[k] <= 0 || prog[k] >= 1) return;
          const q = rects[k];
          c.save();
          c.beginPath();
          c.rect(q.rx, q.ry, q.rw, q.rh);
          c.clip();
          c.globalAlpha = prog[k];
          const dy = (1 - prog[k]) * fh * 0.035;
          const kS = sc.sharp ? sc.sharp.width / sc.vW : 1;
          c.drawImage(
            sc.sharp || sc.imgEl,
            r.x * sc.vW * kS, r.y * sc.vH * kS, r.w * sc.vW * kS, r.h * sc.vH * kS,
            q.rx, q.ry + dy, q.rw, q.rh
          );
          c.restore();
          // viền sáng mờ dần quanh khối vừa xuất hiện
          c.save();
          c.globalAlpha = (1 - prog[k]) * 0.9;
          c.strokeStyle = pal[2];
          c.lineWidth = Math.max(3, targetH * 0.004);
          c.strokeRect(q.rx, q.ry, q.rw, q.rh);
          c.restore();
        });
      }
      drawOverlays(c, sc.plan, view, fx, fy, fw, fh, elapsedSec, targetH, subBand); // [MỚI] khung sáng / làm tối / gạch chân
      c.restore();

      // viền mảnh
      c.save();
      c.strokeStyle = `${pal[2]}66`;
      c.lineWidth = Math.max(2, targetH * 0.002);
      roundedRectPath(c, fx, fy, fw, fh, radius);
      c.stroke();
      c.restore();
    }
    }

    // 3) Viền tối + thanh tiến trình
    if (!sc.textSlide) c.drawImage(vignetteLayer, 0, 0);
    if (!social) { // [SỬA] MXH: ẩn thanh tiến trình (nền tảng đã có, và nằm trong vùng bị che)
      const barH = Math.max(4, Math.round(targetH * 0.006));
      const overall = (sIdx + t) / scenes.length;
      c.fillStyle = 'rgba(255,255,255,0.10)';
      c.fillRect(0, targetH - barH, targetW, barH);
      c.fillStyle = pal[2];
      c.fillRect(0, targetH - barH, targetW * overall, barH);
    }

    // 4) Phụ đề (hiện đúng lúc người đọc nói tới)
    if (cue) {
      drawSubtitle(c, cue.text, targetW, targetH, settings.subtitleStyle, pal[2], easeInOut(clamp01(cueAge / 0.18)), sc.emphasis, subOpt); // [SỬA] nhấn mạnh + vị trí + karaoke
    }

    c.restore();

    // 5) [SỬA] Bỏ mờ về đen cuối phim: giữ khung hình cuối, không để màn hình đen
    void isLast;
    void OUTRO_FADE_SECONDS;
  };

  // ── Bắt đầu ghi ──
  let totalRenderedDuration = 0;
  let thumbPromise: Promise<Blob | null> | null = null; // [MỚI] ảnh bìa
  const totalScenes = scenes.length;

  const cleanupAll = () => {
    try {
      bgmAudioEl?.pause();
      masterEl?.pause();
      secEl?.pause();
    } catch {
      // bỏ qua
    }
    try {
      if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    } catch {
      // bỏ qua
    }
    canvasStream.getTracks().forEach((t) => t.stop());
    try {
      audioCtx.close();
    } catch {
      // bỏ qua
    }
  };

  try {
    mediaRecorder.start(250);

    // [MỚI] Video thứ 2 chạy song song suốt phim (lặp lại)
    if (secEl) {
      await secEl.play().catch((e) => console.warn('Secondary video play warning:', e));
    }

    // Nhạc nền vào êm trong 2 giây tới đúng mức đã chọn
    if (bgmAudioEl && bgmGainNode) {
      bgmAudioEl.currentTime = 0;
      const t0 = audioCtx.currentTime;
      bgmGainNode.gain.setValueAtTime(0, t0);
      bgmGainNode.gain.linearRampToValueAtTime(bgmTarget, t0 + 2);
      await bgmAudioEl.play().catch((e) => console.warn('BGM play warning:', e));
    }

    // Thẻ mở đầu (chỉ khi có tiêu đề)
    if (presentation && options.title && options.title.trim()) {
      const pal = PALETTES[0];
      const title = options.title.trim();
      const introMs = INTRO_SECONDS * 1000;
      await runFrames(introMs, (el) => {
        const a = easeInOut(clamp01(el / 700)) * (1 - easeInOut(clamp01((el - (introMs - 500)) / 500)));
        mainCtx.drawImage(getBackdrop(0), 0, 0);
        mainCtx.save();
        mainCtx.globalAlpha = a;
        const fs = Math.round(Math.min(targetW, targetH) * 0.075);
        mainCtx.font = `800 ${fs}px ${FONT_STACK}`;
        mainCtx.textAlign = 'center';
        mainCtx.textBaseline = 'middle';
        mainCtx.fillStyle = '#ffffff';
        const lines = wrapLines(mainCtx, title, targetW * 0.8);
        const lh = fs * 1.25;
        lines.forEach((ln, i) => mainCtx.fillText(ln, targetW / 2, targetH / 2 - ((lines.length - 1) * lh) / 2 + i * lh - fs * 0.15));
        mainCtx.fillStyle = pal[2];
        const lw = targetW * 0.12 * a;
        mainCtx.fillRect((targetW - lw) / 2, targetH / 2 + (lines.length * lh) / 2 + fs * 0.1, lw, Math.max(4, fs * 0.06));
        mainCtx.restore();
        mainCtx.drawImage(vignetteLayer, 0, 0);
      });
      if (useTransitions) prev.ctx.drawImage(canvas, 0, 0, targetW, targetH);
      totalRenderedDuration += INTRO_SECONDS;
    }

    // Tải trước cảnh đầu
    let nextPromise: Promise<LoadedScene> | null = loadScene(scenes[0]);

    for (let sIdx = 0; sIdx < totalScenes; sIdx++) {
      if (signal?.aborted) throw new RenderCancelled();

      const sceneNum = sIdx + 1;
      onProgress?.(Math.round(5 + (sIdx / totalScenes) * 85), `Processing Scene ${sceneNum}/${totalScenes}...`);

      const sc = await nextPromise!;
      // tải trước cảnh kế tiếp trong lúc cảnh này đang chạy
      nextPromise = sIdx + 1 < totalScenes ? loadScene(scenes[sIdx + 1]) : null;

      totalRenderedDuration += sc.duration;
      const sceneMs = sc.duration * 1000;
      const isLast = sIdx === totalScenes - 1;

      // chuẩn bị phát
      // [SỬA] video: bắt đầu từ đoạn giữ lại đầu tiên, đúng tốc độ đã khớp giọng
      let segIdx = 0;
      if (!sc.isImg) {
        const v = sc.videoEl;
        const s0 = sc.segs[0]?.[0] ?? 0;
        if (Math.abs(v.currentTime - s0) > 0.05) {
          await new Promise<void>((r) => {
            const done = () => { v.removeEventListener('seeked', done); r(); };
            v.addEventListener('seeked', done);
            v.currentTime = s0;
            setTimeout(done, 1500);
          });
        }
        v.playbackRate = sc.rate;
      }
      /** [MỚI] hết đoạn → nhảy sang đoạn kế; hết đoạn cuối → dừng ở khung cuối (không đen) */
      const advanceSeg = () => {
        const v = sc.videoEl;
        if (sc.isImg || segIdx >= sc.segs.length || v.seeking) return;
        if (v.currentTime >= sc.segs[segIdx][1] - 0.04 || v.ended) {
          segIdx++;
          if (segIdx < sc.segs.length) v.currentTime = sc.segs[segIdx][0];
          else v.pause();
        }
      };
      drawSceneFrame(sc, sIdx, 0, isLast, sceneMs);
      pushFrame();

      if (!sc.isImg) {
        await sc.videoEl.play().catch(async (e) => {
          console.warn('Video play warning:', e);
          // [MỚI] trình duyệt chặn phát có tiếng → tắt tiếng gốc của cảnh này để hình vẫn chạy (không bị đứng)
          if (!sc.videoEl.muted) {
            sc.videoEl.muted = true;
            await sc.videoEl.play().catch((e2) => console.warn('Video play retry warning:', e2));
          }
        });
      }
      if (sc.voiceEl) {
        sc.voiceEl.currentTime = 0;
        await sc.voiceEl.play().catch((e) => console.warn('Voice play warning:', e));
      }
      if (masterEl && sIdx === 0) {
        await masterEl.play().catch((e) => console.warn('Master voice play warning:', e));
      }

      // cuối phim: nhạc nền và voice dài nhỏ dần êm trong 1.5 giây cuối
      if (isLast) {
        const now = audioCtx.currentTime;
        const tEnd = now + sc.duration;
        if (bgmGainNode) {
          bgmGainNode.gain.cancelScheduledValues(now);
          bgmGainNode.gain.setValueAtTime(bgmTarget, now);
          bgmGainNode.gain.setValueAtTime(bgmTarget, Math.max(now, tEnd - 1.5));
          bgmGainNode.gain.linearRampToValueAtTime(0, tEnd - 0.05);
        }
        if (masterGain) {
          masterGain.gain.setValueAtTime(1, Math.max(now, tEnd - 0.5));
          masterGain.gain.linearRampToValueAtTime(0, tEnd - 0.05);
        }
      }

      await runFrames(sceneMs, (elapsed) => {
        const cur = Math.min(95, Math.round(5 + ((sIdx + elapsed / sceneMs) / totalScenes) * 85));
        onProgress?.(cur, `Rendering frames for Scene ${sceneNum}/${totalScenes}...`);
        advanceSeg(); // [MỚI] ghép các đoạn video đã chọn
        drawSceneFrame(sc, sIdx, elapsed, isLast, sceneMs);
        // [MỚI] ảnh bìa: chụp cảnh mở đầu khi hình + phụ đề đã hiện đủ
        if (!thumbPromise && sIdx === 0 && elapsed >= Math.min(1500, sceneMs * 0.6)) {
          thumbPromise = new Promise<Blob | null>((r) => canvas.toBlob((b) => r(b), 'image/jpeg', 0.9));
        }
      });

      if (signal?.aborted) throw new RenderCancelled();

      if (useTransitions) prev.ctx.drawImage(canvas, 0, 0, targetW, targetH); // lưu khung cuối để chuyển cảnh
      releaseScene(sc);
    }

    onProgress?.(95, 'Packaging video file...');

    await new Promise<void>((resolve) => {
      mediaRecorder.onstop = () => resolve();
      mediaRecorder.stop();
    });
  } catch (err) {
    cleanupAll();
    throw err;
  }

  bgmAudioEl?.pause();
  masterEl?.pause();
  secEl?.pause();
  canvasStream.getTracks().forEach((t) => t.stop());
  try {
    audioCtx.close();
  } catch {
    // bỏ qua
  }

  const isMp4 = selectedMimeType.includes('mp4');
  const extension = isMp4 ? 'mp4' : 'webm';
  const finalBlob = new Blob(recordedChunks, { type: selectedMimeType });
  const finalUrl = URL.createObjectURL(finalBlob);
  const thumbBlob = thumbPromise ? await thumbPromise : null; // [MỚI]
  const thumbnailUrl = thumbBlob ? URL.createObjectURL(thumbBlob) : undefined;

  return {
    url: finalUrl,
    duration: totalRenderedDuration,
    sizeMB: finalBlob.size / (1024 * 1024),
    width: targetW,
    height: targetH,
    extension,
    thumbnailUrl,
    warnings: [],
    dispose: () => {
      try {
        URL.revokeObjectURL(finalUrl);
        if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
      } catch {
        // Ignore
      }
    },
    downloadUrl: (filename: string) => {
      const a = document.createElement('a');
      a.href = finalUrl;
      a.download = `${filename}.${extension}`;
      return finalUrl;
    }
  };
}
