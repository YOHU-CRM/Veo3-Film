/**
 * Gọi MÁY DỰNG (render-server, FFmpeg). Chạy trên máy cá nhân hôm nay,
 * đổi sang VPS sau này chỉ cần đổi địa chỉ (VITE_RENDER_SERVER_URL hoặc localStorage).
 */
import type { JobInfo, RenderManifest } from '../../shared/render/types';
import {
  EngineError, RenderCancelled,
  type EngineHealth, type RenderCallbacks, type RenderRequest, type RenderResult,
} from './types';

const DEFAULT_URL = 'http://127.0.0.1:5055';

export function getEngineUrl(): string {
  try {
    const saved = localStorage.getItem('yohu_render_server_url');
    if (saved) return saved.replace(/\/+$/, '');
  } catch { /* localStorage bị chặn */ }
  const env = (import.meta.env?.VITE_RENDER_SERVER_URL as string | undefined) || DEFAULT_URL;
  return env.replace(/\/+$/, '');
}

function getToken(): string {
  try {
    const saved = localStorage.getItem('yohu_render_server_token');
    if (saved) return saved;
  } catch { /* bỏ qua */ }
  return (import.meta.env?.VITE_RENDER_SERVER_TOKEN as string | undefined) || '';
}

function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function withToken(url: string): string {
  const t = getToken();
  if (!t) return url;
  return url + (url.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(t);
}

/** Kiểm tra máy dựng có đang chạy không. Trả null nếu không kết nối được. */
export async function pingEngine(timeoutMs = 1500): Promise<EngineHealth | null> {
  const baseUrl = getEngineUrl();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: ctrl.signal, headers: authHeaders() });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j?.ok || j.engine !== 'yohu-ffmpeg') return null;
    return { ok: true, ffmpeg: String(j.ffmpeg || ''), subtitles: !!j.subtitles, images: !!j.images, cpus: Number(j.cpus) || 1, baseUrl };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function toBlob(file: File | undefined, url: string | undefined): Promise<Blob> {
  if (file) return file;
  if (!url) throw new EngineError('Thiếu dữ liệu file.');
  const res = await fetch(url);
  return res.blob();
}

function upload(
  baseUrl: string,
  form: FormData,
  signal: AbortSignal,
  onUploadProgress: (fraction: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${baseUrl}/jobs`);
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onUploadProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let body: any = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* không phải JSON */ }
      if (xhr.status === 202 && body?.id) return resolve(String(body.id));
      reject(new EngineError(body?.error || `Máy dựng từ chối yêu cầu (mã ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new EngineError('Mất kết nối với máy dựng khi tải file lên. Hãy kiểm tra máy dựng còn chạy không.'));
    xhr.onabort = () => reject(new RenderCancelled());
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function renderRemote(req: RenderRequest, cb: RenderCallbacks): Promise<RenderResult> {
  const baseUrl = getEngineUrl();
  const scenes = req.scenes;

  const manifest: RenderManifest = {
    settings: req.settings,
    hasBgm: !!req.bgm && req.settings.enableBgm,
    generatedMusic: !req.bgm && req.settings.enableBgm ? (req.generatedMusic ?? null) : null,
    bgmName: req.bgm?.name,
    scenes: scenes.map(s => ({
      id: s.id,
      kind: s.kind === 'image' ? 'image' as const : 'video' as const,
      hasVideo: s.kind !== 'image' && !!s.videoUrl,
      hasImage: s.kind === 'image' && !!s.imageUrl,
      imageDuration: s.kind === 'image' ? s.imageDuration : undefined,
      userDuration: s.userDuration,
      motionStyle: s.kind === 'image' ? s.motionStyle : undefined,
      imageName: s.kind === 'image' ? s.videoName : undefined,
      hasVoice: !!s.voiceUrl || !!s.voiceFile,
      subtitleText: s.subtitleText,
      videoName: s.videoName,
      voiceName: s.voiceName,
    })),
  };

  cb.onProgress(1, 'Đang chuẩn bị file gửi sang máy dựng...');
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  for (const s of scenes) {
    if (s.kind === 'image') { if (s.imageUrl) form.append(`i_${s.id}`, await toBlob(s.imageFile, s.imageUrl), s.videoName || 'image.png'); }
    else if (s.videoUrl) form.append(`v_${s.id}`, await toBlob(s.videoFile, s.videoUrl), s.videoName || 'video.mp4');
    if (s.voiceUrl || s.voiceFile) form.append(`a_${s.id}`, await toBlob(s.voiceFile, s.voiceUrl), s.voiceName || 'voice.wav');
  }
  if (manifest.hasBgm && req.bgm) form.append('bgm', await toBlob(undefined, req.bgm.url), req.bgm.name || 'bgm.mp3');

  const jobId = await upload(baseUrl, form, cb.signal, f => {
    cb.onProgress(2 + Math.round(f * 8), `Đang chuyển file sang máy dựng... ${Math.round(f * 100)}%`);
  });

  const cancelRemote = () => { void fetch(`${baseUrl}/jobs/${jobId}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {}); };
  cb.signal.addEventListener('abort', cancelRemote, { once: true });

  let failures = 0;
  for (;;) {
    if (cb.signal.aborted) { cancelRemote(); throw new RenderCancelled(); }
    await sleep(700);

    let info: JobInfo;
    try {
      const res = await fetch(`${baseUrl}/jobs/${jobId}`, { headers: authHeaders(), signal: cb.signal });
      if (res.status === 404) throw new EngineError('Máy dựng đã bị khởi động lại hoặc tác vụ đã hết hạn. Hãy bấm TẠO PHIM lại.');
      info = await res.json();
      failures = 0;
    } catch (e: any) {
      if (e instanceof EngineError) throw e;
      if (cb.signal.aborted) throw new RenderCancelled();
      if (++failures >= 20) throw new EngineError('Mất kết nối với máy dựng. Hãy kiểm tra máy dựng còn chạy không rồi thử lại.');
      continue;
    }

    cb.onProgress(10 + Math.round(info.percent * 0.9), info.message);

    if (info.status === 'error') throw new EngineError(info.error || 'Máy dựng gặp lỗi.');
    if (info.status === 'cancelled') throw new RenderCancelled();
    if (info.status === 'done' && info.result) {
      const base = `${baseUrl}/jobs/${jobId}/result`;
      return {
        engine: 'server',
        url: withToken(base),
        downloadUrl: name => withToken(`${base}?download=1&name=${encodeURIComponent(name)}`),
        extension: 'mp4',
        duration: info.result.duration,
        sizeMB: info.result.sizeMB,
        width: info.result.width,
        height: info.result.height,
        warnings: info.warnings,
        dispose: cancelRemote,
      };
    }
  }
}
