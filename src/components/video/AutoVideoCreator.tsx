import React, { useState, useRef, useEffect, useMemo } from 'react';
import { 
  Film, Music, Mic, FileText, Download, RotateCcw, 
  Trash2, ArrowUp, ArrowDown, CheckCircle2, 
  Sparkles, Layers, Sliders, Eye, Wand2, 
  Play, Pause, Loader2, CreditCard, Copy, Check, FileUp, ClipboardPaste, Subtitles
} from 'lucide-react';
import { generateGeminiText, generateGeminiVoice, processKeys, collectGeminiKeys, VoiceRegion } from '../../services/gemini';
import { UserProfile } from '../../types';
import { importDocument, type ImportedSlide } from '../../services/inputConverters';
import { SlideMaker } from './SlideMaker';
import type { TextSlideSpec } from '../../services/slideRender';
import { usePersistentState } from '../../utils/usePersistentState';
import { analyzeSpeech, cuesFromText, cuesFromTextAligned, alignSegments, transcribeSegments, splitIntoCaptions, type SubtitleCue, type SpeechMap } from '../../services/subtitleCues';
// [MỚI] voice tạo trong app luôn kèm lời thoại (không cần AI)
import { findVoiceText, takePendingVoice, VOICE_HANDOFF_EVENT } from '../../services/voiceHandoff';
// [MỚI] AI xem hình cảnh: viết lời đúng cảnh (A) + khớp cảnh theo lời voice dài (C)
import { captureAllScenes, writeSceneScripts, assignCuesToScenes, assignCuesByDuration, sceneDurationsFromCues, wordsForSeconds, type SceneVisual } from '../../services/sceneVision';
// [MỚI] Mô tả dựng cảnh: giữ/bỏ đoạn video, hiệu ứng ảnh, từ nhấn mạnh
import {
  parseDirectiveRules, resolveDirectivesAI, segmentsFromDirective, segmentsTotal, describeDirective, directiveWarnings,
  EFFECT_KINDS, EFFECT_LABEL, norm, type SceneDirective, type EffectKind, type SceneEffect,
} from '../../services/sceneDirective';
import { 
  parseSceneNumber, estimateTotalDuration, detectEngine, 
  renderMovie, RenderCancelled, type EngineKind, type RenderResult 
} from '../../services/videoRenderEngine';

export const MAX_FREE_TRIALS = 5;

/** [MỚI] Lời thoại có ghi "Cảnh 1: … Cảnh 2: …" → tách theo cảnh (không có → null) */
export function splitScriptByScenes(script: string): string[] | null {
  const re = /(?:^|\n|\s)(?:cảnh|canh|scene|slide)\s*(\d{1,3})\s*[:.)–-]/gi;
  const marks = Array.from(script.matchAll(re));
  if (marks.length < 2) return null;
  const out: string[] = [];
  marks.forEach((mk, i) => {
    const from = (mk.index ?? 0) + mk[0].length;
    const to = i + 1 < marks.length ? (marks[i + 1].index ?? script.length) : script.length;
    out.push(script.slice(from, to).trim());
  });
  return out;
}
/** [MỚI] Thêm dấu chấm cuối đoạn để câu không dính sang cảnh sau */
export const endSentence = (t: string) => (/[.!?…]["”’)\]]?$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);
export const COST_PER_MOVIE = 5; // 5 credits per movie

export interface SceneItem {
  id: string;
  order: number;
  // Video
  videoFile?: File;
  videoUrl: string;
  /** true = cảnh là ảnh (slide/infographic) */
  isImage?: boolean;
  videoName: string;
  videoDuration: number;
  videoWidth: number;
  videoHeight: number;
  // Voice
  voiceFile?: File;
  voiceUrl?: string;
  voiceName?: string;
  voiceDuration?: number;
  // Subtitle / Script
  subtitleText?: string;
  /** [SỬA] 'script' = lời chuẩn (AI viết / người dùng sửa) đã căn theo giọng → không nghe lại đè lên */
  subtitleCuesSrc?: 'voice' | 'text' | 'script';
  /** Phụ đề có mốc thời gian (từ giọng đọc của cảnh) */
  subtitleCues?: SubtitleCue[];
  /** Slide chữ: được vẽ trực tiếp khi dựng phim (nét + hiệu ứng đánh máy) */
  textSlide?: TextSlideSpec;
  /** [MỚI] Thời lượng cảnh khớp theo lời của voice dài 1 file (giây) */
  targetDuration?: number;
  /** [MỚI] Mô tả dựng cảnh (người dùng viết) + kết quả công cụ hiểu */
  directionText?: string;
  directive?: SceneDirective;
  /** [MỚI] Hiệu ứng chọn tay: 'inherit' = theo hiệu ứng chung */
  effectChoice?: 'inherit' | 'none' | EffectKind;
  /** [MỚI] Ảnh: người dùng tự chỉnh số giây → không tự chia / tự khớp đè lên */
  manualSeconds?: boolean;
  /** [MỚI] Voice dài: dải câu phụ đề [từ, đến] (chỉ số trong phụ đề voice dài) thuộc cảnh này */
  masterCueRange?: [number, number];
}

interface AutoVideoCreatorProps {
  outputLanguage: 'VN' | 'EN';
  credit?: number;
  email?: string;
  profile?: UserProfile;
  deductCredit?: (cost: number) => Promise<boolean>;
  onOpenPricing?: () => void;
  apiKeys?: string[];
  useProjectKey?: boolean;
  adminFreeKeys?: string[];
  adminPaidKeys?: string[];
  onClose?: () => void;
}

export const AutoVideoCreator: React.FC<AutoVideoCreatorProps> = ({ 
  outputLanguage,
  credit = 0,
  email = '',
  profile,
  deductCredit,
  onOpenPricing,
  apiKeys = [],
  useProjectKey = true,
  adminFreeKeys = [],
  adminPaidKeys = []
}) => {
  const isVN = outputLanguage === 'VN';

  // --- Free Trials & Credit Management ---
  const getTrialStorageKey = (targetEmail?: string) => {
    return `autovideo_trials_${targetEmail ? targetEmail.trim().toLowerCase() : 'guest'}`;
  };

  const [usedTrials, setUsedTrials] = useState<number>(() => {
    const key = getTrialStorageKey(email);
    return parseInt(localStorage.getItem(key) || '0', 10);
  });

  useEffect(() => {
    const key = getTrialStorageKey(email);
    setUsedTrials(parseInt(localStorage.getItem(key) || '0', 10));
  }, [email]);

  const isAdminOrVip = useMemo(() => {
    const role = (profile?.role || '').toLowerCase();
    const plan = (profile?.plan_name || '').toLowerCase();
    const cleanEmail = (email || '').trim().toLowerCase();
    return role === 'admin' || plan === 'pro9' || cleanEmail === 'yohu.vn@gmail.com';
  }, [profile, email]);

  const remainingTrials = useMemo(() => {
    if (isAdminOrVip) return 999;
    return Math.max(0, MAX_FREE_TRIALS - usedTrials);
  }, [isAdminOrVip, usedTrials]);

  // --- Pricing Modal State ---
  const [showPricingModal, setShowPricingModal] = useState<boolean>(false);
  const [selectedPricingTier, setSelectedPricingTier] = useState<'month' | 'quarter' | 'year' | 'credits_100'>('quarter');
  const [copiedText, setCopiedText] = useState<string | null>(null);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(label);
    setTimeout(() => setCopiedText(null), 2000);
  };

  // --- Scenes State ---
  const [scenes, setScenes] = useState<SceneItem[]>([]);
  const [bgmUrl, setBgmUrl] = useState<string>('');
  const [bgmName, setBgmName] = useState<string>('');
  const [bgmDuration, setBgmDuration] = useState<number>(0);

  // --- Voice dài 1 file (chia theo số giây từng cảnh) & phụ đề theo giọng đọc ---
  const [masterVoice, setMasterVoice] = useState<{ url: string; name: string; duration: number; file: File } | null>(null);
  const [masterStart, setMasterStart] = useState<number>(0);
  const [masterCues, setMasterCues] = useState<SubtitleCue[]>([]);
  // [MỚI] lời thoại của voice dài (miễn phí tách phụ đề) — draft = ô đang gõ, áp dụng sau khi ngừng gõ
  const [masterScript, setMasterScript] = useState<string>('');
  const [masterScriptDraft, setMasterScriptDraft] = useState<string>('');
  const [masterScriptSrc, setMasterScriptSrc] = useState<'handoff' | 'memory' | 'user' | 'none'>('none');
  const masterScriptRef = useRef<string>('');
  // [MỚI] chia lời vào cảnh bằng AI xem hình (tuỳ chọn, mặc định tắt — miễn phí chia theo thứ tự / "Cảnh N:")
  const [aiAssignScenes, setAiAssignScenes] = usePersistentState<boolean>('yohu_av_ai_assign', false);
  const [isTranscribing, setIsTranscribing] = useState<boolean>(false);
  const [transcribeMsg, setTranscribeMsg] = useState<string>('');
  const [revealObjects, setRevealObjects] = usePersistentState<boolean>('yohu_av_reveal', true);
  const [enableTransitions, setEnableTransitions] = usePersistentState<boolean>('yohu_av_transitions', true);
  const [enableTypewriter, setEnableTypewriter] = usePersistentState<boolean>('yohu_av_typewriter', true);
  const [sharpText, setSharpText] = usePersistentState<boolean>('yohu_av_sharp', true);
  // [SỬA] Voice = lời thoại: bỏ ô chọn nguồn phụ đề
  // [MỚI - C] Voice dài 1 file: tự khớp thời lượng cảnh theo lời (hình chuyển đúng lúc lời chuyển ý)
  const [syncScenesToVoice, setSyncScenesToVoice] = usePersistentState<boolean>('yohu_av_sync_scenes', true);
  // [MỚI] Hiệu ứng chung toàn video + tô màu từ nhấn mạnh
  const [globalEffect, setGlobalEffect] = usePersistentState<'auto' | 'none' | EffectKind>('yohu_av_globalFx', 'auto');
  const [emphasisColor, setEmphasisColor] = usePersistentState<boolean>('yohu_av_emphColor', true);
  const [isResolvingDir, setIsResolvingDir] = useState<boolean>(false);
  const [showSubsEditor, setShowSubsEditor] = useState<boolean>(false); // [MỚI] bảng xem/sửa phụ đề
  const [previewId, setPreviewId] = useState<string | null>(null); // [MỚI] cảnh đang xem trước
  const [presentationStyle, setPresentationStyle] = usePersistentState<boolean>('yohu_av_presentation', true);
  const [isImporting, setIsImporting] = useState<boolean>(false);
  const [showPasteModal, setShowPasteModal] = useState<boolean>(false);
  const docInputRef = useRef<HTMLInputElement>(null);

  // --- AI Auto Voice & Script Generator from User Description ---
  const [aiStoryPrompt, setAiStoryPrompt] = usePersistentState<string>('yohu_av_storyPrompt', '');
  const [aiVoiceGender, setAiVoiceGender] = usePersistentState<'MALE' | 'FEMALE'>('yohu_av_voiceGender', 'MALE');
  const [aiVoiceRegion, setAiVoiceRegion] = usePersistentState<VoiceRegion>('yohu_av_voiceRegion', 'NORTH');
  const [aiVoiceStyle, setAiVoiceStyle] = usePersistentState<'inspirational' | 'dramatic' | 'warm' | 'marketing'>('yohu_av_voiceStyle', 'inspirational');
  const [isGeneratingAiVoice, setIsGeneratingAiVoice] = useState<boolean>(false);
  const [aiGenStatus, setAiGenStatus] = useState<string>('');

  // Voice Audio Preview State
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  // --- Global Output Configurations ---
  const [movieTitle, setMovieTitle] = usePersistentState<string>('yohu_av_movieTitle', `Phim_AI_${new Date().toISOString().slice(0, 10)}`);
  const [aspectRatio, setAspectRatio] = usePersistentState<'original' | '16:9' | '9:16' | '1:1'>('yohu_av_aspect', 'original');
  const [fitMode, setFitMode] = usePersistentState<'blur' | 'cover' | 'contain'>('yohu_av_fit', 'blur');
  // [MỚI] Mức phóng lấp khung (0-100, mặc định 0 = giữ đủ hình như cũ) + vị trí giữ lại khi cắt (0-100, 50 = giữa)
  const [fillAmount, setFillAmount] = usePersistentState<number>('yohu_av_fillAmount', 0);
  const [focusX, setFocusX] = usePersistentState<number>('yohu_av_focusX', 50);
  // [MỚI] Tiếng gốc của clip + ghép 2 video song song (bảng thu gọn, mặc định đóng)
  const [advOpen, setAdvOpen] = usePersistentState<boolean>('yohu_av_advOpen', false);
  const [keepOrigAudio, setKeepOrigAudio] = usePersistentState<boolean>('yohu_av_keepOrig', true);
  const [origVolume, setOrigVolume] = usePersistentState<number>('yohu_av_origVol', 100);
  const [splitScreen, setSplitScreen] = usePersistentState<boolean>('yohu_av_split', false);
  const [splitPos, setSplitPos] = usePersistentState<'top' | 'middle' | 'bottom'>('yohu_av_splitPos', 'top');
  const [secondaryVideo, setSecondaryVideo] = useState<{ url: string; name: string } | null>(null);
  const handleSecondaryPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!f.type.startsWith('video/')) {
      alert('Vui lòng chọn file video. / Please choose a video file.');
      return;
    }
    const url = URL.createObjectURL(f);
    if (secondaryVideo) {
      try { URL.revokeObjectURL(secondaryVideo.url); } catch { /* bỏ qua */ }
    }
    setSecondaryVideo({ url, name: f.name });
  };
  const clearSecondaryVideo = () => {
    if (secondaryVideo) {
      try { URL.revokeObjectURL(secondaryVideo.url); } catch { /* bỏ qua */ }
    }
    setSecondaryVideo(null);
  };
  const [quality, setQuality] = usePersistentState<'original' | '1080p' | '720p' | '4k'>('yohu_av_quality', '1080p');
  // [MỚI] Chế độ Mạng xã hội 9:16 + vị trí phụ đề + karaoke
  const [socialMode, setSocialMode] = usePersistentState<boolean>('yohu_av_social', false);
  const [subPos, setSubPos] = usePersistentState<'top' | 'middle' | 'safe' | 'bottom' | 'custom'>('yohu_av_subPos', 'bottom');
  const [subY, setSubY] = usePersistentState<number>('yohu_av_subY', 68);
  const [karaoke, setKaraoke] = usePersistentState<boolean>('yohu_av_karaoke', true);
  const SUB_PRESET: Record<'top' | 'middle' | 'safe', number> = { top: 22, middle: 50, safe: 68 };
  /** [MỚI] % chiều cao của phụ đề (undefined = sát đáy kiểu cũ) */
  const subtitleYValue = subPos === 'bottom' ? undefined : subPos === 'custom' ? subY : SUB_PRESET[subPos];
  const toggleSocial = (on: boolean) => {
    setSocialMode(on);
    if (on) {
      setAspectRatio('9:16');
      if (quality !== '4k') setQuality('1080p');
      if (subPos === 'bottom') setSubPos('safe'); // phụ đề lên vùng an toàn, tránh nút của app
    }
  };
  const [enableSubtitles, setEnableSubtitles] = usePersistentState<boolean>('yohu_av_subs', true);
  const [subtitleStyle, setSubtitleStyle] = usePersistentState<'yellow_stroke' | 'white_box'>('yohu_av_subStyle', 'yellow_stroke');
  const [enableBgm, setEnableBgm] = usePersistentState<boolean>('yohu_av_bgm', true);
  const [bgmVolume, setBgmVolume] = usePersistentState<number>('yohu_av_bgmVol', 40); // 0 - 100% (mặc định 40%, êm, không đổi đột ngột)

  // Script text area for auto-extraction
  const [bulkScript, setBulkScript] = usePersistentState<string>('yohu_av_bulkScript', '');
  const [showScriptModal, setShowScriptModal] = useState<boolean>(false);

  // --- Processing / Render State ---
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [renderResult, setRenderResult] = useState<RenderResult | null>(null);
  const renderedVideoUrl = renderResult?.url ?? null;
  const renderStats = renderResult
    ? { totalDuration: Math.round(renderResult.duration), fileSizeMB: renderResult.sizeMB.toFixed(1), resolution: `${renderResult.width}x${renderResult.height}` }
    : null;
  const [engineKind, setEngineKind] = useState<EngineKind | 'checking'>('checking');
  const renderResultRef = useRef<RenderResult | null>(null);
  useEffect(() => { renderResultRef.current = renderResult; }, [renderResult]);

  // Đang dựng phim: giữ màn hình sáng + cảnh báo nếu lỡ đóng tab (dựng chạy ngay trên máy này)
  useEffect(() => {
    if (!isProcessing) return;
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock?.request('screen').then((l) => { lock = l; }).catch(() => { /* không hỗ trợ */ });
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      lock?.release().catch(() => { /* bỏ qua */ });
    };
  }, [isProcessing]);

  const refreshEngine = async () => {
    setEngineKind('checking');
    const r = await detectEngine();
    setEngineKind(r.kind);
  };
  useEffect(() => {
    let alive = true;
    detectEngine().then(r => { if (alive) setEngineKind(r.kind); });
    return () => { alive = false; };
  }, []);

  // --- Hidden / Helper Refs ---
  const videoInputRef = useRef<HTMLInputElement>(null);
  const voiceInputRef = useRef<HTMLInputElement>(null);
  const bgmInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cleanupUrlsRef = useRef<string[]>([]);

  // Clean up object URLs on unmount
  useEffect(() => {
    const urls = cleanupUrlsRef.current;
    return () => {
      urls.forEach(u => {
        try {
          URL.revokeObjectURL(u);
        } catch (e) {
          console.debug(e);
        }
      });
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
      }
      abortRef.current?.abort();
      renderResultRef.current?.dispose();
    };
  }, []);

  // Helper: Extract Scene Number from Filename
  const extractSceneNumber = (filename: string): number => parseSceneNumber(filename) ?? 9999;

  // Helper: Load video metadata
  const loadVideoMetadata = (_file: File, url: string): Promise<{ duration: number; width: number; height: number }> => {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.src = url;
      v.muted = true;
      v.onloadedmetadata = () => {
        resolve({
          duration: v.duration || 5,
          width: v.videoWidth || 1920,
          height: v.videoHeight || 1080
        });
      };
      v.onerror = () => {
        resolve({ duration: 5, width: 1920, height: 1080 });
      };
    });
  };

  // Helper: Load audio duration
  const loadAudioDuration = (_file: File | Blob, url: string): Promise<number> => {
    return new Promise((resolve) => {
      const a = document.createElement('audio');
      a.preload = 'metadata';
      a.src = url;
      a.onloadedmetadata = () => {
        resolve(a.duration || 3);
      };
      a.onerror = () => {
        resolve(3);
      };
    });
  };

  // --- Handlers: Upload Video Clips ---
  const handleAddVideos = async (files: FileList | File[]) => {
    const fileArray = Array.from(files).filter(f =>
      f.type.startsWith('video/') || f.type.startsWith('image/') ||
      f.name.match(/\.(mp4|webm|mov|mkv|avi|png|jpe?g|webp)$/i)
    );
    if (fileArray.length === 0) return;

    const newScenes: SceneItem[] = [];

    for (let i = 0; i < fileArray.length; i++) {
      const file = fileArray[i];
      const url = URL.createObjectURL(file);
      cleanupUrlsRef.current.push(url);
      const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.name);
      const meta = isImage
        ? await new Promise<{ duration: number; width: number; height: number }>((resolve) => {
            const im = new Image();
            im.onload = () => resolve({ duration: 6, width: im.naturalWidth || 1920, height: im.naturalHeight || 1080 });
            im.onerror = () => resolve({ duration: 6, width: 1920, height: 1080 });
            im.src = url;
          })
        : await loadVideoMetadata(file, url);
      const order = extractSceneNumber(file.name);

      newScenes.push({
        id: `scene_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        order: order === 9999 ? scenes.length + i + 1 : order,
        videoFile: file,
        videoUrl: url,
        isImage,
        videoName: file.name,
        videoDuration: meta.duration,
        videoWidth: meta.width,
        videoHeight: meta.height
      });
    }

    setScenes(prev => {
      const combined = [...prev, ...newScenes];
      combined.sort((a, b) => a.order - b.order);
      return combined;
    });
  };

  // --- Handlers: Upload Voice Files Manually ---
  const handleAddVoices = async (files: FileList | File[]) => {
    try {
      await addVoicesInner(files);
    } catch (err) {
      console.error('Lỗi thêm voice:', err);
      alert((isVN ? 'Không thêm được file voice: ' : 'Could not add the voice file: ') + (err instanceof Error ? err.message : String(err)));
    }
  };

  const addVoicesInner = async (files: FileList | File[]) => {
    const all = Array.from(files);
    const fileArray = all.filter(f => f.type.startsWith('audio/') || /\.(wav|mp3|m4a|aac|ogg|oga|opus|flac|weba|wma|amr|mp4|webm)$/i.test(f.name));
    if (fileArray.length === 0) {
      if (all.length > 0) alert(isVN ? 'File này không phải âm thanh. Dùng file .mp3, .wav, .m4a, .ogg, .aac, .flac...' : 'That is not an audio file. Use .mp3, .wav, .m4a, .ogg, .aac, .flac...');
      return;
    }

    // 1 file voice dài (không ghi số cảnh trong tên) cho nhiều cảnh → chia tuần tự theo số giây từng cảnh
    if (
      fileArray.length === 1 &&
      scenes.length > 1 &&
      !/(scene|slide|c[aả]nh|clip|part)[_\-\s]*\d+/i.test(fileArray[0].name)
    ) {
      await setMasterFromFile(fileArray[0]);
      return;
    }

    const voiceDataList = await Promise.all(
      fileArray.map(async (file) => {
        const url = URL.createObjectURL(file);
        cleanupUrlsRef.current.push(url);
        const duration = await loadAudioDuration(file, url);
        const sceneNum = extractSceneNumber(file.name);
        const text = findVoiceText(file.size); // [MỚI] voice tạo trong app → có sẵn lời thoại
        return { file, url, name: file.name, duration, sceneNum, text };
      })
    );

    setScenes(prev => {
      const updated = [...prev];
      if (updated.length === 0) {
        voiceDataList.forEach((v, idx) => {
          updated.push({
            id: `scene_${Date.now()}_${idx}`,
            order: v.sceneNum === 9999 ? idx + 1 : v.sceneNum,
            videoUrl: '',
            videoName: isVN ? `Chưa có video cảnh ${idx + 1}` : `No video for scene ${idx + 1}`,
            videoDuration: v.duration,
            videoWidth: 1920,
            videoHeight: 1080,
            voiceFile: v.file,
            voiceUrl: v.url,
            voiceName: v.name,
            voiceDuration: v.duration,
            ...(v.text ? { subtitleText: v.text } : {}), // [MỚI]
          });
        });
        updated.sort((a, b) => a.order - b.order);
        return updated;
      }

      voiceDataList.forEach((v, vIndex) => {
        let matchedIdx = updated.findIndex(s => s.order === v.sceneNum);
        if (matchedIdx === -1 && vIndex < updated.length) {
          matchedIdx = vIndex;
        }

        if (matchedIdx !== -1) {
          updated[matchedIdx] = {
            ...updated[matchedIdx],
            voiceFile: v.file,
            voiceUrl: v.url,
            voiceName: v.name,
            voiceDuration: v.duration,
            subtitleCues: undefined, // giọng mới → phụ đề phải lấy lại theo giọng mới
            subtitleCuesSrc: undefined,
            ...(v.text ? { subtitleText: v.text } : {}), // [MỚI] lời thoại có sẵn của voice
          };
          subsFailedRef.current.delete(updated[matchedIdx].id);
        }
      });

      return updated;
    });
  };

  // --- Voice dài 1 file: cắt tuần tự theo số giây của từng cảnh, phần dư ở cuối bị bỏ ---
  const setMasterFromFile = async (file: File, script?: string) => {
    if (masterVoice) URL.revokeObjectURL(masterVoice.url);
    const url = URL.createObjectURL(file);
    cleanupUrlsRef.current.push(url);
    const duration = await loadAudioDuration(file, url);
    // [MỚI] lời thoại của voice: gửi kèm / tự nhận theo file (voice tạo trong app) → phụ đề miễn phí
    const text = script ?? findVoiceText(file.size) ?? '';
    masterScriptRef.current = text;
    setMasterScript(text);
    setMasterScriptDraft(text);
    setMasterScriptSrc(script ? 'handoff' : text ? 'memory' : 'none');
    setMasterVoice({ url, name: file.name, duration, file });
    setMasterCues([]);
    setMasterStart(0);
    setScenes(prev => prev.map(x => ({ ...x, targetDuration: undefined }))); // [SỬA] voice mới → khớp cảnh lại
    syncSigRef.current = '';
  };

  const removeMasterVoice = () => {
    if (masterVoice) URL.revokeObjectURL(masterVoice.url);
    masterScriptRef.current = '';
    setMasterScript('');
    setMasterScriptDraft('');
    setMasterScriptSrc('none');
    setMasterVoice(null);
    setMasterCues([]);
    setMasterStart(0);
    // [SỬA] bỏ voice dài → về số giây gốc (ảnh tự động về 6s, ảnh chỉnh tay giữ nguyên)
    setScenes(prev => prev.map(x => ({ ...x, targetDuration: undefined, ...(x.isImage && !x.manualSeconds ? { videoDuration: 6 } : {}) })));
    syncSigRef.current = '';
  };

  // --- Phụ đề TỰ ĐỘNG theo giọng đọc: nói đến đâu chữ hiện đến đó, xuống câu đúng chỗ giọng nghỉ ---
  const scenesRef = useRef<SceneItem[]>([]);
  scenesRef.current = scenes;
  const masterRef = useRef(masterVoice);
  masterRef.current = masterVoice;
  const masterCuesRef = useRef<SubtitleCue[]>(masterCues);
  masterCuesRef.current = masterCues;
  const subsBusyRef = useRef(false);
  const subsFailedRef = useRef<Set<string>>(new Set());
  const masterStartRef = useRef(masterStart);
  masterStartRef.current = masterStart;
  const syncSigRef = useRef('');
  /** [MỚI] Bộ nhớ đệm sóng âm theo voiceUrl (sửa chữ → căn lại không phải phân tích lại) */
  const speechCacheRef = useRef<Map<string, SpeechMap>>(new Map());
  const realignTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // [SỬA] lấy đủ key như phần tạo giọng: key dự án (Vercel env) + key người dùng + key admin
  const allKeys = () => collectGeminiKeys(apiKeys, useProjectKey, adminFreeKeys, adminPaidKeys);
  // [SỬA] dùng số giây sau khi giữ/bỏ đoạn + mô tả dựng cảnh
  const toVisual = (sc: SceneItem): SceneVisual => ({
    url: sc.videoUrl, isImage: sc.isImage, seconds: sceneSeconds(sc),
    segments: sceneSegments(sc), note: sc.directionText,
  });

  /** [MỚI] Đoạn video dùng theo mô tả (ảnh → không có) */
  function sceneSegments(sc: SceneItem): [number, number][] | undefined {
    if (sc.isImage || !sc.directive) return undefined;
    return segmentsFromDirective(sc.directive, sc.videoDuration);
  }
  /** [MỚI] Số giây thực dùng của cảnh (video: tổng các đoạn giữ lại) */
  function sceneSeconds(sc: SceneItem): number {
    const segs = sceneSegments(sc);
    return segs ? segmentsTotal(segs) : (sc.videoDuration || 5);
  }
  /** [MỚI] Ảnh có voice riêng (không voice dài): dài đúng giọng + 0.3s; chỉnh tay dài hơn thì theo tay */
  function imageVoiceSeconds(sc: SceneItem): number | undefined {
    if (!sc.isImage || masterVoice || !sc.voiceUrl || !(sc.voiceDuration && sc.voiceDuration > 0)) return undefined;
    const v = sc.voiceDuration + 0.3;
    return sc.manualSeconds ? Math.max(v, sc.videoDuration) : v;
  }
  /** [MỚI] Số giây cảnh khi dựng (giống máy dựng) — dùng cho mốc thời gian phụ đề toàn phim / SRT */
  function sceneRenderSeconds(sc: SceneItem): number {
    if (masterVoice) return (syncScenesToVoice && sc.targetDuration) || sceneSeconds(sc);
    const img = imageVoiceSeconds(sc);
    if (img !== undefined) return img;
    const base = sceneSeconds(sc);
    const v = sc.voiceUrl ? sc.voiceDuration || 0 : 0;
    return v > 0 ? (v > base ? v + 0.3 : Math.min(base, v + 0.3)) : base;
  }
  /** [MỚI] Phụ đề của cảnh theo giây trong cảnh (chưa có mốc → chia theo lời thoại như máy dựng) */
  function sceneCues(sc: SceneItem): SubtitleCue[] {
    if (sc.subtitleCues?.length) return sc.subtitleCues;
    const t = (sc.subtitleText || '').trim();
    if (!t) return [];
    const dur = sceneRenderSeconds(sc);
    const end = !masterVoice && sc.voiceUrl && sc.voiceDuration ? Math.min(sc.voiceDuration, dur) : dur * 0.92;
    return cuesFromText(t, 0.1, Math.max(0.8, end));
  }
  /** [MỚI] Phụ đề toàn phim theo mốc thời gian phim */
  function buildFilmCues(): SubtitleCue[] {
    if (masterVoice && masterCues.length) {
      return masterCues.filter(c => c.end > masterStart && c.text.trim()).map(c => ({ ...c, start: Math.max(0, c.start - masterStart), end: c.end - masterStart }));
    }
    const out: SubtitleCue[] = [];
    let t = 0;
    for (const sc of scenes.filter(x => x.videoUrl)) {
      sceneCues(sc).forEach(c => out.push({ start: t + c.start, end: t + c.end, text: c.text }));
      t += sceneRenderSeconds(sc);
    }
    return out;
  }
  /** [MỚI] Tải file .SRT (YouTube / CapCut) */
  const downloadSrt = () => {
    const cues = buildFilmCues();
    if (!cues.length) { alert(isVN ? 'Chưa có phụ đề để tải.' : 'No subtitles yet.'); return; }
    const ts = (v: number) => {
      const ms = Math.max(0, Math.round(v * 1000));
      const p = (n: number, l = 2) => String(n).padStart(l, '0');
      return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
    };
    const srt = cues.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join('\n');
    const url = URL.createObjectURL(new Blob([srt], { type: 'application/x-subrip;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${movieTitle.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'phu_de'}.srt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  /** [MỚI] Sửa 1 dòng phụ đề (chữ / giờ) — giữ nguyên khi tạo lại tự động */
  const editCue = (sceneId: string | 'master', idx: number, patch: Partial<SubtitleCue>) => {
    if (sceneId === 'master') {
      const next = masterCuesRef.current.map((c, i) => i === idx ? { ...c, ...patch } : c);
      masterCuesRef.current = next;
      setMasterCues(next);
      return;
    }
    setScenes(prev => prev.map(x => {
      if (x.id !== sceneId) return x;
      const base = sceneCues(x);
      const next = base.map((c, i) => i === idx ? { ...c, ...patch } : c);
      return { ...x, subtitleCues: next, subtitleCuesSrc: 'script', subtitleText: next.map(c => c.text).join(' ') };
    }));
  };
  /** [MỚI] Trạng thái phụ đề của cảnh cho bảng ở cột phải */
  function subStatus(sc: SceneItem): { icon: string; label: string; tone: string } {
    if (sceneSubsBusy === sc.id || (isTranscribing && sc.voiceUrl && !sc.subtitleCues?.length)) return { icon: '⏳', label: isVN ? 'đang tạo' : 'working', tone: 'text-sky-300' };
    if (sc.subtitleCues?.length) return { icon: '✓', label: `${sc.subtitleCues.length} ${isVN ? 'dòng' : 'lines'}`, tone: 'text-emerald-300' };
    if (!sc.voiceUrl && (sc.subtitleText || '').trim()) return { icon: '✓', label: isVN ? 'theo lời thoại (chưa có voice)' : 'from text', tone: 'text-emerald-300/80' };
    if (sc.voiceUrl) return { icon: '•', label: isVN ? 'có voice, chưa tạo phụ đề' : 'voice, no subtitles', tone: 'text-amber-300' };
    return { icon: '⚠', label: isVN ? 'chưa có voice / lời thoại' : 'no voice / text', tone: 'text-slate-500' };
  }

  /** [MỚI] Hiệu ứng cuối cùng của cảnh: mô tả > chọn tay > chung (undefined) */
  function sceneEffects(sc: SceneItem): SceneEffect[] | undefined {
    if (sc.directive && sc.directive.effects.length) return sc.directive.effects;
    const ch = sc.effectChoice ?? 'inherit';
    if (ch === 'inherit') return undefined;
    return ch === 'none' ? [] : [{ kind: ch }];
  }

  /** [MỚI] Người dùng gõ mô tả dựng cảnh → hiểu ngay bằng luật (không tốn API) */
  const updateSceneDirection = (id: string, text: string) => {
    const noKey = processKeys(allKeys()).length === 0;
    setScenes(prev => prev.map(x => {
      if (x.id !== id) return x;
      let d = text.trim() ? parseDirectiveRules(text, !!x.isImage) : undefined;
      if (d && d.needsAI && noKey) d = { ...d, needsAI: false, aiUnavailable: true }; // [SỬA] báo ngay khi thiếu key
      return { ...x, directionText: text, directive: d };
    }));
  };
  const setSceneEffectChoice = (id: string, ch: 'inherit' | 'none' | EffectKind) => {
    setScenes(prev => prev.map(x => x.id === id ? { ...x, effectChoice: ch } : x));
  };

  /**
   * [MỚI] Mô tả khó / cần tìm vị trí trên hình → gom tất cả cảnh vào 1 lần gọi AI.
   * Lỗi hoặc không có key → giữ kết quả hiểu bằng luật.
   */
  const resolvePendingDirectives = async (onlyId?: string): Promise<void> => {
    const all = scenesRef.current;
    const pending = all
      .map((sc, i) => ({ sc, no: i + 1 }))
      .filter(({ sc }) => sc.directive && sc.directive.needsAI && sc.videoUrl && (!onlyId || sc.id === onlyId));
    if (pending.length === 0) return;
    const keys = allKeys();
    // [SỬA] không có key / AI lỗi → báo rõ "chưa có API key" thay vì "chưa hiểu"
    const markDone = (arr: SceneItem[], ids: Set<string>) => arr.map(x => ids.has(x.id) && x.directive ? { ...x, directive: { ...x.directive, needsAI: false, aiUnavailable: true } } : x);
    const ids = new Set<string>(pending.map(p => p.sc.id));
    if (processKeys(keys).length === 0) {
      scenesRef.current = markDone(scenesRef.current, ids);
      setScenes(prev => markDone(prev, ids));
      return;
    }
    setIsResolvingDir(true);
    try {
      const frames = await captureAllScenes(pending.map(p => toVisual(p.sc)));
      const out = await resolveDirectivesAI(pending.map((p, k) => ({
        sceneNo: p.no, text: p.sc.directionText || '', isImage: !!p.sc.isImage,
        duration: p.sc.videoDuration, frames: frames[k], ruled: p.sc.directive!,
      })), keys);
      const byId = new Map<string, SceneDirective>(pending.map((p, k) => [p.sc.id, out[k]]));
      const apply = (arr: SceneItem[]) => arr.map(x => {
        const d = byId.get(x.id);
        return d && (x.directionText || '').trim() === d.srcText ? { ...x, directive: d } : x; // bỏ qua nếu người dùng đã sửa tiếp
      });
      scenesRef.current = apply(scenesRef.current);
      setScenes(prev => apply(prev));
    } catch (e) {
      console.warn('AI hiểu mô tả lỗi, dùng kết quả hiểu bằng luật:', e);
      scenesRef.current = markDone(scenesRef.current, ids);
      setScenes(prev => markDone(prev, ids));
    } finally {
      setIsResolvingDir(false);
    }
  };

  /**
   * [MỚI - C] Voice dài 1 file: AI xem hình từng cảnh + đọc từng câu phụ đề → gán câu vào đúng cảnh,
   * rồi đặt thời lượng cảnh = từ câu đầu đến câu đầu của cảnh kế. Lỗi/không có key → chia theo số giây đã đặt.
   * Chỉ gọi AI lại khi thứ tự cảnh / phụ đề / giây bắt đầu thay đổi.
   */
  const syncScenesToMaster = async (cuesAll: SubtitleCue[], force = false, matchScenes = syncScenesToVoice, presetAll?: number[]): Promise<void> => {
    const m = masterRef.current;
    if (!m) return;
    const list = scenesRef.current.filter(sc => sc.videoUrl);
    const start = masterStartRef.current;
    const offset = cuesAll.findIndex(c => c.end > start + 0.05); // [MỚI] chỉ số câu đầu tiên được dùng
    const cues = offset < 0 ? [] : cuesAll.slice(offset);
    if (list.length === 0 || cues.length === 0) return;
    const sig = `${m.url}|${start}|${matchScenes ? 1 : 0}|${list.map(x => x.id).join(',')}`;
    if (!force && sig === syncSigRef.current) return;

    const fallbackSec = list.map(x => sceneSeconds(x)); // [SỬA] theo đoạn video giữ lại
    let assign: number[];
    let byAI = true;
    try {
      const keys = allKeys();
      // [SỬA] lời thoại ghi "Cảnh N:" → chia đúng cảnh, không cần AI
      if (presetAll && presetAll.length === cuesAll.length) {
        assign = presetAll.slice(offset).map(k => Math.min(k, list.length - 1));
        setTranscribeMsg(isVN ? `✓ Chia lời theo "Cảnh 1, 2…" trong lời thoại` : '✓ Split by scene markers');
        byAI = false;
      } else {
        // [SỬA] mặc định miễn phí: chia câu lần lượt theo thời lượng ảnh; AI xem hình chỉ khi người dùng bật
        if (!aiAssignScenes || keys.length === 0 || list.length === 1) throw new Error('skip');
        const frames = await captureAllScenes(list.map(toVisual), (i, n) =>
          setTranscribeMsg(isVN ? `👁 AI xem hình cảnh ${i}/${n} để khớp lời...` : `Viewing scene ${i}/${n}...`));
        setTranscribeMsg(isVN ? '👁 AI đang khớp từng câu vào đúng cảnh...' : 'Matching lines to scenes...');
        assign = await assignCuesToScenes(cues, frames, keys);
      }
    } catch {
      assign = assignCuesByDuration(cues, fallbackSec);
      byAI = false;
    }
    const { durations, texts } = sceneDurationsFromCues(cues, assign, fallbackSec, start);
    // [MỚI] dải câu của từng cảnh (để người dùng sửa ô lời thoại → sửa đúng câu trong phụ đề voice dài)
    const ranges = list.map((_, i) => {
      const a = assign.indexOf(i);
      const b = assign.lastIndexOf(i);
      return a < 0 ? undefined : [offset + a, offset + b] as [number, number];
    });
    const map = new Map<string, { d: number; t: string; r?: [number, number] }>(list.map((x, i) => [x.id, { d: durations[i], t: texts[i], r: ranges[i] }]));
    const apply = (arr: SceneItem[]) => arr.map(x => {
      const v = map.get(x.id);
      // [SỬA] luôn điền lời thoại của voice vào ô từng cảnh; ảnh chỉnh tay giữ số giây
      return v ? { ...x, targetDuration: matchScenes && !x.manualSeconds ? v.d : undefined, subtitleText: v.t, masterCueRange: v.r } : x;
    });
    scenesRef.current = apply(scenesRef.current);
    setScenes(prev => apply(prev));
    syncSigRef.current = sig;
    setTranscribeMsg(byAI
      ? (isVN ? `✓ Đã khớp ${list.length} cảnh theo lời đọc (AI xem hình)` : `✓ ${list.length} scenes matched to narration`)
      : (isVN ? `✓ Đã chia lời vào ${list.length} cảnh, chuyển cảnh ở cuối câu (miễn phí)` : `✓ ${list.length} scenes matched (free)`));
  };

  /** [MỚI - B] Căn lại phụ đề của 1 cảnh theo đúng chữ trong ô lời thoại + chỗ nghỉ của giọng cảnh đó */
  const realignSceneText = async (id: string) => {
    const sc = scenesRef.current.find(x => x.id === id);
    if (!sc || !sc.voiceUrl) return;
    const text = (sc.subtitleText || '').trim();
    let cues: SubtitleCue[] = [];
    if (text) {
      try {
        let sp = speechCacheRef.current.get(sc.voiceUrl);
        if (!sp) {
          const blob = sc.voiceFile ?? await (await fetch(sc.voiceUrl)).blob();
          sp = await analyzeSpeech(blob);
          speechCacheRef.current.set(sc.voiceUrl, sp);
        }
        cues = cuesFromTextAligned(text, sp);
      } catch {
        cues = cuesFromText(text, 0.1, Math.max(0.8, sc.voiceDuration || 3));
      }
    }
    const patch = { subtitleCues: cues.length ? cues : undefined, subtitleCuesSrc: cues.length ? 'script' as const : undefined };
    scenesRef.current = scenesRef.current.map(x => x.id === id ? { ...x, ...patch } : x);
    setScenes(prev => prev.map(x => x.id === id ? { ...x, ...patch } : x));
  };

  /** [MỚI - B] Người dùng sửa ô lời thoại → cập nhật chữ, bỏ phụ đề cũ, căn lại sau 0.7s ngừng gõ */
  const updateSceneText = (id: string, val: string) => {
    // [MỚI] Voice dài: sửa ô lời thoại = sửa đúng các câu phụ đề của cảnh đó (giữ khung thời gian của cảnh)
    const cur = scenesRef.current.find(x => x.id === id);
    if (masterRef.current && cur?.masterCueRange && masterCuesRef.current.length) {
      const [a, b] = cur.masterCueRange;
      const all = masterCuesRef.current;
      if (all[a] && all[b]) {
        const fresh = val.trim() ? cuesFromText(val, all[a].start, all[b].end) : [{ ...all[a], end: all[b].end, text: '' }];
        const next = [...all.slice(0, a), ...fresh, ...all.slice(b + 1)];
        const delta = fresh.length - (b - a + 1);
        const shift = (arr: SceneItem[]) => arr.map(x => {
          if (x.id === id) return { ...x, subtitleText: val, masterCueRange: [a, a + fresh.length - 1] as [number, number] };
          if (x.masterCueRange && x.masterCueRange[0] > b) return { ...x, masterCueRange: [x.masterCueRange[0] + delta, x.masterCueRange[1] + delta] as [number, number] };
          return x;
        });
        masterCuesRef.current = next;
        setMasterCues(masterCuesRef.current);
        scenesRef.current = shift(scenesRef.current);
        setScenes(prev => shift(prev));
        return;
      }
    }
    setScenes(prev => prev.map(x => x.id === id ? { ...x, subtitleText: val, subtitleCues: undefined, subtitleCuesSrc: 'script' } : x));
    subsFailedRef.current.delete(id);
    const timers = realignTimersRef.current;
    const old = timers.get(id);
    if (old) clearTimeout(old);
    timers.set(id, setTimeout(() => { timers.delete(id); void realignSceneText(id); }, 700));
  };

  /**
   * [SỬA] Tạo phụ đề từ voice — MIỄN PHÍ khi đã có lời thoại:
   *  - Voice dài: lời thoại của voice (tự nhận từ công cụ Giọng đọc / người dùng dán) → tách câu,
   *    đặt chỗ ngắt đúng chỗ giọng nghỉ → chia câu vào từng cảnh ("Cảnh 1: …" nếu có, không thì theo thứ tự)
   *  - Voice từng cảnh: chữ trong ô lời thoại → căn theo chỗ giọng nghỉ
   *  - AI (Gemini) chỉ chạy khi người dùng bấm "AI nghe giọng" cho voice không có lời
   */
  const ensureSubtitles = async (force = false, useAI = false): Promise<void> => {
    if (subsBusyRef.current) return;
    const keys = allKeys();
    const hasKeys = keys.length > 0;
    subsBusyRef.current = true;
    setIsTranscribing(true);
    if (force) subsFailedRef.current.clear();
    try {
      // 1) Voice dài 1 file
      const m = masterRef.current;
      if (m && (force || masterCuesRef.current.length === 0) && !subsFailedRef.current.has('master:' + m.url)) {
        try {
          let speech = speechCacheRef.current.get(m.url);
          if (!speech) {
            setTranscribeMsg(isVN ? '🎧 Đang phân tích nhịp giọng đọc...' : 'Analyzing the voice rhythm...');
            speech = await analyzeSpeech(m.file);
            speechCacheRef.current.set(m.url, speech);
          }
          const script = masterScriptRef.current.trim();
          let cues: SubtitleCue[] = [];
          let preset: number[] | undefined;
          if (script) {
            // miễn phí: lời thoại có sẵn → câu + chỗ ngắt theo giọng nghỉ
            const parts = splitScriptByScenes(script);
            const full = parts ? parts.map(endSentence).join(' ') : script;
            cues = cuesFromTextAligned(full, speech);
            if (parts) {
              const counts = parts.map(t => splitIntoCaptions(endSentence(t)).length);
              if (counts.reduce((x, y) => x + y, 0) === cues.length) preset = counts.flatMap((c, k) => Array(c).fill(k));
            }
          } else if (useAI) {
            if (!hasKeys) throw new Error(isVN ? 'Dự án chưa có API key Gemini để AI nghe giọng.' : 'No Gemini API key.');
            setTranscribeMsg(isVN ? '🤖 AI đang nghe giọng đọc để lấy lời...' : 'AI is listening...');
            cues = alignSegments(await transcribeSegments(m.file, keys), speech);
          } else {
            setTranscribeMsg(isVN ? '📝 Voice này chưa có lời thoại: dán lời vào ô "Lời thoại của voice" (miễn phí) hoặc bấm "AI nghe giọng".' : 'Paste the voice script, or use AI listen.');
            return;
          }
          masterCuesRef.current = cues;
          setMasterCues(cues);
          setTranscribeMsg(isVN ? `✓ Đã tạo ${cues.length} dòng phụ đề từ lời thoại của voice` : `✓ ${cues.length} subtitle lines created`);
          await syncScenesToMaster(cues, true, syncScenesToVoice, preset); // điền lời từng cảnh + chuyển cảnh ở cuối câu
        } catch (err) {
          subsFailedRef.current.add('master:' + m.url);
          setTranscribeMsg('⚠ ' + (err instanceof Error ? err.message : String(err)));
        }
      }

      // 2) Voice riêng từng cảnh
      if (!m) {
        const list = scenesRef.current.filter(sc => sc.voiceUrl);
        let done = 0;
        let waiting = 0;
        for (const sc of list) {
          if (!force && sc.subtitleCues && sc.subtitleCues.length > 0) continue;
          if (subsFailedRef.current.has(sc.id)) continue;
          const knownText = (sc.subtitleText || '').trim();
          if (!knownText && !useAI) { waiting++; continue; } // chưa có lời: chờ người dùng dán lời / bấm AI nghe
          try {
            setTranscribeMsg(isVN ? `🎧 Phụ đề cảnh ${done + 1}/${list.length}...` : `Subtitles for scene ${done + 1}/${list.length}...`);
            const blob = sc.voiceFile ?? await (await fetch(sc.voiceUrl!)).blob();
            let speech = speechCacheRef.current.get(sc.voiceUrl!);
            if (!speech) { speech = await analyzeSpeech(blob); speechCacheRef.current.set(sc.voiceUrl!, speech); }
            let cues: SubtitleCue[];
            let src: 'voice' | 'script' = 'script';
            let boxText = knownText;
            if (knownText && !(useAI && force)) {
              cues = cuesFromTextAligned(knownText, speech); // miễn phí
            } else {
              if (!hasKeys) throw new Error(isVN ? 'Dự án chưa có API key Gemini để AI nghe giọng.' : 'No Gemini API key.');
              cues = alignSegments(await transcribeSegments(blob, keys), speech);
              src = 'voice';
              boxText = cues.map(c => c.text).join(' ');
            }
            scenesRef.current = scenesRef.current.map(x => x.id === sc.id ? { ...x, subtitleCues: cues, subtitleCuesSrc: src, subtitleText: boxText } : x);
            setScenes(prev => prev.map(x => x.id === sc.id ? { ...x, subtitleCues: cues, subtitleCuesSrc: src, subtitleText: boxText } : x));
            done++;
          } catch (err) {
            subsFailedRef.current.add(sc.id);
            setTranscribeMsg('⚠ ' + (err instanceof Error ? err.message : String(err)));
          }
        }
        if (done > 0) setTranscribeMsg(isVN ? `✓ Đã tạo phụ đề cho ${done} cảnh` : `✓ Subtitles created for ${done} scenes`);
        else if (waiting > 0) setTranscribeMsg(isVN ? `📝 ${waiting} cảnh có voice nhưng chưa có lời thoại: gõ/dán lời vào ô của cảnh (miễn phí) hoặc bấm "AI nghe giọng".` : `${waiting} scenes need a script.`);
      }
      if (force) setEnableSubtitles(true);
    } finally {
      subsBusyRef.current = false;
      setIsTranscribing(false);
    }
  };

  const handleTranscribe = () => { void ensureSubtitles(true, false); }; // [SỬA] miễn phí: theo lời thoại có sẵn
  const handleTranscribeAI = () => { void ensureSubtitles(true, true); }; // [MỚI] tùy chọn: AI nghe giọng (Gemini)

  // [MỚI] Nhận voice + lời thoại gửi từ công cụ Giọng đọc ("Gửi sang Dựng phim")
  useEffect(() => {
    const take = () => {
      const p = takePendingVoice();
      if (p) void setMasterFromFile(p.file, p.text);
    };
    take();
    window.addEventListener(VOICE_HANDOFF_EVENT, take);
    return () => window.removeEventListener(VOICE_HANDOFF_EVENT, take);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // [MỚI] Ô "Lời thoại của voice": áp dụng sau 0.8s ngừng gõ → tách lại phụ đề (miễn phí)
  useEffect(() => {
    if (masterScriptDraft === masterScript) return;
    const t = setTimeout(() => {
      masterScriptRef.current = masterScriptDraft;
      setMasterScript(masterScriptDraft);
      setMasterScriptSrc(masterScriptDraft.trim() ? 'user' : 'none');
      masterCuesRef.current = [];
      setMasterCues([]);
      if (masterRef.current) subsFailedRef.current.delete('master:' + masterRef.current.url);
    }, 800);
    return () => clearTimeout(t);
  }, [masterScriptDraft, masterScript]);

  // [SỬA] Tự tạo phụ đề MIỄN PHÍ khi voice đã có lời thoại (không tự gọi AI)
  useEffect(() => {
    if (isProcessing || subsBusyRef.current) return;
    const needMaster = !!masterVoice && masterCues.length === 0 && !!masterScript.trim() && !subsFailedRef.current.has('master:' + masterVoice.url);
    const needScene = !masterVoice && scenes.some(sc => sc.voiceUrl && !sc.subtitleCues?.length && (sc.subtitleText || '').trim() && sc.subtitleCuesSrc !== 'script' && !subsFailedRef.current.has(sc.id));
    if (needMaster || needScene) void ensureSubtitles(false, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenes, masterVoice, masterCues, masterScript, isProcessing]);

  // Nhờ AI đổi tiêu đề slide thành từ khoá tiếng Anh để tìm ảnh miễn phí chính xác hơn
  const suggestPhotoKeywords = async (titles: string[]): Promise<string[]> => {
    const list = titles.map((t, i) => `${i + 1}. ${t}`).join('\n');
    const out = await generateGeminiText(
      `Với mỗi dòng dưới đây, hãy đưa ra 2-3 từ khoá TIẾNG ANH ngắn để tìm ảnh minh hoạ (ảnh chụp thật, danh từ cụ thể, không trừu tượng). Trả về đúng ${titles.length} dòng, mỗi dòng dạng "số. từ khoá", không giải thích.\n${list}`,
      'You output only the requested numbered list.',
      apiKeys,
      outputLanguage,
      useProjectKey,
      adminFreeKeys,
      adminPaidKeys
    );
    const res: string[] = titles.map(() => '');
    out.split('\n').forEach((ln) => {
      const m = ln.match(/^\s*(\d+)[.):\-]\s*(.+)$/);
      if (m) {
        const k = parseInt(m[1], 10) - 1;
        if (k >= 0 && k < res.length) res[k] = m[2].replace(/["*]/g, '').trim();
      }
    });
    return res;
  };

  // --- Nhập PDF / Word / PowerPoint / TXT / văn bản dán → cảnh ảnh ---
  const addSlidesAsScenes = (slides: ImportedSlide[], withText = false) => {
    if (slides.length === 0) return;
    const created: SceneItem[] = slides.map((sl, i) => {
      const url = URL.createObjectURL(sl.blob);
      cleanupUrlsRef.current.push(url);
      return {
        id: `scene_${Date.now()}_${Math.random().toString(36).substring(2, 7)}_${i}`,
        order: scenes.length + i + 1,
        videoUrl: url,
        isImage: true,
        videoName: sl.name,
        videoDuration: sl.seconds,
        videoWidth: sl.width,
        videoHeight: sl.height,
        ...(withText && sl.text ? { subtitleText: sl.text } : {}),
        ...(sl.spec ? { textSlide: sl.spec } : {}),
      };
    });
    setScenes(prev => [...prev, ...created]);
  };

  const handleImportDocs = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setIsImporting(true);
    try {
      for (const f of list) {
        const slides = await importDocument(f);
        if (slides.length === 0) {
          alert((isVN ? 'Không tìm thấy nội dung trong file: ' : 'No content found in: ') + f.name);
          continue;
        }
        addSlidesAsScenes(slides);
      }
    } catch (err) {
      alert((isVN ? 'Không đọc được file: ' : 'Could not read file: ') + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsImporting(false);
    }
  };

  const setSceneSeconds = (id: string, sec: number) => {
    const v = Math.max(1, Math.min(120, isFinite(sec) ? sec : 6));
    // [SỬA] chỉnh tay → đánh dấu thủ công: không tự chia / tự khớp đè lên
    setScenes(prev => prev.map(x => (x.id === id ? { ...x, videoDuration: v, targetDuration: undefined, manualSeconds: true } : x)));
  };

  /** [MỚI] Bỏ chỉnh tay → ảnh quay lại tự động theo giọng đọc */
  const resetSceneSeconds = (id: string) => {
    setScenes(prev => prev.map(x => (x.id === id ? { ...x, manualSeconds: false } : x)));
    syncSigRef.current = '';
  };

  /**
   * [MỚI] Voice dài 1 file: tự CHIA ĐỀU phần giọng còn lại cho các ảnh (trừ ảnh chỉnh tay, video giữ độ dài)
   * → tổng thời lượng phim = đúng độ dài giọng: không cụt giọng, không màn hình đen cuối.
   */
  useEffect(() => {
    if (!masterVoice) return;
    const visual = scenes.filter(sc => sc.videoUrl);
    const autoImgs = visual.filter(sc => sc.isImage && !sc.manualSeconds);
    if (autoImgs.length === 0) return;
    const fixed = visual.filter(sc => !(sc.isImage && !sc.manualSeconds)).reduce((a, sc) => a + sceneSeconds(sc), 0);
    const remain = Math.max(0, masterVoice.duration - masterStart) - fixed;
    const each = Math.round(Math.max(1, remain / autoImgs.length) * 100) / 100;
    if (autoImgs.every(sc => Math.abs(sc.videoDuration - each) < 0.02)) return;
    const ids = new Set(autoImgs.map(sc => sc.id));
    setScenes(prev => prev.map(x => ids.has(x.id) ? { ...x, videoDuration: each } : x));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masterVoice, masterStart, scenes]);

  /**
   * [MỚI] Nút "Tạo phụ đề" của TỪNG cảnh: AI nghe giọng cảnh đó → phụ đề đúng lời, đúng chỗ ngắt;
   * không có key / tắt "Phụ đề lấy theo giọng đọc" → căn chữ trong ô lời thoại theo chỗ giọng nghỉ.
   */
  const [sceneSubsBusy, setSceneSubsBusy] = useState<string | null>(null);
  const createSceneSubtitles = async (id: string, useAI = false) => { // [SỬA] miễn phí theo lời có sẵn; AI chỉ khi bấm
    const sc = scenesRef.current.find(x => x.id === id);
    if (!sc?.voiceUrl) return;
    setSceneSubsBusy(id);
    try {
      const blob = sc.voiceFile ?? await (await fetch(sc.voiceUrl)).blob();
      let sp = speechCacheRef.current.get(sc.voiceUrl);
      if (!sp) { sp = await analyzeSpeech(blob); speechCacheRef.current.set(sc.voiceUrl, sp); }
      const keys = allKeys();
      const knownText = (sc.subtitleText || '').trim();
      let cues: SubtitleCue[];
      let src: 'voice' | 'script' = 'script';
      if (knownText && !useAI) {
        cues = cuesFromTextAligned(knownText, sp); // miễn phí
      } else if (useAI) {
        if (keys.length === 0) throw new Error(isVN ? 'Dự án chưa có API key Gemini để AI nghe giọng.' : 'No Gemini API key.');
        cues = alignSegments(await transcribeSegments(blob, keys), sp);
        src = 'voice';
      } else {
        throw new Error(isVN ? 'Ô lời thoại của cảnh đang trống: gõ/dán lời của voice vào ô (miễn phí) hoặc bấm 🤖 AI nghe giọng.' : 'Scene text is empty.');
      }
      const text = src === 'voice' ? cues.map(c => c.text).join(' ') : knownText;
      const patch = { subtitleCues: cues, subtitleCuesSrc: src, subtitleText: text };
      scenesRef.current = scenesRef.current.map(x => x.id === id ? { ...x, ...patch } : x);
      setScenes(prev => prev.map(x => x.id === id ? { ...x, ...patch } : x));
      subsFailedRef.current.delete(id);
      setEnableSubtitles(true);
    } catch (err) {
      alert((isVN ? 'Không tạo được phụ đề cho cảnh này: ' : 'Could not create subtitles: ') + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSceneSubsBusy(null);
    }
  };

  // --- Handlers: Upload BGM ---
  const handleAddBgm = async (file: File) => {
    if (!file) return;
    if (bgmUrl) URL.revokeObjectURL(bgmUrl);
    const url = URL.createObjectURL(file);
    cleanupUrlsRef.current.push(url);
    const dur = await loadAudioDuration(file, url);
    setBgmUrl(url);
    setBgmName(file.name);
    setBgmDuration(dur);
    setEnableBgm(true);
  };

  // --- Handlers: Reorder & Remove Scenes ---
  const moveScene = (index: number, direction: 'up' | 'down') => {
    setScenes(prev => {
      const next = [...prev];
      const target = direction === 'up' ? index - 1 : index + 1;
      if (target < 0 || target >= next.length) return prev;
      const temp = next[index];
      next[index] = next[target];
      next[target] = temp;
      return next;
    });
  };

  const removeScene = (index: number) => {
    setScenes(prev => {
      const target = prev[index];
      if (target.videoUrl) URL.revokeObjectURL(target.videoUrl);
      if (target.voiceUrl) URL.revokeObjectURL(target.voiceUrl);
      return prev.filter((_, i) => i !== index);
    });
  };

  // --- Toggle Voice Audio Preview ---
  const togglePlayVoice = (sceneId: string, url: string) => {
    if (playingVoiceId === sceneId) {
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
      }
      setPlayingVoiceId(null);
      return;
    }

    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
    }

    const audio = new Audio(url);
    previewAudioRef.current = audio;
    audio.play();
    setPlayingVoiceId(sceneId);
    audio.onended = () => {
      setPlayingVoiceId(null);
    };
  };

  // --- AI AUTO SCRIPT & VOICE GENERATOR FROM USER DESCRIPTION ---

  /** [SỬA] Dự phòng (cách cũ, không xem hình): viết lời theo chủ đề, độ dài theo số giây từng cảnh */
  const writeScriptsByTopic = async (list: SceneItem[]): Promise<string[]> => {
    const n = list.length;
    const plan = list.map((sc, i) => `Cảnh ${i + 1}: khoảng ${wordsForSeconds(sceneSeconds(sc), outputLanguage)} từ` +
      (sc.directionText?.trim() ? ` (yêu cầu dựng: "${sc.directionText.trim()}")` : '')).join('\n'); // [SỬA] theo đoạn giữ lại + mô tả
    const prompt = `Bạn là một nhà biên kịch và đạo diễn video AI hàng đầu Hollywood.
Người dùng có tổng cộng ${n} cảnh video (scenes) và yêu cầu chủ đề/mô tả sau:
"${aiStoryPrompt.trim()}"

NHIỆM VỤ: Viết chính xác ${n} câu lời thoại (voiceover narration) bằng ${isVN ? 'tiếng Việt' : 'English'}, mỗi câu khớp đúng với 1 cảnh theo mạch truyện lôi cuốn từ mở đầu đến kết thúc.
ĐỘ DÀI TỪNG CẢNH (để giọng đọc vừa khít thời lượng cảnh):
${plan}
ĐỊNH DẠNG ĐẦU RA BẮT BUỘC (chỉ in đúng định dạng này, không có lời mở đầu hay kết thúc):
Cảnh 1: [Câu lời thoại cảnh 1]
...
Cảnh ${n}: [Câu lời thoại cảnh ${n}]`;
    const out = await generateGeminiText(prompt, '', apiKeys, outputLanguage, useProjectKey, adminFreeKeys, adminPaidKeys);
    const res: string[] = list.map(() => '');
    out.split('\n').forEach((ln) => {
      const m = ln.trim().match(/^(?:Cảnh|Scene)?\s*(\d+)\s*[:.)-]\s*(.+)$/i);
      if (m) {
        const k = parseInt(m[1], 10) - 1;
        if (k >= 0 && k < n) res[k] = m[2].replace(/^\[|\]$/g, '').trim();
      }
    });
    return res;
  };

  /**
   * [SỬA - A] AI xem ảnh/khung hình TỪNG cảnh → viết lời đúng nội dung cảnh, độ dài vừa số giây cảnh
   * → tạo giọng từng cảnh → phụ đề căn theo chỗ giọng nghỉ (dùng đúng lời đã viết, không tốn thêm API).
   * Không xem được hình → tự quay về viết theo chủ đề.
   */
  const handleGenerateAiVoiceAndScript = async () => {
    const base = scenesRef.current;
    if (base.length === 0) {
      alert(isVN
        ? 'Vui lòng thêm ảnh/video các cảnh trước để AI xem hình và viết lời cho từng cảnh!'
        : 'Please add scene images/videos first so AI can write narration for each scene!');
      return;
    }
    const hasVisual = base.some(sc => sc.videoUrl);
    if (!hasVisual && !aiStoryPrompt.trim()) {
      alert(isVN ? 'Chưa có hình cảnh nào: vui lòng nhập mô tả chủ đề để AI viết lời.' : 'No scene visuals: please enter a topic description.');
      return;
    }
    if (masterRef.current) {
      const ok = confirm(isVN
        ? 'Đang dùng voice dài 1 file. AI sẽ tạo giọng RIÊNG cho từng cảnh và bỏ voice dài này. Tiếp tục?'
        : 'A long voice file is in use. AI will create a voice per scene and remove the long voice. Continue?');
      if (!ok) return;
      removeMasterVoice();
    }

    setIsGeneratingAiVoice(true);
    try {
      const keys = allKeys();

      // 0) [MỚI] hiểu mô tả dựng cảnh trước (biết đoạn video giữ lại + thứ cần nhấn mạnh)
      setAiGenStatus(isVN ? '🤖 Đang hiểu mô tả dựng cảnh...' : 'Understanding scene directions...');
      await resolvePendingDirectives();

      // 1) AI xem hình → lời đúng cảnh (1 lần gọi cho tất cả cảnh)
      let lines: string[] = [];
      if (hasVisual && processKeys(keys).length > 0) {
        try {
          const visuals = base.map(b => toVisual(scenesRef.current.find(x => x.id === b.id) ?? b)); // [SỬA] dùng mô tả đã hiểu
          const frames = await captureAllScenes(visuals, (i, n) =>
            setAiGenStatus(isVN ? `👁 Đang lấy hình cảnh ${i}/${n}...` : `Capturing scene ${i}/${n}...`));
          setAiGenStatus(isVN ? '👁 AI đang xem hình và viết lời đúng nội dung từng cảnh...' : 'AI is writing narration for each scene...');
          lines = await writeSceneScripts(visuals, frames, aiStoryPrompt, outputLanguage, keys);
        } catch (e) {
          console.warn('AI xem hình lỗi, chuyển sang viết theo chủ đề:', e);
          lines = [];
        }
      }
      // 2) Dự phòng: viết theo chủ đề
      if (lines.filter(Boolean).length === 0) {
        if (!aiStoryPrompt.trim()) {
          throw new Error(isVN ? 'AI không xem được hình cảnh. Hãy nhập mô tả chủ đề để AI viết theo chủ đề.' : 'AI could not view the scenes. Enter a topic to write by topic.');
        }
        setAiGenStatus(isVN ? 'AI đang viết lời theo chủ đề...' : 'AI is writing by topic...');
        lines = await writeScriptsByTopic(base.map(b => scenesRef.current.find(x => x.id === b.id) ?? b));
      }

      const textOf = new Map<string, string>(base.map((sc, i) => [sc.id, (lines[i] || '').trim()]));
      const applyText = (arr: SceneItem[]) => arr.map(x => {
        const t = textOf.get(x.id);
        return t ? { ...x, subtitleText: t, subtitleCues: undefined, subtitleCuesSrc: 'script' as const } : x;
      });
      scenesRef.current = applyText(scenesRef.current);
      setScenes(prev => applyText(prev));

      // 3) Giọng đọc từng cảnh + phụ đề căn theo giọng (đúng chữ đã viết)
      const styleKeywords = {
        inspirational: 'Deep, warm, inspirational baritone voice, emotional and steady cadence',
        dramatic: 'Cinematic, suspenseful, dramatic narration, powerful storytelling tone',
        warm: 'Gentle, warm, natural baritone storytelling tone, emotional and intimate',
        marketing: 'Enthusiastic, bright, engaging marketing style, clear and confident'
      };
      const voiceLang = isVN ? 'vi-VN' : 'en-US'; // [SỬA] trước đây luôn 'vi-VN'
      // [MỚI] nhấn giọng các từ trong mô tả dựng cảnh
      const voiceStyleFor = (id: string, base0: string) => {
        const d = scenesRef.current.find(x => x.id === id)?.directive;
        const em = d ? Array.from(new Set([...d.emphasis, ...d.effects.map(e => e.word || '').filter(Boolean)])) : [];
        return em.length ? `${base0}. Emphasize clearly and slightly slower on: ${em.map(w => `"${w}"`).join(', ')}` : base0;
      };

      const voiceFailed: number[] = [];
      let voiceFirstError = '';
      for (let i = 0; i < base.length; i++) {
        const id = base[i].id;
        const textToSpeak = textOf.get(id);
        if (!textToSpeak) continue;
        setAiGenStatus(isVN ? `Đang tạo giọng đọc AI cho Cảnh ${i + 1}/${base.length}...` : `Generating voice for Scene ${i + 1}/${base.length}...`);
        try {
          const audioUri = await generateGeminiVoice(
            textToSpeak, voiceLang, aiVoiceGender, voiceStyleFor(id, styleKeywords[aiVoiceStyle]),
            apiKeys, outputLanguage, useProjectKey, 'studio', aiVoiceRegion, adminFreeKeys, adminPaidKeys
          );
          if (!audioUri) continue;
          const blob = await (await fetch(audioUri)).blob();
          const voiceName = `AI_Voice_Scene_${i + 1}.wav`;
          const voiceFile = new File([blob], voiceName, { type: blob.type || 'audio/wav' });
          const voiceUrl = URL.createObjectURL(blob);
          cleanupUrlsRef.current.push(voiceUrl);
          const voiceDuration = await loadAudioDuration(blob, voiceUrl);

          let cues: SubtitleCue[];
          try {
            const sp = await analyzeSpeech(blob);
            speechCacheRef.current.set(voiceUrl, sp);
            cues = cuesFromTextAligned(textToSpeak, sp);
          } catch {
            cues = cuesFromText(textToSpeak, 0.1, Math.max(0.8, voiceDuration));
          }
          subsFailedRef.current.delete(id);
          const patch = { voiceFile, voiceUrl, voiceName, voiceDuration, subtitleCues: cues, subtitleCuesSrc: 'script' as const };
          scenesRef.current = scenesRef.current.map(x => x.id === id ? { ...x, ...patch } : x);
          setScenes(prev => prev.map(x => x.id === id ? { ...x, ...patch } : x));
        } catch (voiceErr) {
          console.warn(`Lỗi tạo giọng cho cảnh ${i + 1}, tiếp tục cảnh khác:`, voiceErr);
          voiceFailed.push(i + 1);
          if (!voiceFirstError) voiceFirstError = voiceErr instanceof Error ? voiceErr.message : String(voiceErr);
        }
      }

      if (voiceFailed.length > 0) {
        alert(isVN
          ? `⚠ Đã viết lời cho ${base.length} cảnh nhưng tạo giọng LỖI ở cảnh: ${voiceFailed.join(', ')}.\nNguyên nhân: ${voiceFirstError}\nBạn có thể bấm tạo lại, hoặc thêm file voice của bạn.`
          : `⚠ Scripts written for ${base.length} scenes but voice failed for scenes: ${voiceFailed.join(', ')}.\nReason: ${voiceFirstError}`);
      } else {
        alert(isVN
          ? `🎉 AI đã viết lời theo hình từng cảnh, tạo giọng và phụ đề cho ${base.length} cảnh!\nBạn có thể nghe thử, sửa chữ (phụ đề tự cập nhật) hoặc bấm "TẠO PHIM".`
          : `🎉 Narration, voice and subtitles created for ${base.length} scenes!`);
      }
    } catch (err: any) {
      console.error('Lỗi khi AI tự tạo voice & kịch bản:', err);
      alert((isVN ? 'Đã xảy ra lỗi khi tạo voice tự động: ' : 'AI voice generation error: ') + (err.message || err));
    } finally {
      setIsGeneratingAiVoice(false);
      setAiGenStatus('');
    }
  };

  // Auto assign script text to scenes
  const applyBulkScript = () => {
    if (!bulkScript.trim()) {
      setShowScriptModal(false);
      return;
    }
    const lines = bulkScript
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('//') && !l.startsWith('#'));

    setScenes(prev => {
      return prev.map((scene, idx) => {
        if (idx < lines.length) {
          const cleaned = lines[idx].replace(/^(?:scene|c[aả]nh|\d+)[:\-\s.]+/i, '').trim();
          return { ...scene, subtitleText: cleaned || lines[idx], subtitleCues: undefined, subtitleCuesSrc: 'script' as const }; // [SỬA - B] chữ mới → căn lại
        }
        return scene;
      });
    });
    setShowScriptModal(false);
    // [SỬA - B] căn phụ đề mới theo giọng từng cảnh
    setTimeout(() => { scenesRef.current.forEach(sc => { if (sc.voiceUrl && sc.subtitleCuesSrc === 'script' && !sc.subtitleCues) void realignSceneText(sc.id); }); }, 50);
  };

  // --- Total Calculated Duration of Film ---
  const totalDuration = useMemo(
    () => estimateTotalDuration(scenes.filter(sc => sc.videoUrl).map(sc => ({
      id: sc.id,
      // [SỬA] video: theo đoạn giữ lại; ảnh có voice (tự động): đúng độ dài giọng
      videoDuration: imageVoiceSeconds(sc) ?? sceneSeconds(sc),
      videoWidth: sc.videoWidth,
      videoHeight: sc.videoHeight,
      voiceDuration: sc.voiceUrl ? sc.voiceDuration : undefined,
      targetDuration: masterVoice ? sc.targetDuration : undefined, // [SỬA - C]
    })), { masterVoice: !!masterVoice }) + (socialMode && scenes.some(sc => sc.videoUrl) ? 1.5 : 0), // [SỬA] MXH giữ cảnh cuối +1.5s
    [scenes, masterVoice, socialMode],
  );

  // --- CORE AUTOMATIC VIDEO RENDERING ENGINE ---
  const handleCreateMovie = async () => {
    if (isProcessing) return;
    if (scenes.length === 0) {
      alert(isVN ? 'Vui lòng thêm ít nhất 1 video clip để tạo phim!' : 'Please add at least 1 video clip!');
      return;
    }

    const validScenes = scenes.filter(s => s.videoUrl);
    if (validScenes.length === 0) {
      alert(isVN ? 'Không có video clip hợp lệ nào trong danh sách!' : 'No valid video clips found!');
      return;
    }

    const skipped = scenes.length - validScenes.length;
    if (skipped > 0) {
      const ok = confirm(isVN
        ? `Có ${skipped} cảnh mới chỉ có voice, chưa có video nên sẽ bị bỏ qua. Tiếp tục tạo phim?`
        : `${skipped} scene(s) have a voice but no video and will be skipped. Continue?`);
      if (!ok) return;
    }

    // --- Kiểm tra quyền dùng (CHƯA trừ gì: chỉ trừ khi dựng thành công) ---
    let willUseTrial = false;
    if (isAdminOrVip) {
      // VIP / Admin -> không giới hạn
    } else if (remainingTrials > 0) {
      willUseTrial = true;
    } else {
      const currentCredit = credit || 0;
      if (currentCredit < COST_PER_MOVIE) {
        setShowPricingModal(true);
        alert(isVN
          ? `⚠️ Bạn đã dùng hết ${MAX_FREE_TRIALS} lượt trải nghiệm miễn phí!\n\nSố dư hiện tại: ${currentCredit} credit (Mỗi lần xuất phim quy đổi = ${COST_PER_MOVIE} credit).\nVui lòng chọn gói nâng cấp hoặc nạp credit để tiếp tục xuất phim!`
          : `⚠️ You have used all ${MAX_FREE_TRIALS} free trials!\nCurrent balance: ${currentCredit} credits (Requires ${COST_PER_MOVIE} credits per movie).\nPlease upgrade or top up to continue!`);
        return;
      }
    }

    // Xóa kết quả cũ (nếu có) rồi bắt đầu
    renderResult?.dispose();
    setRenderResult(null);
    setIsProcessing(true);
    setProgressPercent(1);
    setStatusMessage(isVN ? 'Đang chuẩn bị dựng phim tự động...' : 'Preparing the auto video editor...');

    // Phụ đề theo giọng đọc: nếu chưa có thì tạo xong rồi mới dựng
    if (enableSubtitles) {
      while (subsBusyRef.current) await new Promise(r => setTimeout(r, 300));
      setStatusMessage(isVN ? 'Đang tạo phụ đề theo giọng đọc...' : 'Creating subtitles from voice...');
      await ensureSubtitles(false);
    }
    // [SỬA - B] chờ các ô lời thoại vừa sửa được căn lại xong
    const pendingRealign = scenesRef.current.filter(sc => sc.voiceUrl && sc.subtitleCuesSrc === 'script' && !sc.subtitleCues && (sc.subtitleText || '').trim());
    for (const sc of pendingRealign) await realignSceneText(sc.id);
    // [SỬA - C] voice dài: khớp thời lượng cảnh theo lời (chỉ gọi AI khi có thay đổi)
    if (masterVoice && syncScenesToVoice && masterCuesRef.current.length > 0) {
      setStatusMessage(isVN ? 'Đang khớp cảnh theo lời đọc...' : 'Matching scenes to narration...');
      await syncScenesToMaster(masterCuesRef.current);
    }
    // [MỚI] hiểu nốt các mô tả dựng cảnh cần AI (1 lần gọi)
    if (scenesRef.current.some(sc => sc.directive?.needsAI)) {
      setStatusMessage(isVN ? 'Đang hiểu mô tả dựng cảnh...' : 'Understanding scene directions...');
      await resolvePendingDirectives();
    }
    const renderScenes = scenesRef.current
      .filter(sc => sc.videoUrl)
      .map(sc => ({
        ...sc,
        targetDuration: masterVoice && syncScenesToVoice ? sc.targetDuration : undefined,
        keepSegments: sceneSegments(sc),   // [MỚI] giữ/bỏ đoạn video
        effects: sceneEffects(sc),         // [MỚI] mô tả > chọn tay > chung
        emphasis: sc.directive?.emphasis,  // [MỚI] tô màu phụ đề
      }));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await renderMovie(
        {
          scenes: renderScenes,
          settings: {
            aspectRatio, fitMode, quality,
            fillAmount: fillAmount / 100,   // [MỚI] 0 = giữ đủ hình
            focusX: focusX / 100,           // [MỚI] vị trí giữ lại khi cắt
            keepOriginalAudio: keepOrigAudio,          // [MỚI] giữ tiếng gốc của clip
            originalVolume: origVolume / 100,          // [MỚI] 100% = nguyên bản
            splitScreen: splitScreen && !!secondaryVideo, // [MỚI] ghép 2 video song song
            splitMainPos: splitPos,                    // [MỚI] clip chính: trên / giữa / dưới
            enableSubtitles, subtitleStyle,
            enableBgm: enableBgm && !!bgmUrl,
            bgmVolume,
            revealObjects,
            transitions: enableTransitions,
            typewriter: enableTypewriter,
            sharpText,
            style: presentationStyle ? 'presentation' : 'classic',
            imageEffect: globalEffect,      // [MỚI] hiệu ứng chung toàn video
            emphasisColor,                  // [MỚI] tô màu từ nhấn mạnh
            socialMode,                     // [MỚI] Mạng xã hội 9:16
            subtitleY: subtitleYValue,      // [MỚI] vị trí phụ đề
            karaoke,                        // [MỚI] sáng từng từ theo giọng
          },
          bgm: bgmUrl ? { url: bgmUrl, name: bgmName || 'bgm.mp3' } : undefined,
          masterVoice: masterVoice ? { url: masterVoice.url, startAt: masterStart } : undefined,
          secondaryVideo: splitScreen && secondaryVideo ? { url: secondaryVideo.url, name: secondaryVideo.name } : undefined, // [MỚI]
          subtitleCues: masterVoice && masterCuesRef.current.length > 0 ? masterCuesRef.current : undefined,
        },
        {
          signal: controller.signal,
          onProgress: (percent, message) => {
            if (percent >= 0) setProgressPercent(Math.min(99, percent));
            setStatusMessage(message);
          },
        },
      );

      // --- Dựng thành công -> bây giờ mới trừ lượt dùng thử / credit ---
      if (!isAdminOrVip) {
        if (willUseTrial) {
          const nextUsed = usedTrials + 1;
          setUsedTrials(nextUsed);
          localStorage.setItem(getTrialStorageKey(email), nextUsed.toString());
        } else if (deductCredit) {
          const ok = await deductCredit(COST_PER_MOVIE);
          if (!ok) {
            result.dispose();
            setShowPricingModal(true);
            alert(isVN
              ? 'Phim đã dựng xong nhưng không trừ được credit nên chưa thể giao phim. Vui lòng kiểm tra số dư/kết nối rồi bấm TẠO PHIM lại.'
              : 'The movie is ready but credits could not be deducted. Please check your balance/connection and try again.');
            return;
          }
        }
      }

      setRenderResult(result);
      setProgressPercent(100);
      setStatusMessage(isVN ? '✅ XUẤT PHIM THÀNH CÔNG!' : '✅ MOVIE EXPORTED SUCCESSFULLY!');
    } catch (err: any) {
      if (err instanceof RenderCancelled) {
        setStatusMessage(isVN ? 'Đã hủy dựng phim.' : 'Movie creation cancelled.');
      } else {
        console.error('Lỗi khi dựng phim tự động:', err);
        alert((isVN ? 'Không tạo được phim: ' : 'Could not create the movie: ') + (err?.message || err));
      }
    } finally {
      abortRef.current = null;
      setIsProcessing(false);
    }
  };

  const handleDownloadMovie = () => {
    if (!renderResult) return;
    const cleanTitle = movieTitle.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'Phim_AI';
    const a = document.createElement('a');
    a.href = renderResult.downloadUrl(cleanTitle);
    a.download = `${cleanTitle}.${renderResult.extension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleResetMovie = () => {
    renderResult?.dispose();
    setRenderResult(null);
    setProgressPercent(0);
    setStatusMessage('');
  };

  return (
    <div className="flex-1 bg-slate-950 flex flex-col min-h-0 overflow-y-auto custom-scrollbar font-sans text-slate-100 p-3 sm:p-5">
      {/* ── Header Banner (Dark Luxury Cinema) ────────────────── */}
      <div className="bg-slate-900 rounded-2xl sm:rounded-3xl p-4 sm:p-5 shadow-xl mb-4 border border-slate-800 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="bg-amber-500 text-slate-950 font-black text-[9px] uppercase px-2 py-0.5 rounded-md shadow-sm tracking-wider">
              CINEMA AUTO STUDIO PRO
            </span>
            <span className="text-emerald-400 text-[10px] font-bold flex items-center gap-1.5 bg-slate-950 px-2 py-0.5 rounded-md border border-slate-800">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
              {isVN ? 'TỰ ĐỘNG HÓA 100%' : '100% AUTOMATED'}
            </span>
          </div>
          <h2 className="text-xl sm:text-2xl font-black italic tracking-tight uppercase flex items-center gap-2 text-white">
            🎬 {isVN ? 'DỰNG VIDEO TỰ ĐỘNG' : 'AUTO VIDEO CREATOR'}
          </h2>
          <p className="text-xs text-slate-300 font-medium opacity-90 mt-1 max-w-2xl leading-relaxed">
            {isVN 
              ? 'Tự động ghép video + voice, căn chỉnh thời lượng, lồng nhạc nền và gắn phụ đề xuất xưởng chỉ với 1 click.' 
              : 'Auto-sync scenes with voiceovers, fit durations, blend BGM with audio ducking and render subtitles with 1 click.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto justify-end">
          {/* Trial / Credit status badge */}
          <div className="px-3.5 py-2 bg-slate-950 rounded-xl border border-slate-800 shadow-inner flex items-center gap-1.5">
            {isAdminOrVip ? (
              <span className="text-[10px] font-black text-amber-400 uppercase flex items-center gap-1 tracking-wider">
                👑 VIP UNLIMITED
              </span>
            ) : remainingTrials > 0 ? (
              <span className="text-[10px] font-black text-emerald-400 uppercase flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                {isVN ? `Dùng thử: Còn ${remainingTrials}/${MAX_FREE_TRIALS} lượt` : `Trial: ${remainingTrials}/${MAX_FREE_TRIALS} left`}
                <span className="text-[9px] text-slate-400 font-medium">({COST_PER_MOVIE} cr/phim)</span>
              </span>
            ) : (
              <span className="text-[10px] font-black text-amber-400 uppercase flex items-center gap-1">
                💎 {credit || 0} Credits
                <span className="text-[9px] text-slate-400 font-medium">({COST_PER_MOVIE} cr/lần)</span>
              </span>
            )}
          </div>

          {/* Engine status badge */}
          <button
            type="button"
            onClick={refreshEngine}
            className="px-3.5 py-2 bg-slate-950 rounded-xl border border-slate-800 shadow-inner flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider active:scale-95"
            title={isVN ? 'Bấm để kiểm tra lại máy dựng' : 'Click to re-check the render engine'}
          >
            {engineKind === 'server' ? (
              <span className="text-emerald-400">⚡ {isVN ? 'Máy dựng: sẵn sàng' : 'Engine: ready'}</span>
            ) : engineKind === 'browser' ? (
              <span className="text-amber-400">🌐 {isVN ? 'Dựng bằng trình duyệt' : 'Browser mode'}</span>
            ) : (
              <span className="text-slate-400">… {isVN ? 'Đang kiểm tra' : 'Checking'}</span>
            )}
          </button>

          {/* Pricing Button */}
          <button
            onClick={() => setShowPricingModal(true)}
            className="px-3.5 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded-xl text-xs font-black uppercase transition flex items-center gap-1.5 shadow-sm active:scale-95"
            title={isVN ? 'Bảng giá và nâng cấp' : 'Pricing & Upgrade'}
          >
            <CreditCard size={14} className="text-slate-950" />
            <span>{isVN ? 'Bảng Giá Dựng Phim' : 'Pricing & Packs'}</span>
          </button>

          <button
            onClick={() => setShowScriptModal(true)}
            className="px-3.5 py-2 bg-slate-800/90 hover:bg-slate-700 text-white rounded-xl text-xs font-bold uppercase transition flex items-center justify-center gap-1.5 border border-slate-700/70 shadow-sm"
          >
            <FileText size={14} className="text-amber-400" />
            <span>{isVN ? 'Dán Kịch Bản' : 'Paste Script'}</span>
          </button>
          {scenes.length > 0 && (
            <button
              onClick={() => {
                if (confirm(isVN ? 'Bạn có chắc chắn muốn xóa toàn bộ cảnh đã thêm?' : 'Clear all scenes?')) {
                  setScenes([]);
                  handleResetMovie();
                }
              }}
              className="px-3 py-2 bg-red-950/40 hover:bg-red-900/60 text-red-300 rounded-xl text-xs font-bold transition flex items-center gap-1 border border-red-800/60"
              title={isVN ? 'Xóa hết cảnh' : 'Clear all'}
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>

      {engineKind === 'browser' && (
        <details className="mb-4 bg-amber-950/30 border border-amber-800/50 rounded-2xl px-4 py-3 text-xs text-amber-200">
          <summary className="cursor-pointer font-bold">
            {isVN
              ? '💡 Đang dựng bằng trình duyệt (chậm hơn). Bấm để xem cách bật máy dựng nhanh & ổn định'
              : '💡 Using browser mode (slower). Click to see how to enable the fast render engine'}
          </summary>
          <ol className="list-decimal ml-5 mt-2 space-y-1 text-amber-100/90 leading-relaxed">
            <li>{isVN ? 'Trên máy tính, mở thư mục render-server và chạy file start-engine.bat (lần đầu sẽ tự cài, mất vài phút).' : 'On your computer, open the render-server folder and run start-engine.bat (first run installs automatically).'}</li>
            <li>{isVN ? 'Giữ cửa sổ đen đó mở. Quay lại đây và bấm huy hiệu "Dựng bằng trình duyệt" để kiểm tra lại.' : 'Keep that window open, come back and click the "Browser mode" badge to re-check.'}</li>
            <li>{isVN ? 'Dùng Chrome hoặc Edge. Nếu trình duyệt hỏi quyền truy cập thiết bị cục bộ, hãy chọn Cho phép.' : 'Use Chrome or Edge. If asked for local device access, choose Allow.'}</li>
          </ol>
        </details>
      )}

      {/* ── Main Workspace Grid (Left: Uploads & Scenes; Right: Settings & Render) ──── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 flex-1 min-h-0 mb-4">
        
        {/* Left Column (8/12) */}
        <div className="lg:col-span-8 flex flex-col gap-3.5">
          
          {/* Top 3 Quick Upload Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {/* 1. Add Videos */}
            <div 
              onClick={() => videoInputRef.current?.click()}
              className="bg-slate-900/90 hover:bg-slate-850 border-2 border-dashed border-indigo-500/40 hover:border-indigo-400 rounded-2xl p-4 flex flex-col items-center justify-center cursor-pointer transition group shadow-lg text-center"
            >
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white flex items-center justify-center mb-2 shadow-md group-hover:scale-110 transition">
                <Film size={20} />
              </div>
              <span className="text-xs font-black uppercase text-indigo-200 tracking-tight">
                {isVN ? '+ Thêm Ảnh / Video Clip' : '+ Add Images / Video Clips'}
              </span>
              <span className="text-[10px] text-slate-400 font-medium mt-0.5">
                {isVN ? 'Ảnh slide (png, jpg) hoặc clip: scene_001...' : 'Slide images or video clips'}
              </span>
              <input 
                type="file" 
                ref={videoInputRef} 
                onChange={(e) => { if (e.target.files) handleAddVideos(e.target.files); e.target.value = ''; }} 
                multiple 
                accept="video/*,image/*" 
                hidden 
              />
            </div>

            {/* 2. Add Voices */}
            <div 
              onClick={() => voiceInputRef.current?.click()}
              tabIndex={0}
              onDragOver={(e) => { e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files?.length) void handleAddVoices(e.dataTransfer.files); }}
              onPaste={(e) => {
                const fl: File[] = e.clipboardData?.files ? Array.from(e.clipboardData.files) : [];
                if (fl.length) { e.preventDefault(); void handleAddVoices(fl); }
              }}
              className="bg-slate-900/90 hover:bg-slate-850 border-2 border-dashed border-emerald-500/40 hover:border-emerald-400 rounded-2xl p-4 flex flex-col items-center justify-center cursor-pointer transition group shadow-lg text-center"
            >
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-700 text-white flex items-center justify-center mb-2 shadow-md group-hover:scale-110 transition">
                <Mic size={20} />
              </div>
              <span className="text-xs font-black uppercase text-emerald-200 tracking-tight">
                {isVN ? '+ Thêm File Voice' : '+ Add Voice Files'}
              </span>
              <span className="text-[10px] text-slate-400 font-medium mt-0.5">
                {isVN ? 'Bấm chọn, kéo thả hoặc bấm vào ô rồi Ctrl+V để dán file. 1 file dài = tự chia theo giây từng cảnh' : 'Click, drag & drop, or focus and press Ctrl+V. One long file is split by scene seconds'}
              </span>
              <input 
                type="file" 
                ref={voiceInputRef} 
                onChange={(e) => { if (e.target.files) handleAddVoices(e.target.files); e.target.value = ''; }} 
                multiple 
                accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,.weba,.wma,.amr,.mp4,.webm" 
                hidden 
              />
            </div>

            {/* 3. Add BGM */}
            <div 
              onClick={() => bgmInputRef.current?.click()}
              className={`border-2 border-dashed rounded-2xl p-4 flex flex-col items-center justify-center cursor-pointer transition group shadow-lg text-center ${
                bgmUrl 
                  ? 'bg-amber-950/30 border-amber-500/60' 
                  : 'bg-slate-900/90 hover:bg-slate-850 border-amber-500/30 hover:border-amber-400'
              }`}
            >
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-2 shadow-md group-hover:scale-110 transition ${
                bgmUrl ? 'bg-gradient-to-br from-amber-400 to-amber-600 text-slate-950' : 'bg-slate-800 text-amber-400'
              }`}>
                <Music size={20} />
              </div>
              <span className="text-xs font-black uppercase text-amber-200 tracking-tight truncate max-w-full px-2">
                {bgmUrl ? `🎵 ${bgmName}` : (isVN ? '+ Thêm Nhạc Nền BGM' : '+ Add Background Music')}
              </span>
              <span className="text-[10px] text-slate-400 font-medium mt-0.5">
                {bgmUrl ? `${Math.round(bgmDuration)}s • ${isVN ? 'Đã tải' : 'Loaded'}` : (isVN ? 'Mặc định 40%, êm, không đổi đột ngột' : 'Default 40%, smooth, no sudden changes')}
              </span>
              <input 
                type="file" 
                ref={bgmInputRef} 
                onChange={(e) => { if (e.target.files?.[0]) handleAddBgm(e.target.files[0]); e.target.value = ''; }} 
                accept="audio/*" 
                hidden 
              />
            </div>
          </div>

          {/* ── NHẬP DỮ LIỆU ĐA DẠNG · VOICE DÀI · PHỤ ĐỀ THEO GIỌNG ────────── */}
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 shadow-xl space-y-3">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => docInputRef.current?.click()}
                disabled={isImporting}
                className="flex-1 min-w-[180px] flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:bg-slate-800 disabled:text-slate-500 text-white text-[11px] font-black uppercase transition"
              >
                {isImporting ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />}
                {isVN ? 'Nhập PDF / Word / PowerPoint / TXT' : 'Import PDF / Word / PowerPoint / TXT'}
              </button>
              <button
                type="button"
                onClick={() => setShowPasteModal(true)}
                className="flex-1 min-w-[160px] flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-100 text-[11px] font-black uppercase transition"
              >
                <ClipboardPaste size={14} />
                {isVN ? 'Dán văn bản → slide' : 'Paste text → slides'}
              </button>
              <input
                type="file"
                ref={docInputRef}
                accept=".pdf,.docx,.pptx,.txt,.md,text/plain"
                multiple
                hidden
                onChange={(e) => { if (e.target.files) handleImportDocs(e.target.files); e.target.value = ''; }}
              />
            </div>
            <p className="text-[10px] text-slate-500 leading-relaxed">
              {isVN
                ? 'Mỗi trang PDF / slide / phần văn bản sẽ thành 1 cảnh ảnh. Chỉnh số giây từng cảnh ở danh sách bên dưới. PowerPoint dạng chữ sẽ được dựng lại slide đẹp; muốn giữ nguyên 100% hình dạng, hãy xuất PowerPoint ra PDF rồi nhập PDF.'
                : 'Each PDF page / slide / text block becomes one image scene. Set seconds per scene below.'}
            </p>

            {masterVoice && (
              <div className="flex flex-wrap items-center gap-2 bg-emerald-950/40 border border-emerald-800/50 rounded-2xl px-3 py-2 text-[11px] text-emerald-200">
                <Mic size={13} className="text-emerald-400 shrink-0" />
                <span className="font-black truncate max-w-[220px]">{masterVoice.name}</span>
                <span className="text-emerald-400 font-black">({masterVoice.duration.toFixed(1)}s)</span>
                <span className="text-slate-400">
                  {syncScenesToVoice
                    ? (isVN ? 'Voice dài: hình tự chuyển cảnh đúng lúc lời chuyển ý' : 'Long voice: scenes switch exactly when the narration moves on')
                    : (isVN ? 'Voice dài: cắt từ đầu theo số giây từng cảnh, phần dư cuối bỏ' : 'Long voice: cut from start by scene length, remainder dropped')}
                </span>
                {/* [MỚI - C] bật/tắt khớp cảnh theo lời */}
                <label className="flex items-center gap-1 text-slate-300 font-bold cursor-pointer">
                  <input
                    type="checkbox"
                    checked={syncScenesToVoice}
                    onChange={(e) => {
                      setSyncScenesToVoice(e.target.checked);
                      if (e.target.checked && masterCuesRef.current.length > 0) void syncScenesToMaster(masterCuesRef.current, true);
                    }}
                    className="accent-emerald-500"
                  />
                  {isVN ? 'Chuyển cảnh ở cuối câu (khớp theo lời)' : 'Switch scenes at sentence ends'}
                </label>
                <label className="flex items-center gap-1 text-slate-300">
                  {isVN ? 'Bắt đầu từ giây' : 'Start at sec'}
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={masterStart}
                    onChange={(e) => setMasterStart(Math.max(0, parseFloat(e.target.value) || 0))}
                    className="w-16 bg-slate-950 border border-slate-700 rounded px-1 text-center text-white outline-none focus:border-amber-400"
                  />
                </label>
                <button type="button" onClick={removeMasterVoice} className="ml-auto text-rose-300 hover:text-rose-200 font-black uppercase">
                  {isVN ? 'Bỏ voice dài' : 'Remove'}
                </button>
              </div>
            )}

            {/* [MỚI] Lời thoại của voice dài — có lời là tách phụ đề + chia cảnh MIỄN PHÍ, không cần AI */}
            {masterVoice && (
              <div className="bg-slate-950/70 border border-emerald-900/60 rounded-2xl p-3 space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[10px] font-black uppercase text-emerald-300">{isVN ? 'Lời thoại của voice' : 'Voice script'}</span>
                  <span className="text-[10px] font-bold text-slate-400">
                    {masterScriptSrc === 'handoff' ? (isVN ? '✓ nhận kèm từ công cụ Giọng đọc' : '✓ from voice tool')
                      : masterScriptSrc === 'memory' ? (isVN ? '✓ tự nhận lời của voice tạo trong app' : '✓ recognized from app voice')
                      : masterScriptSrc === 'user' ? (isVN ? '✓ lời bạn dán' : '✓ pasted')
                      : (isVN ? 'chưa có — dán lời vào đây (miễn phí)' : 'empty — paste here')}
                  </span>
                </div>
                <textarea
                  rows={3}
                  value={masterScriptDraft}
                  onChange={(e) => setMasterScriptDraft(e.target.value)}
                  placeholder={isVN
                    ? 'Dán lời đọc của voice. Muốn chia đúng cảnh thì ghi: Cảnh 1: … Cảnh 2: … (không ghi thì tự chia lần lượt theo ảnh, chuyển cảnh ở cuối câu)'
                    : 'Paste the voice script. Use "Scene 1: … Scene 2: …" to split exactly.'}
                  className="w-full bg-slate-900 border border-slate-800 rounded-xl p-2 text-[11px] text-slate-100 placeholder:text-slate-500 outline-none focus:border-emerald-500 resize-y"
                />
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {/* [SỬA] nút tạo phụ đề đã chuyển sang cột phải, mục 5 "Phụ đề" */}
              <div className="w-full flex flex-wrap gap-x-5 gap-y-1.5 bg-slate-950/60 border border-slate-800 rounded-xl px-3 py-2">
                <span className="text-[10px] font-black uppercase text-slate-400 w-full">{isVN ? 'Hiệu ứng (tích để bật, bỏ tích để tắt)' : 'Effects (tick to enable)'}</span>
                <label className="flex items-center gap-2 text-[11px] text-slate-300 font-bold cursor-pointer">
                  <input type="checkbox" checked={presentationStyle} onChange={(e) => setPresentationStyle(e.target.checked)} className="accent-indigo-500" />
                  {isVN ? 'Kiểu trình chiếu (nền màu, khung bo góc)' : 'Presentation look'}
                </label>
                <label className="flex items-center gap-2 text-[11px] text-slate-300 font-bold cursor-pointer">
                  <input type="checkbox" checked={enableTransitions} onChange={(e) => setEnableTransitions(e.target.checked)} className="accent-indigo-500" />
                  {isVN ? 'Chuyển cảnh mượt' : 'Smooth transitions'}
                </label>
                <label className="flex items-center gap-2 text-[11px] text-slate-300 font-bold cursor-pointer">
                  <input type="checkbox" checked={enableTypewriter} onChange={(e) => setEnableTypewriter(e.target.checked)} className="accent-indigo-500" />
                  {isVN ? 'Slide chữ: đánh máy (tắt = tự hiện từng ý)' : 'Text slides: typewriter (off = auto bullets)'}
                </label>
                <label className="flex items-center gap-2 text-[11px] text-slate-300 font-bold cursor-pointer">
                  <input type="checkbox" checked={sharpText} onChange={(e) => setSharpText(e.target.checked)} className="accent-indigo-500" />
                  {isVN ? 'Tăng nét tối ưu (chữ nhỏ, PDF, slide ảnh) - video nặng hơn chút' : 'Optimal sharpening (small text, PDF) - slightly larger file'}
                </label>
                {/* [MỚI] Hiệu ứng chung toàn video (cảnh không có mô tả / không chọn tay) */}
                <label className="flex items-center gap-2 text-[11px] text-slate-300 font-bold">
                  {isVN ? 'Hiệu ứng chung:' : 'Global effect:'}
                  <select
                    value={globalEffect}
                    onChange={(e) => setGlobalEffect(e.target.value as 'auto' | 'none' | EffectKind)}
                    className="bg-slate-950 border border-slate-700 rounded px-1.5 py-0.5 text-[11px] text-white outline-none focus:border-amber-400"
                  >
                    <option value="auto">{isVN ? 'Tự động (slide hiện lần lượt)' : 'Auto'}</option>
                    <option value="none">{isVN ? 'Không hiệu ứng' : 'None'}</option>
                    {EFFECT_KINDS.map(k => <option key={k} value={k}>{EFFECT_LABEL[k][isVN ? 'VN' : 'EN']}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-[11px] text-slate-300 font-bold cursor-pointer">
                  <input type="checkbox" checked={revealObjects} onChange={(e) => setRevealObjects(e.target.checked)} className="accent-indigo-500" />
                  {isVN ? 'Slide ảnh: từng khối hiện lần lượt' : 'Image slides: reveal block by block'}
                </label>
              </div>
            </div>
            <p className="text-[10px] text-amber-300/80 leading-relaxed">
              {isVN
                ? '⚠ Phim được dựng ngay trên máy này theo thời gian thực: giữ tab mở và máy không tắt/ngủ cho đến khi xuất xong. Tắt máy hoặc đóng tab giữa chừng sẽ không ra phim.'
                : '⚠ The movie is rendered on this computer in real time: keep this tab open and the computer awake until it finishes.'}
            </p>
          </div>

          {showPasteModal && (
            <SlideMaker
              isVN={isVN}
              onClose={() => setShowPasteModal(false)}
              onAdd={(slides) => addSlidesAsScenes(slides, true)}
              suggestKeywords={suggestPhotoKeywords}
            />
          )}

          {/* ── AI SMART VOICE & SCRIPT GENERATOR BOX ────────── */}
          <div className="bg-gradient-to-br from-indigo-950/60 via-slate-900 to-slate-900 border border-indigo-500/30 rounded-3xl p-4 shadow-xl">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 mb-2.5">
              <div className="flex items-center gap-2">
                <span className="p-1.5 rounded-xl bg-amber-400 text-slate-950 shadow-md">
                  <Wand2 size={16} />
                </span>
                <div>
                  <h4 className="text-xs font-black uppercase tracking-wider text-amber-300">
                    {isVN ? 'AI TỰ TẠO LỜI THOẠI & LỒNG VOICE TỪ MÔ TẢ' : 'AI AUTO SCENE VOICEOVER FROM DESCRIPTION'}
                  </h4>
                  <p className="text-[10px] text-slate-400 font-medium">
                    {isVN ? 'Chỉ cần gõ mô tả, AI tự viết kịch bản khớp từng clip và sinh giọng đọc truyền cảm' : 'Just describe your story, AI writes scripts and generates matching voiceovers'}
                  </p>
                </div>
              </div>
              <span className="text-[10px] font-bold text-indigo-400 bg-indigo-950/60 px-2 py-0.5 rounded-full border border-indigo-800/50">
                {scenes.length > 0 
                  ? (isVN ? `Đang có ${scenes.length} cảnh` : `${scenes.length} scenes ready`) 
                  : (isVN ? 'Hãy thêm video trước' : 'Add videos first')}
              </span>
            </div>

            {/* Description Textarea */}
            <div className="relative mb-3">
              <textarea
                rows={2}
                value={aiStoryPrompt}
                onChange={(e) => setAiStoryPrompt(e.target.value)}
                placeholder={isVN 
                  ? "(Tùy chọn – AI tự xem hình từng cảnh để viết lời) Nhập mô tả câu chuyện / phong cách muốn dựng (Ví dụ: Kể về hành trình khởi nghiệp từ hai bàn tay trắng vượt qua bão giông, giọng nam trầm ấm truyền cảm, kết thúc đầy hy vọng và tự hào)..." 
                  : "Describe your video theme (e.g. An inspirational story about an entrepreneur overcoming obstacles, deep warm male voice, epic and uplifting tone)..."}
                className="w-full bg-slate-950/90 border border-slate-700/80 rounded-2xl p-3 text-xs text-slate-100 placeholder:text-slate-500 outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400/40 shadow-inner resize-none transition"
              />
            </div>

            {/* Voice Style & Tone Controls */}
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex flex-wrap items-center gap-2">
                {/* Gender */}
                <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800">
                  <button
                    type="button"
                    onClick={() => setAiVoiceGender('MALE')}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-black uppercase transition ${
                      aiVoiceGender === 'MALE' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {isVN ? '👨 Giọng Nam' : '👨 Male'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAiVoiceGender('FEMALE')}
                    className={`px-2.5 py-1 rounded-lg text-[10px] font-black uppercase transition ${
                      aiVoiceGender === 'FEMALE' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {isVN ? '👩 Giọng Nữ' : '👩 Female'}
                  </button>
                </div>

                {/* Tone */}
                <select
                  value={aiVoiceStyle}
                  onChange={(e) => setAiVoiceStyle(e.target.value as any)}
                  className="bg-slate-950 border border-slate-800 text-slate-200 text-[10px] font-bold rounded-xl px-2.5 py-1.5 outline-none focus:border-amber-400 cursor-pointer"
                >
                  <option value="inspirational">{isVN ? '✨ Trầm ấm truyền cảm' : '✨ Inspirational'}</option>
                  <option value="dramatic">{isVN ? '🎭 Kịch tính phim ảnh' : '🎭 Dramatic Cinema'}</option>
                  <option value="warm">{isVN ? '💖 Nhẹ nhàng sâu lắng' : '💖 Warm & Gentle'}</option>
                  <option value="marketing">{isVN ? '⚡ Hào hùng quảng cáo' : '⚡ High Energy'}</option>
                </select>

                {/* Region */}
                <select
                  value={aiVoiceRegion}
                  onChange={(e) => setAiVoiceRegion(e.target.value as any)}
                  className="bg-slate-950 border border-slate-800 text-slate-200 text-[10px] font-bold rounded-xl px-2.5 py-1.5 outline-none focus:border-amber-400 cursor-pointer"
                >
                  <option value="NORTH">{isVN ? '🏛️ Miền Bắc (Hà Nội)' : '🏛️ Northern'}</option>
                  <option value="SOUTH">{isVN ? '🌴 Miền Nam (Sài Gòn)' : '🌴 Southern'}</option>
                </select>
              </div>

              {/* Action Button */}
              <button
                type="button"
                onClick={handleGenerateAiVoiceAndScript}
                disabled={isGeneratingAiVoice || scenes.length === 0}
                className={`px-4 py-2 rounded-xl font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2 shadow-lg transition active:scale-95 ${
                  isGeneratingAiVoice || scenes.length === 0
                    ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
                    : 'bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-black shadow-amber-500/20'
                }`}
              >
                {isGeneratingAiVoice ? (
                  <>
                    <Loader2 size={14} className="animate-spin text-slate-950" />
                    <span>{aiGenStatus || (isVN ? 'ĐANG TẠO VOICE...' : 'GENERATING...')}</span>
                  </>
                ) : (
                  <>
                    <Sparkles size={14} />
                    <span>{isVN ? '🪄 AI TỰ TẠO LỜI THOẠI & LỒNG VOICE' : '🪄 GENERATE VOICE & SCRIPT'}</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* ── Recognized Scenes List ────────────────────────── */}
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4 flex-1 flex flex-col min-h-[350px] shadow-xl">
            <div className="flex justify-between items-center mb-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-black uppercase text-slate-200 tracking-tight flex items-center gap-1.5">
                  <Layers size={16} className="text-indigo-400" />
                  {isVN ? 'Danh Sách Cảnh Phim' : 'Movie Scenes'}
                  <span className="bg-indigo-600 text-white px-2 py-0.5 rounded-full text-[10px] font-black">
                    {scenes.length}
                  </span>
                  {/* [MỚI] số cảnh có mô tả cần xem lại */}
                  {(() => {
                    const nWarn = scenes.filter(sc => directiveWarnings(sc.directive, sc.subtitleText || '', isVN).length > 0).length;
                    return nWarn > 0 ? (
                      <span className="text-[10px] font-black text-amber-300 normal-case">⚠ {nWarn} {isVN ? 'cảnh cần xem lại mô tả' : 'scenes need review'}</span>
                    ) : null;
                  })()}
                </span>
              </div>
              <span className="text-[11px] font-bold text-slate-400">
                {isVN ? 'Tổng thời lượng ước tính:' : 'Est. Duration:'}{' '}
                <span className="text-amber-400 font-black">{totalDuration.toFixed(1)}s</span>
              </span>
            </div>

            {/* Empty State */}
            {scenes.length === 0 && (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center border-2 border-dashed border-slate-800 rounded-2xl bg-slate-950/40">
                <Film size={44} className="text-slate-600 mb-2 animate-bounce" />
                <h4 className="text-sm font-black uppercase text-slate-300 mb-1">
                  {isVN ? 'Chưa có clip video nào' : 'No video clips added'}
                </h4>
                <p className="text-xs text-slate-400 max-w-md leading-relaxed">
                  {isVN 
                    ? 'Hãy kéo thả hoặc bấm "+ Thêm Video Clip" ở trên để nạp các clip scene_001.mp4, scene_002.mp4... Sau đó gõ mô tả để AI tự lồng giọng đọc!' 
                    : 'Click "+ Add Video Clips" above to load scene_001.mp4, scene_002.mp4... Then describe your story for AI auto voiceover!'}
                </p>
              </div>
            )}

            {/* Populated Scenes */}
            {scenes.length > 0 && (
              <div className="space-y-3 overflow-y-auto max-h-[500px] pr-1 custom-scrollbar">
                {scenes.map((scene, idx) => (
                  <div 
                    key={scene.id}
                    className="bg-slate-950 border border-slate-800 hover:border-indigo-500/60 rounded-2xl p-3.5 shadow-md transition flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 group"
                  >
                    {/* Scene Index & Preview */}
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 text-slate-950 font-black text-xs flex items-center justify-center shrink-0 shadow-md">
                        #{idx + 1}
                      </div>

                      {/* Video Thumbnail */}
                      {scene.videoUrl ? (
                        <div
                          className="w-16 h-12 bg-black rounded-xl overflow-hidden shrink-0 border border-slate-700 relative group/vid cursor-pointer"
                          onClick={() => setPreviewId(scene.id)} // [MỚI] bấm con mắt / ảnh → xem trước cảnh
                          title={isVN ? 'Xem trước cảnh' : 'Preview scene'}
                        >
                          {scene.isImage
                            ? <img src={scene.videoUrl} alt="" className="w-full h-full object-cover" />
                            : <video src={scene.videoUrl} className="w-full h-full object-cover" muted playsInline />}
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/vid:opacity-100 flex items-center justify-center transition">
                            <Eye size={12} className="text-white" />
                          </div>
                        </div>
                      ) : (
                        <div className="w-16 h-12 bg-slate-900 rounded-xl border border-dashed border-slate-700 flex items-center justify-center shrink-0 text-[9px] text-slate-500 font-bold uppercase">
                          No Video
                        </div>
                      )}

                      {/* Info & Sync Details */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-black text-white truncate max-w-xs">
                            {scene.videoName}
                          </span>
                          {masterVoice && syncScenesToVoice && scene.targetDuration ? (
                            // [MỚI - C] hiển thị thời lượng đã khớp theo lời
                            <span className="text-[10px] bg-emerald-950/60 text-emerald-300 px-1.5 py-0.5 rounded font-bold border border-emerald-800/60" title={isVN ? 'Đã khớp theo lời đọc' : 'Matched to narration'}>
                              {scene.targetDuration.toFixed(1)}s ✓
                            </span>
                          ) : scene.isImage ? (
                            <label className="flex items-center gap-1 text-[10px] bg-slate-850 text-indigo-300 px-1.5 py-0.5 rounded font-bold border border-indigo-900/60">
                              <input
                                type="number"
                                min={1}
                                max={120}
                                step={0.5}
                                value={Number((imageVoiceSeconds(scene) ?? scene.videoDuration).toFixed(1))} // [SỬA] hiện số giây thực khi dựng
                                onChange={(e) => setSceneSeconds(scene.id, parseFloat(e.target.value))}
                                className={`w-12 bg-slate-950 border rounded px-1 text-center text-white outline-none focus:border-amber-400 ${scene.manualSeconds ? 'border-amber-500' : 'border-slate-700'}`}
                              />
                              <span>{isVN ? 'giây' : 'sec'}</span>
                              {/* [MỚI] trạng thái tự động / chỉnh tay */}
                              {scene.manualSeconds ? (
                                <button type="button" onClick={() => resetSceneSeconds(scene.id)} className="text-amber-300 hover:text-amber-200" title={isVN ? 'Đang chỉnh tay — bấm để về tự động' : 'Manual — click for auto'}>
                                  {isVN ? 'tay ↺' : 'manual ↺'}
                                </button>
                              ) : (
                                <span className="text-slate-500">{isVN ? 'tự động' : 'auto'}</span>
                              )}
                            </label>
                          ) : (
                            <span className="text-[10px] bg-slate-850 text-indigo-300 px-1.5 py-0.2 rounded font-bold border border-indigo-900/60">
                              {scene.videoDuration.toFixed(1)}s
                            </span>
                          )}
                        </div>

                        {/* Voice badge & Audio preview */}
                        <div className="flex items-center gap-2 mt-1">
                          {scene.voiceUrl ? (
                            <div className="flex items-center gap-2 text-[10px] text-emerald-300 bg-emerald-950/40 px-2 py-0.5 rounded-lg border border-emerald-800/50 font-bold truncate max-w-sm">
                              <Mic size={11} className="shrink-0 text-emerald-400" />
                              <span className="truncate">{scene.voiceName}</span>
                              <span className="shrink-0 font-black text-emerald-400">({scene.voiceDuration?.toFixed(1)}s)</span>
                              
                              {/* Voice play button */}
                              <button
                                type="button"
                                onClick={() => togglePlayVoice(scene.id, scene.voiceUrl!)}
                                className="p-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-slate-950 transition ml-1"
                                title={isVN ? 'Nghe thử giọng đọc' : 'Play voice preview'}
                              >
                                {playingVoiceId === scene.id ? <Pause size={10} /> : <Play size={10} />}
                              </button>
                            </div>
                          ) : null}
                          {/* [MỚI] Nút tạo phụ đề theo giọng của cảnh này + số dòng đã có */}
                          {scene.voiceUrl ? (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => void createSceneSubtitles(scene.id)}
                                disabled={sceneSubsBusy !== null || isTranscribing}
                                className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 text-[10px] font-black uppercase"
                                title={isVN ? 'AI nghe giọng cảnh này và tạo phụ đề đúng lời, đúng chỗ ngắt' : 'Create subtitles from this scene voice'}
                              >
                                {sceneSubsBusy === scene.id ? <Loader2 size={10} className="animate-spin" /> : <Subtitles size={10} />}
                                {scene.subtitleCues?.length ? (isVN ? 'Tạo lại phụ đề' : 'Redo subtitles') : (isVN ? 'Tạo phụ đề' : 'Create subtitles')}
                              </button>
                              {scene.subtitleCues?.length ? (
                                <span className="text-[10px] text-emerald-300 font-bold">✓ {scene.subtitleCues.length} {isVN ? 'dòng' : 'lines'}</span>
                              ) : null}
                            </div>
                          ) : (
                            <span className="text-[10px] text-slate-500 italic">
                              {isVN ? 'Chưa có voice (giữ độ dài clip)' : 'No voice (original clip length)'}
                            </span>
                          )}
                        </div>

                        {/* Subtitle text input */}
                        <input
                          type="text"
                          value={scene.subtitleText || ''}
                          onChange={(e) => updateSceneText(scene.id, e.target.value)} // [SỬA - B] sửa chữ → phụ đề căn lại theo chữ mới
                          placeholder={isVN ? 'Lời thoại / phụ đề cho cảnh này (tùy chọn)...' : 'Subtitle text for this scene (optional)...'}
                          className="mt-1.5 w-full bg-slate-900/90 border border-slate-800 rounded-lg px-2.5 py-1 text-[11px] font-medium text-slate-100 placeholder:text-slate-500 outline-none focus:border-amber-400 transition"
                        />

                        {/* [MỚI] Mô tả dựng cảnh + chọn hiệu ứng tay */}
                        <div className="mt-1.5 flex gap-1.5">
                          <input
                            type="text"
                            value={scene.directionText || ''}
                            onChange={(e) => updateSceneDirection(scene.id, e.target.value)}
                            placeholder={scene.isImage
                              ? (isVN ? 'Mô tả dựng cảnh: vd. phóng to ô bên trái, nhấn mạnh chữ "Giảm 50%"...' : 'Direction: e.g. zoom into the left box, emphasize "50% off"...')
                              : (isVN ? 'Mô tả dựng cảnh: vd. chỉ dùng 5s–12s và 20s–35s, bỏ 45s–55s...' : 'Direction: e.g. keep 5s–12s and 20s–35s, cut 45s–55s...')}
                            className="flex-1 min-w-0 bg-slate-900/90 border border-sky-900/70 rounded-lg px-2.5 py-1 text-[11px] font-medium text-sky-100 placeholder:text-slate-500 outline-none focus:border-sky-400 transition"
                          />
                          <select
                            value={scene.effectChoice || 'inherit'}
                            onChange={(e) => setSceneEffectChoice(scene.id, e.target.value as 'inherit' | 'none' | EffectKind)}
                            title={isVN ? 'Hiệu ứng của cảnh (mô tả được ưu tiên hơn)' : 'Scene effect (direction wins)'}
                            className="bg-slate-900 border border-slate-800 rounded-lg px-1.5 py-1 text-[11px] text-slate-200 outline-none focus:border-sky-400"
                          >
                            <option value="inherit">{isVN ? 'Hiệu ứng: theo chung' : 'Effect: global'}</option>
                            <option value="none">{isVN ? 'Không hiệu ứng' : 'No effect'}</option>
                            {EFFECT_KINDS.map(k => <option key={k} value={k}>{EFFECT_LABEL[k][isVN ? 'VN' : 'EN']}</option>)}
                          </select>
                        </div>
                        {scene.directionText?.trim() && (
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-sky-300 font-bold">
                            <span>{isVN ? 'Công cụ hiểu: ' : 'Understood: '}{describeDirective(scene.directive, scene.videoDuration, !!scene.isImage, isVN)}</span>
                            {/* [MỚI] phần chưa hiểu / chưa làm được / không đúng lúc nói */}
                            {directiveWarnings(scene.directive, scene.subtitleText || '', isVN).map((w, wi) => (
                              <span key={wi} className="w-full text-amber-300">⚠ {w}</span>
                            ))}
                            {scene.directive?.needsAI && (
                              <button
                                type="button"
                                disabled={isResolvingDir}
                                onClick={() => void resolvePendingDirectives(scene.id)}
                                className="px-2 py-0.5 rounded bg-sky-600 hover:bg-sky-500 disabled:bg-slate-800 text-white uppercase"
                              >
                                {isResolvingDir ? <Loader2 size={10} className="animate-spin inline" /> : (isVN ? 'AI hiểu ngay' : 'Ask AI')}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Actions: Reorder, Delete */}
                    <div className="flex items-center gap-1 shrink-0 self-end sm:self-center">
                      <button 
                        onClick={() => moveScene(idx, 'up')}
                        disabled={idx === 0}
                        className={`p-1.5 rounded-lg border text-xs ${idx === 0 ? 'text-slate-700 border-slate-900 cursor-not-allowed' : 'text-slate-400 hover:bg-slate-850 hover:text-white border-slate-800'}`}
                        title={isVN ? 'Di chuyển lên' : 'Move up'}
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button 
                        onClick={() => moveScene(idx, 'down')}
                        disabled={idx === scenes.length - 1}
                        className={`p-1.5 rounded-lg border text-xs ${idx === scenes.length - 1 ? 'text-slate-700 border-slate-900 cursor-not-allowed' : 'text-slate-400 hover:bg-slate-850 hover:text-white border-slate-800'}`}
                        title={isVN ? 'Di chuyển xuống' : 'Move down'}
                      >
                        <ArrowDown size={14} />
                      </button>
                      <button 
                        onClick={() => removeScene(idx)}
                        className="p-1.5 rounded-lg border border-red-900/50 text-red-400 hover:bg-red-950/60 transition text-xs"
                        title={isVN ? 'Xóa cảnh này' : 'Delete scene'}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right Column (4/12): Settings & Generation Panel */}
        <div className="lg:col-span-4 flex flex-col gap-3.5">
          
          {/* Config Box (Dark Cinema) */}
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-4.5 shadow-xl space-y-4">
            <h3 className="text-xs font-black uppercase text-amber-400 tracking-wider flex items-center gap-1.5">
              <Sliders size={16} className="text-amber-400" />
              {isVN ? 'Cấu Hình Xuất Phim' : 'Export Settings'}
            </h3>

            {/* [MỚI] Chế độ Mạng xã hội 9:16 */}
            <label className={`flex items-start gap-2 rounded-xl border px-3 py-2 cursor-pointer transition ${socialMode ? 'border-pink-500 bg-pink-950/30' : 'border-slate-800 bg-slate-950/60'}`}>
              <input type="checkbox" checked={socialMode} onChange={(e) => toggleSocial(e.target.checked)} className="mt-0.5 accent-pink-500" />
              <span>
                <span className="block text-[11px] font-black uppercase text-pink-300">📱 {isVN ? 'Mạng xã hội 9:16 (TikTok · Reels · Shorts)' : 'Social 9:16 (TikTok · Reels · Shorts)'}</span>
                <span className="block text-[10px] text-slate-400 leading-snug">
                  {isVN
                    ? '1080×1920 · ảnh đúng tỉ lệ tràn màn hình · phụ đề ngắn ở vùng an toàn · giữ cảnh cuối +1.5s · kèm ảnh bìa'
                    : '1080×1920 · full-bleed · short safe-zone captions · end hold +1.5s · cover image'}
                </span>
              </span>
            </label>

            {/* 1. Movie Title */}
            <div>
              <label className="text-[10px] font-black uppercase text-slate-400 block mb-1">
                {isVN ? 'Tên Phim' : 'Movie Title'}
              </label>
              <input 
                type="text"
                value={movieTitle}
                onChange={(e) => setMovieTitle(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-bold text-white outline-none focus:border-amber-400 shadow-inner"
              />
            </div>

            {/* 2. Aspect Ratio */}
            <div>
              <label className="text-[10px] font-black uppercase text-slate-400 block mb-1">
                {isVN ? 'Tỷ Lệ Khung Hình' : 'Aspect Ratio'}
              </label>
              <select
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value as any)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-bold text-white outline-none focus:border-amber-400 shadow-sm cursor-pointer"
              >
                <option value="original">{isVN ? 'Chuẩn gốc (Theo clip Cảnh 1) ★' : 'Original (From Scene 1 clip) ★'}</option>
                <option value="16:9">{isVN ? '16:9 Ngang (YouTube, Tivi, Phim)' : '16:9 Landscape (YouTube, Cinema)'}</option>
                <option value="9:16">{isVN ? '9:16 Dọc (TikTok, Shorts, Reels)' : '9:16 Portrait (TikTok, Shorts)'}</option>
                <option value="1:1">{isVN ? '1:1 Vuông (Facebook, Instagram)' : '1:1 Square (Facebook, Instagram)'}</option>
              </select>
            </div>

            {/* 3. Fit Mode */}
            <div>
              <label className="text-[10px] font-black uppercase text-slate-400 block mb-1">
                {isVN ? 'Xử Lý Khi Clip Lệch Tỷ Lệ' : 'Frame Mismatch Handling'}
              </label>
              <div className="grid grid-cols-3 gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800">
                <button
                  type="button"
                  onClick={() => setFitMode('blur')}
                  className={`py-1.5 rounded-lg text-[10px] font-black uppercase transition ${
                    fitMode === 'blur' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {isVN ? 'Nền mờ' : 'Blur BG'}
                </button>
                <button
                  type="button"
                  onClick={() => setFitMode('cover')}
                  className={`py-1.5 rounded-lg text-[10px] font-black uppercase transition ${
                    fitMode === 'cover' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {isVN ? 'Lấp đầy' : 'Fill'}
                </button>
                <button
                  type="button"
                  onClick={() => setFitMode('contain')}
                  className={`py-1.5 rounded-lg text-[10px] font-black uppercase transition ${
                    fitMode === 'contain' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {isVN ? 'Viền đen' : 'Letterbox'}
                </button>
              </div>
              {/* [MỚI] Phóng clip video để lấp khung khi đổi ngang ↔ dọc (0% = giữ đủ hình, không cắt) */}
              {fitMode !== 'cover' && (
                <div className="mt-2 bg-slate-950 border border-slate-800 rounded-xl p-2">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-[10px] font-black uppercase text-slate-400">
                      {isVN ? 'Phóng lấp khung (clip video)' : 'Zoom to fill (video clips)'}
                    </span>
                    <span className="text-[10px] font-black text-amber-400">
                      {fillAmount === 0 ? (isVN ? '0% • đủ hình' : '0% • full frame') : `${fillAmount}%`}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={fillAmount}
                    onChange={(e) => setFillAmount(parseInt(e.target.value, 10))}
                    className="w-full accent-indigo-500"
                  />
                  {fillAmount > 0 && (
                    <>
                      <div className="flex justify-between items-center mt-1 mb-1">
                        <span className="text-[10px] font-black uppercase text-slate-400">
                          {isVN ? 'Vị trí giữ lại (trái/trên ↔ phải/dưới)' : 'Keep position (left/top ↔ right/bottom)'}
                        </span>
                        <span className="text-[10px] font-black text-amber-400">{focusX}%</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={focusX}
                        onChange={(e) => setFocusX(parseInt(e.target.value, 10))}
                        className="w-full accent-indigo-500"
                      />
                    </>
                  )}
                </div>
              )}
            </div>

            {/* [MỚI] Nút bật/tắt nhanh tiếng gốc của clip (ngay dưới phần chọn khổ ngang/dọc) */}
            <button
              type="button"
              role="switch"
              aria-checked={keepOrigAudio}
              onClick={() => setKeepOrigAudio(!keepOrigAudio)}
              className="w-full flex items-center justify-between bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 hover:border-slate-700 transition"
            >
              <span className="text-[10px] font-black uppercase text-slate-300">
                {isVN ? 'Tiếng gốc của clip' : 'Original clip audio'}
              </span>
              <span className="flex items-center gap-2">
                <span className={`text-[10px] font-black ${keepOrigAudio ? 'text-emerald-400' : 'text-slate-500'}`}>
                  {keepOrigAudio ? (isVN ? 'BẬT' : 'ON') : (isVN ? 'TẮT' : 'OFF')}
                </span>
                <span className={`relative inline-block w-9 h-5 rounded-full transition ${keepOrigAudio ? 'bg-emerald-500' : 'bg-slate-700'}`}>
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${keepOrigAudio ? 'left-[18px]' : 'left-0.5'}`} />
                </span>
              </span>
            </button>

            {/* [MỚI] Tiếng gốc & ghép 2 video (thu gọn, mặc định đóng để giao diện gọn) */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl">
              <button
                type="button"
                onClick={() => setAdvOpen(!advOpen)}
                className="w-full flex justify-between items-center px-3 py-2 text-[10px] font-black uppercase text-slate-300 hover:text-white"
              >
                <span>
                  {isVN ? 'Tiếng gốc & Ghép 2 video' : 'Original audio & Dual video'}
                  <span className="ml-2 text-amber-400 normal-case">
                    {keepOrigAudio ? (isVN ? `Tiếng gốc ${origVolume}%` : `Audio ${origVolume}%`) : (isVN ? 'Tiếng gốc: tắt' : 'Audio: off')}
                    {splitScreen && secondaryVideo ? (isVN ? ' • 2 video' : ' • 2 videos') : ''}
                  </span>
                </span>
                <span className="text-amber-400">{advOpen ? '▲' : '▼'}</span>
              </button>
              {advOpen && (
                <div className="px-3 pb-3 pt-2 space-y-3 border-t border-slate-800">
                  <div>
                    {!keepOrigAudio && (
                      <p className="text-[10px] text-slate-500 leading-snug">
                        {isVN
                          ? 'Tiếng gốc đang tắt. Bật bằng nút "Tiếng gốc của clip" ở trên.'
                          : 'Original audio is off. Turn it on with the "Original clip audio" switch above.'}
                      </p>
                    )}
                    {keepOrigAudio && (
                      <div className="mt-1">
                        <div className="flex justify-between items-center mb-1">
                          <span className="text-[10px] font-black uppercase text-slate-400">
                            {isVN ? 'Âm lượng tiếng gốc' : 'Original volume'}
                          </span>
                          <span className="text-[10px] font-black text-amber-400">{origVolume}%</span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={5}
                          value={origVolume}
                          onChange={(e) => setOrigVolume(parseInt(e.target.value, 10))}
                          className="w-full accent-indigo-500"
                        />
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="flex items-center gap-2 text-[11px] font-bold text-slate-200 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={splitScreen}
                        onChange={(e) => setSplitScreen(e.target.checked)}
                        className="accent-indigo-500"
                      />
                      {isVN ? 'Ghép 2 video song song' : 'Dual video (side by side)'}
                    </label>
                    {splitScreen && (
                      <div className="mt-2 space-y-2">
                        <div>
                          <span className="text-[10px] font-black uppercase text-slate-400 block mb-1">
                            {isVN ? 'Vị trí clip chính (khổ ngang)' : 'Main clip position'}
                          </span>
                          <div className="grid grid-cols-3 gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800">
                            {([
                              ['top', isVN ? 'Trên' : 'Top'],
                              ['middle', isVN ? 'Giữa' : 'Middle'],
                              ['bottom', isVN ? 'Dưới' : 'Bottom'],
                            ] as const).map(([val, label]) => (
                              <button
                                key={val}
                                type="button"
                                onClick={() => setSplitPos(val)}
                                className={`py-1.5 rounded-md text-[10px] font-black uppercase transition ${
                                  splitPos === val ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
                                }`}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="cursor-pointer px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-black uppercase transition">
                            {secondaryVideo ? (isVN ? 'Đổi video thứ 2' : 'Change video 2') : (isVN ? 'Chọn video thứ 2' : 'Choose video 2')}
                            <input type="file" accept="video/*" className="hidden" onChange={handleSecondaryPick} />
                          </label>
                          {secondaryVideo && (
                            <>
                              <span className="flex-1 min-w-0 truncate text-[10px] font-bold text-slate-300" title={secondaryVideo.name}>
                                {secondaryVideo.name}
                              </span>
                              <button
                                type="button"
                                onClick={clearSecondaryVideo}
                                className="px-2 py-1 rounded-lg text-[10px] font-black text-rose-400 hover:text-rose-300"
                              >
                                ✕
                              </button>
                            </>
                          )}
                        </div>
                        <p className="text-[10px] text-slate-500 leading-snug">
                          {isVN
                            ? 'Dùng với khung xuất 9:16: clip chính giữ đủ hình ở vị trí đã chọn, phần trống chạy video thứ 2 (lặp lại, tắt tiếng). Chưa chọn video 2 thì dựng như bình thường.'
                            : 'Use with 9:16 output: the main clip keeps its full frame at the chosen position, the rest plays video 2 (looped, muted). Without video 2 the movie renders normally.'}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 4. Output Quality */}
            <div>
              <div className="flex justify-between items-center mb-1">
                <label className="text-[10px] font-black uppercase text-slate-400">
                  {isVN ? 'Chất Lượng Xuất' : 'Output Quality'}
                </label>
              </div>
              <select
                value={quality}
                onChange={(e) => setQuality(e.target.value as any)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs font-bold text-white outline-none focus:border-amber-400 shadow-sm cursor-pointer"
              >
                <option value="1080p">{isVN ? '1080p Full HD ★ (Khuyên dùng)' : '1080p Full HD ★ (Recommended)'}</option>
                <option value="original">{isVN ? 'Giữ kích thước clip gốc' : 'Keep source size'}</option>
                <option value="720p">{isVN ? '720p HD (Xuất nhanh & Nhẹ máy)' : '720p HD (Fast & Lightweight)'}</option>
                <option value="4k">{isVN ? '2K / 4K Cao cấp (Yêu cầu clip gốc 2K/4K)' : '2K / 4K UltraHD (Requires 4K source)'}</option>
              </select>
              <p className="text-[9px] text-amber-400/80 italic font-medium mt-1">
                {isVN 
                  ? '💡 Lưu ý: Độ nét thực tế phụ thuộc vào chất lượng clip nguồn bạn tải lên.' 
                  : '💡 Note: Actual sharpness depends on the resolution of uploaded clips.'}
              </p>
            </div>

            {/* 5. [SỬA] PHỤ ĐỀ — nơi tạo phụ đề chính */}
            <div className="pt-2 border-t border-slate-850 space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-black uppercase text-slate-300 flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enableSubtitles}
                    onChange={(e) => setEnableSubtitles(e.target.checked)}
                    className="w-3.5 h-3.5 rounded text-amber-500 accent-amber-500 cursor-pointer"
                  />
                  <span>{isVN ? 'Phụ đề' : 'Subtitles'}</span>
                </label>
                {enableSubtitles && (
                  <select
                    value={subtitleStyle}
                    onChange={(e) => setSubtitleStyle(e.target.value as 'yellow_stroke' | 'white_box')}
                    className="text-[9px] font-black uppercase bg-slate-950 border border-slate-800 text-amber-400 rounded-md px-1.5 py-0.5 outline-none cursor-pointer"
                  >
                    <option value="yellow_stroke">{isVN ? 'Chữ vàng viền đen' : 'Yellow Stroke'}</option>
                    <option value="white_box">{isVN ? 'Chữ trắng hộp đen' : 'White Box'}</option>
                  </select>
                )}
              </div>

              {enableSubtitles && (
                <>
                  {/* [SỬA] Voice = lời thoại: tự điền vào ô "Lời thoại / phụ đề" từng cảnh, sửa trực tiếp ở đó */}
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    {isVN ? 'Voice có lời thoại (tạo trong app / dán lời) → tự tách phụ đề, điền vào ô "Lời thoại / phụ đề" từng cảnh, miễn phí. Sửa chữ ở ô đó, phụ đề đổi theo.' : 'Voice script is split into each scene text box for free; edit there.'}
                  </p>


                  {/* Nút tạo phụ đề */}
                  <button
                    type="button"
                    onClick={handleTranscribe}
                    disabled={isTranscribing || (!masterVoice && !scenes.some(sc => sc.voiceUrl))}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 text-[11px] font-black uppercase transition"
                    title={!masterVoice && !scenes.some(sc => sc.voiceUrl) ? (isVN ? 'Thêm voice trước' : 'Add voice first') : ''}
                  >
                    {isTranscribing ? <Loader2 size={14} className="animate-spin" /> : <Subtitles size={14} />}
                    {isVN ? 'Tạo phụ đề từ lời thoại của voice' : 'Create subtitles from voice script'}
                  </button>
                  {/* [MỚI] Tuỳ chọn AI (Gemini): chỉ khi voice không có lời thoại */}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleTranscribeAI}
                      disabled={isTranscribing || allKeys().length === 0 || (!masterVoice && !scenes.some(sc => sc.voiceUrl))}
                      className="flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-700 text-[10px] font-black uppercase text-slate-300 hover:border-sky-400 disabled:text-slate-600"
                      title={isVN ? 'Chỉ cần khi voice không có lời thoại (ghi âm ngoài). Lời AI nghe được sẽ thay lời đang có.' : 'Only for voice without a script'}
                    >
                      🤖 {isVN ? 'AI nghe giọng (không có lời)' : 'AI listen'}
                    </button>
                    {masterVoice && (
                      <label className="flex items-center gap-1 text-[10px] text-slate-400 font-bold cursor-pointer" title={isVN ? 'Mặc định chia lời lần lượt theo ảnh (miễn phí)' : ''}>
                        <input type="checkbox" checked={aiAssignScenes} onChange={(e) => setAiAssignScenes(e.target.checked)} className="accent-sky-500" />
                        {isVN ? 'AI xem hình để chia lời vào cảnh' : 'AI assigns lines by image'}
                      </label>
                    )}
                  </div>
                  {transcribeMsg && <p className={`text-[10px] font-bold ${transcribeMsg.startsWith('⚠') ? 'text-amber-300' : transcribeMsg.startsWith('📝') ? 'text-sky-300' : 'text-emerald-300'}`}>{transcribeMsg}</p>}

                  {/* Trạng thái từng cảnh */}
                  <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-2 space-y-1 max-h-40 overflow-y-auto custom-scrollbar">
                    {masterVoice ? (
                      <div className="flex items-center justify-between text-[10px] font-bold">
                        <span className="text-slate-300 truncate">{isVN ? 'Voice dài' : 'Long voice'}: {masterVoice.name}</span>
                        <span className={masterCues.length ? 'text-emerald-300' : 'text-amber-300'}>
                          {masterCues.length ? `✓ ${masterCues.length} ${isVN ? 'dòng' : 'lines'}` : (isVN ? '• chưa tạo' : '• not yet')}
                        </span>
                      </div>
                    ) : scenes.filter(sc => sc.videoUrl).length === 0 ? (
                      <p className="text-[10px] text-slate-500">{isVN ? 'Chưa có cảnh.' : 'No scenes yet.'}</p>
                    ) : scenes.filter(sc => sc.videoUrl).map((sc, i) => {
                      const st = subStatus(sc);
                      return (
                        <div key={sc.id} className="flex items-center gap-2 text-[10px] font-bold">
                          <span className="text-slate-400 shrink-0">{isVN ? 'Cảnh' : 'Scene'} {i + 1}</span>
                          <span className={`flex-1 truncate ${st.tone}`}>{st.icon} {st.label}</span>
                          {sc.voiceUrl && (
                            <button type="button" onClick={() => void createSceneSubtitles(sc.id)} disabled={sceneSubsBusy !== null || isTranscribing}
                              className="text-amber-300 hover:text-amber-200 disabled:text-slate-600" title={isVN ? 'Tạo lại phụ đề cảnh này' : 'Redo this scene'}>
                              ↻
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <label className="flex items-center gap-2 text-[10px] text-slate-300 font-bold cursor-pointer">
                    <input type="checkbox" checked={emphasisColor} onChange={(e) => setEmphasisColor(e.target.checked)} className="accent-amber-500" />
                    {isVN ? 'Tô màu từ nhấn mạnh' : 'Color emphasized words'}
                  </label>
                  <label className="flex items-center gap-2 text-[10px] text-slate-300 font-bold cursor-pointer">
                    <input type="checkbox" checked={karaoke} onChange={(e) => setKaraoke(e.target.checked)} className="accent-amber-500" />
                    {isVN ? 'Sáng dần từng từ theo giọng đọc (karaoke)' : 'Word-by-word highlight (karaoke)'}
                  </label>

                  {/* [MỚI] Vị trí phụ đề */}
                  <div className="space-y-1">
                    <div className="text-[10px] font-black uppercase text-slate-400">{isVN ? 'Vị trí phụ đề' : 'Subtitle position'}</div>
                    <div className="grid grid-cols-4 gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800 text-[10px] font-black">
                      {([
                        ['top', isVN ? 'Trên' : 'Top'],
                        ['middle', isVN ? 'Giữa' : 'Middle'],
                        ['safe', isVN ? 'Dưới (an toàn)' : 'Lower (safe)'],
                        ['bottom', isVN ? 'Sát đáy' : 'Bottom'],
                      ] as const).map(([k, lb]) => (
                        <button key={k} type="button" onClick={() => setSubPos(k)}
                          className={`py-1 rounded-lg ${subPos === k ? 'bg-amber-500 text-slate-950' : 'text-slate-400 hover:text-white'}`}>
                          {lb}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="range" min={10} max={92} step={1}
                        value={subtitleYValue ?? 90}
                        onChange={(e) => { setSubY(parseInt(e.target.value, 10)); setSubPos('custom'); }}
                        className="flex-1 accent-amber-500"
                      />
                      <span className="text-[10px] font-bold text-slate-400 w-16 text-right">{subtitleYValue === undefined ? (isVN ? 'sát đáy' : 'bottom') : `${subtitleYValue}%`}</span>
                    </div>
                    {socialMode && subtitleYValue !== undefined && (subtitleYValue > 75 || subtitleYValue < 14) && (
                      <p className="text-[10px] text-amber-300">{isVN ? '⚠ Vị trí này dễ bị nút/chữ của TikTok, Reels che. Nên để 55–72%.' : '⚠ May be covered by app UI. Use 55–72%.'}</p>
                    )}
                    {socialMode && subtitleYValue === undefined && (
                      <p className="text-[10px] text-amber-300">{isVN ? '⚠ Sát đáy sẽ bị phần mô tả bài đăng che trên TikTok/Reels.' : '⚠ Bottom is covered on TikTok/Reels.'}</p>
                    )}
                  </div>

                  {/* Xem / sửa + tải SRT */}
                  <div className="grid grid-cols-2 gap-1.5">
                    <button type="button" onClick={() => setShowSubsEditor(v => !v)}
                      className="py-1.5 rounded-lg bg-slate-850 border border-slate-700 text-[10px] font-black uppercase text-slate-200 hover:border-amber-400">
                      {showSubsEditor ? (isVN ? 'Đóng bảng sửa' : 'Close editor') : (isVN ? 'Xem / sửa phụ đề' : 'View / edit')}
                    </button>
                    <button type="button" onClick={downloadSrt}
                      className="py-1.5 rounded-lg bg-slate-850 border border-slate-700 text-[10px] font-black uppercase text-slate-200 hover:border-amber-400 flex items-center justify-center gap-1">
                      <Download size={11} /> {isVN ? 'Tải .SRT' : '.SRT'}
                    </button>
                  </div>

                  {showSubsEditor && (
                    <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-2 space-y-2 max-h-80 overflow-y-auto custom-scrollbar">
                      {(masterVoice
                        ? [{ id: 'master' as const, title: isVN ? 'Voice dài (giây theo file voice)' : 'Long voice', cues: masterCues }]
                        : scenes.filter(sc => sc.videoUrl).map((sc, i) => ({ id: sc.id, title: `${isVN ? 'Cảnh' : 'Scene'} ${i + 1}`, cues: sceneCues(sc) }))
                      ).map(group => (
                        <div key={group.id} className="space-y-1">
                          <div className="text-[10px] font-black uppercase text-slate-400">{group.title}</div>
                          {group.cues.length === 0 && <p className="text-[10px] text-slate-600">{isVN ? 'Chưa có phụ đề' : 'No subtitles'}</p>}
                          {group.cues.map((c, k) => (
                            <div key={k} className="flex items-center gap-1">
                              <input type="number" step={0.1} min={0} value={Number(c.start.toFixed(2))}
                                onChange={(e) => editCue(group.id, k, { start: Math.max(0, parseFloat(e.target.value) || 0) })}
                                className="w-12 bg-slate-900 border border-slate-800 rounded px-1 text-[10px] text-white text-center outline-none focus:border-amber-400" />
                              <input type="number" step={0.1} min={0} value={Number(c.end.toFixed(2))}
                                onChange={(e) => editCue(group.id, k, { end: Math.max(0, parseFloat(e.target.value) || 0) })}
                                className="w-12 bg-slate-900 border border-slate-800 rounded px-1 text-[10px] text-white text-center outline-none focus:border-amber-400" />
                              <input type="text" value={c.text}
                                onChange={(e) => editCue(group.id, k, { text: e.target.value })}
                                className="flex-1 min-w-0 bg-slate-900 border border-slate-800 rounded px-1.5 py-0.5 text-[10px] text-slate-100 outline-none focus:border-amber-400" />
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* 6. Background Music Options */}
            <div className="pt-2 border-t border-slate-850">
              <div className="flex items-center justify-between mb-2">
                <label className="text-[10px] font-black uppercase text-slate-300 flex items-center gap-1.5 cursor-pointer">
                  <input 
                    type="checkbox"
                    checked={enableBgm}
                    onChange={(e) => setEnableBgm(e.target.checked)}
                    className="w-3.5 h-3.5 rounded text-amber-500 accent-amber-500 cursor-pointer"
                  />
                  <span>{isVN ? 'Bật Nhạc Nền BGM' : 'Enable Background Music'}</span>
                </label>
                <span className="text-[10px] font-black text-amber-400">{bgmVolume}%</span>
              </div>
              {enableBgm && (
                <div className="space-y-1.5">
                  <input 
                    type="range"
                    min="0"
                    max="100"
                    value={bgmVolume}
                    onChange={(e) => setBgmVolume(parseInt(e.target.value, 10))}
                    className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-amber-500"
                  />
                  <div className="flex items-center justify-between text-[9px] text-slate-500 font-bold">
                    <span>{isVN ? 'Nhỏ' : 'Low'}</span>
                    <span className="text-emerald-400 font-black">
                      {isVN ? '✓ Giữ âm lượng đều, vào/ra êm' : '✓ Steady level, soft fade in/out'}
                    </span>
                    <span>{isVN ? 'Lớn' : 'High'}</span>
                  </div>
                </div>
              )}
            </div>

            {/* 7. Action Button: CREATE MOVIE */}
            <div className="pt-2">
              <button
                type="button"
                onClick={handleCreateMovie}
                disabled={isProcessing || scenes.length === 0}
                className={`w-full py-4 rounded-2xl font-black text-xs uppercase tracking-widest shadow-xl flex items-center justify-center gap-2 transition active:scale-95 ${
                  isProcessing 
                    ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-700'
                    : scenes.length === 0
                      ? 'bg-slate-800/80 text-slate-600 cursor-not-allowed border border-slate-800'
                      : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-950/40'
                }`}
              >
                <Sparkles size={16} />
                <span>{isProcessing ? (isVN ? 'ĐANG TỰ ĐỘNG DỰNG PHIM...' : 'EDITING MOVIE...') : (isVN ? '🎬 BẮT ĐẦU TẠO PHIM' : '🎬 CREATE MOVIE NOW')}</span>
              </button>
            </div>
          </div>

          {/* Progress / Output Display */}
          {(isProcessing || renderedVideoUrl) && (
            <div className="bg-slate-900 text-white border border-slate-800 rounded-3xl p-4.5 shadow-2xl space-y-3">
              {isProcessing && (
                <div>
                  <div className="flex justify-between items-center mb-1.5">
                    <span className="text-[10px] font-black uppercase text-amber-400 truncate max-w-[80%]">
                      {statusMessage}
                    </span>
                    <span className="text-xs font-black text-white">{progressPercent}%</span>
                  </div>
                  <div className="w-full bg-slate-950 rounded-full h-2.5 overflow-hidden border border-slate-800">
                    <div 
                      className="bg-indigo-500 h-2.5 rounded-full transition-all duration-300" 
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                  <p className="text-[9px] text-slate-400 mt-2 italic text-center">
                    {engineKind === 'browser'
                      ? (isVN
                        ? 'Dựng bằng trình duyệt theo thời gian thực: hãy GIỮ TAB NÀY MỞ và đang hiển thị cho tới khi xong.'
                        : 'Browser mode renders in real time: keep THIS TAB OPEN and visible until it finishes.')
                      : (isVN
                        ? 'Máy dựng đang tự động ghép video, đồng bộ voice, thêm nhạc nền và phụ đề...'
                        : 'The render engine is merging clips, syncing voice, adding music and subtitles...')}
                  </p>
                  <div className="flex justify-center mt-2">
                    <button
                      type="button"
                      onClick={() => abortRef.current?.abort()}
                      className="px-3 py-1.5 bg-red-950/40 hover:bg-red-900/60 text-red-300 rounded-lg text-[10px] font-bold uppercase border border-red-800/60 active:scale-95"
                    >
                      {isVN ? 'Hủy dựng phim' : 'Cancel'}
                    </button>
                  </div>
                </div>
              )}

              {/* Rendered Finished Result */}
              {renderedVideoUrl && (
                <div className="space-y-3">
                  <div className="flex items-center gap-1.5 text-emerald-400 text-xs font-black uppercase tracking-wider">
                    <CheckCircle2 size={16} />
                    <span>{isVN ? 'PHIM ĐÃ HOÀN THÀNH!' : 'MOVIE COMPLETE!'}</span>
                  </div>

                  {/* Video Player */}
                  <div className="rounded-2xl overflow-hidden bg-black border border-slate-800 shadow-2xl aspect-video">
                    <video 
                      src={renderedVideoUrl} 
                      controls 
                      autoPlay 
                      playsInline 
                      className="w-full h-full object-contain"
                    />
                  </div>

                  {renderStats && (
                    <div className="flex justify-between text-[10px] text-slate-400 font-bold px-1 bg-slate-950 p-2 rounded-xl border border-slate-850">
                      <span>{isVN ? 'Thời lượng:' : 'Length:'} <b className="text-amber-400">{renderStats.totalDuration}s</b></span>
                      <span>{isVN ? 'Độ phân giải:' : 'Res:'} <b className="text-indigo-300">{renderStats.resolution}</b></span>
                      <span>{isVN ? 'Dung lượng:' : 'Size:'} <b className="text-emerald-400">{renderStats.fileSizeMB} MB</b></span>
                    </div>
                  )}

                  {renderResult && renderResult.warnings.length > 0 && (
                    <div className="bg-amber-950/30 border border-amber-800/50 rounded-xl p-2.5 text-[10px] text-amber-200 space-y-1">
                      <div className="font-black uppercase tracking-wider text-amber-300">
                        {isVN ? 'Lưu ý khi dựng:' : 'Notes:'}
                      </div>
                      {renderResult.warnings.map((w, i) => <div key={i}>• {w}</div>)}
                    </div>
                  )}

                  {/* Download / New Movie Buttons */}
                  <div className="flex gap-2">
                    <button
                      onClick={handleDownloadMovie}
                      className="flex-1 py-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-xl text-xs font-black uppercase tracking-wider flex items-center justify-center gap-1.5 shadow-lg active:scale-95 transition"
                    >
                      <Download size={15} />
                      <span>{isVN ? `TẢI PHIM ${(renderResult?.extension || 'mp4').toUpperCase()}` : `DOWNLOAD ${(renderResult?.extension || 'mp4').toUpperCase()}`}</span>
                    </button>
                    <button
                      onClick={handleResetMovie}
                      className="px-4 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold uppercase transition"
                      title={isVN ? 'Làm lại' : 'Reset'}
                    >
                      <RotateCcw size={15} />
                    </button>
                  </div>
                  {/* [MỚI] Tải ảnh bìa + phụ đề .SRT để đăng nền tảng */}
                  <div className="flex gap-2 mt-2">
                    {renderResult?.thumbnailUrl && (
                      <a href={renderResult.thumbnailUrl} download={`${movieTitle.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'Phim_AI'}_anh_bia.jpg`}
                        className="flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-[10px] font-black uppercase flex items-center justify-center gap-1.5">
                        <Download size={13} /> {isVN ? 'Ảnh bìa' : 'Cover image'}
                      </a>
                    )}
                    <button type="button" onClick={downloadSrt}
                      className="flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-[10px] font-black uppercase flex items-center justify-center gap-1.5">
                      <Download size={13} /> {isVN ? 'Phụ đề .SRT' : 'Subtitles .SRT'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      </div>

      {/* Script Modal */}
      {showScriptModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[1000] flex items-center justify-center p-4">
          <div className="bg-slate-900 rounded-3xl p-6 max-w-lg w-full shadow-2xl border border-slate-800 text-white">
            <h3 className="text-sm font-black uppercase text-amber-400 mb-2 flex items-center gap-2">
              <FileText size={18} className="text-amber-400" />
              {isVN ? 'Dán Kịch Bản / Lời Thoại Phân Cảnh' : 'Paste Script / Scene Dialogues'}
            </h3>
            <p className="text-xs text-slate-400 mb-3">
              {isVN 
                ? 'Mỗi dòng tương ứng với 1 cảnh. Hệ thống sẽ tự động gán lời thoại và tạo phụ đề cho từng cảnh:' 
                : 'Each line corresponds to one scene. Subtitles will be automatically assigned:'}
            </p>
            <textarea
              rows={8}
              value={bulkScript}
              onChange={(e) => setBulkScript(e.target.value)}
              placeholder={isVN 
                ? "Cảnh 1: Mặt trời mọc trên đỉnh núi tuyết hùng vĩ.\nCảnh 2: Người thám hiểm bước từng bước vững chãi.\nCảnh 3: Ánh bình minh soi sáng con đường phía trước..." 
                : "Scene 1: Sunrise above the majestic snowy mountains.\nScene 2: The explorer walks steadily.\nScene 3: Golden sunlight illuminates the path..."}
              className="w-full bg-slate-950 border border-slate-800 rounded-2xl p-3 text-xs font-medium text-slate-100 outline-none focus:border-amber-400 resize-none mb-4"
            />
            <div className="flex gap-2">
              <button
                onClick={applyBulkScript}
                className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-black uppercase tracking-wider shadow-md transition"
              >
                {isVN ? 'Áp Dụng Lời Thoại Vào Các Cảnh' : 'Apply to Scenes'}
              </button>
              <button
                onClick={() => setShowScriptModal(false)}
                className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold transition"
              >
                {isVN ? 'Đóng' : 'Close'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* [MỚI] Cửa sổ xem trước cảnh */}
      {previewId && (() => {
        const vis = scenes.filter(x => x.videoUrl);
        const i = vis.findIndex(x => x.id === previewId);
        if (i < 0) return null;
        const sc = vis[i];
        const dur = sceneRenderSeconds(sc);
        const off = masterVoice ? masterStart + vis.slice(0, i).reduce((a, x) => a + sceneRenderSeconds(x), 0) : 0;
        const cues = masterVoice
          ? masterCues.filter(c => c.end > off && c.start < off + dur).map(c => ({ ...c, start: c.start - off, end: c.end - off }))
          : sceneCues(sc);
        const fx = sceneEffects(sc);
        const fxLabel = fx === undefined
          ? `${isVN ? 'theo chung' : 'global'}: ${globalEffect === 'auto' ? (isVN ? 'tự động' : 'auto') : globalEffect === 'none' ? (isVN ? 'không' : 'none') : EFFECT_LABEL[globalEffect][isVN ? 'VN' : 'EN']}`
          : fx.length ? fx.map(e => EFFECT_LABEL[e.kind][isVN ? 'VN' : 'EN'] + (e.target ? ` "${e.target}"` : '')).join(', ') : (isVN ? 'không' : 'none');
        const segs = sc.isImage ? undefined : (sceneSegments(sc) ?? [[0, sc.videoDuration] as [number, number]]);
        const info = [
          `${isVN ? 'Thời lượng' : 'Duration'}: ${dur.toFixed(1)}s · ${isVN ? 'Phụ đề' : 'Subtitles'}: ${cues.length} ${isVN ? 'dòng' : 'lines'} · ${isVN ? 'Hiệu ứng' : 'Effects'}: ${fxLabel}`,
          ...(segs && sc.directive && (sc.directive.keep.length || sc.directive.cut.length)
            ? [`${isVN ? 'Video dùng' : 'Video uses'}: ${segs.map(([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)}s`).join(', ')}`] : []),
          ...directiveWarnings(sc.directive, sc.subtitleText || '', isVN).map(w => `⚠ ${w}`),
        ];
        return (
          <ScenePreviewModal
            isVN={isVN}
            index={i}
            total={vis.length}
            name={sc.videoName}
            url={sc.videoUrl}
            isImage={!!sc.isImage}
            duration={dur}
            cues={cues}
            subtitleY={subtitleYValue}
            emphasis={[...(sc.directive?.emphasis ?? []), ...(sc.directive?.effects ?? []).map(e => e.word || '').filter(Boolean)]}
            audio={masterVoice ? { url: masterVoice.url, offset: off } : sc.voiceUrl ? { url: sc.voiceUrl, offset: 0 } : undefined}
            segments={segs}
            info={info}
            text={sc.subtitleText || ''}
            onText={(v) => updateSceneText(sc.id, v)}
            onPrev={i > 0 ? () => setPreviewId(vis[i - 1].id) : undefined}
            onNext={i < vis.length - 1 ? () => setPreviewId(vis[i + 1].id) : undefined}
            onClose={() => setPreviewId(null)}
          />
        );
      })()}

      {/* ── PRICING & UPGRADE MODAL (CINEMA AUTO STUDIO PRO) ────── */}
      {showPricingModal && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-[1100] flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
          <div className="bg-slate-900 border-2 border-amber-500/40 rounded-[2.5rem] p-5 sm:p-7 max-w-4xl w-full shadow-[0_0_80px_rgba(245,158,11,0.25)] text-white relative my-auto animate-in fade-in zoom-in-95 duration-300">
            
            {/* Close Button */}
            <button
              onClick={() => setShowPricingModal(false)}
              className="absolute top-5 right-5 w-9 h-9 rounded-full bg-slate-800 hover:bg-red-600 text-slate-400 hover:text-white flex items-center justify-center font-black transition active:scale-90"
            >
              ✕
            </button>

            {/* Modal Header */}
            <div className="text-center max-w-2xl mx-auto mb-6">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 text-[10px] font-black uppercase tracking-widest mb-2">
                <Sparkles size={12} />
                <span>BẢNG GIÁ DỰNG PHIM TỰ ĐỘNG • AUTO VIDEO STUDIO</span>
              </div>
              <h3 className="text-xl sm:text-2xl font-black italic tracking-tight uppercase text-white">
                GIA HẠN & NẠP CREDITS DỰNG PHIM
              </h3>
              <p className="text-xs text-slate-400 font-medium mt-1">
                {isVN 
                  ? 'Tự động ghép video + lồng Voice AI toàn bộ các cảnh + hòa âm Ducking + xuất MP4 1080p chỉ với 1 click.' 
                  : 'Auto-sync scenes with full AI voiceover, dynamic BGM ducking, subtitles and 1080p export with 1 click.'}
              </p>
            </div>

            {/* User Account Quick Status */}
            <div className="bg-slate-950/80 border border-slate-800 rounded-2xl p-3.5 mb-5 flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-slate-400">Tài khoản:</span>
                <span className="font-black text-amber-400">{email || 'Khách trải nghiệm'}</span>
                {profile?.role === 'admin' && (
                  <span className="bg-red-600 text-white text-[9px] px-2 py-0.5 rounded-full font-black uppercase">ADMIN</span>
                )}
              </div>
              <div className="flex items-center gap-3">
                <div className="bg-slate-900 px-3 py-1 rounded-xl border border-slate-800">
                  <span className="text-slate-400 mr-1.5">Lượt dùng thử:</span>
                  <span className="font-black text-emerald-400">
                    {isAdminOrVip ? 'Vô hạn (VIP)' : `${remainingTrials}/${MAX_FREE_TRIALS} lượt`}
                  </span>
                </div>
                <div className="bg-slate-900 px-3 py-1 rounded-xl border border-slate-800">
                  <span className="text-slate-400 mr-1.5">Số dư Credits:</span>
                  <span className="font-black text-amber-400">{credit || 0} cr</span>
                  <span className="text-[10px] text-slate-500 ml-1">({COST_PER_MOVIE} cr/phim)</span>
                </div>
              </div>
            </div>

            {/* 4 Pricing Cards Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 mb-6">
              {[
                {
                  id: 'month' as const,
                  name: 'GÓI THÁNG',
                  subtitle: 'Starter Creator',
                  price: 99000,
                  priceText: '99.000đ',
                  period: '/ tháng',
                  credits: 150,
                  movieEst: '~30 Video',
                  unitCost: '~3.300đ / phim',
                  badge: 'Khởi đầu',
                  popular: false,
                  features: ['150 Credits sẵn có', 'Dựng ~30 video full AI Voice', 'AI viết kịch bản & sinh voice', 'Xuất MP4 1080p sắc nét']
                },
                {
                  id: 'quarter' as const,
                  name: 'GÓI QUÝ 3 THÁNG',
                  subtitle: 'Pro Studio Creator',
                  price: 249000,
                  priceText: '249.000đ',
                  period: '/ 3 tháng',
                  credits: 500,
                  movieEst: '~100 Video',
                  unitCost: '~2.500đ / phim',
                  badge: 'Khuyên Dùng ⭐',
                  popular: true,
                  features: ['500 Credits sẵn có', 'Dựng ~100 video full AI Voice', 'Tiết kiệm 17% (~83k/tháng)', 'Auto Ducking & Nền Blur', 'Ưu tiên kết xuất tốc độ cao']
                },
                {
                  id: 'year' as const,
                  name: 'GÓI NĂM 12 THÁNG',
                  subtitle: 'VIP Agency / MMO',
                  price: 799000,
                  priceText: '799.000đ',
                  period: '/ 1 năm',
                  credits: 2000,
                  movieEst: '~400 Video',
                  unitCost: '~2.000đ / phim',
                  badge: 'Tiết Kiệm 33% 💎',
                  popular: false,
                  features: ['2.000 Credits sẵn có', 'Dựng ~400 video full AI Voice', 'Tiết kiệm 33% (~66k/tháng)', 'Phù hợp làm kênh hàng ngày', 'Hỗ trợ kỹ thuật 1-1 qua Zalo']
                },
                {
                  id: 'credits_100' as const,
                  name: 'NẠP LẺ CREDITS',
                  subtitle: 'Pay As You Go',
                  price: 100000,
                  priceText: '100.000đ',
                  period: 'nạp lẻ',
                  credits: 120,
                  movieEst: '~24 Video',
                  unitCost: '~4.100đ / phim',
                  badge: '+20 Cr Thưởng',
                  popular: false,
                  features: ['120 Credits vào tài khoản', 'Dựng ~24 video full AI Voice', 'Không giới hạn thời hạn dùng', 'Dùng lúc nào trừ lúc đó']
                }
              ].map(plan => {
                const isSelected = selectedPricingTier === plan.id;
                return (
                  <div
                    key={plan.id}
                    onClick={() => setSelectedPricingTier(plan.id)}
                    className={`rounded-2xl p-4 cursor-pointer transition-all duration-200 relative flex flex-col justify-between border-2 ${
                      isSelected 
                        ? 'bg-slate-900 border-amber-500 shadow-xl ring-1 ring-amber-500/30' 
                        : 'bg-slate-950/60 hover:bg-slate-900/80 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    {/* Badge */}
                    <div className="flex justify-between items-start mb-2">
                      <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full ${
                        plan.popular ? 'bg-amber-500 text-slate-950 shadow-md' : 'bg-slate-800 text-slate-300'
                      }`}>
                        {plan.badge}
                      </span>
                      {isSelected && (
                        <span className="w-5 h-5 rounded-full bg-amber-500 text-slate-950 flex items-center justify-center font-black text-xs shadow-md">
                          ✓
                        </span>
                      )}
                    </div>

                    <div>
                      <h4 className="text-xs font-black uppercase tracking-wider text-white">
                        {plan.name}
                      </h4>
                      <p className="text-[10px] text-slate-400 font-medium mb-3">
                        {plan.subtitle}
                      </p>

                      <div className="mb-3">
                        <span className="text-xl font-black text-amber-400">
                          {plan.priceText}
                        </span>
                        <span className="text-[10px] text-slate-400 ml-1">
                          {plan.period}
                        </span>
                        <div className="text-[9px] text-emerald-400 font-bold mt-0.5">
                          {plan.unitCost}
                        </div>
                      </div>

                      <div className="bg-slate-900/90 rounded-xl p-2.5 mb-3 border border-slate-800">
                        <div className="flex items-center justify-between text-[11px] font-black text-amber-300">
                          <span>{plan.credits} Credits</span>
                          <span className="text-slate-300">{plan.movieEst}</span>
                        </div>
                      </div>

                      <ul className="space-y-1.5 text-[10px] text-slate-300">
                        {plan.features.map((feat, fIdx) => (
                          <li key={fIdx} className="flex items-start gap-1.5">
                            <Check size={11} className="text-amber-400 shrink-0 mt-0.5" />
                            <span>{feat}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setSelectedPricingTier(plan.id); }}
                      className={`w-full mt-4 py-2 rounded-xl text-xs font-black uppercase transition ${
                        isSelected 
                          ? 'bg-amber-500 text-slate-950 shadow-md' 
                          : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                      }`}
                    >
                      {isSelected ? 'Đang Chọn' : 'Chọn Gói Này'}
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Payment & QR Section - CHỈ HIỆN MÃ QR BẢO MẬT */}
            {(() => {
              const activePlan = [
                { id: 'month', name: 'Gói Tháng (150 Credits)', price: 99000 },
                { id: 'quarter', name: 'Gói Quý 3 Tháng (500 Credits)', price: 249000 },
                { id: 'year', name: 'Gói Năm 12 Tháng (2.000 Credits)', price: 799000 },
                { id: 'credits_100', name: 'Nạp Lẻ 120 Credits', price: 100000 }
              ].find(p => p.id === selectedPricingTier) || { id: 'quarter', name: 'Gói Quý 3 Tháng', price: 249000 };

              const cleanUserCode = email ? email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toUpperCase() : 'USER';
              const transferContent = `AUTOPRO ${cleanUserCode} ${activePlan.id.toUpperCase()}`;
              const qrImageUrl = `https://img.vietqr.io/image/MB-0339606969-compact2.png?amount=${activePlan.price}&addInfo=${encodeURIComponent(transferContent)}&accountName=YOHU%20STUDIO`;

              return (
                <div className="bg-slate-950 border border-amber-500/30 rounded-3xl p-5 flex flex-col sm:flex-row items-center gap-6 shadow-inner">
                  {/* QR Code */}
                  <div className="bg-white p-3 rounded-2xl shadow-2xl shrink-0 flex flex-col items-center">
                    <img 
                      src={qrImageUrl} 
                      alt="Mã QR Quét Thanh Toán" 
                      className="w-40 h-40 object-contain rounded-xl"
                    />
                    <span className="text-[9px] font-black text-slate-800 uppercase mt-1 tracking-wider">
                      Quét Mã Bằng App Ngân Hàng / Zalo
                    </span>
                  </div>

                  {/* Transfer Details - No personal text exposed */}
                  <div className="flex-1 min-w-0 space-y-3 text-xs w-full">
                    <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                      <span className="text-slate-400">Gói đã chọn:</span>
                      <span className="font-black text-amber-400 text-sm">{activePlan.name}</span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">Số tiền thanh toán:</span>
                      <div className="flex items-center gap-2">
                        <span className="font-black text-emerald-400 text-base">{activePlan.price.toLocaleString('vi-VN')} VNĐ</span>
                        <button
                          onClick={() => copyToClipboard(activePlan.price.toString(), 'amount')}
                          className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-[10px] font-bold flex items-center gap-1"
                        >
                          {copiedText === 'amount' ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                          <span>{copiedText === 'amount' ? 'Đã copy' : 'Copy'}</span>
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">Nội dung xác nhận:</span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-black text-amber-300 text-xs bg-slate-900 px-2 py-0.5 rounded border border-slate-800">{transferContent}</span>
                        <button
                          onClick={() => copyToClipboard(transferContent, 'memo')}
                          className="px-2 py-0.5 bg-amber-500 hover:bg-amber-400 text-slate-950 rounded text-[10px] font-black flex items-center gap-1 shadow-sm"
                        >
                          {copiedText === 'memo' ? <Check size={11} /> : <Copy size={11} />}
                          <span>{copiedText === 'memo' ? 'Đã copy' : 'Copy'}</span>
                        </button>
                      </div>
                    </div>

                    <div className="p-3 bg-slate-900/90 rounded-2xl border border-slate-800 space-y-1">
                      <p className="text-[10px] text-amber-300/90 font-medium leading-relaxed">
                        🛡️ <strong>Bảo mật & Phòng chống lừa đảo:</strong> Hệ thống thanh toán hoàn toàn tự động qua việc quét mã QR. Không cung cấp số tài khoản văn bản ra ngoài.
                      </p>
                      <p className="text-[10px] text-indigo-300/90 font-medium leading-relaxed">
                        💬 <strong>Hỗ trợ kích hoạt:</strong> Mọi trao đổi chi tiết và xác thực tài khoản thực hiện trực tiếp trên kênh Chat Zalo chính thức.
                      </p>
                    </div>

                    <div className="pt-2 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800">
                      <a
                        href="https://zalo.me/0973480488"
                        target="_blank"
                        rel="noreferrer"
                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold uppercase tracking-wider transition shadow-md flex items-center gap-1.5"
                      >
                        💬 Mở Chat Zalo Kích Hoạt Tức Thì
                      </a>

                      {onOpenPricing && (
                        <button
                          onClick={() => { setShowPricingModal(false); onOpenPricing(); }}
                          className="text-amber-400 hover:underline font-bold text-[11px]"
                        >
                          Xem Bảng Giá Toàn Tool →
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}

          </div>
        </div>
      )}
    </div>
  );
};

/* ───────────── [MỚI] Cửa sổ "Xem trước cảnh" (bấm con mắt / ảnh thu nhỏ) ───────────── */

interface ScenePreviewProps {
  isVN: boolean;
  index: number;
  total: number;
  name: string;
  url: string;
  isImage: boolean;
  /** số giây cảnh khi dựng */
  duration: number;
  /** phụ đề theo giây trong cảnh */
  cues: SubtitleCue[];
  emphasis: string[];
  /** [MỚI] vị trí phụ đề (% chiều cao, undefined = sát đáy) */
  subtitleY?: number;
  /** giọng đọc: file + giây bắt đầu (voice dài: vị trí của cảnh trong file) */
  audio?: { url: string; offset: number };
  /** video: các đoạn được dùng (giây file gốc) */
  segments?: [number, number][];
  info: string[];
  text: string;
  onText: (v: string) => void;
  onPrev?: () => void;
  onNext?: () => void;
  onClose: () => void;
}

/** [MỚI] Xem trước 1 cảnh: hình + giọng đọc + phụ đề chạy theo giọng + đúng các đoạn video đã giữ */
export const ScenePreviewModal: React.FC<ScenePreviewProps> = (p) => {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef(0);
  const startRef = useRef(0);
  const segIdxRef = useRef(0);

  // đoạn video khớp thời lượng cảnh (giống máy dựng: dài → cắt cuối, ngắn → chạy chậm ≥0.5x)
  const plan = useMemo(() => {
    if (p.isImage || !p.segments?.length) return { segs: p.segments ?? [], rate: 1 };
    const total = p.segments.reduce((a, [x, y]) => a + (y - x), 0);
    if (total > p.duration + 0.02) {
      const out: [number, number][] = [];
      let left = p.duration;
      for (const [a, b] of p.segments) {
        if (left <= 0.02) break;
        const len = Math.min(b - a, left);
        out.push([a, a + len]);
        left -= len;
      }
      return { segs: out, rate: 1 };
    }
    return { segs: p.segments, rate: total < p.duration - 0.05 ? Math.max(0.5, total / p.duration) : 1 };
  }, [p.isImage, p.segments, p.duration]);

  const stop = () => {
    cancelAnimationFrame(rafRef.current);
    audioRef.current?.pause();
    videoRef.current?.pause();
    setPlaying(false);
  };

  // đổi cảnh → dừng, về đầu
  useEffect(() => {
    stop();
    setT(0);
    const v = videoRef.current;
    if (v && plan.segs[0]) { try { v.currentTime = plan.segs[0][0]; } catch { /* bỏ qua */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.index, p.url]);
  useEffect(() => () => { cancelAnimationFrame(rafRef.current); }, []);

  // phím: Esc đóng, ← → chuyển cảnh, Space phát/dừng
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'Escape') p.onClose();
      else if (e.key === 'ArrowLeft') p.onPrev?.();
      else if (e.key === 'ArrowRight') p.onNext?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p]);

  const play = async () => {
    stop();
    setPlaying(true);
    segIdxRef.current = 0;
    const a = audioRef.current;
    const v = videoRef.current;
    if (a && p.audio) { a.currentTime = p.audio.offset; void a.play().catch(() => undefined); }
    if (v && plan.segs.length) {
      v.currentTime = plan.segs[0][0];
      v.playbackRate = plan.rate;
      void v.play().catch(() => undefined);
    }
    startRef.current = performance.now();
    const tick = () => {
      const el = a && p.audio && !a.paused ? a.currentTime - p.audio.offset : (performance.now() - startRef.current) / 1000;
      // ghép các đoạn video đã giữ
      if (v && plan.segs.length && !v.seeking) {
        const k = segIdxRef.current;
        if (k < plan.segs.length && (v.currentTime >= plan.segs[k][1] - 0.04 || v.ended)) {
          segIdxRef.current = k + 1;
          if (k + 1 < plan.segs.length) v.currentTime = plan.segs[k + 1][0];
          else v.pause();
        }
      }
      setT(Math.max(0, el));
      if (el >= p.duration) { stop(); setT(p.duration); return; }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const cue = p.cues.find((c) => t >= c.start && t < c.end) ?? null;
  const emphTok = useMemo(() => new Set(p.emphasis.flatMap((e) => norm(e).split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean))), [p.emphasis]);

  return (
    <div className="fixed inset-0 z-[300] bg-black/80 backdrop-blur-sm flex items-center justify-center p-3" onClick={p.onClose}>
      <div className="w-full max-w-4xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-3 sm:p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[10px] font-black uppercase text-amber-400">{p.isVN ? 'Xem trước cảnh' : 'Scene preview'} {p.index + 1}/{p.total}</div>
            <div className="text-xs font-black text-white truncate">{p.name}</div>
          </div>
          <button type="button" onClick={p.onClose} className="px-2 py-1 rounded-lg bg-slate-800 text-slate-300 hover:text-white text-xs font-black">✕</button>
        </div>

        <div className="relative w-full aspect-video bg-black rounded-xl overflow-hidden">
          {p.isImage
            ? <img src={p.url} alt="" className="absolute inset-0 w-full h-full object-contain" />
            : <video ref={videoRef} src={p.url} muted playsInline preload="auto" className="absolute inset-0 w-full h-full object-contain" />}
          {cue && cue.text.trim() && (
            <div className="absolute left-0 right-0 flex justify-center px-6" style={p.subtitleY === undefined ? { bottom: '6%' } : { top: `${p.subtitleY}%`, transform: 'translateY(-50%)' }}>
              <span className="text-center font-black text-sm sm:text-xl leading-snug text-[#FFE600]" style={{ textShadow: '0 0 4px #000, 0 2px 4px #000, 0 0 2px #000' }}>
                {cue.text.split(' ').map((w, i) => {
                  const hi = emphTok.has(norm(w).replace(/[^\p{L}\p{N}]/gu, ''));
                  return <span key={i} style={hi ? { color: '#FF4D6D' } : undefined}>{w}{' '}</span>;
                })}
              </span>
            </div>
          )}
        </div>
        {p.audio && <audio ref={audioRef} src={p.audio.url} preload="auto" />}

        {/* thanh thời gian */}
        <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
          <div className="h-full bg-amber-500" style={{ width: `${Math.min(100, (t / Math.max(0.1, p.duration)) * 100)}%` }} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={!p.onPrev} onClick={p.onPrev} className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 disabled:text-slate-600 text-[11px] font-black">← {p.isVN ? 'Cảnh trước' : 'Prev'}</button>
          <button type="button" onClick={() => (playing ? stop() : void play())} className="px-4 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-[11px] font-black uppercase">
            {playing ? (p.isVN ? '■ Dừng' : '■ Stop') : (p.isVN ? '▶ Phát cảnh' : '▶ Play')}
          </button>
          <button type="button" disabled={!p.onNext} onClick={p.onNext} className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 disabled:text-slate-600 text-[11px] font-black">{p.isVN ? 'Cảnh sau' : 'Next'} →</button>
          <span className="ml-auto text-[11px] font-bold text-slate-400">{t.toFixed(1)}s / {p.duration.toFixed(1)}s</span>
        </div>

        <input
          type="text"
          value={p.text}
          onChange={(e) => p.onText(e.target.value)}
          placeholder={p.isVN ? 'Lời thoại / phụ đề của cảnh...' : 'Scene text...'}
          className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-[12px] text-slate-100 outline-none focus:border-amber-400"
        />
        <div className="text-[10px] text-slate-400 font-bold space-y-0.5">
          {p.info.map((x, i) => <div key={i}>{x}</div>)}
          <div className="text-slate-500">{p.isVN ? 'Hiệu ứng phóng to / khung sáng… chỉ hiện đầy đủ khi xuất phim.' : 'Effects render fully on export.'}</div>
        </div>
      </div>
    </div>
  );
};
