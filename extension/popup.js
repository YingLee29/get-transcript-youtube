/**
 * popup.js — Giao diện và luồng xử lý của extension.
 */
(function () {
  'use strict';

  const DEFAULTS = {
    serverUrl: 'http://127.0.0.1:8765',
    model: 'small',
    autoFallback: true,
    lang: 'vi',
  };

  const el = (id) => document.getElementById(id);
  const YT = window.YTTranscript;

  const state = {
    text: '',
    srt: '',
    title: '',
    tab: 'text',
    busy: false,
    poll: null,
    tabId: null,
    serverOk: null,
  };

  /* ------------------------------------------------------------
   * Tiện ích
   * ---------------------------------------------------------- */

  function getSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(DEFAULTS, (v) => resolve(Object.assign({}, DEFAULTS, v || {})));
      } catch (_) {
        resolve(Object.assign({}, DEFAULTS));
      }
    });
  }

  function saveSettings(values) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(values, resolve);
      } catch (_) {
        resolve();
      }
    });
  }

  function fetchWithTimeout(url, options, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms || 8000);
    return fetch(url, Object.assign({}, options, { signal: controller.signal })).finally(() =>
      clearTimeout(timer)
    );
  }

  function normalizeServer(url) {
    let s = String(url || '').trim() || DEFAULTS.serverUrl;
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    return s.replace(/\/+$/, '');
  }

  function showStatus(text, kind, progress) {
    const box = el('status');
    const hint = el('statusHint');
    box.hidden = false;
    box.classList.remove('status-ok', 'status-error');
    if (kind === 'ok') box.classList.add('status-ok');
    if (kind === 'error') box.classList.add('status-error');

    el('statusText').textContent = text;
    el('statusHint').hidden = true;
    hint.textContent = '';

    const bar = el('bar');
    if (typeof progress === 'number' && progress >= 0) {
      bar.hidden = false;
      el('barFill').style.width = Math.max(2, Math.min(100, progress)) + '%';
    } else {
      bar.hidden = true;
      el('barFill').style.width = '0%';
    }
  }

  function showHint(text) {
    const hint = el('statusHint');
    hint.hidden = false;
    hint.textContent = text;
  }

  function hideStatus() {
    el('status').hidden = true;
  }

  function setBusy(busy) {
    state.busy = busy;
    el('btnCaptions').disabled = busy;
    el('btnAi').disabled = busy;
  }

  function stopPolling() {
    if (state.poll) {
      clearInterval(state.poll);
      state.poll = null;
    }
  }

  function chars(n) {
    return n.toLocaleString('vi-VN');
  }

  function slug(name) {
    const s = String(name || 'transcript')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/gi, 'd')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    return s || 'transcript';
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: (mime || 'text/plain') + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /* ------------------------------------------------------------
   * Hiển thị kết quả
   * ---------------------------------------------------------- */

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    const out = el('out');
    out.classList.toggle('srt', tab === 'srt');
    out.textContent = tab === 'srt' ? state.srt || '(không có SRT)' : state.text;
    out.scrollTop = 0;
  }

  function updateStats() {
    const t = state.text || '';
    const words = t.trim() ? t.trim().split(/\s+/).length : 0;
    const minutes = Math.max(1, Math.round(words / 200));
    el('stats').textContent =
      chars(t.length) + ' ký tự · ' + chars(words) + ' từ · đọc khoảng ' + minutes + ' phút';
  }

  function render(data) {
    state.text = (data.text || '').trim();
    state.srt = (data.srt || '').trim();
    state.title = data.title || '';

    el('videoTitle').textContent = state.title || 'Văn bản video';
    el('videoMeta').textContent = data.note || '';
    el('result').hidden = false;
    document.querySelector('.tab[data-tab="srt"]').hidden = !state.srt;

    setTab('text');
    updateStats();
    el('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ------------------------------------------------------------
   * Đọc input
   * ---------------------------------------------------------- */

  function readInput() {
    const raw = el('url').value.trim();
    if (!raw) {
      showStatus('Bạn chưa dán link video.', 'error');
      el('url').focus();
      return null;
    }
    const id = YT.extractVideoId(raw);
    if (!id) {
      showStatus('Link không hợp lệ. Ví dụ: https://youtu.be/xxxxxxx', 'error');
      el('url').focus();
      return null;
    }
    return { raw: raw, id: id, url: 'https://www.youtube.com/shorts/' + id };
  }

  /* ------------------------------------------------------------
   * Server AI
   * ---------------------------------------------------------- */

  async function checkServer(settings, quiet) {
    const base = normalizeServer(settings.serverUrl);
    try {
      const res = await fetchWithTimeout(base + '/health', { method: 'GET' }, 2500);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const info = await res.json();
      state.serverOk = { base: base, info: info };
      const label = el('serverState');
      label.classList.remove('off');
      label.classList.add('ok');
      label.title = 'Thiết bị: ' + (info.device || '?') + ' · Model: ' + (info.model || '?');
      label.textContent = 'AI sẵn sàng (' + (info.model || '?') + ')';
      return state.serverOk;
    } catch (_) {
      state.serverOk = null;
      if (!quiet) {
        const label = el('serverState');
        label.classList.remove('ok');
        label.classList.add('off');
        label.textContent = 'AI chưa bật';
      }
      return null;
    }
  }

  function startJob(base, jobId) {
    stopPolling();
    let failures = 0;

    state.poll = setInterval(async () => {
      let job;
      try {
        const res = await fetchWithTimeout(base + '/transcribe/' + jobId, { method: 'GET' }, 8000);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        job = await res.json();
        failures = 0;
      } catch (_) {
        failures += 1;
        if (failures >= 4) {
          stopPolling();
          setBusy(false);
          showStatus('Mất kết nối tới server AI. Kiểm tra Terminal đang chạy.', 'error', -1);
        }
        return;
      }

      if (job.status === 'error') {
        stopPolling();
        setBusy(false);
        showStatus(job.error || 'AI xử lý thất bại.', 'error', -1);
        showHint(job.hint || '');
        return;
      }

      if (job.status === 'done') {
        stopPolling();
        setBusy(false);
        hideStatus();
        const note =
          'AI Whisper (' +
          (job.model || '?') +
          ')' +
          (job.detected_language ? ' · ngôn ngữ: ' + job.detected_language : '') +
          (job.duration ? ' · ' + formatDuration(job.duration) : '');
        render({ text: job.text, srt: job.srt, title: job.title, note: note });
        return;
      }

      showStatus(job.message || 'Đang xử lý…', 'busy', Number(job.progress) || 0);
    }, 1200);
  }

  function formatDuration(sec) {
    const s = Math.round(Number(sec) || 0);
    const m = Math.floor(s / 60);
    return m > 0 ? m + ' phút ' + (s % 60) + ' giây' : s + ' giây';
  }

  /* ------------------------------------------------------------
   * Hành động
   * ---------------------------------------------------------- */

  async function runCaptions() {
    if (state.busy) return;
    const v = readInput();
    if (!v) return;

    stopPolling();
    el('result').hidden = true;
    setBusy(true);
    showStatus('Đang lấy phụ đề từ YouTube…', 'busy', -1);

    try {
      const data = await YT.fetchTranscript({
        videoId: v.id,
        tabId: state.tabId,
        lang: el('lang').value,
      });
      hideStatus();
      setBusy(false);
      render(data);
    } catch (err) {
      setBusy(false);
      const settings = await getSettings();
      const noCaptions =
        err.code === 'NO_CAPTIONS' || /không có phụ đề sẵn/i.test(err.message || '');

      if (noCaptions && el('autoFallback').checked) {
        const server = await checkServer(settings, true);
        if (server) {
          showStatus('Video không có phụ đề — chuyển sang AI Whisper…', 'busy', 0);
          await runAi(v, settings);
          return;
        }
        showStatus('Video này không có phụ đề sẵn.', 'error', -1);
        showHint(
          'Bật server AI để chuyển âm thanh thành văn bản:\n' +
            'cd server\npip install -r requirements.txt\npython app.py'
        );
        return;
      }

      showStatus(err.message || 'Không lấy được phụ đề.', 'error', -1);
    }
  }

  async function runAi(existing, existingSettings) {
    if (state.busy && !existing) return;
    const v = existing || readInput();
    if (!v) return;

    const settings = existingSettings || (await getSettings());
    const base = normalizeServer(settings.serverUrl);

    stopPolling();
    el('result').hidden = true;
    setBusy(true);
    showStatus('Đang kiểm tra server AI…', 'busy', -1);

    const server = await checkServer(settings, true);
    if (!server) {
      setBusy(false);
      showStatus('Chưa kết nối được server AI.', 'error', -1);
      showHint(
        'Mở Terminal và chạy:\n' +
          'cd server\npip install -r requirements.txt\npython app.py\n\n' +
          'Sau đó thử lại. Cài đặt server: ' + base
      );
      return;
    }

    showStatus('Đang gửi video tới AI…', 'busy', 1);

    let job;
    try {
      const res = await fetchWithTimeout(
        base + '/transcribe',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: 'https://www.youtube.com/watch?v=' + v.id,
            language: el('lang').value,
            model: settings.model,
          }),
        },
        20000
      );
      if (!res.ok) {
        let detail = '';
        try {
          const j = await res.json();
          detail = j.detail || j.error || '';
        } catch (_) {}
        throw new Error(detail || 'Server trả về lỗi ' + res.status);
      }
      job = await res.json();
    } catch (err) {
      setBusy(false);
      showStatus(err.message || 'Không gửi được yêu cầu tới server AI.', 'error', -1);
      return;
    }

    startJob(base, job.job_id);
  }

  /* ------------------------------------------------------------
   * Khởi tạo
   * ---------------------------------------------------------- */

  async function prefillFromTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (!tab || !tab.url || !YT.isYouTubeUrl(tab.url)) return;
      const id = YT.extractVideoId(tab.url);
      if (!id) return;
      state.tabId = tab.id;
      el('url').value = tab.url;
      el('subtitle').textContent = 'Đã nhận link từ tab đang mở';
    } catch (_) {
      /* bỏ qua */
    }
  }

  function openSettings() {
    el('settings').hidden = false;
  }

  function closeSettings() {
    el('settings').hidden = true;
  }

  function wire() {
    el('btnCaptions').addEventListener('click', runCaptions);
    el('btnAi').addEventListener('click', () => runAi(null));

    el('pasteBtn').addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          el('url').value = text.trim();
          el('subtitle').textContent = 'Đã dán link từ clipboard';
        }
      } catch (_) {
        showStatus('Không đọc được clipboard. Hãy dán bằng Ctrl+V.', 'error', -1);
      }
    });

    el('url').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) runAi(null);
        else runCaptions();
      }
    });

    document.querySelectorAll('.tab').forEach((b) => {
      b.addEventListener('click', () => setTab(b.dataset.tab));
    });

    el('copyBtn').addEventListener('click', async () => {
      const text = state.tab === 'srt' ? state.srt : state.text;
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        const btn = el('copyBtn');
        const old = btn.textContent;
        btn.textContent = 'Đã sao chép ✓';
        setTimeout(() => (btn.textContent = old), 1400);
      } catch (_) {
        showStatus('Không sao chép được. Hãy bôi đen và Ctrl+C.', 'error', -1);
      }
    });

    el('dlTxtBtn').addEventListener('click', () => {
      if (!state.text) return;
      const head = state.title ? state.title + '\n\n' : '';
      download(slug(state.title) + '.txt', head + state.text, 'text/plain');
    });

    el('dlSrtBtn').addEventListener('click', () => {
      if (!state.srt) return;
      download(slug(state.title) + '.srt', state.srt, 'application/x-subrip');
    });

    el('settingsBtn').addEventListener('click', openSettings);
    el('helpBtn').addEventListener('click', openSettings);
    el('closeSettings').addEventListener('click', closeSettings);
    el('settings').addEventListener('click', (e) => {
      if (e.target === el('settings')) closeSettings();
    });

    el('saveSettings').addEventListener('click', async () => {
      const values = {
        serverUrl: normalizeServer(el('serverUrl').value),
        model: el('model').value,
        autoFallback: el('autoFallback').checked,
        lang: el('lang').value,
      };
      await saveSettings(values);
      el('serverUrl').value = values.serverUrl;
      closeSettings();
      await checkServer(values, false);
    });

    el('testServer').addEventListener('click', async () => {
      const btn = el('testServer');
      const old = btn.textContent;
      btn.textContent = 'Đang kiểm tra…';
      const server = await checkServer({ serverUrl: el('serverUrl').value }, true);
      btn.textContent = old;
      if (server) {
        const info = server.info || {};
        showStatus(
          'Kết nối OK · ' +
            (info.device || '?') +
            ' · model ' +
            (info.model || '?') +
            (info.loaded ? ' (đã nạp)' : ' (sẽ nạp khi dùng)'),
          'ok',
          -1
        );
      } else {
        showStatus('Không kết nối được: ' + normalizeServer(el('serverUrl').value), 'error', -1);
        showHint('Kiểm tra server đã chạy chưa: python app.py');
      }
    });

    window.addEventListener('unload', stopPolling);
  }

  async function init() {
    wire();
    const settings = await getSettings();
    el('serverUrl').value = settings.serverUrl;
    el('model').value = settings.model;
    el('autoFallback').checked = !!settings.autoFallback;
    el('lang').value = settings.lang || 'vi';

    el('lang').addEventListener('change', () => saveSettings({ lang: el('lang').value }));
    el('autoFallback').addEventListener('change', () =>
      saveSettings({ autoFallback: el('autoFallback').checked })
    );

    await prefillFromTab();
    checkServer(settings, false);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
