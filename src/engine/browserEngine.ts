/**
 * Bộ dựng DỰ PHÒNG chạy ngay trong trình duyệt (không cần cài gì).
 * Dùng khi máy dựng FFmpeg chưa bật. Hạn chế: dựng theo thời gian thực
 * (phim 5 phút = chờ 5 phút), phải giữ tab mở và đang hiển thị.
 *
 * Mọi quyết định về thời lượng / phụ đề / kích thước lấy từ shared/render/plan.ts
 * nên khớp với máy dựng FFmpeg.
 */
import { buildTimeline } from '../../shared/render/plan';
import type { SceneSpec, SubtitleStyle, TimelineScene } from '../../shared/render/types';
import { RenderCancelled, EngineError, type RenderCallbacks, type RenderRequest, type RenderResult } from './types';
import { ImageMotionScene, createBackdrop, drawImageSceneFrame, defaultCanvasFactory } from '../../shared/imageMotion';
import { prepareImageFromUrl } from './imageCache';

const DUCK_LEVEL = 0.45;      // nhạc nền chỉ hạ còn ~45% khi có giọng đọc (trước đây 22%: quá nhỏ)

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines = 3): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines - 1);
    head.push(lines.slice(maxLines - 1).join(' '));
    return head;
  }
  return lines;
}

function drawSubtitle(
  ctx: CanvasRenderingContext2D,
  text: string,
  style: SubtitleStyle,
  W: number,
  H: number,
) {
  const fontSize = Math.round(Math.min(W, H) * 0.052);
  ctx.font = `bold ${fontSize}px "Be Vietnam Pro", "Outfit", "Inter", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const lines = wrapLines(ctx, text, W * 0.88);
  const lineH = fontSize * 1.25;
  const bottomMargin = H * (W / H < 0.8 ? 0.12 : 0.07);
  const firstY = H - bottomMargin - (lines.length - 1) * lineH - fontSize / 2;

  lines.forEach((line, i) => {
    const y = firstY + i * lineH;
    if (style === 'yellow_stroke') {
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(4, Math.round(fontSize * 0.18));
      ctx.strokeStyle = '#000000';
      ctx.strokeText(line, W / 2, y);
      ctx.fillStyle = '#FFE600';
      ctx.fillText(line, W / 2, y);
    } else {
      const padX = fontSize * 0.6;
      const boxW = ctx.measureText(line).width + padX * 2;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.beginPath();
      ctx.roundRect((W - boxW) / 2, y - lineH / 2, boxW, lineH, 10);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(line, W / 2, y);
    }
  });
}

function drawVideoFrame(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  fit: 'blur' | 'cover' | 'contain',
  W: number,
  H: number,
) {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);
  const vW = video.videoWidth || W;
  const vH = video.videoHeight || H;

  if (fit === 'cover') {
    const scale = Math.max(W / vW, H / vH);
    ctx.drawImage(video, (W - vW * scale) / 2, (H - vH * scale) / 2, vW * scale, vH * scale);
    return;
  }
  if (fit === 'blur') {
    ctx.save();
    ctx.filter = 'blur(30px) brightness(0.45)';
    ctx.drawImage(video, 0, 0, W, H);
    ctx.restore();
  }
  const scale = Math.min(W / vW, H / vH);
  ctx.drawImage(video, (W - vW * scale) / 2, (H - vH * scale) / 2, vW * scale, vH * scale);
}

function loadVideo(url: string): Promise<HTMLVideoElement | null> {
  return new Promise(resolve => {
    const el = document.createElement('video');
    el.muted = true;
    el.playsInline = true;
    el.loop = true; // clip ngắn hơn cảnh -> lặp lại (giống máy dựng FFmpeg)
    el.preload = 'auto';
    const timer = setTimeout(() => resolve(null), 20000);
    el.onloadeddata = () => { clearTimeout(timer); resolve(el); };
    el.onerror = () => { clearTimeout(timer); resolve(null); };
    el.src = url;
  });
}

export async function renderInBrowser(req: RenderRequest, cb: RenderCallbacks): Promise<RenderResult> {
  const warnings: string[] = [];
  const { settings } = req;

  const usable = req.scenes.filter((s, i) => {
    if (s.kind === 'image' ? !!s.imageUrl : !!s.videoUrl) return true;
    if (s.voiceUrl) warnings.push(`Cảnh ${i + 1}: có voice nhưng chưa có ${s.kind === 'image' ? 'ảnh' : 'video'} nên đã bỏ qua cảnh này.`);
    return false;
  });
  if (usable.length === 0) throw new EngineError('Không có video hợp lệ để dựng.');

  const specs: SceneSpec[] = usable.map(s => ({
    id: s.id,
    kind: s.kind === 'image' ? 'image' as const : 'video' as const,
    imageDuration: s.kind === 'image' ? s.imageDuration : undefined,
    userDuration: s.userDuration,
    subtitleCues: s.voiceUrl ? s.subtitleCues : undefined,
    videoDuration: s.videoDuration,
    videoWidth: s.videoWidth,
    videoHeight: s.videoHeight,
    voiceDuration: s.voiceUrl ? s.voiceDuration : undefined,
    subtitleText: s.subtitleText,
  }));
  const timeline = buildTimeline(specs, settings);
  const W = timeline.width;
  const H = timeline.height;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new EngineError('Trình duyệt không hỗ trợ vẽ video (Canvas 2D).');

  if (typeof MediaRecorder === 'undefined') {
    throw new EngineError('Trình duyệt này không hỗ trợ ghi video. Hãy dùng Chrome hoặc Edge, hoặc bật máy dựng.');
  }

  const AudioCtxClass: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
  const audioCtx = new AudioCtxClass();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  const audioDest = audioCtx.createMediaStreamDestination();

  let wakeLock: { release: () => Promise<void> } | null = null;
  try { wakeLock = await (navigator as any).wakeLock?.request('screen'); } catch { /* không hỗ trợ */ }

  let bgmEl: HTMLAudioElement | null = null;
  let bgmGain: GainNode | null = null;
  let bgmFade: GainNode | null = null; // mờ dần vào / ra (giống máy dựng FFmpeg)
  const bgmBase = Math.max(0, Math.min(1, settings.bgmVolume / 100));
  if (settings.enableBgm && req.bgm) {
    bgmEl = new Audio(req.bgm.url);
    bgmEl.loop = true;
    bgmEl.crossOrigin = 'anonymous';
    const src = audioCtx.createMediaElementSource(bgmEl);
    bgmGain = audioCtx.createGain();
    bgmGain.gain.value = bgmBase;
    bgmFade = audioCtx.createGain();
    bgmFade.gain.value = 0;
    src.connect(bgmGain);
    bgmGain.connect(bgmFade);
    bgmFade.connect(audioDest);
  }

  const canvasStream = canvas.captureStream(timeline.fps);
  const stream = new MediaStream([...canvasStream.getVideoTracks(), ...audioDest.stream.getAudioTracks()]);

  const mimeTypes = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  const mimeType = mimeTypes.find(t => MediaRecorder.isTypeSupported(t)) || '';
  const isMp4 = mimeType.startsWith('video/mp4');
  const bitrate = settings.quality === '4k' ? 18_000_000 : settings.quality === '720p' ? 4_000_000 : 9_000_000;

  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
  recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });

  const onVisibility = () => {
    if (document.hidden) cb.onProgress(-1, 'Hãy giữ tab này mở và hiển thị để phim không bị đứng hình...');
  };
  document.addEventListener('visibilitychange', onVisibility);

  const players: Array<HTMLMediaElement> = [];
  let imageIndex = 0;
  try {
    recorder.start(250);
    if (bgmEl) {
      bgmEl.currentTime = 0;
      await bgmEl.play().catch(() => warnings.push('Không phát được nhạc nền, phim có thể thiếu nhạc.'));
      if (bgmFade) {
        const t0 = audioCtx.currentTime;
        const fadeIn = Math.min(1, timeline.totalDuration / 3);
        bgmFade.gain.setValueAtTime(0, t0);
        bgmFade.gain.linearRampToValueAtTime(1, t0 + fadeIn);
      }
    }

    for (const scene of timeline.scenes) {
      if (cb.signal.aborted) throw new RenderCancelled();
      const src = usable[scene.index];
      // Cảnh cuối: nhạc nền nhỏ dần về 0 đúng lúc phim kết thúc
      if (bgmFade && scene.index === timeline.scenes.length - 1) {
        const now = audioCtx.currentTime;
        const d = Math.min(2, scene.duration * 0.9);
        bgmFade.gain.cancelScheduledValues(now);
        bgmFade.gain.setValueAtTime(timeline.scenes.length === 1 ? 1 : bgmFade.gain.value, now);
        bgmFade.gain.setValueAtTime(1, now + Math.max(0, scene.duration - d));
        bgmFade.gain.linearRampToValueAtTime(0, now + scene.duration);
      }
      cb.onProgress(
        Math.min(94, 3 + Math.round((scene.start / timeline.totalDuration) * 90)),
        `Đang dựng cảnh ${scene.index + 1}/${timeline.scenes.length}...`,
      );

      let videoEl: HTMLVideoElement | null = null;
      let paintImage: ((tSec: number) => void) | undefined;
      if (src.kind === 'image') {
        // Cảnh ảnh (mới): chuyển động bằng điểm ảnh gốc, chữ không bị đổi
        try {
          const prepared = await prepareImageFromUrl(src.imageUrl as string);
          const motion = new ImageMotionScene(prepared, {
            duration: scene.duration, style: src.motionStyle ?? 'auto', variant: imageIndex++,
          });
          const backdrop = settings.fitMode === 'blur' ? createBackdrop(defaultCanvasFactory, W, H) : undefined;
          backdrop?.update(prepared.orig);
          paintImage = (t: number) => drawImageSceneFrame(ctx, motion, t, W, H, settings.fitMode, backdrop);
        } catch {
          warnings.push(`Cảnh ${scene.index + 1}: file ảnh "${src.videoName}" bị hỏng hoặc không đọc được nên đã bỏ qua.`);
          continue;
        }
      } else {
        videoEl = await loadVideo(src.videoUrl);
        if (!videoEl) {
          warnings.push(`Cảnh ${scene.index + 1}: file video "${src.videoName}" bị hỏng hoặc không đọc được nên đã bỏ qua.`);
          continue;
        }
        players.push(videoEl);
      }

      let voiceEl: HTMLAudioElement | null = null;
      if (src.voiceUrl && scene.voiceOffset !== null) {
        voiceEl = new Audio(src.voiceUrl);
        voiceEl.crossOrigin = 'anonymous';
        const node = audioCtx.createMediaElementSource(voiceEl);
        node.connect(audioDest);
        players.push(voiceEl);
      }

      if (videoEl) {
        videoEl.currentTime = 0;
        await videoEl.play().catch(() => { /* sẽ thử lại theo khung hình */ });
      }

      await runScene(ctx, videoEl, voiceEl, scene, {
        paintImage,
        fit: settings.fitMode,
        subtitleStyle: settings.subtitleStyle,
        W, H,
        signal: cb.signal,
        duck: (on: boolean) => {
          if (!bgmGain) return;
          const target = on ? bgmBase * DUCK_LEVEL : bgmBase;
          // Hạ vừa phải, và LÊN LẠI CHẬM (không bật to đột ngột gây phân tâm)
          bgmGain.gain.setTargetAtTime(target, audioCtx.currentTime, on ? 0.35 : 1.0);
        },
      });

      if (videoEl) { videoEl.pause(); videoEl.removeAttribute('src'); videoEl.load(); }
      if (voiceEl) { voiceEl.pause(); voiceEl.removeAttribute('src'); voiceEl.load(); }
    }

    cb.onProgress(96, 'Đang đóng gói video...');
    bgmEl?.pause();
    recorder.stop();
    await stopped;
  } catch (err) {
    try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* bỏ qua */ }
    throw err;
  } finally {
    document.removeEventListener('visibilitychange', onVisibility);
    players.forEach(p => { try { p.pause(); } catch { /* bỏ qua */ } });
    bgmEl?.pause();
    void audioCtx.close().catch(() => {});
    void wakeLock?.release().catch(() => {});
  }

  const type = mimeType || 'video/webm';
  const blob = new Blob(chunks, { type });
  if (blob.size === 0) throw new EngineError('Trình duyệt không ghi được video. Hãy thử Chrome/Edge hoặc bật máy dựng.');
  const url = URL.createObjectURL(blob);

  if (!isMp4) warnings.push('Trình duyệt này chỉ xuất được định dạng WebM. Dùng Chrome/Edge mới hoặc bật máy dựng để có MP4 chuẩn.');

  if (!req.bgm && req.generatedMusic && settings.enableBgm) {
    warnings.push('Nhạc nền tự tạo cần máy dựng. Hãy bật máy dựng hoặc tải nhạc của bạn lên.');
  }

  return {
    engine: 'browser',
    url,
    downloadUrl: () => url,
    extension: isMp4 ? 'mp4' : 'webm',
    duration: Math.round(timeline.totalDuration * 10) / 10,
    sizeMB: Math.round((blob.size / 1048576) * 10) / 10,
    width: W,
    height: H,
    warnings,
    dispose: () => URL.revokeObjectURL(url),
  };
}

interface SceneRunOptions {
  /** cảnh ảnh: hàm vẽ khung tại giây t (thay cho khung video) */
  paintImage?: (tSec: number) => void;
  fit: 'blur' | 'cover' | 'contain';
  subtitleStyle: SubtitleStyle;
  W: number;
  H: number;
  signal: AbortSignal;
  duck: (on: boolean) => void;
}

function runScene(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement | null,
  voice: HTMLAudioElement | null,
  scene: TimelineScene,
  o: SceneRunOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const sceneMs = scene.duration * 1000;
    const voiceStartMs = scene.voiceOffset !== null ? scene.voiceOffset * 1000 : Infinity;
    const voiceEndMs = voiceStartMs + scene.voiceDuration * 1000;
    let voiceStarted = false;
    let voiceEnded = false;
    const t0 = performance.now();

    const timer = setInterval(() => {
      if (o.signal.aborted) {
        clearInterval(timer);
        reject(new RenderCancelled());
        return;
      }
      const elapsedMs = performance.now() - t0;
      if (elapsedMs >= sceneMs) {
        clearInterval(timer);
        if (voiceStarted && !voiceEnded) o.duck(false);
        resolve();
        return;
      }

      if (voice && !voiceStarted && elapsedMs >= voiceStartMs) {
        voiceStarted = true;
        o.duck(true);
        voice.currentTime = 0;
        void voice.play().catch(() => {});
      }
      if (voiceStarted && !voiceEnded && elapsedMs >= voiceEndMs) {
        voiceEnded = true;
        o.duck(false);
      }
      if (o.paintImage) {
        o.paintImage(elapsedMs / 1000);
      } else if (video) {
        if (video.paused) void video.play().catch(() => {});
        drawVideoFrame(ctx, video, o.fit, o.W, o.H);
      }

      const elapsed = elapsedMs / 1000;
      const cue = scene.cues.find(c => elapsed >= c.start && elapsed < c.end);
      if (cue) drawSubtitle(ctx, cue.text, o.subtitleStyle, o.W, o.H);
    }, 1000 / 30);
  });
}
