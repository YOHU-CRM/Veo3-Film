
import { VideoMode, AspectRatio, Resolution } from '@/enums';
import { generateVideoByEngine } from './videoEngines';

export interface GenerationParams {
  prompt: string;
  mode: VideoMode;
  aspectRatio: AspectRatio;
  resolution: Resolution;
  image?: string;
  imageStart?: string;
  imageEnd?: string;
  consistencyImages?: string[];
  apiKey?: string;
  engine: string;
  onProgress: (progress: number, status: string) => void;
}

export const runGenerationTask = async (params: GenerationParams): Promise<{url: string, error?: string}> => {
  const { prompt, apiKey, engine, onProgress } = params;
  
  onProgress(10, "Mở kết nối...");
  try {
    const url = await generateVideoByEngine({
      prompt,
      engine: engine as any,
      apiKey,
      aspectRatio: params.aspectRatio,
      onProgress
    });
    return { url };
  } catch (err: any) {
    return { url: "", error: err.message };
  }
};

export const requestVideoGeneration = async (params: {
  prompts: string[],
  aspectRatio: AspectRatio,
  resolution: Resolution,
  apiKey?: string,
  engine: string,
  onProgress: (progress: number, status: string) => void
}) => {
  // Simple implementation for full video: generate first part
  return runGenerationTask({
    prompt: params.prompts.join(" "),
    mode: 'TEXT_TO_VIDEO' as VideoMode,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    apiKey: params.apiKey,
    engine: params.engine,
    onProgress: params.onProgress
  });
};
