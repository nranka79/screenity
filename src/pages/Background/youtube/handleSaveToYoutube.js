import { sendMessageTab } from "../tabManagement";
import { diagEvent } from "../../utils/diagnosticLog";
import signIn from "../modules/signIn";

const log = (...args) => console.log("[YouTube]", ...args);
const warn = (...args) => console.warn("[YouTube]", ...args);
const err = (...args) => console.error("[YouTube]", ...args);

const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CHUNK_ATTEMPTS = 5;
const MAX_STALL_ROUNDS = 4;

const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.upload";

const getYoutubeToken = async () => {
  log("getYoutubeToken: checking stored youtubeToken");
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(["youtubeToken"], async (result) => {
      if (chrome.runtime.lastError) {
        err("getYoutubeToken: storage error:", chrome.runtime.lastError.message);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const token = result.youtubeToken;
      if (!token) {
        log("getYoutubeToken: no stored token, triggering sign-in");
        try {
          const newToken = await signInYoutube();
          if (!newToken) {
            reject(new Error("YouTube sign-in failed"));
            return;
          }
          log("getYoutubeToken: new sign-in succeeded, token length =", newToken.length);
          resolve(newToken);
        } catch (caughtErr) {
          err("getYoutubeToken: sign-in failed:", caughtErr.message);
          reject(caughtErr);
        }
        return;
      }
      log("getYoutubeToken: found stored token, checking expiry");
      const REFRESH_HEADROOM_MS = 5 * 60 * 1000;
      let needsRefresh = false;
      try {
        const parts = token.split(".");
        if (parts.length === 3) {
          const payload = JSON.parse(atob(parts[1]));
          const exp = payload.exp * 1000;
          needsRefresh = Date.now() + REFRESH_HEADROOM_MS >= exp;
          log("getYoutubeToken: token exp =", new Date(exp).toISOString(), "needsRefresh =", needsRefresh);
        } else {
          log("getYoutubeToken: token doesn't look like JWT (parts:", parts.length, ")");
        }
      } catch (parseErr) {
        warn("getYoutubeToken: could not parse token expiry:", parseErr.message);
      }
      if (needsRefresh) {
        log("getYoutubeToken: token expiring soon, re-signing in");
        try {
          const newToken = await signInYoutube();
          if (!newToken) {
            reject(new Error("YouTube re-sign-in failed"));
          } else {
            log("getYoutubeToken: re-sign-in succeeded");
            resolve(newToken);
          }
        } catch (caughtErr) {
          err("getYoutubeToken: re-sign-in failed:", caughtErr.message);
          reject(caughtErr);
        }
      } else {
        log("getYoutubeToken: using stored token (length =", token.length, ")");
        resolve(token);
      }
    });
  });
};

const signInYoutube = async () => {
  log("=== signInYoutube ===");
  try {
    const token = await signIn(YOUTUBE_SCOPE);
    log("signInYoutube succeeded, token length =", token.length);
    return token;
  } catch (caughtErr) {
    err("signInYoutube failed:", caughtErr.message);
    throw caughtErr;
  }
};

const signOutYoutube = async () => {
  try {
    const { youtubeToken } = await new Promise((resolve) =>
      chrome.storage.local.get(["youtubeToken"], resolve),
    );
    if (youtubeToken && chrome.identity?.removeCachedAuthToken) {
      await chrome.identity.removeCachedAuthToken({ token: youtubeToken });
    }
  } catch {}
  await new Promise((resolve) => chrome.storage.local.remove(["youtubeToken"], resolve));
};

const sanitizeTitle = (raw) => {
  let out = String(raw ?? "").trim();
  if (!out) out = "Screenity Recording";
  if (out.length > 100) out = out.slice(0, 100).trim();
  return out;
};

const uploadResumable = async (token, blob, fileName, onProgress) => {
  const title = sanitizeTitle(fileName);
  log("uploadResumable: starting for", title, "size =", blob.size);

  const metadata = {
    snippet: {
      title,
      description: `Recorded with Screenity`,
    },
    status: {
      privacyStatus: "unlisted",
    },
  };

  log("uploadResumable: initializing resumable upload");
  const initRes = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": blob.type || "video/*",
        "X-Upload-Content-Length": String(blob.size),
      },
      body: JSON.stringify(metadata),
    },
  );

  log("uploadResumable: init response status =", initRes.status);
  if (!initRes.ok) {
    const errBody = await initRes.text().catch(() => "");
    err("uploadResumable: init failed:", initRes.status, errBody.slice(0, 200));
    throw new Error(`YouTube resumable init failed: ${initRes.status} ${errBody}`);
  }

  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) {
    err("uploadResumable: missing Location header in init response");
    throw new Error("YouTube resumable init missing Location header");
  }
  log("uploadResumable: got upload URL, length =", uploadUrl.length);

  const totalSize = blob.size;
  let offset = 0;
  let stalledRounds = 0;

  while (offset < totalSize) {
    const end = Math.min(offset + CHUNK_SIZE, totalSize);
    const chunkBlob = blob.slice(offset, end);
    const buffer = await chunkBlob.arrayBuffer();
    const contentRange = `bytes ${offset}-${end - 1}/${totalSize}`;
    log("uploadResumable: uploading chunk", offset, "-", end - 1, "of", totalSize, "(", buffer.byteLength, "bytes )");

    const pct = Math.round((end / totalSize) * 100);
    if (typeof onProgress === "function") {
      onProgress(pct);
    }

    let advanced = false;
    let stalled = false;
    for (let attempt = 0; attempt < MAX_CHUNK_ATTEMPTS; attempt++) {
      let chunkRes;
      try {
        chunkRes = await fetch(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Length": String(buffer.byteLength),
            "Content-Range": contentRange,
          },
          body: buffer,
        });
      } catch (err) {
        const isNetworkErr = err?.name === "TypeError" || err?.name === "AbortError";
        if (!isNetworkErr || attempt === MAX_CHUNK_ATTEMPTS - 1) throw err;
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
        await new Promise((r) => setTimeout(r, delay + Math.random() * 250));
        continue;
      }

      if (chunkRes.status === 200 || chunkRes.status === 201) {
        const data = await chunkRes.json();
        return { videoId: data?.id || null };
      }

      if (chunkRes.status === 308) {
        const range = chunkRes.headers.get("range");
        const match = range && range.match(/bytes=0-(\d+)/);
        const nextOffset = match ? parseInt(match[1], 10) + 1 : offset;
        if (nextOffset > offset) {
          offset = nextOffset;
          advanced = true;
        } else {
          stalled = true;
        }
        break;
      }

      const isTransient =
        chunkRes.status === 408 || chunkRes.status === 429 || chunkRes.status >= 500;
      if (!isTransient || attempt === MAX_CHUNK_ATTEMPTS - 1) {
        const errBody = await chunkRes.text().catch(() => "");
        throw new Error(`YouTube chunk PUT failed: ${chunkRes.status} ${errBody}`);
      }
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      await new Promise((r) => setTimeout(r, delay + Math.random() * 250));
    }

    if (advanced) {
      stalledRounds = 0;
      continue;
    }
    if (!stalled) {
      throw new Error(`YouTube chunk PUT exhausted retries at offset ${offset}`);
    }
    stalledRounds += 1;
    if (stalledRounds >= MAX_STALL_ROUNDS) {
      throw new Error(`YouTube resumable upload stalled at offset ${offset}`);
    }
    const delay = Math.min(1000 * Math.pow(2, stalledRounds - 1), 15000);
    await new Promise((r) => setTimeout(r, delay));
  }

  throw new Error("YouTube resumable upload finished without final response");
};

const saveToYoutube = async (videoBlob, fileName, onProgress) => {
  log("=== saveToYoutube ===");
  log("videoBlob size:", videoBlob.size, "type:", videoBlob.type, "fileName:", fileName);

  const runUploadOnce = async (forceRefresh = false) => {
    log("runUploadOnce: forceRefresh =", forceRefresh);
    let token;
    if (forceRefresh) {
      log("forceRefresh: removing stale token and re-signing in");
      try {
        const stale = await new Promise((r) =>
          chrome.storage.local.get(["youtubeToken"], ({ youtubeToken }) => r(youtubeToken)),
        );
        if (stale && chrome.identity?.removeCachedAuthToken) {
          log("removing cached auth token");
          await Promise.race([
            new Promise((resolve) =>
              chrome.identity.removeCachedAuthToken({ token: stale }, resolve),
            ),
            new Promise((resolve) => setTimeout(resolve, 2000)),
          ]);
        }
      } catch (cleanupErr) {
        warn("token cleanup error:", cleanupErr.message);
      }
      await chrome.storage.local.remove(["youtubeToken"]);
      token = await signInYoutube();
      if (!token) throw new Error("YouTube sign-in failed");
      log("forceRefresh: new token obtained");
    } else {
      log("runUploadOnce: getting token normally");
      token = await getYoutubeToken();
      if (!token) throw new Error("YouTube sign-in failed");
      log("runUploadOnce: token obtained");
    }
    return await uploadResumable(token, videoBlob, fileName, onProgress);
  };

  try {
    diagEvent("youtube-upload-start", {
      blobSize: videoBlob.size,
      blobType: videoBlob.type,
    });

    let result;
    try {
      log("saveToYoutube: first upload attempt");
      result = await runUploadOnce(false);
    } catch (caughtErr) {
      warn("saveToYoutube: first attempt failed:", caughtErr.message);
      if (/401/.test(String(caughtErr.message))) {
        log("saveToYoutube: 401 detected, retrying with fresh token");
        diagEvent("youtube-auth-retry", { error: String(caughtErr.message).slice(0, 120) });
        result = await runUploadOnce(true);
      } else {
        throw caughtErr;
      }
    }

    log("saveToYoutube: upload succeeded, videoId =", result.videoId);
    diagEvent("youtube-upload-ok", { videoId: result.videoId });
    const videoUrl = `https://youtu.be/${result.videoId}`;

    return { status: "ok", url: videoUrl, videoId: result.videoId };
  } catch (error) {
    err("saveToYoutube: upload failed:", error.message);
    diagEvent("youtube-upload-fail", { error: String(error.message).slice(0, 120) });
    return { status: "ew", url: null, error: error.message };
  }
};

export const handleSaveToYoutube = async (request, sender) => {
  log("=== handleSaveToYoutube ===");
  log("request:", JSON.stringify({ ...request, blob: request.blob ? "(blob " + request.blob.size + " bytes)" : undefined }));
  const requestId = request.requestId || crypto.randomUUID();

  const onProgress = (pct) => {
    if (sender?.tab?.id) {
      chrome.tabs.sendMessage(sender.tab.id, {
        type: "youtube-upload-progress",
        progress: pct,
        requestId,
      }).catch(() => {});
    }
  };

  try {
    let blob;
    if (request.opfsFileName) {
      log("reading video from OPFS file:", request.opfsFileName);
      const dir = await navigator.storage.getDirectory();
      const handle = await dir.getFileHandle(request.opfsFileName);
      blob = await handle.getFile();
      log("OPFS file size:", blob.size, "type:", blob.type);
    } else if (request.blob) {
      blob = request.blob;
      log("using provided blob, size:", blob.size, "type:", blob.type);
    } else {
      throw new Error("No video data provided for YouTube upload");
    }
    return await saveToYoutube(blob, request.title, onProgress);
  } catch (caughtErr) {
    err("handleSaveToYoutube failed:", caughtErr);
    return { status: "ew", url: null, error: caughtErr.message };
  }
};

export const checkYoutubeAuth = async () => {
  log("checkYoutubeAuth: checking stored youtubeToken");
  try {
    const { youtubeToken } = await new Promise((resolve) =>
      chrome.storage.local.get(["youtubeToken"], resolve),
    );
    const signedIn = Boolean(youtubeToken);
    log("checkYoutubeAuth: signedIn =", signedIn, "(token length =", youtubeToken ? youtubeToken.length : 0, ")");
    return { signedIn };
  } catch (caughtErr) {
    warn("checkYoutubeAuth error:", caughtErr.message);
    return { signedIn: false };
  }
};

export const handleSignInYoutube = async () => {
  log("=== handleSignInYoutube ===");
  try {
    const token = await signInYoutube();
    if (token) {
      log("handleSignInYoutube: sign-in OK, token length =", token.length);
      return { status: "ok" };
    }
    warn("handleSignInYoutube: sign-in returned no token");
    return { status: "ew", error: "Sign-in returned no token" };
  } catch (caughtErr) {
    err("handleSignInYoutube: sign-in failed:", caughtErr.message);
    return { status: "ew", error: caughtErr.message };
  }
};

export { signOutYoutube };
