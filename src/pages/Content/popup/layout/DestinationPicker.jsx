import React, { useState } from "react";

const styles = {
  container: {
    padding: "16px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  title: {
    fontSize: "16px",
    fontWeight: 600,
    marginBottom: "12px",
    color: "#231f20",
  },
  subtitle: {
    fontSize: "13px",
    color: "#3e3e3d",
    marginBottom: "16px",
    lineHeight: 1.4,
  },
  option: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "12px",
    marginBottom: "8px",
    borderRadius: "8px",
    border: "1px solid #e0e0e0",
    cursor: "pointer",
    transition: "all 0.2s",
    backgroundColor: "#fff",
  },
  icon: {
    fontSize: "24px",
    width: "40px",
    height: "40px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "8px",
  },
  driveIcon: {
    backgroundColor: "#FEF7E6",
  },
  youtubeIcon: {
    backgroundColor: "#FEF7E6",
  },
  s3Icon: {
    backgroundColor: "#FEF7E6",
  },
  label: {
    fontSize: "14px",
    fontWeight: 500,
    color: "#231f20",
  },
  desc: {
    fontSize: "11px",
    color: "#3e3e3d",
    marginTop: "2px",
  },
  s3Form: {
    marginTop: "12px",
    padding: "12px",
    backgroundColor: "#FEF7E6",
    borderRadius: "8px",
  },
  input: {
    width: "100%",
    padding: "8px",
    marginBottom: "8px",
    borderRadius: "6px",
    border: "1px solid #ddd",
    fontSize: "12px",
    boxSizing: "border-box",
  },
  button: {
    padding: "8px 16px",
    borderRadius: "6px",
    border: "none",
    backgroundColor: "#f7b519",
    color: "#231f20",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
  },
  cancelButton: {
    padding: "8px 16px",
    borderRadius: "6px",
    border: "1px solid #ddd",
    backgroundColor: "#fff",
    color: "#3e3e3d",
    fontSize: "12px",
    cursor: "pointer",
    marginLeft: "8px",
  },
  skipButton: {
    marginTop: "16px",
    textAlign: "center",
    fontSize: "12px",
    color: "#3e3e3d",
    cursor: "pointer",
    textDecoration: "underline",
  },
  error: {
    color: "#d32f2f",
    fontSize: "12px",
    marginTop: "8px",
  },
  success: {
    color: "#388e3c",
    fontSize: "12px",
    marginTop: "8px",
  },
  loading: {
    color: "#f7b519",
    fontSize: "12px",
    marginTop: "8px",
  },
};

const DestinationPicker = ({ onComplete }) => {
  const [hovered, setHovered] = useState(null);
  const [showS3Form, setShowS3Form] = useState(false);
  const [s3Config, setS3Config] = useState({
    endpoint: "",
    region: "",
    bucket: "",
    accessKeyId: "",
    secretAccessKey: "",
    pathPrefix: "",
  });
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);

  const handleGoogleDestination = async (dest) => {
    setStatus("authenticating");
    setError(null);
    try {
      const scope = dest === "youtube"
        ? "https://www.googleapis.com/auth/youtube.upload"
        : undefined;
      const result = await chrome.runtime.sendMessage({
        type: "sign-in-for-destination",
        destination: dest,
        scope,
      });
      if (result?.status === "ok") {
        await chrome.storage.local.set({ destination: dest });
        setStatus("authenticated");
        setTimeout(() => {
          if (onComplete) onComplete(dest);
        }, 800);
      } else {
        setError(result?.error || "Sign-in failed or was cancelled");
        setStatus(null);
      }
    } catch (err) {
      setError(err.message);
      setStatus(null);
    }
  };

  const handleS3Save = async () => {
    const { endpoint, region, bucket, accessKeyId, secretAccessKey } = s3Config;
    if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
      setError("Please fill in all required fields");
      return;
    }
    setStatus("saving");
    setError(null);
    try {
      await chrome.runtime.sendMessage({
        type: "save-to-s3-config",
        endpoint: endpoint.trim(),
        region: region.trim(),
        bucket: bucket.trim(),
        accessKeyId: accessKeyId.trim(),
        secretAccessKey: secretAccessKey.trim(),
        pathPrefix: s3Config.pathPrefix.trim(),
      });
      await chrome.storage.local.set({ destination: "s3" });
      setStatus("configured");
      setTimeout(() => {
        if (onComplete) onComplete("s3");
      }, 800);
    } catch (err) {
      setError(err.message);
      setStatus(null);
    }
  };

  const handleSkip = async () => {
    await chrome.storage.local.set({ destination: "local" });
    if (onComplete) onComplete("local");
  };

  const optionBase = (id, label, desc, icon, iconStyle) => (
    <div
      key={id}
      style={{
        ...styles.option,
        ...(hovered === id ? { borderColor: "#f7b519", backgroundColor: "#FEF7E6" } : {}),
        ...(status === "authenticating" && hovered === id ? { opacity: 0.6, pointerEvents: "none" } : {}),
      }}
      onMouseEnter={() => setHovered(id)}
      onMouseLeave={() => setHovered(null)}
      onClick={() => {
        if (id === "s3") {
          setShowS3Form(true);
        } else {
          handleGoogleDestination(id);
        }
      }}
    >
      <div style={{ ...styles.icon, ...iconStyle }}>{icon}</div>
      <div>
        <div style={styles.label}>{label}</div>
        <div style={styles.desc}>{desc}</div>
      </div>
    </div>
  );

  if (showS3Form) {
    return (
      <div style={styles.container}>
        <div style={styles.title}>Configure S3 Storage</div>
        <div style={styles.subtitle}>Enter your S3-compatible storage details</div>
        <div style={styles.s3Form}>
          <input
            style={styles.input}
            placeholder="Endpoint (e.g. https://s3.amazonaws.com)"
            value={s3Config.endpoint}
            onChange={(e) => setS3Config({ ...s3Config, endpoint: e.target.value })}
          />
          <input
            style={styles.input}
            placeholder="Region (e.g. us-east-1)"
            value={s3Config.region}
            onChange={(e) => setS3Config({ ...s3Config, region: e.target.value })}
          />
          <input
            style={styles.input}
            placeholder="Bucket name"
            value={s3Config.bucket}
            onChange={(e) => setS3Config({ ...s3Config, bucket: e.target.value })}
          />
          <input
            style={styles.input}
            placeholder="Access Key ID"
            value={s3Config.accessKeyId}
            onChange={(e) => setS3Config({ ...s3Config, accessKeyId: e.target.value })}
          />
          <input
            style={styles.input}
            type="password"
            placeholder="Secret Access Key"
            value={s3Config.secretAccessKey}
            onChange={(e) => setS3Config({ ...s3Config, secretAccessKey: e.target.value })}
          />
          <input
            style={styles.input}
            placeholder="Path prefix (optional, e.g. recordings/)"
            value={s3Config.pathPrefix}
            onChange={(e) => setS3Config({ ...s3Config, pathPrefix: e.target.value })}
          />
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              style={styles.button}
              onClick={handleS3Save}
              disabled={status === "saving"}
            >
              {status === "saving" ? "Saving..." : "Save & Continue"}
            </button>
            <button
              style={styles.cancelButton}
              onClick={() => setShowS3Form(false)}
            >
              Back
            </button>
          </div>
          {status === "configured" && <div style={styles.success}>S3 configured successfully!</div>}
          {error && <div style={styles.error}>{error}</div>}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.title}>Where should recordings go?</div>
      <div style={styles.subtitle}>
        Your recordings will be automatically uploaded here. You can change this later in settings.
      </div>

      {optionBase("drive", "Google Drive", "Saved to a Screenity folder in your Drive", "📁", styles.driveIcon)}
      {optionBase("youtube", "YouTube (unlisted)", "Uploaded as unlisted videos to your channel", "▶️", styles.youtubeIcon)}
      {optionBase("s3", "S3 Compatible Storage", "Upload to your own S3 bucket", "☁️", styles.s3Icon)}

      {status === "authenticating" && (
        <div style={styles.loading}>Signing in with Google...</div>
      )}
      {status === "authenticated" && (
        <div style={styles.success}>Signed in! Redirecting...</div>
      )}
      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.skipButton} onClick={handleSkip}>
        Skip — save locally only
      </div>
    </div>
  );
};

export default DestinationPicker;
