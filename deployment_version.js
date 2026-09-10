"use strict";

(() => {
  const REPOSITORY = "JCgoCRAZY/Sync";
  const CACHE_KEY = "ushub:last-confirmed-pages-deployment-v2";
  const CHECK_KEY = "ushub:last-pages-deployment-check-v2";
  const TORONTO_TZ = "America/Toronto";
  let currentVersion = localStorage.getItem(CACHE_KEY) || "";

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
        .filter(p => p.type !== "literal")
        .map(p => [p.type, p.value])
    );
    return `${parts.year}.${parts.month}.${parts.day}-${parts.hour}:${parts.minute}`;
  }

  function displayText() {
    return currentVersion ? `Version ${currentVersion}` : "Version checking…";
  }

  function paint() {
    document.querySelectorAll("[data-deployment-version]").forEach(el => {
      el.textContent = displayText();
      el.title = currentVersion
        ? `Latest successful GitHub Pages deployment: ${currentVersion} (Toronto time, 24-hour clock)`
        : "Checking latest successful GitHub Pages deployment…";
    });
  }

  function ensureSettingsCard() {
    const title = document.getElementById("page-title");
    if (!title || title.textContent.trim() !== "Settings") return;

    const stack = document.querySelector("#page .page-stack");
    if (!stack || stack.querySelector("#deployment-version-settings-card")) return;

    const card = document.createElement("section");
    card.className = "card";
    card.id = "deployment-version-settings-card";
    card.innerHTML = `
      <div class="card-header">
        <div>
          <h2>App Version</h2>
          <div class="card-subtitle">
            Latest successful GitHub Pages deployment • Toronto time • 24-hour clock
          </div>
        </div>
        <div class="deployment-version-settings-value" data-deployment-version>
          ${displayText()}
        </div>
      </div>
    `;
    stack.prepend(card);
    paint();
  }

  async function fetchLatestSuccessfulPagesRun() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const url =
        `https://api.github.com/repos/${REPOSITORY}/actions/runs` +
        `?branch=main&status=success&per_page=20&_=${Date.now()}`;

      const response = await fetch(url, {
        cache: "no-store",
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.github+json"
        }
      });
      if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);

      const body = await response.json();
      const runs = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
      const run = runs.find(item =>
        item &&
        item.status === "completed" &&
        item.conclusion === "success" &&
        /pages build and deployment/i.test(
          `${item.name || ""} ${item.display_title || ""}`
        )
      );

      if (!run) throw new Error("No successful Pages deployment found.");

      // updated_at corresponds to completion of the successful Pages workflow,
      // which is the closest reliable timestamp to the page becoming deployed.
      const formatted = formatToronto(
        run.updated_at || run.run_started_at || run.created_at
      );
      if (!formatted) throw new Error("Invalid Pages deployment timestamp.");

      currentVersion = formatted;
      localStorage.setItem(CACHE_KEY, formatted);
      localStorage.setItem(CHECK_KEY, new Date().toISOString());
      paint();
      ensureSettingsCard();
    } catch (err) {
      console.warn("Deployment version check failed; using cached value.", err);
      paint();
      ensureSettingsCard();
    } finally {
      clearTimeout(timeout);
    }
  }

  function initialize() {
    paint();
    ensureSettingsCard();

    const page = document.getElementById("page");
    const title = document.getElementById("page-title");
    if (page) {
      new MutationObserver(() => {
        paint();
        ensureSettingsCard();
      }).observe(page, { childList: true, subtree: true });
    }
    if (title) {
      new MutationObserver(() => ensureSettingsCard())
        .observe(title, { childList: true, characterData: true, subtree: true });
    }

    fetchLatestSuccessfulPagesRun();

    // Re-check when the app returns to the foreground so a long-running installed
    // PWA notices a newly deployed GitHub version without needing reinstall.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        fetchLatestSuccessfulPagesRun();
      }
    });

    // Also re-check periodically for users who leave the app open all day.
    setInterval(fetchLatestSuccessfulPagesRun, 5 * 60 * 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})();
