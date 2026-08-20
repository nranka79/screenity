import signIn, { YOUTUBE_SCOPE } from "../modules/signIn";
import { diagEvent } from "../../utils/diagnosticLog";

const log = (...args) => console.log("[AutoAuth]", ...args);
const warn = (...args) => console.warn("[AutoAuth]", ...args);

const LAST_ATTEMPT_KEY = "autoAuthLastAttemptAt";
const MIN_ATTEMPT_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Runs at service-worker startup / install.
 *
 * Goals:
 * 1. Default the recording destination to "youtube" ONCE (when the user has
 *    never chosen one) so every finished recording auto-uploads — no
 *    post-recording "select destination" prompt.
 * 2. Silently provision a YouTube token from the Chrome profile's
 *    signed-in Google account (getAuthToken with interactive:false). If the
 *    account session or a previously cached/approved token exists, this
 *    completes with zero UI and persists to chrome.storage.local, so the
 *    sign-in stays until explicitly signed out.
 *    If it cannot succeed silently, nothing is shown here; the popup offers
 *    the one-time interactive sign-in instead.
 *
 * Never shows UI on its own.
 */
export const ensureYoutubeAuth = async () => {
  try {
    const { destination, youtubeToken, autoAuthLastAttemptAt } =
      await chrome.storage.local.get([
        "destination",
        "youtubeToken",
        LAST_ATTEMPT_KEY,
      ]);

    // 1. One-time default destination.
    if (!destination) {
      log("no destination configured; defaulting to youtube auto-upload");
      await chrome.storage.local.set({
        destination: "youtube",
        autoUploadConfigured: true,
      });
      diagEvent("auto-auth-default-destination", { destination: "youtube" });
    } else if (destination !== "youtube" && destination !== "local") {
      log("destination already configured:", destination);
    }

    // 2. Silent token provisioning. Throttled: once we have a fresh token
    // signIn() short-circuits on the stored value, so this is cheap; the
    // throttle only guards the failure path (no Google session at all).
    const sinceLastAttempt = Date.now() - (autoAuthLastAttemptAt || 0);
    if (youtubeToken && sinceLastAttempt < MIN_ATTEMPT_INTERVAL_MS) {
      log("youtubeToken already provisioned; skipping silent auth");
      return { status: "skipped", reason: "already-provisioned" };
    }

    log("attempting silent YouTube auth from Chrome session");
    try {
      const token = await signIn(YOUTUBE_SCOPE, { allowInteractive: false });
      if (token) {
        log("silent YouTube auth OK (token length =", token.length, ")");
        diagEvent("auto-auth-ok", { tokenLen: token.length });
        return { status: "ok", token };
      }
    } catch (authErr) {
      warn("silent YouTube auth unavailable:", authErr.message);
      diagEvent("auto-auth-silent-failed", {
        error: String(authErr.message).slice(0, 160),
      });
    }

    await chrome.storage.local
      .set({ [LAST_ATTEMPT_KEY]: Date.now() })
      .catch(() => {});
    return { status: "not-signed-in" };
  } catch (err) {
    warn("ensureYoutubeAuth failed:", err.message);
    return { status: "error", error: err.message };
  }
};

export default ensureYoutubeAuth;