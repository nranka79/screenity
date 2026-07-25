const log = (...args) => console.log("[OAuth]", ...args);
const err = (...args) => console.error("[OAuth]", ...args);

const signIn = async (scopeOverride) => {
  const scope = scopeOverride || "https://www.googleapis.com/auth/drive.file";
  const storageKey = scope.includes("youtube") ? "youtubeToken" : "token";

  log("=== signIn ===");
  log("scope:", scope);
  log("extension_id:", chrome.runtime.id);
  const manifest = chrome.runtime.getManifest();
  log("manifest client_id:", manifest?.oauth2?.client_id?.slice(0, 30) + "...");

  try {
    log("calling chrome.identity.getAuthToken({ interactive: true })");
    const tokenResult = await chrome.identity.getAuthToken({
      interactive: true,
      scopes: scope.includes("youtube") ? [scope] : undefined,
    });
    if (!tokenResult?.token) {
      err("getAuthToken returned no token");
      throw new Error("Sign-in returned no token");
    }
    log("getAuthToken succeeded, token length =", tokenResult.token.length);
    await new Promise((resolve) =>
      chrome.storage.local.set({ [storageKey]: tokenResult.token }, resolve),
    );
    log("token saved to", storageKey);
    return tokenResult.token;
  } catch (caughtErr) {
    err("getAuthToken failed:", caughtErr.message);
    err("  check that the OAuth consent screen is configured and APIs are enabled");
    throw caughtErr;
  }
};

export default signIn;
