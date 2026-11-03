/**
 * YT Hi-Res — service worker.
 *
 * Only job: seed the default settings the first time the extension is
 * installed. Everything else lives in the content scripts and the popup.
 */
const DEFAULT_SETTINGS = { enabled: true, cap: 2160 };

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== 'install') return;
  chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
    chrome.storage.sync.set({
      enabled: stored.enabled !== false,
      cap: stored.cap
    });
  });
});
