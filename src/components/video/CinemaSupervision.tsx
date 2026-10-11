import React from 'react';
import { translate } from '../../i18n';
import { GenerationHistory, UserProfile } from '../../types';
import { EngineSelector } from '../EngineSelector';

interface CinemaSupervisionProps {
  outputLanguage: 'VN' | 'EN';
  activeTasks: GenerationHistory[];
  setActiveTasks: React.Dispatch<React.SetStateAction<GenerationHistory[]>>;
  handleSelectAllTasks: () => void;
  handleJoinVideos: () => void;
  handleRepairVideos: () => void;
  selectedTaskIds: Set<string>;
  toggleSelectTask: (id: string) => void;
  concurrentRenderCount: number;
  setConcurrentRenderCount: (count: number) => void;
  handleGenerate: () => void;
  isGenerating: boolean;
  selectedEngine: string;
  setSelectedEngine: (engine: string) => void;
  userPlan: string;
  profile: UserProfile;
  wavespeedApiKey: string;
  setWavespeedApiKey: (key: string) => void;
  isFullVideoRendering: boolean;
  editingTaskId: string | null;
  editPromptValue: string;
  setEditPromptValue: (val: string) => void;
  saveEditTask: (id: string) => void;
  startEditTask: (task: GenerationHistory) => void;
  downloadVideoFile: (url: string, id: string) => void;
  deleteTask: (id: string) => void;
}

export const CinemaSupervision: React.FC<CinemaSupervisionProps> = (props) => {
  const {
    outputLanguage, activeTasks, setActiveTasks, handleSelectAllTasks,
    handleJoinVideos, handleRepairVideos, selectedTaskIds, toggleSelectTask,
    concurrentRenderCount, setConcurrentRenderCount, handleGenerate,
    isGenerating, selectedEngine, setSelectedEngine, userPlan, profile,
    wavespeedApiKey, setWavespeedApiKey, isFullVideoRendering, editingTaskId,
    editPromptValue, setEditPromptValue, saveEditTask,
    startEditTask, downloadVideoFile, deleteTask
  } = props;

  return (
    <div className="bg-white border-2 border-slate-200 rounded-[2rem] shadow-2xl flex flex-col flex-1 border-t-[6px] border-t-blue-600 overflow-hidden relative min-h-0">
      <div className="bg-slate-900 text-white p-3 border-b border-white/5 flex flex-col gap-3 flex-shrink-0 shadow-lg">
        <div className="flex justify-between items-center">
          <div className="flex items-center space-x-2">
            <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse shadow-[0_0_8px_#3b82f6]"></span>
            <span className="text-[8px] font-serif font-black uppercase italic tracking-widest">{translate('CINEMA_SUPERVISION', outputLanguage)}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              <button onClick={handleSelectAllTasks} className="bg-white/10 hover:bg-white/20 border border-white/10 rounded-lg px-2 py-1.5 text-[8px] font-serif font-black uppercase transition italic">{translate('SELECT_ALL_VIDEOS', outputLanguage)}</button>
              <button onClick={handleJoinVideos} disabled={selectedTaskIds.size < 2} className={`rounded-lg px-2 py-1.5 text-[8px] font-serif font-black uppercase transition italic ${selectedTaskIds.size >= 2 ? 'bg-blue-600 text-white shadow-lg' : 'bg-white/5 text-white/20 cursor-not-allowed'}`}>{translate('JOIN_VIDEOS', outputLanguage)}</button>
              <button onClick={handleRepairVideos} disabled={selectedTaskIds.size === 0} className={`rounded-lg px-2 py-1.5 text-[8px] font-serif font-black uppercase transition italic ${selectedTaskIds.size > 0 ? 'bg-amber-500 text-white shadow-lg' : 'bg-white/5 text-white/20 cursor-not-allowed'}`}>{translate('REPAIR_VIDEOS', outputLanguage)}</button>
            </div>
            <div className="flex gap-1 ml-2">
              {concurrentRenderCount > 0 && (
                <button 
                  onClick={handleGenerate} 
                  disabled={isGenerating}
                  className="bg-blue-600 hover:bg-blue-700 text-white text-[8px] font-serif font-black px-3 py-1.5 rounded-lg shadow-lg transition active:scale-95 flex items-center gap-1"
                >
                  🚀 {translate('GENERATE_VIDEO', outputLanguage)}
                </button>
              )}
              <button onClick={() => setConcurrentRenderCount(3)} className={`text-[8px] font-serif font-black px-3 py-1.5 rounded-lg border transition ${concurrentRenderCount === 3 ? 'bg-indigo-500 text-white shadow-lg' : 'bg-white/5 text-white/30 border-white/10 hover:bg-white/10'}`}>3 {translate('THREADS_UNIT', outputLanguage)}</button>
              <button onClick={() => setConcurrentRenderCount(5)} className={`text-[8px] font-serif font-black px-3 py-1.5 rounded-lg border transition ${concurrentRenderCount === 5 ? 'bg-indigo-500 text-white shadow-lg' : 'bg-white/5 text-white/30 border-white/10 hover:bg-white/10'}`}>5 {translate('THREADS_UNIT', outputLanguage)}</button>
              {concurrentRenderCount > 0 && <button onClick={() => setConcurrentRenderCount(0)} className="text-[8px] font-serif font-black px-3 py-1.5 rounded-lg bg-slate-600 text-white shadow-lg italic">{translate('OFF_LABEL', outputLanguage)}</button>}
            </div>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar bg-slate-50/50 p-2 space-y-3 min-h-0">
        <div className="flex justify-between items-center px-2">
          <span className="text-[8px] font-black text-slate-400 uppercase italic tracking-widest">{translate('RENDER_RESULTS', outputLanguage)} ({activeTasks.length})</span>
          {activeTasks.length > 0 && <button onClick={() => setActiveTasks([])} className="text-[8px] font-black bg-slate-200 text-slate-500 px-3 py-1 rounded-md uppercase">{translate('DELETE_ALL', outputLanguage)}</button>}
        </div>

        {!(isGenerating || isFullVideoRendering) && (
          <div className="px-2 pt-2">
            <EngineSelector 
              selected={selectedEngine} 
              onChange={setSelectedEngine} 
              disabled={isGenerating} 
            />
            
            {selectedEngine !== 'veo' && (
              <div className="mb-4 transition-all">
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider italic">
                    {userPlan === 'pro' && (profile.plan_type === 'pro9' || (profile as any).plan === 'pro9') 
                      ? 'WaveSpeed API Key (Tùy chọn)' 
                      : 'WaveSpeed API Key (Bắt buộc)'}
                  </label>
                  <a 
                    href="https://wavespeed.ai" 
                    target="_blank" 
                    rel="noreferrer"
                    className="text-[10px] text-blue-500 hover:underline font-bold italic"
                  >
                    Lấy key miễn phí tại wavespeed.ai
                  </a>
                </div>
                <input 
                  type="password"
                  value={wavespeedApiKey}
                  onChange={(e) => setWavespeedApiKey(e.target.value)}
                  placeholder={(userPlan === 'pro' && (profile.plan_type === 'pro9' || (profile as any).plan === 'pro9'))
                    ? "Dùng key hệ thống (hoặc dán key riêng vào đây)..."
                    : "Dán WaveSpeed API Key cá nhân vào đây..."}
                  className="w-full bg-white border-2 border-slate-200 rounded-xl px-4 py-3 text-xs font-mono outline-none focus:border-indigo-400 shadow-sm"
                />
              </div>
            )}
          </div>
        )}

        {activeTasks.map((task, idx) => (
          <div key={task.id} className="p-4 border-2 rounded-[2rem] bg-white shadow-xl relative overflow-hidden border-indigo-50 group hover:border-blue-300 transition-all flex flex-col gap-2">
            <div className="flex justify-between items-center px-1">
              <div className="flex items-center gap-2">
                <span className="text-[8px] font-black text-indigo-600 italic">
                  {task.laneId ? `${translate('THREAD_STATUS', outputLanguage).toUpperCase()} ${task.laneId}` : `#${activeTasks.length - idx}`}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-[8px] font-black text-indigo-400 italic">{task.progress}%</div>
                <input type="checkbox" checked={selectedTaskIds.has(task.id)} onChange={() => toggleSelectTask(task.id)} className="w-4 h-4 rounded accent-blue-600 cursor-pointer shadow-md" />
              </div>
            </div>

            {task.status && (
              <div className={`px-1 text-[7px] font-black uppercase italic ${task.status.includes('Lỗi') || task.status.includes('Error') || task.status.includes('fail') ? 'text-red-500' : 'text-slate-400'}`}>
                {task.status}
              </div>
            )}

            <div className="px-1">
              {editingTaskId === task.id ? (
                <textarea 
                  value={editPromptValue} 
                  onChange={(e) => setEditPromptValue(e.target.value)}
                  className="w-full p-3 text-[8px] font-bold border-2 border-blue-200 rounded-2xl outline-none focus:border-blue-500 h-24 resize-none bg-blue-50/30"
                  autoFocus
                />
              ) : (
                <p className="text-[8px] font-black text-slate-800 italic uppercase tracking-tighter leading-tight line-clamp-3">
                  {task.prompt}
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2 px-1 mt-1">
              {editingTaskId === task.id ? (
                <button onClick={() => saveEditTask(task.id)} className="bg-emerald-600 text-white px-4 py-1.5 rounded-xl text-[9px] font-black uppercase shadow-lg active:scale-95 flex items-center gap-1">
                  💾 {translate('SAVE_IMG_BTN', outputLanguage)}
                </button>
              ) : (
                <button 
                  onClick={() => startEditTask(task)} 
                  disabled={!selectedTaskIds.has(task.id)}
                  className={`px-4 py-1.5 rounded-xl text-[9px] font-black uppercase shadow-lg active:scale-95 flex items-center gap-1 ${selectedTaskIds.has(task.id) ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-400'}`}
                >
                  ✏️ {translate('EDIT', outputLanguage)}
                </button>
              )}
              <button 
                onClick={() => downloadVideoFile(task.url, task.id)} 
                className={`px-4 py-1.5 rounded-xl text-[9px] font-black uppercase shadow-lg active:scale-95 flex items-center gap-1 ${task.url ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-300 cursor-not-allowed'}`}
                disabled={!task.url}
              >
                📥 {translate('SAVE_IMAGE', outputLanguage)}
              </button>
              <button onClick={() => deleteTask(task.id)} className="bg-red-500 text-white px-4 py-1.5 rounded-xl text-[9px] font-black uppercase shadow-lg active:scale-95 flex items-center gap-1">
                🗑️ {translate('DELETE', outputLanguage)}
              </button>
            </div>

            <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-blue-600 to-indigo-600 transition-all duration-1000" style={{ width: `${task.progress}%` }}></div>
            </div>

            {task.url && (
              <div className="mt-1 rounded-2xl overflow-hidden border-2 border-slate-50 shadow-inner bg-black aspect-video">
                <video src={task.url} controls playsInline className="w-full h-full" />
              </div>
            )}
          </div>
        ))}
        {activeTasks.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-slate-300 opacity-30 italic text-[10px] uppercase font-black tracking-widest">
            {(isGenerating || isFullVideoRendering) && (
              <div className="mb-8 w-full max-w-sm px-4">
                <div className="flex flex-col items-center mb-6 scale-110">
                  <span className="bg-blue-600 text-white text-[7px] font-black px-1.5 py-0.5 rounded mb-1">GOOGLE</span>
                  <span className="text-[12px] font-black text-slate-800">Veo 3.1 Fast</span>
                </div>
                
                <div className="flex items-center justify-between w-full">
                  <div className="flex flex-col items-center">
                    <span className="bg-[#2AF5FF] text-white text-[7px] font-black px-1.5 py-0.5 rounded mb-1">BYTEDANCE</span>
                    <span className="text-[10px] font-black text-slate-800">Seedance Fast</span>
                  </div>
                  
                  <div className="mx-4 text-center">
                    {translate('WAITING_COMMAND', outputLanguage)}
                  </div>

                  <div className="flex flex-col items-center">
                    <span className="bg-[#FF7752] text-white text-[7px] font-black px-1.5 py-0.5 rounded mb-1">KUAISHOU</span>
                    <span className="text-[10px] font-black text-slate-800">Kling 3.0</span>
                  </div>
                </div>
              </div>
            )}
            {!(isGenerating || isFullVideoRendering) && translate('WAITING_COMMAND', outputLanguage)}
          </div>
        )}
      </div>
    </div>
  );
};
