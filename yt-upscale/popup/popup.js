/**
 * YT Upscale - Popup Logic v2.0 ULTRA
 */
(() => {
  'use strict';

  const DEFAULT_SETTINGS = {
    enabled: true,
    preset: 'anime4k',
    scaleMode: '4k',
    strength: 1.8,
    splitScreen: false,
    splitPos: 0.5,
    showHud: true
  };

  let settings = { ...DEFAULT_SETTINGS };
  let pollInterval = null;

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
    sliderStrength: document.getElementById('sliderStrength'),
    strengthVal: document.getElementById('strengthVal'),
    btn4k: document.getElementById('btn4k'),
    btn2x: document.getElementById('btn2x'),
    btnAuto: document.getElementById('btnAuto'),
    presetRadios: document.querySelectorAll('input[name="preset"]'),
    radioCards: {
      anime4k: document.getElementById('labelAnime4k'),
      cinema4k: document.getElementById('labelCinema'),
      esports: document.getElementById('labelEsports'),
      fsr: document.getElementById('labelFSR')
    }
  };

  function updateUI() {
    el.toggleEnabled.checked = settings.enabled;
    el.toggleSplitScreen.checked = settings.splitScreen;
    
    const pct = Math.round(settings.strength * 100);
    el.sliderStrength.value = pct;
    el.strengthVal.textContent = `${pct}%`;

    // Presets
    el.presetRadios.forEach(r => {
      r.checked = (r.value === settings.preset);
      const card = el.radioCards[r.value];
      if (card) {
        if (r.checked) card.classList.add('active');
        else card.classList.remove('active');
      }
    });

    // Scale buttons
    [el.btn4k, el.btn2x, el.btnAuto].forEach(btn => btn.classList.remove('active'));
    if (settings.scaleMode === '4k') el.btn4k.classList.add('active');
    else if (settings.scaleMode === '2x') el.btn2x.classList.add('active');
    else el.btnAuto.classList.add('active');

    if (!settings.enabled) {
      el.statusDot.classList.remove('active');
      el.statusText.textContent = 'Đã tắt extension (Bấm U để bật)';
      el.fpsBadge.textContent = '0 FPS';
    }
  }

  async function saveSettings(patch) {
    settings = { ...settings, ...patch };
    updateUI();
    try {
      await chrome.storage.sync.set(settings);
    } catch (err) {
      console.error('Không thể lưu:', err);
    }
    queryActiveTabStatus();
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
          el.statusText.textContent = 'Đang đợi video… (F5 tab nếu vừa cài)';
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
          el.statusText.textContent = settings.splitScreen ? 'Đang so sánh Trái / Phải' : 'Đang Upscale GPU 4K';
          el.drmWarning.style.display = 'none';
        } else {
          el.statusDot.classList.remove('active');
          el.statusText.textContent = settings.enabled ? 'Video tạm dừng' : 'Đã tắt extension';
          el.drmWarning.style.display = 'none';
        }

        el.nativeRes.textContent = response.nativeRes || '---';
        el.outputRes.textContent = response.outputRes || '3840×2160 (4K)';
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

    el.sliderStrength.addEventListener('input', () => {
      el.strengthVal.textContent = `${el.sliderStrength.value}%`;
    });

    el.sliderStrength.addEventListener('change', () => {
      saveSettings({ strength: Number(el.sliderStrength.value) / 100.0 });
    });

    el.presetRadios.forEach(radio => {
      radio.addEventListener('change', () => {
        if (radio.checked) saveSettings({ preset: radio.value });
      });
    });

    el.btn4k.addEventListener('click', () => saveSettings({ scaleMode: '4k' }));
    el.btn2x.addEventListener('click', () => saveSettings({ scaleMode: '2x' }));
    el.btnAuto.addEventListener('click', () => saveSettings({ scaleMode: 'auto' }));
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
