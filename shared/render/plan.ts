/**
 * Lập kế hoạch dựng phim – HÀM THUẦN, dùng chung cho giao diện và máy dựng.
 * Mọi quyết định về thời lượng / phụ đề / kích thước nằm ở đây để
 * "thời lượng hiển thị" luôn bằng "thời lượng dựng thật".
 */
import type {
  AspectRatioOpt, QualityOpt, RenderSettings, SceneSpec,
  SubtitleCue, Timeline, TimelineScene,
} from './types';

export const FPS = 30;
/** Voice bắt đầu sau đầu cảnh một chút cho tự nhiên */
export const VOICE_LEAD = 0.1;
/** Giữ thêm sau khi voice dứt */
export const VOICE_TAIL = 0.3;
export const MIN_SCENE_SECONDS = 0.5;
export const MIN_CUE_SECONDS = 0.8;
/** Cảnh ảnh: số giây mặc định / tối thiểu (đủ cho vào-hiện, lóe sáng, giữ khung cuối) */
export const DEFAULT_IMAGE_SECONDS = 7;
/** Tên cũ, giữ lại để máy dựng FFmpeg bản GitHub vẫn chạy */
export const IMAGE_DEFAULT_SECONDS = DEFAULT_IMAGE_SECONDS;
export const MIN_IMAGE_SECONDS = 2.5;
/** Cạnh dài tối đa khi lấy kích thước ảnh làm khung phim (tránh ra video quá lớn) */
const MAX_IMAGE_LONG_SIDE = 1920;

export type DurationSource = 'user' | 'voice' | 'image' | 'clip';

type DurationInput = Pick<SceneSpec, 'kind' | 'videoDuration' | 'voiceDuration' | 'imageDuration' | 'userDuration'>;

/**
 * Thời lượng thô (giây) của một cảnh – DÙNG CHUNG cho timeline, ước tính và hiển thị.
 * Thứ tự ưu tiên:  1) người dùng tự đặt  >  2) thời lượng voice  >  3) số giây mặc định của ảnh / độ dài clip gốc.
 * - Đặt ngắn hơn voice: voice bị cắt cho vừa cảnh. Đặt dài hơn clip: clip được lặp lại cho đủ.
 */
export function sceneDuration(s: DurationInput): { seconds: number; source: DurationSource } {
  const user = s.userDuration && s.userDuration > 0 ? s.userDuration : 0;
  if (user > 0) return { seconds: Math.max(MIN_SCENE_SECONDS, user), source: 'user' };
  const voice = s.voiceDuration && s.voiceDuration > 0 ? s.voiceDuration : 0;
  if (s.kind === 'image') {
    if (voice > 0) return { seconds: Math.max(MIN_IMAGE_SECONDS, VOICE_LEAD + voice + VOICE_TAIL), source: 'voice' };
    return { seconds: Math.max(MIN_IMAGE_SECONDS, s.imageDuration || DEFAULT_IMAGE_SECONDS), source: 'image' };
  }
  if (voice > 0) return { seconds: VOICE_LEAD + voice + VOICE_TAIL, source: 'voice' };
  return { seconds: Math.max(MIN_SCENE_SECONDS, s.videoDuration || MIN_SCENE_SECONDS), source: 'clip' };
}

export function sceneRawDuration(s: DurationInput): number {
  return sceneDuration(s).seconds;
}

/** Kích thước khung phim khi cảnh đầu là ảnh: giữ tỉ lệ, cạnh dài <= 1920 */
function capImageSize(w: number, h: number): { width: number; height: number } {
  const k = Math.min(1, MAX_IMAGE_LONG_SIDE / Math.max(w, h, 1));
  return { width: Math.round(w * k), height: Math.round(h * k) };
}

const toEven = (n: number) => {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r + 1;
};

const quantize = (seconds: number) => Math.max(1, Math.round(seconds * FPS));

// ───────────────────────── Số thứ tự cảnh từ tên file ─────────────────────────

/**
 * "Veo3_clip_05.mp4" -> 5, "canh 12.mov" -> 12, "IMG_0023.mp4" -> 23,
 * "1771117397469_7.mp4" -> 7, "final_1080p_3.mp4" -> 3. Không tìm được -> null.
 */
export function parseSceneNumber(filename: string): number | null {
  let name = filename.replace(/\.[a-z0-9]{2,5}$/i, '').toLowerCase();

  // 1) Có từ khóa rõ ràng đứng trước số
  const keyword = name.match(
    /(?:scene|c[aảâ]nh|clip|part|ph[aầ]n|t[aậ]p|ep|shot|voice|video|audio)[\s_.#-]*0*(\d{1,4})(?!\d)/i
  );
  if (keyword) return parseInt(keyword[1], 10);

  // 2) Bỏ các số không phải thứ tự: veo3, mp4, h264, 1080p, 30fps, 1920x1080, 4k
  name = name
    .replace(/\b(?:veo|mp|h|x|v|gemini)[\s_-]?\d+(?:\.\d+)?/g, ' ')
    .replace(/\d{3,4}\s?p\b/g, ' ')
    .replace(/\d+\s?fps/g, ' ')
    .replace(/\d+\s?x\s?\d+/g, ' ')
    .replace(/\d+\s?k\b/g, ' ');

  // 3) Lấy nhóm số cuối cùng có 1-4 chữ số (bỏ timestamp / id dài)
  const groups = name.match(/\d+/g)?.filter(g => g.length <= 4);
  if (groups && groups.length > 0) return parseInt(groups[groups.length - 1], 10);
  return null;
}

// ───────────────────────── Kích thước đầu ra ─────────────────────────

export function resolveOutputSize(
  aspect: AspectRatioOpt,
  quality: QualityOpt,
  firstClip: { width: number; height: number },
): { width: number; height: number } {
  const srcW = firstClip.width > 0 ? firstClip.width : 1920;
  const srcH = firstClip.height > 0 ? firstClip.height : 1080;

  if (aspect === 'original' && quality === 'original') {
    return { width: toEven(srcW), height: toEven(srcH) };
  }

  let ratio: number;
  if (aspect === '16:9') ratio = 16 / 9;
  else if (aspect === '9:16') ratio = 9 / 16;
  else if (aspect === '1:1') ratio = 1;
  else ratio = srcW / srcH;

  // "original" về chất lượng = giữ cạnh ngắn của clip gốc
  const shortSide =
    quality === '720p' ? 720 :
    quality === '1080p' ? 1080 :
    quality === '4k' ? 2160 :
    Math.min(srcW, srcH);

  return ratio >= 1
    ? { width: toEven(shortSide * ratio), height: toEven(shortSide) }
    : { width: toEven(shortSide), height: toEven(shortSide / ratio) };
}

// ───────────────────────── Cắt phụ đề ─────────────────────────

/** Số ký tự tối đa cho 1 phụ đề theo khung hình (hiển thị tối đa 2 dòng) */
export function maxCueChars(width: number, height: number): number {
  const r = width / height;
  if (r > 1.2) return 64;
  if (r < 0.8) return 40;
  return 46;
}

function splitLongPiece(piece: string, maxChars: number): string[] {
  if (piece.length <= maxChars) return [piece];

  // Ưu tiên ngắt ở dấu phẩy / hai chấm
  const parts = piece.match(/[^,:，、]+[,:，、]?/g) ?? [piece];
  const out: string[] = [];
  let buf = '';
  const flush = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };

  for (const part of parts) {
    if ((buf + part).length <= maxChars) { buf += part; continue; }
    flush();
    if (part.length <= maxChars) { buf = part; continue; }
    // Vẫn dài -> ngắt theo từ
    for (const word of part.split(/\s+/)) {
      if (!word) continue;
      if ((buf + ' ' + word).trim().length > maxChars) flush();
      buf = (buf + ' ' + word).trim();
    }
  }
  flush();
  return out;
}

export function splitSubtitleText(text: string, maxChars: number): string[] {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const sentences = clean.match(/[^.!?…;。！？]+[.!?…;。！？]*/g) ?? [clean];
  let pieces: string[] = [];
  for (const s of sentences) {
    const t = s.trim();
    if (t) pieces.push(...splitLongPiece(t, maxChars));
  }

  // Gộp mảnh quá ngắn vào mảnh kế bên nếu còn vừa
  const merged: string[] = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last !== undefined && (p.length < 14 || last.length < 14) && (last + ' ' + p).length <= maxChars) {
      merged[merged.length - 1] = last + ' ' + p;
    } else {
      merged.push(p);
    }
  }
  pieces = merged;
  return pieces;
}

/** Chia thời gian cho từng mảnh phụ đề theo số ký tự, trong khoảng [from, to] */
export function allocateCues(pieces: string[], from: number, to: number): SubtitleCue[] {
  if (pieces.length === 0 || to <= from) return [];
  const window = to - from;

  // Quá nhiều mảnh so với thời gian -> gộp bớt để mỗi mảnh đủ MIN_CUE_SECONDS
  let list = pieces;
  while (list.length > 1 && window / list.length < MIN_CUE_SECONDS) {
    let best = 0;
    let bestLen = Infinity;
    for (let i = 0; i < list.length - 1; i++) {
      const l = list[i].length + list[i + 1].length;
      if (l < bestLen) { bestLen = l; best = i; }
    }
    list = [...list.slice(0, best), list[best] + ' ' + list[best + 1], ...list.slice(best + 2)];
  }

  // Chia theo số ký tự, nhưng mỗi mảnh tối thiểu MIN_CUE_SECONDS:
  // mảnh nào thiếu thì nâng lên mức tối thiểu, phần còn lại chia lại cho các mảnh khác.
  const weights = list.map(p => Math.max(p.length, 1));
  const durations: number[] = new Array(list.length).fill(0);
  const fixed = new Array<boolean>(list.length).fill(false);
  for (let pass = 0; pass < list.length; pass++) {
    const freeIdx = durations.map((_, i) => i).filter(i => !fixed[i]);
    const remaining = window - fixed.reduce((a, f, i) => a + (f ? durations[i] : 0), 0);
    const freeWeight = freeIdx.reduce((a, i) => a + weights[i], 0) || 1;
    let changed = false;
    for (const i of freeIdx) {
      const d = (remaining * weights[i]) / freeWeight;
      if (d < MIN_CUE_SECONDS) { durations[i] = MIN_CUE_SECONDS; fixed[i] = true; changed = true; }
      else durations[i] = d;
    }
    if (!changed) break;
  }

  const cues: SubtitleCue[] = [];
  let cursor = from;
  list.forEach((text, i) => {
    const isLast = i === list.length - 1;
    const end = isLast ? to : cursor + durations[i];
    cues.push({ start: cursor, end, text });
    cursor = end;
  });
  return cues;
}

// ───────────────────────── Timeline ─────────────────────────

export function buildTimeline(scenes: SceneSpec[], settings: RenderSettings): Timeline {
  const first = scenes[0];
  const firstDims = first?.kind === 'image'
    ? capImageSize(first.videoWidth || 1920, first.videoHeight || 1080)
    : { width: first?.videoWidth ?? 1920, height: first?.videoHeight ?? 1080 };
  const { width, height } = resolveOutputSize(settings.aspectRatio, settings.quality, firstDims);
  const maxChars = maxCueChars(width, height);

  const out: TimelineScene[] = [];
  let cursorFrames = 0;

  scenes.forEach((scene, index) => {
    const voice = scene.voiceDuration && scene.voiceDuration > 0 ? scene.voiceDuration : 0;
    const rawDuration = sceneRawDuration(scene);

    const frames = quantize(rawDuration);
    const duration = frames / FPS;

    let cues: SubtitleCue[] = [];
    if (settings.enableSubtitles && scene.subtitleText?.trim()) {
      const pieces = splitSubtitleText(scene.subtitleText, maxChars);
      cues = voice > 0
        ? allocateCues(pieces, VOICE_LEAD, Math.min(duration, VOICE_LEAD + voice + 0.15))
        : allocateCues(pieces, 0.1, Math.max(0.2, duration - 0.1));
    }

    out.push({
      id: scene.id,
      index,
      start: cursorFrames / FPS,
      duration,
      frames,
      kind: scene.kind === 'image' ? 'image' : 'video',
      loop: scene.kind === 'image' ? false : (scene.videoDuration || 0) + 0.05 < duration,
      voiceOffset: voice > 0 ? VOICE_LEAD : null,
      voiceDuration: voice,
      cues,
    });
    cursorFrames += frames;
  });

  return { scenes: out, totalDuration: cursorFrames / FPS, width, height, fps: FPS };
}

/** Ước tính thời lượng phim cho giao diện (cùng công thức với dựng thật) */
export function estimateTotalDuration(scenes: SceneSpec[]): number {
  let frames = 0;
  for (const s of scenes) frames += quantize(sceneRawDuration(s));
  return frames / FPS;
}
