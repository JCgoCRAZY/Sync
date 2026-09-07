'use strict';
const CACHE='ushub-2026-09-07-ipad-2';
const CORE=[
  './','index.html','styles.css','app.js','manifest.webmanifest','assets/icon.svg','assets/icon-180.png','assets/icon-192.png','assets/icon-512.png',
  'editor/editor.html','editor/browser_editor_bridge.js','editor/quill/quill.js','editor/quill/quill.snow.css',
  'editor/pdfjs/pdf.mjs','editor/pdfjs/pdf.worker.mjs','editor/whiteboard_plus.webp',
  'audio/clicks/matthewvakaliuk73627-mouse-click-290204.mp3',
  'audio/music/alex-morgan-study-jazz-study-music-564277.mp3',
  'audio/music/alex-morgan-study-music-session-559993.mp3'
];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const url=new URL(event.request.url);
  if(url.protocol==='blob:')return;
  event.respondWith(caches.match(event.request).then(hit=>hit||fetch(event.request).then(response=>{
    if(response && (response.ok || response.type==='opaque')){const clone=response.clone();caches.open(CACHE).then(c=>c.put(event.request,clone)).catch(()=>{});}return response;
  }).catch(()=>caches.match('./index.html'))));
});
