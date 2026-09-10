"use strict";

(() => {
  const REPOSITORY = "JCgoCRAZY/Sync";
  const CACHE_KEY = "ushub:last-confirmed-pages-deployment-v3";
  const TORONTO_TZ = "America/Toronto";
  let loadedRun = null;
  let updateRun = null;
  let checking = false;
  let firstSuccessfulCheck = true;

  function formatToronto(iso) {
    const d = new Date(iso);
    if (Number.isNaN(+d)) return "";
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: TORONTO_TZ,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }).formatToParts(d)
        .filter(part => part.type !== "literal")
        .map(part => [part.type, part.value])
    );
    return `${parts.year}.${parts.month}.${parts.day}-${parts.hour}:${parts.minute}`;
  }

  function normalizeRun(run) {
    if (!run) return null;
    const at = run.updated_at || run.run_started_at || run.created_at;
    const version = formatToronto(at);
    if (!version) return null;
    return { id: String(run.id || version), at, version };
  }

  function currentVersionText() {
    return loadedRun?.version ? `Version ${loadedRun.version}` : "Version checking…";
  }

  function updateAvailable() {
    if (!loadedRun || !updateRun) return false;
    return Date.parse(updateRun.at || "") > Date.parse(loadedRun.at || "") && updateRun.id !== loadedRun.id;
  }

  function paint() {
    document.querySelectorAll("[data-deployment-version]").forEach(el => {
      el.textContent = currentVersionText();
      el.title = loadedRun
        ? `Version loaded from GitHub Pages deployment ${loadedRun.version} (Toronto time, 24-hour clock)`
        : "Checking the GitHub Pages deployment version…";
    });

    const available = updateAvailable();
    document.querySelectorAll("[data-deployment-update]").forEach(button => {
      button.hidden = !available;
      button.textContent = available ? "New version available → Restart" : "";
      button.title = available ? `New deployment: ${updateRun.version}` : "";
    });
  }

  function ensureSettingsCard() {
    const title = document.getElementById("page-title");
    if (!title || title.textContent.trim() !== "Settings") return;
    const stack = document.querySelector("#page .page-stack");
    if (!stack) return;

    let card = stack.querySelector("#deployment-version-settings-card");
    if (!card) {
      card = document.createElement("section");
      card.className = "card";
      card.id = "deployment-version-settings-card";
      card.innerHTML = `
        <div class="card-header">
          <div>
            <h2>App Version</h2>
            <div class="card-subtitle">Current GitHub Pages deployment • Toronto time • 24-hour clock</div>
          </div>
          <div class="deployment-settings-version-wrap">
            <div class="deployment-version-settings-value" data-deployment-version></div>
            <button class="deployment-update-button" type="button" data-deployment-update hidden></button>
          </div>
        </div>`;
      stack.prepend(card);
      card.querySelector("[data-deployment-update]")?.addEventListener("click", restartIntoLatest);
    }
    paint();
  }

  async function fetchLatestRun() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const url = `https://api.github.com/repos/${REPOSITORY}/actions/runs?branch=main&status=success&per_page=20&_=${Date.now()}`;
      const response = await fetch(url, {
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/vnd.github+json" }
      });
      if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
      const body = await response.json();
      const runs = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
      const pageRun = runs.find(item =>
        item && item.status === "completed" && item.conclusion === "success" &&
        /pages build and deployment/i.test(`${item.name || ""} ${item.display_title || ""}`)
      );
      if (!pageRun) throw new Error("No successful GitHub Pages deployment found.");
      return normalizeRun(pageRun);
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkForUpdate() {
    if (checking) return;
    checking = true;
    try {
      const latest = await fetchLatestRun();
      if (!latest) return;

      if (firstSuccessfulCheck || !loadedRun) {
        loadedRun = latest;
        updateRun = null;
        firstSuccessfulCheck = false;
        localStorage.setItem(CACHE_KEY, JSON.stringify(latest));
      } else if (latest.id !== loadedRun.id && Date.parse(latest.at) > Date.parse(loadedRun.at)) {
        updateRun = latest;
      }
      paint();
      ensureSettingsCard();
    } catch (error) {
      console.warn("Deployment version check failed; using the last confirmed version.", error);
      paint();
    } finally {
      checking = false;
    }
  }

  async function restartIntoLatest() {
    document.querySelectorAll("[data-deployment-update]").forEach(button => {
      button.disabled = true;
      button.textContent = "Updating…";
    });
    try {
      const registration = await navigator.serviceWorker?.getRegistration?.();
      await registration?.update?.();
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (error) {
      console.warn("Service worker update check failed; reloading anyway.", error);
    }

    // A cache-busting query guarantees a fresh GitHub Pages navigation while the
    // service worker uses network-first for all application code.
    const next = new URL(location.href);
    next.searchParams.set("ushub_update", String(Date.now()));
    location.replace(next.toString());
  }

  function initialize() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (cached?.version) loadedRun = cached;
    } catch (_) {}
    paint();

    document.getElementById("deployment-update-button")?.addEventListener("click", restartIntoLatest);
    checkForUpdate();

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkForUpdate();
    });
    window.addEventListener("online", checkForUpdate);
    setInterval(checkForUpdate, 2 * 60 * 1000);
  }

  window.StudyHubDeploymentVersion = {
    ensureSettingsCard,
    checkForUpdate,
    restartIntoLatest,
    getCurrentVersion: () => loadedRun?.version || "",
    getAvailableVersion: () => updateAvailable() ? updateRun?.version || "" : ""
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
