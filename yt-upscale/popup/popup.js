/**
 * YT Upscale - Popup Logic v1.1.0
 */
(() => {
  'use strict';

  const DEFAULT_SETTINGS = {
    enabled: true,
    algorithm: 'easu',
    scaleMode: '2x',
    sharpness: 75,
    splitScreen: false,
    showHud: true
  };

  let settings = { ...DEFAULT_SETTINGS };
  let pollInterval = null;

  // DOM Elements
  const el = {
    toggleEnabled: document.getElementById('toggleEnabled'),
    toggleSplitScreen: document.getElementById('toggleSplitScreen'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    fpsBadge: document.getElementById('fpsBadge'),
    nativeRes: document.getElementById('nativeRes'),
    outputRes: document.getElementById('outputRes'),
    drmWarning: document.getElementById('drmWarning'),
    drmText: document.getElementById('drmText'),
    sliderSharpness: document.getElementById('sliderSharpness'),
    sharpnessVal: document.getElementById('sharpnessVal'),
    btn2x: document.getElementById('btn2x'),
    btn15x: document.getElementById('btn15x'),
    btnFit: document.getElementById('btnFit'),
    radioEASU: document.querySelector('input[value="easu"]'),
    radioLanczos: document.querySelector('input[value="lanczos"]'),
    labelEASU: document.getElementById('labelEASU'),
    labelLanczos: document.getElementById('labelLanczos'),
    saveIndicator: document.getElementById('saveIndicator')
  };

  function updateUI() {
    el.toggleEnabled.checked = settings.enabled;
    el.toggleSplitScreen.checked = settings.splitScreen;
    el.sliderSharpness.value = settings.sharpness;
    el.sharpnessVal.textContent = `${settings.sharpness}%`;

    // Algorithm
    if (settings.algorithm === 'easu') {
      el.radioEASU.checked = true;
      el.labelEASU.classList.add('active');
      el.labelLanczos.classList.remove('active');
    } else {
      el.radioLanczos.checked = true;
      el.labelLanczos.classList.add('active');
      el.labelEASU.classList.remove('active');
    }

    // Scale
    [el.btn2x, el.btn15x, el.btnFit].forEach(btn => btn.classList.remove('active'));
    if (settings.scaleMode === '2x') el.btn2x.classList.add('active');
    else if (settings.scaleMode === '1.5x') el.btn15x.classList.add('active');
    else el.btnFit.classList.add('active');

    if (!settings.enabled) {
      el.statusDot.classList.remove('active');
      el.statusText.textContent = 'Đã tắt extension';
      el.fpsBadge.textContent = '0 FPS';
    }
  }

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
    el.saveIndicator.textContent = '✓ Đã đồng bộ';
    el.saveIndicator.style.opacity = '1';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      el.saveIndicator.style.opacity = '0.7';
    }, 1200);
  }

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
          el.statusText.textContent = 'Đang đợi video… (F5 tab)';
          el.fpsBadge.textContent = '0 FPS';
          el.drmWarning.style.display = 'none';
          return;
        }

        if (response.isTainted) {
          el.statusDot.classList.remove('active');
          el.statusText.textContent = 'Bị chặn DRM';
          el.drmWarning.style.display = 'flex';
          el.drmText.textContent = response.taintedReason || 'Video DRM, không thể capture.';
        } else if (response.active) {
          el.statusDot.classList.add('active');
          el.statusText.textContent = settings.splitScreen ? 'Đang so sánh Trái / Phải' : 'Đang Upscale WebGL';
          el.drmWarning.style.display = 'none';
        } else {
          el.statusDot.classList.remove('active');
          el.statusText.textContent = settings.enabled ? 'Video tạm dừng' : 'Đã tắt extension';
          el.drmWarning.style.display = 'none';
        }

        el.nativeRes.textContent = response.nativeRes || '---';
        el.outputRes.textContent = response.outputRes || '---';
        el.fpsBadge.textContent = `${response.fps || 0} FPS`;
      });
    } catch (e) {}
  }

  function bindEvents() {
    el.toggleEnabled.addEventListener('change', () => {
      saveSettings({ enabled: el.toggleEnabled.checked });
    });

    el.toggleSplitScreen.addEventListener('change', () => {
      saveSettings({ splitScreen: el.toggleSplitScreen.checked });
    });

    el.sliderSharpness.addEventListener('input', () => {
      el.sharpnessVal.textContent = `${el.sliderSharpness.value}%`;
    });

    el.sliderSharpness.addEventListener('change', () => {
      saveSettings({ sharpness: Number(el.sliderSharpness.value) });
    });

    el.radioEASU.addEventListener('change', () => {
      if (el.radioEASU.checked) saveSettings({ algorithm: 'easu' });
    });

    el.radioLanczos.addEventListener('change', () => {
      if (el.radioLanczos.checked) saveSettings({ algorithm: 'lanczos' });
    });

    el.btn2x.addEventListener('click', () => saveSettings({ scaleMode: '2x' }));
    el.btn15x.addEventListener('click', () => saveSettings({ scaleMode: '1.5x' }));
    el.btnFit.addEventListener('click', () => saveSettings({ scaleMode: 'fit' }));
  }

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

    pollInterval = setInterval(queryActiveTabStatus, 1000);
    window.addEventListener('unload', () => {
      if (pollInterval) clearInterval(pollInterval);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
