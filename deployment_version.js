"use strict";

(() => {
  const REPOSITORY = "JCgoCRAZY/Sync";
  const VERSION_KEY = "ushub:pages-version:v13";
  const CHECK_KEY = "ushub:pages-version-checked:v13";
  const MIN_CHECK_INTERVAL = 5 * 60 * 1000;
  const TORONTO_TZ = "America/Toronto";
  let currentVersion = localStorage.getItem(VERSION_KEY) || "";
  let checkPromise = null;

  function formatToronto(iso) {
    const d = new Date(iso);
    if (Number.isNaN(+d)) return "";
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: TORONTO_TZ,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23"
      }).formatToParts(d)
        .filter(p => p.type !== "literal")
        .map(p => [p.type, p.value])
    );
    return `${parts.year}.${parts.month}.${parts.day}-${parts.hour}:${parts.minute}`;
  }

  function text() {
    return currentVersion ? `Version ${currentVersion}` : "Version checking…";
  }

  function paintElement(el) {
    if (!el) return;
    const next = text();
    if (el.textContent !== next) el.textContent = next;
    const title = currentVersion
      ? `Latest successful GitHub Pages deployment: ${currentVersion} (Toronto time, 24-hour clock)`
      : "Checking latest successful GitHub Pages deployment…";
    if (el.title !== title) el.title = title;
  }

  function paint() {
    document.querySelectorAll("[data-deployment-version]").forEach(paintElement);
  }

  function ensureSettingsCard() {
    const title = document.getElementById("page-title");
    if (!title || title.textContent.trim() !== "Settings") return;
    const stack = document.querySelector("#page .page-stack");
    if (!stack) return;

    let card = document.getElementById("deployment-version-settings-card");
    if (!card) {
      card = document.createElement("section");
      card.className = "card";
      card.id = "deployment-version-settings-card";
      card.innerHTML = `
        <div class="card-header">
          <div>
            <h2>App Version</h2>
            <div class="card-subtitle">Latest successful GitHub Pages deployment • Toronto time • 24-hour clock</div>
          </div>
          <div class="deployment-version-settings-value" data-deployment-version></div>
        </div>`;
      stack.prepend(card);
    }
    paintElement(card.querySelector("[data-deployment-version]"));
  }

  function lastCheckedMs() {
    const value = Date.parse(localStorage.getItem(CHECK_KEY) || "");
    return Number.isFinite(value) ? value : 0;
  }

  async function refreshVersion(force = false) {
    if (checkPromise) return checkPromise;
    if (!force && Date.now() - lastCheckedMs() < MIN_CHECK_INTERVAL) {
      paint();
      ensureSettingsCard();
      return;
    }

    checkPromise = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const url = `https://api.github.com/repos/${REPOSITORY}/actions/runs?branch=main&per_page=8&_=${Date.now()}`;
        const response = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/vnd.github+json" }
        });
        if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
        const body = await response.json();
        const runs = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
        const run = runs.find(item =>
          item?.status === "completed" &&
          item?.conclusion === "success" &&
          /pages build and deployment/i.test(`${item?.name || ""} ${item?.display_title || ""}`)
        );
        if (!run) throw new Error("No successful Pages deployment found");
        const formatted = formatToronto(run.updated_at || run.run_started_at || run.created_at);
        if (!formatted) throw new Error("Invalid deployment timestamp");
        currentVersion = formatted;
        localStorage.setItem(VERSION_KEY, formatted);
        localStorage.setItem(CHECK_KEY, new Date().toISOString());
      } catch (error) {
        console.warn("Version refresh deferred; cached version retained.", error);
      } finally {
        clearTimeout(timeout);
        paint();
        ensureSettingsCard();
      }
    })().finally(() => { checkPromise = null; });

    return checkPromise;
  }

  function init() {
    paint();
    ensureSettingsCard();

    // Observe ONLY the small title node. The previous page-wide observer watched
    // the Settings card while also rewriting that card, causing an infinite loop.
    const title = document.getElementById("page-title");
    if (title) {
      new MutationObserver(() => {
        requestAnimationFrame(() => {
          ensureSettingsCard();
          paint();
        });
      }).observe(title, { childList: true, characterData: true, subtree: true });
    }

    const idle = window.requestIdleCallback || (fn => setTimeout(fn, 0));
    idle(() => refreshVersion(false));

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshVersion(false);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
