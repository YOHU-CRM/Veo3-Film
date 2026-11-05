/**
 * [MỚI] voiceHandoff.ts — Voice tạo trong app luôn đi kèm lời thoại (không cần AI nghe lại).
 *  - rememberVoiceText: lưu lời thoại theo kích thước file voice (tải về rồi đưa vào Dựng phim vẫn nhận lại được)
 *  - findVoiceText: tìm lời thoại của file voice theo kích thước
 *  - sendVoiceToEditor / takePendingVoice: nút "Gửi sang Dựng phim" chuyển voice + lời thoại trong 1 bước
 */
const STORE_KEY = 'yohu_voice_texts_v1';
const MAX_ITEMS = 30;

interface VoiceTextItem { size: number; text: string; at: number }

function readStore(): VoiceTextItem[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** [MỚI] Lưu lời thoại của voice vừa tạo (khoá = số byte của file) */
export function rememberVoiceText(size: number, text: string): void {
  if (!size || !text.trim()) return;
  try {
    const list = readStore().filter((x) => x.size !== size);
    list.unshift({ size, text: text.trim(), at: Date.now() });
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, MAX_ITEMS)));
  } catch {
    // bộ nhớ trình duyệt bị chặn → bỏ qua
  }
}

/** [MỚI] Tìm lời thoại của file voice theo số byte (file tải về giữ nguyên số byte) */
export function findVoiceText(size: number): string | undefined {
  return readStore().find((x) => x.size === size)?.text;
}

export interface PendingVoice { file: File; text: string }
let pending: PendingVoice | null = null;
export const VOICE_HANDOFF_EVENT = 'yohu-voice-handoff';

/** [MỚI] Gửi voice + lời thoại sang mục Dựng phim */
export function sendVoiceToEditor(blob: Blob, text: string, name = 'generated_voice.wav'): void {
  const file = blob instanceof File ? blob : new File([blob], name, { type: blob.type || 'audio/wav' });
  pending = { file, text };
  rememberVoiceText(file.size, text);
  try {
    window.dispatchEvent(new CustomEvent(VOICE_HANDOFF_EVENT));
  } catch {
    // bỏ qua
  }
}

/** [MỚI] Mục Dựng phim nhận voice đang chờ (lấy 1 lần) */
export function takePendingVoice(): PendingVoice | null {
  const p = pending;
  pending = null;
  return p;
}
