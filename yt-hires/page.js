/**
 * YT Hi-Res — page-side controller.
 *
 * This file runs in YouTube's MAIN world (see manifest.json) so it can talk to
 * the internal player API (`#movie_player`) that page scripts create.
 * Settings come from content.js (the isolated-world bridge) through
 * window.postMessage; status goes back the same way.
 */
(() => {
  'use strict';

  if (window.__ytHiresPageLoaded) return;
  window.__ytHiresPageLoaded = true;

  const ALLOWED_CAPS = [1080, 1440, 2160, 4320];
  const DEFAULT_SETTINGS = { enabled: true, cap: 2160 };

  // Internal quality names used by YouTube's player API.
  const QUALITY_HEIGHT = {
    highres: 4320,
    hd2880: 2880,
    hd2160: 2160,
    hd1440: 1440,
    hd1080: 1080,
    hd720: 720,
    large: 480,
    medium: 360,
    small: 240,
    tiny: 144
  };

  const BRIDGE_IN = 'yt-hires:bridge';
  const PAGE_OUT = 'yt-hires:page';
  const TICK_MS = 800;
  const APPLY_COOLDOWN_MS = 1000;

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    target: null,
    videoId: null,
    levelsKey: '',
    maxAvailable: null,
    lastApplyAt: 0,
    lastStatusKey: '',
    timer: null
  };

  function normalizeSettings(raw) {
    const cap = Number(raw && raw.cap);
    return {
      enabled: !(raw && raw.enabled === false),
      cap: ALLOWED_CAPS.includes(cap) ? cap : DEFAULT_SETTINGS.cap
    };
  }

  function getPlayer() {
    const player = document.getElementById('movie_player');
    return player && typeof player.getAvailableQualityLevels === 'function' ? player : null;
  }

  function playerApiMissing() {
    const element = document.getElementById('movie_player');
    return Boolean(element) && typeof element.getAvailableQualityLevels !== 'function';
  }

  function readLevels(player) {
    try {
      const levels = player.getAvailableQualityLevels();
      if (!Array.isArray(levels)) return [];
      const seen = new Set();
      const result = [];
      for (const level of levels) {
        if (!level || level === 'auto') continue;
        if (!Object.prototype.hasOwnProperty.call(QUALITY_HEIGHT, level)) continue;
        if (seen.has(level)) continue;
        seen.add(level);
        result.push(level);
      }
      result.sort((a, b) => QUALITY_HEIGHT[b] - QUALITY_HEIGHT[a]);
      return result;
    } catch (error) {
      return [];
    }
  }

  /**
   * Highest offered quality at or below the cap. If the video has nothing at
   * or below the cap (rare, e.g. an 8K-only stream), the lowest offered quality
   * above the cap is used so playback stays possible.
   */
  function pickTarget(levels, cap) {
    if (!levels.length) return null;
    const atOrBelow = levels.find((level) => QUALITY_HEIGHT[level] <= cap);
    return atOrBelow || levels[levels.length - 1];
  }

  function readCurrentQuality(player) {
    try {
      const quality = player.getPlaybackQuality();
      return typeof quality === 'string' && quality ? quality : null;
    } catch (error) {
      return null;
    }
  }

  function readCurrentLabel(player) {
    try {
      const label = player.getPlaybackQualityLabel();
      return typeof label === 'string' && label ? label : null;
    } catch (error) {
      return null;
    }
  }

  function readVideoId(player) {
    try {
      const data = player.getVideoData ? player.getVideoData() : null;
      return data && typeof data.video_id === 'string' && data.video_id ? data.video_id : null;
    } catch (error) {
      return null;
    }
  }

  function isAdPlaying(player) {
    return Boolean(player && player.classList && player.classList.contains('ad-showing'));
  }

  function applyQuality(player, target) {
    state.lastApplyAt = Date.now();
    try {
      player.setPlaybackQualityRange(target, target);
    } catch (error) {
      // Older player builds may not expose the range API; the plain setter
      // below is still worth trying.
    }
    try {
      player.setPlaybackQuality(target);
    } catch (error) {
      // The watchdog will retry on the next tick.
    }
  }

  function releaseQuality() {
    const player = getPlayer();
    if (!player) return;
    try {
      player.setPlaybackQualityRange('auto', 'auto');
    } catch (error) {
      // Not every player build accepts "auto" here.
    }
    try {
      player.setPlaybackQuality('auto');
    } catch (error) {
      // Nothing else we can do; stop forcing and let YouTube take over.
    }
  }

  function publish(patch) {
    const status = {
      enabled: state.settings.enabled,
      cap: state.settings.cap,
      mode: 'waiting',
      reason: 'starting',
      target: null,
      targetHeight: null,
      current: null,
      currentHeight: null,
      currentLabel: null,
      maxAvailable: null,
      ad: false,
      videoId: state.videoId,
      updatedAt: Date.now(),
      ...patch
    };
    if (status.target) {
      status.targetHeight = QUALITY_HEIGHT[status.target] || null;
    }
    if (status.current) {
      status.currentHeight = QUALITY_HEIGHT[status.current] || null;
    }
    const key = JSON.stringify({
      enabled: status.enabled,
      cap: status.cap,
      mode: status.mode,
      reason: status.reason,
      target: status.target,
      current: status.current,
      currentLabel: status.currentLabel,
      maxAvailable: status.maxAvailable,
      ad: status.ad,
      videoId: status.videoId
    });
    if (key === state.lastStatusKey) return;
    state.lastStatusKey = key;
    window.postMessage({ source: PAGE_OUT, type: 'status', status }, location.origin);
  }

  function syncTarget(player) {
    const levels = readLevels(player);
    const heights = levels.map((level) => QUALITY_HEIGHT[level]);
    const levelsKey = heights.join(',') + '#' + state.settings.cap;
    if (levelsKey !== state.levelsKey) {
      state.levelsKey = levelsKey;
      state.target = pickTarget(levels, state.settings.cap);
      state.maxAvailable = heights.length ? heights[0] : null;
      state.lastApplyAt = 0;
    }
    if (state.maxAvailable === null && heights.length) {
      state.maxAvailable = heights[0];
    }
    return levels;
  }

  function tick() {
    if (!state.settings.enabled) {
      publish({ mode: 'disabled', reason: 'disabled', target: null });
      return;
    }

    const player = getPlayer();
    if (!player) {
      if (playerApiMissing()) {
        publish({ mode: 'error', reason: 'player-api-missing' });
      } else {
        publish({ mode: 'waiting', reason: 'no-player' });
      }
      return;
    }

    const videoId = readVideoId(player);
    if (!videoId) {
      publish({ mode: 'waiting', reason: 'no-video' });
      return;
    }

    if (videoId !== state.videoId) {
      state.videoId = videoId;
      state.levelsKey = '';
      state.target = null;
      state.maxAvailable = null;
      state.lastApplyAt = 0;
    }

    const levels = syncTarget(player);
    if (!levels.length) {
      publish({ mode: 'waiting', reason: 'no-levels' });
      return;
    }
    if (!state.target) {
      publish({ mode: 'waiting', reason: 'no-target' });
      return;
    }

    const ad = isAdPlaying(player);
    const current = readCurrentQuality(player);

    if (!ad && current !== state.target) {
      const now = Date.now();
      if (now - state.lastApplyAt >= APPLY_COOLDOWN_MS) {
        applyQuality(player, state.target);
      }
    }

    publish({
      mode: 'active',
      reason: ad ? 'ad' : current === state.target ? 'settled' : 'applying',
      target: state.target,
      current,
      currentLabel: readCurrentLabel(player),
      maxAvailable: state.maxAvailable,
      ad
    });
  }

  function ensureTimer() {
    if (state.timer) return;
    state.timer = window.setInterval(tick, TICK_MS);
  }

  function handleSettings(raw) {
    const settings = normalizeSettings(raw);
    const changed =
      settings.enabled !== state.settings.enabled || settings.cap !== state.settings.cap;
    state.settings = settings;
    if (!changed) {
      return;
    }
    state.lastStatusKey = '';
    if (!settings.enabled) {
      releaseQuality();
      state.target = null;
      publish({ mode: 'disabled', reason: 'disabled', target: null });
      return;
    }
    state.levelsKey = '';
    state.lastApplyAt = 0;
    ensureTimer();
    tick();
  }

  window.addEventListener(
    'message',
    (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const data = event.data;
      if (!data || data.source !== BRIDGE_IN) return;
      if (data.type === 'settings') {
        handleSettings(data.settings);
      }
    },
    false
  );

  // YouTube swaps videos without a page load. Reset the cached target right
  // away so the new video does not inherit the old one's quality decision.
  const reapply = () => {
    state.levelsKey = '';
    state.lastApplyAt = 0;
    tick();
  };
  document.addEventListener('yt-navigate-finish', reapply, true);
  document.addEventListener('yt-page-data-updated', reapply, true);
  document.addEventListener('loadedmetadata', reapply, true);

  // Let the bridge know we are alive; it replies with the stored settings.
  window.postMessage({ source: PAGE_OUT, type: 'hello' }, location.origin);
  ensureTimer();
  tick();
})();
