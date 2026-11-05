import React, { useEffect, useRef, useState } from 'react';
import {
  splitTextToDrafts,
  makeTextSlide,
  readingSeconds,
  draftPlainText,
  type ImportedSlide,
} from '../../services/inputConverters';
import {
  SLIDE_THEMES,
  computeLayout,
  drawSlide,
  renderSlideBlob,
  type SlideAnim,
  type SlideLayoutKind,
  type TextSlideSpec,
} from '../../services/slideRender';
import { searchStockPhotos, loadPhotoFromUrl, loadPhotoFromFile, type StockPhoto } from '../../services/stockPhotos';

interface Props {
  isVN: boolean;
  onClose: () => void;
  /** Thêm các slide đã chọn vào danh sách cảnh của phim */
  onAdd: (slides: ImportedSlide[]) => void;
  /** (Tuỳ chọn) nhờ AI đổi tiêu đề slide thành từ khoá tiếng Anh để tìm ảnh chính xác hơn */
  suggestKeywords?: (titles: string[]) => Promise<string[]>;
}

interface Photo {
  img: HTMLImageElement;
  w: number;
  h: number;
  url: string; // blob url dùng lúc dựng phim
  credit?: string;
}

interface Item {
  id: string;
  title: string;
  body: string; // mỗi dòng = 1 ý
  layout: SlideLayoutKind;
  theme: number; // -1 = tự đổi màu theo thứ tự slide
  anim: SlideAnim;
  seconds: number;
  /** lời thoại (dán vào ô tạo giọng đọc + làm phụ đề) */
  script: string;
  scriptEdited: boolean;
  keyword: string;
  photo: Photo | null;
  candidates: StockPhoto[];
  candIdx: number;
  previewUrl: string;
  sig: string;
  busy: boolean;
  note: string;
}

const LAYOUTS: { v: SlideLayoutKind; vn: string; en: string }[] = [
  { v: 'auto', vn: 'Tự động', en: 'Auto' },
  { v: 'text', vn: 'Tiêu đề + ý', en: 'Title + bullets' },
  { v: 'title', vn: 'Slide tiêu đề', en: 'Title slide' },
  { v: 'photo-right', vn: 'Ảnh bên phải', en: 'Photo right' },
  { v: 'photo-left', vn: 'Ảnh bên trái', en: 'Photo left' },
  { v: 'photo-full', vn: 'Ảnh nền toàn trang', en: 'Full photo' },
  { v: 'quote', vn: 'Trích dẫn', en: 'Quote' },
];

const ANIMS: { v: SlideAnim; vn: string; en: string }[] = [
  { v: 'typewriter', vn: 'Đánh máy', en: 'Typewriter' },
  { v: 'bullets', vn: 'Từng ý hiện dần', en: 'Bullet by bullet' },
  { v: 'fade', vn: 'Mờ hiện', en: 'Fade in' },
  { v: 'none', vn: 'Không hiệu ứng', en: 'None' },
];

let idSeq = 0;
const newId = () => `sl_${Date.now()}_${idSeq++}`;
const parasOf = (body: string) => body.split('\n').map((l) => l.replace(/^[-*•]\s*/, '').trim()).filter(Boolean);

const specOf = (it: Item, index: number, total: number): TextSlideSpec => ({
  title: it.title.trim(),
  paras: parasOf(it.body),
  layout: it.layout,
  theme: it.theme,
  anim: it.anim,
  photoUrl: it.photo?.url,
  credit: it.photo?.credit,
  index,
  total,
});

const sigOf = (it: Item, i: number, n: number) => JSON.stringify([it.title, it.body, it.layout, it.theme, it.photo?.url || '', it.photo?.credit || '', i, n]);

/** Đưa ảnh (từ kho / từ máy) về 1 file ảnh cục bộ cỡ vừa → dựng phim không phụ thuộc mạng */
async function toLocalPhoto(img: HTMLImageElement, credit?: string): Promise<Photo> {
  const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  const x = c.getContext('2d')!;
  x.imageSmoothingQuality = 'high';
  x.drawImage(img, 0, 0, c.width, c.height);
  const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Không xử lý được ảnh'))), 'image/jpeg', 0.92));
  const url = URL.createObjectURL(blob);
  const local = new Image();
  await new Promise<void>((res, rej) => {
    local.onload = () => res();
    local.onerror = () => rej(new Error('Không đọc được ảnh'));
    local.src = url;
  });
  return { img: local, w: local.naturalWidth, h: local.naturalHeight, url, credit };
}

/** Xem thử hiệu ứng (đánh máy...) ngay trong hộp thoại */
const SlidePlayer: React.FC<{ spec: TextSlideSpec; photo: Photo | null; seconds: number; typewriter: boolean; onClose: () => void; isVN: boolean }> = ({
  spec,
  photo,
  seconds,
  typewriter,
  onClose,
  isVN,
}) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    const W = cv.width;
    const H = cv.height;
    const layout = computeLayout(ctx, spec, W, H, 0, !!photo);
    let raf = 0;
    const t0 = performance.now();
    const loop = () => {
      const loopLen = seconds + 1.5;
      const t = ((performance.now() - t0) / 1000) % loopLen;
      drawSlide(ctx, W, H, spec, layout, photo ? { img: photo.img, w: photo.w, h: photo.h } : null, t, seconds, { typewriter });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [spec, photo, seconds, typewriter]);
  return (
    <div className="fixed inset-0 z-[120] bg-black/80 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-3xl space-y-2" onClick={(e) => e.stopPropagation()}>
        <canvas ref={ref} width={1280} height={720} className="w-full rounded-2xl border border-slate-700" />
        <div className="flex justify-between items-center">
          <span className="text-[11px] text-slate-300">
            {isVN ? `Xem thử ${seconds} giây (lặp lại). Chữ gõ vừa đủ số giây của slide.` : `Preview of ${seconds}s (looping).`}
          </span>
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl bg-slate-800 text-slate-200 text-xs font-bold">
            {isVN ? 'Đóng' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
};

export const SlideMaker: React.FC<Props> = ({ isVN, onClose, onAdd, suggestKeywords }) => {
  const t = (vn: string, en: string) => (isVN ? vn : en);
  const [step, setStep] = useState<'input' | 'preview'>('input');
  const [text, setText] = useState('');
  const [countMode, setCountMode] = useState<'auto' | 'custom'>('auto');
  const [count, setCount] = useState(5);
  const [useStock, setUseStock] = useState(false);
  const [localFiles, setLocalFiles] = useState<File[]>([]);
  const [deckTypewriter, setDeckTypewriter] = useState(true);
  const [deckTheme, setDeckTheme] = useState(-1);
  const [deckLayout, setDeckLayout] = useState<SlideLayoutKind>('auto');
  const [items, setItems] = useState<Item[]>([]);
  const [working, setWorking] = useState(false);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const [playIdx, setPlayIdx] = useState<number | null>(null);
  const previewUrls = useRef<string[]>([]);
  const photoUrls = useRef<string[]>([]);
  const confirmed = useRef(false);
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;

  useEffect(
    () => () => {
      previewUrls.current.forEach((u) => URL.revokeObjectURL(u));
      if (!confirmed.current) photoUrls.current.forEach((u) => URL.revokeObjectURL(u));
    },
    []
  );

  const patch = (id: string, p: Partial<Item>) => setItems((prev) => prev.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const patchText = (id: string, p: Partial<Pick<Item, 'title' | 'body'>>) =>
    setItems((prev) =>
      prev.map((x) => {
        if (x.id !== id) return x;
        const nx = { ...x, ...p };
        if (!nx.scriptEdited) nx.script = draftPlainText({ title: nx.title.trim(), paras: parasOf(nx.body) });
        return nx;
      })
    );

  /* ───── Vẽ lại ảnh xem trước khi nội dung đổi ───── */
  useEffect(() => {
    if (step !== 'preview') return;
    let cancelled = false;
    (async () => {
      const n = itemsRef.current.length;
      for (let i = 0; i < n; i++) {
        const it = itemsRef.current[i];
        if (!it) continue;
        const sig = sigOf(it, i, n);
        if (it.sig === sig) continue;
        let blob: Blob;
        try {
          blob = await renderSlideBlob(specOf(it, i, n), it.photo ? { img: it.photo.img, w: it.photo.w, h: it.photo.h } : null, 960, 540, 'image/jpeg', 0.9);
        } catch {
          continue;
        }
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        previewUrls.current.push(url);
        setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, previewUrl: url, sig } : x)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [items, step]);

  /* ───── Bước 1 → 2: chia slide ───── */
  const buildPreview = async () => {
    const drafts = splitTextToDrafts(text, countMode === 'custom' ? { count } : undefined);
    if (drafts.length === 0) return;
    setWorking(true);
    try {
      setMsg(t('Đang chia slide...', 'Splitting slides...'));
      let keywords: string[] = drafts.map((d) => d.title || d.paras[0] || '');
      if (useStock && suggestKeywords) {
        try {
          setMsg(t('AI đang chọn từ khoá tìm ảnh...', 'AI is picking photo keywords...'));
          const k = await suggestKeywords(keywords);
          if (k.length === drafts.length) keywords = k.map((x, i) => (x && x.trim()) || keywords[i]);
        } catch {
          // dùng tiêu đề
        }
      }
      const built: Item[] = [];
      for (let i = 0; i < drafts.length; i++) {
        setMsg(t(`Đang chuẩn bị slide ${i + 1}/${drafts.length}...`, `Preparing slide ${i + 1}/${drafts.length}...`));
        const d = drafts[i];
        let photo: Photo | null = null;
        let candidates: StockPhoto[] = [];
        let note = '';
        const lf = localFiles[i];
        if (lf) {
          try {
            const { img, url } = await loadPhotoFromFile(lf);
            photo = await toLocalPhoto(img);
            URL.revokeObjectURL(url);
            photoUrls.current.push(photo.url);
          } catch {
            note = t('Không đọc được ảnh từ máy', 'Could not read the local photo');
          }
        } else if (useStock) {
          try {
            candidates = await searchStockPhotos(keywords[i], 8);
            for (let c = 0; c < candidates.length && !photo; c++) {
              try {
                const img = await loadPhotoFromUrl(candidates[c].url);
                photo = await toLocalPhoto(img, candidates[c].credit);
                photoUrls.current.push(photo.url);
              } catch {
                photo = null;
              }
            }
            if (!photo) note = t('Không tìm được ảnh phù hợp', 'No matching photo found');
          } catch {
            note = t('Không kết nối được kho ảnh', 'Could not reach the photo library');
          }
        }
        const plain = draftPlainText(d);
        built.push({
          id: newId(),
          title: d.title,
          body: d.paras.join('\n'),
          layout: deckLayout,
          theme: deckTheme,
          anim: deckTypewriter ? 'typewriter' : 'bullets',
          seconds: readingSeconds(plain),
          script: plain,
          scriptEdited: false,
          keyword: keywords[i],
          photo,
          candidates,
          candIdx: 0,
          previewUrl: '',
          sig: '',
          busy: false,
          note,
        });
      }
      setItems(built);
      setStep('preview');
    } finally {
      setWorking(false);
      setMsg('');
    }
  };

  /* ───── Sửa từng slide ───── */
  const setLocalPhoto = async (id: string, file: File) => {
    patch(id, { busy: true, note: '' });
    try {
      const { img, url } = await loadPhotoFromFile(file);
      const photo = await toLocalPhoto(img);
      URL.revokeObjectURL(url);
      photoUrls.current.push(photo.url);
      patch(id, { photo, busy: false });
    } catch {
      patch(id, { busy: false, note: t('Không đọc được ảnh', 'Could not read the photo') });
    }
  };

  const nextStock = async (id: string, fresh = false) => {
    const it = itemsRef.current.find((x) => x.id === id);
    if (!it) return;
    patch(id, { busy: true, note: '' });
    try {
      let cands = fresh ? [] : it.candidates;
      let idx = fresh ? 0 : it.candIdx + 1;
      if (cands.length === 0) {
        cands = await searchStockPhotos(it.keyword, 8);
        idx = 0;
      }
      if (cands.length === 0) {
        patch(id, { busy: false, note: t('Không tìm thấy ảnh cho từ khoá này', 'No photos found for this keyword') });
        return;
      }
      for (let tries = 0; tries < cands.length; tries++) {
        const k = (idx + tries) % cands.length;
        try {
          const img = await loadPhotoFromUrl(cands[k].url);
          const photo = await toLocalPhoto(img, cands[k].credit);
          photoUrls.current.push(photo.url);
          patch(id, { photo, candidates: cands, candIdx: k, busy: false });
          return;
        } catch {
          // thử ảnh kế tiếp
        }
      }
      patch(id, { busy: false, candidates: cands, note: t('Không tải được ảnh', 'Could not load the photo') });
    } catch {
      patch(id, { busy: false, note: t('Không kết nối được kho ảnh', 'Could not reach the photo library') });
    }
  };

  const move = (i: number, d: -1 | 1) =>
    setItems((prev) => {
      const j = i + d;
      if (j < 0 || j >= prev.length) return prev;
      const a = [...prev];
      [a[i], a[j]] = [a[j], a[i]];
      return a;
    });
  const remove = (i: number) => setItems((prev) => (prev.length > 1 ? prev.filter((_, k) => k !== i) : prev));
  const addBlank = (i: number) =>
    setItems((prev) => {
      const blank: Item = {
        id: newId(), title: t('Tiêu đề mới', 'New title'), body: t('Nội dung ý 1\nNội dung ý 2', 'Point one\nPoint two'), layout: deckLayout, theme: deckTheme,
        anim: deckTypewriter ? 'typewriter' : 'bullets', seconds: 8, script: '', scriptEdited: false, keyword: '', photo: null, candidates: [], candIdx: 0,
        previewUrl: '', sig: '', busy: false, note: '',
      };
      blank.script = draftPlainText({ title: blank.title, paras: parasOf(blank.body) });
      const a = [...prev];
      a.splice(i + 1, 0, blank);
      return a;
    });
  const mergeNext = (i: number) =>
    setItems((prev) => {
      if (i >= prev.length - 1) return prev;
      const a = prev[i], b = prev[i + 1];
      const body = [a.body, b.title, b.body].filter((x) => x && x.trim()).join('\n');
      const merged: Item = { ...a, body, seconds: Math.min(60, a.seconds + b.seconds), script: a.scriptEdited || b.scriptEdited ? `${a.script} ${b.script}`.trim() : draftPlainText({ title: a.title, paras: parasOf(body) }), sig: '' };
      const arr = [...prev];
      arr.splice(i, 2, merged);
      return arr;
    });
  const splitItem = (i: number) =>
    setItems((prev) => {
      const a = prev[i];
      const lines = parasOf(a.body);
      if (lines.length < 2) return prev;
      const total = lines.join(' ').length;
      let acc = 0, cut = 1;
      for (let k = 0; k < lines.length - 1; k++) {
        acc += lines[k].length;
        cut = k + 1;
        if (acc >= total / 2) break;
      }
      const first: Item = { ...a, body: lines.slice(0, cut).join('\n'), sig: '' };
      const second: Item = { ...a, id: newId(), title: a.title ? `${a.title} (tiếp)` : '', body: lines.slice(cut).join('\n'), photo: null, candidates: [], candIdx: 0, previewUrl: '', sig: '', scriptEdited: false };
      first.script = first.scriptEdited ? first.script : draftPlainText({ title: first.title, paras: parasOf(first.body) });
      second.script = draftPlainText({ title: second.title, paras: parasOf(second.body) });
      first.seconds = readingSeconds(first.script);
      second.seconds = readingSeconds(second.script);
      const arr = [...prev];
      arr.splice(i, 1, first, second);
      return arr;
    });

  const applyDeckToAll = (p: Partial<Pick<Item, 'layout' | 'theme' | 'anim'>>) => setItems((prev) => prev.map((x) => ({ ...x, ...p })));

  const copyAllScripts = async () => {
    const txt = items.map((x, i) => `${isVN ? 'Cảnh' : 'Scene'} ${i + 1}: ${x.script.replace(/\s+/g, ' ').trim()}`).join('\n');
    try {
      await navigator.clipboard.writeText(txt);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const confirm = async () => {
    if (items.length === 0) return;
    setWorking(true);
    setMsg(t('Đang hoàn thiện slide...', 'Finishing slides...'));
    try {
      const out: ImportedSlide[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const spec = specOf(it, i, items.length);
        const sl = await makeTextSlide(spec, it.photo ? { img: it.photo.img, w: it.photo.w, h: it.photo.h } : null, 'slide', it.script);
        out.push({ ...sl, seconds: it.seconds, text: it.script });
      }
      confirmed.current = true;
      onAdd(out);
      onClose();
    } finally {
      setWorking(false);
      setMsg('');
    }
  };

  const btn = 'px-3 py-1.5 rounded-lg text-[11px] font-bold';
  const sel = 'bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-[11px] text-white outline-none';
  const themeName = (i: number) => (i < 0 ? t('Tự đổi màu', 'Auto colors') : SLIDE_THEMES[i].name);

  return (
    <div className="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center p-3">
      <div className="bg-slate-900 border border-slate-700 rounded-3xl p-5 w-full max-w-5xl max-h-[92vh] overflow-y-auto space-y-3 shadow-2xl">
        <h4 className="text-sm font-black text-white uppercase">
          {step === 'input' ? t('Dán văn bản để làm slide', 'Paste text to make slides') : t('Xem trước & chỉnh slide', 'Preview & edit slides')}
        </h4>

        {step === 'input' && (
          <>
            <p className="text-[11px] text-slate-400">
              {t(
                'Dòng ngắn (tiêu đề) hoặc dòng bắt đầu bằng # là tiêu đề slide. Cách nhau 1 dòng trống = đoạn mới. Muốn TỰ CHỌN chữ cho từng slide: gõ một dòng chỉ có --- giữa các phần.',
                'Short lines or lines starting with # are titles. A blank line = new paragraph. To choose the text of each slide yourself, put a line with only --- between parts.'
              )}
            </p>
            <textarea
              rows={9}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-2xl p-3 text-xs text-slate-100 outline-none focus:border-amber-400 resize-none"
              placeholder={t('Dán nội dung vào đây...', 'Paste content here...')}
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3 space-y-2">
                <p className="text-[11px] font-black text-slate-200 uppercase">{t('Số slide', 'Number of slides')}</p>
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-200">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" checked={countMode === 'auto'} onChange={() => setCountMode('auto')} />
                    {t('Tự động', 'Automatic')}
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" checked={countMode === 'custom'} onChange={() => setCountMode('custom')} />
                    {t('Tự chọn', 'Custom')}
                  </label>
                  {countMode === 'custom' && (
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={count}
                      onChange={(e) => setCount(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
                      className="w-16 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white"
                    />
                  )}
                </div>
                <p className="text-[10px] text-slate-500">
                  {t('Chia xong bạn vẫn sửa được từng slide: gộp, tách, thêm, xoá, đổi thứ tự.', 'You can still merge, split, add, delete and reorder after.')}
                </p>
              </div>

              <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3 space-y-2">
                <p className="text-[11px] font-black text-slate-200 uppercase">{t('Phong cách trình chiếu', 'Presentation style')}</p>
                <label className="flex items-center gap-2 text-[11px] text-slate-200 cursor-pointer">
                  <input type="checkbox" checked={deckTypewriter} onChange={(e) => setDeckTypewriter(e.target.checked)} />
                  {t('Chữ đánh máy (gõ vừa đủ số giây của slide). Tắt = từng ý hiện dần tự động', 'Typewriter text (timed to the slide). Off = bullets appear automatically')}
                </label>
                <div className="flex flex-wrap gap-2 items-center text-[11px] text-slate-300">
                  <label className="flex items-center gap-1">
                    {t('Màu', 'Theme')}
                    <select className={sel} value={deckTheme} onChange={(e) => setDeckTheme(Number(e.target.value))}>
                      <option value={-1}>{themeName(-1)}</option>
                      {SLIDE_THEMES.map((th, i) => (
                        <option key={th.name} value={i}>{th.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-1">
                    {t('Bố cục', 'Layout')}
                    <select className={sel} value={deckLayout} onChange={(e) => setDeckLayout(e.target.value as SlideLayoutKind)}>
                      {LAYOUTS.map((l) => (
                        <option key={l.v} value={l.v}>{t(l.vn, l.en)}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
            </div>

            <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3 space-y-2">
              <p className="text-[11px] font-black text-slate-200 uppercase">{t('Ảnh minh hoạ cho slide (không bắt buộc)', 'Slide photos (optional)')}</p>
              <div className="flex flex-wrap items-center gap-2">
                <label className={`${btn} bg-slate-800 hover:bg-slate-700 text-slate-100 cursor-pointer`}>
                  {t('📁 Tải ảnh từ máy', '📁 Upload from computer')}
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      const f = Array.from(e.target.files || []);
                      if (f.length) setLocalFiles((p) => [...p, ...f]);
                      e.target.value = '';
                    }}
                  />
                </label>
                {localFiles.length > 0 && (
                  <>
                    <span className="text-[11px] text-slate-300">
                      {t(`Đã chọn ${localFiles.length} ảnh (gán lần lượt cho slide 1, 2, 3...)`, `${localFiles.length} photos (assigned to slides 1, 2, 3...)`)}
                    </span>
                    <button type="button" className={`${btn} bg-slate-800 text-slate-300`} onClick={() => setLocalFiles([])}>
                      {t('Xoá hết', 'Clear')}
                    </button>
                  </>
                )}
              </div>
              <label className="flex items-start gap-2 text-[11px] text-slate-200 cursor-pointer">
                <input type="checkbox" checked={useStock} onChange={(e) => setUseStock(e.target.checked)} className="mt-0.5" />
                <span>
                  {t(
                    'Tự chèn ảnh từ kho ảnh miễn phí (Wikimedia Commons) cho slide chưa có ảnh từ máy. Ảnh được ghi nguồn nhỏ dưới ảnh.',
                    'Auto-insert free stock photos (Wikimedia Commons) for slides without a local photo. Credit is printed under the photo.'
                  )}
                </span>
              </label>
            </div>

            {msg && <p className="text-[11px] text-amber-300">{msg}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold">
                {t('Đóng', 'Close')}
              </button>
              <button
                type="button"
                onClick={buildPreview}
                disabled={working || !text.trim()}
                className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:bg-slate-800 disabled:text-slate-500 text-white text-xs font-black uppercase"
              >
                {working ? t('Đang dựng...', 'Working...') : t('Xem trước slide', 'Preview slides')}
              </button>
            </div>
          </>
        )}

        {step === 'preview' && (
          <>
            <p className="text-[11px] text-slate-400">
              {t(
                'Mỗi slide: sửa chữ (mỗi dòng ở ô "Nội dung" là một ý), chọn bố cục, màu, hiệu ứng, số giây, ảnh. Bấm ▶ để xem thử hiệu ứng. Hài lòng thì bấm "Thêm vào phim", rồi bấm TẠO PHIM.',
                'Edit text (each line is a bullet), layout, theme, animation, seconds and photo for each slide. Press ▶ to preview the animation. Then "Add to movie" and CREATE MOVIE.'
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void copyAllScripts()} className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-900 text-[11px] font-black">
                {copied ? t('✓ Đã copy', '✓ Copied') : t('📋 Copy toàn bộ lời thoại (để tạo giọng đọc)', '📋 Copy all narration (to make a voice)')}
              </button>
              <span className="text-[11px] text-slate-400">{t('Áp cho tất cả slide:', 'Apply to all:')}</span>
              <select className={sel} defaultValue="" onChange={(e) => { if (e.target.value) applyDeckToAll({ anim: e.target.value as SlideAnim }); e.target.value = ''; }}>
                <option value="">{t('Hiệu ứng...', 'Animation...')}</option>
                {ANIMS.map((a) => (<option key={a.v} value={a.v}>{t(a.vn, a.en)}</option>))}
              </select>
              <select className={sel} defaultValue="" onChange={(e) => { if (e.target.value !== '') applyDeckToAll({ theme: Number(e.target.value) }); e.target.value = ''; }}>
                <option value="">{t('Màu...', 'Theme...')}</option>
                <option value={-1}>{themeName(-1)}</option>
                {SLIDE_THEMES.map((th, i) => (<option key={th.name} value={i}>{th.name}</option>))}
              </select>
              <select className={sel} defaultValue="" onChange={(e) => { if (e.target.value) applyDeckToAll({ layout: e.target.value as SlideLayoutKind }); e.target.value = ''; }}>
                <option value="">{t('Bố cục...', 'Layout...')}</option>
                {LAYOUTS.map((l) => (<option key={l.v} value={l.v}>{t(l.vn, l.en)}</option>))}
              </select>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {items.map((it, i) => (
                <div key={it.id} className="bg-slate-950 border border-slate-800 rounded-2xl p-2.5 space-y-2">
                  <div className="relative">
                    {it.previewUrl ? (
                      <img src={it.previewUrl} alt={`slide ${i + 1}`} className="w-full rounded-xl border border-slate-800" />
                    ) : (
                      <div className="w-full aspect-video rounded-xl bg-slate-900 flex items-center justify-center text-[11px] text-slate-500">{t('Đang vẽ...', 'Rendering...')}</div>
                    )}
                    {it.busy && (
                      <div className="absolute inset-0 bg-black/60 rounded-xl flex items-center justify-center text-xs text-white font-bold">{t('Đang xử lý...', 'Working...')}</div>
                    )}
                    <span className="absolute top-1.5 left-1.5 bg-black/70 text-white text-[10px] font-black px-1.5 py-0.5 rounded">{i + 1}</span>
                    <button
                      type="button"
                      onClick={() => setPlayIdx(i)}
                      className="absolute bottom-1.5 right-1.5 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-black"
                    >
                      ▶ {t('Xem thử', 'Preview')}
                    </button>
                  </div>

                  <div className="flex flex-wrap gap-1">
                    <button type="button" className={`${btn} bg-slate-800 text-slate-200`} onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                    <button type="button" className={`${btn} bg-slate-800 text-slate-200`} onClick={() => move(i, 1)} disabled={i === items.length - 1}>↓</button>
                    <button type="button" className={`${btn} bg-slate-800 text-slate-200`} onClick={() => splitItem(i)}>{t('Tách đôi', 'Split')}</button>
                    <button type="button" className={`${btn} bg-slate-800 text-slate-200`} onClick={() => mergeNext(i)} disabled={i === items.length - 1}>{t('Gộp với slide sau', 'Merge next')}</button>
                    <button type="button" className={`${btn} bg-slate-800 text-slate-200`} onClick={() => addBlank(i)}>{t('+ Slide trống', '+ Blank')}</button>
                    <button type="button" className={`${btn} bg-red-900/70 text-red-100`} onClick={() => remove(i)} disabled={items.length <= 1}>{t('Xoá', 'Delete')}</button>
                  </div>

                  <input
                    value={it.title}
                    onChange={(e) => patchText(it.id, { title: e.target.value })}
                    placeholder={t('Tiêu đề slide', 'Slide title')}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs font-bold text-white outline-none focus:border-amber-400"
                  />
                  <textarea
                    rows={4}
                    value={it.body}
                    onChange={(e) => patchText(it.id, { body: e.target.value })}
                    placeholder={t('Nội dung (mỗi dòng là một ý)', 'Content (one bullet per line)')}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-[11px] text-slate-100 outline-none focus:border-amber-400 resize-y"
                  />

                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-300">
                    <select className={sel} value={it.layout} onChange={(e) => patch(it.id, { layout: e.target.value as SlideLayoutKind })}>
                      {LAYOUTS.map((l) => (<option key={l.v} value={l.v}>{t(l.vn, l.en)}</option>))}
                    </select>
                    <select className={sel} value={it.theme} onChange={(e) => patch(it.id, { theme: Number(e.target.value) })}>
                      <option value={-1}>{themeName(-1)}</option>
                      {SLIDE_THEMES.map((th, k) => (<option key={th.name} value={k}>{th.name}</option>))}
                    </select>
                    <select className={sel} value={it.anim} onChange={(e) => patch(it.id, { anim: e.target.value as SlideAnim })}>
                      {ANIMS.map((a) => (<option key={a.v} value={a.v}>{t(a.vn, a.en)}</option>))}
                    </select>
                    <label className="flex items-center gap-1">
                      {t('Giây', 'Sec')}
                      <input
                        type="number"
                        min={1}
                        max={120}
                        value={it.seconds}
                        onChange={(e) => patch(it.id, { seconds: Math.max(1, Math.min(120, Number(e.target.value) || 6)) })}
                        className="w-14 bg-slate-900 border border-slate-700 rounded-lg px-1.5 py-1 text-xs text-white"
                      />
                    </label>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <label className={`${btn} bg-slate-800 hover:bg-slate-700 text-slate-100 cursor-pointer`}>
                      {t('📁 Ảnh từ máy', '📁 Local photo')}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) void setLocalPhoto(it.id, f);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    <input
                      value={it.keyword}
                      onChange={(e) => patch(it.id, { keyword: e.target.value })}
                      placeholder={t('Từ khoá tìm ảnh (tiếng Anh dễ ra ảnh hơn)', 'Photo keyword')}
                      className="flex-1 min-w-[120px] bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-[11px] text-white"
                    />
                    <button type="button" className={`${btn} bg-sky-700 hover:bg-sky-600 text-white`} onClick={() => void nextStock(it.id, true)} disabled={it.busy}>{t('Tìm ảnh', 'Find')}</button>
                    <button type="button" className={`${btn} bg-slate-800 text-slate-100`} onClick={() => void nextStock(it.id)} disabled={it.busy}>{t('Ảnh khác', 'Next')}</button>
                    {it.photo && (
                      <button type="button" className={`${btn} bg-slate-800 text-slate-300`} onClick={() => patch(it.id, { photo: null })}>{t('Bỏ ảnh', 'No photo')}</button>
                    )}
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] font-black text-slate-400 uppercase">{t('Lời thoại (dán vào ô tạo giọng đọc, cũng là phụ đề)', 'Narration (paste into the voice box; also the subtitle)')}</label>
                    <textarea
                      rows={3}
                      value={it.script}
                      onChange={(e) => patch(it.id, { script: e.target.value, scriptEdited: true })}
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-[11px] text-slate-100 outline-none focus:border-amber-400 resize-y"
                    />
                  </div>
                  {it.note && <p className="text-[10px] text-amber-300">{it.note}</p>}
                </div>
              ))}
            </div>

            {msg && <p className="text-[11px] text-amber-300">{msg}</p>}
            <div className="flex justify-between gap-2 pt-1">
              <button type="button" onClick={() => setStep('input')} className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold">
                {t('← Sửa văn bản gốc', '← Edit source text')}
              </button>
              <div className="flex gap-2">
                <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold">{t('Đóng', 'Close')}</button>
                <button
                  type="button"
                  onClick={() => void confirm()}
                  disabled={working}
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 text-white text-xs font-black uppercase"
                >
                  {working ? t('Đang xử lý...', 'Working...') : t(`Thêm ${items.length} slide vào phim`, `Add ${items.length} slides to movie`)}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {playIdx !== null && items[playIdx] && (
        <SlidePlayer
          spec={specOf(items[playIdx], playIdx, items.length)}
          photo={items[playIdx].photo}
          seconds={items[playIdx].seconds}
          typewriter={deckTypewriter}
          isVN={isVN}
          onClose={() => setPlayIdx(null)}
        />
      )}
    </div>
  );
};

export default SlideMaker;
