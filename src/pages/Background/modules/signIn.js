const log = (...args) => console.log("[OAuth]", ...args);
const err = (...args) => console.error("[OAuth]", ...args);

const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

// Error messages chrome.identity throws when interactive:false cannot be
// satisfied silently (no cached token / consent not yet granted / user
// not signed into a matching Google account in this Chrome profile).
const SILENT_UNAVAILABLE_MSGS = [
  /Authorization page could not be loaded/i,
  /The user needs to sign in/i,
  /interactive/i,
  /Not authorized/i,
  /network error/i,
  /load of "?chrome-extension/i,
];

const isSilentFailure = (message) =>
  SILENT_UNAVAILABLE_MSGS.some((re) => re.test(message || ""));

const decodeJwtExpiry = (token) => {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    const exp = Number(payload?.exp);
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
};

const isTokenFresh = (token, headroomMs = 5 * 60 * 1000) => {
  if (!token) return false;
  const exp = decodeJwtExpiry(token);
  if (exp === null) return true;
  return Date.now() + headroomMs < exp;
};

const getStoredToken = async (storageKey) =>
  new Promise((resolve) => {
    chrome.storage.local.get([storageKey], (result) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(result?.[storageKey] || null);
    });
  });

const persistToken = async (storageKey, token) => {
  const saveObj = { [storageKey]: token };
  if (storageKey === "token") {
    saveObj.youtubeToken = token;
  }
  await new Promise((resolve) => chrome.storage.local.set(saveObj, resolve));
};

const doGetAuthToken = (interactive, scope) =>
  new Promise((resolve, reject) => {
    chrome.identity.getAuthToken(
      { interactive, scopes: scope ? [scope] : undefined },
      (tokenResult) => {
        if (chrome.runtime.lastError) {
          reject(
            new Error(
              chrome.runtime.lastError.message || "getAuthToken failed",
            ),
          );
          return;
        }
        if (!tokenResult?.token) {
          reject(new Error("Sign-in returned no token"));
          return;
        }
        resolve(tokenResult);
      },
    );
  });

/**
 * Sign in to Google using the Chrome profile's signed-in account.
 *
 * Auth strategy (one-time sign-in, then it stays):
 * 1. Stored token in chrome.storage.local wins if unexpired — survives
 *    browser restarts and never re-prompts.
 * 2. If missing/expired, try a SILENT getAuthToken (interactive: false).
 *    This picks up the Google account already signed into Chrome plus any
 *    cached/approved consent — no UI at all.
 * 3. Only if the silent attempt is impossible AND the caller explicitly
 *    allows UI (user-initiated action) do we show the interactive flow.
 *
 * @param {string} [scopeOverride] - e.g. youtube.upload or drive.file
 * @param {{allowInteractive?: boolean, forceRefresh?: boolean}} [opts]
 * @returns {Promise<string>} the access token
 */
const signIn = async (scopeOverride, opts = {}) => {
  const { allowInteractive = false, forceRefresh = false } = opts;
  const scope = scopeOverride || null;
  const isYoutubeOnly =
    typeof scopeOverride === "string" &&
    scopeOverride.includes("youtube") &&
    !scopeOverride.includes("drive");
  const storageKey = isYoutubeOnly ? "youtubeToken" : "token";

  log("=== signIn ===");
  log("scope:", scope || "manifest scopes (Drive.file + YouTube.upload)");
  log("allowInteractive:", allowInteractive, "forceRefresh:", forceRefresh);
  log("extension_id:", chrome.runtime.id);

  if (!forceRefresh) {
    const stored = await getStoredToken(storageKey);
    if (isTokenFresh(stored)) {
      log("using fresh stored token (length =", stored.length, ")");
      return stored;
    }
    if (stored) {
      log("stored token is missing/expired; refreshing silently");
    }
  } else {
    log("forceRefresh: ignoring stored token");
  }

  try {
    log("trying silent getAuthToken({ interactive: false })");
    const tokenResult = await doGetAuthToken(false, scope);
    log("silent getAuthToken succeeded, token length =", tokenResult.token.length);
    await persistToken(storageKey, tokenResult.token);
    log("token saved to", storageKey);
    return tokenResult.token;
  } catch (silentErr) {
    err("silent getAuthToken failed:", silentErr.message);
    if (!allowInteractive || isSilentFailure(silentErr.message) === false) {
      if (!allowInteractive) {
        log("interactive not allowed; failing without showing UI");
      } else {
        err("non-silent failure, not retrying interactively");
      }
      throw silentErr;
    }
    err("falling back to interactive getAuthToken (one-time sign-in)");
    const tokenResult = await doGetAuthToken(true, scope);
    if (!tokenResult?.token) {
      err("getAuthToken returned no token");
      throw new Error("Sign-in returned no token");
    }
    log("interactive getAuthToken succeeded, token length =", tokenResult.token.length);
    await persistToken(storageKey, tokenResult.token);
    log("token saved to", storageKey);
    return tokenResult.token;
  }
};

export default signIn;
export { YOUTUBE_SCOPE, DRIVE_SCOPE, isTokenFresh, decodeJwtExpiry };