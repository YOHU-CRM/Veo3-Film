import { FFMPEG, FFPROBE } from './binaries';
import { runProcess } from './proc';

export interface MediaInfo {
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number;
  height: number;
}

/** Đọc thông tin file. Trả null nếu file hỏng / không đọc được. */
export async function probeMedia(file: string, signal?: AbortSignal): Promise<MediaInfo | null> {
  let res;
  try {
    res = await runProcess(
      FFPROBE,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { signal, collectStdout: true },
    );
  } catch (e: any) {
    if (e?.message === 'ABORTED') throw e;
    return null;
  }
  if (res.code !== 0) return null;

  let json: any;
  try { json = JSON.parse(res.stdout); } catch { return null; }

  const streams: any[] = json.streams ?? [];
  const video = streams.find(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find(s => s.codec_type === 'audio');
  if (!video && !audio) return null;

  let width = 0;
  let height = 0;
  if (video) {
    width = Number(video.width) || 0;
    height = Number(video.height) || 0;
    const rot = Number(
      video.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? video.tags?.rotate ?? 0,
    );
    if (Math.abs(rot) % 180 === 90) [width, height] = [height, width];
    if (width <= 0 || height <= 0) return null;
  }

  let duration = parseFloat(json.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) duration = parseFloat((video ?? audio)?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    // Một số file (WebM ghi từ trình duyệt) không có thời lượng trong header -> đo bằng cách đọc hết file
    const measured = await measureDuration(file, signal);
    if (!measured) return null;
    duration = measured;
  }

  return { duration, hasVideo: !!video, hasAudio: !!audio, width, height };
}

async function measureDuration(file: string, signal?: AbortSignal): Promise<number | null> {
  let last = 0;
  try {
    const res = await runProcess(
      FFMPEG,
      ['-v', 'error', '-nostats', '-progress', 'pipe:1', '-i', file, '-f', 'null', '-'],
      {
        signal,
        onStdoutLine: line => {
          const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
          if (m) last = Math.max(last, parseInt(m[1], 10) / 1_000_000);
        },
      },
    );
    if (res.code !== 0) return null;
  } catch (e: any) {
    if (e?.message === 'ABORTED') throw e;
    return null;
  }
  return last > 0 ? last : null;
}
