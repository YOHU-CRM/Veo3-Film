/**
 * Nhạc nền TỰ TẠO bằng FFmpeg: hợp âm nền (pad) chuyển hợp âm mượt + vang nhẹ.
 * Hoàn toàn do máy dựng tổng hợp -> miễn phí, không có bản quyền, không cần tải gì.
 * Tạo sẵn 1 vòng lặp liền mạch (chuyển hợp âm cuối -> đầu êm), máy dựng lặp lại cho đủ độ dài phim.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MusicMood } from '../../shared/render/types';
import { FFMPEG } from './binaries';
import { runFfmpeg } from './proc';

const SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** 'A2' -> 110 Hz, 'Bb1' -> 58.27 Hz */
export function noteHz(name: string): number {
  const m = name.match(/^([A-G])([b#]?)(\d)$/);
  if (!m) throw new Error('Tên nốt không hợp lệ: ' + name);
  const semi = SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  const midi = 12 * (parseInt(m[3], 10) + 1) + semi;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

interface MoodSpec {
  chords: string[][];      // mỗi hợp âm 4 nốt (trầm -> cao)
  chordSeconds: number;    // mỗi hợp âm kéo dài
  crossfade: number;       // giây chuyển hợp âm
  lowpass: number;         // Hz – độ "ấm"
  noteAmps: number[];      // biên độ từng nốt
  pulseBpm?: number;       // có nhịp nhấp nhô nhẹ
  /** Nâng các nốt trên lên 1 quãng tám cho nghe rõ trên loa điện thoại (giữ nốt trầm) */
  brightVoicing: boolean;
  gain: number;
  echo: string;            // aecho: in_gain:out_gain:delays:decays
}

export const MOODS: Record<MusicMood, MoodSpec> = {
  calm: {
    chords: [['A2', 'C3', 'E3', 'A3'], ['F2', 'A2', 'C3', 'F3'], ['C3', 'E3', 'G3', 'C4'], ['G2', 'B2', 'D3', 'G3']],
    chordSeconds: 8, crossfade: 3, lowpass: 1800, brightVoicing: true, noteAmps: [1, 0.8, 0.7, 0.45], gain: 0.24,
    echo: '0.8:0.6:120|230:0.35|0.25',
  },
  warm: {
    chords: [['C3', 'E3', 'G3', 'C4'], ['A2', 'C3', 'E3', 'A3'], ['F2', 'A2', 'C3', 'F3'], ['G2', 'B2', 'D3', 'G3']],
    chordSeconds: 7, crossfade: 2.5, lowpass: 2400, brightVoicing: true, noteAmps: [0.9, 0.85, 0.8, 0.6], gain: 0.24,
    echo: '0.8:0.55:90|180:0.3|0.2',
  },
  cinematic: {
    chords: [['D2', 'A2', 'D3', 'F3'], ['Bb1', 'F2', 'Bb2', 'D3'], ['F2', 'C3', 'F3', 'A3'], ['C2', 'G2', 'C3', 'E3']],
    chordSeconds: 10, crossfade: 4, lowpass: 1100, brightVoicing: false, noteAmps: [1.2, 0.9, 0.6, 0.4], gain: 0.22,
    echo: '0.8:0.7:200|380:0.45|0.35',
  },
  upbeat: {
    chords: [['C3', 'E3', 'G3', 'C4'], ['G2', 'B2', 'D3', 'G3'], ['A2', 'C3', 'E3', 'A3'], ['F2', 'A2', 'C3', 'F3']],
    chordSeconds: 4, crossfade: 0.8, lowpass: 2800, brightVoicing: true, noteAmps: [0.9, 0.8, 0.75, 0.65], pulseBpm: 105, gain: 0.26, // 16s x 105 BPM = đúng 28 nhịp -> lặp liền mạch
    echo: '0.8:0.5:60|120:0.25|0.18',
  },
};

/** Độ dài 1 vòng lặp (giây) */
export function loopSeconds(mood: MusicMood): number {
  const m = MOODS[mood];
  return m.chords.length * m.chordSeconds;
}

const f = (n: number) => n.toFixed(4);

/**
 * Biểu thức aevalsrc cho 1 kênh (detune/lfo khác nhau giữa trái - phải để nghe rộng hơn).
 * Mọi tần số được làm tròn để 1 vòng lặp chứa đúng SỐ NGUYÊN chu kỳ -> nối vòng lặp không bị tiếng "tách".
 */
export function buildChannelExpr(mood: MusicMood, detune: number, lfoHz: number): string {
  const m = MOODS[mood];
  const n = m.chords.length;
  const L = m.chordSeconds;
  const loop = n * L;
  const fq = (hz: number) => Math.max(1, Math.round(hz * loop)) / loop;

  const selector = (idx: string, noteIdx: number, mul: number) => {
    const oct = m.brightVoicing && noteIdx >= 1 ? 2 : 1;
    let expr = f(fq(noteHz(m.chords[n - 1][noteIdx]) * mul * oct));
    for (let k = n - 2; k >= 0; k--) expr = `if(eq(${idx},${k}),${f(fq(noteHz(m.chords[k][noteIdx]) * mul * oct))},${expr})`;
    return expr;
  };
  const pad = (idx: string) =>
    m.noteAmps
      .map((a, j) => `${f(a)}*(sin(2*PI*${selector(idx, j, 1)}*t)+0.5*sin(2*PI*${selector(idx, j, detune)}*t))`)
      .join('+');

  const cur = `mod(floor(t/${L}),${n})`;
  const prv = `mod(floor(t/${L})+${n - 1},${n})`;
  const win = `(0.5-0.5*cos(PI*min(1,mod(t,${L})/${m.crossfade})))`;
  const lfo = `(0.85+0.15*sin(2*PI*${f(fq(lfoHz))}*t))`;
  const pulse = m.pulseBpm ? `(0.7+0.3*pow(sin(PI*t*${m.pulseBpm}/60),2))*` : '';
  return `${f(m.gain)}*${pulse}${lfo}*(${win}*(${pad(cur)})+(1-${win})*(${pad(prv)}))`;
}

/** Tạo file WAV (1 vòng lặp liền mạch) cho phong cách nhạc đã chọn */
export async function generateMusicFile(
  mood: MusicMood,
  outPath: string,
  signal?: AbortSignal,
): Promise<number> {
  const m = MOODS[mood];
  const loop = loopSeconds(mood);
  const left = buildChannelExpr(mood, 1.004, 0.06);
  const right = buildChannelExpr(mood, 0.997, 0.05);

  // Tạo 2 vòng rồi lấy vòng thứ 2: phần vang (echo) của vòng 1 đã "thấm" vào đầu vòng 2
  // nên khi lặp lại không bị hụt tiếng ở chỗ nối.
  const chain = [
    `lowpass=f=${m.lowpass}`,
    `aecho=${m.echo}`,
    'alimiter=limit=0.9',
    'aresample=48000',
    `atrim=${loop}:${loop * 2}`,
    'asetpts=PTS-STARTPTS',
  ].join(',');

  await runFfmpeg(FFMPEG, [
    // +1 giây dư ở cuối để phần cắt không dính méo ở biên của bộ đổi tần số
    '-f', 'lavfi', '-i', `aevalsrc=exprs='${left}|${right}':s=12000:d=${loop * 2 + 1}`,
    '-af', chain,
    '-c:a', 'pcm_s16le', '-ar', '48000',
    outPath,
  ], { signal });
  return loop;
}

/**
 * Lấy file nhạc theo phong cách; chỉ tạo lần đầu, các lần sau dùng lại từ bộ nhớ đệm.
 * (cacheDir nằm ngoài thư mục job nên không bị xóa khi dọn dẹp)
 */
export async function getMusicFile(
  mood: MusicMood,
  cacheDir: string,
  signal?: AbortSignal,
): Promise<string> {
  fs.mkdirSync(cacheDir, { recursive: true });
  const target = path.join(cacheDir, `music_${mood}_v1.wav`);
  if (fs.existsSync(target) && fs.statSync(target).size > 100_000) return target;
  const tmp = target + `.${process.pid}.tmp.wav`;
  await generateMusicFile(mood, tmp, signal);
  fs.renameSync(tmp, target);
  return target;
}
