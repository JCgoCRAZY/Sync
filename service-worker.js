"use strict";

const CACHE = "ushub-2026-09-10-ux-upgrade-v14";
const CORE = [
  "./", "index.html", "styles.css", "app.js", "app_fixes.js",
  "keyboard_navigation_fix.js", "runtime_hardening.js", "ux_upgrade.js", "deployment_version.js",
  "cloud_sync.js", "ux_upgrade.css", "manifest.webmanifest"
];

const CODE_RE = /\/(?:index\.html|app\.js|app_fixes\.js|keyboard_navigation_fix\.js|runtime_hardening\.js|ux_upgrade\.js|deployment_version\.js|cloud_sync\.js|styles\.css|ux_upgrade\.css|editor\/editor\.html|editor\/browser_editor_bridge\.js)$/;

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request, timeoutMs = 1500) {
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
    return (await caches.match(request)) || (request.mode === "navigate" ? await caches.match("./index.html") : undefined);
  } finally {
    clearTimeout(timer);
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const refresh = fetch(request).then(async response => {
    if (response && (response.ok || response.type === "opaque")) {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  }).catch(() => null);
  return cached || refresh || Response.error();
}

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.protocol === "blob:") return;
  if (url.origin !== self.location.origin) return;

  const cleanPath = url.pathname;
  if (event.request.mode === "navigate" || CODE_RE.test(cleanPath)) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  event.respondWith(staleWhileRevalidate(event.request));
});
