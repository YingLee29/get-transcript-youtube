const assert = require('assert');
const YT = require('../extension/youtube.js');

// --- ID ---
const cases = {
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ': 'dQw4w9WgXcQ',
  'https://youtu.be/dQw4w9WgXcQ?t=10': 'dQw4w9WgXcQ',
  'https://www.youtube.com/shorts/dQw4w9WgXcQ': 'dQw4w9WgXcQ',
  'https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share': 'dQw4w9WgXcQ',
  'https://www.youtube.com/live/dQw4w9WgXcQ': 'dQw4w9WgXcQ',
  'https://www.youtube.com/embed/dQw4w9WgXcQ': 'dQw4w9WgXcQ',
  'youtube.com/watch?v=dQw4w9WgXcQ': 'dQw4w9WgXcQ',
  'dQw4w9WgXcQ': 'dQw4w9WgXcQ',
  'https://example.com/abc': null,
};
for (const [input, want] of Object.entries(cases)) {
  assert.strictEqual(YT.extractVideoId(input), want, input);
}

// --- srv3 (định dạng YouTube thực tế trả về) ---
const srv3 = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3">
<head><ws id="0"/><wp id="0"/></head>
<body>
<w t="0" id="1" wp="1" ws="1"/>
<p t="320" d="14260" w="1">[Music]</p>
<p t="18790" w="1" a="1">
</p>
<p t="18800" d="7160" w="1"><s ac="0">We&#39;re</s><s t="239" ac="0"> no</s><s t="559" ac="0"> strangers</s><s t="1040" ac="0"> to</s></p>
<p t="21800" d="7319" w="1"><s ac="0">love.</s><s t="1000" ac="0"> You</s><s t="1400" ac="0"> know</s></p>
</body></timedtext>`;
const cues = YT.parseTimedTextXml(srv3);
assert.strictEqual(cues.length, 3, 'parse cues: got ' + cues.length);
assert.strictEqual(cues[0].text, "[Music]");
assert.ok(cues[1].text.startsWith("We're no strangers to"), cues[1].text);
assert.ok(cues[1].start > 18.7 && cues[1].start < 18.9, 'start=' + cues[1].start);

// --- json3 ---
const j3 = JSON.stringify({ events: [
  { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Xin chào ' }, { utf8: 'các bạn' }] },
  { tStartMs: 3000, dDurationMs: 0, segs: [{ utf8: 'hôm nay' }] },
  { tStartMs: 3500, segs: [] },
]});
const cues2 = YT.parseJson3(j3);
assert.strictEqual(cues2.length, 2);
assert.strictEqual(cues2[0].text, 'Xin chào các bạn');

// --- SRT ---
const srt = YT.toSrt([{ start: 0, dur: 2.5, text: 'Xin chào các bạn' }, { start: 65.25, dur: 3, text: 'Nội dung tiếp theo' }]);
assert.ok(srt.includes('1\n00:00:00,000 --> 00:00:02,500'), srt);
assert.ok(srt.includes('00:01:05,250 --> 00:01:08,250'), srt);

// --- paragraphs ---
const text = YT.toParagraphs([
  { start: 0, dur: 2, text: 'Câu một.' },
  { start: 9, dur: 2, text: 'Câu hai.' },
]);
assert.strictEqual(text, 'Câu một.\n\nCâu hai.');

// --- pickTrack ---
const tracks = [
  { url: 'u1', lang: 'en', kind: '', name: 'English' },
  { url: 'u2', lang: 'en', kind: 'asr', name: 'English auto' },
  { url: 'u3', lang: 'vi', kind: 'asr', name: 'Tiếng Việt auto' },
];
assert.strictEqual(YT.pickTrack(tracks, 'vi').track.url, 'u3');
assert.strictEqual(YT.pickTrack(tracks, 'vi').translated, false);
const t2 = YT.pickTrack([tracks[0]], 'vi');
assert.strictEqual(t2.track.url, 'u1');
assert.strictEqual(t2.translated, true);

console.log('✓ tất cả test logic YouTube đều đạt');
