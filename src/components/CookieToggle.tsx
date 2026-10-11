import React, { useState } from 'react';
import { Eye, EyeOff, Key, Shield, HelpCircle, AlertCircle, Copy, Check } from 'lucide-react';

interface CookieToggleProps {
  useCookieMode: boolean;
  onToggle: (v: boolean) => void;
  cookieString: string;
  onCookieChange: (s: string) => void;
  outputLanguage: 'EN' | 'VN';
}

export const CookieToggle: React.FC<CookieToggleProps> = ({
  useCookieMode,
  onToggle,
  cookieString,
  onCookieChange,
  outputLanguage
}) => {
  const [showCookie, setShowCookie] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopyInstruction = () => {
    const code = `document.cookie`;
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const hasValidCookie = cookieString && cookieString.trim().length > 50;

  return (
    <div className="mb-4 bg-slate-900 border border-slate-800 text-slate-200 rounded-xl p-4 shadow-xl transition-all duration-300">
      <div className={`flex items-center justify-between transition-all duration-300 ${
        useCookieMode ? 'mb-4 border-b border-slate-800 pb-3' : ''
      }`}>
        <div className="flex items-center space-x-2">
          <Shield className={`w-4 h-4 transition-colors duration-300 ${useCookieMode ? 'text-emerald-400' : 'text-slate-500'}`} />
          <div>
            <span className="text-xs font-black tracking-wider uppercase italic block text-slate-50 font-mono">
              {outputLanguage === 'VN' ? '🍪 Chế độ Cookie Veo' : '🍪 Veo Cookie Mode'}
            </span>
            <span className="text-[9px] text-slate-400 font-medium font-sans">
              {outputLanguage === 'VN' 
                ? 'Sử dụng cookie AI Studio cá nhân' 
                : 'Utilize personal AI Studio session cookie'}
            </span>
          </div>
        </div>
        
        {/* Toggle Switch */}
        <button
          onClick={() => onToggle(!useCookieMode)}
          className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
            useCookieMode ? 'bg-indigo-600' : 'bg-slate-700'
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${
              useCookieMode ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {useCookieMode && (
        <div className="space-y-4 animate-fade-in duration-300">
          {/* Warning/Error message if cookie is empty but toggled */}
          {!hasValidCookie && (
            <div className="bg-indigo-950/40 border border-indigo-900/40 rounded-lg p-2.5 flex items-start space-x-2">
              <AlertCircle className="w-4.5 h-4.5 text-indigo-400 shrink-0 mt-0.5" />
              <span className="text-[10px] text-indigo-300 font-medium">
                {outputLanguage === 'VN' 
                  ? 'Vui lòng dán chuỗi Cookie hợp lệ bên dưới để kích hoạt chế độ này.' 
                  : 'Please paste a valid Cookie string below to activate this mode.'}
              </span>
            </div>
          )}

          {/* Cookie Input Section */}
          <div className="space-y-2">
            <div className="flex justify-between items-center text-[10px] font-bold text-slate-400 uppercase tracking-wider italic">
              <span className="flex items-center space-x-1">
                <Key className="w-3 h-3 text-indigo-400" />
                <span>{outputLanguage === 'VN' ? 'Chuỗi Cookie AI Studio' : 'AI Studio Cookie String'}</span>
              </span>
              <button
                onClick={() => setShowInstructions(!showInstructions)}
                className="text-indigo-400 hover:text-indigo-300 transition flex items-center space-x-0.5"
              >
                <HelpCircle className="w-3.5 h-3.5" />
                <span>{outputLanguage === 'VN' ? 'Hướng dẫn' : 'Instructions'}</span>
              </button>
            </div>

            <div className="relative">
              <input
                type={showCookie ? 'text' : 'password'}
                value={cookieString}
                onChange={(e) => onCookieChange(e.target.value)}
                placeholder={
                  outputLanguage === 'VN'
                    ? 'Dán chuỗi cookie (bắt đầu bằng __Secure-hoặc tương đương)...'
                    : 'Paste cookie string (starts with __Secure- or equivalent)...'
                }
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-100 placeholder-slate-700 outline-none focus:border-indigo-500 shadow-inner pr-10"
              />
              <button
                type="button"
                onClick={() => setShowCookie(!showCookie)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition"
              >
                {showCookie ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Instructions Modal/Section */}
          {showInstructions && (
            <div className="p-3 bg-slate-950 border border-slate-800 rounded-lg text-[10.5px] text-slate-300 space-y-2 leading-relaxed animate-fade-in">
              <p className="font-bold text-indigo-400 border-b border-slate-800 pb-1 flex items-center">
                <span>{outputLanguage === 'VN' ? '💡 CÁCH LẤY COOKIE GOOGLE AI STUDIO' : '💡 HOW TO GET GOOGLE AI STUDIO COOKIE'}</span>
              </p>
              
              <ol className="list-decimal pl-4 space-y-1 text-[10px]">
                {outputLanguage === 'VN' ? (
                  <>
                    <li>Truy cập <a href="https://aistudio.google.com" target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">Google AI Studio</a> và đăng nhập.</li>
                    <li>Nhấn phím <kbd className="px-1 bg-slate-850 rounded text-slate-200">F12</kbd> (hoặc chuột phải chọn Inspect) &rarr; Chuyển sang thẻ <span className="font-bold text-slate-100">Network</span> (Mạng).</li>
                    <li>Tạo một prompt hoặc click bất kỳ request API nào (ví dụ: `listKeys`, `predict`...).</li>
                    <li>Tìm mục <span className="font-bold text-slate-100">Request Headers</span>, copy toàn bộ chuỗi nằm sau chữ <span className="text-amber-400 font-bold">cookie:</span> và dán vào ô bên trên.</li>
                  </>
                ) : (
                  <>
                    <li>Visit <a href="https://aistudio.google.com" target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">Google AI Studio</a> and sign in.</li>
                    <li>Press <kbd className="px-1 bg-slate-850 rounded text-slate-200">F12</kbd> &rarr; Navigate to the <span className="font-bold text-slate-100">Network</span> tab.</li>
                    <li>Trigger any request (e.g. submit a prompt or refresh, click API action).</li>
                    <li>Find <span className="font-bold text-slate-100">Request Headers</span>, copy the entire string after <span className="text-amber-400 font-bold">cookie:</span> and paste it above.</li>
                  </>
                )}
              </ol>

              <div className="pt-2 flex justify-between items-center border-t border-slate-800">
                <span className="text-[9px] text-slate-400">
                  {outputLanguage === 'VN' 
                    ? '💡 Mẹo nhanh: Gõ `document.cookie` trong tab Console để copy nhanh.' 
                    : '💡 Fast tip: Type `document.cookie` in Console to extract it.'}
                </span>
                <button
                  onClick={handleCopyInstruction}
                  className="flex items-center space-x-1 text-[9.5px] px-2 py-1 bg-slate-850 hover:bg-slate-800 text-slate-300 hover:text-white rounded transition border border-slate-750"
                >
                  {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>{copied ? 'Copied' : 'Copy string'}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
