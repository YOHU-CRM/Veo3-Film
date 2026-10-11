import React from 'react';
import { translate } from '../../i18n';
import { UserProfile, GenerationHistory } from '@/types';
import { AspectRatio, Resolution } from '@/enums';

interface SceneToolbarProps {
  handleGenerate: () => void;
  isGenerating: boolean;
  userPlan: string;
  profile: UserProfile;
  apiKeys: string[];
  selectedEngine: string;
  wavespeedApiKey: string;
  countdown: number;
  outputLanguage: 'VN' | 'EN';
  getActivePromptsCount: () => number;
  aspectRatio: AspectRatio;
  setAspectRatio: (ratio: AspectRatio) => void;
  resolution: Resolution;
  setResolution: (res: Resolution) => void;
  handleStop: () => void;
  onOpenPricing: () => void;
}

export const SceneToolbar: React.FC<SceneToolbarProps> = (props) => {
  const {
    handleGenerate, isGenerating, userPlan, profile, apiKeys, selectedEngine,
    wavespeedApiKey, countdown, outputLanguage, getActivePromptsCount,
    aspectRatio, setAspectRatio, resolution, setResolution, handleStop,
    onOpenPricing
  } = props;

  return (
    <div className="px-6 py-4 bg-white border-t border-slate-100 flex-shrink-0">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-2">
        <div className="w-full sm:flex-[1.2] flex flex-col gap-1">
          <button 
            onClick={handleGenerate} 
            disabled={isGenerating || (userPlan === 'pro' && profile.is_active && apiKeys.length === 0) || (selectedEngine !== 'veo' && !wavespeedApiKey)} 
            className={`bg-gradient-to-r ${(userPlan === 'pro' && profile.is_active && apiKeys.length === 0) || (selectedEngine !== 'veo' && !wavespeedApiKey) ? 'from-slate-400 to-slate-500 cursor-not-allowed' : 'from-indigo-600 to-blue-700 active:scale-95'} text-white px-6 py-4 rounded-xl font-black text-[8px] shadow-lg uppercase w-full italic transition-all duration-300`}
          >
            {isGenerating 
              ? `${translate('STUDIO_RENDERING', outputLanguage)} (${countdown}s)` 
              : (userPlan === 'pro' && profile.is_active && apiKeys.length === 0) 
                ? translate('PLEASE_ENTER_PRO1_KEY', outputLanguage)
                : (selectedEngine !== 'veo' && !wavespeedApiKey)
                  ? 'VUI LÒNG NHẬP WAVESPEED KEY'
                  : translate('GENERATE', outputLanguage)}
          </button>
          <p className="text-[9px] font-bold text-slate-400 text-center uppercase italic">
            {translate('ESTIMATED', outputLanguage)}: {getActivePromptsCount()} {translate('SCENES', outputLanguage)} × 8 {translate('SECONDS', outputLanguage)} = ~{(getActivePromptsCount() * 8).toFixed(0)}s {translate('TOTAL_DURATION', outputLanguage)}
          </p>
        </div>
        <div className="w-full sm:flex-1 bg-slate-50 border-2 border-slate-100 rounded-xl p-1 flex gap-1 shadow-inner h-fit">
          {[AspectRatio.LANDSCAPE, AspectRatio.PORTRAIT, AspectRatio.SQUARE].map((ratio) => (
            <button 
              key={ratio} 
              onClick={() => setAspectRatio(ratio as AspectRatio)} 
              className={`flex-1 py-1 rounded-lg text-[8px] font-black transition ${aspectRatio === ratio ? 'bg-white text-blue-600 shadow-md border border-blue-100' : 'text-slate-400 hover:text-slate-600 uppercase italic'}`}
            >
              {ratio === AspectRatio.LANDSCAPE ? '16:9' : ratio === AspectRatio.PORTRAIT ? '9:16' : '1:1'}
            </button>
          ))}
        </div>
        <div className="flex-[0.5] bg-white border-2 border-slate-100 rounded-xl px-2 py-1 flex items-center gap-1 shadow-sm h-fit">
          <select 
            value={resolution} 
            onChange={e => setResolution(e.target.value as Resolution)} 
            className="bg-transparent text-[8px] font-black outline-none text-blue-600 uppercase w-full text-center"
          >
            <option value={Resolution.R720P}>720P</option>
            <option value={Resolution.R1080P}>1080P</option>
          </select>
        </div>
        {isGenerating ? (
          <button onClick={handleStop} className="bg-red-500 text-white px-4 py-4 rounded-xl font-black text-[8px] uppercase animate-pulse shadow-lg w-full sm:flex-1 italic h-fit">
            {translate('STOP', outputLanguage)}
          </button>
        ) : (
          <button onClick={onOpenPricing} className="bg-white text-black border-2 border-slate-200 px-4 py-4 rounded-xl font-black text-[8px] uppercase shadow-lg active:scale-95 w-full sm:flex-1 italic h-fit">
            {translate('PRICING', outputLanguage)}
          </button>
        )}
      </div>
    </div>
  );
};

interface CinemaToolbarProps {
  handleRunFullVideo: () => void;
  isGenerating: boolean;
  isFullVideoRendering: boolean;
  countdown: number;
  outputLanguage: 'VN' | 'EN';
  activeTasks: GenerationHistory[];
  selectedTaskIds: Set<string>;
  downloadVideoFile: (url: string, id: string) => void;
}

export const CinemaToolbar: React.FC<CinemaToolbarProps> = (props) => {
  const {
    handleRunFullVideo, isGenerating, isFullVideoRendering, countdown,
    outputLanguage, activeTasks, selectedTaskIds, downloadVideoFile
  } = props;

  return (
    <div className="p-3 bg-slate-900 border-t-[4px] border-t-indigo-500 shadow-2xl flex-shrink-0 flex gap-2">
      <button 
        onClick={handleRunFullVideo} 
        disabled={isGenerating} 
        className="flex-1 py-4 rounded-xl bg-indigo-400 text-white font-black text-[8px] uppercase shadow-xl active:scale-95 italic"
      >
        {isFullVideoRendering ? `${translate('STUDIO_RENDERING', outputLanguage)} (${countdown}s)` : translate('CREATE_SEAMLESS', outputLanguage)}
      </button>
      <button 
        onClick={() => { 
          const s = activeTasks.filter(t => selectedTaskIds.has(t.id) && t.url); 
          if (s.length === 0) {
            alert(translate('SELECT_VIDEO_TO_SAVE', outputLanguage));
            return;
          }
          s.forEach((t, i) => setTimeout(() => downloadVideoFile(t.url, `cinema_${t.id}`), i*1000)); 
        }} 
        className="flex-1 py-4 rounded-xl bg-indigo-700 text-white font-black text-[8px] uppercase shadow-xl active:scale-95 italic flex items-center justify-center gap-2"
      >
        <span>{translate('SAVE_TO_DEVICE', outputLanguage)}</span>
        {selectedTaskIds.size > 0 && <span className="bg-white text-indigo-700 px-1.5 py-0.5 rounded-md text-[8px]">{selectedTaskIds.size}</span>}
      </button>
    </div>
  );
};
