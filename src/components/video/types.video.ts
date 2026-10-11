
import { UserProfile } from '../../types';

export const ToolMode = {
  NONE: 'NONE',
  STORY_DNA: 'STORY_DNA',
  SEAMLESS_FLOW: 'SEAMLESS_FLOW',
  BATCH_IMAGE_GEN: 'BATCH_IMAGE_GEN',
  IMAGE_GEN: 'IMAGE_GEN',
  AUTO_VIDEO: 'AUTO_VIDEO'
} as const;
export type ToolMode = typeof ToolMode[keyof typeof ToolMode];

export const VIDEO_ENGINES = [
  { id: 'veo', name: 'GOOGLE-Veo 3.1 Fast', pricePerSec: 0.09, provider: 'GOOGLE', logoBg: 'bg-blue-600' },
  { id: 'seedance', name: 'BYTEDANCE Seedance Fast', pricePerSec: 0.022, provider: 'BYTEDANCE', logoBg: 'bg-[#2AF5FF]' },
  { id: 'kling', name: 'KUAISHOU-Kling 3.0', pricePerSec: 0.15, provider: 'KUAISHOU', logoBg: 'bg-[#FF7752]' }
];

export const FILM_STYLES = [
  { id: 'hollywood', name: { VN: '🎬 Hollywood (Mặc định)', EN: '🎬 Hollywood (Default)' }, prompt: 'Cinematic Hollywood movie style, high budget production, detailed textures, professional color grading' },
  { id: 'action', name: { VN: '💥 Hành động (Action)', EN: '💥 Action' }, prompt: 'High-octane action movie style, dynamic camera angles, intense lighting, gritty textures' },
  { id: 'horror', name: { VN: '👻 Kinh dị (Horror)', EN: '👻 Horror' }, prompt: 'Dark horror movie aesthetic, eerie atmosphere, high contrast shadows, suspenseful lighting, desaturated colors' },
  { id: 'scifi', name: { VN: '🚀 Viễn tưởng (Sci-Fi)', EN: '🚀 Sci-Fi' }, prompt: 'Futuristic science fiction style, advanced technology, neon accents, sleek surfaces, cosmic lighting' },
  { id: 'romance', name: { VN: '💖 Lãng mạn (Romance)', EN: '💖 Romance' }, prompt: 'Soft romantic film aesthetic, warm golden hour lighting, shallow depth of field, dreamy atmosphere' },
  { id: 'fantasy', name: { VN: '🧙 Phép thuật (Fantasy)', EN: '🧙 Fantasy' }, prompt: 'Epic fantasy movie style, magical atmosphere, ethereal lighting, mythical creatures, rich textures' },
  { id: 'mystery', name: { VN: '🔍 Bí ẩn (Mystery)', EN: '🔍 Mystery' }, prompt: 'Suspenseful mystery film noir style, low-key lighting, foggy atmosphere, sharp focus on details' },
  { id: 'war', name: { VN: '🎖️ Chiến tranh (War)', EN: '🎖️ War' }, prompt: 'Gritty war movie aesthetic, desaturated colors, handheld camera feel, smoke and debris, intense realism' },
  { id: 'western', name: { VN: '🤠 Miền Tây (Western)', EN: '🤠 Western' }, prompt: 'Classic Western film style, dusty atmosphere, warm sepia tones, wide landscape shots, high noon lighting' },
  { id: 'musical', name: { VN: '🎶 Nhạc kịch (Musical)', EN: '🎶 Musical' }, prompt: 'Vibrant musical film style, theatrical lighting, colorful costumes, dynamic stage-like compositions' },
  { id: 'documentary', name: { VN: '📹 Tài liệu (Documentary)', EN: '📹 Documentary' }, prompt: 'Realistic documentary style, natural lighting, handheld camera, authentic textures, raw feel' },
  { id: 'anime', name: { VN: '🇯🇵 Anime Studio Ghibli', EN: '🇯🇵 Anime Ghibli' }, prompt: 'Studio Ghibli anime style, hand-drawn aesthetic, soft natural lighting, vibrant colors' },
  { id: 'disney', name: { VN: '🏰 Disney/Pixar 3D', EN: '🏰 Disney/Pixar 3D' }, prompt: 'Disney Pixar 3D animation style, expressive characters, smooth surfaces, whimsical lighting' },
  { id: 'vintage', name: { VN: '🎞️ Vintage 1970s', EN: '🎞️ Vintage 1970s' }, prompt: 'Vintage 1970s film style, grainy texture, warm retro colors, slight lens flare' },
  { id: 'noir', name: { VN: '🌑 Film Noir (B&W)', EN: '🌑 Film Noir (B&W)' }, prompt: 'Classic Film Noir style, black and white, high contrast, dramatic shadows, moody atmosphere' },
  { id: 'cyberpunk', name: { VN: '🌃 Cyberpunk Neon', EN: '🌃 Cyberpunk Neon' }, prompt: 'Cyberpunk cinematic style, neon lighting, futuristic atmosphere, high tech detail' },
  { id: 'k-drama', name: { VN: '🇰🇷 K-Drama Aesthetic', EN: '🇰🇷 K-Drama Aesthetic' }, prompt: 'Korean Drama aesthetic, clean soft lighting, pastel color palette, romantic atmosphere' }
];

export const FILM_GENRES = [
  { id: 'review', name: { VN: '🎬 Review: Phim, Sản phẩm, Dịch vụ, So sánh, Unboxing', EN: '🎬 Review: Movie, Product, Service, Comparison, Unboxing' } },
  { id: 'vlog', name: { VN: '📹 Vlog: Daily, Travel, Behind scenes, Một ngày làm việc', EN: '📹 Vlog: Daily, Travel, Behind scenes, A working day' } },
  { id: 'livestream', name: { VN: '📡 Livestream: Q&A, Talkshow, Bán hàng, Gaming', EN: '📡 Livestream: Q&A, Talkshow, Sales, Gaming' } },
  { id: 'love_story', name: { VN: '💖 Kể chuyện – Chủ đề Tình Yêu', EN: '💖 Storytelling – Love Theme' } },
  { id: 'action', name: { VN: '💥 Hành động', EN: '💥 Action' } },
  { id: 'comedy', name: { VN: '😂 Hài hước', EN: '😂 Comedy' } },
  { id: 'drama', name: { VN: '🎭 Tâm lý', EN: '🎭 Drama' } },
  { id: 'horror', name: { VN: '👻 Kinh dị', EN: '👻 Horror' } },
  { id: 'sci-fi', name: { VN: '🚀 Viễn tưởng', EN: '🚀 Sci-Fi' } },
  { id: 'romance', name: { VN: '💖 Lãng mạn', EN: '💖 Romance' } },
  { id: 'thriller', name: { VN: '🔪 Giật gân', EN: '🔪 Thriller' } },
  { id: 'fantasy', name: { VN: '🧙 Phép thuật', EN: '🧙 Fantasy' } },
  { id: 'animation', name: { VN: '🎨 Hoạt hình', EN: '🎨 Animation' } },
  { id: 'documentary', name: { VN: '🎥 Tài liệu', EN: '🎥 Documentary' } },
];

export interface VideoStateProps {
  credit: number;
  email: string;
  userPlan: string;
  profile: UserProfile;
  apiKeys: string[];
  hasApiKey: boolean;
  outputLanguage: 'VN' | 'EN';
  onKeyError: () => void;
  onOpenPricing: () => void;
  onOpenKeyPicker: () => void;
  onRefreshCredits: () => Promise<void>;
  setOutputLanguage: (lang: 'VN' | 'EN') => void;
}
