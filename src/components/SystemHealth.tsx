import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  Activity, 
  ShieldCheck, 
  AlertTriangle, 
  XCircle, 
  RefreshCw, 
  Zap, 
  Database, 
  Search, 
  CheckCircle2, 
  Clock, 
  Copy, 
  Check, 
  Layers,
  Server,
  X
} from 'lucide-react';
import { googleSheetService } from '../services/googleSheetService';
import { GoogleGenAI } from '@google/genai';
import { processKeys } from '../services/gemini';

export type KeyHealthStatus = 'optimal' | 'warning' | 'exhausted' | 'invalid' | 'checking' | 'idle';

export interface KeyHealthItem {
  id: string;
  rawKey: string;
  maskedKey: string;
  source: 'google_sheet' | 'env_free' | 'env_paid' | 'user_custom' | 'system_pro';
  tierName: string;
  isPaid: boolean;
  status: KeyHealthStatus;
  latencyMs?: number;
  capacityPercent: number; // 0 - 100
  supportedModels: string[];
  lastChecked?: number;
  errorMessage?: string;
  requestCount: number;
}

interface SystemHealthProps {
  isOpen: boolean;
  onClose: () => void;
  outputLanguage: 'VN' | 'EN';
  userKeys?: string[];
  isSheetConnected?: boolean | null;
}

export const SystemHealth: React.FC<SystemHealthProps> = ({
  isOpen,
  onClose,
  outputLanguage = 'VN',
  userKeys = [],
  isSheetConnected = true
}) => {
  const [keysList, setKeysList] = useState<KeyHealthItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncingSheet, setIsSyncingSheet] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [testingProgress, setTestingProgress] = useState<{ current: number; total: number } | null>(null);

  const isVN = outputLanguage === 'VN';

  // Helper to mask key
  const maskKey = (key: string) => {
    if (!key || key.length < 10) return 'Invalid Key';
    return `${key.slice(0, 8)}••••••••${key.slice(-4)}`;
  };

  // Collect all keys from multiple sources
  const loadAllConfiguredKeys = useCallback(async () => {
    setIsSyncingSheet(true);
    const collected: KeyHealthItem[] = [];

    // 1. Environment Free Keys
    const envFreeStr = import.meta.env.VITE_GEMINI_FREE_KEYS || '';
    const envFreeKeys = processKeys(envFreeStr.split(','));
    envFreeKeys.forEach((key, idx) => {
      collected.push({
        id: `env-free-${idx}-${key.slice(-4)}`,
        rawKey: key,
        maskedKey: maskKey(key),
        source: 'env_free',
        tierName: isVN ? 'Free Tier (Gemini)' : 'Free Tier',
        isPaid: false,
        status: 'idle',
        capacityPercent: 95,
        supportedModels: ['Gemini 3.8 Flash', 'Gemini 3.8 TTS', 'Flash Image'],
        requestCount: 0
      });
    });

    // 2. Environment Paid Keys
    const envPaidStr = import.meta.env.VITE_GEMINI_PAID_KEYS || '';
    const envPaidKeys = processKeys(envPaidStr.split(','));
    envPaidKeys.forEach((key, idx) => {
      collected.push({
        id: `env-paid-${idx}-${key.slice(-4)}`,
        rawKey: key,
        maskedKey: maskKey(key),
        source: 'env_paid',
        tierName: isVN ? 'Pro Tier (Veo 3.1)' : 'Pro Tier',
        isPaid: true,
        status: 'idle',
        capacityPercent: 100,
        supportedModels: ['Veo 3.1 4K', 'Gemini 3.1 Pro', 'Gemini 3.8 Flash', 'Gemini 3.8 TTS'],
        requestCount: 0
      });
    });

    // 3. System Pro Keys from process.env if available
    const pro1 = typeof process !== 'undefined' ? (process.env.GOOGLE_KEYS_PRO1 || process.env.GOOGLE_KEY_PRO1) : undefined;
    const pro9 = typeof process !== 'undefined' ? (process.env.GOOGLE_KEYS_PRO9 || process.env.GOOGLE_KEY_PRO9) : undefined;
    if (pro1) {
      processKeys(pro1.split(/[\n,]/)).forEach((key, idx) => {
        if (!collected.some(k => k.rawKey === key)) {
          collected.push({
            id: `pro1-${idx}-${key.slice(-4)}`,
            rawKey: key,
            maskedKey: maskKey(key),
            source: 'system_pro',
            tierName: 'PRO1 System',
            isPaid: true,
            status: 'idle',
            capacityPercent: 98,
            supportedModels: ['Veo 3.1 Lite', 'Gemini 3.8 Flash', 'Gemini 3.8 TTS'],
            requestCount: 0
          });
        }
      });
    }
    if (pro9) {
      processKeys(pro9.split(/[\n,]/)).forEach((key, idx) => {
        if (!collected.some(k => k.rawKey === key)) {
          collected.push({
            id: `pro9-${idx}-${key.slice(-4)}`,
            rawKey: key,
            maskedKey: maskKey(key),
            source: 'system_pro',
            tierName: 'PRO9 High-Priority',
            isPaid: true,
            status: 'idle',
            capacityPercent: 100,
            supportedModels: ['Veo 3.1 4K', 'Veo 3.1 Lite', 'Gemini 3.1 Pro', 'Gemini 3.8 TTS'],
            requestCount: 0
          });
        }
      });
    }

    // 4. User Custom Keys
    const customUserKeys = processKeys(userKeys);
    customUserKeys.forEach((key, idx) => {
      if (!collected.some(k => k.rawKey === key)) {
        collected.push({
          id: `user-${idx}-${key.slice(-4)}`,
          rawKey: key,
          maskedKey: maskKey(key),
          source: 'user_custom',
          tierName: isVN ? 'Khóa Người Dùng' : 'Custom User Key',
          isPaid: false,
          status: 'idle',
          capacityPercent: 90,
          supportedModels: ['Veo 3.1', 'Gemini 3.8 Flash', 'Gemini 3.8 TTS'],
          requestCount: 0
        });
      }
    });

    // 5. Google Sheet Keys (Real-time integration)
    try {
      const sheetData = await googleSheetService.getAllApiKeys();
      if (sheetData && sheetData.keys && sheetData.keys.length > 0) {
        const sheetKeys = processKeys(sheetData.keys);
        sheetKeys.forEach((key, idx) => {
          if (!collected.some(k => k.rawKey === key)) {
            const isPaid = sheetData.paidKeys ? sheetData.paidKeys.includes(key) : false;
            collected.push({
              id: `sheet-${idx}-${key.slice(-4)}`,
              rawKey: key,
              maskedKey: maskKey(key),
              source: 'google_sheet',
              tierName: isPaid ? (isVN ? 'Sheet Pro Key' : 'Sheet Paid Key') : (isVN ? 'Sheet Free Key' : 'Sheet Free Key'),
              isPaid,
              status: 'idle',
              capacityPercent: isPaid ? 100 : 85,
              supportedModels: isPaid 
                ? ['Veo 3.1 4K', 'Gemini 3.1 Pro', 'Gemini 3.8 Flash', 'Gemini 3.8 TTS']
                : ['Gemini 3.8 Flash', 'Gemini 3.8 TTS', 'Flash Image'],
              requestCount: 0
            });
          }
        });
      }
    } catch (sheetErr) {
      console.warn("Failed to fetch keys from Google Sheet:", sheetErr);
    }

    setKeysList(collected);
    setLastSyncTime(new Date());
    setIsSyncingSheet(false);
  }, [userKeys, isVN]);

  // Load keys on open
  useEffect(() => {
    if (isOpen) {
      loadAllConfiguredKeys();
    }
  }, [isOpen, loadAllConfiguredKeys]);

  // Test a single key
  const testSingleKey = async (item: KeyHealthItem) => {
    const startTime = performance.now();
    
    // Set status to checking
    setKeysList(prev => prev.map(k => k.id === item.id ? { ...k, status: 'checking', errorMessage: undefined } : k));

    try {
      const ai = new GoogleGenAI({ apiKey: item.rawKey });
      
      // Lightweight probe using gemini-3.8-flash
      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: 'ping',
        config: {
          generationConfig: { maxOutputTokens: 2 }
        }
      });

      const latency = Math.round(performance.now() - startTime);
      const isOk = !!response.text || (response.candidates && response.candidates.length > 0);

      if (isOk) {
        setKeysList(prev => prev.map(k => k.id === item.id ? {
          ...k,
          status: latency > 1800 ? 'warning' : 'optimal',
          latencyMs: latency,
          capacityPercent: Math.max(10, Math.min(100, Math.round(100 - (latency / 40)))),
          lastChecked: Date.now(),
          requestCount: k.requestCount + 1,
          errorMessage: undefined
        } : k));
      } else {
        throw new Error("Invalid model response");
      }
    } catch (err: any) {
      const errorMsg = err.message || '';
      const isQuota = errorMsg.includes('429') || errorMsg.includes('RESOURCE_EXHAUSTED') || errorMsg.includes('quota');
      const isAuth = errorMsg.includes('401') || errorMsg.includes('403') || errorMsg.includes('API_KEY_INVALID') || errorMsg.includes('PERMISSION_DENIED');

      let status: KeyHealthStatus = 'warning';
      if (isQuota) status = 'exhausted';
      else if (isAuth) status = 'invalid';

      setKeysList(prev => prev.map(k => k.id === item.id ? {
        ...k,
        status,
        latencyMs: Math.round(performance.now() - startTime),
        capacityPercent: isQuota ? 5 : (isAuth ? 0 : 40),
        lastChecked: Date.now(),
        errorMessage: isQuota ? (isVN ? 'Đã hết hạn ngạch (429 Quota Exceeded)' : 'Quota limit exceeded (429)') : (isAuth ? (isVN ? 'Khóa không hợp lệ (401/403)' : 'Invalid API Key') : errorMsg.slice(0, 80))
      } : k));
    }
  };

  // Benchmark / Test all keys in batch
  const testAllKeys = async () => {
    if (keysList.length === 0 || isLoading) return;
    setIsLoading(true);

    const total = keysList.length;
    for (let i = 0; i < total; i++) {
      setTestingProgress({ current: i + 1, total });
      await testSingleKey(keysList[i]);
      // small delay to prevent browser throttling
      await new Promise(r => setTimeout(r, 150));
    }

    setTestingProgress(null);
    setIsLoading(false);
  };

  // Copy key to clipboard
  const handleCopyKey = (item: KeyHealthItem) => {
    navigator.clipboard.writeText(item.rawKey);
    setCopiedKeyId(item.id);
    setTimeout(() => setCopiedKeyId(null), 2000);
  };

  // Filtered keys
  const filteredKeys = useMemo(() => {
    return keysList.filter(item => {
      // Search
      const matchesSearch = 
        item.maskedKey.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.tierName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.supportedModels.some(m => m.toLowerCase().includes(searchQuery.toLowerCase()));

      if (!matchesSearch) return false;

      // Filter
      if (filterType === 'all') return true;
      if (filterType === 'paid') return item.isPaid || item.source === 'env_paid' || item.source === 'system_pro';
      if (filterType === 'free') return !item.isPaid && item.source === 'env_free';
      if (filterType === 'sheet') return item.source === 'google_sheet';
      if (filterType === 'user') return item.source === 'user_custom';
      if (filterType === 'optimal') return item.status === 'optimal';
      if (filterType === 'issue') return item.status === 'exhausted' || item.status === 'invalid' || item.status === 'warning';

      return true;
    });
  }, [keysList, searchQuery, filterType]);

  // Summary Metrics
  const metrics = useMemo(() => {
    const total = keysList.length;
    const optimal = keysList.filter(k => k.status === 'optimal').length;
    const warning = keysList.filter(k => k.status === 'warning').length;
    const exhausted = keysList.filter(k => k.status === 'exhausted' || k.status === 'invalid').length;
    const checkedKeys = keysList.filter(k => k.latencyMs !== undefined);
    const avgLatency = checkedKeys.length > 0 
      ? Math.round(checkedKeys.reduce((acc, k) => acc + (k.latencyMs || 0), 0) / checkedKeys.length)
      : null;
    const avgCapacity = total > 0
      ? Math.round(keysList.reduce((acc, k) => acc + k.capacityPercent, 0) / total)
      : 100;

    return { total, optimal, warning, exhausted, avgLatency, avgCapacity };
  }, [keysList]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-6 z-[600] animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-700/80 rounded-3xl w-full max-w-6xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden text-slate-100">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/90 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-indigo-500/10 border border-indigo-500/30 text-indigo-400">
              <Activity size={22} className="animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base sm:text-lg font-black tracking-tight text-white uppercase italic">
                  {isVN ? 'Giám Sát Khả Dụng & Dung Lượng Gemini API Keys' : 'Gemini Keys System Health & Real-Time Capacity'}
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[8px] font-black uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                  Real-time
                </span>
              </div>
              <p className="text-[11px] text-slate-400 font-medium">
                {isVN 
                  ? 'Tự động đồng bộ với Google Sheet CRM, đo lường độ trễ (latency), tải trọng và trạng thái quota từng khóa.' 
                  : 'Live synchronization with Google Sheet CRM, latency benchmarking, and per-key capacity monitoring.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition active:scale-95"
              aria-label="Close modal"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Top Metric Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4 sm:p-6 bg-slate-950/50 border-b border-slate-800">
          
          {/* Card 1: Total Keys */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-3.5 flex flex-col justify-between shadow-sm">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-[10px] font-black uppercase tracking-wider">{isVN ? 'Tổng Khóa Đã Nạp' : 'Total API Keys'}</span>
              <Layers size={16} className="text-indigo-400" />
            </div>
            <div className="flex items-baseline gap-2 mt-2">
              <span className="text-2xl font-black text-white">{metrics.total}</span>
              <span className="text-[10px] text-slate-500 font-bold uppercase">{isVN ? 'Khóa' : 'Keys'}</span>
            </div>
            <div className="text-[9px] text-slate-400 mt-1 flex items-center gap-1">
              <span className="text-emerald-400 font-black">{metrics.optimal} Optimal</span> • <span className="text-amber-400 font-black">{metrics.warning} Warning</span>
            </div>
          </div>

          {/* Card 2: System Health Index */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-3.5 flex flex-col justify-between shadow-sm">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-[10px] font-black uppercase tracking-wider">{isVN ? 'Chỉ Số Khả Dụng' : 'Operational Capacity'}</span>
              <ShieldCheck size={16} className="text-emerald-400" />
            </div>
            <div className="flex items-baseline gap-2 mt-2">
              <span className="text-2xl font-black text-emerald-400">{metrics.avgCapacity}%</span>
              <span className="text-[10px] text-emerald-500/80 font-bold uppercase">{isVN ? 'Sẵn sàng' : 'Ready'}</span>
            </div>
            <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden mt-1">
              <div 
                className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-500" 
                style={{ width: `${metrics.avgCapacity}%` }}
              />
            </div>
          </div>

          {/* Card 3: Average Latency */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-3.5 flex flex-col justify-between shadow-sm">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-[10px] font-black uppercase tracking-wider">{isVN ? 'Độ Trễ Trung Bình' : 'Avg Latency'}</span>
              <Clock size={16} className="text-blue-400" />
            </div>
            <div className="flex items-baseline gap-2 mt-2">
              <span className="text-2xl font-black text-blue-400">
                {metrics.avgLatency !== null ? `${metrics.avgLatency}ms` : '--'}
              </span>
              <span className="text-[10px] text-slate-500 font-bold uppercase">Probe</span>
            </div>
            <div className="text-[9px] text-slate-400 mt-1">
              {metrics.avgLatency ? (metrics.avgLatency < 400 ? '⚡ Siêu nhanh (Fast)' : 'Ổn định (Normal)') : (isVN ? 'Chưa đo lường' : 'Unchecked')}
            </div>
          </div>

          {/* Card 4: Google Sheet Integration */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-3.5 flex flex-col justify-between shadow-sm">
            <div className="flex items-center justify-between text-slate-400">
              <span className="text-[10px] font-black uppercase tracking-wider">{isVN ? 'Google Sheet CRM' : 'Google Sheet CRM'}</span>
              <Database size={16} className={isSheetConnected ? "text-emerald-400" : "text-amber-400"} />
            </div>
            <div className="flex items-center gap-1.5 mt-2">
              <div className={`w-2 h-2 rounded-full ${isSheetConnected ? 'bg-emerald-400 animate-ping' : 'bg-amber-400'}`} />
              <span className="text-sm font-black text-white uppercase">
                {isSheetConnected ? (isVN ? 'Đã Kết Nối' : 'Connected') : (isVN ? 'Offline' : 'Offline')}
              </span>
            </div>
            <div className="text-[9px] text-slate-400 mt-1 truncate">
              {lastSyncTime ? `${isVN ? 'Đồng bộ lúc' : 'Synced at'}: ${lastSyncTime.toLocaleTimeString()}` : (isVN ? 'Tự động đồng bộ' : 'Auto sync')}
            </div>
          </div>

        </div>

        {/* Toolbar & Filters */}
        <div className="px-6 py-3 bg-slate-900 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
          {/* Search box */}
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder={isVN ? "Tìm theo mã khóa, phân loại, model..." : "Search by key, tier, model..."}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700/80 rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition"
            />
          </div>

          {/* Filter Chips */}
          <div className="flex items-center gap-1 overflow-x-auto custom-scrollbar py-1">
            <button
              onClick={() => setFilterType('all')}
              className={`px-3 py-1 rounded-xl text-[10px] font-black uppercase tracking-wider transition ${filterType === 'all' ? 'bg-indigo-600 text-white shadow-md' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
            >
              {isVN ? 'Tất Cả' : 'All'} ({keysList.length})
            </button>
            <button
              onClick={() => setFilterType('free')}
              className={`px-3 py-1 rounded-xl text-[10px] font-black uppercase tracking-wider transition ${filterType === 'free' ? 'bg-indigo-600 text-white shadow-md' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
            >
              Free Tier
            </button>
            <button
              onClick={() => setFilterType('paid')}
              className={`px-3 py-1 rounded-xl text-[10px] font-black uppercase tracking-wider transition ${filterType === 'paid' ? 'bg-indigo-600 text-white shadow-md' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
            >
              Pro / Veo 3.1
            </button>
            <button
              onClick={() => setFilterType('sheet')}
              className={`px-3 py-1 rounded-xl text-[10px] font-black uppercase tracking-wider transition ${filterType === 'sheet' ? 'bg-indigo-600 text-white shadow-md' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
            >
              Google Sheet
            </button>
            <button
              onClick={() => setFilterType('optimal')}
              className={`px-3 py-1 rounded-xl text-[10px] font-black uppercase tracking-wider transition ${filterType === 'optimal' ? 'bg-emerald-600 text-white shadow-md' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
            >
              Optimal ({metrics.optimal})
            </button>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={loadAllConfiguredKeys}
              disabled={isSyncingSheet || isLoading}
              className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-[10px] font-black uppercase flex items-center gap-1.5 transition active:scale-95 disabled:opacity-50"
            >
              <RefreshCw size={13} className={isSyncingSheet ? "animate-spin" : ""} />
              {isSyncingSheet ? (isVN ? 'Đang Tải Sheet...' : 'Syncing...') : (isVN ? 'Đồng Bộ Sheet' : 'Sync Sheet')}
            </button>

            <button
              onClick={testAllKeys}
              disabled={isLoading || keysList.length === 0}
              className="px-4 py-1.5 rounded-xl bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 text-white text-[10px] font-black uppercase shadow-lg flex items-center gap-1.5 transition active:scale-95 disabled:opacity-50"
            >
              <Zap size={14} className={isLoading ? "animate-bounce" : ""} />
              {isLoading 
                ? (isVN ? `Đang Test (${testingProgress?.current}/${testingProgress?.total})...` : `Testing (${testingProgress?.current}/${testingProgress?.total})...`)
                : (isVN ? 'Kiểm Tra Toàn Bộ' : 'Benchmark All')}
            </button>
          </div>
        </div>

        {/* Main List */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-3 custom-scrollbar bg-slate-950/30">
          {filteredKeys.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center text-slate-500">
              <Server size={36} className="opacity-30 mb-2" />
              <p className="text-sm font-bold">{isVN ? 'Không tìm thấy API Key nào phù hợp' : 'No matching API keys found'}</p>
              <p className="text-xs text-slate-600 mt-1">{isVN ? 'Hãy thử đổi bộ lọc hoặc bấm "Đồng Bộ Sheet"' : 'Try changing your filter or click "Sync Sheet"'}</p>
            </div>
          ) : (
            filteredKeys.map((item, idx) => (
              <div 
                key={item.id}
                className="bg-slate-900 border border-slate-800/90 hover:border-slate-700 rounded-2xl p-4 transition-all duration-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-sm"
              >
                {/* Left: Key Info */}
                <div className="flex items-start sm:items-center gap-3.5 min-w-0">
                  <div className="w-8 h-8 rounded-xl bg-slate-800 flex items-center justify-center font-black text-slate-400 text-xs shrink-0 border border-slate-700">
                    {idx + 1}
                  </div>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs font-bold text-slate-200 tracking-wider">
                        {item.maskedKey}
                      </span>
                      <button
                        onClick={() => handleCopyKey(item)}
                        className="text-slate-500 hover:text-indigo-400 transition"
                        title={isVN ? "Sao chép khóa" : "Copy key"}
                      >
                        {copiedKeyId === item.id ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                      </button>

                      {/* Source tag */}
                      <span className={`px-2 py-0.5 rounded-md text-[8px] font-black uppercase tracking-wider ${
                        item.source === 'env_paid' || item.source === 'system_pro'
                          ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                          : item.source === 'google_sheet'
                          ? 'bg-blue-500/10 text-blue-400 border border-blue-500/30'
                          : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/30'
                      }`}>
                        {item.tierName}
                      </span>

                      {item.isPaid && (
                        <span className="px-1.5 py-0.5 rounded text-[8px] font-black bg-gradient-to-r from-purple-500 to-indigo-500 text-white uppercase tracking-tighter">
                          PRO
                        </span>
                      )}
                    </div>

                    {/* Models Supported */}
                    <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                      {item.supportedModels.map((m, mIdx) => (
                        <span key={mIdx} className="text-[8px] font-medium text-slate-400 bg-slate-800/80 px-1.5 py-0.5 rounded border border-slate-700/50">
                          {m}
                        </span>
                      ))}
                    </div>

                    {item.errorMessage && (
                      <div className="text-[9px] text-red-400 font-bold mt-1.5 flex items-center gap-1">
                        <AlertTriangle size={11} className="shrink-0" />
                        <span>{item.errorMessage}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Right: Metrics & Actions */}
                <div className="flex items-center justify-between sm:justify-end gap-5 shrink-0 border-t sm:border-t-0 pt-3 sm:pt-0 border-slate-800">
                  
                  {/* Capacity Bar */}
                  <div className="flex flex-col items-end min-w-[90px]">
                    <div className="flex items-center gap-1 text-[9px] font-bold text-slate-400">
                      <span>{isVN ? 'Dung lượng:' : 'Capacity:'}</span>
                      <span className="text-white font-black">{item.capacityPercent}%</span>
                    </div>
                    <div className="w-20 bg-slate-800 h-1.5 rounded-full overflow-hidden mt-1">
                      <div 
                        className={`h-full transition-all duration-300 ${
                          item.capacityPercent > 70 ? 'bg-emerald-400' : (item.capacityPercent > 30 ? 'bg-amber-400' : 'bg-red-400')
                        }`}
                        style={{ width: `${item.capacityPercent}%` }}
                      />
                    </div>
                  </div>

                  {/* Status & Latency */}
                  <div className="flex flex-col items-end min-w-[85px]">
                    {item.status === 'optimal' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-black bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 uppercase">
                        <CheckCircle2 size={10} /> Online
                      </span>
                    )}
                    {item.status === 'warning' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-black bg-amber-500/10 text-amber-400 border border-amber-500/30 uppercase">
                        <AlertTriangle size={10} /> Slow
                      </span>
                    )}
                    {item.status === 'exhausted' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-black bg-red-500/10 text-red-400 border border-red-500/30 uppercase">
                        <XCircle size={10} /> Quota 429
                      </span>
                    )}
                    {item.status === 'invalid' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-black bg-rose-500/10 text-rose-400 border border-rose-500/30 uppercase">
                        <XCircle size={10} /> Invalid
                      </span>
                    )}
                    {item.status === 'checking' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-black bg-blue-500/10 text-blue-400 border border-blue-500/30 uppercase animate-pulse">
                        <RefreshCw size={10} className="animate-spin" /> Ping...
                      </span>
                    )}
                    {item.status === 'idle' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-black bg-slate-800 text-slate-400 border border-slate-700 uppercase">
                        Idle
                      </span>
                    )}

                    <span className="text-[9px] text-slate-500 mt-1 font-mono">
                      {item.latencyMs !== undefined ? `${item.latencyMs}ms` : '--'}
                    </span>
                  </div>

                  {/* Test button */}
                  <button
                    onClick={() => testSingleKey(item)}
                    disabled={item.status === 'checking'}
                    className="p-2 rounded-xl bg-slate-800 hover:bg-indigo-600 hover:text-white text-slate-300 transition active:scale-95 border border-slate-700 disabled:opacity-50"
                    title={isVN ? "Kiểm tra khóa này" : "Benchmark this key"}
                  >
                    <Zap size={14} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-slate-900 border-t border-slate-800 flex items-center justify-between text-slate-400 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span>{isVN ? 'Tự động luân chuyển (Round-robin) khóa khi một khóa chạm ngưỡng 429 quota.' : 'Automatic key rotation active upon 429 quota exhaustion.'}</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-black uppercase transition"
          >
            {isVN ? 'Đóng' : 'Close'}
          </button>
        </div>

      </div>
    </div>
  );
};
