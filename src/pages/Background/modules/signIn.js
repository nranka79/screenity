const log = (...args) => console.log("[OAuth]", ...args);
const err = (...args) => console.error("[OAuth]", ...args);

const signIn = async (scopeOverride) => {
  const scope = scopeOverride || null;
  const isYoutubeOnly = typeof scopeOverride === "string" && scopeOverride.includes("youtube") && !scopeOverride.includes("drive");
  const storageKey = isYoutubeOnly ? "youtubeToken" : "token";

  log("=== signIn ===");
  log("scope:", scope || "manifest scopes (Drive.file + YouTube.upload)");
  log("extension_id:", chrome.runtime.id);
  const manifest = chrome.runtime.getManifest();
  log("manifest client_id:", manifest?.oauth2?.client_id?.slice(0, 30) + "...");

  try {
    log("calling chrome.identity.getAuthToken({ interactive: true })");
    const tokenResult = await chrome.identity.getAuthToken({
      interactive: true,
      scopes: scope ? [scope] : undefined,
    });
    if (!tokenResult?.token) {
      err("getAuthToken returned no token");
      throw new Error("Sign-in returned no token");
    }
    log("getAuthToken succeeded, token length =", tokenResult.token.length);
    const saveObj = { [storageKey]: tokenResult.token };
    if (!isYoutubeOnly) {
      saveObj.youtubeToken = tokenResult.token;
    }
    await new Promise((resolve) =>
      chrome.storage.local.set(saveObj, resolve),
    );
    log("token saved to", storageKey, isYoutubeOnly ? "" : "(+ youtubeToken)");
    return tokenResult.token;
  } catch (caughtErr) {
    err("getAuthToken failed:", caughtErr.message);
    err("  check that the OAuth consent screen is configured and APIs are enabled");
    throw caughtErr;
  }
};

export default signIn;
