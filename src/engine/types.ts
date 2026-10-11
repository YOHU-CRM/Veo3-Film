import type { MusicMood, RenderSettings, MotionStyle } from '../../shared/render/types';

export type { MusicMood, RenderSettings, MotionStyle };

/** Một cảnh như giao diện đang giữ (clip + voice + chữ phụ đề) */
export interface EngineScene {
  id: string;
  /** 'video' (mặc định) hoặc 'image' (ảnh tĩnh -> chuyển động an toàn cho chữ; khi đó videoUrl = '') */
  kind?: 'video' | 'image';
  imageFile?: File;
  imageUrl?: string;
  imageDuration?: number;
  /** Thời lượng người dùng đặt (giây): ưu tiên số 1 */
  userDuration?: number;
  motionStyle?: MotionStyle;
  videoFile?: File;
  videoUrl: string;
  videoName: string;
  videoDuration: number;
  videoWidth: number;
  videoHeight: number;
  voiceFile?: File;
  voiceUrl?: string;
  voiceName?: string;
  voiceDuration?: number;
  subtitleText?: string;
}

export interface RenderRequest {
  scenes: EngineScene[];
  settings: RenderSettings;
  bgm?: { url: string; name: string };
  /** Nhạc nền tự tạo bằng máy dựng (chỉ dùng khi không có bgm tải lên) */
  generatedMusic?: MusicMood | null;
}

export interface RenderCallbacks {
  onProgress: (percent: number, message: string) => void;
  signal: AbortSignal;
}

export interface RenderResult {
  engine: 'server' | 'browser';
  /** Dùng cho <video src> */
  url: string;
  /** Dùng cho nút tải về (nhận tên file mong muốn, không gồm đuôi) */
  downloadUrl: (fileName: string) => string;
  extension: 'mp4' | 'webm';
  duration: number;
  sizeMB: number;
  width: number;
  height: number;
  warnings: string[];
  /** Giải phóng tài nguyên (xóa file tạm trên máy dựng / thu hồi blob) */
  dispose: () => void;
}

export interface EngineHealth {
  ok: boolean;
  ffmpeg: string;
  subtitles: boolean;
  /** máy dựng có xử lý được cảnh ảnh không */
  images: boolean;
  cpus: number;
  baseUrl: string;
}

/** Lỗi có nội dung thân thiện, hiển thị thẳng cho người dùng */
export class EngineError extends Error {}
export class RenderCancelled extends Error {
  constructor() { super('Đã hủy dựng phim.'); }
}
