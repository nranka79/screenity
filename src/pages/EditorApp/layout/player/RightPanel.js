import React, { useContext, useEffect, useState, useRef } from "react";
import styles from "../../styles/player/_RightPanel.module.scss";

import { buildDiagnosticZip } from "../../../utils/buildDiagnosticZip";
import { downloadResolvedRecording } from "../../recorderStorage/resolveRecordingFile";
import { stageBlobToOpfs } from "../../recorderStorage/stageBlobToOpfs";
import { diagForward } from "../../../utils/diagForward";
import { showEditorToast } from "../../utils/editorToast";

import { ReactSVG } from "react-svg";

const URL =
  "chrome-extension://" + chrome.i18n.getMessage("@@extension_id") + "/assets/";

import CropUI from "../editor/CropUI";
import AudioUI from "../editor/AudioUI";
import S3Settings from "./settings/S3Settings";

import { ContentStateContext } from "../../context/ContentState";

const RightPanel = () => {
  const [contentState, setContentState] = useContext(ContentStateContext);
  const contentStateRef = useRef(contentState);
  const consoleErrorRef = useRef([]);
  const [settingsView, setSettingsView] = useState(null);
  const [youtubeStatus, setYoutubeStatus] = useState(null);
  const [youtubeUploadProgress, setYoutubeUploadProgress] = useState(null);
  const [youtubeUploadResult, setYoutubeUploadResult] = useState(null);
  const youtubeRequestIdRef = useRef(null);
  // `disabled` on a <div role="button"> is inert, so the click still fires
  // while a save is in flight. contentStateRef lags a render, so hold the
  // in-flight lock in its own ref and clear it when saveDrive goes false
  // (failWith, or the "saved-to-drive" message on success).
  const saveDriveInFlight = useRef(false);

  useEffect(() => {
    console.error = (error) => {
      consoleErrorRef.current.push(error);
    };
  }, []);

  useEffect(() => {
    contentStateRef.current = contentState;
  }, [contentState]);

  useEffect(() => {
    if (!contentState.saveDrive) saveDriveInFlight.current = false;
  }, [contentState.saveDrive]);

  useEffect(() => {
    const listener = (msg) => {
      if (msg?.type === "youtube-upload-progress" && msg.requestId === youtubeRequestIdRef.current) {
        setYoutubeUploadProgress(msg.progress);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const getNotAvailableLabel = () => {
    if (contentState.fallback && contentState.noffmpeg && contentState.editLimit === 0) {
      return chrome.i18n.getMessage("notAvailableLongRecording");
    }
    if (contentState.fallback && contentState.noffmpeg) {
      return chrome.i18n.getMessage("notAvailableRecoveryMode");
    }
    return chrome.i18n.getMessage("notAvailableLabel");
  };

  const getPreparingLabel = () => {
    const base = chrome.i18n.getMessage("preparingLabel");
    const pct = Math.round(contentState.processingProgress || 0);
    if (!contentState.mp4ready && pct > 0) {
      return `${base} (${pct}%)`;
    }
    return base;
  };

  // sendMessage rejects past ~64 MB, and base64 inflates ~1.33x, so a base64
  // Drive upload is unsafe above ~48 MB. The OPFS path has no such limit; this
  // only gates the fallback when OPFS staging is unavailable.
  const DRIVE_BASE64_MAX_BYTES = 48 * 1024 * 1024;

  const saveToDrive = async () => {
    if (saveDriveInFlight.current) return;
    saveDriveInFlight.current = true;
    setContentState((prevContentState) => ({
      ...prevContentState,
      saveDrive: true,
    }));

    // Modal rather than a toast: the editor is an extension page, and the
    // background's show-toast relay only reaches the content script of the
    // active tab, so a toast raised here is never seen by someone sitting in
    // the editor. A modal also carries the recovery action for each cause.
    const failWith = (errorCode) => {
      const code = errorCode || "drive-generic";
      diagForward("editor-drive-save-fail", { errorCode: code });
      const base =
        {
          "drive-quota": "driveQuota",
          "drive-too-large": "driveTooLarge",
          "drive-auth": "driveAuth",
        }[code] || "driveGeneric";

      const openModal = contentStateRef.current?.openModal;
      if (typeof openModal === "function") {
        // Quota is the one cause retrying can't clear, so it links out to
        // Drive storage instead. Too-large has no recovery from here.
        let buttonLabel = chrome.i18n.getMessage("offlineLabelTryAgain");
        let action = () => runSaveToDrive();
        if (code === "drive-quota") {
          buttonLabel = chrome.i18n.getMessage("manageStorageButtonLabel");
          action = () =>
            window.open("https://drive.google.com/settings/storage", "_blank");
        } else if (code === "drive-too-large") {
          buttonLabel = null;
          action = () => {};
        }
        openModal(
          chrome.i18n.getMessage(`${base}ModalTitle`),
          chrome.i18n.getMessage(`${base}ModalDescription`),
          buttonLabel,
          chrome.i18n.getMessage("closeModalLabel"),
          action,
          () => {},
        );
      }

      setContentState((prevContentState) => ({
        ...prevContentState,
        saveDrive: false,
        driveError: code,
      }));
    };

    const handleDriveResponse = (response) => {
      if (!response || response.status === "ew" || response.error) {
        console.error(
          "[Drive] drive_save_failed:",
          response?.error || "unknown error",
        );
        failWith(response?.errorCode);
      }
      // On success, saveDrive is reset by the "saved-to-drive" message.
    };
    const handleDriveError = (err) => {
      console.error("[Drive] drive_save_error:", err);
      failWith("drive-generic");
    };

    // Pick the source: the MP4 export when ready, else the duration-fixed webm.
    // With neither, the background rebuilds from IndexedDB chunks itself (no
    // base64 transfer), so route straight to the fallback.
    const useMp4 =
      !contentState.noffmpeg && contentState.mp4ready && contentState.blob;
    const source = useMp4 ? contentState.blob : contentState.webm;
    const isWebm = !useMp4;

    if (!(source instanceof Blob) || source.size === 0) {
      chrome.runtime
        .sendMessage({ type: "save-to-drive-fallback", title: contentState.title })
        .then(handleDriveResponse)
        .catch(handleDriveError);
      return;
    }

    diagForward("editor-drive-save-start", {
      bytes: source.size,
      isWebm,
      transport: "opfs",
    });

    // Preferred: stage into OPFS and send only the filename. Streams to disk,
    // so it's memory-safe at any size — this is the large-file fix.
    const opfsFileName = await stageBlobToOpfs(source, isWebm ? "webm" : "mp4");
    if (opfsFileName) {
      chrome.runtime
        .sendMessage({
          type: "save-to-drive",
          opfsFileName,
          isWebm,
          title: contentState.title,
        })
        .then(handleDriveResponse)
        .catch(handleDriveError);
      return;
    }

    // OPFS unavailable: fall back to base64, but only when small enough to
    // survive the message-size cap. Above it, tell the user instead of failing
    // silently the way this used to.
    if (source.size > DRIVE_BASE64_MAX_BYTES) {
      // Not a Drive limit: OPFS staging failed and the base64 fallback can't
      // carry this much over sendMessage. Drive would accept the file, so
      // don't tell the user it's too large for Drive; retrying can restage it.
      failWith("drive-generic");
      return;
    }
    diagForward("editor-drive-save-start", {
      bytes: source.size,
      isWebm,
      transport: "base64",
    });
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(",")[1];
      chrome.runtime
        .sendMessage({
          type: "save-to-drive",
          base64,
          title: contentState.title,
          isWebm,
        })
        .then(handleDriveResponse)
        .catch(handleDriveError);
    };
    reader.onerror = () => failWith("drive-generic");
    reader.readAsDataURL(source);
  };

  // Safety net: every failure path inside saveToDrive calls failWith, but an
  // unexpected throw would leave saveDrive stuck true and, now that the button
  // is genuinely gated, permanently dead.
  const runSaveToDrive = () => {
    saveToDrive().catch((err) => {
      console.error("[Drive] drive_save_unhandled:", err);
      saveDriveInFlight.current = false;
      setContentState((prevContentState) => ({
        ...prevContentState,
        saveDrive: false,
      }));
    });
  };

  const signOutDrive = () => {
    chrome.runtime.sendMessage({ type: "sign-out-drive" });
    setContentState((prevContentState) => ({
      ...prevContentState,
      driveEnabled: false,
    }));
  };

  const saveToS3 = async () => {
    const config = await chrome.runtime.sendMessage({ type: "get-s3-config" });
    if (!config?.s3Endpoint) {
      setSettingsView("s3");
      return;
    }

    setContentState((prev) => ({ ...prev, saveS3: true }));

    const useMp4 = !contentState.noffmpeg && contentState.mp4ready && contentState.blob;
    const source = useMp4 ? contentState.blob : contentState.webm;
    const isWebm = !useMp4;

    if (!(source instanceof Blob) || source.size === 0) {
      setContentState((prev) => ({ ...prev, saveS3: false }));
      return;
    }

    diagForward("editor-s3-save-start", { bytes: source.size, isWebm });

    const opfsFileName = await stageBlobToOpfs(source, isWebm ? "webm" : "mp4");
    if (opfsFileName) {
      chrome.runtime
        .sendMessage({
          type: "save-to-s3",
          opfsFileName,
          isWebm,
          title: contentState.title,
        })
        .then((response) => {
          setContentState((prev) => ({ ...prev, saveS3: false }));
          if (response?.status === "ok") {
            showEditorToast(contentStateRef.current, "Saved to S3: " + response.url);
          } else {
            showEditorToast(contentStateRef.current, "S3 upload failed: " + (response?.error || "unknown"));
          }
        })
        .catch(() => setContentState((prev) => ({ ...prev, saveS3: false })));
      return;
    }

    setContentState((prev) => ({ ...prev, saveS3: false }));
  };

  const saveToYoutube = async () => {
    console.log("[RightPanel] saveToYoutube: starting");
    console.log("[RightPanel]   mp4ready:", contentState.mp4ready, "noffmpeg:", contentState.noffmpeg, "blob:", contentState.blob ? "(present)" : "null", "webm:", contentState.webm ? "(present)" : "null");
    setYoutubeUploadProgress(0);
    setYoutubeUploadResult(null);
    setContentState((prev) => ({ ...prev, saveYoutube: true }));

    const useMp4 = !contentState.noffmpeg && contentState.mp4ready && contentState.blob;
    const source = useMp4 ? contentState.blob : contentState.webm;
    const isWebm = !useMp4;

    console.log("[RightPanel]   useMp4:", useMp4, "isWebm:", isWebm, "source size:", source?.size);

    if (!(source instanceof Blob) || source.size === 0) {
      console.error("[RightPanel] saveToYoutube: no valid source blob");
      setContentState((prev) => ({ ...prev, saveYoutube: false }));
      setYoutubeUploadProgress(null);
      return;
    }

    diagForward("editor-youtube-save-start", { bytes: source.size, isWebm });

    const opfsFileName = await stageBlobToOpfs(source, isWebm ? "webm" : "mp4");
    console.log("[RightPanel] saveToYoutube: staged to OPFS:", opfsFileName);
    if (opfsFileName) {
      const requestId = crypto.randomUUID();
      youtubeRequestIdRef.current = requestId;
      chrome.runtime
        .sendMessage({
          type: "save-to-youtube",
          opfsFileName,
          isWebm,
          title: contentState.title,
          requestId,
        })
        .then((response) => {
          setContentState((prev) => ({ ...prev, saveYoutube: false }));
          setYoutubeUploadProgress(100);
          console.log("[RightPanel] saveToYoutube: response =", JSON.stringify(response));
          if (response?.status === "ok") {
            setYoutubeUploadResult({ url: response.url, videoId: response.videoId });
            showEditorToast(contentStateRef.current, "Uploaded to YouTube");
          } else {
            setYoutubeUploadResult(null);
            setYoutubeUploadProgress(null);
            showEditorToast(contentStateRef.current, "YouTube upload failed: " + (response?.error || "unknown"));
          }
        })
        .catch((caughtErr) => {
          console.error("[RightPanel] saveToYoutube: error:", caughtErr);
          setContentState((prev) => ({ ...prev, saveYoutube: false }));
          setYoutubeUploadProgress(null);
        });
      return;
    }

    console.error("[RightPanel] saveToYoutube: failed to stage to OPFS");
    setContentState((prev) => ({ ...prev, saveYoutube: false }));
    setYoutubeUploadProgress(null);
  };

  const doSignInYoutube = async () => {
    console.log("[RightPanel] doSignInYoutube: sending sign-in-youtube message");
    const result = await chrome.runtime.sendMessage({ type: "sign-in-youtube" });
    console.log("[RightPanel] doSignInYoutube: result =", JSON.stringify(result));
    if (result?.status === "ok") {
      console.log("[RightPanel] doSignInYoutube: sign-in OK, setting youtubeEnabled");
      setContentState((prev) => ({ ...prev, youtubeEnabled: true }));
    } else {
      console.error("[RightPanel] doSignInYoutube: sign-in failed:", result?.error);
      showEditorToast(contentStateRef.current, result?.error || "YouTube sign-in failed");
    }
  };

  const signOutYoutube = () => {
    console.log("[RightPanel] signOutYoutube: signing out");
    chrome.runtime.sendMessage({ type: "sign-out-youtube" });
    showEditorToast(contentStateRef.current, "Signed out of YouTube");
    setYoutubeStatus(null);
    setContentState((prev) => ({ ...prev, youtubeEnabled: false }));
  };

  const handleEdit = () => {
    if (
      contentState.duration > contentState.editLimit &&
      !contentState.override
    )
      return;
    if (!contentState.mp4ready) return;

    contentState.createBackup();

    setContentState((prevContentState) => ({
      ...prevContentState,
      mode: "edit",
      dragInteracted: false,
    }));
  };

  const handleCrop = () => {
    if (
      contentState.duration > contentState.editLimit &&
      !contentState.override
    )
      return;

    if (!contentState.mp4ready) return;

    contentState.createBackup();

    // If the frame isn't cached yet, request it and defer the mode switch
    // until "new-frame" arrives, otherwise the cropper mounts over a blank
    // stage and there's a black flash for the round-trip duration.
    if (!contentState.frame) {
      setContentState((prevContentState) => ({
        ...prevContentState,
        pendingCropEntry: true,
      }));
      if (!contentState.isFfmpegRunning) contentState.getFrame();
      return;
    }

    setContentState((prevContentState) => ({
      ...prevContentState,
      mode: "crop",
    }));
  };

  const handleAddAudio = async () => {
    if (
      contentState.duration > contentState.editLimit &&
      !contentState.override
    )
      return;
    if (!contentState.mp4ready) return;

    contentState.createBackup();

    setContentState((prevContentState) => ({
      ...prevContentState,
      mode: "audio",
    }));
  };

  // Best available blob: edited MP4 → fixed WebM → raw WebM.
  const handleDownloadOriginal = () => {
    const s = contentStateRef.current;
    const source = s.blob || s.webm || s.rawBlob;
    if (!source) return;
    const blob =
      source instanceof Blob
        ? source
        : new Blob([source], { type: "video/webm" });
    const ext = blob.type.includes("mp4") ? "mp4" : "webm";
    const rawTitle = s.title || "screenity-recording";
    const safe = rawTitle
      .replace(/[\\:*?"<>|]/g, " ")
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "screenity-recording";
    const url = window.URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: `${safe}.${ext}` }, () => {
      window.URL.revokeObjectURL(url);
    });
  };

  const handleRawRecording = () => {
    if (typeof contentStateRef.current.openModal === "function") {
      contentStateRef.current.openModal(
        chrome.i18n.getMessage("rawRecordingModalTitle"),
        chrome.i18n.getMessage("rawRecordingModalDescription"),
        chrome.i18n.getMessage("rawRecordingModalButton"),
        chrome.i18n.getMessage("sandboxEditorCancelButton"),
        async () => {
          const s = contentStateRef.current;
          const blob = s.rawBlob || s.blob;
          if (!blob) {
            // In-memory blob never loaded (e.g. an orphaned OPFS pointer left
            // the editor unable to load). Recover straight from the OPFS file.
            await downloadResolvedRecording(s.title, (status) => {
              if (status === "started") return;
              showEditorToast(
                contentStateRef.current,
                chrome.i18n.getMessage("rawRecordingModalTitle") +
                  (status === "active" ? "" : ": no data"),
              );
            });
            return;
          }

          const ext = blob.type.includes("mp4") ? "mp4" : "webm";
          const filename = `raw-recording.${ext}`;

          // base64-via-BG fallback: works in Brave and when blob-URL downloads
          // are restricted, doesn't depend on chrome.downloads from here.
          const fallbackViaBackground = async () => {
            const base64 = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob);
            });
            chrome.runtime.sendMessage({
              type: "request-download",
              base64,
              title: filename,
            });
          };

          try {
            const url = window.URL.createObjectURL(blob);
            const downloadId = await new Promise((resolve, reject) => {
              try {
                chrome.downloads.download({ url, filename }, (id) => {
                  if (chrome.runtime.lastError || !id) {
                    reject(
                      chrome.runtime.lastError ||
                        new Error("download returned no id"),
                    );
                  } else {
                    resolve(id);
                  }
                });
              } catch (err) {
                reject(err);
              }
            });
            // Detect interrupted (non-user-cancel) downloads; matches the
            // main download flow in ContentState.jsx.
            const interruptHandler = async (delta) => {
              if (delta.id !== downloadId || !delta.state) return;
              if (
                delta.state.current === "interrupted" &&
                delta.error?.current !== "USER_CANCELED"
              ) {
                chrome.downloads.onChanged.removeListener(interruptHandler);
                try {
                  await fallbackViaBackground();
                } catch (err) {
                  console.error("[Screenity] raw download fallback failed:", err);
                }
              } else if (
                delta.state.current === "complete" ||
                delta.state.current === "interrupted"
              ) {
                chrome.downloads.onChanged.removeListener(interruptHandler);
                window.URL.revokeObjectURL(url);
              }
            };
            chrome.downloads.onChanged.addListener(interruptHandler);
          } catch (err) {
            console.warn(
              "[Screenity] raw download direct path failed, using fallback:",
              err,
            );
            try {
              await fallbackViaBackground();
            } catch (fallbackErr) {
              console.error(
                "[Screenity] raw download fallback failed:",
                fallbackErr,
              );
              showEditorToast(
                contentStateRef.current,
                chrome.i18n.getMessage("rawRecordingModalTitle") + ": failed",
              );
            }
          }
        },
        () => {}
      );
    }
  };

  const handleTroubleshooting = () => {
    if (typeof contentStateRef.current.openModal === "function") {
      contentStateRef.current.openModal(
        chrome.i18n.getMessage("troubleshootModalTitle"),
        chrome.i18n.getMessage("troubleshootModalDescription"),
        chrome.i18n.getMessage("troubleshootModalButton"),
        chrome.i18n.getMessage("sandboxEditorCancelButton"),
        async () => {
          try {
            const cs = contentStateRef.current;
            const { blob, filename } = await buildDiagnosticZip({
              source: "sandbox-editor",
              extraConfig: {
                editorMode: cs.mode || null,
                duration: cs.duration || null,
                width: cs.width || null,
                height: cs.height || null,
                hasBlobReady: Boolean(cs.blob || cs.rawBlob),
                mp4ready: Boolean(cs.mp4ready),
                ffmpegLoaded: Boolean(cs.ffmpegLoaded),
                fallback: Boolean(cs.fallback),
                offline: Boolean(cs.offline),
                noffmpeg: Boolean(cs.noffmpeg),
                updateChrome: Boolean(cs.updateChrome),
                hasBeenEdited: Boolean(cs.hasBeenEdited),
                editLimit: cs.editLimit || null,
              },
            });
            const url = window.URL.createObjectURL(blob);
            chrome.downloads.download(
              { url, filename },
              () => {
                window.URL.revokeObjectURL(url);
              },
            );
          } catch (err) {
            console.error("[Screenity] Troubleshooting export failed:", err);
          }
        },
        () => {},
      );
    }
  };

  return (
    <div className={styles.panel}>
      {contentState.mode === "audio" && <AudioUI />}
      {contentState.mode === "crop" && <CropUI />}
      {settingsView === "s3" && (
        <div>
          <S3Settings
            onClose={() => setSettingsView(null)}
            onSave={() => setSettingsView(null)}
          />
        </div>
      )}
      {settingsView === "youtube" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", padding: "0 8px" }}>
            <div style={{ fontSize: "15px", fontWeight: 700 }}>YouTube Account</div>
            <div
              role="button"
              onClick={() => setSettingsView(null)}
              style={{ cursor: "pointer", fontSize: "13px", color: "#888" }}
            >
              Back
            </div>
          </div>
          {youtubeStatus === "signed-in" || contentState.youtubeEnabled ? (
            <div style={{ padding: "8px", fontSize: "13px", color: "#155724", backgroundColor: "#d4edda", borderRadius: "6px", marginBottom: "12px" }}>
              Signed in to YouTube
            </div>
          ) : (
            <div>
              <div style={{ padding: "8px", fontSize: "13px", color: "#856404", backgroundColor: "#fff3cd", borderRadius: "6px", marginBottom: "12px" }}>
                Not signed in to YouTube.
              </div>
              <div
                role="button"
                className={styles.button}
                onClick={() => doSignInYoutube()}
              >
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>Sign in to YouTube</div>
                  <div className={styles.buttonDescription}>
                    Authorize Screenity to upload videos
                  </div>
                </div>
                <div className={styles.buttonRight}>
                  <ReactSVG src={URL + "editor/icons/right-arrow.svg"} />
                </div>
              </div>
            </div>
          )}
          {contentState.youtubeEnabled && (
            <div
              role="button"
              className={styles.button}
              onClick={() => { signOutYoutube(); setSettingsView(null); }}
            >
              <div className={styles.buttonMiddle}>
                <div className={styles.buttonTitle}>Sign out of YouTube</div>
              </div>
              <div className={styles.buttonRight}>
                <ReactSVG src={URL + "editor/icons/right-arrow.svg"} />
              </div>
            </div>
          )}
        </div>
      )}
      {settingsView === null && contentState.mode === "player" && (
        <div>
          {!contentState.fallback && contentState.offline && (
            <div className={styles.alert}>
              <div className={styles.buttonLeft}>
                <ReactSVG src={URL + "editor/icons/no-internet.svg"} />
              </div>
              <div className={styles.buttonMiddle}>
                <div className={styles.buttonTitle}>
                  {chrome.i18n.getMessage("offlineLabelTitle")}
                </div>
                <div className={styles.buttonDescription}>
                  {chrome.i18n.getMessage("offlineLabelDescription")}
                </div>
              </div>
              <div className={styles.buttonRight}>
                {chrome.i18n.getMessage("offlineLabelTryAgain")}
              </div>
            </div>
          )}
          {contentState.fallback && contentState.noffmpeg && contentState.editLimit === 0 && (
            <div className={styles.alert}>
              <div className={styles.buttonLeft}>
                <ReactSVG src={URL + "editor/icons/alert.svg"} />
              </div>
              <div className={styles.buttonMiddle}>
                <div className={styles.buttonTitle}>
                  {chrome.i18n.getMessage("longRecordingTitle")}
                </div>
                <div className={styles.buttonDescription}>
                  {chrome.i18n.getMessage("longRecordingDescription")}
                </div>
              </div>
              <div
                className={styles.buttonRight}
                onClick={handleDownloadOriginal}
              >
                {chrome.i18n.getMessage("rawRecordingModalButton")}
              </div>
            </div>
          )}
          {contentState.fallback && contentState.noffmpeg && contentState.editLimit !== 0 && (
            <div className={styles.alert}>
              <div className={styles.buttonLeft}>
                <ReactSVG src={URL + "editor/icons/alert.svg"} />
              </div>
              <div className={styles.buttonMiddle}>
                <div className={styles.buttonTitle}>
                  {chrome.i18n.getMessage("recoveryModeTitle")}
                </div>
                <div className={styles.buttonDescription}>
                  {chrome.i18n.getMessage("recoveryModeDescription")}
                </div>
              </div>
              <div
                className={styles.buttonRight}
                onClick={handleDownloadOriginal}
              >
                {chrome.i18n.getMessage("rawRecordingModalButton")}
              </div>
            </div>
          )}
          {!contentState.fallback &&
            contentState.updateChrome &&
            !contentState.offline &&
            contentState.duration <= contentState.editLimit && (
              <div className={styles.alert}>
                <div className={styles.buttonLeft}>
                  <ReactSVG src={URL + "editor/icons/alert.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {chrome.i18n.getMessage("updateChromeLabelTitle")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {chrome.i18n.getMessage("updateChromeLabelDescription")}
                  </div>
                </div>
                <div
                  className={styles.buttonRight}
                  onClick={() => {
                    chrome.runtime.sendMessage({ type: "chrome-update-info" });
                  }}
                >
                  {chrome.i18n.getMessage("learnMoreLabel")}
                </div>
              </div>
            )}
          {!contentState.fallback &&
            contentState.duration > contentState.editLimit &&
            !contentState.override &&
            !contentState.offline &&
            !contentState.updateChrome && (
              <div className={styles.alert}>
                <div className={styles.buttonLeft}>
                  <ReactSVG src={URL + "editor/icons/alert.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {chrome.i18n.getMessage("overLimitLabelTitle")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {contentState.blob?.type === "video/mp4"
                      ? chrome.i18n.getMessage(
                          "overLimitLabelDescriptionFastPath"
                        )
                      : chrome.i18n.getMessage("overLimitLabelDescription")}
                  </div>
                </div>
                <div
                  className={styles.buttonRight}
                  onClick={() => {
                    if (typeof contentState.openModal === "function") {
                      contentState.openModal(
                        chrome.i18n.getMessage("overLimitModalTitle"),
                        chrome.i18n.getMessage(
                          contentState.blob?.type === "video/mp4"
                            ? "overLimitModalDescriptionFastPath"
                            : "overLimitModalDescription"
                        ),
                        chrome.i18n.getMessage("overLimitModalButton"),
                        chrome.i18n.getMessage("sandboxEditorCancelButton"),
                        () => {
                          setContentState((prevContentState) => ({
                            ...prevContentState,
                            saved: true,
                          }));
                          chrome.runtime.sendMessage({
                            type: "force-processing",
                          });
                        },
                        () => {},
                        null,
                        chrome.i18n.getMessage("overLimitModalLearnMore"),
                        () => {
                          chrome.runtime.sendMessage({ type: "upgrade-info" });
                        }
                      );
                    }
                  }}
                >
                  {chrome.i18n.getMessage("learnMoreLabel")}
                </div>
              </div>
            )}
          {(contentState.downloadingWEBM || contentState.downloading) && (
            <div className={styles.alert}>
              <div className={styles.buttonLeft}>
                <ReactSVG src={URL + "editor/icons/alert.svg"} />
              </div>
              <div className={styles.buttonMiddle}>
                <div className={styles.buttonTitle}>
                  {chrome.i18n.getMessage("downloadProcessingTitle")}
                </div>
                <div className={styles.buttonDescription}>
                  {contentState.processingProgress > 0
                    ? `${chrome.i18n.getMessage(
                        "downloadProcessingDescription",
                      )} (${contentState.processingProgress}%)`
                    : chrome.i18n.getMessage("downloadProcessingDescription")}
                </div>
              </div>
              <div
                className={styles.buttonRight}
                onClick={() => contentState.cancelDownload?.()}
              >
                {chrome.i18n.getMessage("cancelLabel")}
              </div>
            </div>
          )}
          {(!contentState.mp4ready || contentState.isFfmpegRunning) &&
            !contentState.downloadingWEBM &&
            !contentState.downloading &&
            (contentState.duration <= contentState.editLimit ||
              contentState.override) &&
            !contentState.offline &&
            !contentState.updateChrome &&
            !contentState.noffmpeg && (
              <div className={styles.alert}>
                <div className={styles.buttonLeft}>
                  <ReactSVG src={URL + "editor/icons/alert.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {chrome.i18n.getMessage("videoProcessingLabelTitle")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {contentState.isFfmpegRunning
                      ? chrome.i18n.getMessage("editProcessingSafeDescription")
                      : chrome.i18n.getMessage("videoProcessingLabelDescription")}
                  </div>
                </div>
                {!contentState.isFfmpegRunning && (
                <div
                  className={styles.buttonRight}
                  onClick={() => {
                    chrome.runtime.sendMessage({
                      type: "pricing",
                    });
                  }}
                >
                  {chrome.i18n.getMessage("learnMoreLabel")}
                </div>
                )}
              </div>
            )}

          {!contentState.fallback &&
            contentState.editErrorType === "too-long" &&
            !(
              contentState.duration > contentState.editLimit &&
              !contentState.override
            ) && (
            <div className={styles.alert}>
              <div className={styles.buttonLeft}>
                <ReactSVG src={URL + "editor/icons/alert.svg"} />
              </div>
              <div className={styles.buttonMiddle}>
                <div className={styles.buttonTitle}>
                  {chrome.i18n.getMessage("editTooLongTitle")}
                </div>
                <div className={styles.buttonDescription}>
                  {chrome.i18n.getMessage("editTooLongDescription")}
                </div>
              </div>
              <div
                className={styles.buttonRight}
                onClick={() =>
                  setContentState((prev) => ({ ...prev, editErrorType: null }))
                }
              >
                {chrome.i18n.getMessage("permissionsModalDismiss")}
              </div>
            </div>
          )}
          {!contentState.fallback && contentState.editErrorType === "timeout" && (
            <div className={styles.alert}>
              <div className={styles.buttonLeft}>
                <ReactSVG src={URL + "editor/icons/alert.svg"} />
              </div>
              <div className={styles.buttonMiddle}>
                <div className={styles.buttonTitle}>
                  {chrome.i18n.getMessage("editTimeoutTitle")}
                </div>
                <div className={styles.buttonDescription}>
                  {chrome.i18n.getMessage("editTimeoutDescription")}
                </div>
              </div>
              <div
                className={styles.buttonRight}
                onClick={() =>
                  setContentState((prev) => ({ ...prev, editErrorType: null }))
                }
              >
                {chrome.i18n.getMessage("permissionsModalDismiss")}
              </div>
            </div>
          )}
          {!contentState.fallback && contentState.editErrorType === "failed" && (
            <div className={styles.alert}>
              <div className={styles.buttonLeft}>
                <ReactSVG src={URL + "editor/icons/alert.svg"} />
              </div>
              <div className={styles.buttonMiddle}>
                <div className={styles.buttonTitle}>
                  {chrome.i18n.getMessage("editFailedTitle")}
                </div>
                <div className={styles.buttonDescription}>
                  {chrome.i18n.getMessage("editFailedDescription")}
                </div>
              </div>
              <div
                className={styles.buttonRight}
                onClick={() =>
                  setContentState((prev) => ({ ...prev, editErrorType: null }))
                }
              >
                {chrome.i18n.getMessage("permissionsModalDismiss")}
              </div>
            </div>
          )}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>
              {chrome.i18n.getMessage("sandboxEditTitle")}
            </div>
            <div className={styles.buttonWrap}>
              <div
                role="button"
                className={styles.button}
                onClick={handleEdit}
                disabled={
                  (contentState.duration > contentState.editLimit &&
                    !contentState.override) ||
                  !contentState.mp4ready ||
                  contentState.noffmpeg
                }
              >
                <div className={styles.buttonLeft}>
                  <ReactSVG src={URL + "editor/icons/trim.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {chrome.i18n.getMessage("editButtonTitle")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {contentState.offline && !contentState.ffmpegLoaded
                      ? chrome.i18n.getMessage("noConnectionLabel")
                      : contentState.updateChrome ||
                        contentState.noffmpeg ||
                        (contentState.duration > contentState.editLimit &&
                          !contentState.override)
                      ? getNotAvailableLabel()
                      : contentState.mp4ready
                      ? chrome.i18n.getMessage("editButtonDescription")
                      : getPreparingLabel()}
                  </div>
                </div>
                <div className={styles.buttonRight}>
                  <ReactSVG src={URL + "editor/icons/right-arrow.svg"} />
                </div>
              </div>
              <div
                role="button"
                className={styles.button}
                onClick={handleCrop}
                disabled={
                  (contentState.duration > contentState.editLimit &&
                    !contentState.override) ||
                  !contentState.mp4ready ||
                  contentState.noffmpeg
                }
              >
                <div className={styles.buttonLeft}>
                  <ReactSVG src={URL + "editor/icons/crop.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {chrome.i18n.getMessage("cropButtonTitle")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {contentState.offline && !contentState.ffmpegLoaded
                      ? chrome.i18n.getMessage("noConnectionLabel")
                      : contentState.updateChrome ||
                        contentState.noffmpeg ||
                        (contentState.duration > contentState.editLimit &&
                          !contentState.override)
                      ? getNotAvailableLabel()
                      : contentState.mp4ready
                      ? chrome.i18n.getMessage("cropButtonDescription")
                      : getPreparingLabel()}
                  </div>
                </div>
                <div className={styles.buttonRight}>
                  <ReactSVG src={URL + "editor/icons/right-arrow.svg"} />
                </div>
              </div>
              <div
                role="button"
                className={styles.button}
                onClick={handleAddAudio}
                disabled={
                  (contentState.duration > contentState.editLimit &&
                    !contentState.override) ||
                  !contentState.mp4ready ||
                  contentState.noffmpeg
                }
              >
                <div className={styles.buttonLeft}>
                  <ReactSVG src={URL + "editor/icons/audio.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {chrome.i18n.getMessage("addAudioButtonTitle")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {contentState.offline && !contentState.ffmpegLoaded
                      ? chrome.i18n.getMessage("noConnectionLabel")
                      : contentState.updateChrome ||
                        contentState.noffmpeg ||
                        (contentState.duration > contentState.editLimit &&
                          !contentState.override)
                      ? getNotAvailableLabel()
                      : contentState.mp4ready
                      ? chrome.i18n.getMessage("addAudioButtonDescription")
                      : getPreparingLabel()}
                  </div>
                </div>
                <div className={styles.buttonRight}>
                  <ReactSVG src={URL + "editor/icons/right-arrow.svg"} />
                </div>
              </div>
            </div>
          </div>
          <div className={styles.section}>
            <div className={styles.sectionTitle}>
              {chrome.i18n.getMessage("sandboxSaveTitle")}
            </div>
            {contentState.driveEnabled && (
              <div
                className={styles.buttonLogout}
                onClick={() => {
                  signOutDrive();
                }}
              >
                {chrome.i18n.getMessage("signOutDriveLabel")}
              </div>
            )}
            <div className={styles.buttonWrap}>
              <div
                role="button"
                className={styles.button}
                onClick={runSaveToDrive}
                aria-disabled={contentState.saveDrive}
                disabled={contentState.saveDrive}
              >
                <div className={styles.buttonLeft}>
                  <ReactSVG src={URL + "editor/icons/drive.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {contentState.saveDrive
                      ? chrome.i18n.getMessage("savingDriveLabel")
                      : contentState.driveEnabled
                      ? chrome.i18n.getMessage("saveDriveButtonTitle")
                      : chrome.i18n.getMessage("signInDriveLabel")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {contentState.offline
                      ? chrome.i18n.getMessage("noConnectionLabel")
                      : contentState.updateChrome
                      ? chrome.i18n.getMessage("notAvailableLabel")
                      : chrome.i18n.getMessage("saveDriveButtonDescription")}
                  </div>
                </div>
                <div className={styles.buttonRight}>
                  <ReactSVG src={URL + "editor/icons/right-arrow.svg"} />
                </div>
              </div>
              <div
                role="button"
                className={styles.button}
                onClick={saveToS3}
                disabled={contentState.saveS3}
                aria-disabled={contentState.saveS3}
              >
                <div className={styles.buttonLeft}>
                  <ReactSVG src={URL + "editor/icons/upload.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {contentState.saveS3 ? "Saving to S3\u2026" : "Save to S3"}
                  </div>
                  <div className={styles.buttonDescription}>
                    Upload to your S3 bucket
                  </div>
                </div>
                <div className={styles.buttonRight}>
                  <ReactSVG src={URL + "editor/icons/right-arrow.svg"} />
                </div>
              </div>
              <div
                role="button"
                className={styles.button}
                onClick={() => { setSettingsView(settingsView === "s3" ? null : "s3"); }}
              >
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    S3 Settings
                  </div>
                  <div className={styles.buttonDescription}>
                    Configure your S3 storage
                  </div>
                </div>
                <div className={styles.buttonRight}>
                  <ReactSVG src={URL + "editor/icons/right-arrow.svg"} />
                </div>
              </div>
              <div
                role="button"
                className={styles.button}
                onClick={saveToYoutube}
                disabled={contentState.saveYoutube}
                aria-disabled={contentState.saveYoutube}
                style={{ position: "relative", overflow: "hidden" }}
              >
                {youtubeUploadProgress !== null && contentState.saveYoutube && (
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      height: "100%",
                      width: `${youtubeUploadProgress}%`,
                      backgroundColor: "rgba(56, 126, 247, 0.12)",
                      transition: "width 0.3s ease",
                      pointerEvents: "none",
                    }}
                  />
                )}
                <div className={styles.buttonLeft}>
                  <ReactSVG src={URL + "editor/icons/youtube.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {contentState.saveYoutube
                      ? `Uploading to YouTube\u2026 ${youtubeUploadProgress ?? 0}%`
                      : "Upload to YouTube"}
                  </div>
                  <div className={styles.buttonDescription}>
                    {contentState.youtubeEnabled ? "Upload as unlisted video" : "Sign in & upload as unlisted"}
                  </div>
                </div>
                <div className={styles.buttonRight}>
                  <ReactSVG src={URL + "editor/icons/right-arrow.svg"} />
                </div>
              </div>
              {youtubeUploadResult && (
                <div
                  style={{
                    padding: "12px",
                    backgroundColor: "#d4edda",
                    border: "1px solid #c3e6cb",
                    borderRadius: "6px",
                    marginTop: "8px",
                    fontSize: "13px",
                  }}
                >
                  <div style={{ fontWeight: 700, marginBottom: "8px", color: "#155724" }}>
                    Uploaded to YouTube
                  </div>
                  <div style={{ marginBottom: "8px", wordBreak: "break-all" }}>
                    <a href={youtubeUploadResult.url} target="_blank" rel="noopener noreferrer" style={{ color: "#155724" }}>
                      {youtubeUploadResult.url}
                    </a>
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <div
                      role="button"
                      onClick={() => {
                        navigator.clipboard.writeText(youtubeUploadResult.url);
                        showEditorToast(contentStateRef.current, "Link copied");
                      }}
                      style={{
                        padding: "6px 12px",
                        backgroundColor: "#155724",
                        color: "#fff",
                        borderRadius: "4px",
                        cursor: "pointer",
                        fontSize: "12px",
                      }}
                    >
                      Copy link
                    </div>
                    <div
                      role="button"
                      onClick={() => window.open(youtubeUploadResult.url, "_blank")}
                      style={{
                        padding: "6px 12px",
                        backgroundColor: "#155724",
                        color: "#fff",
                        borderRadius: "4px",
                        cursor: "pointer",
                        fontSize: "12px",
                      }}
                    >
                      Open in YouTube
                    </div>
                  </div>
                </div>
              )}
              <div
                role="button"
                className={styles.button}
                onClick={() => { setSettingsView(settingsView === "youtube" ? null : "youtube"); }}
              >
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    YouTube Account
                  </div>
                  <div className={styles.buttonDescription}>
                    {contentState.youtubeEnabled ? "Signed in" : "Not signed in"}
                  </div>
                </div>
                <div className={styles.buttonRight}>
                  <ReactSVG src={URL + "editor/icons/right-arrow.svg"} />
                </div>
              </div>
              {contentState.youtubeEnabled && (
                <div
                  className={styles.buttonLogout}
                  onClick={() => { signOutYoutube(); }}
                >
                  Sign out of YouTube
                </div>
              )}
            </div>
          </div>
          <div className={styles.section}>
            <div className={styles.sectionTitle}>
              {chrome.i18n.getMessage("sandboxExportTitle")}
            </div>
            <div className={styles.buttonWrap}>
              {contentState.fallback && (
                <div
                  role="button"
                  className={styles.button}
                  onClick={() => contentState.downloadWEBM()}
                  disabled={contentState.isFfmpegRunning}
                >
                  <div className={styles.buttonLeft}>
                    <ReactSVG src={URL + "editor/icons/download.svg"} />
                  </div>
                  <div className={styles.buttonMiddle}>
                    <div className={styles.buttonTitle}>
                      {contentState.downloadingWEBM
                        ? chrome.i18n.getMessage("downloadingLabel")
                        : chrome.i18n.getMessage("downloadWEBMButtonTitle")}
                    </div>
                    <div className={styles.buttonDescription}>
                      {chrome.i18n.getMessage("downloadWEBMButtonDescription")}
                    </div>
                  </div>
                  <div className={styles.buttonRight}>
                    <ReactSVG src={URL + "editor/icons/right-arrow.svg"} />
                  </div>
                </div>
              )}
              {(() => {
                // WebCodecs path produces a native MP4 blob; download is a
                // blob-URL anchor click, no ffmpeg/re-encode, so editLimit
                // and noffmpeg gates don't apply.
                const isNativeMp4 =
                  contentState.blob?.type === "video/mp4";
                const mp4Disabled = isNativeMp4
                  ? contentState.isFfmpegRunning || !contentState.mp4ready
                  : contentState.isFfmpegRunning ||
                    contentState.noffmpeg ||
                    !contentState.mp4ready;
                const mp4ShowNotAvailable = isNativeMp4
                  ? false
                  : contentState.updateChrome ||
                    contentState.noffmpeg ||
                    (contentState.duration > contentState.editLimit &&
                      !contentState.override);
                return (
              <div
                role="button"
                className={styles.button}
                onClick={() => {
                  if (!contentState.mp4ready) return;
                  contentState.download();
                }}
                disabled={mp4Disabled}
              >
                <div className={styles.buttonLeft}>
                  <ReactSVG src={URL + "editor/icons/download.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {contentState.downloading
                      ? chrome.i18n.getMessage("downloadingLabel")
                      : chrome.i18n.getMessage("downloadMP4ButtonTitle")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {contentState.offline &&
                    !contentState.ffmpegLoaded &&
                    !isNativeMp4
                      ? chrome.i18n.getMessage("noConnectionLabel")
                      : mp4ShowNotAvailable
                      ? getNotAvailableLabel()
                      : contentState.mp4ready && !contentState.isFfmpegRunning
                      ? chrome.i18n.getMessage("downloadMP4ButtonDescription")
                      : getPreparingLabel()}
                  </div>
                </div>
                <div className={styles.buttonRight}>
                  <ReactSVG src={URL + "editor/icons/right-arrow.svg"} />
                </div>
              </div>
                );
              })()}
              {!contentState.fallback && (
                <div
                  role="button"
                  className={styles.button}
                  onClick={() => contentState.downloadWEBM()}
                  disabled={contentState.isFfmpegRunning}
                >
                  <div className={styles.buttonLeft}>
                    <ReactSVG src={URL + "editor/icons/download.svg"} />
                  </div>
                  <div className={styles.buttonMiddle}>
                    <div className={styles.buttonTitle}>
                      {contentState.downloadingWEBM
                        ? chrome.i18n.getMessage("downloadingLabel")
                        : chrome.i18n.getMessage("downloadWEBMButtonTitle")}
                    </div>
                    <div className={styles.buttonDescription}>
                      {!contentState.isFfmpegRunning
                        ? chrome.i18n.getMessage(
                            "downloadWEBMButtonDescription"
                          )
                        : getPreparingLabel()}
                    </div>
                  </div>
                  <div className={styles.buttonRight}>
                    <ReactSVG src={URL + "editor/icons/right-arrow.svg"} />
                  </div>
                </div>
              )}
              <div
                role="button"
                className={styles.button}
                onClick={() => {
                  // disabled on a div is meaningless; gate click manually.
                  // Not gated on isFfmpegRunning: it leaks from background
                  // poll handlers and would intermittently swallow the
                  // click. downloadGIF self-locks via downloadingGIF.
                  if (
                    contentState.downloadingGIF ||
                    contentState.duration > 30 ||
                    !contentState.mp4ready ||
                    contentState.noffmpeg
                  ) {
                    return;
                  }
                  contentState.downloadGIF();
                }}
                disabled={
                  contentState.downloadingGIF ||
                  contentState.duration > 30 ||
                  !contentState.mp4ready ||
                  contentState.noffmpeg
                }
              >
                <div className={styles.buttonLeft}>
                  <ReactSVG src={URL + "editor/icons/gif.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {contentState.downloadingGIF
                      ? chrome.i18n.getMessage("downloadingLabel")
                      : chrome.i18n.getMessage("downloadGIFButtonTitle")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {contentState.offline && !contentState.ffmpegLoaded
                      ? chrome.i18n.getMessage("noConnectionLabel")
                      : contentState.updateChrome ||
                        contentState.noffmpeg ||
                        (contentState.duration > contentState.editLimit &&
                          !contentState.override)
                      ? getNotAvailableLabel()
                      : contentState.mp4ready
                      ? chrome.i18n.getMessage("downloadGIFButtonDescription")
                      : getPreparingLabel()}
                  </div>
                </div>
                <div className={styles.buttonRight}>
                  <ReactSVG src={URL + "editor/icons/right-arrow.svg"} />
                </div>
              </div>
            </div>
          </div>
          <div className={styles.section}>
            <div className={styles.sectionTitle}>
              {chrome.i18n.getMessage("sandboxAdvancedTitle")}
            </div>
            <div className={styles.buttonWrap}>
              <div
                role="button"
                className={styles.button}
                onClick={() => {
                  handleRawRecording();
                }}
              >
                <div className={styles.buttonLeft}>
                  <ReactSVG src={URL + "editor/icons/download.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {chrome.i18n.getMessage("rawRecordingButtonTitle")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {chrome.i18n.getMessage("rawRecordingButtonDescription")}
                  </div>
                </div>
                <div className={styles.buttonRight}>
                  <ReactSVG src={URL + "editor/icons/right-arrow.svg"} />
                </div>
              </div>
              <div
                role="button"
                className={styles.button}
                onClick={() => {
                  handleTroubleshooting();
                }}
              >
                <div className={styles.buttonLeft}>
                  <ReactSVG src={URL + "editor/icons/flag.svg"} />
                </div>
                <div className={styles.buttonMiddle}>
                  <div className={styles.buttonTitle}>
                    {chrome.i18n.getMessage("troubleshootButtonTitle")}
                  </div>
                  <div className={styles.buttonDescription}>
                    {chrome.i18n.getMessage("troubleshootButtonDescription")}
                  </div>
                </div>
                <div className={styles.buttonRight}>
                  <ReactSVG src={URL + "editor/icons/right-arrow.svg"} />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RightPanel;
