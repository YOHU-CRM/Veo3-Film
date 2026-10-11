/**
 * Kiểu dữ liệu dùng CHUNG giữa giao diện (src/) và máy dựng (render-server/).
 * Chỉ chứa kiểu + hằng số thuần, không phụ thuộc trình duyệt hay Node.
 */

import type { MotionStyle } from '../imageMotion/plan';
export type { MotionStyle };

export type AspectRatioOpt = 'original' | '16:9' | '9:16' | '1:1';
export type FitMode = 'blur' | 'cover' | 'contain';
export type QualityOpt = 'original' | '720p' | '1080p' | '4k';
export type SubtitleStyle = 'yellow_stroke' | 'white_box';

export interface RenderSettings {
  aspectRatio: AspectRatioOpt;
  fitMode: FitMode;
  quality: QualityOpt;
  enableSubtitles: boolean;
  subtitleStyle: SubtitleStyle;
  enableBgm: boolean;
  /** 0 - 100: âm lượng nhạc nền khi KHÔNG có voice */
  bgmVolume: number;
}

/** Thông tin 1 cảnh đã đọc xong (kích thước, thời lượng) – dùng để lập timeline. */
export interface SceneSpec {
  id: string;
  /** 'video' (mặc định) hoặc 'image' (ảnh tĩnh -> chuyển động an toàn cho chữ) */
  kind?: 'video' | 'image';
  /** cảnh ảnh không có voice: số giây hiển thị */
  imageDuration?: number;
  videoDuration: number;
  videoWidth: number;
  videoHeight: number;
  voiceDuration?: number;
  subtitleText?: string;
}

export interface SubtitleCue {
  /** Giây, tính từ đầu CẢNH */
  start: number;
  end: number;
  text: string;
}

export interface TimelineScene {
  id: string;
  index: number;
  /** Giây, tính từ đầu PHIM */
  start: number;
  duration: number;
  frames: number;
  /** Clip ngắn hơn cảnh -> lặp lại clip cho đủ */
  loop: boolean;
  /** Có voice: giây tính từ đầu cảnh; không có: null */
  voiceOffset: number | null;
  voiceDuration: number;
  cues: SubtitleCue[];
}

export interface Timeline {
  scenes: TimelineScene[];
  totalDuration: number;
  width: number;
  height: number;
  fps: number;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface JobInfo {
  id: string;
  status: JobStatus;
  percent: number;
  /** Chữ thân thiện hiển thị cho người dùng */
  message: string;
  warnings: string[];
  error?: string;
  result?: {
    duration: number;
    sizeMB: number;
    width: number;
    height: number;
  };
}

/** Manifest gửi kèm khi upload. Tên field file: v_<id> (video), i_<id> (ảnh), a_<id> (voice), bgm */
export interface RenderManifest {
  settings: RenderSettings;
  scenes: Array<{
    id: string;
    kind?: 'video' | 'image';
    hasVideo: boolean;
    /** cảnh ảnh: file gửi kèm với tên field i_<id> */
    hasImage?: boolean;
    imageDuration?: number;
    motionStyle?: MotionStyle;
    imageName?: string;
    hasVoice: boolean;
    subtitleText?: string;
    /** Tên file gốc, chỉ để báo lỗi dễ hiểu */
    videoName?: string;
    voiceName?: string;
  }>;
  hasBgm: boolean;
  bgmName?: string;
}
