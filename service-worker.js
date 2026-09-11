"use strict";

const CACHE = "ushub-2026-09-11-all-courses-v23";
const CORE = [
  "./", "index.html", "styles.css", "app.js", "app_fixes.js",
  "keyboard_navigation_fix.js", "runtime_hardening.js", "ux_upgrade.js", "deployment_version.js",
  "cloud_sync.js", "ux_upgrade.css", "manifest.webmanifest"
];

const CODE_RE = /\/(?:app\.js|app_fixes\.js|keyboard_navigation_fix\.js|runtime_hardening\.js|ux_upgrade\.js|deployment_version\.js|cloud_sync\.js|styles\.css|ux_upgrade\.css|editor\/editor\.html|editor\/browser_editor_bridge\.js)$/;

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request, timeoutMs = 700) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(request, { cache: "no-store", signal: controller.signal });
    if (response?.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    return (await caches.match(request)) || (await caches.match("./index.html"));
  } finally {
    clearTimeout(timer);
  }
}

async function staleWhileRevalidate(event, request) {
  const cached = await caches.match(request);

  const refresh = fetch(request, { cache: "no-cache" })
    .then(async response => {
      if (response && (response.ok || response.type === "opaque")) {
        const cache = await caches.open(CACHE);
        await cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // Keep the worker alive long enough to finish refreshing for the *next*
    // navigation while returning the current cached file immediately.
    event.waitUntil(refresh);
    return cached;
  }

  return (await refresh) || Response.error();
}

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.protocol === "blob:" || url.origin !== self.location.origin) return;

  // HTML navigation checks the network briefly so deployments are discovered
  // quickly, but poor/offline connections fall back in < 1 second.
  if (event.request.mode === "navigate" || /\/index\.html$/.test(url.pathname) || /\/editor\/editor\.html$/.test(url.pathname)) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // App code/CSS is returned from cache immediately and refreshed behind the
  // scenes. Query-string version bumps still force the first new build fetch.
  if (CODE_RE.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, event.request));
    return;
  }

  event.respondWith(staleWhileRevalidate(event, event.request));
});
