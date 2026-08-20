import signIn, { YOUTUBE_SCOPE } from "../modules/signIn";
import { diagEvent } from "../../utils/diagnosticLog";

const log = (...args) => console.log("[YoutubeStream]", ...args);
const warn = (...args) => console.warn("[YoutubeStream]", ...args);
const err = (...args) => console.error("[YoutubeStream]", ...args);

const SUB_CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CHUNK_ATTEMPTS = 5;
const MAX_STALL_ROUNDS = 4;

const sanitizeTitle = (raw) => {
  let out = String(raw ?? "").trim();
  if (!out) out = "NDR-Screenity Recording";
  if (out.length > 100) out = out.slice(0, 100).trim();
  return out;
};

/**
 * Streaming upload of a recording to YouTube while it is still being
 * captured. One instance per recording session; lives in the service
 * worker and serializes chunk writes in index order.
 *
 * Network model: YouTube resumable uploads support an unknown total size —
 * the session is initialized without X-Upload-Content-Length and each PUT
 * carries `Content-Range: bytes A-B/*`. To finalize we must know the exact
 * byte count, so this uploader always holds back the last sub-chunk and
 * sends it at finalize() with `bytes A-(total-1)/total`, completing the
 * upload. This lags the server by at most one recorded chunk.
 */
export default class YoutubeStreamUploader {
  constructor({ sessionId, title, onProgress = null } = {}) {
    this.sessionId = sessionId || null;
    this.title = sanitizeTitle(title || "NDR-Screenity Recording");
    this.onProgress = onProgress || null;
    this.token = null;
    this.uploadUrl = null;
    this.offset = 0;
    this.totalBytes = 0;
    this.status = "idle";
    this.error = null;
    this.videoId = null;
    this.videoUrl = null;
    this.container = "video/webm";
    this.nextExpectedIndex = 0;
    // Serializes all writes per session (FIFO promise chain).
    this._chain = Promise.resolve();
    this._bufferedTail = null; // { start, data }
    this.stalledRounds = 0;
  }

  async init() {
    log(
      `init: session=${this.sessionId} title="${this.title}"`,
    );
    if (this.status !== "idle") return;
    try {
      // Streaming pipeline must never pop the Google account UI on its own.
      this.token = await signIn(YOUTUBE_SCOPE, { allowInteractive: false });
    } catch (authErr) {
      this.status = "no-auth";
      this.error = authErr.message || "YouTube auth unavailable";
      warn("init: no auth, streaming skipped:", this.error);
      return;
    }

    const metadata = {
      snippet: {
        title: this.title,
        description: `Recorded with NDR-Screenity (streaming upload)`,
      },
      status: { privacyStatus: "unlisted" },
    };

    const initRes = await fetch(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": this.container || "video/*",
        },
        body: JSON.stringify(metadata),
      },
    );

    if (!initRes.ok) {
      const body = await initRes.text().catch(() => "");
      this.status = "error";
      this.error = `YouTube resumable init failed: ${initRes.status} ${body.slice(0, 200)}`;
      err("init:", this.error);
      diagEvent("youtube-stream-init-fail", {
        status: initRes.status,
        error: this.error.slice(0, 160),
      });
      return;
    }
    this.uploadUrl = initRes.headers.get("location");
    if (!this.uploadUrl) {
      this.status = "error";
      this.error = "YouTube resumable init missing Location header";
      err("init:", this.error);
      return;
    }
    this.status = "uploading";
    diagEvent("youtube-stream-init-ok", { sessionId: this.sessionId });
    log("init: session opened, uploadUrl len =", this.uploadUrl.length);
  }

  /** Queue a recorded chunk. Guarantees index ordering. */
  async write(index, blob) {
    if (this.status === "error" || this.status === "no-auth" || this.status === "completed") {
      return;
    }
    const task = this._chain.then(async () => {
      try {
        await this._writeOrdered(index, blob);
      } catch (taskErr) {
        err(`write(index=${index}) failed:`, taskErr.message);
      }
    });
    this._chain = task;
    await this._chain;
  }

  async _writeOrdered(index, blob) {
    if (index !== this.nextExpectedIndex) {
      warn(
        `out-of-order chunk: got ${index}, expected ${this.nextExpectedIndex}; dropping`,
      );
      return;
    }
    this.nextExpectedIndex = index + 1;

    if (!this.uploadUrl) {
      await this.init();
      if (!this.uploadUrl) {
        warn("write: session unavailable, dropping chunk");
        return;
      }
    }
    if (!blob || blob.size === 0) return;

    const slices = [];
    for (let i = 0; i < blob.size; i += SUB_CHUNK_SIZE) {
      slices.push({ blob: blob.slice(i, i + SUB_CHUNK_SIZE) });
    }

    // Upload all-but-last sub-chunks with unknown total; hold the last one
    // back so finalize() can declare the exact total.
    for (let i = 0; i < slices.length - 1; i += 1) {
      await this._putSubChunk(slices[i].blob, false);
      if (this.status === "error") return;
    }
    if (slices.length > 0) {
      this._bufferedTail = slices[slices.length - 1].blob;
    }
  }

  async _putSubChunk(subChunk, isFinal) {
    let localOffset = this.offset;
    let localData = subChunk;
    const total = isFinal ? this.offset + subChunk.size : null;
    if (total !== null) {
      this.totalBytes = total;
    }

    for (let attempt = 0; attempt < MAX_CHUNK_ATTEMPTS; attempt += 1) {
      const start = localOffset;
      const end = start + localData.size - 1;
      const contentRange = total !== null
        ? `bytes ${start}-${end}/${total}`
        : `bytes ${start}-${end}/*`;
      if (total !== null) {
        // Only the final range may declare the total.
        this.totalBytes = total;
      } else {
        this.totalBytes = end + 1;
      }

      let res;
      try {
        res = await fetch(this.uploadUrl, {
          method: "PUT",
          headers: { "Content-Range": contentRange },
          body: localData,
        });
      } catch (fetchErr) {
        if (attempt === MAX_CHUNK_ATTEMPTS - 1) throw fetchErr;
        await new Promise((r) =>
          setTimeout(r, Math.min(1000 * 2 ** attempt, 30000) + Math.random() * 250),
        );
        continue;
      }

      if (res.status === 200 || res.status === 201) {
        const data = await res.json().catch(() => null);
        this.offset = end + 1;
        this.status = isFinal ? "completed" : "uploading";
        if (isFinal) {
          this.videoId = data?.id || null;
          this.videoUrl = this.videoId ? `https://youtu.be/${this.videoId}` : "";
          log("final chunk accepted, videoId =", this.videoId);
        } else if (this.offset > this.totalBytes) {
          this.totalBytes = this.offset;
        }
        return;
      }

      if (res.status === 308) {
        const range = res.headers.get("range");
        const match = range && range.match(/bytes=0-(\d+)/);
        const serverAckedEnd = match ? parseInt(match[1], 10) : null;
        if (serverAckedEnd === null || serverAckedEnd <= start - 1) {
          // No progress: stall retry.
          this.stalledRounds += 1;
          if (this.stalledRounds >= MAX_STALL_ROUNDS) {
            throw new Error(
              `YouTube stream upload stalled at offset ${start}`,
            );
          }
          await new Promise((r) =>
            setTimeout(r, Math.min(1000 * 2 ** (this.stalledRounds - 1), 15000)),
          );
          continue;
        }
        if (serverAckedEnd < end) {
          // Partial accept: re-slice the remainder and retry.
          const skipBytes = serverAckedEnd + 1 - start;
          localData = localData.slice(skipBytes);
          localOffset = serverAckedEnd + 1;
          this.stalledRounds = 0;
          continue;
        }
        this.offset = end + 1;
        this.stalledRounds = 0;
        if (typeof this.onProgress === "function") {
          this.onProgress({ offset: this.offset });
        }
        return;
      }

      // 401: token expired. Refresh silently once and retry.
      if (res.status === 401) {
        try {
          this.token = await signIn(YOUTUBE_SCOPE, { allowInteractive: false });
        } catch (authErr) {
          throw new Error(`YouTube token refresh failed: ${authErr.message}`);
        }
        continue;
      }

      const transient =
        res.status === 408 || res.status === 429 || res.status >= 500;
      if (!transient || attempt === MAX_CHUNK_ATTEMPTS - 1) {
        const errBody = await res.text().catch(() => "");
        throw new Error(
          `YouTube stream chunk PUT failed: ${res.status} ${errBody.slice(0, 200)}`,
        );
      }
      await new Promise((r) =>
        setTimeout(r, Math.min(1000 * 2 ** attempt, 30000) + Math.random() * 250),
      );
    }
    throw new Error(
      `YouTube stream chunk PUT exhausted retries at offset ${this.offset}`,
    );
  }

  /** Complete the upload: send the held-back tail declaring the total. */
  async finalize() {
    log(
      "finalize: status =", this.status,
      "offset =", this.offset,
      "hasTail =", Boolean(this._bufferedTail),
    );
    if (this.status === "no-auth") {
      return { status: "no-auth", error: this.error || "Not signed in" };
    }
    if (this.status === "error") {
      return { status: "error", error: this.error || "Upload failed mid-stream" };
    }
    if (this.status === "completed") {
      return { status: "ok", url: this.videoUrl, videoId: this.videoId };
    }

    try {
      const settled = await this._chain.catch(() => {});
      await settled;
      if (!this._bufferedTail) {
        // Nothing buffered: either empty recording or tail already sent.
        if (this.offset === 0) {
          this.status = "error";
          this.error = "Empty recording, nothing to finalize";
          return { status: "error", error: this.error };
        }
        this.status = "error";
        this.error = "Finalization failed: no tail buffered";
        return { status: "error", error: this.error };
      }
      const tail = this._bufferedTail;
      this._bufferedTail = null;
      if (this.status === "error") {
        return { status: "error", error: this.error };
      }
      await this._putSubChunk(tail, true);
      if (this.status === "completed" && this.videoId) {
        log("finalize: upload complete, videoId =", this.videoId);
        diagEvent("youtube-stream-completed", {
          sessionId: this.sessionId,
          videoId: this.videoId,
          totalBytes: this.totalBytes,
        });
        return { status: "ok", url: this.videoUrl, videoId: this.videoId };
      }
      return { status: "error", error: this.error || "Finalize did not complete" };
    } catch (finalizeErr) {
      this.status = "error";
      this.error = finalizeErr.message || "Finalize failed";
      err("finalize:", this.error);
      diagEvent("youtube-stream-finalize-fail", {
        sessionId: this.sessionId,
        error: String(this.error).slice(0, 160),
      });
      return { status: "error", error: this.error };
    }
  }

  abort() {
    log("abort: dropping stream session", this.sessionId);
    this.status = "error";
    this.error = "aborted";
    this._bufferedTail = null;
  }
}

export { sanitizeTitle };