/**
 * Công cụ âm thanh chạy trong trình duyệt (không cần cài gì):
 *  - robustAudioDuration: đọc thời lượng thật, kể cả file ghi âm mà thẻ <audio> báo Infinity/NaN
 *  - splitVoiceFile: cắt 1 file ghi âm dài thành nhiều đoạn (mỗi đoạn ~N giây), ưu tiên cắt ở chỗ lặng
 */

/** Năng lượng theo khung 20ms */
function frameEnergy(mono: Float32Array, sampleRate: number): Float32Array {
  const frame = Math.max(1, Math.round(sampleRate * 0.02));
  const nFrames = Math.floor(mono.length / frame);
  const energy = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    let s = 0;
    const o = i * frame;
    for (let k = 0; k < frame; k++) { const v = mono[o + k]; s += v * v; }
    energy[i] = s / frame;
  }
  return energy;
}

/**
 * Đưa các mốc cắt LÝ TƯỞNG (giây) về chỗ lặng gần nhất để không cắt giữa câu.
 * avgSeg: độ dài đoạn trung bình, dùng để quyết định vùng tìm.
 */
function snapToSilence(energy: Float32Array, targets: number[], avgSeg: number, snapWindowSec?: number): number[] {
  const nFrames = energy.length;
  let mean = 0;
  for (let i = 0; i < nFrames; i++) mean += energy[i];
  mean /= Math.max(1, nFrames);
  const quiet = mean * 0.06; // ngưỡng "lặng": thấp hơn nhiều so với mức trung bình

  const smooth = (i: number) => {
    let e = 0, c = 0;
    for (let d = -2; d <= 2; d++) { const j = i + d; if (j >= 0 && j < nFrames) { e += energy[j]; c++; } }
    return e / c;
  };
  const search = (center: number, winFrames: number, minFrame: number): { frame: number; e: number } => {
    let best = center;
    let bestE = Infinity;
    const lo = Math.max(minFrame, center - winFrames);
    const hi = Math.min(nFrames - 1, center + winFrames);
    for (let i = lo; i <= hi; i++) {
      const e = smooth(i) * (1 + (Math.abs(i - center) / Math.max(1, winFrames)) * 0.15); // gần mốc đúng hơn thì tốt hơn một chút
      if (e < bestE) { bestE = e; best = i; }
    }
    return { frame: best, e: bestE };
  };

  const win1 = Math.round((snapWindowSec ?? Math.min(1.5, avgSeg * 0.3)) / 0.02);
  const win2 = Math.round(Math.min(4, avgSeg * 0.45) / 0.02);
  const cuts: number[] = [];
  let prev = 0;
  for (const t of targets) {
    const center = Math.min(nFrames - 1, Math.round(t / 0.02));
    const minFrame = Math.round((prev + 1) / 0.02);
    let r = search(center, win1, minFrame);
    // Không có chỗ lặng gần mốc: nới vùng tìm rộng hơn để không cắt giữa câu
    if (r.e > quiet) { const r2 = search(center, win2, minFrame); if (r2.e < r.e) r = r2; }
    const cut = Math.max(prev + 0.5, r.frame * 0.02);
    cuts.push(cut);
    prev = cut;
  }
  return cuts;
}

/** Chia theo số giây mỗi đoạn. Hàm thuần: không dùng DOM nên test được bằng Node. */
export function planSplitPoints(
  mono: Float32Array,
  sampleRate: number,
  segmentSec: number,
  opts: { snap?: boolean; snapWindowSec?: number } = {},
): number[] {
  const total = mono.length / sampleRate;
  const seg = Math.max(1, segmentSec);
  if (total <= seg * 1.2) return [];
  const targets: number[] = [];
  for (let t = seg; t < total - seg * 0.35; t += seg) targets.push(t);
  if (opts.snap === false) return targets;
  return snapToSilence(frameEnergy(mono, sampleRate), targets, seg, opts.snapWindowSec);
}

/**
 * Chia đúng N đoạn theo TỈ LỆ (vd: theo lượng chữ / thời lượng bạn đặt cho từng trang)
 * để giọng đọc được dùng HẾT và mỗi cảnh nhận phần tương ứng. Trả về N-1 điểm cắt.
 */
export function planSplitByWeights(
  mono: Float32Array,
  sampleRate: number,
  weights: number[],
  opts: { snap?: boolean; snapWindowSec?: number } = {},
): number[] {
  const n = weights.length;
  if (n < 2) return [];
  const total = mono.length / sampleRate;
  const safe = weights.map(w => (Number.isFinite(w) && w > 0 ? w : 1));
  const sum = safe.reduce((a, b) => a + b, 0);
  const targets: number[] = [];
  let acc = 0;
  for (let i = 0; i < n - 1; i++) { acc += safe[i]; targets.push((acc / sum) * total); }
  if (opts.snap === false) return targets;
  return snapToSilence(frameEnergy(mono, sampleRate), targets, total / n, opts.snapWindowSec);
}

/** Mã hóa một đoạn AudioBuffer thành WAV 16-bit. */
export function encodeWav(channels: Float32Array[], sampleRate: number, startSec: number, endSec: number): Blob {
  const nCh = channels.length;
  const start = Math.max(0, Math.floor(startSec * sampleRate));
  const end = Math.min(channels[0].length, Math.ceil(endSec * sampleRate));
  const frames = Math.max(0, end - start);
  const bytes = frames * nCh * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nCh, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nCh * 2, true);
  v.setUint16(32, nCh * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, bytes, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nCh; c++) {
      const x = Math.max(-1, Math.min(1, channels[c][start + i]));
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function decode(file: Blob): Promise<AudioBuffer> {
  const Ctx: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new Ctx();
  try {
    const data = await file.arrayBuffer();
    return await ctx.decodeAudioData(data);
  } finally {
    void ctx.close().catch(() => {});
  }
}

/**
 * Thời lượng thật của file âm thanh. Thử thẻ <audio> trước (nhanh); nếu báo Infinity/NaN/lỗi
 * (hay gặp với file ghi âm .webm/.ogg/.m4a từ điện thoại) thì giải mã để đo.
 * Trả null nếu trình duyệt hoàn toàn không đọc được file.
 */
export async function robustAudioDuration(file: Blob, url: string): Promise<number | null> {
  const fromElement = await new Promise<number | null>(resolve => {
    const a = document.createElement('audio');
    a.preload = 'metadata';
    const timer = setTimeout(() => resolve(null), 6000);
    a.onloadedmetadata = () => { clearTimeout(timer); resolve(Number.isFinite(a.duration) && a.duration > 0 ? a.duration : null); };
    a.onerror = () => { clearTimeout(timer); resolve(null); };
    a.src = url;
  });
  if (fromElement) return fromElement;
  try {
    const buf = await decode(file);
    return buf.duration;
  } catch {
    return null;
  }
}

export interface VoiceSegment { file: File; duration: number }

/** Cắt 1 file ghi âm thành các đoạn ~segmentSec giây. Trả về danh sách file WAV theo thứ tự. */
export async function splitVoiceFile(
  file: File,
  segmentSec: number,
  baseName = 'voice',
  snap = true,
  /** Có giá trị: chia đúng weights.length đoạn theo tỉ lệ (bỏ qua segmentSec) */
  weights?: number[],
): Promise<VoiceSegment[]> {
  const buf = await decode(file);
  const channels: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
  const mono = new Float32Array(buf.length);
  for (const ch of channels) for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / channels.length;

  const cuts = weights && weights.length >= 2
    ? planSplitByWeights(mono, buf.sampleRate, weights, { snap })
    : planSplitPoints(mono, buf.sampleRate, segmentSec, { snap });
  const bounds = [0, ...cuts, buf.duration];
  const out: VoiceSegment[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const blob = encodeWav(channels, buf.sampleRate, bounds[i], bounds[i + 1]);
    const name = `${baseName}_${String(i + 1).padStart(3, '0')}.wav`;
    out.push({ file: new File([blob], name, { type: 'audio/wav' }), duration: bounds[i + 1] - bounds[i] });
  }
  return out;
}
