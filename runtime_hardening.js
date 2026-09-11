"use strict";

(() => {
  const ERROR_KEY = "ushub:last-runtime-error:v26";
  const LONG_TASK_KEY = "ushub:recent-long-tasks:v26";
  const PERF_KEY = "ushub:performance-diagnostics:v26";
  const PERF_LIMIT = 240;
  let lastToastAt = 0;
  let perfPersistTimer = null;
  let appUsableRecorded = false;
  const pendingCloudConfirmations = new Map();
  let performanceEntries = [];

  try {
    const stored = JSON.parse(localStorage.getItem(PERF_KEY) || "[]");
    if (Array.isArray(stored)) performanceEntries = stored.slice(-PERF_LIMIT);
  } catch (_) {}

  function persistPerformanceSoon() {
    clearTimeout(perfPersistTimer);
    perfPersistTimer = setTimeout(() => {
      try { localStorage.setItem(PERF_KEY, JSON.stringify(performanceEntries.slice(-PERF_LIMIT))); } catch (_) {}
    }, 1200);
  }

  function recordPerformance(kind, name, value, meta = {}) {
    const numeric = Number(value);
    if (!name || !Number.isFinite(numeric) || numeric < 0) return null;
    const entry = {
      kind: String(kind || "timing"),
      name: String(name),
      value: Math.round(numeric * 10) / 10,
      at: new Date().toISOString(),
      meta: meta && typeof meta === "object" ? meta : {}
    };
    performanceEntries.push(entry);
    if (performanceEntries.length > PERF_LIMIT) performanceEntries.splice(0, performanceEntries.length - PERF_LIMIT);
    persistPerformanceSoon();
    try { window.dispatchEvent(new CustomEvent("studyhub-performance", { detail: entry })); } catch (_) {}
    return entry;
  }

  function startTiming(name, meta = {}) {
    return { name: String(name || "operation"), start: performance.now(), meta };
  }

  function endTiming(token, meta = {}) {
    if (!token || !Number.isFinite(Number(token.start))) return null;
    return recordPerformance("timing", token.name, performance.now() - Number(token.start), { ...(token.meta || {}), ...(meta || {}) });
  }

  function recordTiming(name, durationMs, meta = {}) {
    return recordPerformance("timing", name, durationMs, meta);
  }

  function recordGauge(name, value, meta = {}) {
    return recordPerformance("gauge", name, value, meta);
  }

  function percentile(values, fraction) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
    return sorted[index];
  }

  function getPerformanceSummary() {
    const groups = new Map();
    for (const entry of performanceEntries) {
      if (entry.kind !== "timing") continue;
      if (!groups.has(entry.name)) groups.set(entry.name, []);
      groups.get(entry.name).push(Number(entry.value) || 0);
    }
    const timings = {};
    for (const [name, values] of groups) {
      const sorted = values.slice().sort((a, b) => a - b);
      timings[name] = {
        count: sorted.length,
        median_ms: Math.round(percentile(sorted, 0.5)),
        p90_ms: Math.round(percentile(sorted, 0.9)),
        max_ms: Math.round(sorted[sorted.length - 1] || 0)
      };
    }
    const latestGauges = {};
    for (let i = performanceEntries.length - 1; i >= 0; i -= 1) {
      const entry = performanceEntries[i];
      if (entry.kind === "gauge" && !(entry.name in latestGauges)) latestGauges[entry.name] = entry.value;
    }
    return { timings, gauges: latestGauges, recent: performanceEntries.slice(-40) };
  }

  function clearPerformanceDiagnostics() {
    performanceEntries = [];
    try { localStorage.removeItem(PERF_KEY); } catch (_) {}
  }

  function markAppUsable(meta = {}) {
    if (appUsableRecorded) return;
    appUsableRecorded = true;
    // performance.now() is measured from this document navigation start.
    recordTiming("launch-first-usable", performance.now(), meta);
  }

  function record(kind, value) {
    try {
      const message = value instanceof Error ? `${value.name}: ${value.message}` : String(value || "Unknown error");
      sessionStorage.setItem(ERROR_KEY, JSON.stringify({ kind, message, at: new Date().toISOString() }));
      console.error(`[Study Hub ${kind}]`, value);
      if (Date.now() - lastToastAt > 5000 && typeof toast === "function") {
        lastToastAt = Date.now();
        toast("A page component recovered from an error. Your local data remains saved.", 4200);
      }
    } catch (_) {}
  }

  const yieldToUI = () => new Promise(resolve => {
    if (document.visibilityState === "hidden") return setTimeout(resolve, 0);
    requestAnimationFrame(() => resolve());
  });

  const nextPaint = () => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });

  const scheduleIdle = (fn, timeout = 2200) => {
    if ("requestIdleCallback" in window) return requestIdleCallback(fn, { timeout });
    return setTimeout(fn, Math.min(timeout, 1200));
  };

  window.StudyHubRuntime = {
    yieldToUI,
    nextPaint,
    scheduleIdle,
    startTiming,
    endTiming,
    recordTiming,
    recordGauge,
    markAppUsable,
    getPerformanceSummary,
    clearPerformanceDiagnostics,
    lastRuntimeError: () => {
      try { return JSON.parse(sessionStorage.getItem(ERROR_KEY) || "null"); } catch (_) { return null; }
    }
  };

  window.addEventListener("error", event => record("error", event.error || event.message));
  window.addEventListener("unhandledrejection", event => record("promise", event.reason));

  // Pair the exact local save ID with its exact Supabase acknowledgement. This
  // measures local-save → cloud-confirmation latency without adding any network
  // request, polling loop, analytics service or Supabase usage.
  window.addEventListener("studyhub-cloud-status", event => {
    const detail = event?.detail || {};
    const localId = String(detail.lastLocalSaveId || "");
    const confirmedId = String(detail.lastCloudConfirmedSaveId || "");
    if (localId && !pendingCloudConfirmations.has(localId)) {
      pendingCloudConfirmations.set(localId, performance.now());
      while (pendingCloudConfirmations.size > 40) pendingCloudConfirmations.delete(pendingCloudConfirmations.keys().next().value);
    }
    if (confirmedId && pendingCloudConfirmations.has(confirmedId)) {
      const started = pendingCloudConfirmations.get(confirmedId);
      pendingCloudConfirmations.delete(confirmedId);
      recordTiming("local-save-to-cloud-confirmed", performance.now() - started, { save_id: confirmedId });
    }
  });

  // Observe genuinely expensive main-thread work for future diagnostics without
  // changing user data or blocking the interface.
  try {
    if ("PerformanceObserver" in window && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      const recent = [];
      let persistTimer = null;
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          recent.push({ at: Date.now(), duration: Math.round(entry.duration) });
          while (recent.length > 12) recent.shift();
        }
        // sessionStorage is synchronous. Batch diagnostics so performance
        // monitoring never becomes its own source of main-thread work.
        clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
          try { sessionStorage.setItem(LONG_TASK_KEY, JSON.stringify(recent)); } catch (_) {}
        }, 1000);
      });
      observer.observe({ entryTypes: ["longtask"] });
    }
  } catch (_) {}

  // Warm the Lecture shell only after the main app is interactive. On a normal
  // connection, also warm PDF.js so the first PDF lecture opens faster.
  scheduleIdle(async () => {
    if (navigator.connection?.saveData) return;
    const resources = ["editor/editor.html", "editor/browser_editor_bridge.js"];
    const effective = navigator.connection?.effectiveType || "";
    if (!/2g/.test(effective)) resources.push("editor/pdfjs/pdf.mjs");
    // Idle-only prewarming can safely use two concurrent requests. This shortens
    // time-to-first-Lecture without competing with initial app rendering.
    for (let i = 0; i < resources.length; i += 2) {
      await Promise.allSettled(
        resources.slice(i, i + 2).map(url => fetch(url, { cache: "force-cache" }))
      );
      await yieldToUI();
    }
  });

  // Ask the browser to keep IndexedDB/PWA data when supported; never block startup.
  scheduleIdle(() => navigator.storage?.persist?.().catch?.(() => {}));

  // Periodically invite the service worker to check for a newer app shell while
  // the current app remains fully usable.
  scheduleIdle(async () => {
    try {
      const registration = await navigator.serviceWorker?.getRegistration?.();
      await registration?.update?.();
    } catch (_) {}
  }, 3500);
})();
