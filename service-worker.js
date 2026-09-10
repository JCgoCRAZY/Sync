"use strict";

const CACHE = "ushub-2026-09-10-deployment-version-v11";
const CORE = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "app_fixes.js",
  "deployment_version.js",
  "cloud_sync.js",
  "manifest.webmanifest",
  "assets/icon.svg",
  "assets/icon-180.png",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "editor/editor.html",
  "editor/browser_editor_bridge.js",
  "editor/quill/quill.js",
  "editor/quill/quill.snow.css",
  "editor/pdfjs/pdf.mjs",
  "editor/pdfjs/pdf.worker.mjs",
  "editor/whiteboard_plus.webp",
  "audio/clicks/matthewvakaliuk73627-mouse-click-290204.mp3",
  "audio/music/alex-morgan-study-jazz-study-music-564277.mp3",
  "audio/music/alex-morgan-study-music-session-559993.mp3"
];

const NETWORK_FIRST =
  /\/(?:index\.html|app\.js|app_fixes\.js|deployment_version\.js|cloud_sync\.js|styles\.css|service-worker\.js|editor\/editor\.html|editor\/browser_editor_bridge\.js)(?:\?.*)?$/;

self.addEventListener("install", event => event.waitUntil(
  caches.open(CACHE)
    .then(cache => cache.addAll(CORE))
    .then(() => self.skipWaiting())
));

self.addEventListener("activate", event => event.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim())
));

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.protocol === "blob:") return;

  const sameOrigin = url.origin === self.location.origin;
  const networkFirst =
    event.request.mode === "navigate" ||
    (sameOrigin && NETWORK_FIRST.test(url.pathname));

  if (networkFirst) {
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then(response => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE).then(cache => cache.put(event.request, clone)).catch(() => {});
          }
          return response;
        })
        .catch(() =>
          caches.match(event.request).then(hit => hit || caches.match("./index.html"))
        )
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(hit => {
      const network = fetch(event.request)
        .then(response => {
          if (response && (response.ok || response.type === "opaque")) {
            const clone = response.clone();
            caches.open(CACHE).then(cache => cache.put(event.request, clone)).catch(() => {});
          }
          return response;
        })
        .catch(() => null);

      return hit || network.then(response => response || caches.match("./index.html"));
    })
  );
});
