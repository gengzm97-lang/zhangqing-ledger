"use strict";

const CACHE_NAME = "zhangqing-pwa-v22";
const APP_ASSETS = [
  "./", "./index.html", "./styles.css", "./app.js", "./cloud.js", "./cloud-config.js",
  "./bill-parser.js", "./bill-import.js", "./vendor/xlsx.full.min.js",
  "./autoaccounting.js", "./autoaccounting.css",
  "./manifest.webmanifest", "./icons/icon.svg", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png"
];

self.addEventListener("install", event => {
  // Reload the actual files, not potentially stale HTTP-cache copies from the previous release.
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_ASSETS.map(url => new Request(url, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("zhangqing-pwa-v") && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("message", event => {
  if (event.data?.type === "ZHANGQING_VERSION") event.ports?.[0]?.postMessage({ cacheName: CACHE_NAME });
});

self.addEventListener("fetch", event => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== "GET" || requestUrl.origin !== self.location.origin) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).then(response => {
      const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put("./index.html", copy)); return response;
    }).catch(() => caches.match("./index.html")));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)); return response;
  })));
});
