
import React, { useState } from 'react';
import { SUBSCRIPTION_PLANS, SYSTEM_PRO_KEYS } from '../constants';
import { SubscriptionPlan, UserProfile } from '../types';

import { translate } from '../i18n';

interface PricingProps {
  onClose?: () => void;
  onUpdateProfile: (profile: UserProfile) => void;
  currentProfile: UserProfile;
  outputLanguage: 'EN' | 'VN';
}

export const Pricing: React.FC<PricingProps> = ({ onClose, onUpdateProfile, currentProfile, outputLanguage }) => {
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionPlan | null>(null);
  const [showPaymentWindow, setShowPaymentWindow] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);

  const handleSelectPlan = (plan: SubscriptionPlan) => {
    setSelectedPlan(plan);
    if (plan.id === 'free_unlimited') {
      if (window.aistudio?.openSelectKey) {
        window.aistudio.openSelectKey().then(() => {
          handleConfirmActivation(plan);
        });
      } else {
        alert(translate('API_KEY_REQUIRED_ALERT', outputLanguage));
      }
    } else {
      setShowPaymentWindow(true);
    }
  };

  const handleConfirmActivation = (planOverride?: SubscriptionPlan) => {
    const plan = planOverride || selectedPlan;
    if (!plan) return;

    setIsVerifying(true);
    setTimeout(() => {
      if (plan.id === 'pro_1') {
        sessionStorage.setItem('veopro_custom_key', SYSTEM_PRO_KEYS.PRO1);
      } else if (plan.id === 'pro_9') {
        sessionStorage.setItem('veopro_custom_key', SYSTEM_PRO_KEYS.PRO9);
      }

      const newProfile: UserProfile = {
        ...currentProfile,
        accountType: translate(plan.name as any, outputLanguage),
        expiryDate: plan.duration === 'FREE_DURATION' ? translate('FREE_DURATION', outputLanguage) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString(outputLanguage === 'VN' ? 'vi-VN' : 'en-US'),
        limitText: translate(plan.videoLimitText as any, outputLanguage),
        licenseInfo: `Bản quyền: YOHU-PRO Studio. Gói: ${translate(plan.name as any, outputLanguage)}`
      };

      onUpdateProfile(newProfile);
      setIsVerifying(false);
      setShowPaymentWindow(false);
      alert(translate('ACTIVATION_SUCCESS', outputLanguage, { name: translate(plan.name as any, outputLanguage), id: currentProfile.machineId }));
      if (onClose) onClose();
    }, 2000);
  };

  return (
    <div className="fixed inset-0 bg-slate-950/95 backdrop-blur-2xl flex items-center justify-center z-[100] p-2 animate-in fade-in duration-500">
      <div className="bg-white rounded-[2rem] shadow-[0_0_100px_rgba(0,0,0,0.6)] w-full max-w-6xl overflow-hidden flex flex-col border-4 border-slate-100 max-h-[95vh]">
        
        {/* Header - Font nhỏ hơn */}
        <div className="bg-[#0f172a] text-white px-8 py-4 flex items-center justify-between border-b border-white/5 flex-shrink-0">
          <div className="flex items-center space-x-4">
            <div className="w-4 h-4 bg-emerald-400 rounded-full animate-pulse shadow-[0_0_15px_rgba(52,211,153,0.8)]"></div>
            <div className="flex flex-col">
              <span className="text-[8px] font-black uppercase tracking-[0.3em] text-emerald-400 italic">{translate('COPYRIGHT_CENTER', outputLanguage)}</span>
              <span className="text-[9px] text-white/40 font-bold uppercase tracking-[0.4em] italic">{translate('AI_CINEMA_SYSTEM', outputLanguage)} • ID: {currentProfile.machineId}</span>
            </div>
          </div>
          <button onClick={onClose} className="hover:bg-red-600 hover:text-white text-slate-400 w-10 h-10 rounded-full flex items-center justify-center transition-all font-black text-xl shadow-inner active:scale-90">✕</button>
        </div>

        <div className="p-8 overflow-y-auto flex flex-col items-center flex-1 bg-slate-50/30 custom-scrollbar">
          <h2 className="text-2xl font-black text-slate-900 mb-2 tracking-tighter uppercase italic text-center">{translate('PRICING_TITLE', outputLanguage)}</h2>
          <p className="text-slate-400 font-bold text-[7px] mb-8 uppercase tracking-[0.6em] text-center italic">{translate('PRICING_SUBTITLE', outputLanguage)}</p>

          {/* Grid các gói - Chữ nhỏ hơn, hiển thị toàn bộ */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full max-w-5xl mb-6">
            {SUBSCRIPTION_PLANS.map((plan) => (
              <div 
                key={plan.id} 
                className={`bg-white rounded-[2rem] border-2 flex flex-col items-center p-6 transition-all duration-500 group cursor-pointer relative ${selectedPlan?.id === plan.id ? 'border-emerald-500 shadow-2xl scale-105' : 'border-slate-100 hover:border-indigo-200'}`}
                onClick={() => setSelectedPlan(plan)}
              >
                {currentProfile.accountType === translate(plan.name as any, outputLanguage) && (
                   <div className="absolute -top-3 bg-indigo-600 text-white px-4 py-1 rounded-full text-[8px] font-black uppercase shadow-lg z-10 tracking-[0.2em] italic">{translate('CURRENT_PLAN', outputLanguage)}</div>
                )}
                
                <h3 className="text-sm font-black text-slate-800 mb-6 uppercase tracking-tight text-center italic">{translate(plan.name as any, outputLanguage)}</h3>
                
                <div className="w-full space-y-2 mb-6">
                  <div className="bg-slate-50 py-2 px-3 rounded-xl text-center border border-slate-200">
                    <span className="text-[8px] font-bold text-slate-700 uppercase">{translate('DURATION_LABEL', outputLanguage)}: {translate(plan.duration as any, outputLanguage)}</span>
                  </div>
                  <div className="bg-slate-900 py-2.5 px-3 rounded-xl text-center shadow-sm">
                    <span className="text-[9px] font-black text-white uppercase tracking-tight">{translate(plan.videoLimitText as any, outputLanguage)}</span>
                  </div>
                  <div className="bg-slate-50 py-2 px-3 rounded-xl text-center border border-slate-200">
                    <span className="text-[8px] font-bold text-slate-600 uppercase">⚡ {plan.concurrentLimit} {translate('RENDER_THREADS_LABEL', outputLanguage)}</span>
                  </div>
                  <div className="bg-slate-50 py-2 px-3 rounded-xl text-center border border-slate-200">
                    <span className="text-[8px] font-bold text-slate-600 uppercase">{translate(plan.stitchTime as any, outputLanguage)}</span>
                  </div>
                </div>

                <div className="text-2xl font-black text-slate-900 mb-1 italic">
                  {outputLanguage === 'VN' ? translate(plan.price as any, outputLanguage) : (
                    plan.id === 'free_unlimited' ? translate('FREE_PLAN_PRICE_USD', outputLanguage) : (
                      plan.id === 'pro_1' ? translate('PRO1_PLAN_PRICE_USD', outputLanguage) : translate('PRO9_PLAN_PRICE_USD', outputLanguage)
                    )
                  )}
                </div>
                <div className="text-[8px] text-slate-400 font-black mb-8 uppercase tracking-widest italic">{translate(plan.subtitle as any, outputLanguage)}</div>

                <button 
                  onClick={(e) => { e.stopPropagation(); handleSelectPlan(plan); }}
                  className={`w-full py-4 rounded-xl font-black text-[9px] uppercase tracking-widest italic transition active:scale-95 ${currentProfile.accountType === translate(plan.name as any, outputLanguage) ? 'bg-slate-100 text-slate-400 cursor-default' : (plan.id === 'free_unlimited' ? 'bg-indigo-600 text-white shadow-lg' : 'bg-[#0f172a] text-white hover:bg-slate-800 shadow-xl')}`}
                >
                  {currentProfile.accountType === translate(plan.name as any, outputLanguage) ? translate('ACTIVATED', outputLanguage) : (plan.id === 'free_unlimited' ? translate('SETUP_API_KEY', outputLanguage) : translate('ACTIVATE_PLAN', outputLanguage))}
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Cửa sổ thanh toán - Chỉ hiện mã QR bảo mật */}
        {showPaymentWindow && selectedPlan && (
          <div className="fixed inset-0 bg-[#0f172a]/95 backdrop-blur-xl z-[150] flex items-center justify-center p-4 animate-in fade-in zoom-in-95 duration-300">
            <div className="bg-slate-900 text-white rounded-[2.5rem] w-full max-w-3xl shadow-2xl border-2 border-amber-500/40 flex flex-col md:flex-row overflow-hidden relative">
              <button 
                onClick={() => setShowPaymentWindow(false)} 
                className="absolute top-5 right-5 bg-slate-800 hover:bg-red-600 text-slate-300 hover:text-white w-9 h-9 rounded-full flex items-center justify-center font-black z-20 shadow-md transition"
              >
                ✕
              </button>
              
              {/* Left Column: QR Code */}
              <div className="flex-1 bg-slate-950 p-6 sm:p-8 flex flex-col items-center justify-center border-b md:border-b-0 md:border-r border-slate-800">
                <div className="bg-white p-3 rounded-2xl shadow-2xl mb-3 flex flex-col items-center">
                  <img 
                    src={`https://img.vietqr.io/image/MB-0339606969-compact2.png?amount=${selectedPlan.price.replace(/,/g, '').replace(' VNĐ', '')}&addInfo=${encodeURIComponent(currentProfile.machineId + ' ' + translate(selectedPlan.name as any, outputLanguage))}&accountName=YOHU%20STUDIO`}
                    className="w-56 h-56 sm:w-64 sm:h-64 object-contain rounded-xl" 
                    alt="Mã QR Thanh Toán Tự Động" 
                  />
                  <span className="text-[9px] font-black text-slate-800 uppercase mt-1 tracking-wider">
                    Quét Mã Bằng App Ngân Hàng / Zalo
                  </span>
                </div>
                
                <div className="text-center bg-slate-900/90 px-4 py-2 rounded-xl border border-slate-800 w-full">
                  <p className="text-[8px] font-black text-slate-400 uppercase tracking-wider mb-0.5">{translate('TRANSACTION_VALUE', outputLanguage)}</p>
                  <p className="text-xl font-black text-amber-400">
                    {outputLanguage === 'VN' ? translate(selectedPlan.price as any, outputLanguage) : (
                      selectedPlan.id === 'free_unlimited' ? translate('FREE_PLAN_PRICE_USD', outputLanguage) : (
                        selectedPlan.id === 'pro_1' ? translate('PRO1_PLAN_PRICE_USD', outputLanguage) : translate('PRO9_PLAN_PRICE_USD', outputLanguage)
                      )
                    )}
                  </p>
                </div>
              </div>

              {/* Right Column: Safe Instructions & Zalo Chat */}
              <div className="flex-1 p-6 sm:p-8 flex flex-col justify-between">
                <div>
                  <div className="inline-flex items-center gap-1.5 bg-amber-500/10 text-amber-400 px-3 py-1 rounded-full w-fit mb-4 border border-amber-500/30 text-[9px] font-black uppercase tracking-wider">
                    <span>🛡️ THANH TOÁN BẢO MẬT 100%</span>
                  </div>

                  <h3 className="text-lg font-black uppercase tracking-tight text-white mb-2">
                    {translate('PAYMENT_TITLE', outputLanguage)}: {translate(selectedPlan.name as any, outputLanguage)}
                  </h3>

                  <div className="space-y-3 mb-5">
                    <div className="p-3 bg-slate-950 rounded-xl border border-slate-800">
                      <p className="text-[9px] text-slate-400 font-bold uppercase mb-1">Mã xác nhận giao dịch:</p>
                      <p className="font-mono font-black text-amber-400 text-xs">
                        {currentProfile.machineId} • {translate(selectedPlan.name as any, outputLanguage)}
                      </p>
                    </div>

                    <div className="p-3 bg-amber-950/30 rounded-xl border border-amber-500/30">
                      <p className="text-[10px] text-amber-300 font-medium leading-relaxed">
                        🔒 <strong>Chính sách an toàn:</strong> Nhằm phòng chống lừa đảo và bảo vệ thông tin người dùng, hệ thống chỉ hiển thị mã QR tự động.
                      </p>
                    </div>

                    <div className="p-3 bg-indigo-950/40 rounded-xl border border-indigo-500/30">
                      <p className="text-[10px] text-indigo-300 font-medium leading-relaxed">
                        💬 <strong>Chi tiết trao đổi:</strong> Toàn bộ thông tin hỗ trợ và xác nhận giao dịch thực hiện trực tiếp qua Chat Zalo chính thức.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-2 pt-2">
                  <button 
                    onClick={() => handleConfirmActivation()} 
                    disabled={isVerifying} 
                    className="w-full py-3.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-black text-xs uppercase tracking-wider shadow-lg active:scale-95 transition"
                  >
                    {isVerifying ? translate('VERIFYING', outputLanguage) : 'ĐÃ QUÉT MÃ • XÁC NHẬN KÍCH HOẠT'}
                  </button>

                  <a
                    href="https://zalo.me/0973480488"
                    target="_blank"
                    rel="noreferrer"
                    className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs uppercase tracking-wider text-center block transition border border-slate-700"
                  >
                    💬 Trao Đổi Chi Tiết Qua Chat Zalo
                  </a>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="bg-slate-100 px-8 py-3 flex justify-between items-center text-[9px] font-black text-slate-400 uppercase tracking-widest flex-shrink-0 border-t border-slate-200 italic">
           <span>YOHU-PRO v3.7 • VEO 3.1 PRO SYSTEM</span>
           <span className="text-emerald-600">{translate('AUTO_ACTIVATION', outputLanguage)}</span>
        </div>
      </div>
    </div>
  );
};
