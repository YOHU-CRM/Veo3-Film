import React, { useState, useRef, useEffect, useMemo } from 'react';
import { 
  Film, Music, Mic, FileText, Download, RotateCcw, 
  Trash2, ArrowUp, ArrowDown, CheckCircle2, 
  Sparkles, Layers, Sliders, Eye, Wand2, 
  Play, Pause, Loader2, CreditCard, Copy, Check, Image as ImageIcon
} from 'lucide-react';
import { generateGeminiText, generateGeminiVoice, VoiceRegion } from '../../services/gemini';
import { UserProfile } from '../../types';
import { parseSceneNumber, estimateTotalDuration, sceneDuration, DEFAULT_IMAGE_SECONDS, VOICE_LEAD, VOICE_TAIL } from '../../../shared/render/plan';
import { MUSIC_MOODS, type MusicMood, type MotionStyle } from '../../../shared/render/types';
import { UniversalDropZone } from './UniversalDropZone';
import { classifyAudioBatch, ingestFiles, splitScriptToScenes } from '../../ingest';
import { readPdfInBrowser, renderPdfPages } from '../../ingest/pdfBrowser';
import { transcribeAudioGemini } from '../../services/gemini';
import { robustAudioDuration, splitVoiceFile } from '../../utils/audioTools';
import { describeImageMotion, releasePreparedImage } from '../../engine/imageCache';
import {
  detectEngine, renderMovie, RenderCancelled,
  type EngineKind, type RenderResult,
} from '../../engine';

/** Thời lượng + nguồn của MỘT cảnh (ảnh hoặc video). Ưu tiên: bạn tự đặt > giọng đọc > mặc định/clip gốc */
const sceneInfoOf = (s: { kind?: 'video' | 'image'; imageDuration?: number; voiceDuration?: number; voiceUrl?: string; videoDuration: number; userDuration?: number }) =>
  sceneDuration({
    kind: s.kind === 'image' ? 'image' : 'video',
    videoDuration: s.videoDuration,
    imageDuration: s.imageDuration,
    voiceDuration: s.voiceUrl ? s.voiceDuration : undefined,
    userDuration: s.userDuration,
  });

export const MAX_FREE_TRIALS = 5;
export const COST_PER_MOVIE = 5; // 5 credits per movie

export interface SceneItem {
  id: string;
  order: number;
  // Video
  videoFile?: File;
  videoUrl: string;
  videoName: string;
  videoDuration: number;
  videoWidth: number;
  videoHeight: number;
  // Ảnh tĩnh -> chuyển động an toàn cho chữ (kind = 'image'; khi đó videoUrl = '')
  kind?: 'video' | 'image';
  imageFile?: File;
  imageUrl?: string;
  imageDuration?: number;
  /** Thời lượng bạn tự đặt (giây). ƯU TIÊN SỐ 1; để trống = tự động theo giọng đọc/clip/ảnh */
  userDuration?: number;
  /** Phụ đề có thời điểm do AI nghe giọng đọc; chỉ dùng khi subtitleCuesFor trùng voiceUrl hiện tại */
  subtitleCues?: { start: number; end: number; text: string }[];
  subtitleCuesFor?: string;
  /** Chữ phụ đề lúc nhận dạng; nếu chữ bị sửa sau đó thì bỏ phụ đề theo giọng, dùng chữ mới */
  subtitleCuesText?: string;
  motionStyle?: MotionStyle;
  /** kết quả phân tích ảnh để hiển thị: số khối nhận diện, chế độ */
  motionInfo?: { mode: 'slide' | 'photo'; blocks: number } | null;
  // Voice
  voiceFile?: File;
  voiceUrl?: string;
  voiceName?: string;
  voiceDuration?: number;
  // Subtitle / Script
  subtitleText?: string;
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
  // Mặc định cho các cảnh ảnh mới thêm
  const [imageSeconds, setImageSeconds] = useState<number>(DEFAULT_IMAGE_SECONDS);
  const [imageStyle, setImageStyle] = useState<MotionStyle>('auto');

  // --- AI Auto Voice & Script Generator from User Description ---
  const [aiStoryPrompt, setAiStoryPrompt] = useState<string>('');
  const [aiVoiceGender, setAiVoiceGender] = useState<'MALE' | 'FEMALE'>('MALE');
  const [aiVoiceRegion, setAiVoiceRegion] = useState<VoiceRegion>('NORTH');
  const [aiVoiceStyle, setAiVoiceStyle] = useState<'inspirational' | 'dramatic' | 'warm' | 'marketing'>('inspirational');
  const [isGeneratingAiVoice, setIsGeneratingAiVoice] = useState<boolean>(false);
  const [aiGenStatus, setAiGenStatus] = useState<string>('');

  // Voice Audio Preview State
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  // --- Global Output Configurations ---
  const [movieTitle, setMovieTitle] = useState<string>(() => `Phim_AI_${new Date().toISOString().slice(0, 10)}`);
  const [aspectRatio, setAspectRatio] = useState<'original' | '16:9' | '9:16' | '1:1'>('original');
  const [fitMode, setFitMode] = useState<'blur' | 'cover' | 'contain'>('blur');
  const [quality, setQuality] = useState<'original' | '1080p' | '720p' | '4k'>('1080p');
  const [enableSubtitles, setEnableSubtitles] = useState<boolean>(true);
  const [subtitleStyle, setSubtitleStyle] = useState<'yellow_stroke' | 'white_box'>('yellow_stroke');
  const [enableBgm, setEnableBgm] = useState<boolean>(true);
  const [bgmVolume, setBgmVolume] = useState<number>(35); // 0 - 100% (mặc định 35%: đủ nghe, vẫn chỉnh tay được)

  // Script text area for auto-extraction
  const [bulkScript, setBulkScript] = useState<string>('');
  const [musicMood, setMusicMood] = useState<MusicMood | 'none'>('none');
  // 1 file ghi âm dài -> tự chia thành các đoạn (mỗi đoạn cho 1 cảnh)
  const [voiceSplitOn, setVoiceSplitOn] = useState<boolean>(true);
  // File âm thanh chưa rõ vai trò: chờ người dùng chọn Giọng đọc / Nhạc nền
  const [pendingAudio, setPendingAudio] = useState<File[]>([]);
  const [voiceSplitSec, setVoiceSplitSec] = useState<number>(8);
  const [voiceSplitSnap, setVoiceSplitSnap] = useState<boolean>(true);
  // 'seconds': mỗi đoạn ~N giây | 'scenes': chia đúng bằng số cảnh, theo tỉ lệ thời lượng bạn đặt / lượng chữ của từng cảnh
  const [voiceSplitMode, setVoiceSplitMode] = useState<'seconds' | 'scenes'>('scenes');
  const [voiceSplitNote, setVoiceSplitNote] = useState<string>('');
  const [isTranscribing, setIsTranscribing] = useState<boolean>(false);
  const [transcribeStatus, setTranscribeStatus] = useState<string>('');
  // Các đoạn giọng đọc DƯ (chưa có cảnh): tự gán cho cảnh thêm sau
  const [voiceReserve, setVoiceReserve] = useState<{ file: File; url: string; duration: number }[]>([]);
  const [isIngesting, setIsIngesting] = useState(false);
  const [ingestMessage, setIngestMessage] = useState('');
  /** Kịch bản đã tải lên nhưng chưa có cảnh nào để gắn vào */
  const pendingScriptRef = useRef<string>('');
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
  const imageInputRef = useRef<HTMLInputElement>(null);
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
  const loadAudioDuration = async (file: File | Blob, url: string): Promise<number> => {
    const d = await robustAudioDuration(file, url);
    if (d !== null) return d;
    const name = (file as File).name || '';
    alert(isVN
      ? `Không đọc được file âm thanh "${name}". Trình duyệt không hỗ trợ định dạng này (ví dụ .wma, .amr, file ghi âm lạ). Hãy đổi sang MP3 hoặc WAV rồi tải lại.`
      : `Could not read audio file "${name}". The browser does not support this format. Please convert to MP3 or WAV and try again.`);
    return 3;
  };

  // --- Handlers: Upload Video Clips ---
  const handleAddVideos = async (files: FileList | File[]) => {
    const fileArray = Array.from(files).filter(f => f.type.startsWith('video/') || f.name.match(/\.(mp4|webm|mov|mkv|avi)$/i));
    if (fileArray.length === 0) return;

    const newScenes: SceneItem[] = [];

    for (let i = 0; i < fileArray.length; i++) {
      const file = fileArray[i];
      const url = URL.createObjectURL(file);
      cleanupUrlsRef.current.push(url);
      const meta = await loadVideoMetadata(file, url);
      const order = extractSceneNumber(file.name);

      newScenes.push({
        id: `scene_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        order: order === 9999 ? scenes.length + i + 1 : order,
        videoFile: file,
        videoUrl: url,
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

  // --- Handlers: Upload Images (slide / infographic / photo) -> video with text-safe motion ---
  const loadImageMeta = (url: string): Promise<{ width: number; height: number }> =>
    new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve({ width: im.naturalWidth || 1920, height: im.naturalHeight || 1080 });
      im.onerror = () => resolve({ width: 1920, height: 1080 });
      im.src = url;
    });

  const handleAddImages = async (files: FileList | File[], texts?: Record<string, string>) => {
    const fileArray = Array.from(files).filter(f => f.type.startsWith('image/') || f.name.match(/\.(png|jpe?g|webp|bmp|gif)$/i));
    if (fileArray.length === 0) return;

    const newScenes: SceneItem[] = [];
    for (let i = 0; i < fileArray.length; i++) {
      const file = fileArray[i];
      const url = URL.createObjectURL(file);
      cleanupUrlsRef.current.push(url);
      const meta = await loadImageMeta(url);
      const order = extractSceneNumber(file.name);
      newScenes.push({
        id: `scene_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        order: order === 9999 ? scenes.length + i + 1 : order,
        kind: 'image',
        imageFile: file,
        imageUrl: url,
        imageDuration: imageSeconds,
        motionStyle: imageStyle,
        motionInfo: null,
        subtitleText: texts?.[file.name] || undefined,
        videoUrl: '',
        videoName: file.name,
        videoDuration: imageSeconds,
        videoWidth: meta.width,
        videoHeight: meta.height,
      });
    }

    setScenes(prev => {
      const combined = [...prev, ...newScenes];
      combined.sort((a, b) => a.order - b.order);
      return combined;
    });

    // Phân tích nền (không chặn giao diện) để hiển thị "nhận diện N khối" và làm nóng bộ nhớ đệm
    for (const sc of newScenes) {
      describeImageMotion(sc.imageUrl as string, sc.motionStyle ?? 'auto')
        .then(info => setScenes(prev => prev.map(s => s.id === sc.id ? { ...s, motionInfo: { mode: info.mode === 'slide' ? 'slide' : 'photo', blocks: info.blocks } } : s)))
        .catch(() => setScenes(prev => prev.map(s => s.id === sc.id ? { ...s, motionInfo: { mode: 'photo', blocks: 0 } } : s)));
    }
  };

  const updateImageScene = (id: string, patch: Partial<SceneItem>) =>
    setScenes(prev => prev.map(s => (s.id === id ? { ...s, ...patch } : s)));

  const applyImageDefaultsToAll = () =>
    setScenes(prev => prev.map(s => (s.kind === 'image' ? { ...s, motionStyle: imageStyle, imageDuration: imageSeconds, videoDuration: imageSeconds } : s)));

  // --- Handlers: Upload Voice Files Manually ---
  const scenesRef = useRef<SceneItem[]>([]);
  scenesRef.current = scenes;

  // Nhờ AI nghe giọng đọc từng cảnh -> phụ đề đúng lời nói, hiện đúng lúc người đọc tới đó
  const handleTranscribeVoices = async () => {
    const targets = scenesRef.current.filter(sc => sc.voiceUrl && sc.voiceDuration);
    if (targets.length === 0) {
      alert(isVN ? 'Chưa có cảnh nào có giọng đọc để tạo phụ đề.' : 'No scene has a voice yet.');
      return;
    }
    setIsTranscribing(true);
    let ok = 0;
    let fail = 0;
    let lastMsg = '';
    for (let i = 0; i < targets.length; i++) {
      const sc = targets[i];
      setTranscribeStatus(isVN ? `AI đang nghe giọng đọc ${i + 1}/${targets.length}...` : `Listening ${i + 1}/${targets.length}...`);
      try {
        const blob = await (await fetch(sc.voiceUrl as string)).blob();
        const cues = await transcribeAudioGemini(blob, sc.voiceDuration as number, apiKeys, outputLanguage, useProjectKey, adminFreeKeys, adminPaidKeys);
        if (cues.length === 0) { fail++; lastMsg = isVN ? 'không nghe thấy lời nói' : 'no speech'; continue; }
        setScenes(prev => prev.map(s => s.id === sc.id
          ? { ...s, subtitleCues: cues, subtitleCuesFor: sc.voiceUrl, subtitleCuesText: cues.map(c => c.text).join(' '), subtitleText: cues.map(c => c.text).join(' ') }
          : s));
        ok++;
      } catch (e: any) {
        fail++;
        lastMsg = String(e?.message || e).slice(0, 120);
      }
    }
    setIsTranscribing(false);
    setTranscribeStatus(isVN
      ? `✅ Đã tạo phụ đề theo giọng đọc cho ${ok} cảnh.${fail ? ` ${fail} cảnh chưa được (${lastMsg}).` : ''}`
      : `✅ Subtitles created for ${ok} scene(s).${fail ? ` ${fail} failed (${lastMsg}).` : ''}`);
  };

  // Có cảnh mới (đã có hình, chưa có voice) và còn giọng dự trữ -> gán tiếp theo thứ tự
  useEffect(() => {
    if (voiceReserve.length === 0) return;
    const need = scenes.filter(sc => (sc.videoUrl || sc.imageUrl) && !sc.voiceUrl).slice(0, voiceReserve.length);
    if (need.length === 0) return;
    const take = voiceReserve.slice(0, need.length);
    setScenes(prev => prev.map(sc => {
      const k = need.findIndex(n => n.id === sc.id);
      if (k < 0) return sc;
      const v = take[k];
      return { ...sc, voiceFile: v.file, voiceUrl: v.url, voiceName: v.file.name, voiceDuration: v.duration };
    }));
    setVoiceReserve(prev => prev.slice(need.length));
  }, [scenes, voiceReserve]);

  const chooseAudioRole = async (file: File, role: 'voice' | 'music' | 'skip') => {
    setPendingAudio(prev => prev.filter(f => f !== file));
    if (role === 'voice') await handleAddVoices([file]);
    else if (role === 'music') await handleAddBgm(file);
  };

  const assignSplitVoice = async (file: File) => {
    try {
      // Chế độ 'scenes': trọng số của mỗi cảnh = thời lượng bạn đặt, nếu không có thì theo lượng chữ / số khối chữ
      const cur = scenesRef.current.filter(sc => sc.videoUrl || sc.imageUrl);
      const useScenes = voiceSplitMode === 'scenes' && cur.length >= 2;
      const weights = useScenes
        ? cur.map(sc => sc.userDuration ?? (sc.subtitleText?.trim().length ? sc.subtitleText.trim().length : (sc.motionInfo?.blocks ? sc.motionInfo.blocks * 12 : 30)))
        : undefined;
      const segs = await splitVoiceFile(file, voiceSplitSec, 'voice', voiceSplitSnap, weights);
      const data = segs.map(sg => {
        const url = URL.createObjectURL(sg.file);
        cleanupUrlsRef.current.push(url);
        return { file: sg.file, url, duration: sg.duration };
      });
      // Gán lần lượt cho các cảnh đã có hình/video (theo tỉ lệ: đúng số cảnh). Đoạn DƯ không tạo cảnh thừa mà để dành
      // cho cảnh thêm sau (mục "giọng dự trữ").
      const ids = scenesRef.current.filter(sc => sc.videoUrl || sc.imageUrl).map(sc => sc.id);
      const used = Math.min(ids.length, data.length);
      const reserve = data.slice(used);
      setScenes(prev => prev.map(sc => {
        const k = ids.indexOf(sc.id);
        if (k < 0 || k >= used) return sc;
        const v = data[k];
        return { ...sc, voiceFile: v.file, voiceUrl: v.url, voiceName: v.file.name, voiceDuration: v.duration };
      }));
      if (reserve.length) setVoiceReserve(prev => [...prev, ...reserve]);
      const total = segs.reduce((t, sg) => t + sg.duration, 0);
      const reserveSec = reserve.reduce((t, v) => t + v.duration, 0);
      const missing = Math.max(0, ids.length - data.length);
      setVoiceSplitNote(isVN
        ? `✅ Đã chia giọng đọc (${total.toFixed(1)}s) thành ${segs.length} đoạn${useScenes ? ' theo tỉ lệ từng cảnh (dùng HẾT giọng đọc)' : ` ~${voiceSplitSec}s`}. ${used} đoạn đầu gán cho ${used} cảnh.${reserve.length ? ` Còn ${reserve.length} đoạn dư (${reserveSec.toFixed(1)}s) được GIỮ LẠI, tự gán cho cảnh bạn thêm sau.` : ''}${missing ? ` Có ${missing} cảnh cuối chưa có voice (giọng đọc hết trước).` : ''}`
        : `✅ Voice (${total.toFixed(1)}s) split into ${segs.length} parts. ${used} assigned; ${reserve.length} kept for new scenes.`);
    } catch (e: any) {
      alert(isVN
        ? `Không chia được file ghi âm: ${e?.message || e}. Hãy thử đổi sang MP3 hoặc WAV.`
        : `Could not split the voice file: ${e?.message || e}. Try MP3 or WAV.`);
    }
  };

  const handleAddVoices = async (files: FileList | File[]) => {
    const fileArray = Array.from(files).filter(f => f.type.startsWith('audio/') || f.name.match(/\.(wav|mp3|m4a|aac|ogg|flac)$/i));
    if (fileArray.length === 0) return;

    // 1 file ghi âm dài -> chia thành nhiều đoạn, mỗi đoạn lồng cho 1 cảnh
    if (fileArray.length === 1 && voiceSplitOn) {
      const only = fileArray[0];
      const url0 = URL.createObjectURL(only);
      cleanupUrlsRef.current.push(url0);
      const d0 = await loadAudioDuration(only, url0);
      const visualScenes = scenesRef.current.filter(sc => sc.videoUrl || sc.imageUrl).length;
      if ((voiceSplitMode === 'scenes' && visualScenes >= 2) || d0 > voiceSplitSec * 1.2) { await assignSplitVoice(only); return; }
    }

    const voiceDataList = await Promise.all(
      fileArray.map(async (file) => {
        const url = URL.createObjectURL(file);
        cleanupUrlsRef.current.push(url);
        const duration = await loadAudioDuration(file, url);
        const sceneNum = extractSceneNumber(file.name);
        return { file, url, name: file.name, duration, sceneNum };
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
            voiceDuration: v.duration
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
            voiceDuration: v.duration
          };
        }
      });

      return updated;
    });
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
      if (target.imageUrl) { releasePreparedImage(target.imageUrl); URL.revokeObjectURL(target.imageUrl); }
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
  const handleGenerateAiVoiceAndScript = async () => {
    if (scenes.length === 0) {
      alert(isVN 
        ? 'Vui lòng thêm danh sách các video clip trước để AI nắm được số lượng cảnh cần viết kịch bản!' 
        : 'Please upload video clips first so AI knows the scene count and pacing!');
      return;
    }

    if (!aiStoryPrompt.trim()) {
      alert(isVN 
        ? 'Vui lòng nhập mô tả ý tưởng hoặc phong cách video bạn muốn AI dựng!' 
        : 'Please enter a description or theme for your video!');
      return;
    }

    setIsGeneratingAiVoice(true);
    setAiGenStatus(isVN ? 'AI đang phân tích các cảnh và viết lời thoại phân cảnh...' : 'AI is writing scene scripts...');

    try {
      const sceneCount = scenes.length;
      const scriptPrompt = `Bạn là một nhà biên kịch và đạo diễn video AI hàng đầu Hollywood.
Người dùng có tổng cộng ${sceneCount} cảnh video (scenes) và yêu cầu chủ đề/mô tả sau:
"${aiStoryPrompt.trim()}"

NHIỆM VỤ CỦA BẠN:
Viết chính xác ${sceneCount} câu lời thoại (voiceover narration) truyền cảm, mỗi câu khớp đúng với 1 cảnh theo mạch truyện lôi cuốn từ mở đầu đến kết thúc.

QUY TẮC BẮT BUỘC:
1. Viết đúng ${sceneCount} dòng, mỗi dòng đại diện cho một cảnh theo thứ tự 1 đến ${sceneCount}.
2. Độ dài mỗi câu: khoảng 12 đến 24 từ (đọc trong khoảng 4 đến 6 giây). Không viết quá ngắn, không viết quá dài.
3. Câu từ cảm xúc, sâu sắc, cuốn hút người xem mạng xã hội (TikTok, Shorts, YouTube).
4. ĐỊNH DẠNG ĐẦU RA BẮT BUỘC (chỉ in đúng định dạng này, không có lời mở đầu hay kết thúc):
Cảnh 1: [Câu lời thoại cảnh 1]
Cảnh 2: [Câu lời thoại cảnh 2]
...
Cảnh ${sceneCount}: [Câu lời thoại cảnh ${sceneCount}]`;

      const generatedScriptText = await generateGeminiText(
        scriptPrompt,
        undefined,
        apiKeys,
        outputLanguage,
        useProjectKey,
        adminFreeKeys,
        adminPaidKeys
      );

      // Parse the lines
      const rawLines = generatedScriptText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const parsedDialogues: string[] = [];

      rawLines.forEach(line => {
        const cleaned = line.replace(/^(?:Cảnh|Scene|\d+)[\s\d:.-]+/i, '').trim();
        if (cleaned.length > 5) {
          parsedDialogues.push(cleaned);
        }
      });

      // Update subtitleText on scenes
      const updatedScenes = [...scenes];
      for (let i = 0; i < updatedScenes.length; i++) {
        if (i < parsedDialogues.length) {
          updatedScenes[i] = {
            ...updatedScenes[i],
            subtitleText: parsedDialogues[i]
          };
        }
      }
      setScenes(updatedScenes);

      // Next: Generate TTS Voice for each scene
      setAiGenStatus(isVN ? 'AI đang tạo giọng đọc âm thanh cho từng cảnh...' : 'AI is generating voiceovers...');

      const styleKeywords = {
        inspirational: 'Deep, warm, inspirational baritone voice, emotional and steady cadence',
        dramatic: 'Cinematic, suspenseful, dramatic narration, powerful storytelling tone',
        warm: 'Gentle, warm, natural baritone storytelling tone, emotional and intimate',
        marketing: 'Enthusiastic, bright, engaging marketing style, clear and confident'
      };

      for (let i = 0; i < updatedScenes.length; i++) {
        const textToSpeak = updatedScenes[i].subtitleText;
        if (!textToSpeak) continue;

        setAiGenStatus(isVN ? `Đang tạo giọng đọc AI cho Cảnh ${i + 1}/${updatedScenes.length}...` : `Generating voice for Scene ${i + 1}/${updatedScenes.length}...`);

        try {
          const audioUri = await generateGeminiVoice(
            textToSpeak,
            'vi-VN',
            aiVoiceGender,
            styleKeywords[aiVoiceStyle],
            apiKeys,
            outputLanguage,
            useProjectKey,
            'studio',
            aiVoiceRegion,
            adminFreeKeys,
            adminPaidKeys
          );

          if (audioUri) {
            const resp = await fetch(audioUri);
            const blob = await resp.blob();
            const voiceUrl = URL.createObjectURL(blob);
            cleanupUrlsRef.current.push(voiceUrl);
            const voiceDuration = await loadAudioDuration(blob, voiceUrl);

            updatedScenes[i] = {
              ...updatedScenes[i],
              voiceUrl,
              voiceName: `AI_Voice_Scene_${i + 1}.wav`,
              voiceDuration
            };
          }
        } catch (voiceErr) {
          console.warn(`Lỗi tạo giọng cho cảnh ${i + 1}, tiếp tục cảnh khác:`, voiceErr);
        }
      }

      setScenes([...updatedScenes]);
      alert(isVN 
        ? `🎉 AI đã viết kịch bản và tạo xong giọng đọc cho toàn bộ ${updatedScenes.length} cảnh!\nBạn có thể nghe thử, chỉnh sửa hoặc bấm "TẠO PHIM" ngay!` 
        : `🎉 AI successfully generated scripts and voices for all ${updatedScenes.length} scenes!`);
    } catch (err: any) {
      console.error('Lỗi khi AI tự tạo voice & kịch bản:', err);
      alert((isVN ? 'Đã xảy ra lỗi khi tạo voice tự động: ' : 'AI voice generation error: ') + (err.message || err));
    } finally {
      setIsGeneratingAiVoice(false);
      setAiGenStatus('');
    }
  };

  // Auto assign script text to scenes
  // --- Ô kéo thả duy nhất: nhận mọi loại file, tự phân loại ---
  const applyScriptText = (text: string) => {
    setScenes(prev => {
      if (prev.length === 0) { pendingScriptRef.current = text; return prev; }
      pendingScriptRef.current = '';
      const { lines } = splitScriptToScenes(text, prev.length);
      return prev.map((sc, i) => (lines[i] ? { ...sc, subtitleText: lines[i] } : sc));
    });
  };

  useEffect(() => {
    if (scenes.length > 0 && pendingScriptRef.current) applyScriptText(pendingScriptRef.current);
  }, [scenes.length]);

  const handleUniversalFiles = async (files: File[]) => {
    setIsIngesting(true);
    setIngestMessage('');
    try {
      const res = await ingestFiles(files, { readPdf: readPdfInBrowser, collectPdfs: true });
      const notes: string[] = [];

      if (res.videos.length) await handleAddVideos(res.videos);
      if (res.images.length) await handleAddImages(res.images);

      // PDF thả riêng (chưa có cảnh, không kèm ảnh/video) -> mỗi TRANG là 1 cảnh slide, chữ của trang làm phụ đề.
      // Ngược lại -> dùng chữ trong PDF làm kịch bản.
      const pdfAsSlides = res.pdfs.length > 0 && res.videos.length + res.images.length === 0 && scenes.length === 0;
      let pdfPages = 0;
      for (const pdf of res.pdfs) {
        if (pdfAsSlides) {
          const pages = await renderPdfPages(pdf.file);
          const texts: Record<string, string> = {};
          pages.files.forEach((f, i) => { if (pages.pageTexts[i]) texts[f.name] = pages.pageTexts[i]; });
          await handleAddImages(pages.files, texts);
          pdfPages += pages.files.length;
          if (pages.truncated) notes.push(isVN ? `PDF "${pdf.file.name}" quá dài: chỉ lấy 60 trang đầu.` : `PDF "${pdf.file.name}" is long: first 60 pages only.`);
        } else if (pdf.scanned) {
          notes.push(isVN ? `PDF "${pdf.file.name}" là dạng ảnh scan, không có chữ để làm kịch bản.` : `PDF "${pdf.file.name}" is scanned (no text).`);
        } else {
          res.scripts.push({ name: pdf.file.name, text: pdf.text });
        }
      }

      // Âm thanh: phân biệt voice và nhạc nền
      let voices = 0;
      let music = 0;
      if (res.audios.length) {
        const probes = await Promise.all(res.audios.map(async f => {
          const url = URL.createObjectURL(f);
          const duration = await loadAudioDuration(f, url);
          URL.revokeObjectURL(url);
          const n = parseSceneNumber(f.name);
          return { file: f, name: f.name, duration, number: n };
        }));
        const classified = classifyAudioBatch(probes);
        // Chỉ tự xếp những file RÕ RÀNG (tên có "voice/giọng/nhạc/music..." hoặc số cảnh). File mơ hồ thì HỎI, không đoán nữa
        // để nhạc nền không bị nhầm thành voice và tạo cảnh thừa ở cuối video.
        const sure = classified.filter(c => !c.guessed);
        const unsure = classified.filter(c => c.guessed);
        const voiceFiles = sure.filter(c => c.role === 'voice').map(c => (c.item as typeof probes[number]).file);
        const musicItem = sure.find(c => c.role === 'music');
        if (voiceFiles.length) { await handleAddVoices(voiceFiles); voices = voiceFiles.length; }
        if (musicItem) { await handleAddBgm((musicItem.item as typeof probes[number]).file); music = 1; }
        if (unsure.length) {
          setPendingAudio(prev => [...prev, ...unsure.map(c => (c.item as typeof probes[number]).file)]);
          notes.push(isVN
            ? `${unsure.length} file âm thanh chưa rõ là GIỌNG ĐỌC hay NHẠC NỀN: hãy bấm chọn ở khung bên dưới.`
            : `${unsure.length} audio file(s): please choose VOICE or MUSIC below.`);
        }
      }

      // Kịch bản (PDF / TXT / SRT)
      let scriptNote = '';
      if (res.scripts.length) {
        const text = res.scripts.map(sc => sc.text).join('\n\n');
        applyScriptText(text);
        scriptNote = isVN ? `kịch bản từ ${res.scripts.length} file` : `script from ${res.scripts.length} file(s)`;
      }

      const parts: string[] = [];
      if (res.videos.length) parts.push(isVN ? `${res.videos.length} video` : `${res.videos.length} video(s)`);
      if (pdfPages) parts.push(isVN ? `${pdfPages} trang PDF (mỗi trang 1 cảnh)` : `${pdfPages} PDF page(s)`);
      if (res.images.length) parts.push(isVN ? `${res.images.length} ảnh` : `${res.images.length} image(s)`);
      if (voices) parts.push(isVN ? `${voices} voice` : `${voices} voice(s)`);
      if (music) parts.push(isVN ? '1 nhạc nền' : '1 music track');
      if (scriptNote) parts.push(scriptNote);
      if (res.zipsOpened) parts.push(isVN ? `(đã mở ${res.zipsOpened} file ZIP)` : `(${res.zipsOpened} ZIP opened)`);

      const lines: string[] = [];
      lines.push(parts.length
        ? `✅ ${isVN ? 'Đã nhận' : 'Received'}: ${parts.join(', ')}.`
        : (isVN ? '⚠️ Không nhận được file hợp lệ nào.' : '⚠️ No valid files received.'));
      for (const w of [...res.warnings, ...notes]) lines.push(`• ${w}`);
      setIngestMessage(lines.join('\n'));
    } catch (err: any) {
      console.error('Lỗi khi đọc file:', err);
      setIngestMessage(`⚠️ ${isVN ? 'Không đọc được file' : 'Could not read files'}: ${err?.message || err}`);
    } finally {
      setIsIngesting(false);
    }
  };

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
          return { ...scene, subtitleText: cleaned || lines[idx] };
        }
        return scene;
      });
    });
    setShowScriptModal(false);
  };

  // --- Total Calculated Duration of Film ---
  const totalDuration = useMemo(
    () => estimateTotalDuration(scenes.filter(sc => sc.videoUrl || sc.imageUrl).map(sc => ({
      id: sc.id,
      kind: sc.kind,
      imageDuration: sc.imageDuration,
      userDuration: sc.userDuration,
      videoDuration: sc.videoDuration,
      videoWidth: sc.videoWidth,
      videoHeight: sc.videoHeight,
      voiceDuration: sc.voiceUrl ? sc.voiceDuration : undefined,
    }))),
    [scenes],
  );

  // --- CORE AUTOMATIC VIDEO RENDERING ENGINE ---
  const handleCreateMovie = async () => {
    if (isProcessing) return;
    if (scenes.length === 0) {
      alert(isVN ? 'Vui lòng thêm ít nhất 1 video clip hoặc 1 ảnh để tạo phim!' : 'Please add at least 1 video clip or image!');
      return;
    }

    const validScenes = scenes.filter(s => s.videoUrl || s.imageUrl);
    if (validScenes.length === 0) {
      alert(isVN ? 'Không có video clip hoặc ảnh hợp lệ nào trong danh sách!' : 'No valid video clips or images found!');
      return;
    }

    const skipped = scenes.length - validScenes.length;
    if (skipped > 0) {
      const ok = confirm(isVN
        ? `Có ${skipped} cảnh mới chỉ có voice, chưa có video/ảnh nên sẽ bị bỏ qua. Tiếp tục tạo phim?`
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

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await renderMovie(
        {
          // Chỉ dùng phụ đề theo giọng nếu giọng đọc của cảnh không bị đổi sau khi nhận dạng
          scenes: validScenes.map(sc => (sc.subtitleCues && sc.subtitleCuesFor === sc.voiceUrl && sc.subtitleCuesText === sc.subtitleText ? sc : { ...sc, subtitleCues: undefined })),
          settings: {
            aspectRatio, fitMode, quality,
            enableSubtitles, subtitleStyle,
            enableBgm: enableBgm && (!!bgmUrl || musicMood !== 'none'),
            bgmVolume,
          },
          bgm: bgmUrl ? { url: bgmUrl, name: bgmName || 'bgm.mp3' } : undefined,
          generatedMusic: !bgmUrl && enableBgm && musicMood !== 'none' ? musicMood : null,
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
          
          {/* Một ô kéo thả cho tất cả: video, ảnh, voice, nhạc, PDF/TXT, ZIP */}
          <UniversalDropZone
            isVN={isVN}
            busy={isIngesting}
            message={ingestMessage}
            onFiles={handleUniversalFiles}
            onDismissMessage={() => setIngestMessage('')}
          />

          {/* File âm thanh chưa rõ vai trò: người dùng chọn, tool không đoán */}
          {pendingAudio.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/40 rounded-xl px-3 py-2 text-[11px] text-amber-100 space-y-1.5">
              <div className="font-bold">
                {isVN ? 'Chọn vai trò cho file âm thanh (tool không đoán nữa để khỏi nhầm nhạc nền thành giọng đọc):' : 'Choose a role for these audio files:'}
              </div>
              {pendingAudio.map((f, i) => (
                <div key={`${f.name}-${i}`} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono truncate max-w-[16rem]">{f.name}</span>
                  <button type="button" onClick={() => chooseAudioRole(f, 'voice')} className="px-2 py-0.5 rounded-md bg-emerald-600 text-white font-bold">{isVN ? 'Giọng đọc' : 'Voice'}</button>
                  <button type="button" onClick={() => chooseAudioRole(f, 'music')} className="px-2 py-0.5 rounded-md bg-indigo-600 text-white font-bold">{isVN ? 'Nhạc nền' : 'Music'}</button>
                  <button type="button" onClick={() => chooseAudioRole(f, 'skip')} className="px-2 py-0.5 rounded-md bg-slate-700 text-slate-200">{isVN ? 'Bỏ qua' : 'Skip'}</button>
                </div>
              ))}
            </div>
          )}

          {/* Top 3 Quick Upload Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2.5">
            {/* 1. Add Videos */}
            <div 
              onClick={() => videoInputRef.current?.click()}
              className="bg-slate-900/90 hover:bg-slate-850 border-2 border-dashed border-indigo-500/40 hover:border-indigo-400 rounded-2xl p-4 flex flex-col items-center justify-center cursor-pointer transition group shadow-lg text-center"
            >
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white flex items-center justify-center mb-2 shadow-md group-hover:scale-110 transition">
                <Film size={20} />
              </div>
              <span className="text-xs font-black uppercase text-indigo-200 tracking-tight">
                {isVN ? '+ Thêm Video Clip' : '+ Add Video Clips'}
              </span>
              <span className="text-[10px] text-slate-400 font-medium mt-0.5">
                {isVN ? 'Chọn nhiều clip scene_001.mp4...' : 'Batch select video files'}
              </span>
              <input 
                type="file" 
                ref={videoInputRef} 
                onChange={(e) => { if (e.target.files) handleAddVideos(e.target.files); e.target.value = ''; }} 
                multiple 
                accept="video/*" 
                hidden 
              />
            </div>

            {/* 1b. Add Images */}
            <div 
              onClick={() => imageInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files?.length) handleAddImages(e.dataTransfer.files); }}
              className="bg-slate-900/90 hover:bg-slate-850 border-2 border-dashed border-amber-500/40 hover:border-amber-400 rounded-2xl p-4 flex flex-col items-center justify-center cursor-pointer transition group shadow-lg text-center"
            >
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 text-slate-950 flex items-center justify-center mb-2 shadow-md group-hover:scale-110 transition">
                <ImageIcon size={20} />
              </div>
              <span className="text-xs font-black uppercase text-amber-200 tracking-tight">
                {isVN ? '+ Thêm Ảnh / Slide' : '+ Add Images / Slides'}
              </span>
              <span className="text-[10px] text-slate-400 font-medium mt-0.5">
                {isVN ? 'Tự tạo chuyển động, GIỮ NGUYÊN chữ' : 'Auto motion, text stays intact'}
              </span>
              <input 
                type="file" 
                ref={imageInputRef} 
                onChange={(e) => { if (e.target.files) handleAddImages(e.target.files); e.target.value = ''; }} 
                multiple 
                accept="image/*" 
                hidden 
              />
            </div>

            {/* 2. Add Voices */}
            <div 
              onClick={() => voiceInputRef.current?.click()}
              className="bg-slate-900/90 hover:bg-slate-850 border-2 border-dashed border-emerald-500/40 hover:border-emerald-400 rounded-2xl p-4 flex flex-col items-center justify-center cursor-pointer transition group shadow-lg text-center"
            >
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-700 text-white flex items-center justify-center mb-2 shadow-md group-hover:scale-110 transition">
                <Mic size={20} />
              </div>
              <span className="text-xs font-black uppercase text-emerald-200 tracking-tight">
                {isVN ? '+ Thêm File Voice' : '+ Add Voice Files'}
              </span>
              <span className="text-[10px] text-slate-400 font-medium mt-0.5">
                {isVN ? 'Tự khớp theo số cảnh scene_001.wav' : 'Auto syncs by scene number'}
              </span>
              <input 
                type="file" 
                ref={voiceInputRef} 
                onChange={(e) => { if (e.target.files) handleAddVoices(e.target.files); e.target.value = ''; }} 
                multiple 
                accept="audio/*" 
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
                {isVN ? 'Thêm Nhạc nền' : 'Add Background Music'}
              </span>
              <span className="text-[10px] text-slate-400 font-medium mt-0.5">
                {bgmUrl ? `✓ ${bgmName} • ${Math.round(bgmDuration)}s` : (isVN ? 'Tự giảm nhẹ khi có voice' : 'Gently lowers under voice')}
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
                  ? "Nhập mô tả câu chuyện / phong cách muốn dựng (Ví dụ: Kể về hành trình khởi nghiệp từ hai bàn tay trắng vượt qua bão giông, giọng nam trầm ấm truyền cảm, kết thúc đầy hy vọng và tự hào)..." 
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
                </span>
              </div>
              <span className="text-[11px] font-bold text-slate-400">
                {isVN ? 'Tổng thời lượng ước tính:' : 'Est. Duration:'}{' '}
                <span className="text-amber-400 font-black">{totalDuration.toFixed(1)}s</span>
              </span>
            </div>

            {/* Chia 1 file ghi âm dài cho nhiều cảnh */}
            <div className="flex flex-wrap items-center gap-2 bg-slate-900/70 border border-slate-700 rounded-xl px-3 py-2 text-[11px] text-slate-200">
              <Mic size={14} className="text-emerald-400 shrink-0" />
              <label className="flex items-center gap-1.5 cursor-pointer font-bold">
                <input type="checkbox" checked={voiceSplitOn} onChange={(e) => setVoiceSplitOn(e.target.checked)} className="accent-emerald-500" />
                {isVN ? 'Chia 1 file ghi âm dài cho nhiều cảnh' : 'Split one long voice file across scenes'}
              </label>
              <select
                value={voiceSplitMode}
                onChange={(e) => setVoiceSplitMode(e.target.value as 'seconds' | 'scenes')}
                className="bg-slate-950 border border-slate-700 rounded-md px-1.5 py-1 outline-none focus:border-emerald-400"
              >
                <option value="scenes">{isVN ? 'đúng số cảnh, theo tỉ lệ chữ/thời lượng từng cảnh' : 'per scene, proportional'}</option>
                <option value="seconds">{isVN ? 'mỗi đoạn N giây' : 'N seconds each'}</option>
              </select>
              {voiceSplitMode === 'seconds' && (
                <>
                  <input
                    type="number" min={2} max={120} step={0.5} value={voiceSplitSec}
                    onChange={(e) => setVoiceSplitSec(Math.max(2, Math.min(120, Number(e.target.value) || 8)))}
                    className="w-16 bg-slate-950 border border-slate-700 rounded-md px-2 py-1 text-center outline-none focus:border-emerald-400"
                  />
                  <span>{isVN ? 'giây' : 's'}</span>
                </>
              )}
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={voiceSplitSnap} onChange={(e) => setVoiceSplitSnap(e.target.checked)} className="accent-emerald-500" />
                {isVN ? 'cắt ở chỗ ngắt nghỉ (bỏ chọn = cắt đúng từng N giây)' : 'cut at pauses (off = exact N seconds)'}
              </label>
              {voiceReserve.length > 0 && (
                <button type="button" onClick={() => setVoiceReserve([])} className="px-2 py-0.5 rounded-md bg-slate-700 text-slate-200 text-[10px]">
                  {isVN ? `Bỏ ${voiceReserve.length} đoạn giọng dư` : `Discard ${voiceReserve.length} spare part(s)`}
                </button>
              )}
              {voiceSplitNote && <div className="basis-full text-[10px] text-emerald-300 whitespace-pre-line">{voiceSplitNote}</div>}
            </div>

            {/* Image defaults bar */}
            {scenes.some(sc => sc.kind === 'image') && (
              <div className="flex flex-wrap items-center gap-2 bg-amber-950/20 border border-amber-800/40 rounded-xl px-3 py-2 text-[11px] text-amber-100">
                <ImageIcon size={14} className="text-amber-400 shrink-0" />
                <span className="font-black uppercase tracking-tight">{isVN ? 'Cảnh ảnh' : 'Image scenes'}</span>
                <select
                  value={imageStyle}
                  onChange={(e) => setImageStyle(e.target.value as MotionStyle)}
                  className="bg-slate-900 border border-slate-700 rounded-md px-2 py-1 text-[11px] text-slate-100 outline-none focus:border-amber-400"
                >
                  <option value="auto">{isVN ? 'Tự động (hiệu ứng đầy đủ)' : 'Auto (full effects)'}</option>
                  <option value="text-safe">{isVN ? 'An toàn chữ tuyệt đối (chỉ trượt / hiện / viền sáng)' : 'Strict text-safe (slide / reveal / outer glow only)'}</option>
                  <option value="kenburns">{isVN ? 'Zoom nhẹ (ảnh chụp)' : 'Gentle zoom (photos)'}</option>
                  <option value="none">{isVN ? 'Đứng yên' : 'Static'}</option>
                </select>
                <label className="flex items-center gap-1">
                  <input
                    type="number" min={2.5} max={60} step={0.5} value={imageSeconds}
                    onChange={(e) => setImageSeconds(Math.max(2.5, Math.min(60, Number(e.target.value) || DEFAULT_IMAGE_SECONDS)))}
                    className="w-14 bg-slate-900 border border-slate-700 rounded-md px-1.5 py-1 text-[11px] text-slate-100 outline-none focus:border-amber-400"
                  />
                  <span>{isVN ? 'giây/ảnh' : 'sec/image'}</span>
                </label>
                <button
                  type="button"
                  onClick={applyImageDefaultsToAll}
                  className="ml-auto px-2.5 py-1 rounded-md bg-amber-500 hover:bg-amber-400 text-slate-950 font-black transition"
                >
                  {isVN ? 'Áp dụng cho mọi ảnh' : 'Apply to all images'}
                </button>
              </div>
            )}

            {/* Empty State */}
            {scenes.length === 0 && (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center border-2 border-dashed border-slate-800 rounded-2xl bg-slate-950/40">
                <Film size={44} className="text-slate-600 mb-2 animate-bounce" />
                <h4 className="text-sm font-black uppercase text-slate-300 mb-1">
                  {isVN ? 'Chưa có clip video hoặc ảnh nào' : 'No video clips or images added'}
                </h4>
                <p className="text-xs text-slate-400 max-w-md leading-relaxed">
                  {isVN 
                    ? 'Bấm "+ Thêm Video Clip" để nạp clip scene_001.mp4... hoặc "+ Thêm Ảnh / Slide" để biến ảnh/slide thành video có chuyển động (chữ giữ nguyên 100%). Sau đó gõ mô tả để AI tự lồng giọng đọc!' 
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

                      {/* Video / Image Thumbnail */}
                      {scene.kind === 'image' && scene.imageUrl ? (
                        <div className="w-16 h-12 bg-black rounded-xl overflow-hidden shrink-0 border border-amber-700/60 relative">
                          <img src={scene.imageUrl} alt="" className="w-full h-full object-cover" />
                          <span className="absolute left-0.5 top-0.5 text-[8px] font-black bg-amber-500 text-slate-950 px-1 rounded">{isVN ? 'ẢNH' : 'IMG'}</span>
                        </div>
                      ) : scene.videoUrl ? (
                        <div className="w-16 h-12 bg-black rounded-xl overflow-hidden shrink-0 border border-slate-700 relative group/vid">
                          <video src={scene.videoUrl} className="w-full h-full object-cover" muted playsInline />
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
                          <span className="text-[10px] bg-slate-850 text-indigo-300 px-1.5 py-0.2 rounded font-bold border border-indigo-900/60">
                            {sceneInfoOf(scene).seconds.toFixed(1)}s
                          </span>
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
                          ) : (
                            <span className="text-[10px] text-slate-500 italic">
                              {isVN ? (scene.kind === 'image' ? 'Chưa có voice (theo số giây đã đặt)' : 'Chưa có voice (giữ độ dài clip)') : 'No voice (original length)'}
                            </span>
                          )}
                        </div>

                        {/* Image scene controls */}
                        {scene.kind === 'image' && (
                          <div className="flex flex-wrap items-center gap-2 mt-1.5 text-[10px] text-slate-300">
                            <select
                              value={scene.motionStyle ?? 'auto'}
                              onChange={(e) => updateImageScene(scene.id, { motionStyle: e.target.value as MotionStyle })}
                              title={isVN
                                ? 'Hiệu ứng ảnh (rê chuột lên từng mục để xem mô tả)\n\n• Tự động: tool tự nhận diện. Slide/infographic có nền phẳng -> chữ và thẻ hiện lần lượt; ảnh chụp -> zoom nhẹ.\n• An toàn chữ: chỉ chuyển động nhẹ nền, chữ giữ nguyên, không bị méo.\n• Zoom nhẹ: phóng to/thu nhỏ chậm cả bức ảnh (hợp ảnh chụp, ảnh có người).\n• Đứng yên: không chuyển động.'
                                : 'Image effect'}
                              className="bg-slate-900 border border-slate-700 rounded-md px-1.5 py-0.5 text-[10px] text-slate-100 outline-none focus:border-amber-400"
                            >
                              <option value="auto" title={isVN ? 'Tool tự nhận diện: slide/infographic nền phẳng thì chữ và thẻ hiện lần lượt; ảnh chụp thì zoom nhẹ.' : 'Auto-detect'}>{isVN ? 'Tự động' : 'Auto'}</option>
                              <option value="text-safe" title={isVN ? 'Chỉ chuyển động nhẹ phần nền, chữ giữ nguyên, không bị méo.' : 'Subtle motion, text untouched'}>{isVN ? 'An toàn chữ' : 'Text-safe'}</option>
                              <option value="kenburns" title={isVN ? 'Phóng to/thu nhỏ chậm cả bức ảnh. Hợp ảnh chụp; với slide nhiều chữ nên dùng Tự động.' : 'Slow zoom of the whole image'}>{isVN ? 'Zoom nhẹ' : 'Gentle zoom'}</option>
                              <option value="none" title={isVN ? 'Ảnh đứng yên suốt cảnh.' : 'Static image'}>{isVN ? 'Đứng yên' : 'Static'}</option>
                            </select>
                            <span className="text-slate-400">
                              {scene.motionInfo === null || scene.motionInfo === undefined
                                ? (isVN ? 'Đang phân tích ảnh…' : 'Analyzing…')
                                : scene.motionInfo.mode === 'slide'
                                  ? (isVN ? `Nhận diện ${scene.motionInfo.blocks} khối chữ/hình` : `${scene.motionInfo.blocks} blocks detected`)
                                  : (isVN ? 'Ảnh chụp: zoom nhẹ' : 'Photo: gentle zoom')}
                            </span>
                          </div>
                        )}

                        {/* Thời lượng cảnh (ảnh và video): bạn đặt > giọng đọc > mặc định / clip gốc */}
                        {(() => {
                          const info = sceneInfoOf(scene);
                          const voiceLen = scene.voiceUrl && scene.voiceDuration ? VOICE_LEAD + scene.voiceDuration + VOICE_TAIL : 0;
                          const cut = scene.userDuration && voiceLen > scene.userDuration + 0.05 ? voiceLen - scene.userDuration : 0;
                          const loops = scene.kind !== 'image' && scene.userDuration && scene.videoDuration > 0 && scene.userDuration > scene.videoDuration + 0.05;
                          const sourceText = info.source === 'user' ? (isVN ? 'do bạn đặt' : 'set by you')
                            : info.source === 'voice' ? (isVN ? 'theo giọng đọc' : 'follows voice')
                            : info.source === 'image' ? (isVN ? 'mặc định của ảnh' : 'image default')
                            : (isVN ? 'theo độ dài clip' : 'clip length');
                          return (
                            <div className="flex flex-wrap items-center gap-2 mt-1.5 text-[10px] text-slate-300">
                              <label className="flex items-center gap-1">
                                <span>{isVN ? 'Thời lượng' : 'Length'}</span>
                                {scene.userDuration === undefined && <span className="text-emerald-400 font-bold">{info.seconds.toFixed(1)}s</span>}
                                {scene.userDuration !== undefined && <input
                                  type="number" min={0.5} max={600} step={0.5}
                                  value={scene.userDuration ?? ''}
                                  placeholder={info.seconds.toFixed(1)}
                                  onChange={(e) => {
                                    const raw = e.target.value;
                                    const v = raw === '' ? undefined : Math.max(0.5, Math.min(600, Number(raw) || 0.5));
                                    updateImageScene(scene.id, { userDuration: v });
                                  }}
                                  className="w-16 bg-slate-900 border border-slate-700 rounded-md px-1 py-0.5 text-[10px] text-slate-100 outline-none focus:border-amber-400"
                                />}
                                {scene.userDuration !== undefined && <span>{isVN ? 'giây' : 'sec'}</span>}
                              </label>
                              <select
                                value={scene.userDuration === undefined ? 'auto' : 'custom'}
                                onChange={(e) => updateImageScene(scene.id, { userDuration: e.target.value === 'auto' ? undefined : (scene.userDuration ?? Math.round(info.seconds * 2) / 2) })}
                                title={isVN
                                  ? 'Tự động: cảnh dài đúng bằng giọng đọc (nếu có), không thì theo mặc định của ảnh hoặc độ dài clip.\nĐặt số giây: bạn quyết định, ưu tiên cao nhất (giọng đọc dài hơn sẽ bị cắt, clip ngắn hơn sẽ lặp lại).'
                                  : 'Auto: follows the voice (if any), else the image default or clip length. Set seconds: you decide; highest priority.'}
                                className="bg-slate-900 border border-slate-700 rounded-md px-1.5 py-0.5 text-[10px] text-slate-100 outline-none focus:border-amber-400"
                              >
                                <option value="auto">{isVN ? `Tự động (${sourceText})` : `Auto (${sourceText})`}</option>
                                <option value="custom">{isVN ? 'Đặt số giây' : 'Set seconds'}</option>
                              </select>
                              {cut > 0 && <span className="text-red-400">{isVN ? `⚠ giọng đọc bị cắt ${cut.toFixed(1)}s` : `⚠ voice cut by ${cut.toFixed(1)}s`}</span>}
                              {loops && <span className="text-amber-300">{isVN ? 'clip ngắn hơn: sẽ lặp lại cho đủ' : 'clip shorter: will loop'}</span>}
                            </div>
                          );
                        })()}

                        {/* Subtitle text input */}
                        <input
                          type="text"
                          value={scene.subtitleText || ''}
                          onChange={(e) => {
                            const val = e.target.value;
                            setScenes(prev => prev.map((s, i) => i === idx ? { ...s, subtitleText: val } : s));
                          }}
                          placeholder={isVN ? 'Lời thoại / phụ đề cho cảnh này (tùy chọn)...' : 'Subtitle text for this scene (optional)...'}
                          className="mt-1.5 w-full bg-slate-900/90 border border-slate-800 rounded-lg px-2.5 py-1 text-[11px] font-medium text-slate-100 placeholder:text-slate-500 outline-none focus:border-amber-400 transition"
                        />
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

            {/* 5. Subtitles Options */}
            <div className="pt-2 border-t border-slate-850">
              <div className="flex items-center justify-between mb-2">
                <label className="text-[10px] font-black uppercase text-slate-300 flex items-center gap-1.5 cursor-pointer">
                  <input 
                    type="checkbox"
                    checked={enableSubtitles}
                    onChange={(e) => setEnableSubtitles(e.target.checked)}
                    className="w-3.5 h-3.5 rounded text-amber-500 accent-amber-500 cursor-pointer"
                  />
                  <span>{isVN ? 'Bật Phụ Đề Tự Động' : 'Enable Subtitles'}</span>
                </label>
                {enableSubtitles && (
                  <select
                    value={subtitleStyle}
                    onChange={(e) => setSubtitleStyle(e.target.value as any)}
                    className="text-[9px] font-black uppercase bg-slate-950 border border-slate-800 text-amber-400 rounded-md px-1.5 py-0.5 outline-none cursor-pointer"
                  >
                    <option value="yellow_stroke">{isVN ? 'Chữ vàng viền đen' : 'Yellow Stroke'}</option>
                    <option value="white_box">{isVN ? 'Chữ trắng hộp đen' : 'White Box'}</option>
                  </select>
                )}
              </div>
            </div>

            {/* Phụ đề theo giọng đọc (AI nghe giọng đọc) */}
            <div className="pt-2 border-t border-slate-850">
              <button
                type="button"
                disabled={isTranscribing}
                onClick={handleTranscribeVoices}
                title={isVN
                  ? 'AI nghe giọng đọc của từng cảnh, chép lại đúng lời nói và chia dòng theo dấu câu; chữ hiện đúng lúc người đọc tới đó. Dùng khóa API như các tính năng AI khác, mỗi cảnh 1 lượt gọi. Sẽ thay thế chữ phụ đề hiện có của các cảnh có giọng đọc.'
                  : 'AI listens to each scene voice and creates timed subtitles.'}
                className="w-full text-[10px] font-black uppercase tracking-wide px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white"
              >
                {isTranscribing ? (isVN ? 'Đang tạo phụ đề...' : 'Working...') : (isVN ? 'Tạo phụ đề từ giọng đọc (AI)' : 'Subtitles from voice (AI)')}
              </button>
              {transcribeStatus && <div className="mt-1 text-[10px] text-emerald-300">{transcribeStatus}</div>}
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
                  {!bgmUrl && (
                    <div className="pt-1">
                      <div className="text-[9px] font-black uppercase text-slate-400 mb-1">
                        {isVN ? 'Hoặc tự tạo nhạc nền (miễn phí):' : 'Or generate music (free):'}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {(['none', ...MUSIC_MOODS] as const).map(m => {
                          const label: Record<string, string> = isVN
                            ? { none: 'Không', calm: 'Nhẹ nhàng', warm: 'Ấm áp', cinematic: 'Điện ảnh', upbeat: 'Sôi động' }
                            : { none: 'None', calm: 'Calm', warm: 'Warm', cinematic: 'Cinematic', upbeat: 'Upbeat' };
                          const disabled = m !== 'none' && engineKind !== 'server';
                          return (
                            <button
                              key={m}
                              type="button"
                              disabled={disabled}
                              onClick={() => setMusicMood(m)}
                              className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border transition active:scale-95 ${
                                musicMood === m
                                  ? 'bg-amber-500 text-slate-950 border-amber-400'
                                  : 'bg-slate-950 text-slate-300 border-slate-700 hover:border-slate-500'
                              } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                            >
                              {label[m]}
                            </button>
                          );
                        })}
                      </div>
                      {engineKind !== 'server' && (
                        <div className="text-[9px] text-amber-300/80 mt-1">
                          {isVN ? 'Cần bật máy dựng để tự tạo nhạc.' : 'Requires the render engine to generate music.'}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="flex items-center justify-between text-[9px] text-slate-500 font-bold">
                    <span>{isVN ? 'Nhỏ' : 'Low'}</span>
                    <span className="text-emerald-400 font-black">
                      {isVN ? '✓ Tự giảm khi có voice' : '✓ Auto Ducking'}
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
