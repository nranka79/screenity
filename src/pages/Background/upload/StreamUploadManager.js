import { diagEvent } from "../../utils/diagnosticLog";
import signIn from "../modules/signIn";
import { openExistingChunksStore } from "../../CloudRecorder/recorderStorage/chooseChunksStore";

const getDestination = async () => {
  const result = await chrome.storage.local.get([
    "destination", "token", "youtubeToken",
    "s3Endpoint", "s3Region", "s3Bucket", "s3AccessKeyId", "s3SecretAccessKey",
  ]);
  return {
    destination: result.destination || null,
    hasGoogleAuth: Boolean(result.token),
    hasS3Config: Boolean(result.s3Endpoint && result.s3Bucket && result.s3AccessKeyId),
  };
};

const getAuthTokenForDestination = async (dest) => {
  if (dest === "drive") {
    const { token } = await chrome.storage.local.get(["token"]);
    if (token) return token;
    // Background pipeline: never pop the Google UI by itself.
    return await signIn(undefined, { allowInteractive: false });
  }
  if (dest === "youtube") {
    const { youtubeToken } = await chrome.storage.local.get(["youtubeToken"]);
    if (youtubeToken) return youtubeToken;
    return await signIn("https://www.googleapis.com/auth/youtube.upload", {
      allowInteractive: false,
    });
  }
  return null;
};

const getS3Config = async () => {
  const result = await chrome.storage.local.get([
    "s3Endpoint", "s3Region", "s3Bucket", "s3AccessKeyId", "s3SecretAccessKey", "s3PathPrefix",
  ]);
  if (!result.s3Endpoint || !result.s3Region || !result.s3Bucket || !result.s3AccessKeyId || !result.s3SecretAccessKey) {
    return null;
  }
  return {
    endpoint: result.s3Endpoint.replace(/\/+$/, ""),
    region: result.s3Region,
    bucket: result.s3Bucket,
    accessKeyId: result.s3AccessKeyId,
    secretAccessKey: result.s3SecretAccessKey,
    pathPrefix: (result.s3PathPrefix || "").replace(/^\/+|\/+$/g, ""),
  };
};

const uploadBlobToDrive = async (blob, fileName) => {
  const { handleSaveToDrive } = await import("../drive/handleSaveToDrive");
  const opfsFileName = `stream-upload-${Date.now()}.${blob.type?.includes("webm") ? "webm" : "mp4"}`;
  const dir = await navigator.storage.getDirectory();
  const handle = await dir.getFileHandle(opfsFileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  return await handleSaveToDrive(
    { opfsFileName, title: fileName, isWebm: blob.type?.includes("webm") },
    false
  );
};

const uploadBlobToYoutube = async (blob, fileName) => {
  const { handleSaveToYoutube } = await import("../youtube/handleSaveToYoutube");
  return await handleSaveToYoutube({ blob, title: fileName }, null);
};

const uploadBlobToS3 = async (blob, fileName) => {
  const { handleSaveToS3 } = await import("../s3/handleSaveToS3");
  return await handleSaveToS3({ blob, title: fileName });
};

export const uploadChunksFromStore = async (store, destination, fileName) => {
  const chunks = [];
  await store.iterate((value) => chunks.push(value));
  if (chunks.length === 0) return { status: "error", reason: "no-chunks" };
  chunks.sort((a, b) => {
    if (a.index == null) return -1;
    if (b.index == null) return 1;
    return a.index - b.index;
  });
  const parts = chunks.map((c) =>
    c.chunk instanceof Blob ? c.chunk : new Blob([c.chunk])
  );
  const fullBlob = new Blob(parts, { type: "video/webm" });
  return await uploadBlob(fullBlob, fileName, destination);
};

const uploadBlob = async (blob, fileName, destination) => {
  if (!destination) {
    const stored = await chrome.storage.local.get(["destination"]);
    destination = stored.destination;
  }
  if (!destination) {
    return { status: "skipped", reason: "no-destination-configured" };
  }

  diagEvent("stream-upload-start", {
    destination,
    blobSize: blob.size,
    blobType: blob.type,
  });

  try {
    let result;
    switch (destination) {
      case "drive":
        result = await uploadBlobToDrive(blob, fileName);
        break;
      case "youtube":
        result = await uploadBlobToYoutube(blob, fileName);
        break;
      case "s3":
        result = await uploadBlobToS3(blob, fileName);
        break;
      default:
        return { status: "error", reason: `unknown-destination: ${destination}` };
    }

    diagEvent("stream-upload-result", { destination, status: result.status, url: result.url });
    return result;
  } catch (err) {
    console.error("[StreamUpload] auto-upload failed:", err);
    diagEvent("stream-upload-fail", { destination, error: String(err.message).slice(0, 120) });
    return { status: "error", error: err.message };
  }
};

export const autoUploadRecording = async (videoBlob, fileName, destination) => {
  return await uploadBlob(videoBlob, fileName, destination);
};

export { getDestination };
