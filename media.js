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
    demoMode: true,
    objectUrls: [],
    photoZoom: { scale: 1, x: 0, y: 0 },
    pdfZoom: 1
  };

  const PHOTO_ZOOM_MIN = 1;
  const PHOTO_ZOOM_MAX = 4;
  const PHOTO_ZOOM_STEP = 0.35;
  const PDF_ZOOM_MIN = 1;
  const PDF_ZOOM_MAX = 3;
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
      const baseH = 150;
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

  function resetPdfZoom() {
    state.pdfZoom = 1;
    applyPdfZoom();
  }

  function stepPdfZoom(dir) {
    state.pdfZoom = clamp(state.pdfZoom + dir * PDF_ZOOM_STEP, PDF_ZOOM_MIN, PDF_ZOOM_MAX);
    applyPdfZoom();
  }

  function renderPhoto() {
    const list = photosForTree(state.treeId);
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
      const scroll = $("media-pdf-scroll");
      const openTab = $("media-pdf-open-tab");
      if (scroll) scroll.hidden = true;
      if (openTab) { openTab.hidden = true; openTab.removeAttribute("href"); }
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
    const scroll = $("media-pdf-scroll");
    const openTab = $("media-pdf-open-tab");
    const pdf = state.pdfs[0];
    if (frame && pdf && pdf.url) {
      if (scroll) scroll.hidden = false;
      // PDF open parameters: page via hash (works in many browsers)
      frame.src = pdf.url + "#page=" + n;
      if (openTab) {
        openTab.hidden = false;
        openTab.href = pdf.url + "#page=" + n;
        openTab.setAttribute("download", pdf.name || "report.pdf");
      }
      applyPdfZoom();
    } else {
      if (scroll) scroll.hidden = true;
      if (openTab) { openTab.hidden = true; openTab.removeAttribute("href"); }
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
    state.photoIndex = 0;

    let useProps = props;
    if ((!useProps || !Object.keys(useProps).filter((k) => k.charAt(0) !== "_").length) && id && DEMO_ATTRS[id]) {
      // Clone so edits do not mutate the shared demo template
      useProps = Object.assign({}, DEMO_ATTRS[id]);
    }
    if (useProps) ensureCanonicalMetrics(useProps);

    const hint = $("media-tree-hint");
    if (hint) hint.textContent = id ? ("已選 " + id) : "未選樹木";

    renderFeatureAttrs(useProps || null, id);
    resetPdfZoom();
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
