/**
 * Đọc CHỮ trong file PowerPoint (.pptx), Word (.docx), Excel (.xlsx).
 * Các file này thực chất là ZIP chứa XML nên đọc được hoàn toàn trong trình duyệt.
 *
 * Giới hạn: chỉ lấy CHỮ (để làm kịch bản / phụ đề). Không vẽ lại hình ảnh của slide;
 * muốn có hình thì xuất file sang PDF hoặc ảnh rồi thả vào.
 */
import JSZip from 'jszip';

export type OfficeExt = 'pptx' | 'docx' | 'xlsx';

export interface OfficeText {
  /** Mỗi phần tử: nội dung 1 slide (pptx) / 1 đoạn văn (docx) / 1 ô chữ (xlsx) */
  units: string[];
  /** Toàn bộ chữ, các đơn vị cách nhau 1 dòng trống */
  text: string;
}

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&amp;/g, '&');

/** Gom chữ trong các thẻ <tag>...</tag> (vd a:t, w:t) của một đoạn XML */
function textRuns(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let out = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out += decodeXml(m[1]);
  return out;
}

/** Tách thành các đoạn theo thẻ <paraTag> rồi gom chữ theo <textTag> */
function paragraphs(xml: string, paraTag: string, textTag: string): string[] {
  const re = new RegExp(`<${paraTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${paraTag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const t = textRuns(m[1], textTag).replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
  }
  return out;
}

const numKey = (name: string) => parseInt(name.match(/(\d+)\.xml$/)?.[1] || '0', 10);

export async function extractOfficeText(data: Blob | ArrayBuffer | Uint8Array, ext: OfficeExt): Promise<OfficeText> {
  const zip = await JSZip.loadAsync(data as any);
  const units: string[] = [];

  if (ext === 'pptx') {
    const slides = Object.keys(zip.files)
      .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => numKey(a) - numKey(b));
    for (const name of slides) {
      const xml = await zip.files[name].async('string');
      const lines = paragraphs(xml, 'a:p', 'a:t');
      if (lines.length) units.push(lines.join('\n'));
    }
  } else if (ext === 'docx') {
    const f = zip.files['word/document.xml'];
    if (f) units.push(...paragraphs(await f.async('string'), 'w:p', 'w:t'));
  } else {
    // Chữ dùng chung (Excel thường lưu ở đây) + chữ nằm thẳng trong ô (một số phần mềm lưu kiểu này)
    const shared: string[] = [];
    const sf = zip.files['xl/sharedStrings.xml'];
    if (sf) {
      const xml = await sf.async('string');
      const re = /<si>([\s\S]*?)<\/si>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(xml))) shared.push(textRuns(m[1], 't').replace(/\s+/g, ' ').trim());
    }
    const sheets = Object.keys(zip.files)
      .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((x, y) => numKey(x) - numKey(y));
    for (const name of sheets) {
      const xml = await zip.files[name].async('string');
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let m: RegExpExecArray | null;
      while ((m = cellRe.exec(xml))) {
        const attrs = m[1] || '';
        const body = m[2] || '';
        let t = '';
        if (/\bt="s"/.test(attrs)) {
          const v = body.match(/<v>(\d+)<\/v>/);
          if (v) t = shared[parseInt(v[1], 10)] || '';
        } else if (/\bt="inlineStr"/.test(attrs)) {
          t = textRuns(body, 't').replace(/\s+/g, ' ').trim();
        }
        if (t) units.push(t);
      }
    }
  }
  return { units, text: units.join('\n\n') };
}
