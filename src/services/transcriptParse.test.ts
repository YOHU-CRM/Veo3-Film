import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscriptJson, geminiAudioMime } from './transcriptParse';

test('đọc JSON có rào ```json và chữ thừa', () => {
  const raw = 'Đây là kết quả:\n```json\n[{"start":0,"end":1.5,"text":"Xin chào"},{"start":1.6,"end":3,"text":" các   bạn "}]\n```';
  const c = parseTranscriptJson(raw, 10);
  assert.equal(c.length, 2);
  assert.equal(c[1].text, 'các bạn');
});

test('bỏ dòng hỏng, kéo thời gian về trong file, không cho chồng nhau', () => {
  const raw = JSON.stringify([
    { start: 2, end: 6, text: 'B' }, { start: 0, end: 3, text: 'A' },
    { start: 'x', end: 1, text: 'hỏng' }, { start: 1, end: 2, text: '' }, { start: 8, end: 20, text: 'C' },
  ]);
  const c = parseTranscriptJson(raw, 10);
  assert.deepEqual(c.map(x => x.text), ['A', 'B', 'C']);
  assert.ok(c[0].end <= c[1].start + 1e-9);
  assert.ok(c[2].end <= 10);
});

test('không phải JSON thì trả mảng rỗng', () => {
  assert.deepEqual(parseTranscriptJson('xin lỗi tôi không nghe được'), []);
  assert.deepEqual(parseTranscriptJson('[]'), []);
});

test('đoán loại âm thanh cho Gemini', () => {
  assert.equal(geminiAudioMime('audio/mpeg', 'a.mp3'), 'audio/mp3');
  assert.equal(geminiAudioMime('', 'ghi am.m4a'), 'audio/aac');
  assert.equal(geminiAudioMime('audio/wav', ''), 'audio/wav');
});
