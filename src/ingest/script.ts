/**
 * Biến một đoạn văn bản (từ PDF / TXT / SRT / dán vào) thành lời thoại cho từng cảnh.
 * HÀM THUẦN, không gọi AI, không tốn phí.
 */

export type ScriptMethod = 'markers' | 'srt' | 'paragraphs' | 'sentences' | 'empty';

export interface ScriptSplit {
  lines: string[];       // đúng sceneCount phần tử (cảnh thiếu chữ = chuỗi rỗng)
  method: ScriptMethod;
  /** Số đoạn chữ tìm được trong văn bản gốc */
  units: number;
}

const MARKER = /^\s*(?:c[aảâ]nh|scene|shot|đo[aạ]n|ph[aầ]n)\s*(\d{1,4})\s*[:.\-–—)]?\s*/i;

export function normalizeText(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00A0\u200B]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/-\n(?=[a-zà-ỹ])/g, '') // từ bị ngắt dòng bằng dấu gạch nối
    .trim();
}

function parseSrt(text: string): string[] | null {
  if (!/-->/.test(text)) return null;
  const blocks = text.split(/\n{2,}/);
  const out: string[] = [];
  for (const b of blocks) {
    const lines = b.split('\n').map(l => l.trim()).filter(Boolean);
    const ts = lines.findIndex(l => /-->/.test(l));
    if (ts < 0) continue;
    const content = lines.slice(ts + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (content) out.push(content);
  }
  return out.length ? out : null;
}

function splitMarkers(text: string): string[] | null {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let cur: string[] | null = null;
  for (const line of lines) {
    const m = line.match(MARKER);
    if (m) {
      if (cur) blocks.push(cur.join(' ').trim());
      cur = [line.replace(MARKER, '').trim()];
    } else if (cur) {
      cur.push(line.trim());
    }
  }
  if (cur) blocks.push(cur.join(' ').trim());
  const nonEmpty = blocks.filter(Boolean);
  return nonEmpty.length >= 2 ? nonEmpty : null;
}

/** Tách đoạn văn: dòng trống phân tách; dòng bị ngắt cứng giữa câu được nối lại; bỏ số trang đứng một mình */
function splitParagraphs(text: string): string[] {
  const cleaned = text
    .split('\n')
    .filter(l => !/^\s*(?:trang\s*|page\s*)?\d{1,4}\s*(?:\/\s*\d{1,4})?\s*$/i.test(l))
    .join('\n');
  return cleaned
    .split(/\n{2,}/)
    .map(p => p.split('\n').map(l => l.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export function splitSentences(text: string): string[] {
  const m = text.match(/[^.!?…。！？]+(?:[.!?…。！？]+["”’)\]]*|$)/g);
  return (m ?? [text]).map(s => s.trim()).filter(Boolean);
}

/** Chia `units` thành n nhóm liên tiếp, độ dài chữ mỗi nhóm gần bằng nhau */
export function balancedGroups(units: string[], n: number): string[] {
  const out: string[] = [];
  let i = 0;
  let remaining = units.reduce((a, u) => a + u.length, 0);
  for (let g = 0; g < n; g++) {
    const groupsLeft = n - g;
    const unitsLeft = units.length - i;
    if (unitsLeft <= 0) { out.push(''); continue; }
    if (unitsLeft <= groupsLeft) { out.push(units[i++]); remaining -= out[g].length; continue; }
    // Nhóm cuối nhận hết phần còn lại để không bỏ sót chữ nào
    if (groupsLeft === 1) { out.push(units.slice(i).join(' ')); i = units.length; remaining = 0; continue; }
    const target = remaining / groupsLeft;
    let cur = units[i++];
    // Thêm đoạn kế tiếp nếu làm nhóm gần mục tiêu hơn, nhưng chừa đủ đoạn cho các nhóm sau
    while (i < units.length - (groupsLeft - 1)) {
      const next = units[i];
      if (Math.abs(cur.length + 1 + next.length - target) < Math.abs(cur.length - target)) {
        cur += ' ' + next;
        i++;
      } else break;
    }
    out.push(cur);
    remaining -= cur.length;
  }
  return out;
}

export function splitScriptToScenes(raw: string, sceneCount: number): ScriptSplit {
  const n = Math.max(0, Math.floor(sceneCount));
  const text = normalizeText(raw || '');
  if (!text || n === 0) return { lines: new Array(n).fill(''), method: 'empty', units: 0 };

  const fit = (parts: string[]): string[] => {
    if (parts.length <= n) return [...parts, ...new Array(n - parts.length).fill('')];
    // Thừa đoạn -> gộp phần dư vào cảnh cuối
    return [...parts.slice(0, n - 1), parts.slice(n - 1).join(' ')];
  };

  const srt = parseSrt(text);
  if (srt) return { lines: fit(srt), method: 'srt', units: srt.length };

  const marked = splitMarkers(text);
  if (marked) return { lines: fit(marked), method: 'markers', units: marked.length };

  const paragraphs = splitParagraphs(text);
  if (paragraphs.length === n) return { lines: paragraphs, method: 'paragraphs', units: n };

  if (paragraphs.length > n) {
    return { lines: balancedGroups(paragraphs, n), method: 'paragraphs', units: paragraphs.length };
  }
  const sentences = paragraphs.flatMap(splitSentences);
  return { lines: balancedGroups(sentences, n), method: 'sentences', units: sentences.length };
}
