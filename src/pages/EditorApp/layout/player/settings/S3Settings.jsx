import React, { useState, useEffect } from "react";
import styles from "../../../styles/player/_RightPanel.module.scss";

const URL =
  "chrome-extension://" + chrome.i18n.getMessage("@@extension_id") + "/assets/";

const S3Settings = ({ onClose, onSave }) => {
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("");
  const [bucket, setBucket] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [pathPrefix, setPathPrefix] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "get-s3-config" }).then((config) => {
      if (config?.s3Endpoint) {
        setEndpoint(config.s3Endpoint);
        setRegion(config.s3Region || "");
        setBucket(config.s3Bucket || "");
        setAccessKeyId(config.s3AccessKeyId || "");
        setSecretAccessKey(config.s3SecretAccessKey || "");
        setPathPrefix(config.s3PathPrefix || "");
      }
    });
  }, []);

  const handleSave = async () => {
    if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
      setMessage({ type: "error", text: "All fields except Path Prefix are required." });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await chrome.runtime.sendMessage({
        type: "save-to-s3-config",
        endpoint,
        region,
        bucket,
        accessKeyId,
        secretAccessKey,
        pathPrefix,
      });
      setMessage({ type: "success", text: "S3 settings saved." });
      if (onSave) onSave();
    } catch (err) {
      setMessage({ type: "error", text: "Failed to save: " + err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    await chrome.runtime.sendMessage({ type: "clear-s3-config" });
    setEndpoint("");
    setRegion("");
    setBucket("");
    setAccessKeyId("");
    setSecretAccessKey("");
    setPathPrefix("");
    setMessage({ type: "success", text: "S3 configuration cleared." });
  };

  const inputStyle = {
    width: "100%",
    padding: "8px 10px",
    marginBottom: "10px",
    border: "1px solid #ddd",
    borderRadius: "6px",
    fontSize: "13px",
    fontFamily: "inherit",
    boxSizing: "border-box",
  };

  const labelStyle = {
    display: "block",
    fontSize: "12px",
    fontWeight: 600,
    color: "#555",
    marginBottom: "4px",
  };

  const rowStyle = {
    marginBottom: "4px",
  };

  return (
    <div style={{ padding: "8px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <div style={{ fontSize: "15px", fontWeight: 700 }}>S3 Storage Settings</div>
        <div
          role="button"
          onClick={onClose}
          style={{ cursor: "pointer", fontSize: "13px", color: "#888" }}
        >
          Back
        </div>
      </div>

      <div style={rowStyle}>
        <label style={labelStyle}>Endpoint URL</label>
        <input
          style={inputStyle}
          type="text"
          placeholder="https://s3.us-east-1.amazonaws.com"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
        />
      </div>

      <div style={rowStyle}>
        <label style={labelStyle}>Region</label>
        <input
          style={inputStyle}
          type="text"
          placeholder="us-east-1"
          value={region}
          onChange={(e) => setRegion(e.target.value)}
        />
      </div>

      <div style={rowStyle}>
        <label style={labelStyle}>Bucket Name</label>
        <input
          style={inputStyle}
          type="text"
          placeholder="my-screenity-recordings"
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
        />
      </div>

      <div style={rowStyle}>
        <label style={labelStyle}>Access Key ID</label>
        <input
          style={inputStyle}
          type="text"
          placeholder="AKIAIOSFODNN7EXAMPLE"
          value={accessKeyId}
          onChange={(e) => setAccessKeyId(e.target.value)}
        />
      </div>

      <div style={rowStyle}>
        <label style={labelStyle}>Secret Access Key</label>
        <input
          style={inputStyle}
          type="password"
          placeholder="Enter your secret key"
          value={secretAccessKey}
          onChange={(e) => setSecretAccessKey(e.target.value)}
        />
      </div>

      <div style={rowStyle}>
        <label style={labelStyle}>Path Prefix (optional)</label>
        <input
          style={inputStyle}
          type="text"
          placeholder="recordings/videos"
          value={pathPrefix}
          onChange={(e) => setPathPrefix(e.target.value)}
        />
      </div>

      {message && (
        <div
          style={{
            padding: "8px 12px",
            marginBottom: "10px",
            borderRadius: "6px",
            fontSize: "13px",
            backgroundColor: message.type === "success" ? "#d4edda" : "#f8d7da",
            color: message.type === "success" ? "#155724" : "#721c24",
          }}
        >
          {message.text}
        </div>
      )}

      <div style={{ display: "flex", gap: "10px", marginTop: "16px" }}>
        <div
          role="button"
          onClick={handleSave}
          style={{
            flex: 1,
            padding: "10px",
            textAlign: "center",
            borderRadius: "6px",
            backgroundColor: saving ? "#aaa" : "#387ef7",
            color: "#fff",
            fontWeight: 600,
            fontSize: "14px",
            cursor: saving ? "default" : "pointer",
          }}
        >
          {saving ? "Saving\u2026" : "Save Settings"}
        </div>
        <div
          role="button"
          onClick={handleClear}
          style={{
            padding: "10px 16px",
            textAlign: "center",
            borderRadius: "6px",
            border: "1px solid #ddd",
            color: "#888",
            fontSize: "13px",
            cursor: "pointer",
          }}
        >
          Clear
        </div>
      </div>
    </div>
  );
};

export default S3Settings;
