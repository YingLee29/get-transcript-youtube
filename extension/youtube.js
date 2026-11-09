/**
 * youtube.js — Lấy phụ đề (caption) của video YouTube / Shorts.
 *
 * Vì sao không dùng API timedtext "cổ điển":
 *   YouTube hiện chặn các request không có "proof of origin" token, nên nhiều
 *   cách cũ trả về nội dung rỗng. Cách hoạt động (tại thời điểm viết):
 *   1. Đọc player response ngay trong tab YouTube đang mở (nếu có).
 *   2. Gọi InnerTube /youtubei/v1/player bằng client ANDROID_VR.
 *   3. Dự phòng: tải HTML trang watch rồi bóc ytInitialPlayerResponse.
 *   Sau đó tải phụ đề ở 3 định dạng (json3 / srv3 / srv1) và chuẩn hoá.
 *
 * File này không phụ thuộc DOM của popup nên có thể test bằng Node.
 */
(function (root) {
  'use strict';

  // Khóa công khai của YouTube Web (dùng khi không bóc được từ trang).
  const FALLBACK_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

  // Client ANDROID_VR hiện là client "dễ tính" nhất khi gọi InnerTube.
  const CLIENTS = [
    {
      name: 'ANDROID_VR',
      version: '1.60.19',
      extra: {
        deviceMake: 'Oculus',
        deviceModel: 'Quest 3',
        osName: 'Android',
        osVersion: '12',
        androidSdkVersion: 32,
      },
    },
    { name: 'WEB', version: '2.20240726.00.00', extra: {} },
  ];

  const ID_RE = /^[A-Za-z0-9_-]{11}$/;

  /** Bóc ID video từ mọi kiểu link (watch, youtu.be, shorts, live, embed). */
  function extractVideoId(input) {
    if (!input) return null;
    const s = String(input).trim();
    if (ID_RE.test(s)) return s;

    const withProto = /^https?:\/\//i.test(s) ? s : 'https://' + s;
    try {
      const u = new URL(withProto);
      const host = u.hostname.replace(/^www\.|^m\./i, '');
      if (host === 'youtu.be') {
        const id = u.pathname.split('/').filter(Boolean)[0];
        if (id && ID_RE.test(id)) return id;
      }
      if (host.endsWith('youtube.com') || host === 'youtube-nocookie.com') {
        const parts = u.pathname.split('/').filter(Boolean);
        if (['shorts', 'embed', 'live', 'v', 'e'].includes(parts[0]) && ID_RE.test(parts[1] || '')) {
          return parts[1];
        }
        const v = u.searchParams.get('v');
        if (v && ID_RE.test(v)) return v;
        if (parts[0] === 'watch' && ID_RE.test(parts[1] || '')) return parts[1];
      }
    } catch (_) {
      /* thử regex bên dưới */
    }

    const m = s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  function isYouTubeUrl(url) {
    return /(?:^|\.)youtube\.com|youtu\.be|youtube-nocookie\.com/i.test(String(url || ''));
  }

  /** Tên hiển thị của track phụ đề (YouTube trả về 2 kiểu). */
  function trackName(t) {
    if (!t || !t.name) return '';
    if (typeof t.name.simpleText === 'string') return t.name.simpleText;
    if (Array.isArray(t.name.runs)) return t.name.runs.map((r) => r.text || '').join('');
    return '';
  }

  /** Chuẩn hoá captionTracks của player response. */
  function mapTracks(data) {
    const list =
      (data && data.captions && data.captions.playerCaptionsTracklistRenderer &&
        data.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
    return list
      .map((t) => ({
        url: t.baseUrl || '',
        lang: String(t.languageCode || '').toLowerCase(),
        kind: t.kind || '',
        name: trackName(t),
      }))
      .filter((t) => t.url);
  }

  function detailsFrom(data) {
    const d = (data && data.videoDetails) || {};
    return {
      title: d.title || '',
      author: d.author || '',
      duration: Number(d.lengthSeconds) || 0,
      tracks: mapTracks(data),
    };
  }

  /**
   * Chọn track phù hợp.
   * - Ưu tiên bản gốc đúng ngôn ngữ (bản người làm, không phải ASR).
   * - Nếu không có, dùng ASR cùng ngôn ngữ.
   * - Nếu vẫn không có, lấy track bất kỳ và dịch tự động (tlang).
   */
  function pickTrack(tracks, want) {
    if (!tracks.length) return null;
    const target = String(want || 'vi').toLowerCase();
    const isAsr = (t) => t.kind === 'asr';

    if (target === 'auto') {
      const best = tracks.find((t) => !isAsr(t)) || tracks[0];
      return { track: best, translated: false };
    }

    const same = tracks.filter((t) => t.lang === target || t.lang.startsWith(target + '-'));
    if (same.length) {
      return { track: same.find((t) => !isAsr(t)) || same[0], translated: false };
    }

    const base = tracks.find((t) => !isAsr(t)) || tracks[0];
    return { track: base, translated: base.lang !== target };
  }

  /** Đọc player response đang nằm trong tab YouTube (nếu tab đó mở đúng video). */
  async function readFromTab(tabId, videoId) {
    if (!tabId || !root.chrome || !chrome.scripting) return null;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab || !tab.url || extractVideoId(tab.url) !== videoId) return null;
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          try {
            const pr =
              window.ytInitialPlayerResponse ||
              (window.ytplayer && window.ytplayer.config && window.ytplayer.config.args
                ? JSON.parse(window.ytplayer.config.args.player_response)
                : null);
            if (!pr) return null;
            return {
              title: (pr.videoDetails && pr.videoDetails.title) || '',
              author: (pr.videoDetails && pr.videoDetails.author) || '',
              duration: Number(pr.videoDetails && pr.videoDetails.lengthSeconds) || 0,
              tracks: (
                (pr.captions &&
                  pr.captions.playerCaptionsTracklistRenderer &&
                  pr.captions.playerCaptionsTracklistRenderer.captionTracks) ||
                []
              ).map((t) => ({
                url: t.baseUrl || '',
                lang: String(t.languageCode || '').toLowerCase(),
                kind: t.kind || '',
                name:
                  (t.name && t.name.simpleText) ||
                  ((t.name && t.name.runs) || []).map((r) => r.text || '').join('') ||
                  t.languageCode ||
                  '',
              })),
            };
          } catch (_) {
            return null;
          }
        },
      });
      const out = results && results[0] && results[0].result;
      return out && out.tracks && out.tracks.length ? out : null;
    } catch (_) {
      return null;
    }
  }

  /** Gọi InnerTube player (có cookie của người dùng nên ít bị chặn hơn). */
  async function playerViaInnertube(videoId, lang) {
    const hl = lang && lang !== 'auto' ? lang : 'vi';
    for (const c of CLIENTS) {
      const context = {
        client: Object.assign(
          { clientName: c.name, clientVersion: c.version, hl: hl, gl: 'VN' },
          c.extra || {}
        ),
      };
      try {
        const res = await fetch(
          'https://www.youtube.com/youtubei/v1/player?key=' + FALLBACK_KEY + '&prettyPrint=false',
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              context: context,
              videoId: videoId,
              contentCheckOk: true,
              racyCheckOk: true,
            }),
          }
        );
        if (!res.ok) continue;
        const data = await res.json();
        const info = detailsFrom(data);
        if (info.tracks.length) return info;
      } catch (_) {
        /* thử client kế tiếp */
      }
    }
    return null;
  }

  /** Tìm object JSON cân bằng ngoặc bắt đầu sau `marker` trong HTML. */
  function extractJsonAfter(html, marker) {
    const at = html.indexOf(marker);
    if (at < 0) return null;
    const start = html.indexOf('{', at + marker.length);
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) return html.slice(start, i + 1);
      }
    }
    return null;
  }

  /** Dự phòng: tải HTML trang watch và bóc player response. */
  async function playerViaHtml(videoId, lang) {
    const hl = lang && lang !== 'auto' ? lang : 'vi';
    const url =
      'https://www.youtube.com/watch?v=' +
      encodeURIComponent(videoId) +
      '&hl=' +
      hl +
      '&gl=VN&has_verified=1&bpctr=9999999999';
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    const html = await res.text();
    const raw = extractJsonAfter(html, 'ytInitialPlayerResponse');
    if (!raw) return null;

    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      return null;
    }
    const info = detailsFrom(data);
    if (!info.title) {
      const m = html.match(/<meta\s+name="title"\s+content="([^"]*)"/i);
      if (m) info.title = decodeEntities(m[1]);
    }
    return info.tracks.length ? info : null;
  }

  function decodeEntities(str) {
    return String(str || '')
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  }

  function safeChar(code) {
    try {
      return String.fromCodePoint(code);
    } catch (_) {
      return '';
    }
  }

  function parseAttributes(raw) {
    const out = {};
    const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(raw))) out[m[1]] = m[2];
    return out;
  }

  /** json3: { events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] } */
  function parseJson3(body) {
    let data;
    try {
      data = typeof body === 'string' ? JSON.parse(body) : body;
    } catch (_) {
      return [];
    }
    const events = (data && data.events) || [];
    const cues = [];
    for (const ev of events) {
      if (!ev || !ev.segs) continue;
      const text = ev.segs
        .map((s) => s.utf8 || '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) continue;
      cues.push({
        start: (Number(ev.tStartMs) || 0) / 1000,
        dur: (Number(ev.dDurationMs) || 0) / 1000,
        text: decodeEntities(text),
      });
    }
    return cues;
  }

  /**
   * srv3 (<p t=".." d=".."><s>..</s></p>) và srv1 (<text start=".." dur="..">..</text>).
   * Dùng regex thay vì DOMParser để chạy được cả trong service worker.
   */
  function parseTimedTextXml(body) {
    const xml = String(body || '');
    const cues = [];

    if (/<p[\s>]/.test(xml)) {
      const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
      let m;
      while ((m = re.exec(xml))) {
        const attrs = parseAttributes(m[1]);
        const text = decodeEntities(
          m[2]
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<[^>]+>/g, '')
            .replace(/\s+/g, ' ')
            .trim()
        );
        if (!text) continue;
        cues.push({
          start: (Number(attrs.t) || 0) / 1000,
          dur: (Number(attrs.d) || 0) / 1000,
          text: text,
        });
      }
      if (cues.length) return cues;
    }

    const re2 = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    let m2;
    while ((m2 = re2.exec(xml))) {
      const attrs = parseAttributes(m2[1]);
      const text = decodeEntities(m2[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
      if (!text) continue;
      cues.push({
        start: Number(attrs.start) || 0,
        dur: Number(attrs.dur) || 0,
        text: text,
      });
    }
    return cues;
  }

  /**
   * Tải nội dung phụ đề. YouTube có thể trả json3, srv3 hoặc XML srv1
   * tuỳ client, nên thử lần lượt và nhận dạng theo nội dung trả về.
   */
  async function fetchCues(baseUrl, opts) {
    opts = opts || {};
    const variants = [];
    const base = String(baseUrl || '');
    if (!base) return [];

    for (const fmt of ['json3', 'srv3', '']) {
      try {
        const u = new URL(base, 'https://www.youtube.com');
        if (fmt) u.searchParams.set('fmt', fmt);
        else u.searchParams.delete('fmt');
        if (opts.tlang) u.searchParams.set('tlang', opts.tlang);
        variants.push(u.toString());
      } catch (_) {
        /* bỏ qua */
      }
    }

    for (const url of variants) {
      let body = '';
      try {
        const res = await fetch(url, { credentials: 'include' });
        // 429 = YouTube đang giới hạn; thử định dạng khác cũng vô ích.
        if (res.status === 429) break;
        if (!res.ok) continue;
        body = await res.text();
      } catch (_) {
        continue;
      }
      if (!body || !body.trim()) continue;

      const trimmed = body.trim();
      // Bỏ qua trang lỗi HTML của YouTube.
      if (trimmed.startsWith('<!') || /^<html/i.test(trimmed)) continue;

      let cues = [];
      if (trimmed.charAt(0) === '{') cues = parseJson3(trimmed);
      else if (trimmed.indexOf('<') === 0) cues = parseTimedTextXml(trimmed);

      if (cues.length) return finalizeCues(cues, !!opts.isAsr);
    }
    return [];
  }

  /** Bỏ cue rỗng/trùng lặp (ASR hay lặp dòng khi cuộn), bù thời lượng thiếu. */
  function finalizeCues(cues, isAsr) {
    const out = [];
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      let text = String(c.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      // Bỏ các cue chỉ chứa nhãn như [Music], [Applause]...
      if (/^[\[(（].*[\])）]$/.test(text)) continue;

      const prev = out[out.length - 1];
      if (isAsr && prev) {
        if (text === prev.text) continue;
        if (prev.text.endsWith(text)) continue;
        if (text.startsWith(prev.text)) {
          prev.text = text;
          prev.dur = Math.max(prev.dur, c.dur || 0);
          continue;
        }
      }

      let dur = Number(c.dur) || 0;
      if (dur <= 0) {
        const next = cues[i + 1];
        dur = next && next.start > c.start ? next.start - c.start : 1.6;
      }
      out.push({ start: Math.max(0, Number(c.start) || 0), dur: Math.max(0.4, dur), text: text });
    }
    return out;
  }

  /** Ghép cue thành đoạn văn dễ đọc (ngắt theo khoảng lặng / độ dài). */
  function toParagraphs(cues, opts) {
    opts = opts || {};
    const maxLen = opts.maxLen || 620;
    const maxGap = opts.maxGap || 2.5;
    const paras = [];
    let cur = '';
    let prevEnd = 0;

    for (const c of cues) {
      const gap = c.start - prevEnd;
      if (cur && (gap > maxGap || cur.length + c.text.length + 1 > maxLen)) {
        paras.push(cur);
        cur = '';
      }
      cur = cur ? cur + ' ' + c.text : c.text;
      prevEnd = c.start + c.dur;
    }
    if (cur) paras.push(cur);
    return paras.join('\n\n');
  }

  function formatTime(sec) {
    const total = Math.max(0, sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = Math.floor(total % 60);
    const ms = Math.round((total - Math.floor(total)) * 1000);
    const pad = (n, w) => String(n).padStart(w || 2, '0');
    return pad(h) + ':' + pad(m) + ':' + pad(s) + ',' + pad(ms, 3);
  }

  /** Tạo phụ đề SRT, tự cắt cue quá dài cho dễ đọc. */
  function toSrt(cues) {
    const rows = [];
    for (const c of cues) {
      const chunks = splitCue(c.text, 90);
      const totalLen = chunks.reduce((n, x) => n + x.length, 0) || 1;
      let t = c.start;
      for (const chunk of chunks) {
        const d = Math.max(0.6, (c.dur * chunk.length) / totalLen);
        rows.push({ start: t, end: t + d, text: chunk });
        t += d;
      }
    }
    return rows
      .map((r, i) => i + 1 + '\n' + formatTime(r.start) + ' --> ' + formatTime(r.end) + '\n' + r.text)
      .join('\n\n');
  }

  function splitCue(text, maxChars) {
    if (text.length <= maxChars) return [text];
    const words = text.split(/\s+/);
    const chunks = [];
    let cur = '';
    for (const w of words) {
      if (cur && cur.length + 1 + w.length > maxChars) {
        chunks.push(cur);
        cur = w;
      } else {
        cur = cur ? cur + ' ' + w : w;
      }
    }
    if (cur) chunks.push(cur);
    return chunks.length ? chunks : [text];
  }

  /**
   * Luồng chính: videoId (+ tabId nếu đang mở video đó) -> { text, srt, title, ... }
   */
  async function fetchTranscript(options) {
    const videoId = options && options.videoId;
    const lang = (options && options.lang) || 'vi';
    if (!videoId || !ID_RE.test(videoId)) throw new Error('Link video không hợp lệ.');

    let info = null;
    let source = '';

    info = await readFromTab(options.tabId, videoId);
    if (info) source = 'tab';
    if (!info) {
      info = await playerViaInnertube(videoId, lang);
      if (info) source = 'innertube';
    }
    if (!info) {
      try {
        info = await playerViaHtml(videoId, lang);
        if (info) source = 'html';
      } catch (_) {
        /* bỏ qua */
      }
    }
    if (!info) {
      throw new Error(
        'Không truy cập được video này. Video có thể bị giới hạn tuổi / riêng tư, ' +
          'hoặc YouTube đang chặn tạm thời. Hãy thử lại hoặc dùng "AI nghe & viết".'
      );
    }
    if (!info.tracks || !info.tracks.length) {
      const err = new Error(
        'Video này không có phụ đề sẵn. Hãy dùng "AI nghe & viết" để tạo văn bản từ âm thanh.'
      );
      err.code = 'NO_CAPTIONS';
      throw err;
    }

    const picked = pickTrack(info.tracks, lang);
    if (!picked) throw new Error('Không tìm thấy track phụ đề phù hợp.');

    const targetLang = lang === 'auto' ? '' : lang;
    const isAsr = picked.track.kind === 'asr';
    let translated = picked.translated;

    let cues = await fetchCues(picked.track.url, {
      tlang: translated && targetLang ? targetLang : '',
      isAsr: isAsr,
    });

    // Dịch tự động có thể bị YouTube chặn -> quay về phụ đề gốc.
    if (!cues.length && translated) {
      translated = false;
      cues = await fetchCues(picked.track.url, { isAsr: isAsr });
    }

    if (!cues.length) {
      throw new Error(
        'Tải được danh sách phụ đề nhưng nội dung trả về rỗng (YouTube đang chặn). ' +
          'Hãy thử lại sau, hoặc dùng "AI nghe & viết".'
      );
    }

    const text = toParagraphs(cues);
    const trackLabel =
      picked.track.name ||
      picked.track.lang.toUpperCase() +
        (picked.track.kind === 'asr' ? ' (tự động)' : '');

    let note = 'Phụ đề: ' + trackLabel;
    if (picked.track.kind === 'asr') note += ' · có thể sai chính tả';
    if (translated) note += ' · dịch tự động sang ' + targetLang.toUpperCase();
    if (!translated && targetLang && picked.track.lang !== targetLang && !picked.track.lang.startsWith(targetLang + '-')) {
      note += ' · khác ngôn ngữ, dùng AI để có ' + targetLang.toUpperCase();
    }

    return {
      title: info.title || '',
      author: info.author || '',
      source: source,
      note: note,
      lang: picked.track.lang,
      translated: translated,
      cues: cues,
      text: text,
      srt: toSrt(cues),
      chars: text.length,
    };
  }

  const api = {
    extractVideoId: extractVideoId,
    isYouTubeUrl: isYouTubeUrl,
    fetchTranscript: fetchTranscript,
    fetchCues: fetchCues,
    pickTrack: pickTrack,
    parseJson3: parseJson3,
    parseTimedTextXml: parseTimedTextXml,
    toParagraphs: toParagraphs,
    toSrt: toSrt,
    extractJsonAfter: extractJsonAfter,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.YTTranscript = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
