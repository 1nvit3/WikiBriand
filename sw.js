// Service worker WikiBrand : mises à jour immédiates + jeu hors-ligne.
//  - Code, styles, cards.json, index.html : RÉSEAU D'ABORD (cache seulement si hors-ligne)
//  - images/*                              : CACHE D'ABORD (elles changent rarement)
// Change CACHE_VERSION pour purger le cache des images si tu remplaces une image sous le même nom.
const CACHE_VERSION = "v9";
const CACHE_NAME = `wikibrand-${CACHE_VERSION}`;
const CORE = ["./", "index.html", "style.css", "app.js", "config.js", "cards.json", "manifest.json", "icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"];

const isImage = (url) => url.pathname.includes("/images/");

self.addEventListener("install", (event) => {
  self.skipWaiting();                       // le nouveau SW s'active sans attendre la fermeture des onglets
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // "reload" : ignore le cache HTTP du navigateur (GitHub Pages en garde 10 min)
    await Promise.all(CORE.map((u) => cache.add(new Request(u, { cache: "reload" })).catch(() => {})));
    // Pré-charge les images des cartes (une image manquante n'empêche pas l'installation)
    try {
      const res = await fetch("cards.json", { cache: "no-store" });
      const data = await res.json();
      const cards = Array.isArray(data) ? data : data.cards || [];
      await Promise.all(cards.filter((c) => c.image).map((c) => cache.add(c.image).catch(() => {})));
    } catch {}
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => (k.startsWith("wikibrand-") || k.startsWith("collecto-")) && k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();             // prend le contrôle des onglets déjà ouverts
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Supabase et le CDN ne passent jamais par le cache : les données de jeu viennent toujours du serveur
  if (url.origin !== location.origin) return;

  event.respondWith(isImage(url) ? cacheFirst(event, req) : networkFirst(event, req));
});

async function networkFirst(event, req) {
  try {
    const res = await fetch(req, { cache: "no-store" });     // contourne aussi le cache HTTP
    if (res.ok) {
      const copy = res.clone();
      event.waitUntil(caches.open(CACHE_NAME).then((c) => c.put(req, copy)));
    }
    return res;
  } catch {
    const hit = await caches.match(req, { ignoreSearch: true });
    return hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error());
  }
}

async function cacheFirst(event, req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) {
      const copy = res.clone();
      event.waitUntil(caches.open(CACHE_NAME).then((c) => c.put(req, copy)));
    }
    return res;
  } catch {
    return Response.error();
  }
}
