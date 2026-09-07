/**
 * Media panel: portrait photo viewer + PDF page chips.
 * Matches photos by tree ID prefix (e.g. T1 → T1_*.jpg).
 * Works with user-picked local files or bundled demo media.
 */
(function () {
  "use strict";

  const DEMO_TREE_PAGES = {
    T1: { pages: [7, 8, 9, 10, 11, 12], current: 8, total: 20 },
    T2: { pages: [3, 4, 5], current: 3, total: 20 },
    T8: { pages: [14, 15], current: 14, total: 20 },
    T30: { pages: [18, 19, 20], current: 18, total: 20 }
  };

  const DEMO_ATTRS = {
    T1: { Species: "細葉榕 Ficus microcarpa", DBH: "45 cm", Defect: "_Cavity on trunk", Location: "Demo plot A" },
    T2: { Species: "樟樹 Cinnamomum camphora", DBH: "32 cm", Defect: "None", Location: "Demo plot A" },
    T8: { Species: "洋紫荊 Bauhinia blakeana", DBH: "28 cm", Defect: "Dead wood", Location: "Demo plot B" },
    T30: { Species: "台灣相思 Acacia confusa", DBH: "55 cm", Defect: "Root plate lift", Location: "Demo plot C" }
  };

  const state = {
    photos: [],       // { name, url, treeId, file? }
    pdfs: [],         // { name, url, file? }
    treeId: null,
    photoIndex: 0,
    pdfPage: null,
    pdfTotal: 20,
    relatedPages: [],
    demoMode: true,
    objectUrls: []
  };

  function $(id) { return document.getElementById(id); }

  function normalizeTreeId(raw) {
    if (raw == null) return null;
    let s = String(raw).trim();
    if (!s || s === "(no ID)" || s === "—") return null;
    // Prefer T## style tokens
    const m = s.match(/\b(T\s*\d+)\b/i) || s.match(/^([A-Za-z]?\d+)\b/);
    if (m) return m[1].replace(/\s+/g, "").toUpperCase();
    return s.toUpperCase();
  }

  function treeIdFromFileName(name) {
    const base = String(name || "").split(/[/\\]/).pop();
    const m = base.match(/^(T\s*\d+|[A-Za-z]\d+|\d+)(?=[_\-\s.]|$)/i);
    if (!m) return null;
    return m[1].replace(/\s+/g, "").toUpperCase();
  }

  function revokeAll() {
    state.objectUrls.forEach((u) => {
      try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ }
    });
    state.objectUrls = [];
  }

  function rememberUrl(url) {
    if (url && url.indexOf("blob:") === 0) state.objectUrls.push(url);
    return url;
  }

  function isImageName(name) {
    return /\.(jpe?g|png|gif|webp|heic|bmp)$/i.test(name || "");
  }

  function isPdfName(name) {
    return /\.pdf$/i.test(name || "");
  }

  function photosForTree(treeId) {
    const id = normalizeTreeId(treeId);
    if (!id) return [];
    return state.photos.filter((p) => p.treeId === id);
  }

  function setStatusHint(msg) {
    const el = $("media-status");
    if (el) el.textContent = msg || "";
  }

  function renderPhoto() {
    const list = photosForTree(state.treeId);
    const slide = $("media-slide");
    const img = $("media-img");
    const fname = $("media-fname");
    const pcnt = $("media-pcnt");
    const empty = $("media-empty");
    const viewer = $("media-viewer");

    if (!list.length) {
      if (slide) slide.hidden = true;
      if (img) { img.hidden = true; img.removeAttribute("src"); }
      if (empty) {
        empty.hidden = false;
        empty.textContent = state.treeId
          ? ("沒有符合 " + state.treeId + " 的相片（檔名需為 " + state.treeId + "_…）")
          : "點選地圖上的樹木以顯示相片";
      }
      if (fname) fname.textContent = "—";
      if (pcnt) pcnt.textContent = "0 / 0";
      return;
    }

    if (state.photoIndex >= list.length) state.photoIndex = 0;
    if (state.photoIndex < 0) state.photoIndex = list.length - 1;
    const p = list[state.photoIndex];

    if (empty) empty.hidden = true;
    if (img && p.url) {
      img.hidden = false;
      img.src = p.url;
      img.alt = p.name;
      if (slide) slide.hidden = true;
    } else if (slide) {
      if (img) img.hidden = true;
      slide.hidden = false;
      slide.textContent = p.name;
      slide.style.background = p.bg || "linear-gradient(135deg,#4a5568,#1a202c)";
    }
    if (fname) fname.textContent = p.name;
    if (pcnt) pcnt.textContent = (state.photoIndex + 1) + " / " + list.length;
    if (viewer) viewer.setAttribute("data-count", String(list.length));
  }

  function renderPdfChips() {
    const nums = $("media-pdf-nums");
    const pageNow = $("media-page-now");
    const pdfTitle = $("media-pdf-title");
    if (!nums) return;
    nums.innerHTML = "";

    const pages = state.relatedPages || [];
    if (!pages.length) {
      if (pageNow) pageNow.textContent = state.treeId ? "此樹暫無 PDF 頁" : "—";
      if (pdfTitle) pdfTitle.textContent = "相關 PDF";
      return;
    }

    pages.forEach((n) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "media-num" + (n === state.pdfPage ? " on" : "");
      b.textContent = "#" + String(n).padStart(2, "0");
      b.setAttribute("aria-label", "第 " + n + " 頁");
      b.addEventListener("click", () => jumpToPdfPage(n));
      nums.appendChild(b);
    });

    if (pageNow) {
      pageNow.textContent = "現在第 " + (state.pdfPage || pages[0]) + " / " + state.pdfTotal + " 頁";
    }
    if (pdfTitle) {
      const pdfName = state.pdfs[0] ? state.pdfs[0].name : "Demo PDF";
      pdfTitle.textContent = "相關 PDF · " + pdfName;
    }
  }

  function jumpToPdfPage(n) {
    state.pdfPage = n;
    renderPdfChips();
    const frame = $("media-pdf-frame");
    const pdf = state.pdfs[0];
    if (frame && pdf && pdf.url) {
      frame.hidden = false;
      // PDF open parameters: page via hash (works in many browsers)
      frame.src = pdf.url + "#page=" + n;
    }
    setStatusHint("PDF 跳至第 " + n + " 頁" + (pdf ? "" : "（示範）"));
  }

  function updatePdfForTree(treeId) {
    const id = normalizeTreeId(treeId);
    const demo = id && DEMO_TREE_PAGES[id];
    if (demo) {
      state.relatedPages = demo.pages.slice();
      state.pdfPage = demo.current;
      state.pdfTotal = demo.total;
    } else if (id && state.pdfs.length) {
      // Real files: show sequential chips as document indices, fake page jump by hash
      // Prefer demo-like page list derived from tree number when possible
      const num = parseInt(String(id).replace(/\D/g, ""), 10);
      if (num && !isNaN(num)) {
        const start = Math.max(1, ((num - 1) % 15) + 1);
        state.relatedPages = [start, start + 1, start + 2].filter((p) => p <= 20);
        state.pdfPage = start;
        state.pdfTotal = 20;
      } else {
        state.relatedPages = state.pdfs.map((_, i) => i + 1);
        state.pdfPage = 1;
        state.pdfTotal = Math.max(state.pdfs.length, 1);
      }
    } else {
      state.relatedPages = [];
      state.pdfPage = null;
    }
    renderPdfChips();
  }

  function renderFeatureAttrs(props, treeId) {
    const box = $("feature-attrs-body");
    const tag = $("feature-attrs-tag");
    const title = $("feature-attrs-title");
    if (tag) tag.textContent = treeId || "—";
    if (title) title.textContent = treeId ? ("樹木資料 Tree " + treeId) : "樹木資料 Attributes";
    if (!box) return;
    if (!props) {
      box.innerHTML = '<p class="empty-hint">點選地圖上的樹木以顯示屬性。</p>';
      return;
    }
    const keys = Object.keys(props).filter((k) => k && k.charAt(0) !== "_");
    if (!keys.length) {
      box.innerHTML = '<p class="empty-hint">沒有屬性 No attributes</p>';
      return;
    }
    let html = "<table class=\"feature-attr-table\"><tbody>";
    keys.forEach((k) => {
      const v = props[k];
      if (v == null || v === "") return;
      html += "<tr><th>" + escapeHtml(k) + "</th><td>" + escapeHtml(String(v)) + "</td></tr>";
    });
    html += "</tbody></table>";
    box.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setSelectedTree(treeId, props) {
    const id = normalizeTreeId(treeId);
    state.treeId = id;
    state.photoIndex = 0;

    let useProps = props;
    if ((!useProps || !Object.keys(useProps).filter((k) => k.charAt(0) !== "_").length) && id && DEMO_ATTRS[id]) {
      useProps = DEMO_ATTRS[id];
    }

    const hint = $("media-tree-hint");
    if (hint) hint.textContent = id ? ("已選 " + id) : "未選樹木";

    renderFeatureAttrs(useProps || null, id);
    renderPhoto();
    updatePdfForTree(id);
  }

  function stepPhoto(dir) {
    const list = photosForTree(state.treeId);
    if (!list.length) return;
    state.photoIndex = (state.photoIndex + dir + list.length) % list.length;
    renderPhoto();
  }

  function ingestFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    revokeAll();
    state.photos = [];
    state.pdfs = [];
    state.demoMode = false;

    files.forEach((file) => {
      const name = file.name || "file";
      if (isImageName(name)) {
        const url = rememberUrl(URL.createObjectURL(file));
        state.photos.push({
          name: name,
          url: url,
          treeId: treeIdFromFileName(name),
          file: file
        });
      } else if (isPdfName(name)) {
        const url = rememberUrl(URL.createObjectURL(file));
        state.pdfs.push({ name: name, url: url, file: file });
      }
    });

    state.photos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const nImg = state.photos.length;
    const nPdf = state.pdfs.length;
    setStatusHint("已載入 " + nImg + " 張相片、" + nPdf + " 個 PDF（僅本機）");
    const badge = $("media-source-badge");
    if (badge) {
      badge.textContent = "本機資料夾";
      badge.classList.remove("demo");
    }
    if (state.treeId) {
      state.photoIndex = 0;
      renderPhoto();
      updatePdfForTree(state.treeId);
    } else {
      renderPhoto();
      renderPdfChips();
    }
  }

  async function loadDemoMedia() {
    revokeAll();
    state.photos = [];
    state.pdfs = [];
    state.demoMode = true;

    const names = [
      "T1_001.jpg", "T1_defect.jpg", "T1_crown.jpg", "T1_root.jpg",
      "T2_001.jpg", "T2_trunk.jpg",
      "T8_001.jpg", "T8_canopy.jpg",
      "T30_001.jpg", "T30_base.jpg"
    ];

    const loaded = [];
    for (const name of names) {
      try {
        const res = await fetch("samples/media/" + name);
        if (!res.ok) throw new Error("missing");
        const blob = await res.blob();
        const url = rememberUrl(URL.createObjectURL(blob));
        loaded.push({ name: name, url: url, treeId: treeIdFromFileName(name) });
      } catch (e) {
        // Placeholder gradient card if fetch fails
        loaded.push({
          name: name,
          url: null,
          treeId: treeIdFromFileName(name),
          bg: "linear-gradient(135deg,#68d391,#276749)"
        });
      }
    }
    state.photos = loaded;

    try {
      const res = await fetch("samples/media/tree_survey_demo.pdf");
      if (res.ok) {
        const blob = await res.blob();
        const url = rememberUrl(URL.createObjectURL(blob));
        state.pdfs = [{ name: "tree_survey_demo.pdf", url: url }];
      }
    } catch (e) { /* ignore */ }

    const badge = $("media-source-badge");
    if (badge) {
      badge.textContent = "示範 Demo";
      badge.classList.add("demo");
    }
    setStatusHint("示範媒體已載入 — 可改為選擇本機相片／PDF 資料夾");
    if (state.treeId) {
      renderPhoto();
      updatePdfForTree(state.treeId);
    } else {
      setSelectedTree("T1", DEMO_ATTRS.T1);
    }
  }

  function bindSwipe(viewer) {
    if (!viewer) return;
    let x0 = null;
    viewer.addEventListener("touchstart", (e) => {
      if (!e.changedTouches || !e.changedTouches[0]) return;
      x0 = e.changedTouches[0].clientX;
    }, { passive: true });
    viewer.addEventListener("touchend", (e) => {
      if (x0 == null || !e.changedTouches || !e.changedTouches[0]) return;
      const dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 40) stepPhoto(dx < 0 ? 1 : -1);
      x0 = null;
    }, { passive: true });
    // mouse drag for desktop testing
    let mx0 = null;
    viewer.addEventListener("mousedown", (e) => { mx0 = e.clientX; });
    viewer.addEventListener("mouseup", (e) => {
      if (mx0 == null) return;
      const dx = e.clientX - mx0;
      if (Math.abs(dx) > 50) stepPhoto(dx < 0 ? 1 : -1);
      mx0 = null;
    });
  }

  function init() {
    const prev = $("media-prev");
    const next = $("media-next");
    if (prev) prev.addEventListener("click", () => stepPhoto(-1));
    if (next) next.addEventListener("click", () => stepPhoto(1));
    bindSwipe($("media-viewer"));

    const mediaInput = $("media-file-input");
    if (mediaInput) {
      mediaInput.addEventListener("change", () => {
        if (mediaInput.files && mediaInput.files.length) ingestFiles(mediaInput.files);
      });
    }

    const btnDemo = $("btn-media-demo");
    if (btnDemo) btnDemo.addEventListener("click", () => { loadDemoMedia(); });

    const btnClear = $("btn-media-clear");
    if (btnClear) {
      btnClear.addEventListener("click", () => {
        revokeAll();
        state.photos = [];
        state.pdfs = [];
        state.demoMode = false;
        const badge = $("media-source-badge");
        if (badge) { badge.textContent = "未載入"; badge.classList.remove("demo"); }
        setStatusHint("已清除媒體");
        renderPhoto();
        renderPdfChips();
      });
    }

    // Keyboard
    document.addEventListener("keydown", (e) => {
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      if (e.key === "ArrowLeft") stepPhoto(-1);
      if (e.key === "ArrowRight") stepPhoto(1);
    });

    // Auto demo media so UI works immediately
    loadDemoMedia();
  }

  window.GpkgMedia = {
    setSelectedTree: setSelectedTree,
    ingestFiles: ingestFiles,
    loadDemoMedia: loadDemoMedia,
    normalizeTreeId: normalizeTreeId,
    demoAttrs: DEMO_ATTRS,
    getState: function () { return state; }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
