/**
 * Chuyển nhiều loại dữ liệu đầu vào thành các "cảnh ảnh" để dựng video:
 *  - PDF       → mỗi trang = 1 ảnh slide (giữ nguyên hình dạng trang)
 *  - Word      → chia theo tiêu đề / đoạn → mỗi phần = 1 slide chữ đẹp
 *  - PowerPoint→ mỗi slide: nếu là ảnh thì lấy ảnh, nếu là chữ thì dựng lại slide chữ
 *  - TXT / MD / văn bản dán vào → chia đoạn → slide chữ
 * Chạy hoàn toàn trên trình duyệt, không gửi file đi đâu.
 */
import JSZip from 'jszip';
import { renderSlideBlob, type TextSlideSpec, type SlidePhotoRef } from './slideRender';

export interface ImportedSlide {
  blob: Blob;
  name: string;
  /** chữ của slide, dùng làm lời thoại / phụ đề gợi ý */
  text: string;
  /** số giây gợi ý theo tốc độ đọc */
  seconds: number;
  width: number;
  height: number;
  /** Slide chữ: thông số để vẽ nét + hiệu ứng khi dựng phim */
  spec?: TextSlideSpec;
}

const MAX_PAGES = 80;

/** Số giây đủ để đọc hết đoạn chữ (khoảng 2.6 từ/giây + 2 giây đệm) */
export function readingSeconds(text: string): number {
  const words = (text || '').trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 6;
  return Math.max(5, Math.min(30, Math.round(words / 2.6) + 2));
}

const pad3 = (n: number) => String(n).padStart(3, '0');

function canvasToBlob(c: HTMLCanvasElement, type = 'image/png', q?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Không tạo được ảnh slide'))), type, q);
  });
}

export interface SlideDraft {
  title: string;
  paras: string[];
}

export function draftPlainText(d: SlideDraft): string {
  return [d.title, ...d.paras].filter(Boolean).join('. ');
}

/** Dựng 1 slide chữ: ảnh "đã gõ xong" (xem trước / dự phòng) + thông số để vẽ nét & có hiệu ứng lúc dựng phim */
export async function makeTextSlide(spec: TextSlideSpec, photo: SlidePhotoRef | null, baseName = 'slide', text?: string): Promise<ImportedSlide> {
  const blob = await renderSlideBlob(spec, photo, 1920, 1080);
  const plain = text ?? draftPlainText({ title: spec.title, paras: spec.paras });
  return { blob, name: `${baseName}_${pad3(spec.index + 1)}.png`, text: plain, seconds: readingSeconds(plain), width: 1920, height: 1080, spec };
}

export function defaultSpec(d: SlideDraft, index: number, total: number): TextSlideSpec {
  return { title: d.title, paras: d.paras, layout: 'auto', theme: -1, anim: 'typewriter', index, total };
}

const sentencesOf = (t: string) => t.split(/(?<=[.!?…])\s+/).map((x) => x.trim()).filter(Boolean);
const lenOf = (d: SlideDraft) => (d.title + ' ' + d.paras.join(' ')).length;

function parseChunk(chunk: string): SlideDraft {
  const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
  let title = '';
  if (lines.length > 0) {
    const f = lines[0];
    if (/^#{1,6}\s/.test(f)) {
      title = f.replace(/^#{1,6}\s*/, '').trim();
      lines.shift();
    } else if (lines.length > 1 && f.length <= 70 && !/[.!?…:;,]$/.test(f)) {
      title = f;
      lines.shift();
    }
  }
  return { title, paras: lines.map((l) => l.replace(/^[-*•]\s*/, '').trim()).filter(Boolean) };
}

function autoDrafts(text: string): SlideDraft[] {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const drafts: SlideDraft[] = [];
  let cur: SlideDraft | null = null;
  const push = () => {
    if (cur && (cur.title || cur.paras.length)) drafts.push(cur);
    cur = null;
  };
  const isHeading = (b: string, hasNext: boolean) =>
    /^#{1,6}\s/.test(b) || (hasNext && b.length <= 70 && !/[.!?…:;,]$/.test(b) && !b.includes('\n'));

  blocks.forEach((b, i) => {
    const hasNext = i < blocks.length - 1;
    if (isHeading(b, hasNext)) {
      push();
      cur = { title: b.replace(/^#{1,6}\s*/, '').trim(), paras: [] };
      return;
    }
    if (!cur) cur = { title: '', paras: [] };
    const lines = b.split('\n').map((l) => l.replace(/^[-*•]\s*/, '').trim()).filter(Boolean);
    const used = (cur as SlideDraft).paras.join(' ').length;
    if (used + b.length > 520 && (cur as SlideDraft).paras.length > 0) {
      const t = (cur as SlideDraft).title;
      push();
      cur = { title: t ? `${t} (tiếp)` : '', paras: [] };
    }
    (cur as SlideDraft).paras.push(...lines);
  });
  push();
  return drafts;
}

function mergeToCount(drafts: SlideDraft[], count: number): SlideDraft[] {
  const list = drafts.map((d) => ({ title: d.title, paras: [...d.paras] }));
  while (list.length > count && list.length > 1) {
    let bi = 0;
    let best = Infinity;
    for (let i = 0; i < list.length - 1; i++) {
      const sz = lenOf(list[i]) + lenOf(list[i + 1]);
      if (sz < best) { best = sz; bi = i; }
    }
    const a = list[bi], b = list[bi + 1];
    list.splice(bi, 2, { title: a.title || b.title, paras: [...a.paras, ...(a.title && b.title ? [b.title] : []), ...b.paras] });
  }
  return list;
}

function splitToCount(drafts: SlideDraft[], count: number): SlideDraft[] {
  const list = drafts.map((d) => ({ title: d.title, paras: [...d.paras] }));
  let guard = 0;
  while (list.length < count && guard++ < 200) {
    // chọn slide dài nhất còn chia được
    const order = list.map((d, i) => ({ i, n: lenOf(d) })).sort((x, y) => y.n - x.n);
    let done = false;
    for (const { i } of order) {
      const d = list[i];
      let paras = d.paras;
      if (paras.length < 2) {
        const sents = paras.length === 1 ? sentencesOf(paras[0]) : [];
        if (sents.length < 2) continue;
        paras = sents;
      }
      const total = paras.join(' ').length;
      let acc = 0;
      let cut = 1;
      for (let k = 0; k < paras.length - 1; k++) {
        acc += paras[k].length;
        cut = k + 1;
        if (acc >= total / 2) break;
      }
      list.splice(i, 1, { title: d.title, paras: paras.slice(0, cut) }, { title: d.title ? `${d.title} (tiếp)` : '', paras: paras.slice(cut) });
      done = true;
      break;
    }
    if (!done) break;
  }
  return list;
}

/**
 * Chia văn bản thành các bản nháp slide.
 *  - Có dòng chỉ gồm --- : cắt đúng ở những dòng đó (tự chọn chữ cho từng slide).
 *  - Có count: chia đúng số slide mong muốn (gộp hoặc tách theo độ dài).
 *  - Còn lại: tự động theo tiêu đề / đoạn / độ dài.
 */
export function splitTextToDrafts(raw: string, opts?: { count?: number }): SlideDraft[] {
  const text = (raw || '').replace(/\r/g, '').trim();
  if (!text) return [];
  if (/^\s*-{3,}\s*$/m.test(text)) {
    return text.split(/^\s*-{3,}\s*$/m).map((c) => c.trim()).filter(Boolean).map(parseChunk).filter((d) => d.title || d.paras.length);
  }
  let drafts = autoDrafts(text);
  const count = opts?.count && opts.count > 0 ? Math.min(60, Math.round(opts.count)) : 0;
  if (count && drafts.length > count) drafts = mergeToCount(drafts, count);
  else if (count && drafts.length < count) drafts = splitToCount(drafts, count);
  return drafts;
}

export async function textToSlides(raw: string, baseName = 'slide', opts?: { count?: number }): Promise<ImportedSlide[]> {
  const drafts = splitTextToDrafts(raw, opts);
  const out: ImportedSlide[] = [];
  for (let i = 0; i < drafts.length; i++) out.push(await makeTextSlide(defaultSpec(drafts[i], i, drafts.length), null, baseName));
  return out;
}

/* ───────────────────────── PDF ───────────────────────── */

async function pdfToSlides(file: File, baseName: string): Promise<ImportedSlide[]> {
  const pdfjs = await import('pdfjs-dist');
  // @ts-ignore - Vite trả về đường dẫn file worker
  const workerUrl: string = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const n = Math.min(doc.numPages, MAX_PAGES);
  const out: ImportedSlide[] = [];
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const v1 = page.getViewport({ scale: 1 });
    const scale = 3200 / Math.max(v1.width, v1.height);
    const viewport = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.round(viewport.width);
    c.height = Math.round(viewport.height);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    let text = '';
    try {
      const tc = await page.getTextContent();
      text = tc.items.map((it) => ('str' in it ? (it as { str: string }).str : '')).join(' ').replace(/\s+/g, ' ').trim();
    } catch {
      text = '';
    }
    const blob = await canvasToBlob(c, 'image/jpeg', 0.95);
    out.push({ blob, name: `${baseName}_${pad3(i)}.jpg`, text, seconds: text ? readingSeconds(text) : 6, width: c.width, height: c.height });
  }
  return out;
}

/* ───────────────────────── Word (.docx) ───────────────────────── */

async function docxToSlides(file: File, baseName: string): Promise<ImportedSlide[]> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const f = zip.file('word/document.xml');
  if (!f) throw new Error('File Word không hợp lệ (không thấy nội dung)');
  const xml = new DOMParser().parseFromString(await f.async('string'), 'application/xml');
  const paras = Array.from(xml.getElementsByTagName('w:p'));
  const lines: string[] = [];
  for (const p of paras) {
    const text = Array.from(p.getElementsByTagName('w:t')).map((t) => t.textContent || '').join('').trim();
    if (!text) {
      lines.push('');
      continue;
    }
    const style = p.getElementsByTagName('w:pStyle')[0]?.getAttribute('w:val') || '';
    lines.push(/^(Heading|Title|Tiêu|Ti)/i.test(style) ? `# ${text}` : text);
  }
  // mỗi đoạn Word cách nhau 1 dòng trống để thuật toán chia slide nhận ra
  const joined = lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n\n');
  return textToSlides(joined, baseName);
}

/* ───────────────────────── PowerPoint (.pptx) ───────────────────────── */

async function pptxToSlides(file: File, baseName: string): Promise<ImportedSlide[]> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const slideFiles = Object.keys(zip.files)
    .map((p) => ({ p, m: p.match(/^ppt\/slides\/slide(\d+)\.xml$/) }))
    .filter((x) => x.m)
    .sort((a, b) => parseInt(a.m![1], 10) - parseInt(b.m![1], 10));
  if (slideFiles.length === 0) throw new Error('File PowerPoint không hợp lệ (không thấy slide)');

  const out: ImportedSlide[] = [];
  const total = Math.min(slideFiles.length, MAX_PAGES);
  for (let i = 0; i < total; i++) {
    const { p, m } = slideFiles[i];
    const xml = new DOMParser().parseFromString(await zip.file(p)!.async('string'), 'application/xml');
    const paras = Array.from(xml.getElementsByTagName('a:p'))
      .map((x) => Array.from(x.getElementsByTagName('a:t')).map((t) => t.textContent || '').join('').trim())
      .filter(Boolean);
    const textLen = paras.join(' ').length;
    const hasPic = xml.getElementsByTagName('p:pic').length > 0;

    // Slide chỉ là 1 ảnh (xuất từ Canva, ảnh chụp...) → lấy luôn ảnh
    if (hasPic && textLen < 40) {
      const relFile = zip.file(`ppt/slides/_rels/slide${m![1]}.xml.rels`);
      if (relFile) {
        const rels = new DOMParser().parseFromString(await relFile.async('string'), 'application/xml');
        const imgRel = Array.from(rels.getElementsByTagName('Relationship')).find((r) => (r.getAttribute('Type') || '').endsWith('/image'));
        const target = imgRel?.getAttribute('Target');
        if (target) {
          const mediaPath = 'ppt/' + target.replace(/^\.\.\//, '');
          const mf = zip.file(mediaPath);
          if (mf) {
            const ext = (mediaPath.split('.').pop() || 'png').toLowerCase();
            const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
            if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
              const blob = new Blob([await mf.async('arraybuffer')], { type: mime });
              let w = 1920, h = 1080;
              try {
                const bmp = await createImageBitmap(blob);
                w = bmp.width;
                h = bmp.height;
                bmp.close();
              } catch {
                // giữ mặc định
              }
              out.push({ blob, name: `${baseName}_${pad3(i + 1)}.${ext === 'jpeg' ? 'jpg' : ext}`, text: paras.join('. '), seconds: paras.length ? readingSeconds(paras.join(' ')) : 6, width: w, height: h });
              continue;
            }
          }
        }
      }
    }

    // Slide chữ → dựng lại
    const title = paras[0] || '';
    const body = paras.slice(1);
    out.push(await makeTextSlide(defaultSpec({ title, paras: body }, i, total), null, baseName, paras.join('. ')));
  }
  return out;
}

/** Nhận 1 file bất kỳ (pdf, docx, pptx, txt, md) và trả về danh sách slide */
export async function importDocument(file: File): Promise<ImportedSlide[]> {
  const name = file.name.replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_') || 'slide';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return pdfToSlides(file, name);
  if (ext === 'docx') return docxToSlides(file, name);
  if (ext === 'pptx') return pptxToSlides(file, name);
  if (ext === 'txt' || ext === 'md' || file.type.startsWith('text/')) return textToSlides(await file.text(), name);
  throw new Error(`Chưa hỗ trợ định dạng .${ext}. Dùng: PDF, Word (.docx), PowerPoint (.pptx), TXT, MD.`);
}
