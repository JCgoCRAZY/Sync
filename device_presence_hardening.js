"use strict";

(() => {
  const LOCAL_PUBLISH_KEY = "ushub-device-presence-hardening-v36";
  const REPUBLISH_MS = 60 * 60 * 1000;
  let timer = null;
  let running = false;

  function cloudDeviceId() {
    try {
      const direct = window.StudyHubCloud?.deviceId?.();
      if (direct) return String(direct);
      const fromStatus = window.StudyHubCloud?.getStatus?.()?.deviceId;
      if (fromStatus) return String(fromStatus);
    } catch (_) {}
    return "";
  }

  function detectedDeviceName() {
    const ua = navigator.userAgent || "";
    const platform = navigator.userAgentData?.platform || navigator.platform || "";
    const touchPoints = Number(navigator.maxTouchPoints || 0);

    if (/iPhone/i.test(ua) || /iPhone/i.test(platform)) return "iPhone";
    if (/iPad/i.test(ua) || /iPad/i.test(platform) || (platform === "MacIntel" && touchPoints > 1)) return "iPad";
    if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? "Android phone" : "Android tablet";
    if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return "Mac";
    if (/Win/i.test(platform) || /Windows/i.test(ua)) return "Windows PC";
    return platform || "Study Hub device";
  }

  function detectedBrowserName() {
    const ua = navigator.userAgent || "";
    if (/EdgiOS\//.test(ua)) return "Edge";
    if (/CriOS\//.test(ua)) return "Chrome";
    if (/FxiOS\//.test(ua)) return "Firefox";
    if (/Edg\//.test(ua)) return "Edge";
    if (/OPR\//.test(ua)) return "Opera";
    if (/Chrome\//.test(ua)) return "Chrome";
    if (/Safari\//.test(ua)) return "Safari";
    return "Browser";
  }

  function activeProfileSafe() {
    try {
      if (!window.state?.profiles || !window.state?.active_profile_id) return null;
      return window.state.profiles[window.state.active_profile_id] || null;
    } catch (_) {
      try { return activeProfile(); } catch (_) { return null; }
    }
  }

  function currentCloudReady() {
    try {
      const status = window.StudyHubCloud?.getStatus?.();
      if (!status?.signedIn) return false;
      if (status.needsChoice || status.conflict) return false;
      return !["starting", "signed-out"].includes(String(status.phase || ""));
    } catch (_) {
      return false;
    }
  }

  function lastPublished(id) {
    const all = JSON.parse(localStorage.getItem(LOCAL_PUBLISH_KEY) || "{}");
    return Number(all[id] || 0);
  }

  function rememberPublished(id) {
    let all = {};
    try { all = JSON.parse(localStorage.getItem(LOCAL_PUBLISH_KEY) || "{}"); } catch (_) {}
    all[id] = Date.now();
    localStorage.setItem(LOCAL_PUBLISH_KEY, JSON.stringify(all));
  }

  async function ensurePresence({ force = false } = {}) {
    if (running) return;
    const profile = activeProfileSafe();
    const id = cloudDeviceId();
    if (!profile || !id) return;

    running = true;
    try {
      profile.device_registry ||= {};
      const previous = profile.device_registry[id] || null;
      const previousTime = Date.parse(previous?.last_seen_at || "");
      const stale = !Number.isFinite(previousTime) || Date.now() - previousTime >= REPUBLISH_MS;
      const missing = !previous;
      const metadataChanged =
        previous?.name !== detectedDeviceName() ||
        previous?.browser !== detectedBrowserName();

      // First registration after cloud reconciliation is always published.
      // Later heartbeats are deliberately infrequent to avoid unnecessary writes.
      const cloudPublishDue =
        force ||
        missing ||
        metadataChanged ||
        stale ||
        Date.now() - lastPublished(id) >= REPUBLISH_MS;

      if (!cloudPublishDue) return;

      profile.device_registry[id] = {
        ...(previous || {}),
        id,
        name: detectedDeviceName(),
        browser: detectedBrowserName(),
        last_seen_at: new Date().toISOString()
      };

      // queueSave(true) commits IndexedDB first, then marks the granular profile
      // entity dirty. This is safe if cloud is briefly unavailable: the existing
      // retry queue will publish it later.
      if (typeof queueSave === "function") {
        queueSave(true);
        rememberPublished(id);
      }
    } finally {
      running = false;
    }
  }

  function scheduleEnsure(force = false, delay = 250) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!currentCloudReady() && !force) return;
      ensurePresence({ force }).catch(error =>
        console.warn("Device presence registration will retry later:", error)
      );
    }, delay);
  }

  // Critical path: the old registration could run before bootstrap/reconciliation
  // and then be overwritten by the downloaded profile. Register again only after
  // the account has reached a usable signed-in cloud state.
  window.addEventListener("studyhub-cloud-status", event => {
    const status = event.detail || {};
    if (!status.signedIn || status.needsChoice || status.conflict) return;
    if (["starting", "signed-out"].includes(String(status.phase || ""))) return;
    scheduleEnsure(false, status.phase === "synced" ? 120 : 450);
  });

  // If another device updates the profile and the local merge temporarily drops
  // this device entry, immediately reassert this device without waiting an hour.
  window.addEventListener("studyhub-cloud-remote", () => scheduleEnsure(true, 350));

  window.addEventListener("online", () => scheduleEnsure(false, 250));
  window.addEventListener("focus", () => scheduleEnsure(false, 250));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleEnsure(false, 250);
  });

  function startWhenAppReady() {
    const profile = activeProfileSafe();
    const cloud = window.StudyHubCloud;
    if (!profile || !cloud) {
      setTimeout(startWhenAppReady, 100);
      return;
    }
    // Do not force cloud traffic before authentication finishes.
    scheduleEnsure(false, 300);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startWhenAppReady, { once: true });
  } else {
    startWhenAppReady();
  }

  // Refresh the visible Settings device list when a remote profile update arrives.
  window.addEventListener("studyhub-cloud-remote", () => {
    try {
      if (window.route?.page === "settings" && typeof renderSettings === "function") {
        setTimeout(() => renderSettings(), 180);
      }
    } catch (_) {}
  });
})();
