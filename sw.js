// Service worker : permet de jouer hors-ligne.
// Stratégie "réseau d'abord" : en ligne tu as toujours la dernière version de tes fichiers
// (cards.json, app.js...), hors-ligne le jeu utilise la copie en cache.
const CACHE_VERSION = "v5";
const CACHE_NAME = `collecto-${CACHE_VERSION}`;
const CORE = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "config.js",
  "cards.json",
  "manifest.webmanifest",
  "icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(CORE);
    // Pré-charge les images des cartes (une image manquante n'empêche pas l'installation)
    try {
      const res = await fetch("cards.json");
      const { cards = [] } = await res.json();
      await Promise.all(cards.filter((c) => c.image).map((c) => cache.add(c.image).catch(() => {})));
    } catch {}
  })());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  // Supabase et le CDN ne passent jamais par le cache : les données de jeu viennent toujours du serveur
  if (new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && new URL(event.request.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match("index.html")))
  );
});
