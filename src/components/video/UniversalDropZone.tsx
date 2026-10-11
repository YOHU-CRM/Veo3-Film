import React, { useRef, useState } from 'react';
import { Loader2, UploadCloud, X } from 'lucide-react';

interface Props {
  isVN: boolean;
  busy: boolean;
  message: string;
  onFiles: (files: File[]) => void;
  onDismissMessage: () => void;
}

/** Một ô duy nhất: kéo thả (hoặc chạm để chọn) video, ảnh, voice, nhạc, PDF/TXT kịch bản, ZIP */
export const UniversalDropZone: React.FC<Props> = ({ isVN, busy, message, onFiles, onDismissMessage }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div className="space-y-2">
      <div
        onClick={() => !busy && inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={e => {
          e.preventDefault();
          setOver(false);
          if (!busy && e.dataTransfer.files.length) onFiles(Array.from(e.dataTransfer.files));
        }}
        className={`rounded-2xl border-2 border-dashed p-5 text-center cursor-pointer transition shadow-lg ${
          over ? 'border-amber-400 bg-amber-500/10' : 'border-amber-500/40 hover:border-amber-400 bg-slate-900/90'
        } ${busy ? 'opacity-70 cursor-wait' : ''}`}
      >
        <div className="flex flex-col items-center gap-1.5">
          {busy ? <Loader2 size={28} className="animate-spin text-amber-400" /> : <UploadCloud size={28} className="text-amber-400" />}
          <div className="text-sm font-black uppercase tracking-tight text-amber-200">
            {busy
              ? (isVN ? 'Đang đọc file...' : 'Reading files...')
              : (isVN ? 'Kéo thả TẤT CẢ vào đây' : 'Drop EVERYTHING here')}
          </div>
          <div className="text-[11px] text-slate-400 font-medium max-w-xl">
            {isVN
              ? 'Video, ảnh, voice, nhạc, PDF (mỗi trang = 1 cảnh), PowerPoint / Word / Excel (đọc chữ làm kịch bản), TXT hoặc ZIP. Tự nhận diện và sắp xếp theo số trong tên file.'
              : 'Videos, images, voice, music, PDF (one page = one scene), PowerPoint / Word / Excel (text as script), TXT or ZIP.'}
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          accept="video/*,image/*,audio/*,.pdf,.pptx,.docx,.xlsx,.zip,.txt,.md,.srt"
          onChange={e => { if (e.target.files?.length) onFiles(Array.from(e.target.files)); e.target.value = ''; }}
        />
      </div>

      {message && (
        <div className="relative bg-slate-900/90 border border-slate-700 rounded-xl px-3 py-2 pr-8 text-[11px] text-slate-200 whitespace-pre-line leading-relaxed">
          {message}
          <button type="button" onClick={onDismissMessage} className="absolute top-1.5 right-1.5 text-slate-500 hover:text-slate-200">
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
};
