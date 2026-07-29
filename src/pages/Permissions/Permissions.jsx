import React, { useEffect, useState, useRef, useCallback } from "react";
import { debug, debugWarn, debugError, initDebugMode, watchDebugMode } from "../utils/debugLog";

const Recorder = () => {
  useEffect(() => {
    initDebugMode();
    watchDebugMode();
    debug('Permissions iframe mounted, inited debug mode');

    window.parent.postMessage(
      {
        type: "screenity-permissions-loaded",
      },
      "*"
    );

    // Cross-origin iframe, so allowsFeature reflects what the page actually
    // delegated to us. Pages with feature=(self) (e.g. facebook.com) don't
    // delegate, so this reads false. Report up so the UI can warn.
    try {
      const pp = document.permissionsPolicy || document.featurePolicy;
      if (pp && typeof pp.allowsFeature === "function") {
        debug('Permissions policy:', { camera: pp.allowsFeature("camera"), microphone: pp.allowsFeature("microphone"), display: pp.allowsFeature("display-capture") });
        window.parent.postMessage(
          {
            type: "screenity-site-policy",
            cameraAllowed: pp.allowsFeature("camera"),
            microphoneAllowed: pp.allowsFeature("microphone"),
            displayCaptureAllowed: pp.allowsFeature("display-capture"),
          },
          "*"
        );
      }
    } catch (e) {}
  }, []);

  useEffect(() => {
    const handleDeviceChange = () => {
      // Recheck permissions and enumerate devices
      checkPermissions();
    };

    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);

    return () => {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        handleDeviceChange
      );
    };
  }, []);

  const checkPermissions = async () => {
    debug('checkPermissions() called');
    try {
      const cameraPermission = await navigator.permissions.query({
        name: "camera",
      });
      const microphonePermission = await navigator.permissions.query({
        name: "microphone",
      });
      debug('Permissions.query results:', { camera: cameraPermission.state, microphone: microphonePermission.state });

      cameraPermission.onchange = () => {
        debug('Camera permission changed, rechecking');
        checkPermissions();
      };

      microphonePermission.onchange = () => {
        debug('Microphone permission changed, rechecking');
        checkPermissions();
      };

      const camGranted = cameraPermission.state === "granted";
      const micGranted = microphonePermission.state === "granted";

      if (camGranted || micGranted) {
        debug('Fast path - at least one granted, probe individually');
        await probeAndEnumerate(camGranted, micGranted);
        return;
      }

      debug('Neither granted via Permissions API, probing getUserMedia individually');
      let micOk = false;
      let camOk = false;

      try {
        const audioProbe = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioProbe.getTracks().forEach((t) => t.stop());
        micOk = true;
        debug('Audio probe succeeded');
      } catch (audioErr) {
        debugWarn('Audio probe failed:', audioErr.name);
      }

      try {
        const videoProbe = await navigator.mediaDevices.getUserMedia({ video: true });
        videoProbe.getTracks().forEach((t) => t.stop());
        camOk = true;
        debug('Video probe succeeded');
      } catch (videoErr) {
        debugWarn('Video probe failed:', videoErr.name);
      }

      if (micOk || camOk) {
        debug('Probe results - mic:', micOk, 'camera:', camOk);
        await probeAndEnumerate(camOk, micOk);
      } else {
        debugError('No media devices available after individual probe');
        window.parent.postMessage(
          {
            type: "screenity-permissions",
            success: false,
            error: "No media devices available",
          },
          "*"
        );
      }
    } catch (err) {
      debugWarn('Permissions.query threw, falling back to enumerate:', err);
      await probeAndEnumerate(false, false);
    }
  };

  const probeAndEnumerate = async (camGranted, micGranted) => {
    debug('probeAndEnumerate:', { camera: camGranted, microphone: micGranted });
    try {
      const constraints = {};
      if (micGranted) constraints.audio = true;
      if (camGranted) constraints.video = true;

      let stream = null;
      if (Object.keys(constraints).length > 0) {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        debug('getUserMedia for enumeration succeeded');
      } else {
        debug('No constraints for getUserMedia, skipping stream request');
      }

      const devicesInfo = await navigator.mediaDevices.enumerateDevices();
      debug('Enumerated', devicesInfo.length, 'devices:', devicesInfo.map(d => d.kind + ':' + d.label));

      let audioinput = [];
      let audiooutput = [];
      let videoinput = [];

      if (micGranted) {
        audioinput = devicesInfo
          .filter((device) => device.kind === "audioinput")
          .map((device) => ({
            deviceId: device.deviceId,
            label: device.label,
          }));

        audiooutput = devicesInfo
          .filter((device) => device.kind === "audiooutput")
          .map((device) => ({
            deviceId: device.deviceId,
            label: device.label,
          }));
      }

      if (camGranted) {
        videoinput = devicesInfo
          .filter((device) => device.kind === "videoinput")
          .map((device) => ({
            deviceId: device.deviceId,
            label: device.label,
          }));
      }

      debug('Filtered devices - audioinput:', audioinput.length, 'videoinput:', videoinput.length);

      chrome.storage.local.set({
        audioinput: audioinput,
        audiooutput: audiooutput,
        videoinput: videoinput,
        cameraPermission: camGranted,
        microphonePermission: micGranted,
      });

      window.parent.postMessage(
        {
          type: "screenity-permissions",
          success: true,
          audioinput: audioinput,
          audiooutput: audiooutput,
          videoinput: videoinput,
          cameraPermission: camGranted,
          microphonePermission: micGranted,
        },
        "*"
      );

      if (stream) {
        stream.getTracks().forEach(function (track) {
          track.stop();
        });
      }
    } catch (err) {
      debugError('EnumerateDevices failed:', err.name, err.message);
      window.parent.postMessage(
        {
          type: "screenity-permissions",
          success: false,
          error: err.name,
        },
        "*"
      );
    }
  };



  const onMessage = (message) => {
    if (message.type === "screenity-get-permissions") {
      checkPermissions();
    }
  };

  // Post message listener
  useEffect(() => {
    window.addEventListener("message", (event) => {
      onMessage(event.data);
    });
  }, []);

  return <div></div>;
};

export default Recorder;
