const CACHE = "tp-pane-v89";
const ASSETS = [
  "./index.html",
  "./styles.css",
  "./app.js",
  "./media.js",
  "./import-extras.js",
  "./vendor/xlsx.full.min.js",
  "./vendor/pdf.min.js",
  "./vendor/pdf.worker.min.js",
  "./manifest.json",
  "./vendor/leaflet.css",
  "./vendor/leaflet.js",
  "./vendor/geopackage.min.js",
  "./vendor/sql-wasm.wasm",
  "./icons/tp-pane.svg",
  "./icons/favicon-32.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./offline/db-roads.json.gz",
  "./offline/db-water.json.gz",
  "./offline/db-waterways.json.gz",
  "./offline/db-landuse.json.gz",
  "./offline/db-buildings.json.gz",
  "./offline/db-rail.json.gz",
  "./offline/db-places.json.gz",
  "./samples/media/T1_001.jpg",
  "./samples/media/T1_defect.jpg",
  "./samples/media/T1_crown.jpg",
  "./samples/media/T1_root.jpg",
  "./samples/media/T2_001.jpg",
  "./samples/media/T2_trunk.jpg",
  "./samples/media/T8_001.jpg",
  "./samples/media/T8_canopy.jpg",
  "./samples/media/T30_001.jpg",
  "./samples/media/T30_base.jpg",
  "./samples/media/tree_survey_demo.pdf",
  "./samples/demo_trees.csv",
  "./samples/demo_trees_list_only.csv"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Always try the network first for app files so updates actually appear.
  const isAppFile = /\.(html|js|css|json)$/.test(url.pathname) || url.pathname.endsWith("/");
  if (isAppFile) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
      }
      return res;
    }))
  );
});
