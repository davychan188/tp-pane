/**
 * Media panel: PDF page viewer via pdf.js canvas (sharp zoom).
 * Independent media library by default (no tree / T1_* required).
 * Optional filter: when a tree is selected, can show only matching prefixes.
 * Works with user-picked local files or bundled demo media.
 * Right panel shows PDF pages only (photo strip removed).
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
    T1: { Species: "細葉榕 Ficus microcarpa", DBH: "45 cm", Height: "12", Spread: "10", Remarks: "", Defect: "_Cavity on trunk", Location: "Demo plot A" },
    T2: { Species: "樟樹 Cinnamomum camphora", DBH: "32 cm", Height: "9", Spread: "7", Remarks: "", Defect: "None", Location: "Demo plot A" },
    T8: { Species: "洋紫荊 Bauhinia blakeana", DBH: "28 cm", Height: "8", Spread: "6", Remarks: "", Defect: "Dead wood", Location: "Demo plot B" },
    T30: { Species: "台灣相思 Acacia confusa", DBH: "55 cm", Height: "14", Spread: "12", Remarks: "", Defect: "Root plate lift", Location: "Demo plot C" }
  };

  const METRIC_DEFS = [
    {
      key: "DBH",
      label: "DBH",
      tip: "胸徑 DBH",
      aliases: ["DBH", "dbh", "DBH (mm)", "DBH(mm)", "dbh_mm", "胸徑", "胸径", "diameter", "Diameter"]
    },
    {
      key: "Height",
      label: "H",
      tip: "高度 Height",
      aliases: ["Height", "height", "Overall Height", "Overall Height (M)", "Overall Height(M)", "height_m", "高度", "H"]
    },
    {
      key: "Spread",
      label: "S",
      tip: "冠幅 Spread",
      aliases: ["Spread", "spread", "Crown spread", "Crown spread (M)", "Crown spread(M)", "spread_m", "crown", "Crown", "冠幅", "S"]
    }
  ];

  const PRIMARY_KEYS = ["Tree ID", "TreeID", "tree_id", "tree_no", "TREE_ID", "ID", "id"];
  const PREFERRED_OTHER = ["Species", "Remarks", "Defect", "Location"];
  const REMARKS_ALIASES = ["Remarks", "remarks", "備註", "备注", "Remark", "note", "notes", "註解", "附註"];

  const state = {
    photos: [],       // { name, url, treeId, file? }
    pdfs: [],         // { name, url, treeId, file?, pageCount? }
    treeId: null,
    selectedProps: null,
    photoIndex: 0,
    pdfIndex: 0,      // selected PDF within activePdfs()
    pdfPage: null,    // 1-based page within selected PDF
    pdfTotal: 0,
    relatedPages: [], // page chips for current PDF (may be demo subset)
    filterMode: "all",   // "all" | "tree" — default show all imported media
    demoMode: false,
    showPhotos: false,   // photo strip removed from UI
    objectUrls: [],
    photoZoom: { scale: 1, x: 0, y: 0 },
    pdfZoom: 1,
    pdfDocCache: new Map(), // url/name -> Promise<PDFDocumentProxy>
    pdfRenderToken: 0,
    pdfRenderTimer: null,
    pdfjsReady: false
  };

  const PHOTO_ZOOM_MIN = 1;
  const PHOTO_ZOOM_MAX = 8;
  const PHOTO_ZOOM_STEP = 0.35;
  const PDF_ZOOM_MIN = 1;
  const PDF_ZOOM_MAX = 12;
  const PDF_ZOOM_STEP = 0.25;

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
    return /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?)$/i.test(name || "");
  }

  function isPdfName(name) {
    return /\.pdf$/i.test(name || "");
  }

  function isImageFile(file) {
    if (!file) return false;
    const t = String(file.type || "").toLowerCase();
    if (t.indexOf("image/") === 0) return true;
    return isImageName(file.name);
  }

  function isPdfFile(file) {
    if (!file) return false;
    const t = String(file.type || "").toLowerCase();
    if (t === "application/pdf" || t === "application/x-pdf") return true;
    return isPdfName(file.name);
  }

  function displayFileName(file, index, kind) {
    const raw = (file && file.name) ? String(file.name).split(/[/\\]/).pop() : "";
    if (raw && raw !== "image" && raw !== "blob") return raw;
    const ext = kind === "pdf" ? ".pdf" : guessImageExt(file);
    return (kind === "pdf" ? "document" : "photo") + "_" + String(index + 1).padStart(3, "0") + ext;
  }

  function guessImageExt(file) {
    const t = String((file && file.type) || "").toLowerCase();
    if (t.indexOf("png") >= 0) return ".png";
    if (t.indexOf("webp") >= 0) return ".webp";
    if (t.indexOf("gif") >= 0) return ".gif";
    if (t.indexOf("heic") >= 0 || t.indexOf("heif") >= 0) return ".heic";
    return ".jpg";
  }

  function shortPdfLabel(name, index) {
    const base = String(name || ("PDF " + (index + 1))).split(/[/\\]/).pop();
    if (base.length <= 18) return base;
    const dot = base.lastIndexOf(".");
    if (dot > 8) return base.slice(0, 12) + "…" + base.slice(dot);
    return base.slice(0, 15) + "…";
  }

  function photosForTree(treeId) {
    const id = normalizeTreeId(treeId);
    if (!id) return [];
    return state.photos.filter((p) => p.treeId === id);
  }

  /** Visible photo list: default = all imported; optional tree filter. */
  function activePhotos() {
    if (state.filterMode === "tree") {
      if (!state.treeId) return [];
      return photosForTree(state.treeId);
    }
    return state.photos;
  }

  function setFilterMode(mode) {
    state.filterMode = (mode === "tree") ? "tree" : "all";
    state.photoIndex = 0;
    state.pdfIndex = 0;
    const allBtn = $("media-filter-all");
    const treeBtn = $("media-filter-tree");
    if (allBtn) allBtn.classList.toggle("on", state.filterMode === "all");
    if (treeBtn) treeBtn.classList.toggle("on", state.filterMode === "tree");
    renderPhoto();
    updatePdfLibrary();
  }

  function pdfsForTree(treeId) {
    const id = normalizeTreeId(treeId);
    if (!id) return [];
    return state.pdfs.filter((p) => p.treeId === id);
  }

  /** Visible PDF list: default = all imported; optional tree filter by filename prefix. */
  function activePdfs() {
    if (state.filterMode === "tree") {
      if (!state.treeId) return [];
      const matched = pdfsForTree(state.treeId);
      // If no PDF name matches tree, still show all PDFs (survey PDF often shared)
      return matched.length ? matched : state.pdfs.slice();
    }
    return state.pdfs;
  }

  function currentPdf() {
    const list = activePdfs();
    if (!list.length) return null;
    if (state.pdfIndex < 0) state.pdfIndex = 0;
    if (state.pdfIndex >= list.length) state.pdfIndex = list.length - 1;
    return list[state.pdfIndex] || null;
  }

  /** Heuristic page count from PDF bytes (fallback if pdf.js unavailable). */
  function estimatePdfPageCount(bytes) {
    try {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      let s = "";
      const chunk = 0x8000;
      for (let i = 0; i < u8.length; i += chunk) {
        s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + chunk, u8.length)));
      }
      const re = /\/Type\s*\/Page(?!\s*s)\b/g;
      let n = 0;
      while (re.exec(s)) n += 1;
      return n > 0 ? n : 1;
    } catch (e) {
      return 1;
    }
  }

  function getPdfjs() {
    return (typeof window !== "undefined" && window.pdfjsLib) ? window.pdfjsLib : null;
  }

  function ensurePdfjsConfigured() {
    const lib = getPdfjs();
    if (!lib || state.pdfjsReady) return lib;
    try {
      const base = (document.querySelector('script[src*="pdf.min.js"]') || {}).src || "vendor/pdf.min.js";
      const workerSrc = String(base).replace(/pdf\.min\.js(\?.*)?$/i, "pdf.worker.min.js$1");
      lib.GlobalWorkerOptions.workerSrc = workerSrc || "vendor/pdf.worker.min.js?v=64";
      state.pdfjsReady = true;
    } catch (e) {
      console.warn("pdf.js worker config failed", e);
    }
    return lib;
  }

  function pdfCacheKey(pdf) {
    if (!pdf) return "";
    return pdf.url || pdf.name || "pdf";
  }

  function forgetPdfDoc(pdf) {
    if (!pdf) return;
    const key = pdfCacheKey(pdf);
    const cached = state.pdfDocCache.get(key);
    state.pdfDocCache.delete(key);
    if (pdf._pdfDoc) {
      try { pdf._pdfDoc.destroy(); } catch (e) { /* ignore */ }
      pdf._pdfDoc = null;
    } else if (cached && typeof cached.then === "function") {
      cached.then(function (doc) {
        try { if (doc && doc.destroy) doc.destroy(); } catch (e) { /* ignore */ }
      }).catch(function () {});
    }
  }

  function forgetAllPdfDocs() {
    state.pdfs.forEach(forgetPdfDoc);
    state.pdfDocCache.clear();
  }

  async function getPdfDocument(pdf) {
    if (!pdf) return null;
    if (pdf._pdfDoc) return pdf._pdfDoc;
    const lib = ensurePdfjsConfigured();
    if (!lib) return null;
    const key = pdfCacheKey(pdf);
    if (state.pdfDocCache.has(key)) {
      try {
        pdf._pdfDoc = await state.pdfDocCache.get(key);
        if (pdf._pdfDoc && pdf._pdfDoc.numPages) pdf.pageCount = pdf._pdfDoc.numPages;
        return pdf._pdfDoc;
      } catch (e) {
        state.pdfDocCache.delete(key);
      }
    }
    const loading = (async function () {
      let data = null;
      if (pdf.file && typeof pdf.file.arrayBuffer === "function") {
        data = new Uint8Array(await pdf.file.arrayBuffer());
      } else if (pdf.url) {
        const res = await fetch(pdf.url);
        if (!res.ok) throw new Error("無法讀取 PDF");
        data = new Uint8Array(await res.arrayBuffer());
      } else {
        throw new Error("沒有 PDF 資料");
      }
      const task = lib.getDocument({ data: data });
      return await task.promise;
    })();
    state.pdfDocCache.set(key, loading);
    try {
      const doc = await loading;
      pdf._pdfDoc = doc;
      if (doc && doc.numPages) pdf.pageCount = doc.numPages;
      return doc;
    } catch (e) {
      state.pdfDocCache.delete(key);
      throw e;
    }
  }

  async function ensurePdfPageCount(pdf) {
    if (!pdf) return 1;
    if (pdf.pageCount && pdf.pageCount > 0) return pdf.pageCount;
    try {
      const doc = await getPdfDocument(pdf);
      if (doc && doc.numPages) {
        pdf.pageCount = doc.numPages;
        return pdf.pageCount;
      }
    } catch (e) {
      /* fall through to heuristic */
    }
    try {
      let buf = null;
      if (pdf.file && typeof pdf.file.arrayBuffer === "function") {
        buf = await pdf.file.arrayBuffer();
      } else if (pdf.url) {
        const res = await fetch(pdf.url);
        if (res.ok) buf = await res.arrayBuffer();
      }
      if (buf) pdf.pageCount = estimatePdfPageCount(buf);
    } catch (e) {
      pdf.pageCount = pdf.pageCount || 1;
    }
    if (!pdf.pageCount || pdf.pageCount < 1) pdf.pageCount = 1;
    return pdf.pageCount;
  }

  function setStatusHint(msg) {
    const el = $("media-status");
    if (el) el.textContent = msg || "";
  }


  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function applyPhotoZoom() {
    const img = $("media-img");
    const viewer = $("media-viewer");
    const z = state.photoZoom;
    if (img) {
      img.style.transform = "translate(" + z.x.toFixed(1) + "px," + z.y.toFixed(1) + "px) scale(" + z.scale.toFixed(3) + ")";
    }
    if (viewer) viewer.classList.toggle("is-zoomed", z.scale > 1.01);
    const resetBtn = $("media-zoom-reset");
    if (resetBtn) resetBtn.textContent = z.scale <= 1.01 ? "1×" : (Math.round(z.scale * 10) / 10) + "×";
  }

  function resetPhotoZoom() {
    state.photoZoom.scale = 1;
    state.photoZoom.x = 0;
    state.photoZoom.y = 0;
    applyPhotoZoom();
  }

  function setPhotoZoom(scale, cx, cy) {
    const z = state.photoZoom;
    const prev = z.scale;
    const next = clamp(scale, PHOTO_ZOOM_MIN, PHOTO_ZOOM_MAX);
    if (next <= 1.01) {
      resetPhotoZoom();
      return;
    }
    // Keep point under (cx,cy) roughly stable when scaling from buttons (optional)
    if (cx != null && cy != null && prev > 0) {
      const ratio = next / prev;
      z.x = cx - (cx - z.x) * ratio;
      z.y = cy - (cy - z.y) * ratio;
    }
    z.scale = next;
    applyPhotoZoom();
  }

  function stepPhotoZoom(dir) {
    setPhotoZoom(state.photoZoom.scale + dir * PHOTO_ZOOM_STEP);
  }

  function updatePdfZoomLabel() {
    const resetBtn = $("media-pdf-zoom-reset");
    const s = state.pdfZoom;
    if (resetBtn) resetBtn.textContent = s <= 1.01 ? "1×" : (Math.round(s * 10) / 10) + "×";
    const scroll = $("media-pdf-scroll");
    if (scroll) scroll.classList.toggle("is-zoomed", s > 1.01);
  }

  function setPdfZoom(scale) {
    state.pdfZoom = clamp(scale, PDF_ZOOM_MIN, PDF_ZOOM_MAX);
    applyPdfZoom();
  }

  async function renderPdfCanvas() {
    const canvas = $("media-pdf-canvas");
    const scroll = $("media-pdf-scroll");
    const stage = $("media-pdf-stage");
    const empty = $("media-pdf-empty");
    const pdf = currentPdf();
    if (!canvas) return;
    if (!pdf || !pdf.url) return;

    const token = ++state.pdfRenderToken;
    const pageNum = state.pdfPage || 1;
    const lib = ensurePdfjsConfigured();
    if (!lib) {
      if (empty) {
        empty.hidden = false;
        empty.textContent = "缺少 pdf.js — 無法以高清晰度顯示 PDF";
      }
      return;
    }

    try {
      const doc = await getPdfDocument(pdf);
      if (token !== state.pdfRenderToken) return;
      if (!doc) throw new Error("無法載入 PDF");
      if (doc.numPages && (!pdf.pageCount || pdf.pageCount !== doc.numPages)) {
        pdf.pageCount = doc.numPages;
      }
      const page = await doc.getPage(pageNum);
      if (token !== state.pdfRenderToken) return;

      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
      const baseW = (scroll && scroll.clientWidth) ? Math.max(120, scroll.clientWidth - 4) : 280;
      const unscaled = page.getViewport({ scale: 1 });
      const fitScale = baseW / unscaled.width;
      const displayScale = fitScale * state.pdfZoom;
      const viewport = page.getViewport({ scale: displayScale * dpr });

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const cssW = Math.max(1, Math.floor(viewport.width / dpr));
      const cssH = Math.max(1, Math.floor(viewport.height / dpr));
      canvas.style.width = cssW + "px";
      canvas.style.height = cssH + "px";

      if (stage) {
        stage.style.transform = "none";
        stage.style.transformOrigin = "0 0";
        stage.style.width = cssW + "px";
        stage.style.height = cssH + "px";
        stage.style.marginRight = "0";
        stage.style.marginBottom = "0";
      }

      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("canvas 2d unavailable");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const task = page.render({ canvasContext: ctx, viewport: viewport });
      await task.promise;
      if (token !== state.pdfRenderToken) return;
      if (empty) empty.hidden = true;
    } catch (err) {
      if (token !== state.pdfRenderToken) return;
      console.warn("pdf canvas render failed", err);
      if (empty) {
        empty.hidden = false;
        empty.textContent = "PDF 繪製失敗：" + (err && err.message ? err.message : String(err));
      }
    }
  }

  function applyPdfZoom() {
    updatePdfZoomLabel();
    if (state.pdfRenderTimer) {
      clearTimeout(state.pdfRenderTimer);
      state.pdfRenderTimer = null;
    }
    state.pdfRenderTimer = setTimeout(function () {
      state.pdfRenderTimer = null;
      renderPdfCanvas();
    }, 60);
  }

  function resetPdfZoom() {
    state.pdfZoom = 1;
    applyPdfZoom();
  }

  function stepPdfZoom(dir) {
    state.pdfZoom = clamp(state.pdfZoom + dir * PDF_ZOOM_STEP, PDF_ZOOM_MIN, PDF_ZOOM_MAX);
    applyPdfZoom();
  }

  /** Photo strip removed — no-op kept for API compatibility. */
  function setShowPhotos(on) {
    state.showPhotos = false;
    document.body.classList.remove("show-photos");
    const section = $("media-photos-section");
    if (section) section.hidden = true;
    const body = $("media-photos-body");
    if (body) body.hidden = true;
    const btn = $("btn-toggle-photos");
    if (btn) btn.hidden = true;
  }

  function renderPdfTabs() {
    const tabs = $("media-pdf-tabs");
    if (!tabs) return;
    const list = activePdfs();
    tabs.innerHTML = "";
    if (list.length <= 1) {
      tabs.hidden = true;
      return;
    }
    tabs.hidden = false;
    list.forEach((pdf, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "media-pdf-tab" + (i === state.pdfIndex ? " on" : "");
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", i === state.pdfIndex ? "true" : "false");
      b.textContent = shortPdfLabel(pdf.name, i);
      b.title = pdf.name;
      b.addEventListener("click", () => selectPdfIndex(i));
      tabs.appendChild(b);
    });
  }

  function renderPageChips() {
    const nums = $("media-pdf-nums");
    const pageNow = $("media-page-now");
    // v77: remove #01/#02 chips under the PDF — jump via 「第 N/M 頁」 instead
    if (nums) {
      nums.innerHTML = "";
      nums.hidden = true;
    }
    const pages = state.relatedPages || [];
    if (!pages.length) {
      if (pageNow) {
        pageNow.textContent = state.pdfs.length ? "第 — / — 頁" : "未匯入 PDF";
        pageNow.disabled = true;
      }
      return;
    }
    if (pageNow) {
      pageNow.disabled = false;
      pageNow.textContent = "第 " + (state.pdfPage || pages[0]) + " / " + state.pdfTotal + " 頁";
      pageNow.title = "點擊跳至頁碼（目前第 " + (state.pdfPage || pages[0]) + " 頁）";
    }
  }

  function promptJumpPdfPage() {
    const pages = state.relatedPages || [];
    if (!pages.length) return;
    const total = state.pdfTotal || pages[pages.length - 1] || pages.length;
    const cur = state.pdfPage || pages[0] || 1;
    const raw = window.prompt("跳至第幾頁？（1–" + total + "）", String(cur));
    if (raw == null) return;
    const n = parseInt(String(raw).trim(), 10);
    if (!isFinite(n)) return;
    jumpToPdfPage(n);
  }

  function pdfOpenHref(url, page) {
    if (!url) return "#";
    const base = String(url).split("#")[0];
    const p = Math.max(1, Number(page) || 1);
    return base + "#page=" + p;
  }

  function renderPdfChips() {
    // Back-compat alias used by older call sites
    renderPdfTabs();
    renderPageChips();
  }

  function showPdfInFrame(page) {
    const scroll = $("media-pdf-scroll");
    const openTab = $("media-pdf-open-tab");
    const empty = $("media-pdf-empty");
    const pdf = currentPdf();
    const title = $("media-pdf-title");
    const canvas = $("media-pdf-canvas");

    if (!pdf || !pdf.url) {
      if (scroll) scroll.hidden = true;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        canvas.width = 0;
        canvas.height = 0;
      }
      if (empty) {
        empty.hidden = false;
        if (!state.pdfs.length) empty.textContent = "尚未載入 PDF — 請按「媒體資料夾」選 PDF";
        else if (state.filterMode === "tree" && !state.treeId) empty.textContent = "「只顯示呢棵樹」模式下請先點選樹木，或改回「全部媒體」";
        else empty.textContent = "沒有可顯示的 PDF";
      }
      if (openTab) { openTab.hidden = true; openTab.removeAttribute("href"); }
      if (title) title.innerHTML = '樹木 PDF <span class="tag">頁</span>';
      return;
    }

    if (empty) empty.hidden = true;
    if (scroll) scroll.hidden = false;
    const pageNum = page || state.pdfPage || 1;
    state.pdfPage = pageNum;
    if (openTab) {
      openTab.hidden = false;
      openTab.href = pdfOpenHref(pdf.url, pageNum);
      openTab.removeAttribute("download");
      openTab.textContent = "新分頁";
      openTab.title = "新分頁開啟目前第 " + pageNum + " 頁";
    }
    if (title) {
      title.innerHTML = escapeHtml(pdf.name) + ' <span class="tag">頁</span>';
    }
    updatePdfZoomLabel();
    renderPdfCanvas();
  }

  function jumpToPdfPage(n) {
    const pages = state.relatedPages || [];
    if (!pages.length) return;
    let page = Number(n);
    if (!isFinite(page)) return;
    page = Math.round(page);
    if (!pages.includes(page)) {
      const total = state.pdfTotal || pages[pages.length - 1] || 1;
      if (page < 1 || page > total) {
        setStatusHint("頁碼需介乎 1–" + total);
        return;
      }
      // Allow jump even if relatedPages temporarily incomplete
    }
    state.pdfPage = page;
    renderPageChips();
    showPdfInFrame(page);
    const pdf = currentPdf();
    setStatusHint("PDF 跳至第 " + page + " 頁" + (pdf ? (" · " + pdf.name) : ""));
  }

  function stepPdfPage(dir) {
    const pages = state.relatedPages || [];
    if (!pages.length) return;
    let idx = pages.indexOf(state.pdfPage);
    if (idx < 0) idx = 0;
    idx = (idx + dir + pages.length) % pages.length;
    jumpToPdfPage(pages[idx]);
  }

  function selectPdfIndex(i) {
    const list = activePdfs();
    if (!list.length) return;
    state.pdfIndex = Math.max(0, Math.min(i, list.length - 1));
    state.pdfPage = 1;
    resetPdfZoom();
    updatePdfLibrary();
  }

  /** Rebuild PDF tabs + page chips; load current page into main viewer. */
  function updatePdfLibrary() {
    const list = activePdfs();
    const id = normalizeTreeId(state.treeId);
    const pdfTitle = $("media-pdf-title");

    if (!list.length) {
      state.pdfIndex = 0;
      state.pdfPage = null;
      state.pdfTotal = 0;
      state.relatedPages = [];
      renderPdfTabs();
      renderPageChips();
      showPdfInFrame(null);
      return;
    }

    if (state.pdfIndex >= list.length) state.pdfIndex = 0;
    const pdf = list[state.pdfIndex];

    const demo = state.demoMode && id && DEMO_TREE_PAGES[id] && state.filterMode === "tree";
    if (demo) {
      const d = DEMO_TREE_PAGES[id];
      state.relatedPages = d.pages.slice();
      state.pdfPage = d.current;
      state.pdfTotal = d.total;
      if (pdf && !pdf.pageCount) pdf.pageCount = d.total;
      renderPdfTabs();
      renderPageChips();
      showPdfInFrame(state.pdfPage);
      return;
    }

    // Resolve page count async, then fill chips 1..N
    const known = (pdf && pdf.pageCount) ? pdf.pageCount : 0;
    if (known > 0) {
      state.pdfTotal = known;
      state.relatedPages = [];
      for (let p = 1; p <= known; p++) state.relatedPages.push(p);
      if (!state.pdfPage || state.pdfPage > known) state.pdfPage = 1;
      renderPdfTabs();
      renderPageChips();
      showPdfInFrame(state.pdfPage);
    } else {
      state.pdfTotal = 1;
      state.relatedPages = [1];
      state.pdfPage = 1;
      renderPdfTabs();
      renderPageChips();
      showPdfInFrame(1);
      ensurePdfPageCount(pdf).then(function (n) {
        if (currentPdf() !== pdf) return;
        state.pdfTotal = n;
        state.relatedPages = [];
        for (let p = 1; p <= n; p++) state.relatedPages.push(p);
        if (!state.pdfPage || state.pdfPage > n) state.pdfPage = 1;
        renderPageChips();
        showPdfInFrame(state.pdfPage);
      });
    }
    if (pdfTitle && pdf) {
      /* title also set in showPdfInFrame */
    }
  }

  function updatePdfForTree(treeId) {
    if (treeId != null) state.treeId = normalizeTreeId(treeId);
    updatePdfLibrary();
  }

  function aliasHit(props, aliases) {
    for (let i = 0; i < aliases.length; i++) {
      const k = aliases[i];
      if (Object.prototype.hasOwnProperty.call(props, k) && props[k] != null && String(props[k]) !== "") {
        return { key: k, value: props[k] };
      }
    }
    for (let i = 0; i < aliases.length; i++) {
      const k = aliases[i];
      if (Object.prototype.hasOwnProperty.call(props, k)) return { key: k, value: props[k] == null ? "" : props[k] };
    }
    return null;
  }

  function ensureCanonicalMetrics(props) {
    if (!props || typeof props !== "object") return props;
    METRIC_DEFS.forEach((def) => {
      const hit = aliasHit(props, def.aliases);
      if (hit && hit.key !== def.key) {
        if (props[def.key] == null || props[def.key] === "") props[def.key] = hit.value;
      }
      if (!Object.prototype.hasOwnProperty.call(props, def.key)) props[def.key] = "";
    });
    const rem = aliasHit(props, REMARKS_ALIASES);
    if (rem && rem.key !== "Remarks") {
      if (props.Remarks == null || props.Remarks === "") props.Remarks = rem.value;
    }
    if (!Object.prototype.hasOwnProperty.call(props, "Remarks")) props.Remarks = "";
    if (!Object.prototype.hasOwnProperty.call(props, "Species")) {
      const sp = aliasHit(props, ["Species", "species", "樹種", "树种", "學名"]);
      props.Species = sp ? sp.value : "";
    }
    return props;
  }

  function displayValue(v) {
    if (v == null || v === "") return "—";
    return String(v);
  }

  function attrCellHtml(key, value, extraClass) {
    const empty = (value == null || value === "");
    const cls = "editable" + (extraClass ? (" " + extraClass) : "") + (empty ? " empty" : "");
    return "<td class=\"" + cls + "\" data-attr-key=\"" + escapeHtml(key) +
      "\" title=\"雙擊編輯 double-click to edit\">" + escapeHtml(displayValue(value)) + "</td>";
  }

  function orderedOtherKeys(props) {
    const metricKeys = new Set();
    METRIC_DEFS.forEach((d) => {
      metricKeys.add(d.key);
      d.aliases.forEach((a) => metricKeys.add(a));
    });
    const skip = new Set(metricKeys);
    PRIMARY_KEYS.forEach((k) => skip.add(k));
    const keys = [];
    PREFERRED_OTHER.forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(props, k)) keys.push(k);
    });
    Object.keys(props).forEach((k) => {
      if (!k || k.charAt(0) === "_") return;
      if (skip.has(k)) return;
      if (keys.indexOf(k) >= 0) return;
      keys.push(k);
    });
    return keys;
  }

  function renderFeatureAttrs(props, treeId) {
    const box = $("feature-attrs-body");
    const tag = $("feature-attrs-tag");
    const title = $("feature-attrs-title");
    if (tag) tag.textContent = treeId || "—";
    if (title) {
      title.innerHTML = (treeId ? ("樹木資料 Tree " + escapeHtml(treeId)) : "樹木資料 Attributes") +
        ' <span class="tag" id="feature-attrs-tag">' + escapeHtml(treeId || "—") + "</span>";
    }
    // Keep tag id in sync if title rewrite replaced it
    const tag2 = $("feature-attrs-tag");
    if (tag2) tag2.textContent = treeId || "—";
    if (!box) return;
    if (!props) {
      state.selectedProps = null;
      box.innerHTML = '<p class="empty-hint">點選地圖／清單上的樹木以顯示屬性。點一下欄位可編輯。</p>';
      return;
    }
    ensureCanonicalMetrics(props);
    state.selectedProps = props;

    const primaryKey = PRIMARY_KEYS.find((k) => Object.prototype.hasOwnProperty.call(props, k));
    let html = "";
    html += '<p class="feature-attrs-edit-hint">點一下數值可編輯 · edits update export</p>';
    if (primaryKey) {
      html += '<table class="feature-attr-table"><tbody>';
      html += "<tr><th>" + escapeHtml(primaryKey) + "</th>" + attrCellHtml(primaryKey, props[primaryKey]) + "</tr>";
      html += "</tbody></table>";
    }

    // Second row/area: DBH / H / S as three cells
    html += '<div class="feature-metrics" role="group" aria-label="DBH Height Spread">';
    METRIC_DEFS.forEach((def) => {
      const v = props[def.key];
      const empty = (v == null || v === "");
      html += '<div class="feature-metric' + (empty ? " empty" : "") + '" data-attr-key="' + escapeHtml(def.key) +
        '" title="' + escapeHtml(def.tip) + ' · 點一下編輯">';
      html += '<div class="feature-metric-label"><span class="feature-metric-abbr">' + escapeHtml(def.label) +
        '</span><span class="feature-metric-sub">' + escapeHtml(def.tip) + "</span></div>";
      html += '<div class="feature-metric-value editable' + (empty ? " empty" : "") +
        '" data-attr-key="' + escapeHtml(def.key) + '">' + escapeHtml(displayValue(v)) + "</div>";
      html += "</div>";
    });
    html += "</div>";

    const others = orderedOtherKeys(props);
    if (others.length) {
      html += '<table class="feature-attr-table"><tbody>';
      others.forEach((k) => {
        html += "<tr><th>" + escapeHtml(k) + "</th>" + attrCellHtml(k, props[k]) + "</tr>";
      });
      html += "</tbody></table>";
    }
    box.innerHTML = html;
    bindFeatureAttrEdits(box);
  }

  function applyAttrEdit(key, value) {
    if (!key) return;
    if (state.selectedProps) state.selectedProps[key] = value;
    if (window.GpkgImport && typeof window.GpkgImport.applyTreeAttr === "function") {
      window.GpkgImport.applyTreeAttr(state.treeId, key, value);
    }
    if (window.GpkgViewer && typeof window.GpkgViewer.applySelectedAttr === "function") {
      window.GpkgViewer.applySelectedAttr(key, value);
    }
    if (window.GpkgViewer && typeof window.GpkgViewer.setStatus === "function") {
      window.GpkgViewer.setStatus("已更新 " + key, "ok");
    }
  }


  /** True for DBH / Height / Spread (canonical keys + METRIC_DEFS aliases). */
  function isMetricAttrKey(key) {
    const f = String(key || "");
    const fl = f.toLowerCase();
    if (f === "DBH" || f === "Height" || f === "Spread" ||
        fl === "dbh" || fl === "height" || fl === "spread") return true;
    return METRIC_DEFS.some((d) => d.key === f || (d.aliases && d.aliases.indexOf(f) >= 0));
  }

  /**
   * Sanitize metric commit value to a clean numeric string.
   * Empty stays empty; strips units/letters; allows one decimal; rejects non-numeric.
   */
  function sanitizeMetricNumber(raw) {
    let s = String(raw == null ? "" : raw).replace(/\r\n/g, "\n").replace(/\n/g, " ").trim();
    if (!s) return "";
    s = s.replace(/,/g, "");
    const m = s.match(/-?\d*\.?\d+/);
    if (!m) return "";
    const token = m[0];
    if (token === "." || token === "-" || token === "-.") return "";
    const n = parseFloat(token);
    if (!Number.isFinite(n)) return "";
    return String(n);
  }

  /** Mobile/iPad keyboard / Scribble hints for attrs enlarge-edit overlay. */
  function configureAttrInlineInput(inp, key) {
    if (!inp) return;
    inp.setAttribute("type", "text");
    inp.setAttribute("autocomplete", "off");
    inp.setAttribute("autocorrect", "off");
    inp.setAttribute("spellcheck", "false");
    const f = String(key || "");
    const fl = f.toLowerCase();
    const isMetric = isMetricAttrKey(key);
    const isSpecies = f === "Species" || fl === "species" || f === "樹種" || f === "树种";
    const isRemarks = f === "Remarks" || fl === "remarks" || f === "備註" || f === "备注" ||
      (typeof REMARKS_ALIASES !== "undefined" && REMARKS_ALIASES.indexOf(f) >= 0);
    const isTreeId = PRIMARY_KEYS.indexOf(f) >= 0;
    if (isMetric) {
      inp.setAttribute("inputmode", "decimal");
      inp.setAttribute("enterkeyhint", "done");
      return;
    }
    inp.setAttribute("inputmode", "text");
    if (isSpecies || isRemarks) {
      inp.setAttribute("lang", "en");
      inp.setAttribute("autocapitalize", isRemarks ? "sentences" : "off");
      inp.setAttribute("spellcheck", isRemarks ? "true" : "false");
      return;
    }
    if (isTreeId) {
      inp.setAttribute("autocapitalize", "off");
    }
  }

  function removeAttrEditOverlay() {
    const node = document.getElementById("attr-edit-overlay");
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  /** Center attrs enlarge-edit in the viewport (no CSS transform — Pencil/Scribble friendly). */
  function placeAttrEditOverlay(wrap) {
    if (!wrap) return;
    wrap.style.left = "0";
    wrap.style.top = "0";
    wrap.style.right = "0";
    wrap.style.bottom = "0";
  }

  function startAttrEdit(el) {
    if (!el || el.classList.contains("editing")) return;
    const key = el.getAttribute("data-attr-key");
    if (!key || !state.selectedProps) return;
    const prior = document.querySelector(".editable.editing, .feature-metric-value.editing");
    if (prior && prior !== el) {
      prior.classList.remove("editing");
      removeAttrEditOverlay();
    }
    const old = state.selectedProps[key] == null ? "" : String(state.selectedProps[key]);
    el.classList.add("editing");
    // Ghost text stays in-cell; handwriting editor floats above clipped panels
    el.textContent = displayValue(old);
    el.classList.toggle("empty", old === "");

    removeAttrEditOverlay();
    const wrap = document.createElement("div");
    wrap.id = "attr-edit-overlay";
    wrap.className = "tree-list-edit-overlay attr-edit-overlay";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    if (isMetricAttrKey(key)) wrap.classList.add("is-num");
    const isSpeciesOrRemarks = (function () {
      const f = String(key || "");
      const fl = f.toLowerCase();
      return f === "Species" || fl === "species" || f === "樹種" || f === "树种" ||
        f === "Remarks" || fl === "remarks" || f === "備註" || f === "备注" ||
        (typeof REMARKS_ALIASES !== "undefined" && REMARKS_ALIASES.indexOf(f) >= 0);
    })();
    if (isSpeciesOrRemarks) wrap.classList.add("is-wide");
    const panel = document.createElement("div");
    panel.className = "tree-list-edit-overlay-panel";
    const cap = document.createElement("div");
    cap.className = "tree-list-edit-overlay-cap";
    cap.textContent = String(key);
    const inp = document.createElement("textarea");
    inp.className = "tree-list-input tree-list-edit-overlay-input";
    inp.setAttribute("rows", "6");
    inp.setAttribute("enterkeyhint", "done");
    configureAttrInlineInput(inp, key);
    inp.value = old;
    panel.appendChild(cap);
    panel.appendChild(inp);
    wrap.appendChild(panel);
    document.body.appendChild(wrap);
    placeAttrEditOverlay(wrap);
    requestAnimationFrame(function () { placeAttrEditOverlay(wrap); });
    inp.focus();
    try { inp.select(); } catch (_) {}

    let done = false;
    function onWinChange() {
      if (!done) placeAttrEditOverlay(wrap);
    }
    window.addEventListener("resize", onWinChange);
    window.addEventListener("scroll", onWinChange, true);

    function finish(ok) {
      if (done) return;
      done = true;
      window.removeEventListener("resize", onWinChange);
      window.removeEventListener("scroll", onWinChange, true);
      el.classList.remove("editing");
      removeAttrEditOverlay();
      let text = String(inp.value || "").replace(/\r\n/g, "\n").replace(/\n/g, " ").trim();
      // DBH / Height / Spread → numeric-only result (decimals OK; strip units/letters)
      if (ok && isMetricAttrKey(key)) {
        text = sanitizeMetricNumber(text);
      }
      if (!ok || text === old) {
        if (el.isConnected) {
          el.textContent = displayValue(old);
          el.classList.toggle("empty", old === "");
        }
        return;
      }
      applyAttrEdit(key, text);
      if (el.isConnected) {
        el.textContent = displayValue(text);
        el.classList.toggle("empty", text === "");
      }
      const box = $("feature-attrs-body");
      if (box) {
        box.querySelectorAll("[data-attr-key]").forEach((node) => {
          if (node.getAttribute("data-attr-key") !== key) return;
          if (node.classList.contains("feature-metric")) {
            node.classList.toggle("empty", text === "");
            return;
          }
          if (node === el) return;
          if (node.classList.contains("editable") || node.classList.contains("feature-metric-value")) {
            node.textContent = displayValue(text);
            node.classList.toggle("empty", text === "");
          }
        });
      }
    }
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); finish(true); }
      if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    });
    inp.addEventListener("blur", () => { setTimeout(() => finish(true), 0); });
    panel.addEventListener("click", (ev) => ev.stopPropagation());
    panel.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    wrap.addEventListener("pointerdown", (ev) => {
      if (ev.target === wrap) { ev.preventDefault(); finish(true); }
    });
  }

  function bindFeatureAttrEdits(box) {
    if (!box || box._attrEditBound) return;
    box._attrEditBound = true;
    let editedByPointer = 0;
    function tryEdit(e, el) {
      if (!el || !box.contains(el)) return;
      if (el.classList.contains("editing")) return;
      e.preventDefault();
      startAttrEdit(el);
    }
    // Single tap/click on value → edit (mouse, Pencil, finger)
    box.addEventListener("click", (e) => {
      if (Date.now() - editedByPointer < 450) {
        e.preventDefault();
        return;
      }
      const el = e.target && e.target.closest ? e.target.closest(".editable[data-attr-key]") : null;
      tryEdit(e, el);
    });
    box.addEventListener("dblclick", (e) => {
      const el = e.target && e.target.closest ? e.target.closest(".editable[data-attr-key]") : null;
      tryEdit(e, el);
    });
    box.addEventListener("pointerup", (e) => {
      if (e.pointerType === "mouse") return; // click handles mouse
      if (e.pointerType !== "pen" && e.pointerType !== "touch") return;
      const el = e.target && e.target.closest ? e.target.closest(".editable[data-attr-key]") : null;
      if (!el || !box.contains(el) || el.classList.contains("editing")) return;
      editedByPointer = Date.now();
      tryEdit(e, el);
    });
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
    if (state.filterMode === "tree") state.photoIndex = 0;

    let useProps = props;
    if ((!useProps || !Object.keys(useProps).filter((k) => k.charAt(0) !== "_").length) && id && DEMO_ATTRS[id]) {
      // Clone so edits do not mutate the shared demo template
      useProps = Object.assign({}, DEMO_ATTRS[id]);
    }
    if (useProps) ensureCanonicalMetrics(useProps);

    const hint = $("media-tree-hint");
    if (hint) {
      if (id) {
        hint.textContent = state.filterMode === "tree" ? ("已選 " + id + " · 篩選中") : ("已選 " + id);
      } else {
        hint.textContent = "未選樹木";
      }
    }

    renderFeatureAttrs(useProps || null, id);
    resetPdfZoom();
    renderPhoto();
    updatePdfLibrary();
  }

  /** Photo strip removed from UI — kept as no-op for call sites. */
  function renderPhoto() {
    /* intentionally empty */
  }

  function stepPhoto(dir) {
    const list = activePhotos();
    if (!list.length) return;
    state.photoIndex = (state.photoIndex + dir + list.length) % list.length;
    renderPhoto();
  }

  function ingestFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) {
      setStatusHint("未選擇檔案（0 個）— 請再試「媒體資料夾」，並允許相簿／檔案存取");
      return;
    }

    let nImg = 0;
    let nPdf = 0;
    let nSkip = 0;
    const nextPhotos = [];
    const nextPdfs = [];
    const nextUrls = [];

    function keepUrl(url) {
      if (url && url.indexOf("blob:") === 0) nextUrls.push(url);
      return url;
    }

    files.forEach((file, index) => {
      try {
        if (isImageFile(file)) {
          const name = displayFileName(file, index, "image");
          const url = keepUrl(URL.createObjectURL(file));
          nextPhotos.push({
            name: name,
            url: url,
            treeId: treeIdFromFileName(name),
            file: file
          });
          nImg += 1;
        } else if (isPdfFile(file)) {
          const name = displayFileName(file, index, "pdf");
          const url = keepUrl(URL.createObjectURL(file));
          nextPdfs.push({ name: name, url: url, treeId: treeIdFromFileName(name), file: file, pageCount: 0 });
          nPdf += 1;
        } else {
          nSkip += 1;
        }
      } catch (err) {
        nSkip += 1;
        console.warn("[media] skip file", file && file.name, err);
      }
    });

    if (!nImg && !nPdf) {
      setStatusHint(
        "匯入失敗：已選 " + files.length + " 個檔，但沒有相片／PDF" +
        (nSkip ? ("（略過 " + nSkip + "）") : "") +
        "。請選 JPG／PNG／WEBP／PDF（相簿或檔案 App）"
      );
      return;
    }

    revokeAll();
    state.objectUrls = nextUrls;
    state.photos = nextPhotos;
    state.pdfs = nextPdfs;
    state.demoMode = false;
    state.photoIndex = 0;
    state.pdfIndex = 0;
    state.pdfPage = 1;
    // Default: show everything just imported (independent of tree selection)
    state.filterMode = "all";
    const allBtn = $("media-filter-all");
    const treeBtn = $("media-filter-tree");
    if (allBtn) allBtn.classList.toggle("on", true);
    if (treeBtn) treeBtn.classList.toggle("on", false);

    state.photos.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    let msg = "已載入 " + nImg + " 張相片、" + nPdf + " 個 PDF（僅本機，可唔對應樹木）";
    if (nSkip) msg += "；略過 " + nSkip + " 個非媒體檔";
    setStatusHint(msg);
    if (window.GpkgViewer && typeof window.GpkgViewer.setStatus === "function") {
      window.GpkgViewer.setStatus(msg, "ok");
    }
    const badge = $("media-source-badge");
    if (badge) {
      badge.textContent = "本機 " + (nImg + nPdf);
      badge.classList.remove("demo");
      badge.hidden = false;
    }
    renderPhoto();
    updatePdfLibrary();
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
        state.pdfs = [{ name: "tree_survey_demo.pdf", url: url, treeId: null, pageCount: 20 }];
      }
    } catch (e) { /* ignore */ }

    const badge = $("media-source-badge");
    if (badge) {
      badge.textContent = "示範";
      badge.classList.add("demo");
      badge.hidden = false;
    }
    setStatusHint("示範媒體已載入（?demo=1）— 可改為選擇本機相片／PDF 資料夾");
    state.filterMode = "all";
    const allBtn = $("media-filter-all");
    const treeBtn = $("media-filter-tree");
    if (allBtn) allBtn.classList.toggle("on", true);
    if (treeBtn) treeBtn.classList.toggle("on", false);
    state.photoIndex = 0;
    state.pdfIndex = 0;
    state.pdfPage = 1;
    if (!state.treeId) {
      // Still seed attrs for demo convenience, but media shows all
      state.treeId = "T1";
      renderFeatureAttrs(Object.assign({}, DEMO_ATTRS.T1), "T1");
      const hint = $("media-tree-hint");
      if (hint) hint.textContent = "已選 T1";
    }
    renderPhoto();
    updatePdfLibrary();
  }

  function bindPhotoGestures(viewer) {
    if (!viewer || viewer._photoZoomBound) return;
    viewer._photoZoomBound = true;
    const frame = $("media-frame") || viewer;

    let swipeX0 = null;
    let swipeY0 = null;
    let pan = null; // { x0, y0, ox, oy }
    let pinch = null; // { dist, scale, x, y }
    let lastTap = 0;
    let moved = false;

    function touchDist(a, b) {
      const dx = a.clientX - b.clientX;
      const dy = a.clientY - b.clientY;
      return Math.hypot(dx, dy) || 1;
    }

    function midPoint(a, b) {
      return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
    }

    viewer.addEventListener("touchstart", (e) => {
      if (!e.touches || !e.touches.length) return;
      moved = false;
      if (e.touches.length === 2) {
        swipeX0 = null;
        pan = null;
        const d = touchDist(e.touches[0], e.touches[1]);
        pinch = { dist: d, scale: state.photoZoom.scale, x: state.photoZoom.x, y: state.photoZoom.y };
        e.preventDefault();
        return;
      }
      pinch = null;
      const t = e.touches[0];
      swipeX0 = t.clientX;
      swipeY0 = t.clientY;
      if (state.photoZoom.scale > 1.01) {
        pan = { x0: t.clientX, y0: t.clientY, ox: state.photoZoom.x, oy: state.photoZoom.y };
      } else {
        pan = null;
      }
    }, { passive: false });

    viewer.addEventListener("touchmove", (e) => {
      if (!e.touches) return;
      if (e.touches.length === 2 && pinch) {
        e.preventDefault();
        moved = true;
        const d = touchDist(e.touches[0], e.touches[1]);
        const next = clamp(pinch.scale * (d / pinch.dist), PHOTO_ZOOM_MIN, PHOTO_ZOOM_MAX);
        state.photoZoom.scale = next;
        if (next <= 1.01) {
          state.photoZoom.x = 0;
          state.photoZoom.y = 0;
        } else {
          // mild pan from mid-point delta
          const mid = midPoint(e.touches[0], e.touches[1]);
          // keep existing translate; pinch mainly scales
          state.photoZoom.x = pinch.x;
          state.photoZoom.y = pinch.y;
        }
        applyPhotoZoom();
        return;
      }
      if (pan && e.touches.length === 1 && state.photoZoom.scale > 1.01) {
        e.preventDefault();
        const t = e.touches[0];
        const dx = t.clientX - pan.x0;
        const dy = t.clientY - pan.y0;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
        state.photoZoom.x = pan.ox + dx;
        state.photoZoom.y = pan.oy + dy;
        applyPhotoZoom();
      }
    }, { passive: false });

    viewer.addEventListener("touchend", (e) => {
      if (pinch && (!e.touches || e.touches.length < 2)) {
        pinch = null;
        if (state.photoZoom.scale <= 1.01) resetPhotoZoom();
      }
      if (pan && (!e.touches || e.touches.length === 0)) pan = null;

      // Swipe next/prev only when not zoomed (before double-tap)
      if (state.photoZoom.scale <= 1.01 && swipeX0 != null && e.changedTouches && e.changedTouches[0]) {
        const dx = e.changedTouches[0].clientX - swipeX0;
        const dy = e.changedTouches[0].clientY - (swipeY0 == null ? e.changedTouches[0].clientY : swipeY0);
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
          moved = true;
          stepPhoto(dx < 0 ? 1 : -1);
          lastTap = 0;
        }
      }

      // Double-tap zoom
      if ((!e.touches || e.touches.length === 0) && e.changedTouches && e.changedTouches[0] && !moved) {
        const now = Date.now();
        if (now - lastTap < 320) {
          lastTap = 0;
          if (state.photoZoom.scale > 1.01) resetPhotoZoom();
          else setPhotoZoom(2.2);
          swipeX0 = null;
          return;
        }
        lastTap = now;
      }
      if (!e.touches || e.touches.length === 0) {
        swipeX0 = null;
        swipeY0 = null;
      }
    }, { passive: false });

    // Mouse: drag to pan when zoomed, else swipe; double-click zoom
    let mx0 = null;
    let my0 = null;
    let mPan = null;
    viewer.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest(".zoom-btn, .media-nav")) return;
      mx0 = e.clientX;
      my0 = e.clientY;
      moved = false;
      if (state.photoZoom.scale > 1.01) {
        mPan = { x0: e.clientX, y0: e.clientY, ox: state.photoZoom.x, oy: state.photoZoom.y };
      }
    });
    window.addEventListener("mousemove", (e) => {
      if (!mPan) return;
      const dx = e.clientX - mPan.x0;
      const dy = e.clientY - mPan.y0;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
      state.photoZoom.x = mPan.ox + dx;
      state.photoZoom.y = mPan.oy + dy;
      applyPhotoZoom();
    });
    window.addEventListener("mouseup", (e) => {
      if (mPan) { mPan = null; mx0 = null; return; }
      if (mx0 == null) return;
      const dx = e.clientX - mx0;
      if (!moved && state.photoZoom.scale <= 1.01 && Math.abs(dx) > 50) stepPhoto(dx < 0 ? 1 : -1);
      mx0 = null;
      my0 = null;
    });
    viewer.addEventListener("dblclick", (e) => {
      if (e.target && e.target.closest && e.target.closest(".zoom-btn, .media-nav")) return;
      e.preventDefault();
      if (state.photoZoom.scale > 1.01) resetPhotoZoom();
      else setPhotoZoom(2.2);
    });
  }

  /**
   * Finger pinch to zoom PDF canvas (pdf.js) + pan when zoomed.
   * Live CSS scale during pinch; crisp re-render on release / button / wheel.
   */
  function bindPdfGestures(scroll) {
    if (!scroll || scroll._pdfGesturesBound) return;
    scroll._pdfGesturesBound = true;

    let pinch = null; // { dist, zoom, scrollL, scrollT, cx, cy }
    let pan = null;   // { x, y, sl, st }
    let previewScale = 1;

    function touchDist(a, b) {
      const dx = a.clientX - b.clientX;
      const dy = a.clientY - b.clientY;
      return Math.sqrt(dx * dx + dy * dy) || 1;
    }
    function midPoint(a, b) {
      return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
    }
    function stageEl() {
      return $("media-pdf-stage");
    }
    function clearPreview() {
      previewScale = 1;
      const stage = stageEl();
      if (stage) stage.style.transform = "none";
    }
    function applyPreview(scale, originX, originY) {
      previewScale = scale;
      const stage = stageEl();
      if (!stage) return;
      stage.style.transformOrigin = originX.toFixed(1) + "px " + originY.toFixed(1) + "px";
      stage.style.transform = "scale(" + scale.toFixed(4) + ")";
    }
    function commitPinchZoom(nextZoom, focusClientX, focusClientY) {
      const prev = state.pdfZoom;
      const next = clamp(nextZoom, PDF_ZOOM_MIN, PDF_ZOOM_MAX);
      clearPreview();
      if (Math.abs(next - prev) < 0.001) {
        updatePdfZoomLabel();
        return;
      }
      // Preserve focal point roughly via scroll position after re-render
      const rect = scroll.getBoundingClientRect();
      const relX = (focusClientX != null ? focusClientX : rect.left + rect.width / 2) - rect.left + scroll.scrollLeft;
      const relY = (focusClientY != null ? focusClientY : rect.top + rect.height / 2) - rect.top + scroll.scrollTop;
      const ratio = next / (prev || 1);
      state.pdfZoom = next;
      updatePdfZoomLabel();
      if (state.pdfRenderTimer) {
        clearTimeout(state.pdfRenderTimer);
        state.pdfRenderTimer = null;
      }
      state.pdfRenderTimer = setTimeout(function () {
        state.pdfRenderTimer = null;
        renderPdfCanvas().then(function () {
          scroll.scrollLeft = Math.max(0, relX * ratio - rect.width / 2);
          scroll.scrollTop = Math.max(0, relY * ratio - rect.height / 2);
        });
      }, 40);
    }

    scroll.addEventListener("touchstart", function (e) {
      if (!e.touches || !e.touches.length) return;
      if (e.touches.length === 2) {
        e.preventDefault();
        pan = null;
        const d = touchDist(e.touches[0], e.touches[1]);
        const mid = midPoint(e.touches[0], e.touches[1]);
        const rect = scroll.getBoundingClientRect();
        pinch = {
          dist: d,
          zoom: state.pdfZoom,
          scrollL: scroll.scrollLeft,
          scrollT: scroll.scrollTop,
          ox: mid.x - rect.left + scroll.scrollLeft,
          oy: mid.y - rect.top + scroll.scrollTop
        };
        return;
      }
      pinch = null;
      if (state.pdfZoom > 1.01 && e.touches.length === 1) {
        const t = e.touches[0];
        pan = { x: t.clientX, y: t.clientY, sl: scroll.scrollLeft, st: scroll.scrollTop };
        scroll.classList.add("is-panning");
      }
    }, { passive: false });

    scroll.addEventListener("touchmove", function (e) {
      if (!e.touches) return;
      if (e.touches.length === 2 && pinch) {
        e.preventDefault();
        const d = touchDist(e.touches[0], e.touches[1]);
        const factor = d / pinch.dist;
        const live = clamp(pinch.zoom * factor, PDF_ZOOM_MIN, PDF_ZOOM_MAX);
        const preview = live / (pinch.zoom || 1);
        const mid = midPoint(e.touches[0], e.touches[1]);
        const rect = scroll.getBoundingClientRect();
        applyPreview(preview, mid.x - rect.left, mid.y - rect.top);
        // Keep pinch mid roughly centered while previewing
        scroll.scrollLeft = pinch.ox * preview - (mid.x - rect.left);
        scroll.scrollTop = pinch.oy * preview - (mid.y - rect.top);
        const resetBtn = $("media-pdf-zoom-reset");
        if (resetBtn) resetBtn.textContent = live <= 1.01 ? "1×" : (Math.round(live * 10) / 10) + "×";
        return;
      }
      if (pan && e.touches.length === 1 && state.pdfZoom > 1.01) {
        e.preventDefault();
        const t = e.touches[0];
        scroll.scrollLeft = pan.sl - (t.clientX - pan.x);
        scroll.scrollTop = pan.st - (t.clientY - pan.y);
      }
    }, { passive: false });

    function endPinch(e) {
      if (pinch) {
        const touches = e.touches;
        if (!touches || touches.length < 2) {
          const next = clamp(pinch.zoom * (previewScale || 1), PDF_ZOOM_MIN, PDF_ZOOM_MAX);
          const rect = scroll.getBoundingClientRect();
          const midX = rect.left + Math.min(rect.width, Math.max(0, pinch.ox - scroll.scrollLeft));
          const midY = rect.top + Math.min(rect.height, Math.max(0, pinch.oy - scroll.scrollTop));
          pinch = null;
          commitPinchZoom(next, midX, midY);
        }
      }
      if (pan && (!e.touches || e.touches.length === 0)) {
        pan = null;
        scroll.classList.remove("is-panning");
      }
    }
    scroll.addEventListener("touchend", endPinch);
    scroll.addEventListener("touchcancel", endPinch);

    // Mouse drag pan when zoomed
    let mPan = null;
    scroll.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest(".zoom-btn")) return;
      if (state.pdfZoom <= 1.01) return;
      mPan = { x: e.clientX, y: e.clientY, sl: scroll.scrollLeft, st: scroll.scrollTop };
      scroll.classList.add("is-panning");
      e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!mPan) return;
      scroll.scrollLeft = mPan.sl - (e.clientX - mPan.x);
      scroll.scrollTop = mPan.st - (e.clientY - mPan.y);
    });
    window.addEventListener("mouseup", function () {
      if (!mPan) return;
      mPan = null;
      scroll.classList.remove("is-panning");
    });

    // Ctrl/⌘ + wheel (trackpad pinch on desktop)
    scroll.addEventListener("wheel", function (e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const delta = e.deltaY;
      const factor = delta > 0 ? 0.92 : 1.08;
      commitPinchZoom(state.pdfZoom * factor, e.clientX, e.clientY);
    }, { passive: false });

    scroll.addEventListener("dblclick", function (e) {
      if (e.target && e.target.closest && e.target.closest(".zoom-btn")) return;
      e.preventDefault();
      if (state.pdfZoom > 1.01) resetPdfZoom();
      else commitPinchZoom(2.2, e.clientX, e.clientY);
    });
  }

  function init() {
    const prev = $("media-prev");
    const next = $("media-next");
    if (prev) prev.addEventListener("click", () => stepPhoto(-1));
    if (next) next.addEventListener("click", () => stepPhoto(1));
    bindPhotoGestures($("media-viewer"));

    const zin = $("media-zoom-in");
    const zout = $("media-zoom-out");
    const zreset = $("media-zoom-reset");
    if (zin) zin.addEventListener("click", () => stepPhotoZoom(1));
    if (zout) zout.addEventListener("click", () => stepPhotoZoom(-1));
    if (zreset) zreset.addEventListener("click", () => resetPhotoZoom());

    const pzin = $("media-pdf-zoom-in");
    const pzout = $("media-pdf-zoom-out");
    const pzreset = $("media-pdf-zoom-reset");
    if (pzin) pzin.addEventListener("click", () => stepPdfZoom(1));
    if (pzout) pzout.addEventListener("click", () => stepPdfZoom(-1));
    if (pzreset) pzreset.addEventListener("click", () => resetPdfZoom());
    bindPdfGestures($("media-pdf-scroll"));

    const mediaInput = $("media-file-input");
    if (mediaInput) {
      mediaInput.addEventListener("change", () => {
        try {
          if (mediaInput.files && mediaInput.files.length) ingestFiles(mediaInput.files);
          else setStatusHint("未選擇檔案（0 個）— 請再試或檢查相簿權限");
        } catch (err) {
          setStatusHint("匯入出錯：" + (err && err.message ? err.message : String(err)));
        }
        // Allow re-picking the same files
        try { mediaInput.value = ""; } catch (e) { /* ignore */ }
      });
    }

    const filterAll = $("media-filter-all");
    const filterTree = $("media-filter-tree");
    if (filterAll) filterAll.addEventListener("click", () => setFilterMode("all"));
    if (filterTree) filterTree.addEventListener("click", () => setFilterMode("tree"));

    // Optional: deep-link / leftover id only (toolbar demo buttons removed)
    const btnDemo = $("btn-media-demo");
    if (btnDemo) btnDemo.addEventListener("click", () => { loadDemoMedia(); });

    const btnClear = $("btn-media-clear");
    if (btnClear) {
      btnClear.addEventListener("click", () => {
        forgetAllPdfDocs();
        revokeAll();
        state.photos = [];
        state.pdfs = [];
        state.demoMode = false;
        state.photoIndex = 0;
        state.pdfIndex = 0;
        state.relatedPages = [];
        state.pdfPage = null;
        state.pdfTotal = 0;
        setShowPhotos(false);
        const badge = $("media-source-badge");
        if (badge) {
          badge.textContent = "未載入";
          badge.classList.remove("demo");
          badge.hidden = true;
        }
            setStatusHint("已清除媒體");
        renderPhoto();
        updatePdfLibrary();
      });
    }

    const pdfPrev = $("media-pdf-prev");
    const pdfNext = $("media-pdf-next");
    const pageNowBtn = $("media-page-now");
    if (pdfPrev) pdfPrev.addEventListener("click", () => stepPdfPage(-1));
    if (pdfNext) pdfNext.addEventListener("click", () => stepPdfPage(1));
    if (pageNowBtn) pageNowBtn.addEventListener("click", () => promptJumpPdfPage());

    setShowPhotos(false);
    ensurePdfjsConfigured();

    // Keyboard: PDF page navigation
    document.addEventListener("keydown", (e) => {
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      if (e.key === "ArrowLeft") stepPdfPage(-1);
      if (e.key === "ArrowRight") stepPdfPage(1);
    });

    window.addEventListener("resize", function () {
      requestAnimationFrame(applyPdfZoom);
    });

    // Do not auto-load demo media in primary UI; use ?demo=1 (app.js) for samples.
    setStatusHint("尚未載入 PDF — 請按「媒體資料夾」選 PDF（右側可雙指縮放；底列清單／地圖互不依賴）");
    setFilterMode("all");
    updatePdfLibrary();
  }

  window.GpkgMedia = {
    setSelectedTree: setSelectedTree,
    ingestFiles: ingestFiles,
    loadDemoMedia: loadDemoMedia,
    normalizeTreeId: normalizeTreeId,
    setFilterMode: setFilterMode,
    setShowPhotos: setShowPhotos,
    demoAttrs: DEMO_ATTRS,
    getState: function () { return state; }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
