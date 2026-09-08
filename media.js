/**
 * Media panel: portrait photo viewer + PDF chips.
 * Independent media library by default (no tree / T1_* required).
 * Optional filter: when a tree is selected, can show only matching prefixes.
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
    T1: { Species: "細葉榕 Ficus microcarpa", DBH: "45 cm", Height: "12", Spread: "10", Defect: "_Cavity on trunk", Location: "Demo plot A" },
    T2: { Species: "樟樹 Cinnamomum camphora", DBH: "32 cm", Height: "9", Spread: "7", Defect: "None", Location: "Demo plot A" },
    T8: { Species: "洋紫荊 Bauhinia blakeana", DBH: "28 cm", Height: "8", Spread: "6", Defect: "Dead wood", Location: "Demo plot B" },
    T30: { Species: "台灣相思 Acacia confusa", DBH: "55 cm", Height: "14", Spread: "12", Defect: "Root plate lift", Location: "Demo plot C" }
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
  const PREFERRED_OTHER = ["Species", "Defect", "Location"];

  const state = {
    photos: [],       // { name, url, treeId, file? }
    pdfs: [],         // { name, url, file? }
    treeId: null,
    selectedProps: null,
    photoIndex: 0,
    pdfPage: null,
    pdfTotal: 20,
    relatedPages: [],
    pdfChipMode: "docs", // "docs" = one chip per PDF file; "pages" = demo page chips
    filterMode: "all",   // "all" | "tree" — default show all imported media
    demoMode: false,
    objectUrls: [],
    photoZoom: { scale: 1, x: 0, y: 0 },
    pdfZoom: 1
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
    const allBtn = $("media-filter-all");
    const treeBtn = $("media-filter-tree");
    if (allBtn) allBtn.classList.toggle("on", state.filterMode === "all");
    if (treeBtn) treeBtn.classList.toggle("on", state.filterMode === "tree");
    renderPhoto();
    updatePdfLibrary();
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

  function applyPdfZoom() {
    const stage = $("media-pdf-stage");
    const scroll = $("media-pdf-scroll");
    const frame = $("media-pdf-frame");
    const s = state.pdfZoom;
    if (stage && frame) {
      const baseW = (scroll && scroll.clientWidth) ? scroll.clientWidth : (stage.clientWidth || 280);
      const focused = document.body.classList.contains("pdf-focus");
      let baseH = 150;
      if (scroll && !scroll.hidden) {
        const sh = scroll.clientHeight;
        if (sh > 40) baseH = focused ? Math.max(220, sh - 8) : Math.max(150, Math.min(sh - 8, 220));
      }
      frame.style.width = baseW + "px";
      frame.style.height = baseH + "px";
      stage.style.transformOrigin = "0 0";
      stage.style.transform = "scale(" + s.toFixed(3) + ")";
      // Layout box stays base size; margins extend scrollable area to match visual scale
      stage.style.width = baseW + "px";
      stage.style.height = baseH + "px";
      stage.style.marginRight = (baseW * (s - 1)) + "px";
      stage.style.marginBottom = (baseH * (s - 1)) + "px";
    }
    const resetBtn = $("media-pdf-zoom-reset");
    if (resetBtn) resetBtn.textContent = s <= 1.01 ? "1×" : (Math.round(s * 10) / 10) + "×";
  }

  function isPdfFocus() {
    return document.body.classList.contains("pdf-focus");
  }

  function setPdfFocus(on) {
    document.body.classList.toggle("pdf-focus", !!on);
    const closeBtn = $("btn-pdf-focus-close");
    if (closeBtn) closeBtn.hidden = !on;
    // Re-measure after layout settles
    requestAnimationFrame(function () {
      applyPdfZoom();
      requestAnimationFrame(applyPdfZoom);
    });
  }

  function enterPdfFocus() {
    setPdfFocus(true);
  }

  function exitPdfFocus() {
    setPdfFocus(false);
  }

  function resetPdfZoom() {
    state.pdfZoom = 1;
    applyPdfZoom();
  }

  function stepPdfZoom(dir) {
    state.pdfZoom = clamp(state.pdfZoom + dir * PDF_ZOOM_STEP, PDF_ZOOM_MIN, PDF_ZOOM_MAX);
    applyPdfZoom();
  }

  function renderPhoto() {
    const list = activePhotos();
    const slide = $("media-slide");
    const img = $("media-img");
    const fname = $("media-fname");
    const pcnt = $("media-pcnt");
    const empty = $("media-empty");
    const viewer = $("media-viewer");
    resetPhotoZoom();

    if (!list.length) {
      if (slide) slide.hidden = true;
      if (img) { img.hidden = true; img.removeAttribute("src"); img.style.transform = ""; }
      if (empty) {
        empty.hidden = false;
        if (!state.photos.length) {
          empty.textContent = "尚未載入媒體 — 請按「媒體資料夾」選相片／PDF";
        } else if (state.filterMode === "tree" && state.treeId) {
          empty.textContent = "沒有符合 " + state.treeId + " 的相片（可改「全部媒體」，或檔名用 " + state.treeId + "_…）";
        } else if (state.filterMode === "tree" && !state.treeId) {
          empty.textContent = "「只顯示呢棵樹」模式下請先點選樹木，或改回「全部媒體」";
        } else {
          empty.textContent = "沒有可顯示的相片";
        }
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
      if (pageNow) pageNow.textContent = state.pdfs.length ? "—" : "未匯入 PDF";
      if (pdfTitle) pdfTitle.textContent = "相關 PDF";
      const scroll = $("media-pdf-scroll");
      const openTab = $("media-pdf-open-tab");
      if (scroll) scroll.hidden = true;
      if (openTab) { openTab.hidden = true; openTab.removeAttribute("href"); }
      exitPdfFocus();
      return;
    }

    pages.forEach((n) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "media-num" + (n === state.pdfPage ? " on" : "");
      if (state.pdfChipMode === "docs") {
        const pdf = state.pdfs[n - 1];
        b.textContent = pdf ? shortPdfLabel(pdf.name, n - 1) : ("#" + String(n).padStart(2, "0"));
        b.title = pdf ? pdf.name : ("PDF " + n);
        b.setAttribute("aria-label", "開啟 PDF " + (pdf ? pdf.name : n));
      } else {
        b.textContent = "#" + String(n).padStart(2, "0");
        b.setAttribute("aria-label", "第 " + n + " 頁");
      }
      b.addEventListener("click", () => jumpToPdfPage(n));
      nums.appendChild(b);
    });

    if (state.pdfChipMode === "docs") {
      const cur = state.pdfs[(state.pdfPage || 1) - 1];
      if (pageNow) {
        pageNow.textContent = cur
          ? ((state.pdfPage || 1) + " / " + state.pdfTotal + " · " + cur.name)
          : (state.pdfs.length + " 個 PDF");
      }
      if (pdfTitle) {
        pdfTitle.textContent = cur ? ("相關 PDF · " + cur.name) : ("相關 PDF · " + state.pdfs.length + " 個");
      }
    } else {
      if (pageNow) {
        pageNow.textContent = "現在第 " + (state.pdfPage || pages[0]) + " / " + state.pdfTotal + " 頁";
      }
      if (pdfTitle) {
        const pdfName = state.pdfs[0] ? state.pdfs[0].name : "PDF";
        pdfTitle.textContent = "相關 PDF · " + pdfName;
      }
    }
  }

  function jumpToPdfPage(n) {
    state.pdfPage = n;
    renderPdfChips();
    const frame = $("media-pdf-frame");
    const scroll = $("media-pdf-scroll");
    const openTab = $("media-pdf-open-tab");
    let pdf = null;
    let src = null;
    if (state.pdfChipMode === "docs") {
      pdf = state.pdfs[n - 1];
      if (pdf && pdf.url) src = pdf.url;
    } else {
      pdf = state.pdfs[0];
      if (pdf && pdf.url) src = pdf.url + "#page=" + n;
    }
    if (frame && pdf && src) {
      if (scroll) scroll.hidden = false;
      frame.src = src;
      if (openTab) {
        openTab.hidden = false;
        openTab.href = src;
        openTab.setAttribute("download", pdf.name || "report.pdf");
      }
      enterPdfFocus();
      applyPdfZoom();
    } else {
      if (scroll) scroll.hidden = true;
      if (openTab) { openTab.hidden = true; openTab.removeAttribute("href"); }
      exitPdfFocus();
    }
    if (state.pdfChipMode === "docs") {
      setStatusHint(pdf ? ("開啟 PDF：" + pdf.name) : "PDF");
    } else {
      setStatusHint("PDF 跳至第 " + n + " 頁" + (pdf ? "" : "（示範）"));
    }
  }

  /** Rebuild PDF chips from full imported set (tree optional; demo may use page chips). */
  function updatePdfLibrary() {
    const id = normalizeTreeId(state.treeId);
    const demo = state.demoMode && id && DEMO_TREE_PAGES[id] && state.filterMode === "tree";
    if (demo) {
      const d = DEMO_TREE_PAGES[id];
      state.pdfChipMode = "pages";
      state.relatedPages = d.pages.slice();
      state.pdfPage = d.current;
      state.pdfTotal = d.total;
    } else if (state.pdfs.length) {
      state.pdfChipMode = "docs";
      state.relatedPages = state.pdfs.map((_, i) => i + 1);
      if (!state.pdfPage || state.pdfPage > state.pdfs.length) state.pdfPage = 1;
      state.pdfTotal = state.pdfs.length;
    } else {
      state.pdfChipMode = "docs";
      state.relatedPages = [];
      state.pdfPage = null;
      state.pdfTotal = 0;
    }
    renderPdfChips();
  }

  function updatePdfForTree(treeId) {
    // Keep API: tree change may switch demo page chips when filter=tree
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

  function startAttrEdit(el) {
    if (!el || el.classList.contains("editing")) return;
    const key = el.getAttribute("data-attr-key");
    if (!key || !state.selectedProps) return;
    const old = state.selectedProps[key] == null ? "" : String(state.selectedProps[key]);
    el.classList.add("editing");
    el.innerHTML = "<input type='text' />";
    const inp = el.querySelector("input");
    inp.value = old;
    inp.focus();
    inp.select();
    let done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      el.classList.remove("editing");
      const text = inp.value;
      if (!ok || text === old) {
        el.textContent = displayValue(old);
        el.classList.toggle("empty", old === "");
        return;
      }
      applyAttrEdit(key, text);
      el.textContent = displayValue(text);
      el.classList.toggle("empty", text === "");
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
      if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
      if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    });
    inp.addEventListener("blur", () => finish(true));
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
    // Keep photo index when browsing "all"; reset when tree-filtered
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

    exitPdfFocus();
    renderFeatureAttrs(useProps || null, id);
    resetPdfZoom();
    renderPhoto();
    updatePdfLibrary();
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
          nextPdfs.push({ name: name, url: url, file: file });
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
    exitPdfFocus();
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
        state.pdfs = [{ name: "tree_survey_demo.pdf", url: url }];
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
    if (!state.treeId) {
      // Still seed attrs for demo convenience, but media shows all
      state.treeId = "T1";
      renderFeatureAttrs(Object.assign({}, DEMO_ATTRS.T1), "T1");
      const hint = $("media-tree-hint");
      if (hint) hint.textContent = "已選 T1";
    }
    exitPdfFocus();
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
        revokeAll();
        state.photos = [];
        state.pdfs = [];
        state.demoMode = false;
        state.photoIndex = 0;
        state.relatedPages = [];
        state.pdfPage = null;
        const badge = $("media-source-badge");
        if (badge) {
          badge.textContent = "未載入";
          badge.classList.remove("demo");
          badge.hidden = true;
        }
        exitPdfFocus();
        setStatusHint("已清除媒體");
        renderPhoto();
        updatePdfLibrary();
      });
    }

    const pdfClose = $("btn-pdf-focus-close");
    if (pdfClose) pdfClose.addEventListener("click", () => exitPdfFocus());

    const pdfScroll = $("media-pdf-scroll");
    if (pdfScroll) {
      pdfScroll.addEventListener("click", (e) => {
        // Ignore clicks on zoom controls nested elsewhere; scroll area itself expands
        if (e.target && e.target.closest && e.target.closest(".zoom-btn")) return;
        if (!isPdfFocus()) enterPdfFocus();
      });
    }

    const pdfHead = $("media-pdf-title");
    if (pdfHead) {
      pdfHead.style.cursor = "pointer";
      pdfHead.title = "點擊展開 PDF 預覽";
      pdfHead.addEventListener("click", () => {
        const scroll = $("media-pdf-scroll");
        if (scroll && !scroll.hidden) enterPdfFocus();
      });
    }

    // Keyboard
    document.addEventListener("keydown", (e) => {
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      if (e.key === "ArrowLeft") stepPhoto(-1);
      if (e.key === "ArrowRight") stepPhoto(1);
      if (e.key === "Escape" && isPdfFocus()) exitPdfFocus();
    });

    // Do not auto-load demo media in primary UI; use ?demo=1 (app.js) for samples.
    setStatusHint("尚未載入媒體 — 請按「媒體資料夾」選相片／PDF（可唔對應地圖／清單）");
    setFilterMode("all");
    renderPhoto();
    updatePdfLibrary();
  }

  window.GpkgMedia = {
    setSelectedTree: setSelectedTree,
    ingestFiles: ingestFiles,
    loadDemoMedia: loadDemoMedia,
    normalizeTreeId: normalizeTreeId,
    setFilterMode: setFilterMode,
    demoAttrs: DEMO_ATTRS,
    getState: function () { return state; }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
