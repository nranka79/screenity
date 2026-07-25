const hmacSha256 = async (key, msg) => {
  const keyBytes = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(msg));
  return new Uint8Array(sig);
};

const sha256 = async (str) => {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
};

const hexEncode = (arr) =>
  Array.from(new Uint8Array(arr)).map((b) => b.toString(16).padStart(2, "0")).join("");

const hmacHex = async (key, msg) => hexEncode(await hmacSha256(key, msg));

const getSignatureKey = async (key, dateStamp, region, service) => {
  let k = await hmacSha256("AWS4" + key, dateStamp);
  k = await hmacSha256(k, region);
  k = await hmacSha256(k, service);
  k = await hmacSha256(k, "aws4_request");
  return k;
};

export const signRequestV4 = async ({
  method,
  path,
  queryString = "",
  headers,
  body,
  region,
  accessKeyId,
  secretAccessKey,
  service = "s3",
  bucket,
}) => {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const bodyHash = await sha256(body || "");

  const canonicalUri = path.startsWith("/") ? path : "/" + path;
  const canonicalQuery = queryString;

  const signedHeaders = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort()
    .join(";");

  const canonicalHeaders =
    Object.entries(headers)
      .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map(([k, v]) => `${k.toLowerCase()}:${v.trim()}\n`)
      .join("") + `x-amz-content-sha256:${bodyHash}\n` + `x-amz-date:${amzDate}\n`;

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    await sha256(canonicalRequest),
  ].join("\n");

  const signingKey = await getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signature = await hmacHex(signingKey, stringToSign);

  const authorizationHeader = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    authorizationHeader,
    amzDate,
    bodyHash,
  };
};
