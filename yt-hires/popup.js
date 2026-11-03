/**
 * YT Hi-Res — popup controller.
 *
 * Settings are saved straight into chrome.storage.sync on every change; the
 * content script listens for the change and applies it without a reload.
 */
(() => {
  'use strict';

  const ALLOWED_CAPS = [1080, 1440, 2160, 4320];
  const DEFAULT_SETTINGS = { enabled: true, cap: 2160 };
  const POLL_MS = 1000;

  const elements = {
    enabled: document.getElementById('enabled'),
    dot: document.getElementById('status-dot'),
    title: document.getElementById('status-title'),
    sub: document.getElementById('status-sub'),
    saveState: document.getElementById('save-state'),
    availableHint: document.getElementById('available-hint'),
    capInputs: Array.from(document.querySelectorAll('input[name="cap"]'))
  };

  let settings = { ...DEFAULT_SETTINGS };
  let activeTabId = null;
  let pollTimer = null;
  let pollToken = 0;
  let saveTimer = null;
  let lastStatus = null;

  function normalizeSettings(raw) {
    const cap = Number(raw && raw.cap);
    return {
      enabled: !(raw && raw.enabled === false),
      cap: ALLOWED_CAPS.includes(cap) ? cap : DEFAULT_SETTINGS.cap
    };
  }

  function renderControls() {
    elements.enabled.checked = settings.enabled;
    for (const input of elements.capInputs) {
      input.checked = Number(input.value) === settings.cap;
    }
    document.body.classList.toggle('is-off', !settings.enabled);
  }

  function formatHeight(height) {
    return height ? `${height}p` : null;
  }

  function currentQualityText(status) {
    if (status.currentLabel) return status.currentLabel;
    const formatted = formatHeight(status.currentHeight);
    if (formatted) return formatted;
    if (status.current === 'auto') return 'Auto';
    return 'chưa xác định';
  }

  function setStatus(kind, title, sub) {
    const dotKind = { ok: 'is-ok', wait: 'is-wait', warn: 'is-warn', off: 'is-off' }[kind];
    elements.dot.className = 'status-dot ' + dotKind;
    elements.title.textContent = title;
    elements.sub.textContent = sub;
  }

  function renderStatus(status) {
    if (!settings.enabled) {
      setStatus('off', 'Đã tắt', 'Bật công tắc để áp dụng lại.');
      elements.availableHint.textContent = 'Extension đang tạm dừng.';
      return;
    }
    if (!status) {
      setStatus('wait', 'Đang kiểm tra…', 'Đang kết nối với YouTube.');
      return;
    }
    if (status.mode === 'disabled') {
      setStatus('off', 'Đã tắt', 'Bật công tắc để áp dụng lại.');
      return;
    }
    if (status.mode === 'error') {
      setStatus(
        'warn',
        'Không tìm thấy trình phát',
        'YouTube có thể đã thay đổi API. Hãy tải lại trang.'
      );
      return;
    }
    if (status.mode === 'waiting') {
      if (status.reason === 'no-levels' || status.reason === 'no-target') {
        setStatus('wait', 'Đang chờ video…', 'Chất lượng sẽ được áp dụng khi video sẵn sàng.');
      } else {
        setStatus('wait', 'Chưa có video', 'Mở một video YouTube để áp dụng.');
      }
      const max = formatHeight(status.maxAvailable);
      elements.availableHint.textContent = max
        ? `Video hỗ trợ tới ${max}.`
        : 'Đang đọc độ phân giải khả dụng của video…';
      return;
    }

    const target = formatHeight(status.targetHeight) || 'mức trần';
    const max = formatHeight(status.maxAvailable);
    if (status.ad) {
      setStatus('wait', 'Đang phát quảng cáo', 'Sẽ áp dụng lại ngay sau quảng cáo.');
    } else if (status.current === status.target && status.target) {
      setStatus(
        'ok',
        `Đang phát ${currentQualityText(status)}`,
        `Mức trần ${settings.cap}p${max ? ` · video tối đa ${max}` : ''}`
      );
    } else {
      setStatus(
        'wait',
        `Đang chuyển sang ${target}…`,
        `Hiện tại: ${currentQualityText(status)}`
      );
    }

    if (max) {
      const cap = settings.cap;
      elements.availableHint.textContent =
        status.maxAvailable > cap
          ? `Video hỗ trợ tới ${max} · đang giới hạn ở ${cap}p.`
          : `Video hỗ trợ tới ${max}.`;
    } else {
      elements.availableHint.textContent = 'Đang đọc độ phân giải khả dụng của video…';
    }
  }

  function showSaved() {
    elements.saveState.textContent = 'Đã lưu';
    elements.saveState.classList.add('is-visible');
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      elements.saveState.classList.remove('is-visible');
    }, 1300);
  }

  async function saveSettings(patch) {
    settings = normalizeSettings({ ...settings, ...patch });
    renderControls();
    renderStatus(lastStatus);
    try {
      await chrome.storage.sync.set({ enabled: settings.enabled, cap: settings.cap });
      showSaved();
    } catch (error) {
      elements.saveState.textContent = 'Không lưu được';
      elements.saveState.classList.add('is-visible');
    }
    refreshStatus();
  }

  async function getActiveTabId() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      activeTabId = tabs && tabs[0] ? tabs[0].id : null;
    } catch (error) {
      activeTabId = null;
    }
    return activeTabId;
  }

  async function refreshStatus() {
    const token = ++pollToken;
    const tabId = await getActiveTabId();
    if (tabId === null) {
      renderStatus(null);
      return;
    }
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: 'yt-hires:get-status'
      });
      if (token !== pollToken) return;
      if (!response || !response.ok) {
        setStatus(
          'warn',
          'Chưa kết nối',
          'Mở một video YouTube (tải lại trang nếu vừa cài extension).'
        );
        return;
      }
      lastStatus = { ...response.status, enabled: settings.enabled, cap: settings.cap };
      renderStatus(lastStatus);
    } catch (error) {
      if (token !== pollToken) return;
      setStatus(
        'warn',
        'Chưa kết nối',
        'Mở một video YouTube (tải lại trang nếu vừa cài extension).'
      );
    }
  }

  function onSettingsChanged(changes, areaName) {
    if (areaName !== 'sync') return;
    if (!('enabled' in changes) && !('cap' in changes)) return;
    const next = { ...settings };
    if ('enabled' in changes && changes.enabled.newValue !== undefined) {
      next.enabled = changes.enabled.newValue !== false;
    }
    if ('cap' in changes && changes.cap.newValue !== undefined) {
      next.cap = changes.cap.newValue;
    }
    settings = normalizeSettings(next);
    renderControls();
    renderStatus(lastStatus);
  }

  async function init() {
    elements.enabled.addEventListener('change', () => {
      saveSettings({ enabled: elements.enabled.checked });
    });
    for (const input of elements.capInputs) {
      input.addEventListener('change', () => {
        if (!input.checked) return;
        saveSettings({ cap: Number(input.value) });
      });
    }
    chrome.storage.onChanged.addListener(onSettingsChanged);

    try {
      settings = normalizeSettings(await chrome.storage.sync.get(DEFAULT_SETTINGS));
    } catch (error) {
      settings = { ...DEFAULT_SETTINGS };
    }
    renderControls();
    renderStatus(null);

    await refreshStatus();
    pollTimer = setInterval(refreshStatus, POLL_MS);
    window.addEventListener('unload', () => {
      if (pollTimer) clearInterval(pollTimer);
    });
  }

  init();
})();
