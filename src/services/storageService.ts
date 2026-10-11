
import { BatchResult } from '@/types';
import { VideoMode } from '@/enums';

export const getGeminiKeys = (): string[] => {
  const saved = localStorage.getItem('veopro_api_keys');
  if (!saved) return [];
  try {
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const getStoredBatchResults = (): BatchResult[] => {
  const saved = localStorage.getItem('veopro_batch_results');
  return saved ? JSON.parse(saved) : [];
};

export const saveStoredBatchResults = (results: BatchResult[]) => {
  localStorage.setItem('veopro_batch_results', JSON.stringify(results));
};

export const getModePrompts = (): Record<VideoMode, string> => {
  const saved = localStorage.getItem('veopro_mode_prompts');
  const defaults: Record<VideoMode, string> = {
    [VideoMode.TEXT_TO_VIDEO]: '',
    [VideoMode.IMAGE_TO_VIDEO]: '',
    [VideoMode.INTERPOLATION]: '',
    [VideoMode.CONSISTENCY]: ''
  };
  try {
    if (!saved) return defaults as any;
    const parsed = JSON.parse(saved);
    return { ...defaults, ...parsed };
  } catch {
    return defaults as any;
  }
};

export const saveModePrompts = (prompts: Record<VideoMode, string>) => {
  localStorage.setItem('veopro_mode_prompts', JSON.stringify(prompts));
};

export const getModeImages = (): Record<VideoMode, {url: string, name: string}[]> => {
  const saved = localStorage.getItem('veopro_mode_images');
  const defaults: Record<VideoMode, {url: string, name: string}[]> = {
    [VideoMode.TEXT_TO_VIDEO]: [],
    [VideoMode.IMAGE_TO_VIDEO]: [],
    [VideoMode.INTERPOLATION]: [],
    [VideoMode.CONSISTENCY]: []
  };
  try {
    if (!saved) return defaults as any;
    const parsed = JSON.parse(saved);
    return { ...defaults, ...parsed };
  } catch {
    return defaults as any;
  }
};

export const saveModeImages = (images: Record<VideoMode, {url: string, name: string}[]>) => {
  localStorage.setItem('veopro_mode_images', JSON.stringify(images));
};
