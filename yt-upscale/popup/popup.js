/**
 * YT Upscale - Popup Logic
 * Light Theme UI Controller with live metrics & storage sync
 */
(() => {
  'use strict';

  const DEFAULT_SETTINGS = {
    enabled: true,
    algorithm: 'easu',
    scaleMode: 'fit'
  };

  let settings = { ...DEFAULT_SETTINGS };
  let pollInterval = null;

  // DOM Elements
  const el = {
    toggleEnabled: document.getElementById('toggleEnabled'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    fpsBadge: document.getElementById('fpsBadge'),
    nativeRes: document.getElementById('nativeRes'),
    outputRes: document.getElementById('outputRes'),
    drmWarning: document.getElementById('drmWarning'),
    drmText: document.getElementById('drmText'),
    radioEASU: document.querySelector('input[value="easu"]'),
    radioLanczos: document.querySelector('input[value="lanczos"]'),
    labelEASU: document.getElementById('labelEASU'),
    labelLanczos: document.getElementById('labelLanczos'),
    btnFit: document.getElementById('btnFit'),
    btn2x: document.getElementById('btn2x'),
    saveIndicator: document.getElementById('saveIndicator')
  };

  // Cập nhật giao diện theo cài đặt
  function updateUI() {
    el.toggleEnabled.checked = settings.enabled;

    // Algorithm radio
    if (settings.algorithm === 'easu') {
      el.radioEASU.checked = true;
      el.labelEASU.classList.add('active');
      el.labelLanczos.classList.remove('active');
    } else {
      el.radioLanczos.checked = true;
      el.labelLanczos.classList.add('active');
      el.labelEASU.classList.remove('active');
    }

    // Scale buttons
    if (settings.scaleMode === 'fit') {
      el.btnFit.classList.add('active');
      el.btn2x.classList.remove('active');
    } else {
      el.btn2x.classList.add('active');
      el.btnFit.classList.remove('active');
    }

    if (!settings.enabled) {
      el.statusDot.classList.remove('active');
      el.statusText.textContent = 'Đã tắt extension';
      el.fpsBadge.textContent = '0 FPS';
    }
  }

  // Lưu cài đặt vào chrome.storage
  async function saveSettings(patch) {
    settings = { ...settings, ...patch };
    updateUI();
    try {
      await chrome.storage.sync.set(settings);
      showSavedFlash();
    } catch (err) {
      console.error('Không thể lưu cài đặt:', err);
    }
    queryActiveTabStatus();
  }

  let saveTimer = null;
  function showSavedFlash() {
    el.saveIndicator.textContent = '✓ Đã lưu tức thì';
    el.saveIndicator.style.opacity = '1';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      el.saveIndicator.textContent = '✓ Đã đồng bộ';
      el.saveIndicator.style.opacity = '0.7';
    }, 1200);
  }

  // Truy vấn thông tin runtime từ Tab YouTube đang mở
  async function queryActiveTabStatus() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id || !tab.url || !tab.url.includes('youtube.com')) {
        el.statusDot.classList.remove('active');
        el.statusText.textContent = 'Mở một video YouTube';
        el.nativeRes.textContent = '---';
        el.outputRes.textContent = '---';
        el.fpsBadge.textContent = '0 FPS';
        el.drmWarning.style.display = 'none';
        return;
      }

      chrome.tabs.sendMessage(tab.id, { type: 'yt-upscale:get-status' }, (response) => {
        if (chrome.runtime.lastError || !response || !response.ok) {
          el.statusDot.classList.remove('active');
          el.statusText.textContent = 'Đang đợi video…';
          el.fpsBadge.textContent = '0 FPS';
          el.drmWarning.style.display = 'none';
          return;
        }

        // Cập nhật trạng thái
        if (response.isTainted) {
          el.statusDot.classList.remove('active');
          el.statusText.textContent = 'Bị chặn DRM';
          el.drmWarning.style.display = 'flex';
          el.drmText.textContent = response.taintedReason || 'Video DRM, không thể capture.';
        } else if (response.active) {
          el.statusDot.classList.add('active');
          el.statusText.textContent = 'Đang Upscale WebGL';
          el.drmWarning.style.display = 'none';
        } else {
          el.statusDot.classList.remove('active');
          el.statusText.textContent = settings.enabled ? 'Video đang tạm dừng' : 'Đã tắt extension';
          el.drmWarning.style.display = 'none';
        }

        el.nativeRes.textContent = response.nativeRes || '---';
        el.outputRes.textContent = response.outputRes || '---';
        el.fpsBadge.textContent = `${response.fps || 0} FPS`;
      });
    } catch (e) {
      // Ignored
    }
  }

  // Gắn sự kiện
  function bindEvents() {
    el.toggleEnabled.addEventListener('change', () => {
      saveSettings({ enabled: el.toggleEnabled.checked });
    });

    el.radioEASU.addEventListener('change', () => {
      if (el.radioEASU.checked) saveSettings({ algorithm: 'easu' });
    });

    el.radioLanczos.addEventListener('change', () => {
      if (el.radioLanczos.checked) saveSettings({ algorithm: 'lanczos' });
    });

    el.btnFit.addEventListener('click', () => {
      saveSettings({ scaleMode: 'fit' });
    });

    el.btn2x.addEventListener('click', () => {
      saveSettings({ scaleMode: '2x' });
    });
  }

  // Khởi động
  async function init() {
    bindEvents();
    try {
      const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      settings = { ...DEFAULT_SETTINGS, ...stored };
    } catch (e) {
      settings = { ...DEFAULT_SETTINGS };
    }
    updateUI();
    queryActiveTabStatus();

    // Poll trạng thái mỗi giây
    pollInterval = setInterval(queryActiveTabStatus, 1000);
    window.addEventListener('unload', () => {
      if (pollInterval) clearInterval(pollInterval);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
