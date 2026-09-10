"use strict";

(() => {
  const ERROR_KEY = "ushub:last-runtime-error:v14";
  const LONG_TASK_KEY = "ushub:recent-long-tasks:v14";
  let lastToastAt = 0;

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
    lastRuntimeError: () => {
      try { return JSON.parse(sessionStorage.getItem(ERROR_KEY) || "null"); } catch (_) { return null; }
    }
  };

  window.addEventListener("error", event => record("error", event.error || event.message));
  window.addEventListener("unhandledrejection", event => record("promise", event.reason));

  // Observe genuinely expensive main-thread work for future diagnostics without
  // changing user data or blocking the interface.
  try {
    if ("PerformanceObserver" in window && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
      const recent = [];
      const observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          recent.push({ at: Date.now(), duration: Math.round(entry.duration) });
          while (recent.length > 12) recent.shift();
        }
        sessionStorage.setItem(LONG_TASK_KEY, JSON.stringify(recent));
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
    for (const url of resources) {
      try { await fetch(url, { cache: "force-cache" }); } catch (_) {}
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
