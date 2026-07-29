let _debugMode = false;

export const isDebugMode = () => _debugMode;

export const setDebugMode = (enabled) => {
  _debugMode = enabled;
};

export const initDebugMode = async () => {
  try {
    const result = await chrome.storage.local.get(['debugMode']);
    _debugMode = !!result.debugMode;
  } catch {
    _debugMode = false;
  }
};

export const watchDebugMode = () => {
  try {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.debugMode) {
        _debugMode = !!changes.debugMode.newValue;
      }
    });
  } catch {}
};

export const debug = (...args) => {
  if (_debugMode) {
    console.log('[NDR]', ...args);
  }
};

export const debugWarn = (...args) => {
  if (_debugMode) {
    console.warn('[NDR]', ...args);
  }
};

export const debugError = (...args) => {
  if (_debugMode) {
    console.error('[NDR]', ...args);
  }
};

export const debugGroup = (label) => {
  if (_debugMode) {
    console.group('[NDR]', label);
  }
};

export const debugGroupEnd = () => {
  if (_debugMode) {
    console.groupEnd();
  }
};
