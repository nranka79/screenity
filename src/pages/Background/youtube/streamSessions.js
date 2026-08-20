import YoutubeStreamUploader from "./YoutubeStreamUploader";
import { diagEvent } from "../../utils/diagnosticLog";

const log = (...args) => console.log("[YoutubeSession]", ...args);
const warn = (...args) => console.warn("[YoutubeSession]", ...args);

const JOURNAL_PREFIX = "youtubeStreamJournal-";

// In-memory sessions survive normal recording; the journal lets a session
// resume after a service-worker restart. Sessions keyed by recorder sessionId.
const sessions = new Map();

const journalKey = (sessionId) => `${JOURNAL_PREFIX}${sessionId}`;

const loadJournal = async (sessionId) => {
  try {
    const { [journalKey(sessionId)]: journal } = await chrome.storage.local.get(
      journalKey(sessionId),
    );
    return journal || null;
  } catch {
    return null;
  }
};

const saveJournal = async (uploader) => {
  if (!uploader?.sessionId || !uploader?.uploadUrl) return;
  try {
    await chrome.storage.local.set({
      [journalKey(uploader.sessionId)]: {
        sessionId: uploader.sessionId,
        title: uploader.title,
        uploadUrl: uploader.uploadUrl,
        offset: uploader.offset,
        container: uploader.container,
        updatedAt: Date.now(),
      },
    });
  } catch (journalErr) {
    warn("journal persist failed:", journalErr.message);
  }
};

const clearJournal = async (sessionId) => {
  if (!sessionId) return;
  try {
    await chrome.storage.local.remove([journalKey(sessionId)]);
  } catch {}
};

export const getYoutubeStreamSession = async ({
  sessionId,
  title = "NDR-Screenity Recording",
}) => {
  if (!sessionId) return null;
  const existing = sessions.get(sessionId);
  if (existing) return existing;

  // SW restarted mid-stream: resume from journal if we can. A resumed
  // session may be missing its buffered tail; finalize() will refuse to
  // complete it and the post-stop fallback re-uploads the full file.
  const journal = await loadJournal(sessionId);
  const uploader = new YoutubeStreamUploader({ sessionId, title: journal?.title || title });
  if (journal?.uploadUrl) {
    uploader.uploadUrl = journal.uploadUrl;
    uploader.offset = journal.offset || 0;
    uploader.totalBytes = journal.offset || 0;
    uploader.container = journal.container || uploader.container;
    uploader.status = "uploading";
    uploader.resumedFromJournal = true;
    log("resumed session from journal at offset", uploader.offset);
  }
  sessions.set(sessionId, uploader);
  return uploader;
};

export const handleStreamStart = async ({ sessionId, title }) => {
  if (!sessionId) return { status: "error", error: "missing-session-id" };
  const uploader = await getYoutubeStreamSession({ sessionId, title });
  log("stream start:", sessionId, title);
  return { status: "ok" };
};

export const handleStreamChunk = async ({ sessionId, index, blob }) => {
  if (!sessionId || !blob) return { status: "ignored" };
  try {
    const uploader = await getYoutubeStreamSession({ sessionId });
    if (!uploader) return { status: "ignored" };
    // Fire-and-forget; ordering enforced inside the uploader via index.
    void uploader
      .write(Number(index) || 0, blob)
      .then(() => saveJournal(uploader))
      .catch((writeErr) => {
        warn("stream chunk failed:", writeErr.message);
      });
    return { status: "ok" };
  } catch (err) {
    warn("handleStreamChunk error:", err.message);
    return { status: "error", error: err.message };
  }
};

export const handleStreamFinalize = async ({ sessionId }) => {
  if (!sessionId) return { status: "error", reason: "missing-session-id" };
  try {
    const uploader = await getYoutubeStreamSession({ sessionId });
    if (!uploader) return { status: "error", reason: "no-session" };
    const result = await uploader.finalize();
    sessions.delete(sessionId);
    if (result.status === "ok") {
      await clearJournal(sessionId);
      diagEvent("youtube-stream-finalize-ok", {
        sessionId,
        videoId: result.videoId,
        bytes: uploader.totalBytes,
      });
    } else {
      // Keep the journal so trigger-auto-upload fallback can complete the
      // job post-stop (the recorder chunks are still stored locally).
      await saveJournal(uploader);
      warn("stream finalize did not complete:", result.status, result.error || result.reason);
    }
    return result;
  } catch (finalizeErr) {
    warn("handleStreamFinalize error:", finalizeErr.message);
    return { status: "error", reason: finalizeErr.message };
  }
};

export const handleStreamAbort = async ({ sessionId }) => {
  if (!sessionId) return { status: "ok" };
  const uploader = sessions.get(sessionId);
  uploader?.abort?.();
  sessions.delete(sessionId);
  await clearJournal(sessionId);
  log("stream aborted:", sessionId);
  return { status: "ok" };
};

export const sweepStaleStreamJournals = async () => {
  try {
    const all = await chrome.storage.local.get(null);
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    const stale = [];
    for (const [key, value] of Object.entries(all || {})) {
      if (!key.startsWith(JOURNAL_PREFIX)) continue;
      const at = value?.updatedAt || 0;
      if (at === 0) {
        stale.push(key);
      } else if (at < cutoff) {
        stale.push(key);
      }
    }
    if (stale.length) {
      await chrome.storage.local.remove(stale);
      log("swept stale stream journals:", stale.length);
    }
  } catch (err) {
    warn("journal sweep failed:", err.message);
  }
};

export default sessions;