import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyAudioBatch, classifyFile } from './classify';
import { extractPdfText } from './pdf';
import { balancedGroups, splitScriptToScenes } from './script';
import { expandZip, zipEntryFileName } from './zip';
import { ingestFiles } from './index';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string, type = '') => new File([fs.readFileSync(path.join(FIX, name))], name, { type });

test('classifyFile: nhận đúng loại, bỏ file rác', () => {
  assert.equal(classifyFile('Veo3_clip_01.MP4'), 'video');
  assert.equal(classifyFile('anh.JPG'), 'image');
  assert.equal(classifyFile('a.webp'), 'image');
  assert.equal(classifyFile('voice_1.wav'), 'audio');
  assert.equal(classifyFile('kich ban.pdf'), 'pdf');
  assert.equal(classifyFile('goi.zip'), 'zip');
  assert.equal(classifyFile('kichban.txt'), 'text');
  assert.equal(classifyFile('phude.srt'), 'text');
  assert.equal(classifyFile('.DS_Store'), 'ignore');
  assert.equal(classifyFile('Thumbs.db'), 'ignore');
  assert.equal(classifyFile('__MACOSX/canh_1/._video.mp4'), 'ignore');
  assert.equal(classifyFile('abc.xyz'), 'unknown');
  assert.equal(classifyFile('khongduoi', 'video/mp4'), 'video');
});

test('classifyAudioBatch: phân biệt voice và nhạc nền', () => {
  const r = classifyAudioBatch([
    { name: 'nhac_nen.mp3', duration: 150, number: null },
    { name: 'voice_01.wav', duration: 5, number: 1 },
    { name: 'voice_02.wav', duration: 6, number: 2 },
    { name: 'Giọng đọc 3.mp3', duration: 4, number: 3 },
    { name: 'abc.mp3', duration: 200, number: null },   // dài, không số -> đoán là nhạc
    { name: 'xyz.mp3', duration: 4, number: null },     // ngắn, không số -> đoán là voice
  ]);
  const role = (n: string) => r.find(x => x.item.name === n)!;
  assert.equal(role('nhac_nen.mp3').role, 'music');
  assert.equal(role('voice_01.wav').role, 'voice');
  assert.equal(role('Giọng đọc 3.mp3').role, 'voice');
  // Chỉ giữ 1 file nhạc: ưu tiên file có tên nói rõ là nhạc (dù ngắn hơn file được đoán)
  assert.equal(r.filter(x => x.role === 'music').length, 1);
  assert.equal(role('abc.mp3').role, 'voice');
  assert.equal(role('abc.mp3').guessed, true);
  assert.equal(role('xyz.mp3').role, 'voice');
  assert.equal(role('xyz.mp3').guessed, true);
});

test('splitScriptToScenes: có nhãn "Cảnh N"', () => {
  const t = 'Cảnh 1: Mở đầu bầu trời.\nCảnh 2: Con thuyền ra khơi\nvà sóng vỗ nhẹ.\nCảnh 3: Kết thúc.';
  const r = splitScriptToScenes(t, 3);
  assert.equal(r.method, 'markers');
  assert.deepEqual(r.lines, ['Mở đầu bầu trời.', 'Con thuyền ra khơi và sóng vỗ nhẹ.', 'Kết thúc.']);
});

test('splitScriptToScenes: số đoạn bằng số cảnh', () => {
  const r = splitScriptToScenes('Đoạn một.\n\nĐoạn hai.\n\nĐoạn ba.', 3);
  assert.equal(r.method, 'paragraphs');
  assert.deepEqual(r.lines, ['Đoạn một.', 'Đoạn hai.', 'Đoạn ba.']);
});

test('splitScriptToScenes: 1 đoạn văn dài -> chia theo câu, cân bằng, không mất chữ', () => {
  const text = 'Câu một khá dài để thử. Câu hai ngắn. Câu ba cũng dài vừa phải đấy. Câu bốn. Câu năm kết thúc bài.';
  const r = splitScriptToScenes(text, 3);
  assert.equal(r.method, 'sentences');
  assert.equal(r.lines.length, 3);
  assert.ok(r.lines.every(Boolean));
  assert.equal(r.lines.join(' '), text);
});

test('splitScriptToScenes: ít câu hơn cảnh -> cảnh dư để trống; nhiều đoạn hơn cảnh -> gộp', () => {
  assert.deepEqual(splitScriptToScenes('Chỉ một câu.', 3).lines, ['Chỉ một câu.', '', '']);
  const many = splitScriptToScenes('A.\n\nB.\n\nC.\n\nD.\n\nE.', 2);
  assert.equal(many.lines.length, 2);
  assert.equal(many.lines.join(' ').replace(/\s/g, ''), 'A.B.C.D.E.');
});

test('splitScriptToScenes: bỏ số trang, nối dòng bị ngắt cứng, đọc SRT', () => {
  const pdfLike = 'Mặt trời lên chậm\nrãi sau ngọn sóng.\n\n1\n\nCon thuyền rời bến.';
  const r = splitScriptToScenes(pdfLike, 2);
  assert.deepEqual(r.lines, ['Mặt trời lên chậm rãi sau ngọn sóng.', 'Con thuyền rời bến.']);

  const srt = '1\n00:00:00,000 --> 00:00:02,000\nXin chào\n\n2\n00:00:02,000 --> 00:00:04,000\nTạm biệt';
  const s = splitScriptToScenes(srt, 2);
  assert.equal(s.method, 'srt');
  assert.deepEqual(s.lines, ['Xin chào', 'Tạm biệt']);
});

test('balancedGroups: mỗi nhóm có ít nhất 1 đoạn khi đủ đoạn', () => {
  const g = balancedGroups(['aaaaaaaaaa', 'b', 'c', 'd', 'eeeeeeeeee'], 4);
  assert.equal(g.length, 4);
  assert.ok(g.every(Boolean));
});

test('zipEntryFileName: lấy số cảnh từ tên thư mục khi tên file không có', () => {
  assert.equal(zipEntryFileName('canh_03/video.mp4'), 'canh_03_video.mp4');
  assert.equal(zipEntryFileName('Veo3_clip_07.mp4'), 'Veo3_clip_07.mp4');
  assert.equal(zipEntryFileName('goi/anh_02.jpg'), 'anh_02.jpg');
  assert.equal(zipEntryFileName('thu_muc/ghi_chu.txt'), 'ghi_chu.txt');
});

test('expandZip: mở ZIP thật, bỏ file rác, ghép tên thư mục', async () => {
  const r = await expandZip(fixture('test.zip'), 'test.zip');
  const names = r.files.map(f => f.name).sort();
  assert.deepEqual(names, ['canh_01_video.mp4', 'canh_01_voice.mp3', 'canh_02_video.mp4', 'nhac_nen.wav']);
  assert.ok(r.files.every(f => f.size > 0));
  assert.deepEqual(r.warnings, []);
});

test('expandZip: file hỏng không làm sập, trả cảnh báo', async () => {
  const r = await expandZip(new Blob([Buffer.from('khong phai zip')]), 'hong.zip');
  assert.equal(r.files.length, 0);
  assert.ok(r.warnings.some(w => w.includes('hong.zip')));
});

test('extractPdfText: đọc chữ tiếng Việt có dấu từ PDF thật', async () => {
  const r = await extractPdfText(fixture('kichban.pdf'));
  assert.equal(r.pages, 2);
  assert.equal(r.scanned, false);
  assert.ok(r.text.includes('Buổi sáng yên bình trên biển'), r.text);
  assert.ok(r.text.includes('Hoàng hôn buông xuống'), r.text);
  // đưa qua bộ chia: ra đúng 3 cảnh nhờ nhãn "Cảnh N"
  const split = splitScriptToScenes(r.text, 3);
  assert.equal(split.method, 'markers');
  assert.ok(split.lines[0].startsWith('Buổi sáng yên bình'));
  assert.ok(split.lines[2].includes('Hoàng hôn'));
});

test('extractPdfText: PDF không có chữ -> báo là bản scan', async () => {
  const r = await extractPdfText(fixture('scan.pdf'));
  assert.equal(r.scanned, true);
});

test('ingestFiles: thả lẫn ZIP + PDF + TXT + ảnh + file lạ -> phân loại đủ', async () => {
  const res = await ingestFiles(
    [
      fixture('test.zip'),
      fixture('kichban.pdf'),
      fixture('scan.pdf'),
      new File(['Cảnh 1: a\nCảnh 2: b'], 'loi.txt', { type: 'text/plain' }),
      new File([new Uint8Array([1, 2, 3])], 'anh_01.png'),
      new File([new Uint8Array([1])], 'la.xyz'),
    ],
    { readPdf: f => extractPdfText(f) },
  );
  assert.equal(res.zipsOpened, 1);
  assert.equal(res.videos.length, 2);
  assert.equal(res.audios.length, 2);   // voice.mp3 + nhac_nen.wav
  assert.equal(res.images.length, 1);
  assert.equal(res.scripts.length, 2);  // pdf có chữ + txt
  assert.ok(res.warnings.some(w => w.includes('scan.pdf')), 'phải cảnh báo PDF scan');
  assert.ok(res.warnings.some(w => w.includes('la.xyz')), 'phải cảnh báo file lạ');
});
