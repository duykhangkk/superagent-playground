/**
 * YT Hi-Res — isolated-world bridge.
 *
 * Reads the user settings from chrome.storage and relays them to page.js in
 * YouTube's MAIN world. It also answers status queries from the popup.
 */
(() => {
  'use strict';

  if (window.__ytHiresBridgeLoaded) return;
  window.__ytHiresBridgeLoaded = true;

  const ALLOWED_CAPS = [1080, 1440, 2160, 4320];
  const DEFAULT_SETTINGS = { enabled: true, cap: 2160 };
  const BRIDGE_OUT = 'yt-hires:bridge';
  const PAGE_IN = 'yt-hires:page';

  let settings = { ...DEFAULT_SETTINGS };
  let lastStatus = {
    enabled: settings.enabled,
    cap: settings.cap,
    mode: 'waiting',
    reason: 'starting',
    updatedAt: Date.now()
  };

  function normalizeSettings(raw) {
    const cap = Number(raw && raw.cap);
    return {
      enabled: !(raw && raw.enabled === false),
      cap: ALLOWED_CAPS.includes(cap) ? cap : DEFAULT_SETTINGS.cap
    };
  }

  function postSettings() {
    window.postMessage(
      { source: BRIDGE_OUT, type: 'settings', settings },
      location.origin
    );
  }

  function readStoredSettings(callback) {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
      settings = normalizeSettings(stored);
      lastStatus = { ...lastStatus, enabled: settings.enabled, cap: settings.cap };
      postSettings();
      if (typeof callback === 'function') callback(settings);
    });
  }

  window.addEventListener(
    'message',
    (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const data = event.data;
      if (!data || data.source !== PAGE_IN) return;
      if (data.type === 'hello') {
        postSettings();
      } else if (data.type === 'status' && data.status) {
        lastStatus = { ...data.status, enabled: settings.enabled, cap: settings.cap };
      }
    },
    false
  );

  readStoredSettings();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;
    if (!('enabled' in changes) && !('cap' in changes)) return;
    readStoredSettings();
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'yt-hires:get-status') return undefined;
    sendResponse({
      ok: true,
      url: location.href,
      settings,
      status: lastStatus
    });
    return undefined;
  });

})();
