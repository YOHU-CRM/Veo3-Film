/**
 * Bridge service between YOHU BUILD (building-2026.vercel.app) and Google-Veo3 Studio
 */
import { generateGeminiVoice, generateVeoVideo } from './gemini';
import { AspectRatio, Resolution, VideoMode } from '../types';

export interface ProjectOrderPayload {
  secretToken?: string;
  projectId?: string;
  customerName: string;
  birthYear?: string;
  element?: string;        // Mệnh phong thủy (ví dụ: Thiên Thượng Hỏa)
  direction?: string;      // Hướng tốt (ví dụ: Nam - Sinh Khí)
  buildingType?: string;   // Biệt thự, Nhà phố, Căn hộ...
  packageType?: string;    // 'TEASER' | 'STANDARD' | 'ADVANCED' | 'CINEMATIC'
  images?: string[];       // Ảnh phối cảnh 3D / Bản vẽ
  customNotes?: string;
}

export const buildArchitecturalPrompt = (payload: ProjectOrderPayload): string => {
  const { customerName, birthYear, element, direction, buildingType, packageType, customNotes } = payload;
  
  let cameraStyle = "Smooth cinematic drone fly-through, high-angle panoramic view, architectural presentation";
  if (packageType === 'STANDARD') {
    cameraStyle = "Smooth 360-degree exterior orbit camera, highlighting clean facades and landscape, golden hour light";
  } else if (packageType === 'ADVANCED') {
    cameraStyle = "Seamless walkthrough transition from exterior courtyard to spacious modern interior living room, day to evening light transition";
  } else if (packageType === 'CINEMATIC') {
    cameraStyle = "Hollywood master cinematography, dynamic drone reveal shot, photorealistic luxury architectural materials, lens flare, 8k resolution";
  }

  const prompt = `Cinematic architectural 3D visualization of modern ${buildingType || 'residence'} for owner ${customerName || 'Homeowner'}${birthYear ? ` (born ${birthYear})` : ''}.
Orientation: Facing ${direction || 'South with natural sunlight'}, Feng Shui element: ${element || 'Harmonious'}.
Camera Movement: ${cameraStyle}.
Visual Quality: Photorealistic architectural rendering, Unreal Engine 5 aesthetic, natural ambient lighting, ultra-crisp textures, 8k detail.
${customNotes ? `Client Notes: ${customNotes}` : ''}`;

  return prompt;
};

export const buildArchitecturalVoiceScript = (payload: ProjectOrderPayload): string => {
  const { customerName, birthYear, element, direction, buildingType } = payload;
  
  return `Kính chào gia chủ ${customerName || 'quý khách'}${birthYear ? ` - sinh năm ${birthYear}` : ''}. 
Trân trọng giới thiệu phương án thiết kế kiến trúc ${buildingType || 'công trình hiện đại'}, được quy hoạch chuẩn phong thủy${element ? ` theo bản mệnh ${element}` : ''}, tọa lạc tại cung hướng ${direction || 'đắc tài lộc'}.
Không gian sống được tối ưu hóa ánh sáng tự nhiên, mang lại vượng khí, bình an và thịnh vượng trường tồn cho gia đình.`;
};

export const processProjectOrder = async (
  payload: ProjectOrderPayload,
  apiKeys: string[] = [],
  onProgress?: (msg: string) => void
) => {
  onProgress?.("Đang khởi tạo kịch bản kiến trúc & phong thủy...");
  const prompt = buildArchitecturalPrompt(payload);
  const voiceScript = buildArchitecturalVoiceScript(payload);

  onProgress?.("Đang khởi tạo giọng đọc thuyết minh Gemini 3.8 Flash TTS...");
  const voiceBase64 = await generateGeminiVoice(
    voiceScript,
    'vi-VN',
    'MALE',
    'STYLE_CINEMATIC',
    apiKeys,
    'VN',
    true,
    'QUALITY_PRO'
  );

  onProgress?.("Đang render video chuyển động kiến trúc 3D...");
  const videoResult = await generateVeoVideo({
    mode: payload.images && payload.images.length > 0 ? VideoMode.IMAGE_TO_VIDEO : VideoMode.TEXT_TO_VIDEO,
    prompt,
    images: payload.images || [],
    resolution: Resolution.R1080P,
    aspectRatio: AspectRatio.LANDSCAPE,
    onProgress,
    apiKeys,
    useProjectKey: true
  });

  return {
    prompt,
    voiceScript,
    voiceBase64,
    videoUrl: videoResult.finalUrl,
    videoRef: videoResult.videoRef
  };
};
