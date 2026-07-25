import { signRequestV4 } from "./awsSignatureV4";
import { diagEvent } from "../../utils/diagnosticLog";

const S3_PART_SIZE = 8 * 1024 * 1024;
const MAX_PART_ATTEMPTS = 5;

const getS3Config = async () => {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(
      ["s3Endpoint", "s3Region", "s3Bucket", "s3AccessKeyId", "s3SecretAccessKey", "s3PathPrefix"],
      (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        const { s3Endpoint, s3Region, s3Bucket, s3AccessKeyId, s3SecretAccessKey, s3PathPrefix } = result;
        if (!s3Endpoint || !s3Region || !s3Bucket || !s3AccessKeyId || !s3SecretAccessKey) {
          reject(new Error("S3 configuration incomplete"));
          return;
        }
        resolve({
          endpoint: s3Endpoint.replace(/\/+$/, ""),
          region: s3Region,
          bucket: s3Bucket,
          accessKeyId: s3AccessKeyId,
          secretAccessKey: s3SecretAccessKey,
          pathPrefix: (s3PathPrefix || "").replace(/^\/+|\/+$/g, ""),
        });
      },
    );
  });
};

const buildS3Headers = (config, additional = {}) => ({
  host: new URL(config.endpoint).host,
  "content-type": "application/octet-stream",
  ...additional,
});

const s3Fetch = async (config, method, path, queryString = "", body = null, extraHeaders = {}) => {
  const headers = buildS3Headers(config, extraHeaders);
  const url = `${config.endpoint}/${config.bucket}${path.startsWith("/") ? "" : "/"}${path}${queryString ? "?" + queryString : ""}`;

  const { authorizationHeader, amzDate, bodyHash } = await signRequestV4({
    method,
    path: `/${config.bucket}${path.startsWith("/") ? "" : "/"}${path}`,
    queryString,
    headers,
    body: body ? await body.text() : "",
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucket: config.bucket,
  });

  const finalHeaders = {
    ...headers,
    "x-amz-content-sha256": bodyHash,
    "x-amz-date": amzDate,
    Authorization: authorizationHeader,
    ...extraHeaders,
  };

  const res = await fetch(url, {
    method,
    headers: finalHeaders,
    body,
  });

  return res;
};

const initiateMultipartUpload = async (config, objectKey) => {
  const res = await s3Fetch(config, "POST", `${objectKey}?uploads`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`S3 multipart init failed: ${res.status} ${text}`);
  }
  const xml = await res.text();
  const uploadIdMatch = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
  if (!uploadIdMatch) throw new Error("S3 multipart init: no UploadId in response");
  return uploadIdMatch[1];
};

const uploadPart = async (config, objectKey, uploadId, partNumber, blob) => {
  const queryString = `uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`;
  const buffer = await blob.arrayBuffer();
  const body = new Blob([buffer]);

  let res;
  for (let attempt = 0; attempt < MAX_PART_ATTEMPTS; attempt++) {
    try {
      res = await s3Fetch(config, "PUT", objectKey, queryString, body);
    } catch (err) {
      if (attempt === MAX_PART_ATTEMPTS - 1) throw err;
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    if (res.ok) break;
    const isTransient = res.status === 500 || res.status === 503 || res.status === 429;
    if (!isTransient || attempt === MAX_PART_ATTEMPTS - 1) {
      const text = await res.text().catch(() => "");
      throw new Error(`S3 part upload failed: ${res.status} ${text}`);
    }
    const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
    await new Promise((r) => setTimeout(r, delay));
  }

  const etag = res.headers.get("etag");
  if (!etag) throw new Error("S3 part upload: no ETag in response");
  return { etag, partNumber };
};

const completeMultipartUpload = async (config, objectKey, uploadId, parts) => {
  const sortedParts = parts.sort((a, b) => a.partNumber - b.partNumber);
  const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${sortedParts.map(
    (p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`,
  ).join("")}</CompleteMultipartUpload>`;

  const res = await s3Fetch(config, "POST", objectKey, `uploadId=${encodeURIComponent(uploadId)}`, new Blob([xmlBody], { type: "application/xml" }));
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`S3 multipart complete failed: ${res.status} ${text}`);
  }
};

const abortMultipartUpload = async (config, objectKey, uploadId) => {
  try {
    await s3Fetch(config, "DELETE", objectKey, `uploadId=${encodeURIComponent(uploadId)}`);
  } catch {}
};

const saveToS3 = async (videoBlob, fileName) => {
  const config = await getS3Config();
  const ext = videoBlob.type.includes("webm") ? ".webm" : ".mp4";
  const safeName = fileName || "Screenity Recording";
  const timestamp = Date.now();
  const objectKey = config.pathPrefix
    ? `${config.pathPrefix}/${safeName}-${timestamp}${ext}`
    : `${safeName}-${timestamp}${ext}`;

  try {
    diagEvent("s3-upload-start", {
      blobSize: videoBlob.size,
      blobType: videoBlob.type,
      endpoint: config.endpoint,
      bucket: config.bucket,
      key: objectKey,
    });

    const uploadId = await initiateMultipartUpload(config, objectKey);
    const parts = [];
    const totalSize = videoBlob.size;
    let offset = 0;
    let partNumber = 1;

    while (offset < totalSize) {
      const end = Math.min(offset + S3_PART_SIZE, totalSize);
      const chunkBlob = videoBlob.slice(offset, end);
      const { etag } = await uploadPart(config, objectKey, uploadId, partNumber, chunkBlob);
      parts.push({ etag, partNumber });
      offset = end;
      partNumber++;
    }

    await completeMultipartUpload(config, objectKey, uploadId, parts);

    const fileUrl = `${config.endpoint}/${config.bucket}/${objectKey}`;
    diagEvent("s3-upload-ok", { key: objectKey, url: fileUrl, parts: parts.length });

    return { status: "ok", url: fileUrl, key: objectKey };
  } catch (error) {
    console.error("[S3] upload failed:", error.message);
    diagEvent("s3-upload-fail", { error: String(error.message).slice(0, 120) });
    return { status: "ew", url: null, error: error.message };
  }
};

export const handleSaveToS3 = async (request) => {
  try {
    let blob;
    if (request.opfsFileName) {
      const dir = await navigator.storage.getDirectory();
      const handle = await dir.getFileHandle(request.opfsFileName);
      blob = await handle.getFile();
    } else if (request.blob) {
      blob = request.blob;
    } else {
      const { s3Endpoint } = await new Promise((resolve) =>
        chrome.storage.local.get(["s3Endpoint"], resolve),
      );
      if (s3Endpoint) {
        return { status: "ok", url: null, message: "S3 configured. Start a recording first." };
      }
      return { status: "ew", url: null, error: "No video data and no S3 config found for upload" };
    }
    return await saveToS3(blob, request.title);
  } catch (err) {
    console.error("[S3] handleSaveToS3 failed:", err);
    return { status: "ew", url: null, error: err.message };
  }
};
