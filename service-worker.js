"use strict";

const CACHE = "ushub-2026-09-10-draw-icons-v12";
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

const EDITOR_HTML_RE = /\/editor\/editor\.html$/;

const DRAW_ICON_FIX = `
<style id="ushub-draw-icon-visibility-fix">
  /* Marker / Highlighter / Eraser must remain visible on the white Draw palette.
     Their SVG paths use currentColor. Explicitly setting the button colour avoids
     the dark-mode browser default turning the icons white until hover. */
  #toolbar .draw-tool-card-main {
    color: #15191c !important;
  }

  #toolbar .draw-tool-card-main svg,
  #toolbar .draw-tool-card-main svg path {
    opacity: 1 !important;
    visibility: visible !important;
  }

  #toolbar .draw-tool-card-main svg path {
    stroke: currentColor !important;
  }

  #toolbar .draw-tool-card.selected .draw-tool-card-main {
    color: #3457e5 !important;
  }

  #toolbar .draw-tool-card-main:hover {
    color: #3457e5 !important;
  }
</style>`;

async function applyEditorDrawIconFix(response) {
  if (!response || !response.ok) return response;

  try {
    const html = await response.text();
    if (html.includes('ushub-draw-icon-visibility-fix')) {
      return new Response(html, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    }

    const patched = html.includes("</head>")
      ? html.replace("</head>", `${DRAW_ICON_FIX}\n</head>`)
      : `${DRAW_ICON_FIX}\n${html}`;

    const headers = new Headers(response.headers);
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.delete("Content-Length");

    return new Response(patched, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  } catch (error) {
    console.warn("Could not apply Draw icon visibility fix:", error);
    return response;
  }
}

function isEditorHtmlRequest(url) {
  return url.origin === self.location.origin && EDITOR_HTML_RE.test(url.pathname);
}

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
  const editorHtml = isEditorHtmlRequest(url);
  const networkFirst =
    event.request.mode === "navigate" ||
    (sameOrigin && NETWORK_FIRST.test(url.pathname));

  if (networkFirst) {
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then(async response => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE).then(cache => cache.put(event.request, clone)).catch(() => {});
          }
          return editorHtml ? applyEditorDrawIconFix(response) : response;
        })
        .catch(async () => {
          const hit = await caches.match(event.request) || await caches.match("./index.html");
          return editorHtml ? applyEditorDrawIconFix(hit) : hit;
        })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(async hit => {
      const network = fetch(event.request)
        .then(response => {
          if (response && (response.ok || response.type === "opaque")) {
            const clone = response.clone();
            caches.open(CACHE).then(cache => cache.put(event.request, clone)).catch(() => {});
          }
          return response;
        })
        .catch(() => null);

      const response = hit || await network || await caches.match("./index.html");
      return editorHtml ? applyEditorDrawIconFix(response) : response;
    })
  );
});
