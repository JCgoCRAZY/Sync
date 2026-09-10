"use strict";

(() => {
  const ERROR_KEY = "ushub:last-runtime-error:v13";
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
    } catch {}
  }

  window.addEventListener("error", event => record("error", event.error || event.message));
  window.addEventListener("unhandledrejection", event => record("promise", event.reason));

  // Warm the Lecture shell only after the main app is interactive. This reduces
  // perceived time opening the first Lecture without delaying Dashboard startup.
  const idle = window.requestIdleCallback || (fn => setTimeout(fn, 1200));
  idle(() => {
    if (navigator.connection?.saveData) return;
    fetch("editor/editor.html", { cache: "force-cache" }).catch(() => {});
  });

  // Ask the browser to keep IndexedDB/PWA data when supported; never block startup.
  idle(() => navigator.storage?.persist?.().catch?.(() => {}));
})();
