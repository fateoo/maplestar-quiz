(() => {
  'use strict';

  const storageKey = 'maplestar.capture-regions.v1';
  const maxWindows = 12;
  const maxStoredLength = 32_768;
  let state = { last: null, windows: [] };
  let storageAvailable = true;

  function validKey(key) {
    return typeof key === 'string' && key.length <= 256 && key.trim().length > 0;
  }

  function validSize(width, height) {
    return Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0;
  }

  function normalizeRegion(rect) {
    if (!rect || typeof rect !== 'object') return null;
    const { x, y, width, height } = rect;
    if (![x, y, width, height].every(Number.isFinite)) return null;
    if (x < 0 || y < 0 || x >= 1 || y >= 1 || width <= 0 || height <= 0) return null;
    if (x + width > 1 + 1e-9 || y + height > 1 + 1e-9) return null;
    return { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) };
  }

  function readState() {
    if (!storageAvailable) return state;
    let raw;
    try {
      raw = window.localStorage.getItem(storageKey);
    } catch {
      storageAvailable = false;
      return state;
    }

    state = { last: null, windows: [] };
    if (!raw || raw.length > maxStoredLength) return state;
    try {
      const saved = JSON.parse(raw);
      if (saved?.version !== 1) return state;
      state.last = normalizeRegion(saved.last);
      for (const entry of (Array.isArray(saved.windows) ? saved.windows.slice(0, maxWindows) : [])) {
        if (!entry || !validKey(entry.key) || !validSize(entry.width, entry.height)) continue;
        const rect = normalizeRegion(entry.rect);
        if (rect) state.windows.push({ key: entry.key, width: entry.width, height: entry.height, rect });
      }
    } catch {
      // Invalid storage never prevents a new selection from being saved.
    }
    return state;
  }

  window.mapleCaptureRegions = {
    load(windowKey, width, height) {
      if (!validKey(windowKey) || !validSize(width, height)) return null;
      const entry = readState().windows.find(candidate => candidate.key === windowKey
        && candidate.width === width && candidate.height === height);
      return entry ? { ...entry.rect } : null;
    },

    loadLast(windowKey) {
      const { last, windows } = readState();
      const rect = windows.find(entry => entry.key === windowKey)?.rect ?? last;
      return rect ? { ...rect } : null;
    },

    save(windowKey, width, height, rect) {
      if ((windowKey !== null && !validKey(windowKey)) || !validSize(width, height)) return false;
      const normalized = normalizeRegion(rect);
      if (!normalized) return false;
      const saved = readState();
      saved.last = normalized;
      // An unidentified source can only recover this crop through explicit selection.
      if (windowKey !== null) {
        saved.windows = [
          { key: windowKey, width, height, rect: normalized },
          ...saved.windows.filter(entry => entry.key !== windowKey),
        ].slice(0, maxWindows);
      }
      if (storageAvailable) {
        try {
          window.localStorage.setItem(storageKey, JSON.stringify({ version: 1, ...saved }));
        } catch {
          storageAvailable = false;
        }
      }
      return true;
    },
  };
})();
