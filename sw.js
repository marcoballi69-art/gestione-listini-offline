 
"use strict";

const CACHE_NAME = "gestione-listini-v2";

const APP_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.webmanifest"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key =>
            key.startsWith("gestione-listini-") &&
            key !== CACHE_NAME
          )
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Risorse esterne: usa la cache se disponibile,
  // altrimenti prova a scaricarle e conservarle.
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;

        return fetch(request).then(response => {
          if (response && (response.ok || response.type === "opaque")) {
            const copy = response.clone();

            caches.open(CACHE_NAME).then(cache => {
              cache.put(request, copy).catch(() => {});
            });
          }

          return response;
        }).catch(() => new Response(
          "Risorsa non disponibile offline.",
          {
            status: 503,
            statusText: "Offline"
          }
        ));
      })
    );

    return;
  }

  // File dell'app: prima cache, poi rete.
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request).then(response => {
        if (response && response.ok) {
          const copy = response.clone();

          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, copy).catch(() => {});
          });
        }

        return response;
      }).catch(() => {
        if (request.mode === "navigate") {
          return caches.match("./index.html");
        }

        return new Response(
          "File non disponibile offline.",
          {
            status: 503,
            statusText: "Offline"
          }
        );
      });
    })
  );
});
