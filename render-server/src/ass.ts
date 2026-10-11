import type { SubtitleCue, SubtitleStyle } from '../../shared/render/types';

function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

function assEscape(text: string): string {
  return text
    .replace(/[{}\\]/g, '')
    .replace(/\r?\n/g, '\\N');
}

export const SUBTITLE_FONT_FAMILY = 'Be Vietnam Pro';

/** Tạo nội dung file .ass cho 1 cảnh (thời gian tính từ đầu cảnh). */
export function buildAss(
  cues: SubtitleCue[],
  style: SubtitleStyle,
  width: number,
  height: number,
): string {
  const short = Math.min(width, height);
  const fontSize = Math.round(short * 0.052);
  const ratio = width / height;
  const marginV = Math.round(height * (ratio < 0.8 ? 0.12 : 0.07));
  const marginLR = Math.round(width * 0.06);

  // ASS màu: &HAABBGGRR
  const isBox = style === 'white_box';
  const primary = isBox ? '&H00FFFFFF' : '&H0000E6FF'; // trắng | vàng #FFE600
  const outlineColour = isBox ? '&H99000000' : '&H00000000';
  const backColour = isBox ? '&H99000000' : '&H64000000';
  const borderStyle = isBox ? 3 : 1;
  const outline = isBox ? Math.round(fontSize * 0.35) : Math.max(3, Math.round(fontSize * 0.09));
  const shadow = isBox ? 0 : Math.max(1, Math.round(fontSize * 0.03));

  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${SUBTITLE_FONT_FAMILY},${fontSize},${primary},&H000000FF,${outlineColour},${backColour},-1,0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},2,${marginLR},${marginLR},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const cue of cues) {
    lines.push(`Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${assEscape(cue.text)}`);
  }
  return lines.join('\n') + '\n';
}
