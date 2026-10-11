
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { GenerationHistory, BatchResult, UserProfile } from '@/types';
import { VideoMode, AspectRatio, Resolution } from '@/enums';
import { ToolMode } from './types.video';
import { translate } from '@/i18n';
import { 
  IMAGE_GEN_INSTRUCTION,
  SEAMLESS_FLOW_INSTRUCTION,
  STORY_DNA_INSTRUCTION
} from '@/constants';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { getStoredBatchResults, saveStoredBatchResults, getModePrompts, saveModePrompts, getModeImages, saveModeImages } from '@/services/storageService';
import { generateGeminiText, generateGeminiImage } from '@/services/gemini';
import { runGenerationTask, requestVideoGeneration } from '@/services/videoService';

export function useVideoState(props: {
  credit: number,
  email: string,
  userPlan: string,
  profile: UserProfile,
  apiKeys: string[],
  hasApiKey: boolean,
  outputLanguage: 'VN' | 'EN',
  onKeyError: () => void,
  onOpenPricing: () => void,
  onOpenKeyPicker: () => void,
  onRefreshCredits: () => Promise<void>,
  setOutputLanguage: (lang: 'VN' | 'EN') => void
}) {
  const { 
    credit, userPlan, profile, apiKeys, 
    outputLanguage, onOpenPricing, 
    onRefreshCredits
  } = props;

  // --- Core State ---
  const [mode, setMode] = useState<VideoMode>(VideoMode.TEXT_TO_VIDEO);
  const [toolMode, setToolMode] = useState<ToolMode>(ToolMode.NONE);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(AspectRatio.LANDSCAPE);
  const [resolution, setResolution] = useState<Resolution>(Resolution.R720P);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isFullVideoRendering, setIsFullVideoRendering] = useState(false);
  const [generatingTool, setGeneratingTool] = useState<ToolMode | 'BATCH' | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [activeTasks, setActiveTasks] = useState<GenerationHistory[]>([]);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [selectedPrompts, setSelectedPrompts] = useState<Set<number>>(new Set());
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editPromptValue, setEditPromptValue] = useState("");
  const [showZaloQR, setShowZaloQR] = useState(false);
  const [showZaloGroupQR, setShowZaloGroupQR] = useState(false);

  // --- Prompts & Images ---
  const [modePrompts, setModePrompts] = useState<Record<VideoMode, string>>(() => getModePrompts());
  const [modeImages, setModeImages] = useState<Record<VideoMode, {url: string, name: string}[]>>(() => getModeImages());
  const currentPromptText = modePrompts[mode] || "";
  const currentImages = modeImages[mode] || [];

  // --- Batch Tool State ---
  const [batchResults, setBatchResults] = useState<BatchResult[]>(() => getStoredBatchResults());
  const [refImage, setRefImage] = useState<string | null>(null);
  const [scenePrompts, setScenePrompts] = useState("");
  const [characterPrompts, setCharacterPrompts] = useState("");
  const [editingBatchIdx, setEditingBatchIdx] = useState<number | null>(null);
  const [editingBatchPrompt, setEditingBatchPrompt] = useState("");

  // --- Tool Forms ---
  const [toolPromptCount, setToolPromptCount] = useState("5");
  const [linkTopic, setLinkTopic] = useState("");
  const [storyCount, setStoryCount] = useState(3);
  const [maleCount, setMaleCount] = useState(1);
  const [femaleCount, setFemaleCount] = useState(1);
  const [selectedGenre, setSelectedGenre] = useState({ id: 'action', name: { VN: 'Hành động', EN: 'Action' } });
  const [selectedStyle, setSelectedStyle] = useState({ id: 'cinematic', name: { VN: 'Điện ảnh', EN: 'Cinematic' } });
  const [directorScript, setDirectorScript] = useState("");
  const [analyzedScript, setAnalyzedScript] = useState("");
  const [seamlessScript, setSeamlessScript] = useState("");
  const [directorForm, setDirectorForm] = useState({ plot: "", dna: "", environment: "" });
  const [seamlessForm, setSeamlessForm] = useState({ plot: "", dna: "", environment: "" });

  // --- Mode State ---
  const [concurrentRenderCount, setConcurrentRenderCount] = useState(0);
  const [concurrentPrompts, setConcurrentPrompts] = useState<string[]>(Array(10).fill(""));

  // --- WaveSpeed ---
  const [selectedEngine, setSelectedEngine] = useState('veo');
  const [wavespeedApiKey, setWavespeedApiKey] = useState(() => localStorage.getItem('wavespeedApiKey') || '');

  // --- Refs ---
  const countdownRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const refImageInputRef = useRef<HTMLInputElement>(null);
  const specificSlotRef = useRef<{index: number, subIndex?: number} | null>(null);

  // --- Derived State ---
  const effectiveWavespeedKey = useMemo(() => {
    const isPro9 = (profile.plan_type === 'pro9' || (profile as any).plan === 'pro9');
    if (wavespeedApiKey) return wavespeedApiKey;
    if (isPro9) return (import.meta.env.VITE_WAVESPEED_API_KEY as string) || '';
    return '';
  }, [wavespeedApiKey, profile]);

  // --- Effects ---
  useEffect(() => {
    localStorage.setItem('wavespeedApiKey', wavespeedApiKey);
  }, [wavespeedApiKey]);

  useEffect(() => {
    saveModePrompts(modePrompts);
  }, [modePrompts]);

  useEffect(() => {
    saveModeImages(modeImages);
  }, [modeImages]);

  useEffect(() => {
    saveStoredBatchResults(batchResults);
  }, [batchResults]);

  // --- Utility Functions ---
  const startCountdown = useCallback((duration: number = 300) => {
    setCountdown(duration);
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(countdownRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const stopCountdown = useCallback(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    setCountdown(0);
  }, []);

  const handleStop = useCallback(() => {
    setIsGenerating(false);
    setIsFullVideoRendering(false);
    setGeneratingTool(null);
    stopCountdown();
    alert(translate('SYSTEM_STOPPED', outputLanguage));
  }, [outputLanguage, stopCountdown]);

  const updatePromptForMode = useCallback((newText: string) => {
    setModePrompts(prev => ({ ...prev, [mode]: newText }));
  }, [mode]);

  const getActivePromptsFromSource = useCallback(() => {
    if (concurrentRenderCount > 0) {
      return concurrentPrompts.slice(0, concurrentRenderCount).filter(p => p.trim());
    }
    const lines = currentPromptText.split('\n').filter(l => l.trim());
    if (selectedPrompts.size > 0) {
      return lines.filter((_, i) => selectedPrompts.has(i));
    }
    return lines;
  }, [concurrentRenderCount, concurrentPrompts, currentPromptText, selectedPrompts]);

  const validateAndPrepareGeneration = useCallback(() => {
    const activePrompts = getActivePromptsFromSource();
    if (activePrompts.length === 0) {
      alert(translate('ENTER_PROMPTS_ERROR', outputLanguage));
      return null;
    }

    const isWaveSpeed = selectedEngine !== 'veo';
    const isPro1 = (profile.plan_type === 'pro1' || (profile as any).plan === 'pro1');
    const isPro9 = (profile.plan_type === 'pro9' || (profile as any).plan === 'pro9');

    const requiredCredits = activePrompts.length * 3;
    if (credit < requiredCredits && !isPro1 && !isPro9) {
      alert(translate('INSUFFICIENT_CREDITS', outputLanguage));
      onOpenPricing();
      return null;
    }

    if (isWaveSpeed) {
      if (userPlan === 'free') {
        alert("Gói FREE không dùng được Seedance/Kling. Vui lòng Nâng cấp PRO1.");
        onOpenPricing();
        return null;
      }
      if (isPro1 && !wavespeedApiKey) {
        alert("Gói PRO1 bắt buộc nhập WaveSpeed key cá nhân.");
        return null;
      }
      if (!effectiveWavespeedKey) {
        alert("Vui lòng nhập WaveSpeed API Key.");
        return null;
      }
    } else {
      if (isPro1 && apiKeys.length === 0) {
        alert(translate('PLEASE_ENTER_PRO1_KEY', outputLanguage));
        return null;
      }
    }

    return { activePrompts, apiKeyToUse: isWaveSpeed ? effectiveWavespeedKey : undefined };
  }, [getActivePromptsFromSource, outputLanguage, selectedEngine, profile, credit, onOpenPricing, userPlan, wavespeedApiKey, effectiveWavespeedKey, apiKeys.length]);

  // --- Handlers ---
  const handleGenerate = async () => {
    const prep = validateAndPrepareGeneration();
    if (!prep) return;
    const { activePrompts, apiKeyToUse } = prep;

    setIsGenerating(true);
    startCountdown(activePrompts.length * 60);

    const initialTasks: GenerationHistory[] = activePrompts.map((p, idx) => ({
      id: `${Date.now()}-${idx}`,
      prompt: p,
      url: "",
      progress: 0,
      status: translate('PROGRESS_INIT', outputLanguage),
      mode,
      timestamp: Date.now(),
      laneId: concurrentRenderCount > 0 ? (idx + 1).toString() : undefined
    }));
    setActiveTasks(prev => [...initialTasks, ...prev]);

    try {
      await Promise.all(activePrompts.map(async (p, idx) => {
        const taskId = initialTasks[idx].id;
        const result = await runGenerationTask({
          prompt: p,
          mode,
          aspectRatio,
          resolution,
          image: mode === VideoMode.IMAGE_TO_VIDEO ? currentImages[idx]?.url : undefined,
          imageStart: mode === VideoMode.INTERPOLATION ? currentImages[idx * 2]?.url : undefined,
          imageEnd: mode === VideoMode.INTERPOLATION ? currentImages[idx * 2 + 1]?.url : undefined,
          consistencyImages: mode === VideoMode.CONSISTENCY ? currentImages.map(img => img.url) : [],
          apiKey: apiKeyToUse,
          engine: selectedEngine,
          onProgress: (prog, stat) => {
            setActiveTasks(prev => prev.map(t => t.id === taskId ? { ...t, progress: prog, status: stat || t.status } : t));
          }
        });

        if (result.url) {
          setActiveTasks(prev => prev.map(t => t.id === taskId ? { ...t, url: result.url, progress: 100, status: translate('COMPLETED_STATUS', outputLanguage) } : t));
        } else {
          setActiveTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: `${translate('ERROR_STATUS', outputLanguage)}: ${result.error}`, progress: 0 } : t));
        }
      }));
    } catch (err) {
      console.error("Batch Gen Error:", err);
    } finally {
      setIsGenerating(false);
      stopCountdown();
      onRefreshCredits();
    }
  };

  const handleRunFullVideo = async () => {
    const activePrompts = getActivePromptsFromSource();
    if (activePrompts.length === 0) {
      alert(translate('ENTER_PROMPTS_ERROR', outputLanguage));
      return;
    }

    const isWaveSpeed = selectedEngine !== 'veo';
    const isPro1 = (profile.plan_type === 'pro1' || (profile as any).plan === 'pro1');

    if (isWaveSpeed) {
      if (userPlan === 'free') {
        alert("Gói FREE không dùng được Seedance/Kling. Vui lòng Nâng cấp PRO1.");
        onOpenPricing();
        return;
      }
      if (isPro1 && !wavespeedApiKey) {
        alert("Gói PRO1 bắt buộc nhập WaveSpeed key cá nhân.");
        return;
      }
      if (!effectiveWavespeedKey) {
        alert("Vui lòng nhập WaveSpeed API Key.");
        return;
      }
    }

    setIsFullVideoRendering(true);
    startCountdown(activePrompts.length * 120);

    const taskId = `${Date.now()}-full`;
    const newTask: GenerationHistory = {
      id: taskId,
      prompt: `[FULL VIDEO] ${activePrompts[0].substring(0, 50)}...`,
      url: "",
      progress: 0,
      status: translate('PROGRESS_INIT', outputLanguage),
      mode,
      timestamp: Date.now()
    };
    setActiveTasks(prev => [newTask, ...prev]);

    try {
      const result = await requestVideoGeneration({
        prompts: activePrompts,
        aspectRatio,
        resolution,
        apiKey: isWaveSpeed ? effectiveWavespeedKey : undefined,
        engine: selectedEngine,
        onProgress: (prog, stat) => {
          setActiveTasks(prev => prev.map(t => t.id === taskId ? { ...t, progress: prog, status: stat } : t));
        }
      });

      if (result.url) {
        setActiveTasks(prev => prev.map(t => t.id === taskId ? { ...t, url: result.url, progress: 100, status: translate('COMPLETED_STATUS', outputLanguage) } : t));
      } else {
        setActiveTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: `${translate('ERROR_STATUS', outputLanguage)}: ${result.error}`, progress: 0 } : t));
      }
    } catch (err: any) {
      setActiveTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: err.message, progress: 0 } : t));
    } finally {
      setIsFullVideoRendering(false);
      stopCountdown();
      onRefreshCredits();
    }
  };

  // ... (Other handlers like handleToolGenerate, handleBatchImageGen etc. should be added here)
  // For brevity, I'll add the remaining key functions in the next step or keep them in VideoGenerator if they are too tied to UI.
  // Actually, I should add as many as possible to keep VideoGenerator small.

  const toggleSelectPrompt = useCallback((idx: number) => {
    setSelectedPrompts(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const handleSelectAllPrompts = useCallback(() => {
    const lines = currentPromptText.split('\n').filter(p => p.trim());
    if (selectedPrompts.size === lines.length && lines.length > 0) {
      setSelectedPrompts(new Set());
    } else {
      setSelectedPrompts(new Set(lines.map((_, i) => i)));
    }
  }, [currentPromptText, selectedPrompts.size]);

  const handleDeleteSelectedPrompts = useCallback(() => {
    const lines = currentPromptText.split('\n');
    const next = lines.filter((_, i) => !selectedPrompts.has(i));
    updatePromptForMode(next.join('\n'));
    setSelectedPrompts(new Set());
  }, [currentPromptText, selectedPrompts, updatePromptForMode]);

  const toggleSelectTask = useCallback((id: string) => {
    setSelectedTaskIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSelectAllTasks = useCallback(() => {
    if (selectedTaskIds.size === activeTasks.length && activeTasks.length > 0) {
      setSelectedTaskIds(new Set());
    } else {
      setSelectedTaskIds(new Set(activeTasks.map(t => t.id)));
    }
  }, [activeTasks, selectedTaskIds.size]);

  const deleteTask = useCallback((id: string) => {
    setActiveTasks(prev => prev.filter(t => t.id !== id));
    setSelectedTaskIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const startEditTask = useCallback((task: GenerationHistory) => {
    setEditingTaskId(task.id);
    setEditPromptValue(task.prompt);
  }, []);

  const saveEditTask = useCallback((id: string) => {
    if (!editPromptValue.trim()) return;
    setActiveTasks(prev => prev.map(t => t.id === id ? { ...t, prompt: editPromptValue } : t));
    setEditingTaskId(null);
    setEditPromptValue("");
  }, [editPromptValue]);

  const downloadVideoFile = useCallback(async (url: string, id: string) => {
    if (!url) return;
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const filename = `video_${id}_${Date.now()}.mp4`;
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    } catch (err) {
      console.error("Download error:", err);
      window.open(url, '_blank');
    }
  }, []);

  const downloadImageFile = useCallback(async (url: string, name: string) => {
    if (!url) return;
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const filename = `image_${name}_${Date.now()}.png`;
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    } catch {
      window.open(url, '_blank');
    }
  }, []);

  const handleJoinVideos = useCallback(async () => {
    // Logic for joining videos (placeholder or actual implementation if available)
    alert("Tính năng nối video đang được phát triển.");
  }, []);

  const handleRepairVideos = useCallback(async () => {
     // Logic for repairing videos (re-running failed ones)
    alert("Tính năng sửa video lỗi đang được phát triển.");
  }, []);

  const handleRefImageChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => setRefImage(event.target?.result as string);
      reader.readAsDataURL(file);
    }
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    
    if (specificSlotRef.current) {
      const { index } = specificSlotRef.current;
      const file = files[0];
      const reader = new FileReader();
      reader.onload = (event) => {
        const url = event.target?.result as string;
        setModeImages(prev => {
          const current = [...(prev[mode] || [])];
          current[index] = { url, name: file.name };
          return { ...prev, [mode]: current };
        });
      };
      reader.readAsDataURL(file);
      specificSlotRef.current = null;
      return;
    }

    const newImages: {url: string, name: string}[] = [];
    let processed = 0;
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = (event) => {
        newImages.push({ url: event.target?.result as string, name: file.name });
        processed++;
        if (processed === files.length) {
          setModeImages(prev => ({ ...prev, [mode]: [...(prev[mode] || []), ...newImages] }));
        }
      };
      reader.readAsDataURL(file);
    });
  }, [mode, specificSlotRef]);

  const handleBatchImageGen = useCallback(async () => {
    const lines = scenePrompts.split('\n').filter(p => p.trim());
    if (lines.length === 0) return;
    setIsGenerating(true);
    setGeneratingTool('BATCH');
    const results: BatchResult[] = lines.map(p => ({
      prompt: p, url: "", progress: 0, timestamp: Date.now(), selected: true
    }));
    setBatchResults(results);
    try {
      await Promise.all(results.map(async (res, idx) => {
        try {
          const url = await generateGeminiImage(res.prompt);
          setBatchResults(prev => prev.map((r, i) => i === idx ? { ...r, url, progress: 100 } : r));
        } catch (err: any) {
          setBatchResults(prev => prev.map((r, i) => i === idx ? { ...r, error: err.message, progress: 0 } : r));
        }
      }));
    } finally {
      setIsGenerating(false);
      setGeneratingTool(null);
    }
  }, [scenePrompts]);

  const handleToolGenerate = useCallback(async (tMode: ToolMode) => {
    const promptMap: Record<ToolMode, string> = {
      [ToolMode.STORY_DNA]: STORY_DNA_INSTRUCTION,
      [ToolMode.SEAMLESS_FLOW]: SEAMLESS_FLOW_INSTRUCTION,
      [ToolMode.IMAGE_GEN]: IMAGE_GEN_INSTRUCTION,
      [ToolMode.BATCH_IMAGE_GEN]: IMAGE_GEN_INSTRUCTION,
      [ToolMode.AUTO_VIDEO]: "",
      [ToolMode.NONE]: ""
    };
    const instruction = promptMap[tMode];
    if (!instruction) return;

    setIsGenerating(true);
    setGeneratingTool(tMode);
    try {
      const text = await generateGeminiText(instruction + "\n\nTopic: " + linkTopic);
      if (tMode === ToolMode.SEAMLESS_FLOW) setSeamlessScript(text);
      else if (tMode === ToolMode.STORY_DNA) setAnalyzedScript(text);
    } catch (err) {
      console.error("Tool Gen Error:", err);
    } finally {
      setIsGenerating(false);
      setGeneratingTool(null);
    }
  }, [linkTopic]);

  const handleRegenerateSelectedBatchImages = useCallback(async () => {
    const selectedIndices = batchResults.map((r, i) => r.selected ? i : -1).filter(i => i !== -1);
    if (selectedIndices.length === 0) return;
    setIsGenerating(true);
    try {
      await Promise.all(selectedIndices.map(async (idx) => {
        const res = batchResults[idx];
        setBatchResults(prev => prev.map((r, i) => i === idx ? { ...r, progress: 50, error: undefined } : r));
        try {
          const url = await generateGeminiImage(res.prompt);
          setBatchResults(prev => prev.map((r, i) => i === idx ? { ...r, url, progress: 100 } : r));
        } catch (err: any) {
          setBatchResults(prev => prev.map((r, i) => i === idx ? { ...r, error: err.message, progress: 0 } : r));
        }
      }));
    } finally {
      setIsGenerating(false);
    }
  }, [batchResults]);

  const handleDownloadBatchZip = useCallback(async () => {
    const valid = batchResults.filter(r => r.url);
    if (valid.length === 0) return;
    const zip = new JSZip();
    await Promise.all(valid.map(async (res, idx) => {
      const resp = await fetch(res.url);
      const blob = await resp.blob();
      zip.file(`scene_${idx + 1}.png`, blob);
    }));
    const content = await zip.generateAsync({ type: 'blob' });
    saveAs(content, `batch_images_${Date.now()}.zip`);
  }, [batchResults]);

  const handleRegenerateBatchImage = useCallback(async (idx: number, prompt: string) => {
    setIsGenerating(true);
    try {
      const url = await generateGeminiImage(prompt);
      setBatchResults(prev => prev.map((r, i) => i === idx ? { ...r, url, prompt, progress: 100, error: undefined } : r));
    } catch (err: any) {
      setBatchResults(prev => prev.map((r, i) => i === idx ? { ...r, error: err.message } : r));
    } finally {
      setIsGenerating(false);
    }
  }, []);

  return {
    mode, setMode, toolMode, setToolMode, aspectRatio, setAspectRatio,
    resolution, setResolution, isGenerating, isFullVideoRendering,
    generatingTool, setGeneratingTool, countdown, activeTasks, setActiveTasks,
    selectedTaskIds, setSelectedTaskIds, selectedPrompts, setSelectedPrompts,
    editingTaskId, setEditingTaskId, editPromptValue, setEditPromptValue,
    showZaloQR, setShowZaloQR, showZaloGroupQR, setShowZaloGroupQR,
    currentPromptText, currentImages, modePrompts, setModePrompts,
    modeImages, setModeImages, batchResults, setBatchResults,
    refImage, setRefImage, scenePrompts, setScenePrompts,
    characterPrompts, setCharacterPrompts, editingBatchIdx, setEditingBatchIdx,
    editingBatchPrompt, setEditingBatchPrompt, toolPromptCount, setToolPromptCount,
    linkTopic, setLinkTopic, storyCount, setStoryCount, maleCount, setMaleCount,
    femaleCount, setFemaleCount, selectedGenre, setSelectedGenre,
    selectedStyle, setSelectedStyle, directorScript, setDirectorScript,
    analyzedScript, setAnalyzedScript, seamlessScript, setSeamlessScript,
    directorForm, setDirectorForm, seamlessForm, setSeamlessForm,
    concurrentRenderCount, setConcurrentRenderCount, concurrentPrompts, setConcurrentPrompts,
    selectedEngine, setSelectedEngine, wavespeedApiKey, setWavespeedApiKey,
    effectiveWavespeedKey, fileInputRef, refImageInputRef, specificSlotRef,
    handleStop, startCountdown, stopCountdown, updatePromptForMode,
    getActivePromptsFromSource, validateAndPrepareGeneration,
    handleGenerate, handleRunFullVideo, toggleSelectPrompt,
    handleSelectAllPrompts, handleDeleteSelectedPrompts, toggleSelectTask,
    handleSelectAllTasks, deleteTask, startEditTask, saveEditTask,
    downloadVideoFile, downloadImageFile, handleJoinVideos, handleRepairVideos,
    handleRefImageChange, handleFileChange, handleBatchImageGen, handleToolGenerate,
    handleRegenerateSelectedBatchImages, handleDownloadBatchZip, handleRegenerateBatchImage
  };
}
