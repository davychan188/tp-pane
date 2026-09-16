/**
 * Excel / CSV tree-list import + map PDF/image reference panel + from-scratch annotate.
 * v111: portal topbar menus (overflow clip fix). v110: topbar 匯入/隱藏/匯出; larger import hits; accept all files; PDF blob worker.
 * v109: project backup/restore (export+import .tp-pane.json package).
 * v108: hide-trees expands map; multipage map PDF sheets; page selects; broader PDF accept.
 * v107: list PDF reuses map ink color/width controls (same DOM). v106: full-height list PDF. v105: fill panel. v104: list PDF pane.
 * Works without a GeoPackage. Tree list / Excel import does not require a map PDF;
 * map PDF import is separate — neither blocks the other.
 * Hooks into window.GpkgViewer (set by app.js).
 */
(function () {
  "use strict";

  const ID_HEADER_HINTS = [
    "tree id", "treeid", "tree_id", "tree-id", "tree.id",
    "tree_no", "tree no", "tree no.", "treeno", "tree number", "treenumber", "tree_num", "tree#",
    "plant id", "plantid", "plant no", "plant no.", "plant_no", "plantno",
    "asset id", "assetid", "asset no", "asset_no",
    "tag", "tag no", "tag_no", "tagno", "tree tag", "treetag", "label",
    "tree", "trees",
    "號碼", "木號", "树号", "樹號", "树木编号", "樹木編號", "樹木编号", "树木編號", "編號", "编号",
    "no.", "no", "num", "number",
    "id", "fid", "gid"
  ];
  // Short / ambiguous hints: exact (or compact) match only — avoid "no" hitting "longitude"
  const ID_HEADER_EXACT_ONLY = new Set([
    "no", "no.", "num", "number", "tag", "label", "tree", "trees", "id", "fid", "gid", "編號", "编号"
  ]);

  const SPECIES_HINTS = ["scientific name", "scientific", "species", "學名", "学名", "树种", "樹種"];
  const DBH_HINTS = ["dbh", "diameter", "胸徑", "胸径"];
  const HEIGHT_HINTS = ["overall height (m)", "overall height", "height_m", "height", "高度", "h"];
  const SPREAD_HINTS = ["crown spread (m)", "crown spread", "spread_m", "spread", "crown", "冠幅", "s"];
  const DEFECT_HINTS = ["defect", "缺陷", "condition"];
  const REMARKS_HINTS = ["remarks", "備註", "备注", "remark", "note", "notes", "註解", "附註"];
  const RECOMMEND_HINTS = [
    "recommendation", "recommendations", "建議", "建议", "處理建議", "处理建议",
    "proposed mitigation measure", "proposed mitigation measures", "proposed mitigation",
    "mitigation measure", "mitigation", "measures", "action", "actions"
  ];
  const CHINESE_NAME_HINTS = ["chinese name", "chinese", "中文名", "中文名稱", "中文名称"];
  const LOCATION_HINTS = ["location", "位置", "site", "address", "地點", "地点"];
  const LAT_HINTS = ["lat", "latitude", "緯度", "纬度", "y_wgs", "wgs_y", "wgs84_y"];
  const LON_HINTS = ["lon", "lng", "long", "longitude", "經度", "经度", "x_wgs", "wgs_x", "wgs84_x"];
  const X_HINTS = ["x", "easting", "east", "hk_e", "hk1980_e", "東距", "东距"];
  const Y_HINTS = ["y", "northing", "north", "hk_n", "hk1980_n", "北距"];

  const LS_SESSION = "tp-pane-session-trees";
  const LS_HIDE_MEDIA = "tp-pane-hide-media";
  const LS_HIDE_MAP = "tp-pane-hide-map";
  const LS_HIDE_TREES = "tp-pane-hide-trees";
  const LS_INK_PREFS = "tp-pane-ink-prefs";
  const LS_COL_MAP = "tp-pane-excel-col-map";
  const LS_LIST_PDF_INK = "tp-pane-list-pdf-ink";
  const LIST_PDF_INK_MAX_STROKES = 240;
  const LIST_PDF_INK_MAX_KEYS = 24;
  const LIST_PDF_ZOOM_MIN = 1;
  const LIST_PDF_ZOOM_MAX = 12;
  let persistTimer = null;
  let restoring = false;

  const state = {
    trees: [],          // { id, props, feature, hasCoords, x, y, path, annot, leafletMarker }
    drawStrokes: [],    // freehand ink for CURRENT map only: [{ path, color?, width? }]
    drawStrokesByMap: {}, // per-map ink: { [mapKey]: strokes[] } — never bleed across maps
    drawMapKey: null,   // active map ink key (file name identity)
    inkColor: "#38bdf8",
    inkWidth: 2.25,
    sourceName: "",
    mapRefUrl: null,
    mapRefRasterUrl: null, // PNG/JPG blob used for annotate when PDF was rasterized
    mapRefKind: null,   // "pdf" | "image"
    mapRefName: "",
    mapRefMeta: null,   // { name, kind } when map blob cannot be restored
    mapRefZoom: { scale: 1, x: 0, y: 0 }, // x/y = scrollLeft/Top; scale enlarges layout (no CSS scale())
    mapRefRasterized: false,
    mapSheets: [],      // [{ id, label, kind:'original'|'page'|'crop', url, sourceName, page?, cropOf? }]
    activeMapSheetId: null,
    cropMode: false,
    cropRect: null,     // { x, y, w, h } in active sheet content % (0–100)
    cropDrag: null,
    objectUrls: [],
    annotateMode: false,
    idMode: "auto",     // "auto" | "manual"
    pendingPlace: null, // { x, y, lat, lng, source }
    leafletAnnotLayer: null,
    leafletBound: false,
    annotLayerRo: null
  };

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function displayListVal(v) {
    if (v == null || v === "") return "—";
    return String(v);
  }

  function schedulePersist() {
    if (restoring) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(persistSession, 200);
  }

  function serializeTrees() {
    return state.trees.map((t) => {
      const props = Object.assign({}, t.props || {});
      // Drop huge / transient keys if any
      Object.keys(props).forEach((k) => {
        if (k && k.charAt(0) === "_" && k !== "_editColor") delete props[k];
      });
      return {
        id: String(t.id),
        props: props,
        hasCoords: !!t.hasCoords,
        x: t.x == null ? null : Number(t.x),
        y: t.y == null ? null : Number(t.y),
        path: Array.isArray(t.path) && t.path.length ? t.path.map(function (p) {
          return { x: Number(p.x), y: Number(p.y) };
        }) : null,
        annot: !!t.annot,
        source: t.source || (t.annot ? "annotate" : "import"),
        geometry: (t.feature && t.feature.geometry) ? t.feature.geometry : null
      };
    });
  }

  function mapInkKey(name) {
    const s = String(name || "").trim().toLowerCase();
    return s || "";
  }

  function normalizeStrokeRec(s) {
    if (!s) return null;
    const path = Array.isArray(s.path) ? s.path : null;
    if (!path || !path.length) return null;
    const pts = path.map(function (p) {
      return { x: Number(p.x), y: Number(p.y) };
    }).filter(function (p) { return isFinite(p.x) && isFinite(p.y); });
    if (!pts.length) return null;
    const out = { path: pts };
    if (s.color) out.color = String(s.color);
    const w = Number(s.width);
    if (isFinite(w) && w > 0) out.width = w;
    return out;
  }

  function serializeDrawStrokes(list) {
    const src = Array.isArray(list) ? list : (state.drawStrokes || []);
    return src.map(function (s) {
      const path = Array.isArray(s && s.path) ? s.path : null;
      const norm = path ? simplifyPath(path) || normalizePath(path) : null;
      if (!norm || !norm.length) return null;
      const out = { path: norm.map(function (p) { return { x: Number(p.x), y: Number(p.y) }; }) };
      if (s && s.color) out.color = String(s.color);
      const w = Number(s && s.width);
      if (isFinite(w) && w > 0) out.width = w;
      return out;
    }).filter(Boolean);
  }

  function serializeDrawStrokesByMap() {
    const bag = state.drawStrokesByMap || {};
    const out = {};
    Object.keys(bag).forEach(function (k) {
      const strokes = serializeDrawStrokes(bag[k]);
      if (strokes.length) out[k] = strokes;
    });
    return out;
  }

  /** Persist current map's ink under its key so switching maps never bleeds strokes. */
  function saveCurrentMapInk() {
    const sheet = (typeof getActiveMapSheet === "function") ? getActiveMapSheet() : null;
    const key = (sheet && sheet.id) || state.drawMapKey || mapInkKey(state.mapRefName);
    if (!key) {
      state.drawStrokes = state.drawStrokes || [];
      return;
    }
    state.drawStrokesByMap = state.drawStrokesByMap || {};
    state.drawStrokesByMap[key] = serializeDrawStrokes(state.drawStrokes);
    state.drawMapKey = key;
  }

  function loadMapInk(name) {
    const key = mapInkKey(name);
    state.drawMapKey = key || null;
    const bag = state.drawStrokesByMap || {};
    const raw = (key && Array.isArray(bag[key])) ? bag[key] : [];
    state.drawStrokes = raw.map(normalizeStrokeRec).filter(Boolean);
  }

  function getActiveMapSheet() {
    const id = state.activeMapSheetId;
    if (!id || !state.mapSheets || !state.mapSheets.length) return null;
    for (let i = 0; i < state.mapSheets.length; i++) {
      if (state.mapSheets[i].id === id) return state.mapSheets[i];
    }
    return state.mapSheets[0] || null;
  }

  /** Original-space % ↔ active sheet % when viewing a crop. */
  function sheetPctFromOrig(ox, oy) {
    const sheet = getActiveMapSheet();
    const c = sheet && sheet.cropOf;
    if (!c || !(c.w > 0) || !(c.h > 0)) return { x: ox, y: oy };
    return {
      x: ((Number(ox) - c.x) / c.w) * 100,
      y: ((Number(oy) - c.y) / c.h) * 100
    };
  }

  function origPctFromSheet(sx, sy) {
    const sheet = getActiveMapSheet();
    const c = sheet && sheet.cropOf;
    if (!c || !(c.w > 0) || !(c.h > 0)) return { x: sx, y: sy };
    return {
      x: c.x + (Number(sx) / 100) * c.w,
      y: c.y + (Number(sy) / 100) * c.h
    };
  }

  function remapPathToSheet(path) {
    if (!path || !path.length) return path;
    const sheet = getActiveMapSheet();
    if (!sheet || !sheet.cropOf) return path;
    return path.map(function (p) {
      const q = sheetPctFromOrig(p.x, p.y);
      return { x: q.x, y: q.y };
    });
  }

  function remapPathToOrig(path) {
    if (!path || !path.length) return path;
    const sheet = getActiveMapSheet();
    if (!sheet || !sheet.cropOf) return path;
    return path.map(function (p) {
      const q = origPctFromSheet(p.x, p.y);
      return { x: q.x, y: q.y };
    });
  }

  function revokeSheetUrl(url) {
    if (url && String(url).indexOf("blob:") === 0) {
      try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
    }
  }

  function clearMapSheets() {
    (state.mapSheets || []).forEach(function (s) {
      if (!s || !s.url) return;
      // Do not revoke URLs still referenced as mapRefUrl / mapRefRasterUrl — those cleared separately
      if (s.url === state.mapRefUrl || s.url === state.mapRefRasterUrl) return;
      revokeSheetUrl(s.url);
    });
    state.mapSheets = [];
    state.activeMapSheetId = null;
  }

  function nextCropSheetMeta(sourceName) {
    let n = 0;
    (state.mapSheets || []).forEach(function (s) {
      if (s && s.kind === "crop") n += 1;
    });
    n += 1;
    const base = mapInkKey(sourceName || state.mapRefName || "map") || "map";
    return {
      id: "crop" + n + ":" + base,
      label: "裁切" + n
    };
  }

  function getMapPageSheets() {
    return (state.mapSheets || []).filter(function (s) {
      return s && (s.kind === "page" || (typeof s.page === "number" && s.page > 0));
    });
  }

  function syncMapPageSelect() {
    const nav = $("map-ref-page-nav");
    const sel = $("map-ref-page-select");
    const pages = getMapPageSheets();
    if (!nav || !sel) return;
    if (pages.length < 1) {
      nav.hidden = true;
      sel.innerHTML = "";
      return;
    }
    nav.hidden = false;
    const total = pages.length;
    const active = state.activeMapSheetId;
    const opts = [];
    for (let i = 0; i < pages.length; i++) {
      const n = pages[i].page || (i + 1);
      opts.push('<option value="' + escapeHtml(pages[i].id) + '"' +
        (pages[i].id === active ? " selected" : "") + ">第 " + n + " / " + total + " 頁</option>");
    }
    sel.innerHTML = opts.join("");
    if (pages.some(function (p) { return p.id === active; })) {
      sel.value = active;
    }
  }

  function renderMapSheetTabs() {
    const box = $("map-sheet-tabs");
    const sheets = state.mapSheets || [];
    const pages = getMapPageSheets();
    const hasPages = pages.length >= 1;
    syncMapPageSelect();
    if (!box) return;
    if (!sheets.length) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    // Multipage: page sheets use select; tabs show crops (+ original if any without pages)
    const tabSheets = hasPages
      ? sheets.filter(function (s) { return s && s.kind !== "page"; })
      : sheets;
    if (!tabSheets.length) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }
    box.hidden = false;
    const active = state.activeMapSheetId;
    box.innerHTML = tabSheets.map(function (s) {
      const on = s.id === active ? " on" : "";
      return '<button type="button" class="map-sheet-tab' + on + '" role="tab" data-sheet-id="' +
        escapeHtml(s.id) + '" aria-selected="' + (s.id === active ? "true" : "false") + '" title="' +
        escapeHtml(s.label + (s.sourceName ? " · " + s.sourceName : "")) + '">' +
        escapeHtml(s.label) + "</button>";
    }).join("");
  }

  function syncCropOverlayBox() {
    const overlay = $("map-crop-overlay");
    const layer = $("map-annotate-layer");
    if (!overlay || !layer) return;
    overlay.style.left = layer.style.left || "0";
    overlay.style.top = layer.style.top || "0";
    overlay.style.width = layer.style.width || "100%";
    overlay.style.height = layer.style.height || "100%";
  }

  function updateCropRectEl() {
    const el = $("map-crop-rect");
    if (!el) return;
    const r = state.cropRect;
    if (!r || !(r.w > 0.15) || !(r.h > 0.15)) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.style.left = r.x.toFixed(3) + "%";
    el.style.top = r.y.toFixed(3) + "%";
    el.style.width = r.w.toFixed(3) + "%";
    el.style.height = r.h.toFixed(3) + "%";
  }

  function setCropMode(on) {
    const want = !!on;
    if (want) {
      const img = getMapRefMediaEl();
      if (!img) {
        setImportStatus("請先匯入地圖影像（PDF 會自動轉影像）再裁切", "warn");
        return;
      }
    }
    state.cropMode = want;
    state.cropDrag = null;
    if (!want) state.cropRect = null;
    document.body.classList.toggle("map-crop-mode", want);
    const overlay = $("map-crop-overlay");
    const actions = $("map-crop-actions");
    const btn = $("btn-map-crop");
    if (overlay) {
      overlay.hidden = !want;
      overlay.setAttribute("aria-hidden", want ? "false" : "true");
    }
    if (actions) actions.hidden = !want;
    if (btn) {
      btn.classList.toggle("is-on", want);
      btn.textContent = want ? "裁切中" : "裁切";
    }
    updateCropRectEl();
    if (want) {
      syncAnnotLayerToContent();
      syncCropOverlayBox();
      setImportStatus("裁切模式：拖曳選取區域，再按「確定」新增圖紙", "ok");
    }
  }

  function exitCropMode() {
    setCropMode(false);
  }

  function showSheetOnImg(sheet) {
    if (!sheet) return;
    const img = $("map-ref-img");
    const obj = $("map-ref-object");
    const emb = $("map-ref-embed");
    const frame = $("map-ref-frame");
    const label = $("map-ref-label");
    const openTab = $("map-ref-open-tab");
    if (obj) {
      obj.hidden = true;
      try { obj.removeAttribute("data"); } catch (e) { /* ignore */ }
      obj.data = "";
    }
    if (emb) {
      try { emb.removeAttribute("src"); } catch (e) { /* ignore */ }
      emb.src = "";
    }
    if (frame) {
      frame.hidden = true;
      frame.removeAttribute("src");
    }
    if (img) {
      const onReady = function () {
        img.removeEventListener("load", onReady);
        applyMapRefZoom();
        renderAnnotOverlay();
        syncCropOverlayBox();
      };
      img.addEventListener("load", onReady);
      img.hidden = false;
      if (img.src !== sheet.url) img.src = sheet.url;
      img.alt = sheet.label + (sheet.sourceName ? " · " + sheet.sourceName : "");
      if (img.complete && img.naturalWidth) onReady();
    }
    if (label) {
      const base = sheet.sourceName || state.mapRefName || "地圖";
      label.textContent = "地圖參考 · " + base +
        (sheet.kind === "crop" || sheet.kind === "page" ? " · " + sheet.label : "");
    }
    if (openTab && sheet.url) {
      openTab.hidden = false;
      openTab.href = sheet.url;
      openTab.removeAttribute("download");
      openTab.textContent = "新分頁";
      openTab.title = "新分頁開啟目前圖紙";
    }
  }

  function switchMapSheet(sheetId) {
    if (!sheetId) return;
    const sheets = state.mapSheets || [];
    let sheet = null;
    for (let i = 0; i < sheets.length; i++) {
      if (sheets[i].id === sheetId) { sheet = sheets[i]; break; }
    }
    if (!sheet) return;
    if (state.activeMapSheetId === sheet.id) {
      renderMapSheetTabs();
      return;
    }
    if (state.cropMode) exitCropMode();
    saveCurrentMapInk();
    state.activeMapSheetId = sheet.id;
    loadMapInk(sheet.id);
    showSheetOnImg(sheet);
    renderMapSheetTabs();
    schedulePersist();
    setImportStatus("已切換圖紙：" + sheet.label, "ok");
  }

  function registerOriginalSheet(displayUrl, name) {
    const id = mapInkKey(name) || "original";
    // Replace sheet list but keep ink bag (keyed by id)
    clearMapSheets();
    state.mapSheets = [{
      id: id,
      label: "原圖",
      kind: "original",
      url: displayUrl,
      sourceName: name || "",
      cropOf: null
    }];
    state.activeMapSheetId = id;
    // Align ink key with sheet id (filename key — back-compat)
    if (state.drawMapKey !== id) {
      saveCurrentMapInk();
      loadMapInk(id);
    } else {
      state.drawMapKey = id;
    }
    renderMapSheetTabs();
  }

  function updateActiveSheetDisplayUrl(url) {
    const sheet = getActiveMapSheet();
    if (sheet && url) sheet.url = url;
  }

  function cropImageToPngBlob(img, rectPct) {
    return new Promise(function (resolve, reject) {
      try {
        const nw = img.naturalWidth;
        const nh = img.naturalHeight;
        if (!nw || !nh) {
          reject(new Error("地圖影像尚未就緒"));
          return;
        }
        let sx = Math.round((rectPct.x / 100) * nw);
        let sy = Math.round((rectPct.y / 100) * nh);
        let sw = Math.round((rectPct.w / 100) * nw);
        let sh = Math.round((rectPct.h / 100) * nh);
        sx = Math.max(0, Math.min(nw - 1, sx));
        sy = Math.max(0, Math.min(nh - 1, sy));
        sw = Math.max(1, Math.min(nw - sx, sw));
        sh = Math.max(1, Math.min(nh - sy, sh));
        const canvas = document.createElement("canvas");
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) {
          reject(new Error("無法建立裁切畫布"));
          return;
        }
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, sw, sh);
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        if (canvas.toBlob) {
          canvas.toBlob(function (blob) {
            if (!blob) reject(new Error("裁切輸出失敗"));
            else resolve(blob);
          }, "image/png");
        } else {
          reject(new Error("瀏覽器不支援 toBlob"));
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  function confirmMapCrop() {
    const r = state.cropRect;
    if (!r || !(r.w > 0.4) || !(r.h > 0.4)) {
      setImportStatus("請拖曳選取較大的裁切範圍", "warn");
      return;
    }
    const img = getMapRefMediaEl();
    if (!img) {
      setImportStatus("沒有可裁切的地圖影像", "warn");
      return;
    }
    const active = getActiveMapSheet();
    const sourceName = (active && active.sourceName) || state.mapRefName || "map";
    setImportStatus("裁切中…", "");
    cropImageToPngBlob(img, r).then(function (blob) {
      const meta = nextCropSheetMeta(sourceName);
      const url = rememberUrl(URL.createObjectURL(blob));
      // cropOf in original content % (compose through parent crop if any)
      let ox = r.x;
      let oy = r.y;
      let ow = r.w;
      let oh = r.h;
      if (active && active.cropOf) {
        ox = active.cropOf.x + (r.x / 100) * active.cropOf.w;
        oy = active.cropOf.y + (r.y / 100) * active.cropOf.h;
        ow = (r.w / 100) * active.cropOf.w;
        oh = (r.h / 100) * active.cropOf.h;
      }
      const sheet = {
        id: meta.id,
        label: meta.label,
        kind: "crop",
        url: url,
        sourceName: sourceName,
        cropOf: { x: ox, y: oy, w: ow, h: oh, parentId: active ? active.id : null }
      };
      saveCurrentMapInk();
      state.mapSheets.push(sheet);
      state.activeMapSheetId = sheet.id;
      loadMapInk(sheet.id);
      exitCropMode();
      showSheetOnImg(sheet);
      renderMapSheetTabs();
      schedulePersist();
      setImportStatus("已新增圖紙「" + sheet.label + "」· 可分別畫墨跡；按圖紙標籤切換", "ok");
    }).catch(function (err) {
      console.warn(err);
      setImportStatus("裁切失敗：" + (err && err.message ? err.message : err), "error");
    });
  }

  function bindMapCropUi() {
    const btn = $("btn-map-crop");
    if (btn && !btn._cropBound) {
      btn._cropBound = true;
      btn.addEventListener("click", function () {
        if (!state.mapRefUrl) {
          setImportStatus("尚未匯入地圖 PDF／圖片", "warn");
          return;
        }
        if (state.cropMode) exitCropMode();
        else setCropMode(true);
      });
    }
    const cancel = $("btn-map-crop-cancel");
    if (cancel && !cancel._cropBound) {
      cancel._cropBound = true;
      cancel.addEventListener("click", function () { exitCropMode(); });
    }
    const confirm = $("btn-map-crop-confirm");
    if (confirm && !confirm._cropBound) {
      confirm._cropBound = true;
      confirm.addEventListener("click", function () { confirmMapCrop(); });
    }
    const tabs = $("map-sheet-tabs");
    if (tabs && !tabs._sheetBound) {
      tabs._sheetBound = true;
      tabs.addEventListener("click", function (e) {
        const t = e.target && e.target.closest ? e.target.closest("[data-sheet-id]") : null;
        if (!t) return;
        e.preventDefault();
        switchMapSheet(t.getAttribute("data-sheet-id"));
      });
    }
    const pageSel = $("map-ref-page-select");
    if (pageSel && !pageSel._pageBound) {
      pageSel._pageBound = true;
      pageSel.addEventListener("change", function () {
        if (pageSel.value) switchMapSheet(pageSel.value);
      });
    }
    const pagePrev = $("map-ref-page-prev");
    if (pagePrev && !pagePrev._pageBound) {
      pagePrev._pageBound = true;
      pagePrev.addEventListener("click", function () {
        const pages = getMapPageSheets();
        if (!pages.length) return;
        let idx = pages.findIndex(function (p) { return p.id === state.activeMapSheetId; });
        if (idx < 0) idx = 0;
        const next = pages[Math.max(0, idx - 1)];
        if (next) switchMapSheet(next.id);
      });
    }
    const pageNext = $("map-ref-page-next");
    if (pageNext && !pageNext._pageBound) {
      pageNext._pageBound = true;
      pageNext.addEventListener("click", function () {
        const pages = getMapPageSheets();
        if (!pages.length) return;
        let idx = pages.findIndex(function (p) { return p.id === state.activeMapSheetId; });
        if (idx < 0) idx = 0;
        const next = pages[Math.min(pages.length - 1, idx + 1)];
        if (next) switchMapSheet(next.id);
      });
    }
    const overlay = $("map-crop-overlay");
    if (overlay && !overlay._cropPtrBound) {
      overlay._cropPtrBound = true;
      function pctFromOverlay(clientX, clientY) {
        const rect = overlay.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const x = ((clientX - rect.left) / rect.width) * 100;
        const y = ((clientY - rect.top) / rect.height) * 100;
        return {
          x: Math.max(0, Math.min(100, x)),
          y: Math.max(0, Math.min(100, y))
        };
      }
      overlay.addEventListener("pointerdown", function (e) {
        if (!state.cropMode) return;
        if (e.pointerType === "mouse" && e.button !== 0) return;
        // Allow two-finger pinch to pass (ignore non-primary multi-touch starts loosely)
        e.preventDefault();
        e.stopPropagation();
        const p = pctFromOverlay(e.clientX, e.clientY);
        if (!p) return;
        state.cropDrag = { pointerId: e.pointerId, x0: p.x, y0: p.y };
        state.cropRect = { x: p.x, y: p.y, w: 0, h: 0 };
        updateCropRectEl();
        try { overlay.setPointerCapture(e.pointerId); } catch (_) {}
      }, { passive: false });
      overlay.addEventListener("pointermove", function (e) {
        if (!state.cropDrag || state.cropDrag.pointerId !== e.pointerId) return;
        e.preventDefault();
        const p = pctFromOverlay(e.clientX, e.clientY);
        if (!p) return;
        const x0 = state.cropDrag.x0;
        const y0 = state.cropDrag.y0;
        const x = Math.min(x0, p.x);
        const y = Math.min(y0, p.y);
        const w = Math.abs(p.x - x0);
        const h = Math.abs(p.y - y0);
        state.cropRect = { x: x, y: y, w: w, h: h };
        updateCropRectEl();
      }, { passive: false });
      function endCropDrag(e) {
        if (!state.cropDrag || (e && state.cropDrag.pointerId !== e.pointerId)) return;
        state.cropDrag = null;
        try { if (e) overlay.releasePointerCapture(e.pointerId); } catch (_) {}
      }
      overlay.addEventListener("pointerup", endCropDrag);
      overlay.addEventListener("pointercancel", endCropDrag);
    }
  }


  function loadInkPrefs() {
    try {
      const raw = localStorage.getItem(LS_INK_PREFS);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data && data.color) state.inkColor = String(data.color);
      const w = Number(data && data.width);
      if (isFinite(w) && w >= 1 && w <= 12) state.inkWidth = w;
    } catch (_) {}
  }

  function saveInkPrefs() {
    try {
      localStorage.setItem(LS_INK_PREFS, JSON.stringify({
        color: state.inkColor,
        width: state.inkWidth
      }));
    } catch (_) {}
  }

  function syncInkControlsUi() {
    const colorEl = $("map-ink-color");
    const widthEl = $("map-ink-width");
    if (colorEl) colorEl.value = state.inkColor || "#38bdf8";
    if (widthEl) widthEl.value = String(state.inkWidth || 2.25);
  }

  /** Live ink prefs: prefer control values, fall back to state (v84). */
  function currentInkPrefs() {
    const colorEl = $("map-ink-color");
    const widthEl = $("map-ink-width");
    let color = state.inkColor || "#38bdf8";
    let width = state.inkWidth || 2.25;
    if (colorEl && colorEl.value) color = String(colorEl.value);
    if (widthEl && widthEl.value != null && widthEl.value !== "") {
      const w = Number(widthEl.value);
      if (isFinite(w) && w > 0) width = w;
    }
    state.inkColor = color;
    state.inkWidth = width;
    return { color: color, width: width };
  }

  function applyInkPrefFromControls() {
    const prefs = currentInkPrefs();
    saveInkPrefs();
    return prefs;
  }

  function bindInkControls() {
    loadInkPrefs();
    syncInkControlsUi();
    const colorEl = $("map-ink-color");
    const widthEl = $("map-ink-width");
    function onColor() {
      state.inkColor = (colorEl && colorEl.value) || "#38bdf8";
      saveInkPrefs();
    }
    function onWidth() {
      const w = Number(widthEl && widthEl.value);
      if (isFinite(w) && w > 0) state.inkWidth = w;
      saveInkPrefs();
    }
    if (colorEl) {
      // Re-bind even if previously marked — toolbar may have been recreated
      colorEl.oninput = onColor;
      colorEl.onchange = onColor;
      colorEl._inkBound = true;
    }
    if (widthEl) {
      widthEl.oninput = onWidth;
      widthEl.onchange = onWidth;
      widthEl._inkBound = true;
    }
    // Event delegation on under-map toolbar (survives DOM moves)
    const bar = $("map-ref-controls");
    if (bar && !bar._inkDelegateBound) {
      bar._inkDelegateBound = true;
      bar.addEventListener("input", function (e) {
        const t = e.target;
        if (!t) return;
        if (t.id === "map-ink-color" || t.id === "map-ink-width") applyInkPrefFromControls();
      }, true);
      bar.addEventListener("change", function (e) {
        const t = e.target;
        if (!t) return;
        if (t.id === "map-ink-color" || t.id === "map-ink-width") applyInkPrefFromControls();
      }, true);
    }
  }

    function persistSession() {
    persistTimer = null;
    if (restoring) return;
    const mapMeta = state.mapRefUrl
      ? { name: state.mapRefName || "", kind: state.mapRefKind || null }
      : (state.mapRefMeta || null);
    saveCurrentMapInk();
    const payload = {
      v: 2,
      savedAt: Date.now(),
      sourceName: state.sourceName || "",
      idMode: state.idMode || "auto",
      forceMapRef: document.body.classList.contains("force-map-ref"),
      mapRef: mapMeta,
      trees: serializeTrees(),
      drawMapKey: state.drawMapKey || null,
      drawStrokes: serializeDrawStrokes(),
      drawStrokesByMap: serializeDrawStrokesByMap()
    };
    try {
      localStorage.setItem(LS_SESSION, JSON.stringify(payload));
    } catch (err) {
      console.warn("tp-pane autosave localStorage failed", err);
      try {
        // Last-resort: drop props extras and retry smaller payload
        payload.trees = payload.trees.map((t) => ({
          id: t.id,
          props: {
            "Tree ID": t.props["Tree ID"] || t.id,
            Species: t.props.Species || "",
            DBH: t.props.DBH || "",
            Height: t.props.Height || "",
            Spread: t.props.Spread || "",
            Remarks: t.props.Remarks || "",
            Defect: t.props.Defect || "",
            Location: t.props.Location || "",
            Latitude: t.props.Latitude,
            Longitude: t.props.Longitude
          },
          hasCoords: t.hasCoords,
          x: t.x,
          y: t.y,
          path: t.path || null,
          annot: t.annot,
          source: t.source,
          geometry: t.geometry
        }));
        localStorage.setItem(LS_SESSION, JSON.stringify(payload));
      } catch (err2) {
        console.warn("tp-pane autosave retry failed", err2);
      }
    }
  }

  function clearPersistedSession() {
    try { localStorage.removeItem(LS_SESSION); } catch (_) {}
    state.mapRefMeta = null;
    state.drawStrokes = [];
    state.drawStrokesByMap = {};
    state.drawMapKey = null;
  }

  function rebuildFeature(rec) {
    const props = Object.assign({}, rec.props || {});
    if (!props["Tree ID"]) props["Tree ID"] = rec.id;
    let geometry = rec.geometry || null;
    if (!geometry && rec.hasCoords && props.Latitude != null && props.Longitude != null &&
        isFinite(Number(props.Latitude)) && isFinite(Number(props.Longitude))) {
      geometry = {
        type: "Point",
        coordinates: [Number(props.Longitude), Number(props.Latitude)]
      };
    }
    return { type: "Feature", properties: props, geometry: geometry };
  }

  async function restoreSession() {
    if (/\bdemo=1\b/.test(location.search || "")) return;
    let raw = null;
    try { raw = localStorage.getItem(LS_SESSION); } catch (_) { return; }
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch (_) { return; }
    if (!data) return;
    const hasTrees = Array.isArray(data.trees) && data.trees.length;
    const hasDraw = Array.isArray(data.drawStrokes) && data.drawStrokes.length;
    const hasDrawBag = !!(data.drawStrokesByMap && typeof data.drawStrokesByMap === "object" &&
      Object.keys(data.drawStrokesByMap).some(function (k) {
        return Array.isArray(data.drawStrokesByMap[k]) && data.drawStrokesByMap[k].length;
      }));
    if (!hasTrees && !hasDraw && !hasDrawBag) return;

    restoring = true;
    try {
      state.sourceName = data.sourceName || "";
      if (data.idMode) setIdMode(data.idMode);
      state.mapRefMeta = data.mapRef || null;

      clearLeafletAnnotMarkers();
      state.drawStrokesByMap = {};
      if (data.drawStrokesByMap && typeof data.drawStrokesByMap === "object") {
        Object.keys(data.drawStrokesByMap).forEach(function (k) {
          const key = mapInkKey(k);
          if (!key) return;
          const list = data.drawStrokesByMap[k];
          if (!Array.isArray(list)) return;
          const strokes = list.map(normalizeStrokeRec).filter(Boolean);
          if (strokes.length) state.drawStrokesByMap[key] = strokes;
        });
      }
      const metaName = (data.mapRef && data.mapRef.name) || "";
      const preferKey = mapInkKey(data.drawMapKey || metaName);
      if (preferKey && state.drawStrokesByMap[preferKey]) {
        state.drawMapKey = preferKey;
        state.drawStrokes = (state.drawStrokesByMap[preferKey] || []).slice();
      } else if (hasDraw) {
        // Back-compat: single global list → attach to remembered map name if any
        state.drawStrokes = data.drawStrokes.map(normalizeStrokeRec).filter(Boolean);
        if (preferKey) {
          state.drawMapKey = preferKey;
          state.drawStrokesByMap[preferKey] = serializeDrawStrokes(state.drawStrokes);
        } else {
          state.drawMapKey = null;
        }
      } else {
        state.drawStrokes = [];
        state.drawMapKey = preferKey || null;
      }
      state.trees = hasTrees ? data.trees.map((rec) => {
        const feature = rebuildFeature(rec);
        const hasCoords = !!(feature.geometry && feature.geometry.type === "Point");
        return {
          id: String(rec.id),
          props: feature.properties,
          feature: feature,
          hasCoords: hasCoords,
          x: rec.x == null || rec.x === "" ? null : Number(rec.x),
          y: rec.y == null || rec.y === "" ? null : Number(rec.y),
          path: Array.isArray(rec.path) && rec.path.length ? rec.path.map(function (p) {
            return { x: Number(p.x), y: Number(p.y) };
          }).filter(function (p) { return isFinite(p.x) && isFinite(p.y); }) : null,
          annot: !!rec.annot,
          leafletMarker: null,
          source: rec.source || ""
        };
      }) : [];

      renderTreeList();
      renderAnnotOverlay();

      const importedMapped = state.trees.filter((t) => t.hasCoords && !t.annot);
      const annotMapped = state.trees.filter((t) => t.hasCoords && t.annot);

      if (importedMapped.length && window.GpkgViewer && typeof window.GpkgViewer.loadTreeFeatures === "function") {
        try {
          await window.GpkgViewer.loadTreeFeatures(
            importedMapped.map((t) => t.feature),
            state.sourceName || "restored"
          );
        } catch (err) {
          console.warn(err);
        }
      }
      annotMapped.forEach((t) => {
        t.leafletMarker = addLeafletAnnotMarker(t);
      });

      if (data.forceMapRef) document.body.classList.add("force-map-ref");
      else document.body.classList.remove("force-map-ref");
      updateMapRefVisibility();
      updateMapRestoreHint();

      // v84: do not spam status for expected map re-import after reload
      if (state.trees.length) {
        setImportStatus("已還原 " + state.trees.length + " 棵樹（本機自動儲存）", "ok");
      }
      if (state.trees.length) selectTreeFromList(state.trees[0].id);
    } finally {
      restoring = false;
    }
  }

  /** v84: no mid-screen「地圖無法自動還原」banner — re-import via topbar when needed. */
  function updateMapRestoreHint() {
    const el = $("map-restore-hint");
    if (el) {
      el.hidden = true;
      el.innerHTML = "";
    }
  }

  /* ========== v109: project backup / restore (.tp-pane.json) ========== */
  const PROJECT_PKG_VERSION = 1;
  const PROJECT_SHEET_MAX_BYTES = 6 * 1024 * 1024;
  const PROJECT_EMBED_SOFT_TOTAL = 28 * 1024 * 1024;
  const PROJECT_EMBED_HARD_TOTAL = 48 * 1024 * 1024;

  function base64ToBlob(b64, mime) {
    const bin = atob(String(b64 || ""));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime || "application/octet-stream" });
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error("FileReader failed")); };
      fr.readAsDataURL(blob);
    });
  }

  async function blobUrlToEmbed(url) {
    if (!url || String(url).indexOf("blob:") !== 0) return null;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const blob = await res.blob();
      if (!blob || !blob.size) return null;
      if (blob.size > PROJECT_SHEET_MAX_BYTES) {
        return { skipped: true, reason: "sheet-too-large", size: blob.size };
      }
      const dataUrl = await blobToDataUrl(blob);
      const parts = String(dataUrl || "").split(",");
      const header = parts[0] || "";
      const b64 = parts[1] || "";
      if (!b64) return null;
      const mimeMatch = header.match(/data:([^;]+)/);
      return {
        mime: (mimeMatch && mimeMatch[1]) || (blob.type || "image/png"),
        base64: b64,
        size: blob.size
      };
    } catch (err) {
      console.warn("blobUrlToEmbed", err);
      return null;
    }
  }

  function projectStampFilename() {
    const d = new Date();
    const p = function (n) { return String(n).padStart(2, "0"); };
    return "tp-pane-project-" +
      d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" +
      p(d.getHours()) + p(d.getMinutes()) + ".tp-pane.json";
  }

  async function buildProjectPackage() {
    saveCurrentMapInk();
    try { saveCurrentListPdfInk(); } catch (_) {}
    const notes = [];
    let embedTotal = 0;
    const sheetsOut = [];
    const sheets = state.mapSheets || [];
    for (let i = 0; i < sheets.length; i++) {
      const s = sheets[i];
      if (!s) continue;
      const rec = {
        id: String(s.id || ""),
        label: s.label || "",
        kind: s.kind || "original",
        sourceName: s.sourceName || "",
        page: (typeof s.page === "number") ? s.page : null,
        cropOf: s.cropOf ? {
          x: Number(s.cropOf.x), y: Number(s.cropOf.y),
          w: Number(s.cropOf.w), h: Number(s.cropOf.h)
        } : null,
        image: null
      };
      if (embedTotal >= PROJECT_EMBED_HARD_TOTAL) {
        notes.push("圖紙影像總量過大，其餘圖紙未嵌入：" + (s.label || s.id));
        sheetsOut.push(rec);
        continue;
      }
      const emb = await blobUrlToEmbed(s.url);
      if (emb && emb.skipped) {
        notes.push("圖紙「" + (s.label || s.id) + "」過大未嵌入（" +
          Math.round(emb.size / (1024 * 1024)) + " MB）");
      } else if (emb && emb.base64) {
        if (embedTotal + emb.size > PROJECT_EMBED_HARD_TOTAL) {
          notes.push("圖紙影像總量達上限，略過：「" + (s.label || s.id) + "」");
        } else {
          rec.image = { mime: emb.mime, base64: emb.base64 };
          embedTotal += emb.size;
          if (embedTotal >= PROJECT_EMBED_SOFT_TOTAL) {
            notes.push("圖紙影像總量較大（約 " + Math.round(embedTotal / (1024 * 1024)) + " MB）");
          }
        }
      } else if (s.url) {
        notes.push("無法嵌入圖紙影像：「" + (s.label || s.id) + "」");
      }
      sheetsOut.push(rec);
    }

    const mapMeta = state.mapRefUrl
      ? { name: state.mapRefName || "", kind: state.mapRefKind || null }
      : (state.mapRefMeta || null);

    let listPdfInk = {};
    try {
      // Prefer in-memory bag (includes current page)
      listPdfInk = listPdf.inkByKey || {};
      if (!listPdfInk || !Object.keys(listPdfInk).length) {
        const raw = localStorage.getItem(LS_LIST_PDF_INK);
        if (raw) listPdfInk = JSON.parse(raw) || {};
      }
    } catch (_) { listPdfInk = {}; }

    const pkg = {
      version: PROJECT_PKG_VERSION,
      exportedAt: new Date().toISOString(),
      app: "tp-pane",
      appVersion: 109,
      sourceName: state.sourceName || "",
      idMode: state.idMode || "auto",
      forceMapRef: document.body.classList.contains("force-map-ref"),
      mapRef: mapMeta,
      trees: serializeTrees(),
      drawMapKey: state.drawMapKey || null,
      drawStrokes: serializeDrawStrokes(),
      drawStrokesByMap: serializeDrawStrokesByMap(),
      activeMapSheetId: state.activeMapSheetId || null,
      mapSheets: sheetsOut,
      listPdfInk: listPdfInk,
      listPdfName: listPdf.name || "",
      notes: notes
    };
    return pkg;
  }

  async function exportProjectPackage() {
    setImportStatus("正在匯出專案…", "");
    try {
      const pkg = await buildProjectPackage();
      const hasTrees = Array.isArray(pkg.trees) && pkg.trees.length;
      const hasInk = pkg.drawStrokesByMap && Object.keys(pkg.drawStrokesByMap).length;
      const hasSheets = Array.isArray(pkg.mapSheets) && pkg.mapSheets.length;
      const hasListInk = pkg.listPdfInk && Object.keys(pkg.listPdfInk).length;
      if (!hasTrees && !hasInk && !hasSheets && !hasListInk) {
        setImportStatus("沒有可匯出的專案資料（樹木／圖紙／墨跡皆空）", "warn");
        return;
      }
      const json = JSON.stringify(pkg);
      const bytes = new Blob([json], { type: "application/json" }).size;
      if (bytes > PROJECT_EMBED_HARD_TOTAL * 1.35) {
        const okHuge = confirm(
          "專案檔約 " + Math.round(bytes / (1024 * 1024)) +
          " MB，下載可能較慢或失敗。仍要匯出？"
        );
        if (!okHuge) {
          setImportStatus("已取消匯出", "warn");
          return;
        }
      }
      const filename = projectStampFilename();
      const blob = new Blob([json], { type: "application/json" });
      const shared = tryShareFile(blob, filename);
      if (shared && typeof shared.then === "function") {
        shared.then(function () {
          setImportStatus("已分享專案：" + filename, "ok");
        }).catch(function () {
          triggerBlobDownload(blob, filename);
          finishExportStatus(pkg, filename);
        });
        return;
      }
      triggerBlobDownload(blob, filename);
      finishExportStatus(pkg, filename);
    } catch (err) {
      console.error(err);
      setImportStatus("匯出專案失敗：" + (err && err.message ? err.message : err), "error");
    }
  }

  function finishExportStatus(pkg, filename) {
    const nTrees = (pkg.trees && pkg.trees.length) || 0;
    const nSheets = (pkg.mapSheets && pkg.mapSheets.length) || 0;
    const nEmbed = (pkg.mapSheets || []).filter(function (s) { return s && s.image && s.image.base64; }).length;
    let msg = "已匯出專案 " + filename + "（" + nTrees + " 棵樹 · " + nEmbed + "/" + nSheets + " 圖紙影像）";
    if (pkg.notes && pkg.notes.length) msg += " · 注意：" + pkg.notes[0];
    setImportStatus(msg, "ok");
  }

  function applyListPdfInkFromPackage(bag) {
    const out = {};
    if (bag && typeof bag === "object") {
      Object.keys(bag).forEach(function (k) {
        if (!Array.isArray(bag[k])) return;
        const strokes = bag[k].map(normalizeListStroke).filter(Boolean);
        if (strokes.length) out[k] = strokes;
      });
    }
    listPdf.inkByKey = out;
    try {
      localStorage.setItem(LS_LIST_PDF_INK, JSON.stringify(out));
    } catch (_) {}
    if (listPdf.url) {
      loadListPdfInkForCurrent();
    }
  }

  async function applyImportedMapSheets(sheetsPayload, activeId, mapMeta) {
    const list = Array.isArray(sheetsPayload) ? sheetsPayload : [];
    // Clear existing map view without wiping ink bag (caller already set ink)
    if (state.cropMode) {
      try { exitCropMode(); } catch (e) { state.cropMode = false; }
    }
    revokeMapRefUrl();
    hideMapRefViewers();
    resetMapRefZoom();

    const rebuilt = [];
    let embedOk = 0;
    let embedFail = 0;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || !s.id) continue;
      let url = null;
      if (s.image && s.image.base64) {
        try {
          const blob = base64ToBlob(s.image.base64, s.image.mime || "image/png");
          url = rememberUrl(URL.createObjectURL(blob));
          embedOk += 1;
        } catch (err) {
          console.warn("sheet base64 restore failed", err);
          embedFail += 1;
        }
      } else {
        embedFail += 1;
      }
      rebuilt.push({
        id: String(s.id),
        label: s.label || String(s.id),
        kind: s.kind || "original",
        sourceName: s.sourceName || (mapMeta && mapMeta.name) || "",
        page: (typeof s.page === "number") ? s.page : undefined,
        cropOf: s.cropOf || null,
        url: url
      });
    }

    // Keep sheets even without url so ink keys remain meaningful; display needs url
    state.mapSheets = rebuilt.filter(function (s) { return !!s.url; });
    const name = (mapMeta && mapMeta.name) || (state.mapSheets[0] && state.mapSheets[0].sourceName) || "";
    state.mapRefName = name;
    state.mapRefMeta = mapMeta ? { name: mapMeta.name || name, kind: mapMeta.kind || "image" } : (name ? { name: name, kind: "image" } : null);
    state.mapRefKind = "image";
    state.mapRefRasterized = state.mapSheets.length > 0;

    let active = null;
    if (activeId) {
      for (let i = 0; i < state.mapSheets.length; i++) {
        if (state.mapSheets[i].id === activeId) { active = state.mapSheets[i]; break; }
      }
    }
    if (!active) active = state.mapSheets[0] || null;
    if (active) {
      state.activeMapSheetId = active.id;
      state.mapRefUrl = active.url;
      state.mapRefRasterUrl = active.url;
      loadMapInk(active.id);
      showSheetOnImg(active);
      document.body.classList.add("force-map-ref");
    } else {
      state.activeMapSheetId = null;
      state.mapRefUrl = null;
      state.mapRefRasterUrl = null;
      document.body.classList.remove("force-map-ref");
    }
    renderMapSheetTabs();
    updateMapRefVisibility();
    ensureAnnotLayerObserver();
    applyMapRefZoom();
    renderAnnotOverlay();
    updateMapRestoreHint();
    return { embedOk: embedOk, embedFail: embedFail, sheetCount: state.mapSheets.length };
  }

  async function importProjectPackage(file) {
    if (!file) return;
    setImportStatus("正在讀取專案…", "");
    let text;
    try {
      text = await file.text();
    } catch (err) {
      setImportStatus("無法讀取專案檔：" + (err && err.message ? err.message : err), "error");
      return;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      setImportStatus("專案檔不是有效的 JSON", "error");
      return;
    }
    if (!data || typeof data !== "object") {
      setImportStatus("專案檔內容無效", "error");
      return;
    }
    if (data.app && data.app !== "tp-pane") {
      setImportStatus("此檔案不是 tp-pane 專案備份（app=" + data.app + "）", "error");
      return;
    }
    const hasTrees = Array.isArray(data.trees) && data.trees.length;
    const hasDrawBag = !!(data.drawStrokesByMap && typeof data.drawStrokesByMap === "object" &&
      Object.keys(data.drawStrokesByMap).some(function (k) {
        return Array.isArray(data.drawStrokesByMap[k]) && data.drawStrokesByMap[k].length;
      }));
    const hasDraw = Array.isArray(data.drawStrokes) && data.drawStrokes.length;
    const hasSheets = Array.isArray(data.mapSheets) && data.mapSheets.length;
    const hasListInk = !!(data.listPdfInk && typeof data.listPdfInk === "object" &&
      Object.keys(data.listPdfInk).length);
    if (!hasTrees && !hasDraw && !hasDrawBag && !hasSheets && !hasListInk) {
      setImportStatus("專案檔沒有可還原的資料", "warn");
      return;
    }
    if (state.trees && state.trees.length) {
      const ok = confirm("目前已有樹木資料，匯入專案會覆寫現有列表／圖註／圖紙。確定繼續？");
      if (!ok) {
        setImportStatus("已取消匯入專案", "warn");
        return;
      }
    }

    restoring = true;
    try {
      // Trees + ink first (mirrors restoreSession)
      state.sourceName = data.sourceName || "";
      if (data.idMode) setIdMode(data.idMode);

      clearLeafletAnnotMarkers();
      state.drawStrokesByMap = {};
      if (data.drawStrokesByMap && typeof data.drawStrokesByMap === "object") {
        Object.keys(data.drawStrokesByMap).forEach(function (k) {
          const key = mapInkKey(k) || String(k);
          if (!key) return;
          const list = data.drawStrokesByMap[k];
          if (!Array.isArray(list)) return;
          const strokes = list.map(normalizeStrokeRec).filter(Boolean);
          if (strokes.length) state.drawStrokesByMap[key] = strokes;
        });
      }
      const metaName = (data.mapRef && data.mapRef.name) || "";
      const preferKey = mapInkKey(data.drawMapKey || metaName) || (data.drawMapKey ? String(data.drawMapKey) : "");
      if (preferKey && state.drawStrokesByMap[preferKey]) {
        state.drawMapKey = preferKey;
        state.drawStrokes = (state.drawStrokesByMap[preferKey] || []).slice();
      } else if (hasDraw) {
        state.drawStrokes = data.drawStrokes.map(normalizeStrokeRec).filter(Boolean);
        if (preferKey) {
          state.drawMapKey = preferKey;
          state.drawStrokesByMap[preferKey] = serializeDrawStrokes(state.drawStrokes);
        } else {
          state.drawMapKey = null;
        }
      } else {
        state.drawStrokes = [];
        state.drawMapKey = preferKey || null;
      }

      state.trees = hasTrees ? data.trees.map(function (rec) {
        const feature = rebuildFeature(rec);
        const hasCoords = !!(feature.geometry && feature.geometry.type === "Point");
        return {
          id: String(rec.id),
          props: feature.properties,
          feature: feature,
          hasCoords: hasCoords,
          x: rec.x == null || rec.x === "" ? null : Number(rec.x),
          y: rec.y == null || rec.y === "" ? null : Number(rec.y),
          path: Array.isArray(rec.path) && rec.path.length ? rec.path.map(function (p) {
            return { x: Number(p.x), y: Number(p.y) };
          }).filter(function (p) { return isFinite(p.x) && isFinite(p.y); }) : null,
          annot: !!rec.annot,
          leafletMarker: null,
          source: rec.source || ""
        };
      }) : [];

      renderTreeList();
      renderAnnotOverlay();

      const importedMapped = state.trees.filter(function (t) { return t.hasCoords && !t.annot; });
      const annotMapped = state.trees.filter(function (t) { return t.hasCoords && t.annot; });
      if (importedMapped.length && window.GpkgViewer && typeof window.GpkgViewer.loadTreeFeatures === "function") {
        try {
          await window.GpkgViewer.loadTreeFeatures(
            importedMapped.map(function (t) { return t.feature; }),
            state.sourceName || "project-import"
          );
        } catch (err) {
          console.warn(err);
        }
      }
      annotMapped.forEach(function (t) {
        t.leafletMarker = addLeafletAnnotMarker(t);
      });

      if (data.forceMapRef) document.body.classList.add("force-map-ref");
      else document.body.classList.remove("force-map-ref");

      const mapResult = await applyImportedMapSheets(
        data.mapSheets || [],
        data.activeMapSheetId || null,
        data.mapRef || null
      );

      applyListPdfInkFromPackage(data.listPdfInk || {});

      const needListPdf = !!(hasListInk || data.listPdfName) && !listPdf.url;
      const needMapFile = !!(data.mapRef && data.mapRef.name) && !(mapResult && mapResult.sheetCount);
      const parts = [];
      parts.push("已匯入專案：" + state.trees.length + " 棵樹");
      if (mapResult && mapResult.sheetCount) {
        parts.push(mapResult.sheetCount + " 張圖紙");
      }
      if (needMapFile) {
        parts.push("地圖原檔「" + data.mapRef.name + "」需重新匯入（圖紙影像未包含於備份）");
      } else if (mapResult && mapResult.embedFail && !mapResult.embedOk && hasSheets) {
        parts.push("圖紙影像未能還原，請重新匯入地圖 PDF／圖片");
      }
      if (needListPdf) {
        const nm = data.listPdfName ? "「" + data.listPdfName + "」" : "";
        parts.push("列表 PDF 原檔" + nm + "需重新匯入（墨跡已保留）");
      }
      const kind = (needListPdf || needMapFile) ? "warn" : "ok";
      setImportStatus(parts.join(" · "), kind);
      if (state.trees.length) selectTreeFromList(state.trees[0].id);
      closeMobileMenuAfterContent();
    } catch (err) {
      console.error(err);
      setImportStatus("匯入專案失敗：" + (err && err.message ? err.message : err), "error");
    } finally {
      restoring = false;
      // Must persist after restoring=false — persistSession no-ops while restoring
      try { persistSession(); } catch (_) {}
    }
  }

  function bindProjectBackupUi() {
    function bindExport(btn) {
      if (!btn || btn._projectExportBound) return;
      btn._projectExportBound = true;
      btn.addEventListener("click", function (ev) {
        if (ev) { ev.preventDefault(); ev.stopPropagation(); }
        exportProjectPackage();
      });
    }
    function bindImportInput(input) {
      if (!input || input._projectImportBound) return;
      input._projectImportBound = true;
      input.addEventListener("change", function () {
        const f = input.files && input.files[0];
        input.value = "";
        if (!f) return;
        const name = (f.name || "").toLowerCase();
        const t = (f.type || "").toLowerCase();
        const looksJson = /\.json$/i.test(name) || t.indexOf("json") >= 0;
        if (!looksJson) {
          setImportStatus("請選擇 .tp-pane.json 或 .json 專案檔（目前：" + (f.name || "未知類型") + "）", "warn");
          return;
        }
        importProjectPackage(f).catch(function (err) {
          console.error(err);
          setImportStatus("匯入專案失敗：" + (err && err.message ? err.message : err), "error");
        });
      });
    }
    bindExport($("btn-export-project"));
    bindExport($("btn-export-project-side"));
    bindImportInput($("project-file-input"));
    bindImportInput($("project-file-input-side"));
  }


  function applyHideMedia(hide) {
    hide = !!hide;
    document.body.classList.toggle("hide-media", hide);
    const btn = $("btn-toggle-media");
    if (btn) {
      btn.textContent = hide ? "顯示媒體" : "隱藏媒體";
      btn.setAttribute("aria-pressed", hide ? "true" : "false");
      btn.title = hide ? "顯示樹木 PDF（右側）" : "隱藏樹木 PDF（地圖可擴展）";
    }
    try { localStorage.setItem(LS_HIDE_MEDIA, hide ? "1" : "0"); } catch (_) {}
    // Map invalidate + media PDF canvas reflow (shared helper defined below / used after init)
    if (typeof reflowAfterLayoutToggle === "function") {
      reflowAfterLayoutToggle();
    } else if (window.GpkgViewer && window.GpkgViewer.invalidateMap) {
      setTimeout(() => window.GpkgViewer.invalidateMap(), 60);
    }
  }

  function initHideMediaToggle() {
    let hide = false;
    try { hide = localStorage.getItem(LS_HIDE_MEDIA) === "1"; } catch (_) {}
    applyHideMedia(hide);
    const btn = $("btn-toggle-media");
    if (btn && !btn._hideBound) {
      btn._hideBound = true;
      btn.addEventListener("click", () => {
        applyHideMedia(!document.body.classList.contains("hide-media"));
      });
    }
  }

  function reflowAfterLayoutToggle() {
    if (window.GpkgViewer && window.GpkgViewer.invalidateMap) {
      setTimeout(function () { window.GpkgViewer.invalidateMap(); }, 60);
    }
    function kickMedia() {
      if (window.GpkgMedia && typeof window.GpkgMedia.reflowLayout === "function") {
        window.GpkgMedia.reflowLayout();
      } else {
        try { window.dispatchEvent(new Event("resize")); } catch (_) {}
      }
    }
    setTimeout(kickMedia, 80);
    setTimeout(kickMedia, 220);
  }

  function applyHideMap(hide) {
    hide = !!hide;
    document.body.classList.toggle("hide-map", hide);
    const btn = $("btn-toggle-map");
    if (btn) {
      btn.textContent = hide ? "顯示地圖" : "隱藏地圖";
      btn.setAttribute("aria-pressed", hide ? "true" : "false");
      btn.title = hide ? "顯示地圖（左側）" : "隱藏地圖（樹木 PDF 可擴展）";
    }
    try { localStorage.setItem(LS_HIDE_MAP, hide ? "1" : "0"); } catch (_) {}
    reflowAfterLayoutToggle();
  }

  function initHideMapToggle() {
    let hide = false;
    try { hide = localStorage.getItem(LS_HIDE_MAP) === "1"; } catch (_) {}
    applyHideMap(hide);
    const btn = $("btn-toggle-map");
    if (btn && !btn._hideBound) {
      btn._hideBound = true;
      btn.addEventListener("click", () => {
        applyHideMap(!document.body.classList.contains("hide-map"));
      });
    }
  }

  function applyHideTrees(hide) {
    hide = !!hide;
    document.body.classList.toggle("hide-trees", hide);
    const btn = $("btn-toggle-trees");
    if (btn) {
      btn.textContent = hide ? "顯示列表" : "隱藏列表";
      btn.setAttribute("aria-pressed", hide ? "true" : "false");
      btn.title = hide ? "顯示樹木列表（底部）" : "隱藏樹木列表（地圖可擴展佔滿列表空間）";
    }
    try { localStorage.setItem(LS_HIDE_TREES, hide ? "1" : "0"); } catch (_) {}
    reflowAfterLayoutToggle();
  }

  function initHideTreesToggle() {
    let hide = false;
    try { hide = localStorage.getItem(LS_HIDE_TREES) === "1"; } catch (_) {}
    applyHideTrees(hide);
    const btn = $("btn-toggle-trees");
    if (btn && !btn._hideBound) {
      btn._hideBound = true;
      btn.addEventListener("click", () => {
        applyHideTrees(!document.body.classList.contains("hide-trees"));
      });
    }
  }

  /** v104: list-panel PDF viewer state (independent of media panel). */
  const listPdf = {
    url: null,
    name: "",
    file: null,
    doc: null,
    page: 1,
    pageCount: 1,
    zoom: 1,
    renderToken: 0,
    renderTask: null,
    renderTimer: null,
    pdfjsReady: false,
    inkByKey: {},
    inkStrokes: [],
    inkKey: null,
    inkDrawing: false,
    objectUrls: []
  };

  function resolveListPdfWorkerSrc() {
    const base = (document.querySelector('script[src*="pdf.min.js"]') || {}).src || "";
    let src = base
      ? String(base).replace(/pdf\.min\.js(\?.*)?$/i, "pdf.worker.min.js$1")
      : "vendor/pdf.worker.min.js?v=111";
    try { return new URL(src, location.href).href; } catch (_) { return src; }
  }

  function ensureListPdfjs() {
    const lib = (typeof window !== "undefined" && window.pdfjsLib) ? window.pdfjsLib : null;
    if (!lib) return null;
    if (!listPdf.pdfjsReady) {
      try {
        lib.GlobalWorkerOptions.workerSrc = resolveListPdfWorkerSrc();
        listPdf.pdfjsReady = true;
      } catch (e) {
        console.warn("list pdf.js worker config failed", e);
      }
    }
    try { ensurePdfWorkerViaShared(lib); } catch (_) {}
    return lib;
  }

  function ensurePdfWorkerViaShared(lib) {
    if (!lib) return Promise.resolve(null);
    // Prefer media.js helper if already installed on GlobalWorker via prior call
    if (!window.TpPanePdfWorker) {
      window.TpPanePdfWorker = { promise: null, blobUrl: null, fallback: null };
    }
    const slot = window.TpPanePdfWorker;
    if (slot.blobUrl) {
      try { lib.GlobalWorkerOptions.workerSrc = slot.blobUrl; } catch (_) {}
      return Promise.resolve(slot.blobUrl);
    }
    if (slot.promise) return slot.promise;
    const fallback = resolveListPdfWorkerSrc();
    slot.fallback = fallback;
    try { lib.GlobalWorkerOptions.workerSrc = fallback; } catch (_) {}
    slot.promise = (async function () {
      try {
        const res = await fetch(fallback);
        if (!res.ok) throw new Error("pdf.worker fetch " + res.status);
        const buf = await res.arrayBuffer();
        const blob = new Blob([buf], { type: "application/javascript" });
        const blobUrl = URL.createObjectURL(blob);
        slot.blobUrl = blobUrl;
        lib.GlobalWorkerOptions.workerSrc = blobUrl;
        return blobUrl;
      } catch (err) {
        console.warn("pdf worker blob setup failed; using same-origin URL", err);
        try { lib.GlobalWorkerOptions.workerSrc = fallback; } catch (_) {}
        return fallback;
      }
    })();
    return slot.promise;
  }

  async function ensureListPdfjsReady() {
    const lib = ensureListPdfjs();
    if (!lib) return null;
    await ensurePdfWorkerViaShared(lib);
    return lib;
  }

  function listPdfInkKey(page) {
    const name = (listPdf.name || "").trim().toLowerCase() || "list-pdf";
    const pg = page || listPdf.page || 1;
    return name + "::" + pg;
  }

  /** Same prefs as map annotate — always read live #map-ink-color / #map-ink-width. */
  function listInkPrefs() {
    return currentInkPrefs();
  }

  function parkMapInkCtrlsForListPdf(on) {
    const ctrls = $("map-ink-ctrls");
    const host = $("tree-list-pdf-ink-host");
    const home = $("map-ref-actions");
    if (!ctrls) return;
    if (on) {
      if (host && ctrls.parentNode !== host) host.appendChild(ctrls);
      ctrls.classList.add("on-list-pdf");
    } else {
      // Restore beside map-ref actions (before crop button if present)
      if (home && ctrls.parentNode !== home) {
        const crop = $("btn-map-crop");
        if (crop && crop.parentNode === home) home.insertBefore(ctrls, crop);
        else home.insertBefore(ctrls, home.firstChild);
      }
      ctrls.classList.remove("on-list-pdf");
    }
    syncInkControlsUi();
  }

  function normalizeListStroke(s) {
    if (!s || !Array.isArray(s.path) || !s.path.length) return null;
    const pts = s.path.map(function (p) {
      return { x: Number(p.x), y: Number(p.y) };
    }).filter(function (p) { return isFinite(p.x) && isFinite(p.y); });
    if (pts.length < 2) return null;
    const out = { path: pts };
    if (s.color) out.color = String(s.color);
    const w = Number(s.width);
    if (isFinite(w) && w > 0) out.width = w;
    return out;
  }

  function simplifyListPath(pts) {
    if (!pts || pts.length < 3) return pts ? pts.slice() : null;
    const out = [pts[0]];
    const EPS = 0.12;
    for (let i = 1; i < pts.length - 1; i++) {
      const a = out[out.length - 1];
      const b = pts[i];
      if (Math.hypot(b.x - a.x, b.y - a.y) >= EPS) out.push(b);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  function pathToListSvgD(pts) {
    if (!pts || !pts.length) return "";
    let d = "M " + Number(pts[0].x).toFixed(3) + " " + Number(pts[0].y).toFixed(3);
    for (let i = 1; i < pts.length; i++) {
      d += " L " + Number(pts[i].x).toFixed(3) + " " + Number(pts[i].y).toFixed(3);
    }
    return d;
  }

  function saveListPdfInkBag() {
    try {
      const bag = listPdf.inkByKey || {};
      let keep = Object.keys(bag);
      if (keep.length > LIST_PDF_INK_MAX_KEYS) keep = keep.slice(-LIST_PDF_INK_MAX_KEYS);
      const out = {};
      let total = 0;
      keep.forEach(function (k) {
        const list = (bag[k] || []).map(normalizeListStroke).filter(Boolean);
        if (!list.length) return;
        const capped = list.slice(-Math.max(16, Math.floor(LIST_PDF_INK_MAX_STROKES / Math.max(1, keep.length))));
        out[k] = capped;
        total += capped.length;
      });
      if (total > LIST_PDF_INK_MAX_STROKES) {
        const kk = Object.keys(out);
        while (total > LIST_PDF_INK_MAX_STROKES && kk.length) {
          const k0 = kk.shift();
          const drop = Math.min(out[k0].length, total - LIST_PDF_INK_MAX_STROKES);
          out[k0] = out[k0].slice(drop);
          total -= drop;
          if (!out[k0].length) delete out[k0];
        }
      }
      localStorage.setItem(LS_LIST_PDF_INK, JSON.stringify(out));
    } catch (_) {}
  }

  function loadListPdfInkBag() {
    try {
      const raw = localStorage.getItem(LS_LIST_PDF_INK);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") return;
      const bag = {};
      Object.keys(data).forEach(function (k) {
        if (!Array.isArray(data[k])) return;
        const strokes = data[k].map(normalizeListStroke).filter(Boolean);
        if (strokes.length) bag[k] = strokes;
      });
      listPdf.inkByKey = bag;
    } catch (_) {}
  }

  function saveCurrentListPdfInk() {
    const key = listPdf.inkKey;
    if (!key) return;
    listPdf.inkByKey = listPdf.inkByKey || {};
    listPdf.inkByKey[key] = (listPdf.inkStrokes || []).map(normalizeListStroke).filter(Boolean);
    saveListPdfInkBag();
  }

  function loadListPdfInkForCurrent() {
    const key = listPdfInkKey(listPdf.page || 1);
    if (listPdf.inkKey && listPdf.inkKey !== key) saveCurrentListPdfInk();
    listPdf.inkKey = key;
    const bag = listPdf.inkByKey || {};
    listPdf.inkStrokes = (Array.isArray(bag[key]) ? bag[key] : []).map(normalizeListStroke).filter(Boolean);
    renderListPdfInkOverlay();
  }

  function ensureListPdfInkLayer() {
    const stage = $("tree-list-pdf-stage");
    if (!stage) return null;
    let layer = $("tree-list-pdf-ink-layer");
    if (!layer) {
      layer = document.createElement("div");
      layer.id = "tree-list-pdf-ink-layer";
      layer.className = "tree-list-pdf-ink-layer";
      layer.setAttribute("aria-hidden", "true");
      stage.appendChild(layer);
    }
    return layer;
  }

  function renderListPdfInkOverlay() {
    const layer = ensureListPdfInkLayer();
    if (!layer) return;
    let paths = "";
    (listPdf.inkStrokes || []).forEach(function (s) {
      if (!s || !s.path || s.path.length < 2) return;
      const col = (s.color && String(s.color)) || "#38bdf8";
      const w = (isFinite(Number(s.width)) && Number(s.width) > 0) ? Number(s.width) : 2.25;
      paths += '<path class="list-draw-ink" d="' + pathToListSvgD(s.path) +
        '" fill="none" stroke="' + col.replace(/"/g, "") + '" stroke-width="' + w +
        '" style="stroke:' + col.replace(/"/g, "") + ';stroke-width:' + w +
        '" vector-effect="non-scaling-stroke"></path>';
    });
    layer.innerHTML =
      '<svg class="list-pdf-ink-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">' +
      paths +
      '<path class="list-ink-preview" hidden fill="none" vector-effect="non-scaling-stroke"></path>' +
      "</svg>";
  }

  function pctFromListPdfStage(clientX, clientY) {
    const stage = $("tree-list-pdf-stage");
    if (!stage) return null;
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)),
      y: Math.max(0, Math.min(100, ((clientY - r.top) / r.height) * 100))
    };
  }

  function updateListPdfZoomLabel() {
    const readout = $("tree-list-pdf-zoom-level");
    const s = listPdf.zoom || 1;
    if (readout) {
      readout.textContent = (Math.round(s * 10) / 10) + "×";
      readout.hidden = s <= 1.01;
    }
    const scroll = $("tree-list-pdf-scroll");
    if (scroll) scroll.classList.toggle("is-zoomed", s > 1.01);
  }

  function updateListPdfPageLabel() {
    const sel = $("tree-list-pdf-page");
    const total = listPdf.pageCount || 1;
    const cur = listPdf.page || 1;
    if (sel) {
      const opts = [];
      for (let i = 1; i <= total; i++) {
        opts.push('<option value="' + i + '"' + (i === cur ? " selected" : "") +
          ">第 " + i + " / " + total + " 頁</option>");
      }
      sel.innerHTML = opts.join("");
      sel.value = String(cur);
      sel.disabled = !listPdf.url;
      sel.title = "選擇頁碼（目前第 " + cur + " 頁）";
    }
    const title = $("tree-list-pdf-title");
    if (title) title.textContent = listPdf.name ? ("列表 PDF · " + listPdf.name) : "列表 PDF";
  }

  function setListPdfPaneVisible(on) {
    const pane = $("tree-list-pdf-pane");
    const panel = $("tree-list-panel");
    document.body.classList.toggle("has-tree-list-pdf", !!on);
    if (pane) pane.hidden = !on;
    if (on) {
      // Ensure bottom list panel is visible so PDF can be seen (even with empty table)
      document.body.classList.add("has-tree-list");
      if (panel) panel.hidden = false;
      parkMapInkCtrlsForListPdf(true);
    } else {
      parkMapInkCtrlsForListPdf(false);
      if (!state.trees.length) {
        document.body.classList.remove("has-tree-list");
        if (panel) panel.hidden = true;
      }
    }
    reflowAfterLayoutToggle();
  }

  function isListPdfRenderCancelled(err) {
    if (!err) return false;
    const name = err.name || "";
    const msg = String(err.message || err || "");
    return name === "RenderingCancelledException" ||
      /RenderingCancelled/i.test(msg) ||
      /cancel(led)?/i.test(msg);
  }

  async function cancelListPdfRender() {
    const prev = listPdf.renderTask;
    listPdf.renderTask = null;
    if (!prev) return;
    try { prev.cancel(); } catch (e) { /* ignore */ }
    try { await prev.promise; } catch (e) { /* ignore cancel */ }
  }

  async function getListPdfDocument() {
    if (listPdf.doc) return listPdf.doc;
    const lib = await ensureListPdfjsReady();
    if (!lib) return null;
    let data = null;
    if (listPdf.file && typeof listPdf.file.arrayBuffer === "function") {
      data = new Uint8Array(await listPdf.file.arrayBuffer());
    } else if (listPdf.url) {
      const res = await fetch(listPdf.url);
      if (!res.ok) throw new Error("無法讀取 PDF");
      data = new Uint8Array(await res.arrayBuffer());
    } else {
      throw new Error("沒有 PDF 資料");
    }
    const task = lib.getDocument({ data: data });
    const doc = await task.promise;
    listPdf.doc = doc;
    if (doc && doc.numPages) listPdf.pageCount = doc.numPages;
    return doc;
  }

  async function renderListPdfCanvas() {
    const canvas = $("tree-list-pdf-canvas");
    const scroll = $("tree-list-pdf-scroll");
    const stage = $("tree-list-pdf-stage");
    if (!canvas || !listPdf.url) return;
    const token = ++listPdf.renderToken;
    const pageNum = listPdf.page || 1;
    const lib = ensureListPdfjs();
    if (!lib) {
      setImportStatus("缺少 pdf.js — 無法顯示列表 PDF", "warn");
      return;
    }
    await cancelListPdfRender();
    if (token !== listPdf.renderToken) return;
    try {
      const doc = await getListPdfDocument();
      if (token !== listPdf.renderToken) return;
      if (!doc) throw new Error("無法載入 PDF");
      if (doc.numPages) listPdf.pageCount = doc.numPages;
      const page = await doc.getPage(pageNum);
      if (token !== listPdf.renderToken) return;
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
      const baseW = (scroll && scroll.clientWidth) ? Math.max(120, scroll.clientWidth - 4) : 280;
      const rotate = (typeof page.rotate === "number") ? page.rotate : 0;
      const unscaled = page.getViewport({ scale: 1, rotation: rotate });
      const fitScale = baseW / unscaled.width;
      const displayScale = fitScale * (listPdf.zoom || 1);
      const viewport = page.getViewport({ scale: displayScale * dpr, rotation: rotate });
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
      }
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("canvas 2d unavailable");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (token !== listPdf.renderToken) return;
      const task = page.render({ canvasContext: ctx, viewport: viewport });
      listPdf.renderTask = task;
      try {
        await task.promise;
      } finally {
        if (listPdf.renderTask === task) listPdf.renderTask = null;
      }
      if (token !== listPdf.renderToken) return;
      updateListPdfPageLabel();
      updateListPdfZoomLabel();
      loadListPdfInkForCurrent();
    } catch (err) {
      if (token !== listPdf.renderToken) return;
      if (isListPdfRenderCancelled(err)) return;
      console.warn("list pdf canvas render failed", err);
      setImportStatus("列表 PDF 繪製失敗：" + (err && err.message ? err.message : String(err)), "error");
    }
  }

  function applyListPdfZoom() {
    updateListPdfZoomLabel();
    if (listPdf.renderTimer) {
      clearTimeout(listPdf.renderTimer);
      listPdf.renderTimer = null;
    }
    listPdf.renderTimer = setTimeout(function () {
      listPdf.renderTimer = null;
      renderListPdfCanvas();
    }, 60);
  }

  function jumpListPdfPage(n) {
    const total = listPdf.pageCount || 1;
    const next = Math.max(1, Math.min(total, Number(n) || 1));
    if (next === listPdf.page) return;
    saveCurrentListPdfInk();
    listPdf.page = next;
    listPdf.zoom = 1;
    updateListPdfPageLabel();
    applyListPdfZoom();
  }

  function stepListPdfPage(dir) {
    jumpListPdfPage((listPdf.page || 1) + (dir || 0));
  }

  function clearListPdfInkCurrent() {
    listPdf.inkStrokes = [];
    if (listPdf.inkKey) {
      listPdf.inkByKey = listPdf.inkByKey || {};
      delete listPdf.inkByKey[listPdf.inkKey];
      saveListPdfInkBag();
    }
    renderListPdfInkOverlay();
    setImportStatus("已清除本頁列表 PDF 墨跡", "ok");
  }

  function closeListPdf() {
    saveCurrentListPdfInk();
    cancelListPdfRender();
    if (listPdf.doc) {
      try { listPdf.doc.destroy(); } catch (_) {}
      listPdf.doc = null;
    }
    (listPdf.objectUrls || []).forEach(function (u) {
      try { URL.revokeObjectURL(u); } catch (_) {}
    });
    listPdf.objectUrls = [];
    listPdf.url = null;
    listPdf.name = "";
    listPdf.file = null;
    listPdf.page = 1;
    listPdf.pageCount = 1;
    listPdf.zoom = 1;
    listPdf.inkKey = null;
    listPdf.inkStrokes = [];
    listPdf.inkDrawing = false;
    const canvas = $("tree-list-pdf-canvas");
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
      canvas.width = 0;
      canvas.height = 0;
    }
    renderListPdfInkOverlay();
    setListPdfPaneVisible(false);
    updateListPdfPageLabel();
    setImportStatus("已關閉列表 PDF", "ok");
  }

  function openListPdfFile(file) {
    if (!file) return;
    const name = file.name || "document.pdf";
    if (!/\.pdf$/i.test(name) && file.type !== "application/pdf") {
      setImportStatus("請選擇 PDF 檔", "warn");
      return;
    }
    saveCurrentListPdfInk();
    cancelListPdfRender();
    if (listPdf.doc) {
      try { listPdf.doc.destroy(); } catch (_) {}
      listPdf.doc = null;
    }
    (listPdf.objectUrls || []).forEach(function (u) {
      try { URL.revokeObjectURL(u); } catch (_) {}
    });
    const url = URL.createObjectURL(file);
    listPdf.objectUrls = [url];
    listPdf.url = url;
    listPdf.name = name;
    listPdf.file = file;
    listPdf.page = 1;
    listPdf.pageCount = 1;
    listPdf.zoom = 1;
    listPdf.inkKey = null;
    listPdf.inkStrokes = [];
    setListPdfPaneVisible(true);
    updateListPdfPageLabel();
    // Double rAF so split layout has width before measuring
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        renderListPdfCanvas();
      });
    });
    setImportStatus("已在列表內開啟 PDF（Pencil 可手寫；不會送到媒體面板）", "ok");
  }

  function bindListPdfInkGestures() {
    const scroll = $("tree-list-pdf-scroll");
    if (!scroll || scroll._listPdfInkBound) return;
    scroll._listPdfInkBound = true;
    let gesture = null;

    function showPreview(pts, color, width) {
      const layer = ensureListPdfInkLayer();
      if (!layer) return;
      const prev = layer.querySelector(".list-ink-preview");
      if (!prev) return;
      if (!pts || pts.length < 1) {
        prev.setAttribute("hidden", "");
        return;
      }
      prev.removeAttribute("hidden");
      prev.setAttribute("d", pathToListSvgD(pts));
      prev.setAttribute("stroke", color || "#38bdf8");
      prev.setAttribute("stroke-width", String(width || 2.25));
      prev.style.stroke = color || "#38bdf8";
      prev.style.strokeWidth = String(width || 2.25);
    }

    function clearPreview() {
      const layer = ensureListPdfInkLayer();
      if (!layer) return;
      const prev = layer.querySelector(".list-ink-preview");
      if (prev) {
        prev.setAttribute("hidden", "");
        prev.removeAttribute("d");
      }
    }

    scroll.addEventListener("touchstart", function (e) {
      if (!e.touches || !e.touches.length) return;
      let stylus = false;
      for (let i = 0; i < e.touches.length; i++) {
        const tt = e.touches[i].touchType;
        if (tt === "stylus" || tt === "pen") { stylus = true; break; }
      }
      if (!stylus) return;
      e.preventDefault();
      e.stopPropagation();
    }, { passive: false, capture: true });

    scroll.addEventListener("pointerdown", function (e) {
      if (!$("tree-list-pdf-canvas") || ($("tree-list-pdf-pane") && $("tree-list-pdf-pane").hidden)) return;
      if (e.pointerType !== "pen" && e.pointerType !== "mouse") return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const pct = pctFromListPdfStage(e.clientX, e.clientY);
      if (!pct) return;
      e.preventDefault();
      e.stopPropagation();
      const prefs = listInkPrefs();
      gesture = {
        pointerId: e.pointerId,
        points: [pct],
        color: prefs.color,
        width: prefs.width
      };
      listPdf.inkDrawing = true;
      try { scroll.setPointerCapture(e.pointerId); } catch (_) {}
      showPreview(gesture.points, gesture.color, gesture.width);
    }, true);

    scroll.addEventListener("pointermove", function (e) {
      if (!gesture || gesture.pointerId !== e.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      const pct = pctFromListPdfStage(e.clientX, e.clientY);
      if (!pct) return;
      const last = gesture.points[gesture.points.length - 1];
      if (last && Math.hypot(pct.x - last.x, pct.y - last.y) < 0.08) return;
      gesture.points.push(pct);
      showPreview(gesture.points, gesture.color, gesture.width);
    }, true);

    function endInk(e) {
      if (!gesture || (e && gesture.pointerId !== e.pointerId)) return;
      const g = gesture;
      gesture = null;
      listPdf.inkDrawing = false;
      clearPreview();
      try { if (e) scroll.releasePointerCapture(e.pointerId); } catch (_) {}
      const pts = simplifyListPath(g.points);
      if (!pts || pts.length < 2) return;
      listPdf.inkStrokes = listPdf.inkStrokes || [];
      listPdf.inkStrokes.push({
        path: pts,
        color: g.color || "#38bdf8",
        width: g.width || 2.25
      });
      if (listPdf.inkStrokes.length > 200) {
        listPdf.inkStrokes = listPdf.inkStrokes.slice(-200);
      }
      saveCurrentListPdfInk();
      renderListPdfInkOverlay();
      setImportStatus("已在列表 PDF 上畫墨跡 · 共 " + listPdf.inkStrokes.length + " 筆", "ok");
    }

    scroll.addEventListener("pointerup", endInk, true);
    scroll.addEventListener("pointercancel", endInk, true);
  }

  function bindListPdfGestures() {
    const scroll = $("tree-list-pdf-scroll");
    if (!scroll || scroll._listPdfGesturesBound) return;
    scroll._listPdfGesturesBound = true;
    let pinch = null;
    let pan = null;
    let swipe = null;
    let liveZoom = null;
    const SWIPE_MIN_DX = 56;
    const SWIPE_MAX_DY = 72;

    function clampZ(z) {
      return Math.max(LIST_PDF_ZOOM_MIN, Math.min(LIST_PDF_ZOOM_MAX, z));
    }
    function touchDist(a, b) {
      const dx = a.clientX - b.clientX;
      const dy = a.clientY - b.clientY;
      return Math.sqrt(dx * dx + dy * dy) || 1;
    }
    function midPoint(a, b) {
      return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
    }
    function stageEl() { return $("tree-list-pdf-stage"); }
    function clearPreview() {
      liveZoom = null;
      const stage = stageEl();
      if (stage) {
        stage.style.transform = "none";
        stage.style.transformOrigin = "0 0";
      }
    }
    function applyLivePreview(absZoom, originClientX, originClientY) {
      const base = listPdf.zoom || 1;
      const next = clampZ(absZoom);
      liveZoom = next;
      const factor = next / base;
      const stage = stageEl();
      if (!stage) return;
      const rect = scroll.getBoundingClientRect();
      const ox = (originClientX != null ? originClientX : rect.left + rect.width / 2) - rect.left + scroll.scrollLeft;
      const oy = (originClientY != null ? originClientY : rect.top + rect.height / 2) - rect.top + scroll.scrollTop;
      stage.style.transformOrigin = ox.toFixed(2) + "px " + oy.toFixed(2) + "px";
      stage.style.transform = "scale(" + factor.toFixed(5) + ")";
      const readout = $("tree-list-pdf-zoom-level");
      if (readout) {
        readout.textContent = (Math.round(next * 10) / 10) + "×";
        readout.hidden = next <= 1.01;
      }
      scroll.classList.toggle("is-zoomed", next > 1.01);
    }
    function commitAbsZoom(absZoom, focusClientX, focusClientY) {
      const prev = listPdf.zoom || 1;
      const next = clampZ(absZoom);
      applyLivePreview(next, focusClientX, focusClientY);
      if (Math.abs(next - prev) < 0.0005) {
        clearPreview();
        updateListPdfZoomLabel();
        return;
      }
      const rect = scroll.getBoundingClientRect();
      const fx = (focusClientX != null ? focusClientX : rect.left + rect.width / 2);
      const fy = (focusClientY != null ? focusClientY : rect.top + rect.height / 2);
      const relX = fx - rect.left + scroll.scrollLeft;
      const relY = fy - rect.top + scroll.scrollTop;
      const ratio = next / prev;
      if (listPdf.renderTimer) {
        clearTimeout(listPdf.renderTimer);
        listPdf.renderTimer = null;
      }
      listPdf.renderTimer = setTimeout(function () {
        listPdf.renderTimer = null;
        listPdf.zoom = next;
        updateListPdfZoomLabel();
        renderListPdfCanvas().then(function () {
          clearPreview();
          scroll.scrollLeft = Math.max(0, relX * ratio - (fx - rect.left));
          scroll.scrollTop = Math.max(0, relY * ratio - (fy - rect.top));
        }).catch(function () { clearPreview(); });
      }, 48);
    }

    scroll.addEventListener("touchstart", function (e) {
      if (!e.touches || !e.touches.length) return;
      if (listPdf.inkDrawing) return;
      if (e.touches.length === 2) {
        e.preventDefault();
        pan = null;
        const d = touchDist(e.touches[0], e.touches[1]);
        const mid = midPoint(e.touches[0], e.touches[1]);
        const base = (liveZoom != null) ? liveZoom : listPdf.zoom;
        pinch = { dist: d, zoom: base, cx: mid.x, cy: mid.y };
        return;
      }
      pinch = null;
      const zNow = (liveZoom != null) ? liveZoom : listPdf.zoom;
      if (e.touches.length === 1) {
        const t0 = e.touches[0];
        if (zNow > 1.01) {
          swipe = null;
          pan = { x: t0.clientX, y: t0.clientY, sl: scroll.scrollLeft, st: scroll.scrollTop };
          scroll.classList.add("is-panning");
        } else {
          pan = null;
          swipe = { x: t0.clientX, y: t0.clientY, t: Date.now() };
        }
      }
    }, { passive: false });

    scroll.addEventListener("touchmove", function (e) {
      if (!e.touches) return;
      if (e.touches.length === 2) {
        e.preventDefault();
        swipe = null;
        pan = null;
        scroll.classList.remove("is-panning");
        const d = touchDist(e.touches[0], e.touches[1]);
        const mid = midPoint(e.touches[0], e.touches[1]);
        if (!pinch) {
          const base = (liveZoom != null) ? liveZoom : listPdf.zoom;
          pinch = { dist: d || 1, zoom: base, cx: mid.x, cy: mid.y };
        }
        const factor = d / (pinch.dist || 1);
        applyLivePreview(clampZ(pinch.zoom * factor), mid.x, mid.y);
        return;
      }
      const zNow = (liveZoom != null) ? liveZoom : listPdf.zoom;
      if (pan && e.touches.length === 1 && zNow > 1.01) {
        e.preventDefault();
        const t0 = e.touches[0];
        scroll.scrollLeft = pan.sl - (t0.clientX - pan.x);
        scroll.scrollTop = pan.st - (t0.clientY - pan.y);
        return;
      }
      if (swipe && e.touches.length === 1 && zNow <= 1.01) {
        const t0 = e.touches[0];
        const dx = t0.clientX - swipe.x;
        const dy = t0.clientY - swipe.y;
        if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.2) e.preventDefault();
      }
    }, { passive: false });

    function endPinch(e) {
      if (pinch) {
        const touches = e.touches;
        if (!touches || touches.length < 2) {
          const next = (liveZoom != null) ? liveZoom : listPdf.zoom;
          const cx = pinch.cx;
          const cy = pinch.cy;
          pinch = null;
          swipe = null;
          commitAbsZoom(next, cx, cy);
        }
      }
      if (pan && (!e.touches || e.touches.length === 0)) {
        pan = null;
        scroll.classList.remove("is-panning");
      }
      if (swipe && (!e.touches || e.touches.length === 0)) {
        const s = swipe;
        swipe = null;
        const zNow = listPdf.zoom || 1;
        if (zNow > 1.01 || listPdf.inkDrawing) return;
        const dt = Date.now() - (s.t || 0);
        if (dt > 800) return;
        // Use last known from changedTouches if available
        let cx = s.x, cy = s.y;
        if (e.changedTouches && e.changedTouches[0]) {
          cx = e.changedTouches[0].clientX;
          cy = e.changedTouches[0].clientY;
        }
        const dx = cx - s.x;
        const dy = cy - s.y;
        if (Math.abs(dx) < SWIPE_MIN_DX || Math.abs(dy) > SWIPE_MAX_DY) return;
        if (Math.abs(dx) <= Math.abs(dy) * 1.15) return;
        if (dx < 0) stepListPdfPage(1);
        else stepListPdfPage(-1);
      }
    }

    scroll.addEventListener("touchend", endPinch, { passive: false });
    scroll.addEventListener("touchcancel", endPinch, { passive: false });
  }

  /** Tree list 「匯入 PDF」 → open inside list panel (NOT media ingest). */
  function initTreeListPdfImport() {
    const input = $("tree-list-pdf-input");
    if (!input || input._listPdfBound) return;
    input._listPdfBound = true;
    loadListPdfInkBag();
    bindListPdfInkGestures();
    bindListPdfGestures();

    input.addEventListener("change", function () {
      const files = input.files;
      if (!files || !files.length) return;
      // Prefer first PDF in selection; never send to media panel
      let pdfFile = null;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (f && (/\.pdf$/i.test(f.name || "") || f.type === "application/pdf")) {
          pdfFile = f;
          break;
        }
      }
      if (!pdfFile) {
        setImportStatus("請選擇 PDF 檔", "warn");
        input.value = "";
        return;
      }
      openListPdfFile(pdfFile);
      if (files.length > 1) {
        setImportStatus("已開啟第 1 個 PDF 於列表內（其餘 " + (files.length - 1) + " 個未載入）", "ok");
      }
      input.value = "";
    });

    const prev = $("tree-list-pdf-prev");
    const next = $("tree-list-pdf-next");
    const pageSel = $("tree-list-pdf-page");
    const clearInk = $("tree-list-pdf-clear-ink");
    const closeBtn = $("tree-list-pdf-close");
    if (prev) prev.addEventListener("click", function () { stepListPdfPage(-1); });
    if (next) next.addEventListener("click", function () { stepListPdfPage(1); });
    if (pageSel && !pageSel._listPdfPageBound) {
      pageSel._listPdfPageBound = true;
      pageSel.addEventListener("change", function () {
        if (!listPdf.url) return;
        const n = parseInt(String(pageSel.value || "1"), 10);
        if (!isFinite(n)) return;
        jumpListPdfPage(n);
      });
    }
    if (clearInk) clearInk.addEventListener("click", clearListPdfInkCurrent);
    if (closeBtn) closeBtn.addEventListener("click", closeListPdf);

    // Reflow list PDF when layout toggles / resize
    window.addEventListener("resize", function () {
      if (!listPdf.url) return;
      applyListPdfZoom();
    });
  }

  function renameTreeId(oldId, newId) {
    newId = String(newId == null ? "" : newId).trim();
    if (!newId) {
      setImportStatus("樹木編號不可空白", "warn");
      return false;
    }
    const want = String(oldId).trim().toUpperCase();
    const clash = state.trees.some((t) =>
      String(t.id).trim().toUpperCase() === newId.toUpperCase() &&
      String(t.id).trim().toUpperCase() !== want
    );
    if (clash) {
      setImportStatus("編號已存在：" + newId, "warn");
      return false;
    }
    const t = state.trees.find((x) => String(x.id).trim().toUpperCase() === want);
    if (!t) return false;
    t.id = newId;
    t.props = t.props || {};
    t.props["Tree ID"] = newId;
    if (t.feature) {
      t.feature.properties = t.feature.properties || t.props;
      t.feature.properties["Tree ID"] = newId;
    }
    if (t.leafletMarker) {
      try {
        if (t.leafletMarker.feature && t.leafletMarker.feature.properties) {
          t.leafletMarker.feature.properties["Tree ID"] = newId;
        }
        if (t.leafletMarker.unbindTooltip) t.leafletMarker.unbindTooltip();
        t.leafletMarker.bindTooltip(String(newId), {
          permanent: true, direction: "top", offset: [0, -4], className: "annot-leaflet-label"
        });
      } catch (_) {}
    }
    renderTreeList();
    if (window.GpkgMedia && window.GpkgMedia.getState &&
        String(window.GpkgMedia.getState().treeId || "").toUpperCase() === want) {
      window.GpkgMedia.setSelectedTree(newId, t.props);
    }
    schedulePersist();
    setImportStatus("已改編號 " + oldId + " → " + newId, "ok");
    return true;
  }


  /** True for DBH / Height / Spread (and common aliases). */
  function isMetricListField(field) {
    const f = String(field || "");
    const fl = f.toLowerCase();
    return f === "DBH" || f === "Height" || f === "Spread" ||
      fl === "dbh" || fl === "height" || fl === "spread";
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

  /** Mobile/iPad keyboard / Scribble hints for list enlarge-edit overlay. */
  function configureListInlineInput(inp, field) {
    if (!inp) return;
    inp.setAttribute("type", "text");
    inp.setAttribute("autocomplete", "off");
    inp.setAttribute("autocorrect", "off");
    inp.setAttribute("spellcheck", "false");
    const f = String(field || "");
    const fl = f.toLowerCase();
    const isMetric = isMetricListField(field);
    const isSpecies = f === "Species" || fl === "species" || f === "樹種" || f === "树种";
    const isRemarks = f === "Remarks" || fl === "remarks" || f === "備註" || f === "备注" ||
      f === "Recommendation" || fl === "recommendation" || f === "建議" || f === "建议";
    if (isMetric) {
      // Prefer text + decimal so empty values stay editable; shows numeric keypad.
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
    // Tree ID and other text fields
    inp.setAttribute("autocapitalize", "off");
  }

  let editOverlayTouchGuard = null;

  function lockPageForEditOverlay() {
    document.documentElement.classList.add("edit-overlay-open");
    document.body.classList.add("edit-overlay-open");
    if (!editOverlayTouchGuard) {
      editOverlayTouchGuard = function (e) {
        if (e.target && e.target.closest &&
            e.target.closest(".tree-list-edit-overlay-panel, .tree-list-edit-overlay-input, textarea, input")) {
          return;
        }
        e.preventDefault();
      };
      document.addEventListener("touchmove", editOverlayTouchGuard, { passive: false, capture: true });
      document.addEventListener("wheel", editOverlayTouchGuard, { passive: false, capture: true });
    }
  }

  function unlockPageForEditOverlay() {
    if (document.querySelector(".tree-list-edit-overlay")) return;
    document.documentElement.classList.remove("edit-overlay-open");
    document.body.classList.remove("edit-overlay-open");
    if (editOverlayTouchGuard) {
      document.removeEventListener("touchmove", editOverlayTouchGuard, true);
      document.removeEventListener("wheel", editOverlayTouchGuard, true);
      editOverlayTouchGuard = null;
    }
  }

  function removeListEditOverlay() {
    const el = document.getElementById("tree-list-edit-overlay");
    if (el && el.parentNode) el.parentNode.removeChild(el);
    unlockPageForEditOverlay();
  }

  /** Center the enlarge-edit card in the viewport (no CSS transform — better Pencil/Scribble). */
  function placeListEditOverlay(wrap) {
    if (!wrap) return;
    // Scrim fills the viewport; inner panel is flex-centered via CSS (no transform scale).
    wrap.style.left = "0";
    wrap.style.top = "0";
    wrap.style.right = "0";
    wrap.style.bottom = "0";
  }

  function startTreeListFieldEdit(fieldEl) {
    if (!fieldEl || fieldEl.classList.contains("editing")) return;
    const treeId = fieldEl.getAttribute("data-tree-id");
    const field = fieldEl.getAttribute("data-field");
    if (!treeId || !field) return;
    const t = state.trees.find((x) => String(x.id).toUpperCase() === String(treeId).toUpperCase());
    if (!t) return;
    // Close any prior overlay editor (one at a time)
    const prior = document.querySelector(".tree-list-field.editing");
    if (prior && prior !== fieldEl) {
      prior.classList.remove("editing");
      removeListEditOverlay();
    }
    selectTreeFromList(treeId);
    const old = (field === "Tree ID")
      ? String(t.id)
      : (t.props && t.props[field] != null ? String(t.props[field]) : "");
    fieldEl.classList.add("editing");
    // Keep cell text as a ghost; real editor is a fixed overlay (avoids overflow clipping)
    fieldEl.textContent = field === "Tree ID" ? old : displayListVal(old);
    fieldEl.classList.toggle("empty", field !== "Tree ID" && (old == null || old === ""));

    removeListEditOverlay();
    const wrap = document.createElement("div");
    wrap.id = "tree-list-edit-overlay";
    wrap.className = "tree-list-edit-overlay";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    if (fieldEl.classList.contains("tree-list-num")) wrap.classList.add("is-num");
    if (fieldEl.classList.contains("tree-list-remarks") || fieldEl.classList.contains("tree-list-sp") ||
        fieldEl.classList.contains("tree-list-rec")) {
      wrap.classList.add("is-wide");
    }
    const panel = document.createElement("div");
    panel.className = "tree-list-edit-overlay-panel";
    const cap = document.createElement("div");
    cap.className = "tree-list-edit-overlay-cap";
    cap.textContent = String(field) + " · " + String(treeId);
    const inp = document.createElement("textarea");
    inp.className = "tree-list-input tree-list-edit-overlay-input";
    inp.setAttribute("rows", "6");
    inp.setAttribute("enterkeyhint", "done");
    configureListInlineInput(inp, field);
    inp.value = old;
    panel.appendChild(cap);
    panel.appendChild(inp);
    wrap.appendChild(panel);
    document.body.appendChild(wrap);
    lockPageForEditOverlay();
    placeListEditOverlay(wrap);
    requestAnimationFrame(function () { placeListEditOverlay(wrap); });
    inp.focus();
    try { inp.select(); } catch (_) {}

    let done = false;
    function onWinChange() {
      if (!done) placeListEditOverlay(wrap);
    }
    window.addEventListener("resize", onWinChange);
    window.addEventListener("scroll", onWinChange, true);

    function finish(ok) {
      if (done) return;
      done = true;
      window.removeEventListener("resize", onWinChange);
      window.removeEventListener("scroll", onWinChange, true);
      fieldEl.classList.remove("editing");
      removeListEditOverlay();
      let text = String(inp.value || "").replace(/\r\n/g, "\n").replace(/\n/g, " ").trimEnd();
      // For Tree ID keep raw trimmed; for others allow empty
      let next = (field === "Tree ID") ? text.trim() : text.trim();
      // DBH / Height / Spread → numeric-only result (decimals OK; strip units/letters)
      if (ok && isMetricListField(field)) {
        next = sanitizeMetricNumber(next);
        text = next;
      }
      if (!ok || next === old) {
        if (fieldEl.isConnected) {
          fieldEl.textContent = field === "Tree ID" ? old : displayListVal(old);
          fieldEl.classList.toggle("empty", field !== "Tree ID" && (old == null || old === ""));
        }
        return;
      }
      if (field === "Tree ID") {
        if (!renameTreeId(treeId, next)) {
          if (fieldEl.isConnected) fieldEl.textContent = old;
          return;
        }
        return;
      }
      applyTreeAttr(treeId, field, next);
      if (fieldEl.isConnected) {
        fieldEl.textContent = displayListVal(next);
        fieldEl.classList.toggle("empty", next === "");
      }
      if (window.GpkgMedia && window.GpkgMedia.getState &&
          String(window.GpkgMedia.getState().treeId || "").toUpperCase() === String(treeId).toUpperCase()) {
        window.GpkgMedia.setSelectedTree(treeId, t.props);
      }
      setImportStatus("已更新 " + field, "ok");
    }
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); finish(true); }
      if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    });
    // Defer blur so tap-outside still commits after any click handlers
    inp.addEventListener("blur", () => { setTimeout(() => finish(true), 0); });
    panel.addEventListener("click", (ev) => ev.stopPropagation());
    panel.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    wrap.addEventListener("pointerdown", (ev) => {
      if (ev.target === wrap) { ev.preventDefault(); finish(true); }
    });
  }

  function bindTreeListInteractions(box) {
    if (!box || box._listEditBound) return;
    box._listEditBound = true;

    // v78: finger/mouse → double-tap/dblclick to edit; Apple Pencil → single tap.
    // Single finger tap must not open enlarge-edit (avoids edit while scrolling).
    // Tap on row chrome (not starting edit) → select only.
    let editedByPointer = 0;
    let lastTouchTap = { t: 0, field: null };
    box.addEventListener("click", (e) => {
      const del = e.target.closest && e.target.closest(".tree-list-del");
      if (del) {
        e.preventDefault();
        e.stopPropagation();
        deleteTree(del.getAttribute("data-del-id"));
        return;
      }
      if (e.target.closest && e.target.closest(".tree-list-input")) return;
      if (Date.now() - editedByPointer < 450) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const row = e.target.closest && e.target.closest(".tree-list-row");
      // Mouse/touch single click: select row only — edit via dblclick / pen / touch double-tap
      if (row) {
        const tid = row.getAttribute("data-tree-id");
        if (tid) selectTreeFromList(tid);
      }
    });

    box.addEventListener("dblclick", (e) => {
      const field = e.target.closest && e.target.closest(".tree-list-field");
      if (!field || !box.contains(field)) return;
      e.preventDefault();
      e.stopPropagation();
      startTreeListFieldEdit(field);
    });

    // Pen: single tap may edit. Touch: require double-tap.
    box.addEventListener("pointerup", (e) => {
      if (e.pointerType === "mouse") return; // dblclick handles mouse
      if (e.pointerType !== "pen" && e.pointerType !== "touch") return;
      const field = e.target.closest && e.target.closest(".tree-list-field");
      if (!field || !box.contains(field)) return;
      if (field.classList.contains("editing")) return;
      if (e.target.closest && e.target.closest(".tree-list-input")) return;
      if (e.pointerType === "pen") {
        editedByPointer = Date.now();
        e.preventDefault();
        startTreeListFieldEdit(field);
        return;
      }
      // touch: double-tap only
      const now = Date.now();
      if (lastTouchTap.field === field && now - lastTouchTap.t < 400) {
        lastTouchTap = { t: 0, field: null };
        editedByPointer = now;
        e.preventDefault();
        startTreeListFieldEdit(field);
        return;
      }
      lastTouchTap = { t: now, field: field };
    });
  }

  function stripBom(s) {
    return String(s == null ? "" : s).replace(/^\uFEFF/, "");
  }

  function normHeader(h) {
    return stripBom(h).trim().toLowerCase().replace(/[\s_\-.#]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function compactHeader(h) {
    return normHeader(h).replace(/\s+/g, "");
  }

  function findCol(headers, hints, opts) {
    opts = opts || {};
    const exactOnly = opts.exactOnly || null;
    const norms = headers.map((h) => ({ raw: h, n: normHeader(h), c: compactHeader(h) }));
    for (const hint of hints) {
      const hn = normHeader(hint);
      const hc = compactHeader(hint);
      const hit = norms.find((x) => x.n === hn || x.c === hc);
      if (hit) return hit.raw;
    }
    // partial contains for longer hints (skip short / ambiguous)
    for (const hint of hints) {
      const hn = normHeader(hint);
      if (hn.length < 3) continue;
      if (exactOnly && exactOnly.has(normHeader(hint))) continue;
      const hit = norms.find((x) => {
        if (!x.n || x.n.length < 2) return false;
        return x.n.indexOf(hn) >= 0 || (x.n.length >= 3 && hn.indexOf(x.n) >= 0);
      });
      if (hit) return hit.raw;
    }
    return null;
  }

  function findIdCol(headers) {
    // Prefer explicit tree-id style over bare "id" / "no"
    const strong = ID_HEADER_HINTS.filter((h) => !ID_HEADER_EXACT_ONLY.has(normHeader(h)));
    let col = findCol(headers, strong, { exactOnly: ID_HEADER_EXACT_ONLY });
    if (col) return col;
    col = findCol(headers, ["編號", "编号", "號碼", "木號", "id", "fid", "gid", "tag", "label", "no.", "no", "num", "number", "tree", "trees"], { exactOnly: ID_HEADER_EXACT_ONLY });
    return col;
  }

  function looksLikeTreeId(v) {
    const s = stripBom(v).trim();
    if (!s || s.length > 40) return false;
    if (/^t\d{1,6}$/i.test(s)) return true;
    if (/^[a-z]{1,6}[-_]?\d{1,6}$/i.test(s)) return true;
    // Mostly alphanumeric IDs (must include a letter or digit; reject pure punctuation)
    if (!/^[A-Za-z0-9][A-Za-z0-9_\-./]*$/.test(s)) return false;
    if (!/[A-Za-z0-9]/.test(s)) return false;
    // Reject obvious non-IDs (long prose / species names with spaces already fail regex)
    return true;
  }

  function scoreColumnAsIds(rows, col) {
    let good = 0;
    let total = 0;
    const n = Math.min(rows.length, 80);
    for (let i = 0; i < n; i++) {
      const v = rows[i][col];
      if (v == null || String(v).trim() === "") continue;
      total++;
      if (looksLikeTreeId(v)) good++;
    }
    return total ? good / total : 0;
  }

  function firstNonEmptyCol(headers, rows) {
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      const hit = rows.some((r) => r[h] != null && String(r[h]).trim() !== "");
      if (hit) return h;
    }
    return headers[0] || null;
  }

  /** Resolve ID column with forgiving fallbacks. Returns { col, note }. */
  function resolveIdCol(headers, rows) {
    const listed = headers.map((h) => stripBom(h).trim() || "(空白)").join("、") || "（無）";
    let col = findIdCol(headers);
    if (col) return { col: col, note: null };

    // Fall back to first column when values look like tree IDs (T1, T30, alphanumeric)
    if (headers.length) {
      const first = headers[0];
      if (scoreColumnAsIds(rows, first) >= 0.5) {
        return { col: first, note: "自動使用第一欄「" + stripBom(first).trim() + "」作為樹木編號" };
      }
    }

    // Best-scoring column among remaining
    let best = null;
    let bestScore = 0;
    headers.forEach((h) => {
      const sc = scoreColumnAsIds(rows, h);
      if (sc > bestScore) { bestScore = sc; best = h; }
    });
    if (best && bestScore >= 0.5) {
      return { col: best, note: "自動使用欄「" + stripBom(best).trim() + "」作為樹木編號" };
    }

    // Last resort: first non-empty column
    const fallback = firstNonEmptyCol(headers, rows);
    if (fallback) {
      return { col: fallback, note: "找不到明確編號欄，已改用「" + stripBom(fallback).trim() + "」。現有欄名：" + listed };
    }

    throw new Error("找不到樹木編號欄。現有欄名：" + listed);
  }

  function rememberUrl(url) {
    if (url && String(url).indexOf("blob:") === 0) state.objectUrls.push(url);
    return url;
  }

  function revokeMapRefUrl() {
    // Revoke sheet blob URLs first (skips urls still equal to mapRef*/raster)
    if (typeof clearMapSheets === "function") clearMapSheets();
    if (state.mapRefUrl && String(state.mapRefUrl).indexOf("blob:") === 0) {
      try { URL.revokeObjectURL(state.mapRefUrl); } catch (e) { /* ignore */ }
    }
    if (state.mapRefRasterUrl && String(state.mapRefRasterUrl).indexOf("blob:") === 0) {
      try { URL.revokeObjectURL(state.mapRefRasterUrl); } catch (e) { /* ignore */ }
    }
    state.mapRefUrl = null;
    state.mapRefRasterUrl = null;
    state.mapRefKind = null;
    state.mapRefName = "";
    state.mapRefRasterized = false;
    state.mapSheets = [];
    state.activeMapSheetId = null;
    if (state.cropMode && typeof exitCropMode === "function") {
      try { exitCropMode(); } catch (e) { state.cropMode = false; }
    } else {
      state.cropMode = false;
      state.cropRect = null;
      state.cropDrag = null;
    }
    const tabs = $("map-sheet-tabs");
    if (tabs) { tabs.hidden = true; tabs.innerHTML = ""; }
    const pageNav = $("map-ref-page-nav");
    if (pageNav) pageNav.hidden = true;
    const pageSel = $("map-ref-page-select");
    if (pageSel) pageSel.innerHTML = "";
  }

  function parseCsvText(text) {
    const rows = [];
    let row = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];
      if (inQ) {
        if (ch === '"' && next === '"') { cur += '"'; i++; continue; }
        if (ch === '"') { inQ = false; continue; }
        cur += ch;
        continue;
      }
      if (ch === '"') { inQ = true; continue; }
      if (ch === ",") { row.push(cur); cur = ""; continue; }
      if (ch === "\r") continue;
      if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; continue; }
      cur += ch;
    }
    if (cur.length || row.length) { row.push(cur); rows.push(row); }
    if (!rows.length) return [];
    return matrixToObjects(rows);
  }

  function cleanHeaderCell(v) {
    return stripBom(String(v == null ? "" : v)).replace(/\s+/g, " ").trim();
  }

  function isTreeNoHeaderCell(cell) {
    const n = normHeader(cell);
    const c = compactHeader(cell);
    if (!n) return false;
    if (n === "tree no" || n === "tree no." || c === "treeno" || n === "tree number" || c === "treenumber") return true;
    if (n === "樹號" || n === "树号" || n === "樹木編號" || n === "树木编号" || n === "樹木编号" || n === "树木編號") return true;
    if (n.indexOf("tree no") === 0) return true;
    return false;
  }

  function findHeaderRowIndex(matrix) {
    const limit = Math.min((matrix && matrix.length) || 0, 60);
    for (let r = 0; r < limit; r++) {
      const row = matrix[r] || [];
      for (let c = 0; c < row.length; c++) {
        if (isTreeNoHeaderCell(row[c])) return r;
      }
    }
    return -1;
  }

  function rowLooksLikeSubHeader(row) {
    if (!row || !row.length) return false;
    let hits = 0;
    for (let i = 0; i < row.length; i++) {
      const n = normHeader(row[i]);
      if (!n) continue;
      if (/scientific|chinese name|中文名|height\s*\(|spread\s*\(|dbh|胸徑|胸径|高度|冠幅/.test(n)) hits++;
    }
    return hits >= 2;
  }

  function mergeHeaderPair(top, sub) {
    const max = Math.max(top.length, sub ? sub.length : 0);
    const headers = [];
    const used = {};
    for (let i = 0; i < max; i++) {
      const a = cleanHeaderCell(top[i]);
      const b = sub ? cleanHeaderCell(sub[i]) : "";
      let name;
      if (a && b) {
        const an = normHeader(a);
        const bn = normHeader(b);
        // Group parents (Species / Tree Size) → prefer detailed sub-label
        if (an === "species" || an === "tree size" || an === "size" || an === "樹種" || an === "树种") {
          name = b;
        } else if (/scientific|chinese name|中文名|^height|^spread|^dbh|胸徑|胸径/.test(bn)) {
          name = b;
        } else if (b.length > 48 && a.length <= 40) {
          // Sub-row is a long legend / enum — keep the short top label
          name = a;
        } else if (an === bn) {
          name = a;
        } else {
          name = a;
        }
      } else {
        name = a || b || ("col" + i);
      }
      let unique = name;
      let n = 2;
      while (used[normHeader(unique)]) {
        unique = name + " (" + n + ")";
        n++;
      }
      used[normHeader(unique)] = true;
      headers.push(unique);
    }
    return headers;
  }

  /** Convert AOA matrix → objects; detect Tree No. header (not title row 0). */
  function matrixToObjects(matrix) {
    if (!matrix || !matrix.length) return [];
    let headerIdx = findHeaderRowIndex(matrix);
    let headers;
    let dataStart;
    if (headerIdx >= 0) {
      const top = matrix[headerIdx] || [];
      const next = matrix[headerIdx + 1] || [];
      if (rowLooksLikeSubHeader(next)) {
        headers = mergeHeaderPair(top, next);
        dataStart = headerIdx + 2;
      } else {
        headers = mergeHeaderPair(top, null);
        dataStart = headerIdx + 1;
      }
    } else {
      // Fallback: first non-empty row as header
      headerIdx = 0;
      while (headerIdx < matrix.length) {
        const row = matrix[headerIdx] || [];
        if (row.some((c) => cleanHeaderCell(c) !== "")) break;
        headerIdx++;
      }
      if (headerIdx >= matrix.length) return [];
      headers = mergeHeaderPair(matrix[headerIdx] || [], null);
      dataStart = headerIdx + 1;
    }
    const out = [];
    for (let r = dataStart; r < matrix.length; r++) {
      const cells = matrix[r] || [];
      if (!cells.some((c) => cleanHeaderCell(c) !== "")) continue;
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = cells[i] != null ? cells[i] : "";
      });
      out.push(obj);
    }
    return out;
  }

  function sheetRowsToObjects(sheet) {
    if (typeof XLSX === "undefined") throw new Error("SheetJS (XLSX) not loaded");
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
    return matrixToObjects(matrix);
  }

  async function readTableFile(file) {
    const name = (file.name || "").toLowerCase();
    if (name.endsWith(".csv") || (file.type && file.type.indexOf("csv") >= 0)) {
      const text = await file.text();
      return parseCsvText(text);
    }
    if (typeof XLSX === "undefined") {
      throw new Error("Excel 解析庫未載入（vendor/xlsx.full.min.js）");
    }
    const buf = await file.arrayBuffer();
    // type:array supports both .xlsx and legacy .xls (BIFF)
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw new Error("Excel 沒有工作表");
    return sheetRowsToObjects(wb.Sheets[sheetName]);
  }

  function pickCoord(row, headers, latCol, lonCol, xCol, yCol) {
    let lon = null;
    let lat = null;
    if (lonCol && latCol) {
      lon = parseFloat(row[lonCol]);
      lat = parseFloat(row[latCol]);
      if (isFinite(lon) && isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        return { lon: lon, lat: lat, kind: "wgs" };
      }
    }
    // x/y may be WGS or HK1980 grid — leave as Point coords; app.js applyHk1980IfNeeded will convert
    if (xCol && yCol) {
      const x = parseFloat(row[xCol]);
      const y = parseFloat(row[yCol]);
      if (isFinite(x) && isFinite(y)) {
        return { lon: x, lat: y, kind: "xy" };
      }
    }
    return null;
  }


  const EXCEL_MAP_FIELDS = [
    { key: "Tree ID", label: "樹號 Tree No", required: true, hints: null },
    { key: "Species", label: "樹種 Species", required: false, hints: SPECIES_HINTS },
    { key: "DBH", label: "DBH", required: false, hints: DBH_HINTS },
    { key: "Height", label: "高度 Height", required: false, hints: HEIGHT_HINTS },
    { key: "Spread", label: "冠幅 Spread", required: false, hints: SPREAD_HINTS },
    { key: "Remarks", label: "備註 Remark", required: false, hints: REMARKS_HINTS },
    { key: "Recommendation", label: "建議 Recommendation", required: false, hints: RECOMMEND_HINTS }
  ];

  function normalizeTableRows(rows) {
    return (rows || []).map((row) => {
      const out = {};
      Object.keys(row).forEach((k) => {
        out[stripBom(k).trim() || k] = row[k];
      });
      return out;
    });
  }

  function autoGuessMapping(headers, rows) {
    const map = {};
    const resolved = resolveIdCol(headers, rows || []);
    if (resolved && resolved.col) map["Tree ID"] = resolved.col;
    EXCEL_MAP_FIELDS.forEach((f) => {
      if (f.key === "Tree ID") return;
      if (!f.hints) return;
      const col = findCol(headers, f.hints);
      if (col) map[f.key] = col;
    });
    return map;
  }

  function loadRememberedColMap(headers) {
    try {
      const raw = localStorage.getItem(LS_COL_MAP);
      if (!raw) return null;
      const data = JSON.parse(raw);
      const saved = (data && data.map) ? data.map : data;
      if (!saved || typeof saved !== "object") return null;
      const out = {};
      Object.keys(saved).forEach((k) => {
        const h = saved[k];
        if (h && headers.indexOf(h) >= 0) out[k] = h;
      });
      return Object.keys(out).length ? out : null;
    } catch (_) {
      return null;
    }
  }

  function saveRememberedColMap(mapping) {
    try {
      localStorage.setItem(LS_COL_MAP, JSON.stringify({ map: mapping || {}, at: Date.now() }));
    } catch (_) {}
  }

  function ensureColMapDialog() {
    let dlg = $("excel-colmap-dialog");
    if (dlg) return dlg;
    dlg = document.createElement("div");
    dlg.id = "excel-colmap-dialog";
    dlg.className = "excel-colmap-dialog";
    dlg.hidden = true;
    dlg.innerHTML =
      '<div class="excel-colmap-card" role="dialog" aria-modal="true" aria-labelledby="excel-colmap-title">' +
      '<h3 id="excel-colmap-title">欄位對應 Column mapping</h3>' +
      '<p class="hint">請確認 Excel／CSV 欄位對應。已自動猜測常見欄名；可改下拉選單後按確定。</p>' +
      '<div class="excel-colmap-grid" id="excel-colmap-grid"></div>' +
      '<label class="excel-colmap-remember"><input type="checkbox" id="excel-colmap-remember" checked /> 記住這組對應</label>' +
      '<div class="excel-colmap-actions">' +
      '<button class="btn" type="button" id="btn-excel-colmap-cancel">取消</button>' +
      '<button class="btn btn-primary" type="button" id="btn-excel-colmap-ok">確定匯入</button>' +
      "</div></div>";
    document.body.appendChild(dlg);
    return dlg;
  }

  function promptColumnMapping(headers, rows) {
    return new Promise((resolve) => {
      const dlg = ensureColMapDialog();
      const grid = $("excel-colmap-grid");
      const rememberEl = $("excel-colmap-remember");
      const remembered = loadRememberedColMap(headers) || {};
      const guessed = autoGuessMapping(headers, rows);
      const initial = Object.assign({}, guessed, remembered);
      // Prefer remembered only when that header still exists; already filtered.
      // But do not wipe required Tree ID if remembered lacked it.
      if (!initial["Tree ID"] && guessed["Tree ID"]) initial["Tree ID"] = guessed["Tree ID"];

      const noneLab = "— 不匯入 —";
      let html = "";
      EXCEL_MAP_FIELDS.forEach((f) => {
        const sel = initial[f.key] || "";
        html += '<label class="excel-colmap-row">' +
          '<span class="excel-colmap-lab">' + escapeHtml(f.label) +
          (f.required ? ' <em>*</em>' : "") + "</span>" +
          '<select data-map-key="' + escapeHtml(f.key) + '" aria-label="' + escapeHtml(f.label) + '">' +
          '<option value="">' + noneLab + "</option>";
        headers.forEach((h) => {
          const v = String(h);
          html += '<option value="' + escapeHtml(v) + '"' +
            (sel === v ? " selected" : "") + ">" + escapeHtml(v || "(空白)") + "</option>";
        });
        html += "</select></label>";
      });
      if (grid) grid.innerHTML = html;
      if (rememberEl) rememberEl.checked = true;
      dlg.hidden = false;

      function cleanup() {
        dlg.hidden = true;
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        dlg.removeEventListener("click", onBackdrop);
      }
      function onCancel() {
        cleanup();
        resolve(null);
      }
      function onOk() {
        const mapping = {};
        Array.prototype.forEach.call(dlg.querySelectorAll("select[data-map-key]"), (sel) => {
          const key = sel.getAttribute("data-map-key");
          const val = sel.value;
          if (key && val) mapping[key] = val;
        });
        if (!mapping["Tree ID"]) {
          setImportStatus("請選擇樹號欄 Tree No", "warn");
          return;
        }
        if (rememberEl && rememberEl.checked) saveRememberedColMap(mapping);
        cleanup();
        resolve(mapping);
      }
      function onBackdrop(e) {
        if (e.target === dlg) onCancel();
      }
      const okBtn = $("btn-excel-colmap-ok");
      const cancelBtn = $("btn-excel-colmap-cancel");
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
      dlg.addEventListener("click", onBackdrop);
    });
  }

  function renameNice(props, fromKey, toKey) {
    if (!fromKey || fromKey === toKey) return;
    if (props[toKey] != null && props[toKey] !== "") return;
    if (props[fromKey] == null || props[fromKey] === "") return;
    props[toKey] = props[fromKey];
  }

  function rowsToFeatures(rows, mapping) {
    if (!rows || !rows.length) throw new Error("表格沒有資料列");
    // Normalize BOM on keys (CSV / some Excel exports)
    rows = normalizeTableRows(rows);
    const headers = Object.keys(rows[0]);
    mapping = mapping || {};
    let idCol = mapping["Tree ID"] || null;
    let idColNote = null;
    if (!idCol) {
      const resolved = resolveIdCol(headers, rows);
      idCol = resolved.col;
      idColNote = resolved.note;
    }
    if (!idCol) {
      throw new Error("找不到樹木編號欄。現有欄名：" + (headers.map((h) => stripBom(h).trim() || "(空白)").join("、") || "（無）"));
    }
    const speciesCol = mapping.Species || findCol(headers, SPECIES_HINTS);
    const chineseCol = findCol(headers, CHINESE_NAME_HINTS);
    const dbhCol = mapping.DBH || findCol(headers, DBH_HINTS);
    const heightCol = mapping.Height || findCol(headers, HEIGHT_HINTS);
    const spreadCol = mapping.Spread || findCol(headers, SPREAD_HINTS);
    const remarksCol = mapping.Remarks || findCol(headers, REMARKS_HINTS);
    const recommendCol = mapping.Recommendation || findCol(headers, RECOMMEND_HINTS);
    const defectCol = findCol(headers, DEFECT_HINTS);
    const locCol = findCol(headers, LOCATION_HINTS);
    const latCol = findCol(headers, LAT_HINTS);
    const lonCol = findCol(headers, LON_HINTS);
    let xCol = findCol(headers, X_HINTS);
    let yCol = findCol(headers, Y_HINTS);
    // Avoid treating lat/lon columns as x/y
    if (xCol && (xCol === lonCol || xCol === latCol)) xCol = null;
    if (yCol && (yCol === lonCol || yCol === latCol)) yCol = null;

    const features = [];
    const seen = {};
    rows.forEach((row, idx) => {
      let id = row[idCol];
      if (id == null || String(id).trim() === "") return;
      id = String(id).trim();
      const props = {};
      headers.forEach((h) => {
        const v = row[h];
        if (v == null || v === "") return;
        props[h] = typeof v === "string" ? v.trim() : v;
      });
      // Canonical keys for media matching / UI (same fields the Excel-style list reads)
      props["Tree ID"] = id;
      renameNice(props, speciesCol, "Species");
      // Optionally append Chinese Name → Species display "Scientific Chinese"
      if (chineseCol && chineseCol !== speciesCol) {
        const cnRaw = row[chineseCol];
        const cn = cnRaw == null ? "" : String(cnRaw).trim();
        if (cn) {
          const sci = props.Species != null ? String(props.Species).trim() : "";
          if (!sci) props.Species = cn;
          else if (sci.indexOf(cn) < 0) props.Species = sci + " " + cn;
        }
      }
      renameNice(props, dbhCol, "DBH");
      renameNice(props, heightCol, "Height");
      renameNice(props, spreadCol, "Spread");
      renameNice(props, remarksCol, "Remarks");
      renameNice(props, recommendCol, "Recommendation");
      renameNice(props, defectCol, "Defect");
      renameNice(props, locCol, "Location");
      // Also bind short aliases some UIs read
      if (props.Height != null && props.Height !== "" && props.H == null) props.H = props.Height;
      if (props.Spread != null && props.Spread !== "" && props.S == null) props.S = props.Spread;
      // Ensure metrics / remarks / recommendation exist for attrs card (empty editable)
      if (!Object.prototype.hasOwnProperty.call(props, "Species")) props.Species = "";
      if (!Object.prototype.hasOwnProperty.call(props, "DBH")) props.DBH = "";
      if (!Object.prototype.hasOwnProperty.call(props, "Height")) props.Height = "";
      if (!Object.prototype.hasOwnProperty.call(props, "Spread")) props.Spread = "";
      if (!Object.prototype.hasOwnProperty.call(props, "Remarks")) props.Remarks = "";
      if (!Object.prototype.hasOwnProperty.call(props, "Recommendation")) props.Recommendation = "";

      const coord = pickCoord(row, headers, latCol, lonCol, xCol, yCol);
      let geometry = null;
      if (coord) {
        geometry = { type: "Point", coordinates: [coord.lon, coord.lat] };
      }
      const key = id.toUpperCase();
      if (seen[key]) {
        // keep first; skip duplicates quietly
        return;
      }
      seen[key] = true;
      features.push({
        type: "Feature",
        properties: props,
        geometry: geometry
      });
    });
    if (!features.length) throw new Error("沒有有效的樹木列（編號欄為空？）");
    return { features: features, idCol: idCol, idColNote: idColNote };
  }

  function fmtXy(n) {
    if (n == null || !isFinite(n)) return "—";
    return Number(n).toFixed(1);
  }

  function renderTreeList() {
    const box = $("tree-list");
    const panel = $("tree-list-panel");
    const countEl = $("tree-list-count");
    if (!box) return;
    if (!state.trees.length) {
      box.innerHTML = "";
      if (countEl) countEl.textContent = "";
      // Keep panel open if list PDF is showing
      if (document.body.classList.contains("has-tree-list-pdf")) {
        document.body.classList.add("has-tree-list");
        if (panel) panel.hidden = false;
      } else {
        if (panel) panel.hidden = true;
        document.body.classList.remove("has-tree-list");
      }
      renderAnnotOverlay();
      updateMapRestoreHint();
      return;
    }
    document.body.classList.add("has-tree-list");
    if (panel) panel.hidden = false;
    if (countEl) {
      const withCoords = state.trees.filter((t) => t.hasCoords).length;
      const withXy = state.trees.filter((t) => t.x != null && t.y != null).length;
      let extra = "";
      if (withCoords) extra = "（" + withCoords + " 有座標）";
      else if (withXy) extra = "（" + withXy + " 有 x／y）";
      else extra = "（無座標 — 請用清單選樹）";
      countEl.textContent = state.trees.length + " 棵" + extra;
    }
    const selected = (window.GpkgMedia && window.GpkgMedia.getState)
      ? window.GpkgMedia.getState().treeId
      : null;

    function cellHtml(tid, field, raw, extraClass, tdClass) {
      const empty = raw == null || raw === "";
      const cls = "tree-list-field" + (extraClass ? " " + extraClass : "") + (empty ? " empty" : "");
      const td = tdClass ? (' class="' + tdClass + '"') : "";
      return "<td" + td + '><span class="' + cls + '" data-field="' + field + '" data-tree-id="' + tid +
        '" title="點一下編輯">' + escapeHtml(field === "Tree ID" ? String(raw) : displayListVal(raw)) + "</span></td>";
    }

    let html = '<table class="tree-list-table" role="grid" aria-label="樹木列表">' +
      "<thead><tr>" +
      '<th class="col-id" scope="col">樹號</th>' +
      '<th class="col-sp" scope="col">樹種 / Species</th>' +
      '<th class="col-num" scope="col" title="胸徑 DBH">DBH</th>' +
      '<th class="col-num" scope="col" title="高度 Height">H</th>' +
      '<th class="col-num" scope="col" title="冠幅 Spread">S</th>' +
      '<th class="col-remarks" scope="col">Remarks</th>' +
      '<th class="col-rec" scope="col">Recommendation</th>' +
      '<th class="col-xy" scope="col" title="Relative x %">x</th>' +
      '<th class="col-xy" scope="col" title="Relative y %">y</th>' +
      '<th class="col-pin" scope="col" title="有座標">📍</th>' +
      '<th class="col-del" scope="col"><span class="sr-only">刪除</span></th>' +
      "</tr></thead><tbody>";

    state.trees.forEach((t) => {
      const p = t.props || {};
      const sp = p.Species || p.species || "";
      const dbh = p.DBH;
      const h = p.Height;
      const s = p.Spread;
      const rem = p.Remarks != null ? p.Remarks : (p["備註"] != null ? p["備註"] : "");
      const rec = p.Recommendation != null ? p.Recommendation : (p["建議"] != null ? p["建議"] : "");
      const on = selected && String(selected).toUpperCase() === String(t.id).toUpperCase();
      const tid = escapeHtml(t.id);
      const hasXy = t.x != null && t.y != null;
      html += '<tr class="tree-list-row' + (on ? " on" : "") + '" data-tree-id="' + tid +
        '" tabindex="0" aria-selected="' + (on ? "true" : "false") + '">' +
        cellHtml(tid, "Tree ID", t.id, "tree-list-id", "col-id") +
        cellHtml(tid, "Species", sp, "tree-list-sp", "col-sp") +
        cellHtml(tid, "DBH", dbh, "tree-list-num", "col-num") +
        cellHtml(tid, "Height", h, "tree-list-num", "col-num") +
        cellHtml(tid, "Spread", s, "tree-list-num", "col-num") +
        cellHtml(tid, "Remarks", rem, "tree-list-remarks", "col-remarks") +
        cellHtml(tid, "Recommendation", rec, "tree-list-remarks tree-list-rec", "col-rec") +
        '<td class="col-xy tree-list-xy tree-list-xy-x' + (hasXy ? "" : " empty") +
        '" data-tree-id="' + tid + '" title="Relative x %">' +
        (hasXy ? escapeHtml(fmtXy(t.x)) : "—") + "</td>" +
        '<td class="col-xy tree-list-xy tree-list-xy-y' + (hasXy ? "" : " empty") +
        '" data-tree-id="' + tid + '" title="Relative y %">' +
        (hasXy ? escapeHtml(fmtXy(t.y)) : "—") + "</td>" +
        '<td class="col-pin tree-list-pin-cell">' + (t.hasCoords ? '<span class="tree-list-pin" title="有座標">📍</span>' : "") + "</td>" +
        '<td class="col-del tree-list-del-cell"><button type="button" class="tree-list-del" data-del-id="' + tid +
        '" title="刪除 Delete" aria-label="刪除 ' + tid + '">✕</button></td>' +
        "</tr>";
    });
    html += "</tbody></table>";
    box.innerHTML = html;
    bindTreeListInteractions(box);
    renderAnnotOverlay();
    updateMapRestoreHint();
    if (window.GpkgViewer && window.GpkgViewer.invalidateMap) {
      setTimeout(function () { window.GpkgViewer.invalidateMap(); }, 60);
    }
  }

  function selectTreeFromList(treeId) {
    const t = state.trees.find((x) => String(x.id).toUpperCase() === String(treeId).toUpperCase());
    if (!t) return;
    // Highlight in list
    const box = $("tree-list");
    if (box) {
      Array.prototype.forEach.call(box.querySelectorAll(".tree-list-row"), (el) => {
        const on = String(el.getAttribute("data-tree-id")).toUpperCase() === String(treeId).toUpperCase();
        el.classList.toggle("on", on);
        el.setAttribute("aria-selected", on ? "true" : "false");
      });
    }
    highlightAnnotMarker(treeId);
    if (window.GpkgViewer && typeof window.GpkgViewer.selectTreeById === "function") {
      window.GpkgViewer.selectTreeById(t.id, t.props);
    } else if (window.GpkgMedia) {
      window.GpkgMedia.setSelectedTree(t.id, t.props);
    }
  }

  function updateMapRefVisibility() {
    const panel = $("map-ref-panel");
    if (!panel) return;
    const hasMapped = window.GpkgViewer && typeof window.GpkgViewer.hasMappedPoints === "function"
      ? window.GpkgViewer.hasMappedPoints()
      : (window.GpkgViewer && window.GpkgViewer.hasVectorLayers ? window.GpkgViewer.hasVectorLayers() : false);
    // Show reference map when loaded AND (no map markers OR user forced show).
    // Excel-only / demo without coords → PDF covers black Leaflet. After import we set force-map-ref.
    const forced = document.body.classList.contains("force-map-ref");
    const show = !!(state.mapRefUrl) && (!hasMapped || forced);
    panel.hidden = !show;
    document.body.classList.toggle("has-map-ref", show);
    const mapEl = $("map");
    if (mapEl) mapEl.classList.toggle("map-ref-active", show);
    updateFloatBarVisibility(show);
    updatePdfHint();
    if (show) {
      ensureAnnotLayerObserver();
      applyMapRefZoom();
    }
    syncAnnotLayerActive();
    if (window.GpkgViewer && window.GpkgViewer.invalidateMap) {
      setTimeout(() => window.GpkgViewer.invalidateMap(), 50);
    }
  }

  function updateFloatBarVisibility(mapRefShowing) {
    const bar = $("annot-float-bar");
    if (!bar) return;
    // Prefer sidebar + map-ref toolbar. Keep a slim bottom-left float only while
    // annotate mode is ON and Leaflet is visible — never over the global topbar.
    const show = !mapRefShowing && !!state.annotateMode;
    bar.hidden = !show;
  }

  function hideMapRefViewers() {
    const frame = $("map-ref-frame");
    const obj = $("map-ref-object");
    const emb = $("map-ref-embed");
    const img = $("map-ref-img");
    const openTab = $("map-ref-open-tab");
    if (frame) { frame.hidden = true; frame.removeAttribute("src"); }
    if (obj) {
      obj.hidden = true;
      try { obj.removeAttribute("data"); } catch (e) { /* ignore */ }
      obj.data = "";
    }
    if (emb) {
      try { emb.removeAttribute("src"); } catch (e) { /* ignore */ }
      emb.src = "";
    }
    if (img) { img.hidden = true; img.removeAttribute("src"); }
    if (openTab) {
      openTab.hidden = true;
      openTab.removeAttribute("href");
    }
  }


  const MAP_ZOOM_MIN = 1;
  const MAP_ZOOM_MAX = 8;
  const MAP_ZOOM_STEP = 0.35;

  function clampZoom(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  /** object-fit:contain content box inside an element of size elW×elH */
  function containBox(elW, elH, contentW, contentH) {
    if (!elW || !elH || !contentW || !contentH) {
      return { left: 0, top: 0, width: elW || 0, height: elH || 0 };
    }
    const scale = Math.min(elW / contentW, elH / contentH);
    const width = contentW * scale;
    const height = contentH * scale;
    return {
      left: (elW - width) / 2,
      top: (elH - height) / 2,
      width: width,
      height: height
    };
  }

  function getMapRefMediaEl() {
    const img = $("map-ref-img");
    // v84/v83: do not require !hidden — src + naturalWidth is enough for composite save
    if (img && img.getAttribute("src") && img.naturalWidth > 0) return img;
    return null;
  }

  /**
   * Pin annotate layer to the painted map image content (not letterbox / overlay viewport).
   * Layer lives inside #map-ref-zoom-stage; stage layout size = viewer × zoom (no CSS scale),
   * so getBoundingClientRect / hit-testing stay 1:1 with pixels at any zoom.
   */
  function syncAnnotLayerToContent() {
    const layer = $("map-annotate-layer");
    const stage = $("map-ref-zoom-stage");
    if (!layer || !stage) return;
    const media = getMapRefMediaEl();
    const sw = stage.clientWidth || 0;
    const sh = stage.clientHeight || 0;
    function fillStage() {
      layer.style.left = "0";
      layer.style.top = "0";
      layer.style.width = "100%";
      layer.style.height = "100%";
      if (typeof syncCropOverlayBox === "function") syncCropOverlayBox();
    }
    if (!media || !sw || !sh) {
      fillStage();
      return;
    }
    // Prefer the img element's layout box inside the stage, then object-fit:contain letterbox.
    const iw = media.clientWidth || 0;
    const ih = media.clientHeight || 0;
    if (!iw || !ih) {
      fillStage();
      return;
    }
    let il = 0;
    let it = 0;
    if (media.offsetParent === stage) {
      il = media.offsetLeft || 0;
      it = media.offsetTop || 0;
    } else {
      il = Math.max(0, Math.round((sw - iw) / 2));
      it = Math.max(0, Math.round((sh - ih) / 2));
    }
    const box = containBox(iw, ih, media.naturalWidth, media.naturalHeight);
    if (!box.width || !box.height) {
      fillStage();
      return;
    }
    layer.style.left = (il + box.left).toFixed(2) + "px";
    layer.style.top = (it + box.top).toFixed(2) + "px";
    layer.style.width = box.width.toFixed(2) + "px";
    layer.style.height = box.height.toFixed(2) + "px";
    if (typeof syncCropOverlayBox === "function") syncCropOverlayBox();
  }

  function ensureAnnotLayerObserver() {
    const viewer = $("map-ref-viewer");
    if (!viewer || typeof ResizeObserver === "undefined") return;
    if (state.annotLayerRo) return;
    // Observe viewer + img only — NOT the stage (applyMapRefZoom resizes stage → would loop)
    state.annotLayerRo = new ResizeObserver(function (entries) {
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].target === viewer) {
          applyMapRefZoom();
          return;
        }
      }
      syncAnnotLayerToContent();
    });
    state.annotLayerRo.observe(viewer);
    const img = $("map-ref-img");
    if (img) {
      state.annotLayerRo.observe(img);
      if (!img._annotSyncBound) {
        img._annotSyncBound = true;
        img.addEventListener("load", function () {
          syncAnnotLayerToContent();
        });
      }
    }
  }

  function getPdfjsLib() {
    return (typeof window !== "undefined" && window.pdfjsLib) ? window.pdfjsLib : null;
  }

  function ensurePdfjsForMapRef() {
    const lib = getPdfjsLib();
    if (!lib) return null;
    try {
      if (!lib.GlobalWorkerOptions.workerSrc) {
        lib.GlobalWorkerOptions.workerSrc = resolveListPdfWorkerSrc();
      }
    } catch (e) { /* ignore */ }
    try { ensurePdfWorkerViaShared(lib); } catch (_) {}
    return lib;
  }

  async function ensurePdfjsForMapRefReady() {
    const lib = ensurePdfjsForMapRef();
    if (!lib) return null;
    await ensurePdfWorkerViaShared(lib);
    return lib;
  }

  /**
   * Rasterize PDF page 1 to a PNG blob URL and show via #map-ref-img so annotate
   * shares the same image content-box coordinate space as PNG/JPG maps.
   */
  function rasterizeMapRefPdf(pdfUrl) {
    return (async function () {
      const lib = await ensurePdfjsForMapRefReady();
      if (!lib) return false;
      const task = lib.getDocument({ url: pdfUrl });
      const doc = await task.promise;
      try {
        const page = await doc.getPage(1);
        const base = page.getViewport({ scale: 1 });
        // Aim ~1600px on the long edge for sharp annotate without huge memory
        const longEdge = Math.max(base.width, base.height) || 1;
        const scale = Math.min(2.5, Math.max(1.25, 1600 / longEdge));
        const viewport = page.getViewport({ scale: scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) return false;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;
        const blob = await new Promise(function (resolve) {
          if (canvas.toBlob) canvas.toBlob(resolve, "image/png");
          else resolve(null);
        });
        if (!blob) return false;
        if (state.mapRefRasterUrl && String(state.mapRefRasterUrl).indexOf("blob:") === 0) {
          try { URL.revokeObjectURL(state.mapRefRasterUrl); } catch (e) { /* ignore */ }
        }
        const rasterUrl = rememberUrl(URL.createObjectURL(blob));
        state.mapRefRasterUrl = rasterUrl;
        state.mapRefRasterized = true;
        const img = $("map-ref-img");
        const obj = $("map-ref-object");
        const emb = $("map-ref-embed");
        const frame = $("map-ref-frame");
        if (obj) {
          obj.hidden = true;
          try { obj.removeAttribute("data"); } catch (e) { /* ignore */ }
          obj.data = "";
        }
        if (emb) {
          try { emb.removeAttribute("src"); } catch (e) { /* ignore */ }
          emb.src = "";
        }
        if (frame) {
          frame.hidden = true;
          frame.removeAttribute("src");
        }
        if (img) {
          await new Promise(function (resolve) {
            var settled = false;
            const done = function () {
              if (settled) return;
              settled = true;
              img.removeEventListener("load", done);
              img.removeEventListener("error", done);
              resolve();
            };
            img.addEventListener("load", done);
            img.addEventListener("error", done);
            img.hidden = false;
            img.src = rasterUrl;
            img.alt = (state.mapRefName || "map") + " (page 1)";
            if (img.complete && img.naturalWidth) done();
          });
        }
        return true;
      } finally {
        try { if (doc && doc.destroy) doc.destroy(); } catch (e) { /* ignore */ }
      }
    })().catch(function (err) {
      console.warn("map-ref PDF rasterize failed", err);
      state.mapRefRasterized = false;
      return false;
    });
  }

  /**
   * v108: Rasterize ALL PDF pages (~1600px long edge) into mapSheets (kind:"page").
   * Soft-cap 60 pages; warn when >40. Crops remain appendable after pages.
   */
  function rasterizeMapRefPdfAllPages(pdfUrl, name) {
    const MAP_PDF_SOFT_CAP = 60;
    const MAP_PDF_WARN_AT = 40;
    return (async function () {
      const lib = await ensurePdfjsForMapRefReady();
      if (!lib) return { ok: false, pageCount: 0 };
      const task = lib.getDocument({ url: pdfUrl });
      const doc = await task.promise;
      try {
        const totalPages = doc.numPages || 1;
        const importCount = Math.min(totalPages, MAP_PDF_SOFT_CAP);
        const baseKey = mapInkKey(name) || "map";
        const pageSheets = [];
        for (let n = 1; n <= importCount; n++) {
          const page = await doc.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const longEdge = Math.max(base.width, base.height) || 1;
          const scale = Math.min(2.5, Math.max(1.25, 1600 / longEdge));
          const viewport = page.getViewport({ scale: scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const ctx = canvas.getContext("2d", { alpha: false });
          if (!ctx) continue;
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: viewport }).promise;
          const blob = await new Promise(function (resolve) {
            if (canvas.toBlob) canvas.toBlob(resolve, "image/png");
            else resolve(null);
          });
          if (!blob) continue;
          const rasterUrl = rememberUrl(URL.createObjectURL(blob));
          pageSheets.push({
            id: baseKey + ":p" + n,
            label: "第" + n + "頁",
            kind: "page",
            page: n,
            url: rasterUrl,
            sourceName: name || ""
          });
        }
        if (!pageSheets.length) return { ok: false, pageCount: totalPages };
        // Keep crop sheets appendable: replace with pages only (fresh import)
        clearMapSheets();
        state.mapSheets = pageSheets.slice();
        const first = pageSheets[0];
        state.activeMapSheetId = first.id;
        state.mapRefRasterUrl = first.url;
        state.mapRefRasterized = true;
        if (state.drawMapKey !== first.id) {
          saveCurrentMapInk();
          loadMapInk(first.id);
        } else {
          state.drawMapKey = first.id;
        }
        const img = $("map-ref-img");
        const obj = $("map-ref-object");
        const emb = $("map-ref-embed");
        const frame = $("map-ref-frame");
        if (obj) {
          obj.hidden = true;
          try { obj.removeAttribute("data"); } catch (e) { /* ignore */ }
          obj.data = "";
        }
        if (emb) {
          try { emb.removeAttribute("src"); } catch (e) { /* ignore */ }
          emb.src = "";
        }
        if (frame) {
          frame.hidden = true;
          frame.removeAttribute("src");
        }
        if (img) {
          await new Promise(function (resolve) {
            var settled = false;
            const done = function () {
              if (settled) return;
              settled = true;
              img.removeEventListener("load", done);
              img.removeEventListener("error", done);
              resolve();
            };
            img.addEventListener("load", done);
            img.addEventListener("error", done);
            img.hidden = false;
            img.src = first.url;
            img.alt = (name || "map") + " · 第1頁";
            if (img.complete && img.naturalWidth) done();
          });
        }
        renderMapSheetTabs();
        let note = "";
        if (totalPages > MAP_PDF_SOFT_CAP) {
          note = "（共 " + totalPages + " 頁，已載入前 " + importCount + " 頁）";
        } else if (totalPages > MAP_PDF_WARN_AT) {
          note = "（共 " + totalPages + " 頁，檔案較大）";
        }
        return {
          ok: true,
          pageCount: totalPages,
          imported: importCount,
          note: note,
          firstUrl: first.url
        };
      } finally {
        try { if (doc && doc.destroy) doc.destroy(); } catch (e) { /* ignore */ }
      }
    })().catch(function (err) {
      console.warn("map-ref PDF multipage rasterize failed", err);
      state.mapRefRasterized = false;
      return { ok: false, pageCount: 0, error: err };
    });
  }

  /**
   * Layout-size zoom (Option 1): enlarge #map-ref-zoom-stage width/height by scale,
   * pan with viewer scrollLeft/scrollTop. Never use transform:scale() — WebKit hit-tests
   * the untransformed box, which broke Apple Pencil above ~1.9×.
   * state.mapRefZoom.x/y are scroll offsets (CSS px).
   */

  function setMapRefZoomingLabels(hide) {
    try { document.body.classList.toggle("tp-mapref-zooming", !!hide); } catch (_) {}
  }
  function applyMapRefZoom() {
    if (state._mapRefZoomApplying) return;
    const viewer = $("map-ref-viewer");
    const stage = $("map-ref-zoom-stage");
    const z = state.mapRefZoom;
    if (!viewer || !stage) return;
    state._mapRefZoomApplying = true;
    try {
      const scale = Math.max(MAP_ZOOM_MIN, Number(z.scale) || 1);
      z.scale = scale;

      const vw = viewer.clientWidth || 0;
      const vh = viewer.clientHeight || 0;
      if (vw > 0 && vh > 0) {
        const sw = vw * scale;
        const sh = vh * scale;
        stage.style.width = sw.toFixed(2) + "px";
        stage.style.height = sh.toFixed(2) + "px";
        // Critical: no CSS scale / translate zoom — layout box == visual box for hit-testing
        stage.style.transform = "none";

        const maxX = Math.max(0, sw - vw);
        const maxY = Math.max(0, sh - vh);
        if (scale <= 1.01) {
          z.x = 0;
          z.y = 0;
        } else {
          z.x = Math.max(0, Math.min(maxX, Number(z.x) || 0));
          z.y = Math.max(0, Math.min(maxY, Number(z.y) || 0));
        }
        viewer.scrollLeft = z.x;
        viewer.scrollTop = z.y;
        // Re-sync in case scroll clamping differed
        z.x = viewer.scrollLeft;
        z.y = viewer.scrollTop;
      }

      const readout = $("map-ref-zoom-level");
      if (readout) {
        readout.textContent = (Math.round(scale * 10) / 10) + "×";
        readout.hidden = scale <= 1.01;
      }
      syncAnnotLayerToContent();
    } finally {
      state._mapRefZoomApplying = false;
    }
  }

  function resetMapRefZoom() {
    state.mapRefZoom.scale = 1;
    state.mapRefZoom.x = 0;
    state.mapRefZoom.y = 0;
    applyMapRefZoom();
  }

  /** Zoom toward a point in viewer-local CSS px (default: viewport center). */
  function setMapRefZoomAt(nextScale, localX, localY) {
    const viewer = $("map-ref-viewer");
    const z = state.mapRefZoom;
    const prev = Math.max(MAP_ZOOM_MIN, Number(z.scale) || 1);
    const next = clampZoom(nextScale, MAP_ZOOM_MIN, MAP_ZOOM_MAX);
    if (next <= 1.01) {
      resetMapRefZoom();
      return;
    }
    const vw = viewer ? viewer.clientWidth : 0;
    const vh = viewer ? viewer.clientHeight : 0;
    const fx = localX != null && isFinite(localX) ? localX : (vw / 2);
    const fy = localY != null && isFinite(localY) ? localY : (vh / 2);
    // Content point under focal in "scale=1 stage" coordinates
    const baseX = (z.x + fx) / prev;
    const baseY = (z.y + fy) / prev;
    z.scale = next;
    z.x = baseX * next - fx;
    z.y = baseY * next - fy;
    applyMapRefZoom();
  }

  function stepMapRefZoom(dir) {
    const z = state.mapRefZoom;
    const next = clampZoom(z.scale + dir * MAP_ZOOM_STEP, MAP_ZOOM_MIN, MAP_ZOOM_MAX);
    setMapRefZoomAt(next);
  }

  function bindMapRefZoomGestures() {
    const viewer = $("map-ref-viewer");
    if (!viewer || viewer._mapZoomBound) return;
    viewer._mapZoomBound = true;

    let pinch = null;
    let pan = null;

    function dist(a, b) {
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
    }

    function midLocal(a, b) {
      const r = viewer.getBoundingClientRect();
      return {
        x: ((a.clientX + b.clientX) / 2) - r.left,
        y: ((a.clientY + b.clientY) / 2) - r.top
      };
    }

    function isStylusTouch(t) {
      // iPadOS: Apple Pencil also synthesizes touch events (touchType === "stylus")
      return !!(t && (t.touchType === "stylus" || t.touchType === "pen"));
    }

    viewer.addEventListener("touchstart", (e) => {
      if (!e.touches) return;
      if (e.touches.length === 2) {
        const m = midLocal(e.touches[0], e.touches[1]);
        setMapRefZoomingLabels(true);
        pinch = {
          dist: dist(e.touches[0], e.touches[1]),
          scale: state.mapRefZoom.scale,
          fx: m.x,
          fy: m.y,
          // content under focal in scale=1 units
          baseX: (state.mapRefZoom.x + m.x) / Math.max(MAP_ZOOM_MIN, state.mapRefZoom.scale),
          baseY: (state.mapRefZoom.y + m.y) / Math.max(MAP_ZOOM_MIN, state.mapRefZoom.scale)
        };
        pan = null;
        e.preventDefault();
        return;
      }
      pinch = null;
      const t = e.touches[0];
      // Never pan with Apple Pencil — ink draw owns stylus (even when zoomed)
      if (isStylusTouch(t)) {
        pan = null;
        const annot = $("map-annotate-layer");
        if (annot && annot.classList.contains("active")) {
          e.preventDefault();
        }
        return;
      }
      // Finger pan when zoomed — including annotate mode (letterbox / areas not on the layer)
      if (state.mapRefZoom.scale > 1.01 && e.touches.length === 1) {
        pan = { x0: t.clientX, y0: t.clientY, ox: state.mapRefZoom.x, oy: state.mapRefZoom.y };
      } else {
        pan = null;
      }
    }, { passive: false });

    viewer.addEventListener("touchmove", (e) => {
      if (e.touches && e.touches.length === 2 && pinch) {
        e.preventDefault();
        const d = dist(e.touches[0], e.touches[1]);
        const next = clampZoom(pinch.scale * (d / pinch.dist), MAP_ZOOM_MIN, MAP_ZOOM_MAX);
        const m = midLocal(e.touches[0], e.touches[1]);
        // Keep original content under moving pinch midpoint
        if (next <= 1.01) {
          state.mapRefZoom.scale = 1;
          state.mapRefZoom.x = 0;
          state.mapRefZoom.y = 0;
        } else {
          state.mapRefZoom.scale = next;
          state.mapRefZoom.x = pinch.baseX * next - m.x;
          state.mapRefZoom.y = pinch.baseY * next - m.y;
        }
        applyMapRefZoom();
        return;
      }
      if (pan && e.touches && e.touches.length === 1) {
        e.preventDefault();
        const t = e.touches[0];
        // Finger moves right → content follows → scrollLeft decreases
        state.mapRefZoom.x = pan.ox - (t.clientX - pan.x0);
        state.mapRefZoom.y = pan.oy - (t.clientY - pan.y0);
        applyMapRefZoom();
      }
    }, { passive: false });

    viewer.addEventListener("touchend", () => {
      if (state.mapRefZoom.scale <= 1.01) resetMapRefZoom();
      pinch = null;
      pan = null;
      setMapRefZoomingLabels(false);
    }, { passive: true });

    // Keep state.x/y in sync if programmatic/native scroll ever happens
    viewer.addEventListener("scroll", function () {
      if (state.mapRefZoom.scale <= 1.01) return;
      state.mapRefZoom.x = viewer.scrollLeft;
      state.mapRefZoom.y = viewer.scrollTop;
    }, { passive: true });
  }

  function showMapRef(file) {
    // Save previous map's ink under its key BEFORE switching (never bleed onto new map)
    if (state.cropMode) {
      try { exitCropMode(); } catch (e) { state.cropMode = false; }
    }
    saveCurrentMapInk();
    revokeMapRefUrl();
    hideMapRefViewers();
    resetMapRefZoom();
    const name = file.name || "map";
    const lower = name.toLowerCase();
    const url = rememberUrl(URL.createObjectURL(file));
    state.mapRefUrl = url;
    state.mapRefName = name;
    state.mapRefRasterized = false;
    // Load only this map's strokes (empty if first time)
    loadMapInk(name);

    const frame = $("map-ref-frame");
    const obj = $("map-ref-object");
    const emb = $("map-ref-embed");
    const img = $("map-ref-img");
    const label = $("map-ref-label");
    const openTab = $("map-ref-open-tab");

    function finishShow(statusMsg, displayUrl, opts) {
      opts = opts || {};
      if (!opts.sheetsReady) {
        const sheetUrl = displayUrl || state.mapRefRasterUrl || state.mapRefUrl || url;
        registerOriginalSheet(sheetUrl, name);
      }
      if (label) {
        const pages = getMapPageSheets();
        if (pages.length > 1) {
          label.textContent = "地圖參考 · " + name + " · 第1頁";
        } else {
          label.textContent = "地圖參考 · " + name;
        }
      }
      document.body.classList.add("force-map-ref");
      state.mapRefMeta = { name: name, kind: state.mapRefKind };
      updateMapRefVisibility();
      ensureAnnotLayerObserver();
      applyMapRefZoom();
      renderAnnotOverlay();
      renderMapSheetTabs();
      updateMapRestoreHint();
      closeMobileMenuAfterContent();
      schedulePersist();
      setImportStatus(statusMsg, "ok");
    }

    if (/\.pdf$/i.test(lower) || (file.type && file.type.indexOf("pdf") >= 0)) {
      state.mapRefKind = "pdf";
      if (openTab) {
        openTab.hidden = false;
        openTab.href = String(url).split("#")[0] + "#page=1";
        openTab.removeAttribute("download");
        openTab.textContent = "新分頁";
        openTab.title = "新分頁開啟目前地圖 PDF（第 1 頁）";
      }
      // v108: rasterize ALL pages into mapSheets (kind page)
      setImportStatus("正在將 PDF 各頁轉成影像以便加樹…", "");
      rasterizeMapRefPdfAllPages(url, name).then(function (result) {
        if (result && result.ok) {
          const n = result.imported || result.pageCount || 1;
          const note = result.note || "";
          finishShow(
            "已載入地圖參考：" + name + "（" + n + " 頁）" + note,
            result.firstUrl || state.mapRefRasterUrl,
            { sheetsReady: true }
          );
          return;
        }
        // Fallback: try single-page rasterize, then native viewer
        rasterizeMapRefPdf(url).then(function (ok) {
          if (ok) {
            finishShow("已載入地圖參考：" + name + "（PDF 第 1 頁影像 · 可直接畫墨跡／裁切）", state.mapRefRasterUrl);
            return;
          }
          if (emb) {
            emb.setAttribute("type", "application/pdf");
            emb.src = url;
          }
          if (obj) {
            obj.hidden = false;
            obj.setAttribute("type", "application/pdf");
            obj.data = url;
          }
          if (frame) {
            frame.hidden = true;
            frame.removeAttribute("src");
          }
          if (img) {
            img.hidden = true;
            img.removeAttribute("src");
          }
          finishShow("已載入地圖參考：" + name + "（PDF 檢視器 · 建議改用 PNG／JPG 畫記）");
        });
      });
      return;
    }

    state.mapRefKind = "image";
    if (img) {
      const onReady = function () {
        img.removeEventListener("load", onReady);
        applyMapRefZoom();
        renderAnnotOverlay();
      };
      img.addEventListener("load", onReady);
      img.hidden = false;
      img.src = url;
      img.alt = name;
      if (img.complete && img.naturalWidth) onReady();
    }
    if (openTab) {
      openTab.hidden = false;
      openTab.href = url;
      openTab.removeAttribute("download");
      openTab.textContent = "新分頁";
      openTab.title = "新分頁開啟目前地圖圖片";
    }
    finishShow("已載入地圖參考：" + name + "（可按「切換地圖」返回 Leaflet；可直接畫墨跡／裁切；開「加樹模式」短點加樹）", url);
  }

  function clearMapRef() {
    saveCurrentMapInk();
    if (state.cropMode) {
      try { exitCropMode(); } catch (e) { state.cropMode = false; }
    }
    revokeMapRefUrl();
    hideMapRefViewers();
    resetMapRefZoom();
    state.mapRefMeta = null;
    state.drawStrokes = [];
    state.drawMapKey = null;
    document.body.classList.remove("force-map-ref");
    updateMapRefVisibility();
    renderAnnotOverlay();
    renderMapSheetTabs();
    updateMapRestoreHint();
    schedulePersist();
    setImportStatus("已清除地圖參考", "");
  }

  /** v93: on tablet/phone overlay sidebar, close menu after map/excel load so Import card cannot cover tree list. */
  function closeMobileMenuAfterContent() {
    try {
      if (!window.matchMedia("(max-width: 1180px)").matches) return;
    } catch (_) {
      return;
    }
    if (!document.body.classList.contains("menu-open")) return;
    if (window.GpkgViewer && typeof window.GpkgViewer.setMenuOpen === "function") {
      window.GpkgViewer.setMenuOpen(false);
      return;
    }
    document.body.classList.remove("menu-open");
    const bd = $("backdrop");
    if (bd) bd.hidden = true;
  }

  function setImportStatus(msg, kind) {
    if (window.GpkgViewer && typeof window.GpkgViewer.setStatus === "function") {
      window.GpkgViewer.setStatus(msg, kind || "");
      return;
    }
    const el = $("status");
    if (el) el.textContent = msg || "";
  }

  async function importExcelFile(file) {
    setImportStatus("解析 " + file.name + " …", "");
    let rows = await readTableFile(file);
    rows = normalizeTableRows(rows);
    if (!rows.length) throw new Error("表格沒有資料列");
    const headers = Object.keys(rows[0]);
    const mapping = await promptColumnMapping(headers, rows);
    if (!mapping) {
      setImportStatus("已取消匯入", "warn");
      return;
    }
    const parsed = rowsToFeatures(rows, mapping);
    const features = parsed.features;

    state.sourceName = file.name;
    // Keep annotate-only trees that have map % coords if they aren't in the import? Spec: excel replaces list.
    clearLeafletAnnotMarkers();
    state.trees = features.map((ft) => ({
      id: String((ft.properties && ft.properties["Tree ID"]) || ""),
      props: ft.properties || {},
      feature: ft,
      hasCoords: !!(ft.geometry && ft.geometry.type === "Point"),
      x: null,
      y: null,
      annot: false,
      leafletMarker: null
    }));

    renderTreeList();

    if (window.GpkgViewer && typeof window.GpkgViewer.loadTreeFeatures === "function") {
      await window.GpkgViewer.loadTreeFeatures(features, file.name);
    }

    // Auto-select first tree
    if (state.trees.length) {
      selectTreeFromList(state.trees[0].id);
    }

    const nCoord = state.trees.filter((t) => t.hasCoords).length;
    let msg = "已匯入 Excel／CSV：" + state.trees.length + " 棵樹" +
      (nCoord ? "（" + nCoord + " 有座標）" : "（無座標 — 請用左側清單選樹）");
    if (parsed.idColNote) msg += " · " + parsed.idColNote;
    setImportStatus(msg, parsed.idColNote && parsed.idColNote.indexOf("找不到明確") >= 0 ? "warn" : "ok");
    updateMapRefVisibility();
    closeMobileMenuAfterContent();
    schedulePersist();
  }

  function normalizeTreeId(v) {
    if (v == null || v === "") return "";
    let s = String(v).trim().toUpperCase().replace(/\s+/g, "");
    s = s.replace(/^T[\-_]?/, "T");
    const m = s.match(/^T0*(\d+)$/);
    if (m) return "T" + m[1];
    const n = s.match(/^0*(\d+)$/);
    if (n) return "T" + n[1];
    return s;
  }

  function syncTreeListHighlight(treeId, opts) {
    const box = $("tree-list");
    if (!box || !state.trees.length) return;
    const want = treeId ? normalizeTreeId(treeId) : "";
    let matched = null;
    Array.prototype.forEach.call(box.querySelectorAll(".tree-list-row"), (el) => {
      const id = el.getAttribute("data-tree-id");
      const on = !!(want && normalizeTreeId(id) === want);
      el.classList.toggle("on", on);
      el.setAttribute("aria-selected", on ? "true" : "false");
      if (on) matched = el;
    });
    if (matched && (!opts || opts.scroll !== false)) {
      try { matched.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (_) {}
    }
    // Prefer original list id for annotate highlight
    const showId = matched ? matched.getAttribute("data-tree-id") : treeId;
    highlightAnnotMarker(showId);
  }

  function clearTreeList() {
    clearLeafletAnnotMarkers();
    state.trees = [];
    state.drawStrokes = [];
    state.drawStrokesByMap = {};
    state.drawMapKey = null;
    state.sourceName = "";
    renderTreeList();
    clearPersistedSession();
  }

  /* ---------- From-scratch annotate mode ---------- */

  function existingIdSet() {
    const s = {};
    state.trees.forEach((t) => { s[String(t.id).toUpperCase()] = true; });
    return s;
  }

  /** True for trees placed via 加樹 / annotate (not Excel/CSV import). */
  function isAnnotatePlacedTree(t) {
    if (!t) return false;
    if (t.annot) return true;
    const propSrc = String((t.props && t.props.Source) || "").trim().toLowerCase();
    if (propSrc === "annotate") return true;
    const src = String(t.source || "").trim().toLowerCase();
    if (src === "annotate" || src === "map-ref" || src === "leaflet") return true;
    return false;
  }

  /**
   * Next auto Tree ID: first free gap among annotate-placed /^T(\d+)$/i only
   * (props.Source===annotate, t.annot, or t.source annotate|map-ref|leaflet).
   * Ignores CPT001 and import-sourced rows even if they look like T#.
   */
  function nextAutoId() {
    const re = /^T(\d+)$/i;
    const usedAnnot = Object.create(null);
    state.trees.forEach((t) => {
      if (!isAnnotatePlacedTree(t)) return;
      const m = re.exec(String(t.id || "").trim());
      if (!m) return;
      usedAnnot[parseInt(m[1], 10)] = true;
    });
    let n = 1;
    while (usedAnnot[n]) n += 1;
    return "T" + n;
  }

  function setIdMode(mode) {
    state.idMode = mode === "manual" ? "manual" : "auto";
    Array.prototype.forEach.call(document.querySelectorAll(".annot-seg[data-id-mode]"), (btn) => {
      btn.classList.toggle("on", btn.getAttribute("data-id-mode") === state.idMode);
    });
    updateAnnotUi();
  }

  /** Enable pointer capture on the annotate layer for ink draw whenever map-ref is visible. */
  function syncAnnotLayerActive() {
    const layer = $("map-annotate-layer");
    if (!layer) return;
    const mapRef = document.body.classList.contains("has-map-ref");
    // Draw ink whenever map-ref is up; 加樹 mode only adds tap-to-place trees.
    const active = mapRef || state.annotateMode;
    layer.classList.toggle("active", active);
    layer.classList.toggle("place-trees", !!state.annotateMode);
    layer.setAttribute("aria-hidden", active ? "false" : "true");
  }

  function setAnnotateMode(on) {
    state.annotateMode = !!on;
    document.body.classList.toggle("annotate-mode", state.annotateMode);
    Array.prototype.forEach.call(document.querySelectorAll("#btn-annot-mode, #btn-annot-mode-bar, #btn-annot-mode-float"), (btn) => {
      if (!btn) return;
      btn.classList.toggle("is-on", state.annotateMode);
      if (btn.id === "btn-annot-mode") {
        btn.textContent = state.annotateMode ? "加樹模式 · 開 ON" : "加樹模式 Add tree";
      } else {
        btn.textContent = state.annotateMode ? "加樹·開" : "加樹";
      }
    });
    syncAnnotLayerActive();
    updatePdfHint();
    updateAnnotUi();
    ensureLeafletAnnotBinding();
    updateFloatBarVisibility(document.body.classList.contains("has-map-ref"));
    if (state.annotateMode) {
      const nextHint = state.idMode === "auto" ? ("下一個 " + nextAutoId() + " · ") : "";
      setImportStatus(
        state.idMode === "manual"
          ? "加樹模式（手動編號）：短點地圖放置後輸入編號；長按標記可拖移。自由畫＝純墨跡，不加樹"
          : "加樹模式（自動編號）：" + nextHint + "短點地圖 → T1、T2…；長按標記可拖移。自由畫＝純墨跡，不加樹",
        "ok"
      );
    } else {
      hideIdDialog();
      state.pendingPlace = null;
    }
  }

  function updatePdfHint() {
    const hint = $("map-annotate-pdf-hint");
    if (!hint) return;
    // Hide when rasterized (accurate image layer) or not annotating — never block clicks
    const nativePdf = state.mapRefKind === "pdf" && !state.mapRefRasterized;
    const show = state.annotateMode && nativePdf && document.body.classList.contains("has-map-ref");
    hint.hidden = !show;
    if (show) {
      hint.textContent = "原生 PDF 點擊較粗 · 建議 PNG／JPG 或重新匯入以轉影像";
    }
  }

  function updateAnnotUi() {
    /* v87: annot-hint instructional copy removed */
  }

  function pctFromEvent(el, clientX, clientY) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    return {
      x: Math.max(0, Math.min(100, x)),
      y: Math.max(0, Math.min(100, y))
    };
  }

  function clampPct(v) {
    return Math.max(0, Math.min(100, Number(v)));
  }

  /**
   * Placement point for a freehand stroke = centroid (average of sample points).
   * Chosen over bbox midpoint so asymmetric ticks / hooks sit nearer the ink mass.
   */
  function pathCentroid(pts) {
    if (!pts || !pts.length) return null;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
      sx += Number(p.x);
      sy += Number(p.y);
      n += 1;
    }
    if (!n) return null;
    return { x: sx / n, y: sy / n };
  }

  function normalizePath(pts) {
    if (!Array.isArray(pts) || !pts.length) return null;
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!p) continue;
      const x = clampPct(p.x);
      const y = clampPct(p.y);
      if (!isFinite(x) || !isFinite(y)) continue;
      out.push({ x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) });
    }
    return out.length ? out : null;
  }

  /**
   * High-fidelity path for committed ink (v79).
   * Drop only true duplicates / sub-pixel jitter so live preview and committed stroke match.
   * Soft safety cap is several thousand pts (was aggressive minDist 0.35% + hard 96-cap).
   */
  function simplifyPath(pts, minDist) {
    pts = normalizePath(pts);
    if (!pts) return null;
    if (pts.length <= 2) return pts;
    // Coords already toFixed(3) in normalizePath; 0.001 ≈ one quantum — keep handwriting.
    minDist = minDist == null ? 0.001 : minDist;
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const prev = out[out.length - 1];
      const p = pts[i];
      const d = Math.hypot(p.x - prev.x, p.y - prev.y);
      if (d >= minDist || i === pts.length - 1) out.push(p);
    }
    const CAP = 8000; // prefer fidelity over autosave size (was 96)
    if (out.length <= CAP) return out;
    const step = Math.ceil(out.length / CAP);
    const capped = [];
    for (let i = 0; i < out.length; i += step) capped.push(out[i]);
    const last = out[out.length - 1];
    const tail = capped[capped.length - 1];
    if (!tail || tail.x !== last.x || tail.y !== last.y) capped.push(last);
    return capped;
  }

  function pathToSvgD(pts) {
    if (!pts || !pts.length) return "";
    let d = "M " + Number(pts[0].x).toFixed(3) + " " + Number(pts[0].y).toFixed(3);
    for (let i = 1; i < pts.length; i++) {
      d += " L " + Number(pts[i].x).toFixed(3) + " " + Number(pts[i].y).toFixed(3);
    }
    return d;
  }

  function translatePath(pts, dx, dy) {
    if (!pts || !pts.length) return null;
    return pts.map(function (p) {
      return { x: clampPct(p.x + dx), y: clampPct(p.y + dy) };
    });
  }

  function beginPlace(place) {
    if (state.idMode === "manual") {
      state.pendingPlace = place;
      showIdDialog();
      return;
    }
    const id = nextAutoId();
    commitPlace(id, place);
  }

  function commitPlace(id, place) {
    id = String(id || "").trim();
    if (!id) {
      setImportStatus("請輸入樹木編號", "warn");
      return false;
    }
    if (existingIdSet()[id.toUpperCase()]) {
      setImportStatus("編號已存在：" + id, "warn");
      return false;
    }
    let path = place && place.path ? simplifyPath(place.path) : null;
    let x = place && place.x != null ? Number(place.x) : null;
    let y = place && place.y != null ? Number(place.y) : null;
    if (path && path.length && (x == null || y == null || !isFinite(x) || !isFinite(y))) {
      const c = pathCentroid(path);
      if (c) { x = c.x; y = c.y; }
    }
    // Place events are in active sheet %; store original-% when on a crop sheet
    if (path && path.length) path = remapPathToOrig(path);
    if (x != null && y != null && isFinite(x) && isFinite(y)) {
      const mapped = origPctFromSheet(x, y);
      x = mapped.x;
      y = mapped.y;
    }
    if (path && path.length === 1 && x != null && y != null) {
      // Keep a one-point path so reload still knows it was ink-placed
      path = [{ x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) }];
    }
    const props = {
      "Tree ID": id,
      Species: "",
      DBH: "",
      Height: "",
      Spread: "",
      Remarks: "",
      Recommendation: "",
      Defect: "",
      Location: "",
      x: x != null ? Number(x.toFixed(2)) : "",
      y: y != null ? Number(y.toFixed(2)) : "",
      Source: "annotate"
    };
    let geometry = null;
    let hasCoords = false;
    if (place && place.lat != null && place.lng != null && isFinite(place.lat) && isFinite(place.lng)) {
      geometry = { type: "Point", coordinates: [place.lng, place.lat] };
      hasCoords = true;
      props.Latitude = place.lat;
      props.Longitude = place.lng;
    }
    const feature = { type: "Feature", properties: props, geometry: geometry };
    const tree = {
      id: id,
      props: props,
      feature: feature,
      hasCoords: hasCoords,
      x: x,
      y: y,
      path: path,
      annot: true,
      leafletMarker: null,
      source: (place && place.source) || "map-ref"
    };
    if (hasCoords) {
      tree.leafletMarker = addLeafletAnnotMarker(tree);
    }
    state.trees.push(tree);
    if (!state.sourceName) state.sourceName = "annotate";
    renderTreeList();
    selectTreeFromList(id);
    schedulePersist();
    setImportStatus("已加 " + id + (x != null ? (" · x " + fmtXy(x) + "% y " + fmtXy(y) + "%") : ""), "ok");
    return true;
  }

  function addLeafletAnnotMarker(tree) {
    try {
      const map = window.GpkgViewer && window.GpkgViewer.getMap && window.GpkgViewer.getMap();
      if (!map || typeof L === "undefined") return null;
      ensureLeafletAnnotLayer(map);
      const ll = L.latLng(tree.feature.geometry.coordinates[1], tree.feature.geometry.coordinates[0]);
      const marker = L.circleMarker(ll, {
        radius: 2.75,
        color: "#fbbf24",
        weight: 1,
        fillColor: "#f59e0b",
        fillOpacity: 0.95,
        className: "annot-leaflet-marker",
        bubblingMouseEvents: false
      });
      marker.bindTooltip(String(tree.id), { permanent: true, direction: "top", offset: [0, -4], className: "annot-leaflet-label" });
      marker.feature = tree.feature;
      marker.on("click", function (e) {
        if (typeof L !== "undefined" && L.DomEvent) L.DomEvent.stopPropagation(e);
        selectTreeFromList(tree.id);
      });
      marker.addTo(state.leafletAnnotLayer);
      return marker;
    } catch (err) {
      console.warn(err);
      return null;
    }
  }

  function ensureLeafletAnnotLayer(map) {
    if (state.leafletAnnotLayer) return;
    state.leafletAnnotLayer = L.layerGroup().addTo(map);
  }

  function clearLeafletAnnotMarkers() {
    state.trees.forEach((t) => {
      if (t.leafletMarker && state.leafletAnnotLayer) {
        try { state.leafletAnnotLayer.removeLayer(t.leafletMarker); } catch (e) { /* ignore */ }
      }
      t.leafletMarker = null;
    });
  }

  function ensureLeafletAnnotBinding() {
    if (state.leafletBound) return;
    const map = window.GpkgViewer && window.GpkgViewer.getMap && window.GpkgViewer.getMap();
    if (!map) return;
    state.leafletBound = true;
    ensureLeafletAnnotLayer(map);
  }

  function handleLeafletClick(e) {
    if (!state.annotateMode) return false;
    const map = window.GpkgViewer && window.GpkgViewer.getMap && window.GpkgViewer.getMap();
    if (!map || !e) return false;
    const container = map.getContainer();
    let pct = null;
    if (e.containerPoint && container) {
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;
      pct = {
        x: Math.max(0, Math.min(100, (e.containerPoint.x / w) * 100)),
        y: Math.max(0, Math.min(100, (e.containerPoint.y / h) * 100))
      };
    } else if (e.originalEvent) {
      pct = pctFromEvent(container, e.originalEvent.clientX, e.originalEvent.clientY);
    }
    if (!pct) return false;
    beginPlace({
      x: pct.x,
      y: pct.y,
      lat: e.latlng ? e.latlng.lat : null,
      lng: e.latlng ? e.latlng.lng : null,
      source: "leaflet"
    });
    return true;
  }

  function handleOverlayClick(e) {
    if (!state.annotateMode) return;
    const layer = $("map-annotate-layer");
    if (!layer) return;
    // Ignore clicks on existing markers (select instead)
    const hit = e.target && e.target.closest && e.target.closest(".annot-marker");
    if (hit) {
      const tid = hit.getAttribute("data-tree-id");
      if (tid) selectTreeFromList(tid);
      return;
    }
    const pct = pctFromEvent(layer, e.clientX, e.clientY);
    if (!pct) return;
    beginPlace({ x: pct.x, y: pct.y, lat: null, lng: null, source: "map-ref" });
  }

  function renderAnnotOverlay() {
    const layer = $("map-annotate-layer");
    if (!layer) return;
    syncAnnotLayerToContent();
    const selected = (window.GpkgMedia && window.GpkgMedia.getState)
      ? window.GpkgMedia.getState().treeId
      : null;
    const selU = selected ? String(selected).toUpperCase() : "";
    let pathsHtml = "";
    let markersHtml = "";
    // Pure annotation ink (never creates trees / T-numbers)
    (state.drawStrokes || []).forEach(function (s) {
      const inkPts = (s && s.path && s.path.length >= 2) ? s.path : null;
      if (!inkPts) return;
      const col = (s.color && String(s.color)) || state.inkColor || "#38bdf8";
      const w = (isFinite(Number(s.width)) && Number(s.width) > 0)
        ? Number(s.width)
        : (state.inkWidth || 2.25);
      pathsHtml += '<path class="annot-draw-ink" d="' + pathToSvgD(inkPts) +
        '" fill="none" stroke="' + escapeHtml(col) + '" stroke-width="' + w +
        '" style="stroke:' + escapeHtml(col) + ';stroke-width:' + w +
        '" vector-effect="non-scaling-stroke"></path>';
    });
    state.trees.forEach((t) => {
      if (t.x == null || t.y == null) return;
      const disp = sheetPctFromOrig(t.x, t.y);
      // Hide markers clearly outside the active crop view
      if (disp.x < -8 || disp.x > 108 || disp.y < -8 || disp.y > 108) return;
      const tid = escapeHtml(t.id);
      const on = !!(selU && String(t.id).toUpperCase() === selU);
      const inkPtsRaw = (t.path && t.path.length >= 2) ? t.path : null;
      const inkPts = inkPtsRaw ? remapPathToSheet(inkPtsRaw) : null;
      if (inkPts) {
        pathsHtml += '<path class="annot-ink' + (on ? " on" : "") + '" data-tree-id="' + tid +
          '" d="' + pathToSvgD(inkPts) + '" fill="none" vector-effect="non-scaling-stroke"></path>';
      }
      markersHtml += '<button type="button" class="annot-marker' + (inkPts ? " has-path" : "") +
        (on ? " on" : "") + '" data-tree-id="' + tid +
        '" style="left:' + Number(disp.x).toFixed(3) + "%;top:" + Number(disp.y).toFixed(3) + '%" title="' +
        tid + '">' +
        '<span class="annot-marker-dot" aria-hidden="true"></span>' +
        '<span class="annot-marker-label">' + tid + "</span>" +
        "</button>";
    });
    layer.innerHTML =
      '<svg class="annot-ink-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">' +
      pathsHtml +
      '<path class="annot-ink-preview" hidden fill="none" vector-effect="non-scaling-stroke"></path>' +
      "</svg>" + markersHtml;
  }

  function highlightAnnotMarker(treeId) {
    const layer = $("map-annotate-layer");
    if (layer) {
      const want = treeId ? String(treeId).toUpperCase() : "";
      Array.prototype.forEach.call(layer.querySelectorAll(".annot-marker"), (el) => {
        el.classList.toggle("on", !!(want && String(el.getAttribute("data-tree-id")).toUpperCase() === want));
      });
      Array.prototype.forEach.call(layer.querySelectorAll("path.annot-ink"), (el) => {
        el.classList.toggle("on", !!(want && String(el.getAttribute("data-tree-id")).toUpperCase() === want));
      });
    }
    const want = treeId ? String(treeId).toUpperCase() : "";
    state.trees.forEach((t) => {
      if (!t.leafletMarker) return;
      const on = !!(want && String(t.id).toUpperCase() === want);
      try {
        if (t.leafletMarker.setStyle) {
          t.leafletMarker.setStyle({
            radius: on ? 3 : 2.75,
            weight: 1,
            color: on ? "#93c5fd" : "#fbbf24",
            fillColor: on ? "#3b82f6" : "#f59e0b",
            fillOpacity: 0.95
          });
        }
        if (on && t.leafletMarker.openTooltip) t.leafletMarker.openTooltip();
        else if (t.leafletMarker.closeTooltip) t.leafletMarker.closeTooltip();
      } catch (e) { /* ignore */ }
    });
  }

  function updateTreeXy(treeId, x, y, pathOpt) {
    const want = String(treeId || "").toUpperCase();
    const t = state.trees.find((x0) => String(x0.id).toUpperCase() === want);
    if (!t) return false;
    // Incoming x/y/path are in active sheet %; persist in original % when on a crop
    const mapped = origPctFromSheet(Number(x), Number(y));
    const nx = Math.max(0, Math.min(100, mapped.x));
    const ny = Math.max(0, Math.min(100, mapped.y));
    if (!isFinite(nx) || !isFinite(ny)) return false;
    const ox = t.x != null && isFinite(Number(t.x)) ? Number(t.x) : nx;
    const oy = t.y != null && isFinite(Number(t.y)) ? Number(t.y) : ny;
    if (pathOpt && Array.isArray(pathOpt)) {
      const remapped = remapPathToOrig(pathOpt);
      t.path = simplifyPath(remapped) || normalizePath(remapped);
    } else if (t.path && t.path.length && (nx !== ox || ny !== oy)) {
      t.path = translatePath(t.path, nx - ox, ny - oy);
    }
    t.x = nx;
    t.y = ny;
    t.props = t.props || {};
    t.props.x = Number(nx.toFixed(2));
    t.props.y = Number(ny.toFixed(2));
    if (t.feature) {
      t.feature.properties = t.feature.properties || t.props;
      t.feature.properties.x = t.props.x;
      t.feature.properties.y = t.props.y;
    }
    schedulePersist();
    // Keep overlay marker + ink path in sync (may already be at this %)
    const layer = $("map-annotate-layer");
    if (layer) {
      Array.prototype.forEach.call(layer.querySelectorAll(".annot-marker"), (el) => {
        if (String(el.getAttribute("data-tree-id") || "").toUpperCase() !== want) return;
        el.style.left = nx.toFixed(3) + "%";
        el.style.top = ny.toFixed(3) + "%";
        el.classList.toggle("has-path", !!(t.path && t.path.length >= 2));
      });
      Array.prototype.forEach.call(layer.querySelectorAll("path.annot-ink"), (el) => {
        if (String(el.getAttribute("data-tree-id") || "").toUpperCase() !== want) return;
        if (t.path && t.path.length >= 2) {
          el.setAttribute("d", pathToSvgD(t.path));
          el.removeAttribute("hidden");
        } else {
          el.setAttribute("d", "");
        }
      });
    }
    // Refresh list x/y; skip full re-render while a field editor is open
    const box = $("tree-list");
    if (box && box.querySelector(".tree-list-field.editing")) {
      Array.prototype.forEach.call(box.querySelectorAll(".tree-list-row"), (row) => {
        if (String(row.getAttribute("data-tree-id") || "").toUpperCase() !== want) return;
        const xCell = row.querySelector(".tree-list-xy-x");
        const yCell = row.querySelector(".tree-list-xy-y");
        if (xCell) {
          xCell.textContent = fmtXy(nx);
          xCell.classList.remove("empty");
        }
        if (yCell) {
          yCell.textContent = fmtXy(ny);
          yCell.classList.remove("empty");
        }
      });
    } else {
      renderTreeList();
      syncTreeListHighlight();
    }
    return true;
  }

  function deleteTree(treeId) {
    const idx = state.trees.findIndex((t) => String(t.id).toUpperCase() === String(treeId).toUpperCase());
    if (idx < 0) return;
    const t = state.trees[idx];
    if (t.leafletMarker && state.leafletAnnotLayer) {
      try { state.leafletAnnotLayer.removeLayer(t.leafletMarker); } catch (e) { /* ignore */ }
    }
    state.trees.splice(idx, 1);
    renderTreeList();
    if (window.GpkgMedia && window.GpkgMedia.getState && String(window.GpkgMedia.getState().treeId || "").toUpperCase() === String(treeId).toUpperCase()) {
      window.GpkgMedia.setSelectedTree(null, null);
    }
    schedulePersist();
    setImportStatus("已刪除 " + treeId, "");
  }

  function treeExportBasename() {
    return (state.sourceName ? String(state.sourceName).replace(/\.[^.]+$/, "") : "trees");
  }

  function isAppleTouchDevice() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent || "") ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function dataURLToBlob(dataUrl) {
    const parts = String(dataUrl || "").split(",");
    const header = parts[0] || "";
    const data = parts[1] || "";
    const mimeMatch = header.match(/data:([^;]+)/);
    const mime = (mimeMatch && mimeMatch[1]) || "application/octet-stream";
    const bin = atob(data);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }

  function triggerBlobDownload(blob, filename) {
    if (!blob) return false;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "download";
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    // iPad Safari: click must stay in user-gesture turn when possible
    a.click();
    setTimeout(function () {
      try { a.remove(); } catch (_) {}
      try { URL.revokeObjectURL(url); } catch (_) {}
    }, 2500);
    return true;
  }

  function tryShareFile(blob, filename) {
    try {
      if (!navigator.share || !navigator.canShare) return null;
      const file = new File([blob], filename || "download", {
        type: (blob && blob.type) || "application/octet-stream"
      });
      if (!navigator.canShare({ files: [file] })) return null;
      return navigator.share({ files: [file], title: filename || "download" });
    } catch (_) {
      return null;
    }
  }

  function collectTreeExportRows() {
    return state.trees.map((t) => {
      const p = t.props || {};
      const x = t.x != null ? Number(t.x).toFixed(2) : "";
      const y = t.y != null ? Number(t.y).toFixed(2) : "";
      const lat = p.Latitude != null ? p.Latitude : "";
      const lng = p.Longitude != null ? p.Longitude : "";
      const src = t.source || (t.annot ? "annotate" : "import");
      const rec = p.Recommendation != null ? p.Recommendation : (p["建議"] != null ? p["建議"] : "");
      return {
        "Tree ID": String(t.id),
        Species: p.Species != null ? p.Species : "",
        DBH: p.DBH != null ? p.DBH : "",
        Height: p.Height != null ? p.Height : "",
        Spread: p.Spread != null ? p.Spread : "",
        Remarks: p.Remarks != null ? p.Remarks : "",
        Recommendation: rec,
        Defect: p.Defect != null ? p.Defect : "",
        Location: p.Location != null ? p.Location : "",
        x: x,
        y: y,
        Latitude: lat,
        Longitude: lng,
        Source: src
      };
    });
  }

  function exportTreeListCsv() {
    if (!state.trees.length) {
      setImportStatus("清單是空的，無可匯出", "warn");
      return;
    }
    function csvCell(v) {
      if (v == null) return "";
      const s = String(v).replace(/"/g, '""');
      return /[",\n\r]/.test(s) ? ('"' + s + '"') : s;
    }
    const cols = ["Tree ID", "Species", "DBH", "Height", "Spread", "Remarks", "Recommendation", "Defect", "Location", "x", "y", "Latitude", "Longitude", "Source"];
    const rows = collectTreeExportRows();
    const lines = [cols.join(",")];
    rows.forEach((row) => {
      lines.push(cols.map((c) => csvCell(row[c])).join(","));
    });
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    triggerBlobDownload(blob, treeExportBasename() + "_annotate.csv");
    setImportStatus("已匯出 CSV（" + state.trees.length + " 棵）", "ok");
  }

  function exportTreeListXlsx() {
    if (!state.trees.length) {
      setImportStatus("清單是空的，無可匯出", "warn");
      return;
    }
    if (typeof XLSX === "undefined") {
      setImportStatus("Excel 匯出庫未載入", "error");
      return;
    }
    const rows = collectTreeExportRows();
    const ws = XLSX.utils.json_to_sheet(rows, {
      header: ["Tree ID", "Species", "DBH", "Height", "Spread", "Remarks", "Recommendation", "Defect", "Location", "x", "y", "Latitude", "Longitude", "Source"]
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Trees");
    const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    triggerBlobDownload(blob, treeExportBasename() + "_annotate.xlsx");
    setImportStatus("已匯出 Excel（" + state.trees.length + " 棵）", "ok");
  }

  function drawStrokeOnCanvas(ctx, pts, color, widthPx) {
    if (!pts || pts.length < 2 || !ctx) return;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    ctx.save();
    ctx.strokeStyle = color || "#38bdf8";
    ctx.lineWidth = Math.max(1, widthPx || 2.25);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    pts.forEach(function (p, i) {
      const x = (Number(p.x) / 100) * w;
      const y = (Number(p.y) / 100) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }

  /** Rasterize map image + ink / markers to PNG and download (iPad Safari friendly). */
  async function saveMapCompositePng() {
    const img = getMapRefMediaEl();
    if (!img || !img.naturalWidth) {
      setImportStatus("請先匯入地圖圖片（PNG／JPG；PDF 會自動轉影像後可儲存）", "warn");
      return;
    }
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh) {
      setImportStatus("地圖影像尚未就緒", "warn");
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = nw;
    canvas.height = nh;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setImportStatus("無法建立畫布", "error");
      return;
    }
    try {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, nw, nh);
      ctx.drawImage(img, 0, 0, nw, nh);
    } catch (err) {
      console.warn(err);
      setImportStatus("無法讀取地圖影像（請重新匯入）", "error");
      return;
    }

    const layer = $("map-annotate-layer");
    const layerW = (layer && layer.clientWidth) || nw;
    // vector-effect non-scaling-stroke ≈ CSS px on layer; scale to natural pixels
    const pxScale = nw / Math.max(1, layerW);

    (state.drawStrokes || []).forEach(function (s) {
      const inkPts = (s && s.path && s.path.length >= 2) ? s.path : null;
      if (!inkPts) return;
      const col = (s.color && String(s.color)) || state.inkColor || "#38bdf8";
      const w = (isFinite(Number(s.width)) && Number(s.width) > 0) ? Number(s.width) : (state.inkWidth || 2.25);
      drawStrokeOnCanvas(ctx, inkPts, col, w * pxScale);
    });

    state.trees.forEach(function (t) {
      if (t.x == null || t.y == null || !isFinite(t.x) || !isFinite(t.y)) return;
      const disp = sheetPctFromOrig(t.x, t.y);
      if (disp.x < -8 || disp.x > 108 || disp.y < -8 || disp.y > 108) return;
      const inkPtsRaw = (t.path && t.path.length >= 2) ? t.path : null;
      const inkPts = inkPtsRaw ? remapPathToSheet(inkPtsRaw) : null;
      if (inkPts) {
        drawStrokeOnCanvas(ctx, inkPts, "#fbbf24", 2.25 * pxScale);
      }
      const cx = (Number(disp.x) / 100) * nw;
      const cy = (Number(disp.y) / 100) * nh;
      const r = Math.max(4, 5 * pxScale);
      ctx.save();
      ctx.fillStyle = "#fbbf24";
      ctx.strokeStyle = "#0e1510";
      ctx.lineWidth = Math.max(1, 1.25 * pxScale);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const label = String(t.id || "");
      if (label) {
        const fs = Math.max(10, Math.round(11 * pxScale));
        ctx.font = "700 " + fs + "px system-ui, -apple-system, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const tx = cx + r + 3 * pxScale;
        const ty = cy;
        const tw = ctx.measureText(label).width;
        const pad = 2 * pxScale;
        ctx.fillStyle = "rgba(251, 191, 36, 0.92)";
        ctx.fillRect(tx - pad, ty - fs * 0.6, tw + pad * 2, fs * 1.2);
        ctx.fillStyle = "#0e1510";
        ctx.fillText(label, tx, ty);
      }
      ctx.restore();
    });

    const sheet = getActiveMapSheet();
    const sheetTag = (sheet && sheet.kind === "crop" && sheet.label) ? ("_" + sheet.label) : "";
    const base = (state.mapRefName ? String(state.mapRefName).replace(/\.[^.]+$/, "") : "map") + sheetTag + "_ink.png";
    setImportStatus("正在產生地圖 PNG…", "");

    // Cap output size so iPad Safari can finish toDataURL inside the user-gesture turn
    let out = canvas;
    const maxEdge = 4096;
    const longEdge = Math.max(nw, nh);
    if (longEdge > maxEdge) {
      const s = maxEdge / longEdge;
      const scaled = document.createElement("canvas");
      scaled.width = Math.max(1, Math.round(nw * s));
      scaled.height = Math.max(1, Math.round(nh * s));
      const sctx = scaled.getContext("2d");
      if (sctx) {
        sctx.fillStyle = "#ffffff";
        sctx.fillRect(0, 0, scaled.width, scaled.height);
        sctx.drawImage(canvas, 0, 0, scaled.width, scaled.height);
        out = scaled;
      }
    }

    let blob = null;
    try {
      const dataUrl = out.toDataURL("image/png");
      blob = dataURLToBlob(dataUrl);
    } catch (err) {
      console.warn("toDataURL failed, trying toBlob", err);
    }

    function finishDownload(b) {
      if (!b) {
        setImportStatus("PNG 產生失敗", "error");
        return;
      }
      // iPad: Share sheet is the most reliable "Save to Files / Photos" path
      if (isAppleTouchDevice()) {
        const shared = tryShareFile(b, base);
        if (shared) {
          shared.then(function () {
            setImportStatus("已儲存地圖 PNG（含墨跡）", "ok");
          }).catch(function (err) {
            if (err && err.name === "AbortError") {
              // User cancelled share — still try anchor download
              triggerBlobDownload(b, base);
              setImportStatus("已取消分享；已嘗試下載 PNG", "warn");
              return;
            }
            triggerBlobDownload(b, base);
            setImportStatus("已下載地圖 PNG（含墨跡）", "ok");
          });
          setImportStatus("請在分享選單選擇「儲存到檔案」／相片", "");
          return;
        }
      }
      triggerBlobDownload(b, base);
      setImportStatus("已儲存地圖 PNG（含墨跡）", "ok");
    }

    if (blob) {
      finishDownload(blob);
      return;
    }
    await new Promise(function (resolve) {
      if (!out.toBlob) {
        setImportStatus("PNG 下載失敗（瀏覽器不支援）", "error");
        resolve();
        return;
      }
      out.toBlob(function (b) {
        finishDownload(b);
        resolve();
      }, "image/png");
    });
  }

  function showIdDialog() {
    const dlg = $("annot-id-dialog");
    const input = $("annot-id-input");
    if (!dlg) return;
    dlg.hidden = false;
    if (input) {
      input.value = nextAutoId();
      setTimeout(() => { input.focus(); input.select(); }, 30);
    }
  }

  function hideIdDialog() {
    const dlg = $("annot-id-dialog");
    if (dlg) dlg.hidden = true;
    state.pendingPlace = null;
  }

  function confirmIdDialog() {
    const input = $("annot-id-input");
    const id = input ? input.value : "";
    const place = state.pendingPlace;
    if (!place) {
      hideIdDialog();
      return;
    }
    const ok = commitPlace(id, place);
    if (ok) {
      state.pendingPlace = null;
      const dlg = $("annot-id-dialog");
      if (dlg) dlg.hidden = true;
    }
  }

  function bindAnnotOverlayPointers(layer) {
    // Bind on #map-ref-viewer so letterbox + zoom chrome still receive Pencil/pen.
    // Zoom uses layout-size enlargement (not CSS scale), so layer rect == hit-test box.
    const viewer = $("map-ref-viewer");
    if (!layer || !viewer || viewer._annotPtrBound) return;
    viewer._annotPtrBound = true;

    const LONG_MS = 450;
    const MOVE_CANCEL_PX = 14;       // finger
    const MOVE_CANCEL_PEN_PX = 44;   // Apple Pencil tip jitter / palm micro-move
    const SHORT_TAP_MS = 420;        // brief pen contact still counts as tap-to-place
    let gesture = null;
    let suppressClickUntil = 0;

    function moveCancelPx(g) {
      const pt = (g && g.pointerType) || "";
      return (pt === "pen" || pt === "mouse") ? MOVE_CANCEL_PEN_PX : MOVE_CANCEL_PX;
    }

    /** Path span in %-of-map units — tiny dots should not become ink in 加樹 mode. */
    function pathSpanPct(pts) {
      if (!pts || !pts.length) return 0;
      let minX = pts[0].x, maxX = pts[0].x, minY = pts[0].y, maxY = pts[0].y;
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i];
        if (!p) continue;
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      return Math.hypot(maxX - minX, maxY - minY);
    }

    function clearLongTimer() {
      if (gesture && gesture.longTimer) {
        clearTimeout(gesture.longTimer);
        gesture.longTimer = null;
      }
    }

    function endGesture() {
      clearLongTimer();
      if (gesture && gesture.marker) {
        gesture.marker.classList.remove("pressing", "dragging");
      }
      clearPreview();
      gesture = null;
    }

    function pctFromClient(clientX, clientY) {
      return pctFromEvent(layer, clientX, clientY);
    }

    /** Visual AABB hit-test — robust when target/elementFromPoint misses small markers. */
    function hitTestMarkerAt(clientX, clientY) {
      const nodes = layer.querySelectorAll(".annot-marker");
      for (let i = 0; i < nodes.length; i++) {
        const r = nodes[i].getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
          return nodes[i];
        }
      }
      return null;
    }

    function findMarkerEl(treeId) {
      if (!treeId) return null;
      const want = String(treeId).toUpperCase();
      const nodes = layer.querySelectorAll(".annot-marker");
      for (let i = 0; i < nodes.length; i++) {
        if (String(nodes[i].getAttribute("data-tree-id") || "").toUpperCase() === want) return nodes[i];
      }
      return null;
    }

    function findInkEl(treeId) {
      if (!treeId) return null;
      const want = String(treeId).toUpperCase();
      const nodes = layer.querySelectorAll("path.annot-ink");
      for (let i = 0; i < nodes.length; i++) {
        if (String(nodes[i].getAttribute("data-tree-id") || "").toUpperCase() === want) return nodes[i];
      }
      return null;
    }

    function clearPreview() {
      const prev = layer.querySelector(".annot-ink-preview");
      if (!prev) return;
      prev.setAttribute("hidden", "");
      prev.setAttribute("d", "");
    }

    function showPreview(pts) {
      let prev = layer.querySelector(".annot-ink-preview");
      if (!prev) {
        let svg = layer.querySelector("svg.annot-ink-svg");
        if (!svg) {
          svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          svg.setAttribute("class", "annot-ink-svg");
          svg.setAttribute("viewBox", "0 0 100 100");
          svg.setAttribute("preserveAspectRatio", "none");
          svg.setAttribute("aria-hidden", "true");
          layer.insertBefore(svg, layer.firstChild);
        }
        prev = document.createElementNS("http://www.w3.org/2000/svg", "path");
        prev.setAttribute("class", "annot-ink-preview");
        prev.setAttribute("fill", "none");
        prev.setAttribute("vector-effect", "non-scaling-stroke");
        svg.appendChild(prev);
      }
      if (!pts || !pts.length) {
        prev.setAttribute("hidden", "");
        prev.setAttribute("d", "");
        return;
      }
      prev.removeAttribute("hidden");
      prev.setAttribute("d", pathToSvgD(pts));
      const prefs = (gesture && gesture.inkColor)
        ? { color: gesture.inkColor, width: gesture.inkWidth }
        : currentInkPrefs();
      const col = prefs.color || "#38bdf8";
      const w = prefs.width || 2.25;
      prev.setAttribute("stroke", col);
      prev.setAttribute("stroke-width", String(w));
      prev.style.stroke = col;
      prev.style.strokeWidth = String(w);
    }

    function beginDrag() {
      if (!gesture || !gesture.marker) return;
      const t = state.trees.find(function (x) {
        return String(x.id).toUpperCase() === String(gesture.treeId || "").toUpperCase();
      });
      gesture.dragging = true;
      gesture.marker.classList.remove("pressing");
      gesture.marker.classList.add("dragging");
      // Drag math runs in active sheet % (markers are rendered remapped on crops)
      const originSheet = (t && t.x != null && t.y != null)
        ? sheetPctFromOrig(Number(t.x), Number(t.y))
        : null;
      gesture.originX = originSheet ? originSheet.x : null;
      gesture.originY = originSheet ? originSheet.y : null;
      gesture.basePath = (t && t.path && t.path.length)
        ? remapPathToSheet(t.path.map(function (p) { return { x: p.x, y: p.y }; }))
        : (gesture.originX != null ? [{ x: gesture.originX, y: gesture.originY }] : null);
      gesture.livePath = gesture.basePath;
      try { gesture.marker.setPointerCapture(gesture.pointerId); } catch (_) {}
      selectTreeFromList(gesture.treeId);
      setImportStatus("拖移 " + gesture.treeId + " …鬆開後儲存位置", "ok");
    }

    function applyDragVisual(clientX, clientY) {
      if (!gesture || !gesture.marker) return null;
      const pct = pctFromClient(clientX, clientY);
      if (!pct) return null;
      gesture.marker.style.left = pct.x.toFixed(3) + "%";
      gesture.marker.style.top = pct.y.toFixed(3) + "%";
      if (gesture.basePath && gesture.basePath.length && gesture.originX != null && gesture.originY != null) {
        const dx = pct.x - gesture.originX;
        const dy = pct.y - gesture.originY;
        gesture.livePath = translatePath(gesture.basePath, dx, dy);
        const ink = findInkEl(gesture.treeId);
        if (ink && gesture.livePath && gesture.livePath.length >= 2) {
          ink.setAttribute("d", pathToSvgD(gesture.livePath));
        }
      }
      return pct;
    }

    function startDraw(e, firstPct) {
      const prefs = currentInkPrefs();
      gesture = {
        pointerId: e.pointerId,
        pointerType: e.pointerType || "pen",
        mode: "draw",
        marker: null,
        treeId: null,
        startX: e.clientX,
        startY: e.clientY,
        t0: Date.now(),
        longTimer: null,
        dragging: false,
        suppressed: false,
        place: false,
        panning: false,
        points: firstPct ? [firstPct] : [],
        inkColor: prefs.color,
        inkWidth: prefs.width
      };
      try { viewer.setPointerCapture(e.pointerId); } catch (_) {}
      showPreview(gesture.points);
    }

    function finishDraw(e) {
      const g = gesture;
      const pts = simplifyPath(g && g.points ? g.points : null) || normalizePath(g && g.points);
      const travel = (g && isFinite(g.startX) && isFinite(g.startY))
        ? Math.hypot(e.clientX - g.startX, e.clientY - g.startY)
        : 0;
      clearPreview();
      try { viewer.releasePointerCapture(e.pointerId); } catch (_) {}
      endGesture();
      // v101: 加樹 + Pencil — treat brief / tiny strokes as place, not ink
      const slop = moveCancelPx(g);
      const span = pathSpanPct(pts);
      const held = (g && g.t0) ? (Date.now() - g.t0) : 0;
      const isShortTap = state.annotateMode && (
        (travel <= slop && span < 2.5) ||
        (held <= SHORT_TAP_MS && span < 3.5 && travel <= slop * 1.35)
      );
      if (isShortTap) {
        suppressClickUntil = Date.now() + 450;
        const pct = pctFromClient(e.clientX, e.clientY);
        if (!pct) {
          setImportStatus("無法加樹：座標無效", "warn");
          return;
        }
        const usePts = (pts && pts.length) ? pts : [{ x: pct.x, y: pct.y }];
        const c = pathCentroid(usePts) || pct;
        beginPlace({ x: c.x, y: c.y, path: usePts, lat: null, lng: null, source: "map-ref" });
        if (state.idMode !== "manual") renderAnnotOverlay();
        return;
      }
      suppressClickUntil = Date.now() + 450;
      if (!pts || pts.length < 2) return; // ignore tiny dots — not ink
      state.drawStrokes = state.drawStrokes || [];
      const prefs = currentInkPrefs();
      const strokeColor = (g && g.inkColor) || prefs.color || "#38bdf8";
      const strokeWidth = (g && g.inkWidth) || prefs.width || 2.25;
      state.drawStrokes.push({
        path: pts,
        color: strokeColor,
        width: strokeWidth
      });
      // Cap session ink so localStorage stays bounded
      if (state.drawStrokes.length > 400) {
        state.drawStrokes = state.drawStrokes.slice(-400);
      }
      saveCurrentMapInk();
      schedulePersist();
      renderAnnotOverlay();
      setImportStatus("已畫墨跡（不加樹）· 共 " + state.drawStrokes.length + " 筆", "ok");
    }

    // Claim Apple Pencil early (capture) so Safari scroll/Scribble cannot cancel the pointer stream
    viewer.addEventListener("touchstart", (e) => {
      if (state.cropMode) return;
      if (!layer.classList.contains("active")) return;
      if (!e.touches || !e.touches.length) return;
      let stylus = false;
      for (let i = 0; i < e.touches.length; i++) {
        const tt = e.touches[i].touchType;
        if (tt === "stylus" || tt === "pen") { stylus = true; break; }
      }
      if (!stylus) return;
      e.preventDefault();
      e.stopPropagation();
    }, { passive: false, capture: true });

    viewer.addEventListener("pointerdown", (e) => {
      // Ink draw works whenever the layer is active (map-ref). Tree place needs 加樹 mode.
      if (state.cropMode) return; // crop overlay owns pointers
      if (!layer.classList.contains("active")) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // Ignore UI chrome inside the viewer (zoom is in toolbar outside viewer)

      const hitMarker = (e.target && e.target.closest && e.target.closest(".annot-marker")) || hitTestMarkerAt(e.clientX, e.clientY);
      const hitInk = e.target && e.target.closest && e.target.closest("path.annot-ink");
      let tid = null;
      let hit = null;
      if (hitMarker && layer.contains(hitMarker)) {
        hit = hitMarker;
        tid = hitMarker.getAttribute("data-tree-id");
      } else if (hitInk && layer.contains(hitInk)) {
        tid = hitInk.getAttribute("data-tree-id");
        hit = findMarkerEl(tid);
      }

      if (hit && tid) {
        e.preventDefault();
        e.stopPropagation();
        gesture = {
          pointerId: e.pointerId,
          mode: "marker",
          marker: hit,
          treeId: tid,
          startX: e.clientX,
          startY: e.clientY,
          longTimer: null,
          dragging: false,
          suppressed: false,
          place: false,
          panning: false,
          originX: null,
          originY: null,
          basePath: null,
          livePath: null
        };
        hit.classList.add("pressing");
        gesture.longTimer = setTimeout(() => {
          if (!gesture || gesture.pointerId !== e.pointerId || gesture.suppressed) return;
          beginDrag();
        }, LONG_MS);
        return;
      }

      const pct = pctFromClient(e.clientX, e.clientY);
      const isPenLike = e.pointerType === "pen" || e.pointerType === "mouse";

      // Pen / mouse: when 加樹 on, pending short-tap places; move → freehand ink.
      // When 加樹 off, freehand draw immediately (draw-only).
      if (isPenLike) {
        e.preventDefault();
        e.stopPropagation();
        if (state.annotateMode) {
          gesture = {
            pointerId: e.pointerId,
            pointerType: e.pointerType || "pen",
            mode: "pen-pending",
            marker: null,
            treeId: null,
            startX: e.clientX,
            startY: e.clientY,
            t0: Date.now(),
            longTimer: null,
            dragging: false,
            suppressed: false,
            place: true,
            panning: false,
            ox: 0,
            oy: 0,
            points: pct ? [pct] : []
          };
          try { viewer.setPointerCapture(e.pointerId); } catch (_) {}
          return;
        }
        startDraw(e, pct);
        return;
      }

      // Touch: pending — short tap places; drag when zoomed pans; drag unzoomed draws
      gesture = {
        pointerId: e.pointerId,
        pointerType: e.pointerType || "touch",
        mode: "touch-pending",
        marker: null,
        treeId: null,
        startX: e.clientX,
        startY: e.clientY,
        t0: Date.now(),
        longTimer: null,
        dragging: false,
        suppressed: false,
        place: true,
        panning: false,
        ox: 0,
        oy: 0,
        points: pct ? [pct] : []
      };
    }, { passive: false });

    viewer.addEventListener("pointermove", (e) => {
      if (!gesture || gesture.pointerId !== e.pointerId) return;
      const dx = e.clientX - gesture.startX;
      const dy = e.clientY - gesture.startY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (gesture.mode === "draw") {
        e.preventDefault();
        const pct = pctFromClient(e.clientX, e.clientY);
        if (pct) {
          const last = gesture.points[gesture.points.length - 1];
          if (!last || Math.hypot(pct.x - last.x, pct.y - last.y) >= 0.12) {
            gesture.points.push(pct);
            showPreview(gesture.points);
          }
        }
        return;
      }

      if (gesture.panning) {
        e.preventDefault();
        state.mapRefZoom.x = gesture.ox - dx;
        state.mapRefZoom.y = gesture.oy - dy;
        applyMapRefZoom();
        return;
      }

      if ((gesture.mode === "touch-pending" || gesture.mode === "pen-pending") && !gesture.dragging) {
        if (dist > moveCancelPx(gesture)) {
          gesture.suppressed = true;
          // Finger pan when zoomed — never create a tree from a pan (touch only)
          if (gesture.mode === "touch-pending" && state.mapRefZoom.scale > 1.01) {
            gesture.panning = true;
            gesture.place = false;
            gesture.mode = "pan";
            gesture.ox = state.mapRefZoom.x;
            gesture.oy = state.mapRefZoom.y;
            e.preventDefault();
            state.mapRefZoom.x = gesture.ox - dx;
            state.mapRefZoom.y = gesture.oy - dy;
            applyMapRefZoom();
            return;
          }
          // Moved past tap threshold → freehand draw (ink only; no tree)
          // Keep t0/pointerType so finishDraw can still recover a brief Pencil tap as 加樹
          gesture.mode = "draw";
          gesture.place = false;
          if (!gesture.t0) gesture.t0 = Date.now();
          const ink = currentInkPrefs();
          gesture.inkColor = ink.color;
          gesture.inkWidth = ink.width;
          try { viewer.setPointerCapture(e.pointerId); } catch (_) {}
          const pct = pctFromClient(e.clientX, e.clientY);
          if (pct) gesture.points.push(pct);
          showPreview(gesture.points);
          e.preventDefault();
          return;
        }
        // Track early samples for a possible short freehand / place centroid
        const pct = pctFromClient(e.clientX, e.clientY);
        if (pct && gesture.points) {
          const last = gesture.points[gesture.points.length - 1];
          if (!last || Math.hypot(pct.x - last.x, pct.y - last.y) >= 0.12) {
            gesture.points.push(pct);
          }
        }
        return;
      }

      if (!gesture.dragging) {
        if (dist > MOVE_CANCEL_PX) {
          gesture.suppressed = true;
          clearLongTimer();
          if (gesture.marker) gesture.marker.classList.remove("pressing");
        }
        return;
      }
      e.preventDefault();
      applyDragVisual(e.clientX, e.clientY);
    }, { passive: false });

    function finishPointer(e) {
      if (!gesture || gesture.pointerId !== e.pointerId) return;
      const g = gesture;
      clearLongTimer();

      if (g.mode === "draw") {
        e.preventDefault();
        e.stopPropagation();
        finishDraw(e);
        return;
      }

      if (g.dragging && g.marker && g.treeId) {
        e.preventDefault();
        e.stopPropagation();
        const pct = applyDragVisual(e.clientX, e.clientY) || pctFromClient(e.clientX, e.clientY);
        g.marker.classList.remove("dragging", "pressing");
        try { g.marker.releasePointerCapture(g.pointerId); } catch (_) {}
        suppressClickUntil = Date.now() + 500;
        if (pct) {
          updateTreeXy(g.treeId, pct.x, pct.y, g.livePath || null);
          setImportStatus(
            "已移動 " + g.treeId + " · x " + fmtXy(pct.x) + "% y " + fmtXy(pct.y) + "%",
            "ok"
          );
        }
        endGesture();
        return;
      }

      const wasSuppressed = g.suppressed || g.panning || g.mode === "pan";
      const marker = g.marker;
      const treeId = g.treeId;
      const place = g.place;
      const touchPts = g.points;
      endGesture();
      if (wasSuppressed) {
        suppressClickUntil = Date.now() + 300;
        return;
      }
      if (marker && treeId) {
        suppressClickUntil = Date.now() + 450;
        selectTreeFromList(treeId);
        return;
      }
      // Short tap places tree in 加樹 mode (touch / pen / mouse pending)
      if (place && state.annotateMode) {
        suppressClickUntil = Date.now() + 450;
        const pct = pctFromClient(e.clientX, e.clientY);
        if (!pct) {
          setImportStatus("無法加樹：座標無效", "warn");
          return;
        }
        const pts = (touchPts && touchPts.length) ? simplifyPath(touchPts) : [{ x: pct.x, y: pct.y }];
        const c = pathCentroid(pts) || pct;
        beginPlace({ x: c.x, y: c.y, path: pts, lat: null, lng: null, source: "map-ref" });
        if (state.idMode !== "manual") renderAnnotOverlay();
      }
    }

    viewer.addEventListener("pointerup", finishPointer, { passive: false });
    viewer.addEventListener("pointercancel", (e) => {
      if (!gesture || gesture.pointerId !== e.pointerId) return;
      if (gesture.mode === "draw") {
        // Safari often cancels Pencil mid-stroke (scroll/Scribble); keep ink if we sampled a path
        if (gesture.points && gesture.points.length >= 2) {
          finishDraw(e);
          return;
        }
        clearPreview();
        try { viewer.releasePointerCapture(e.pointerId); } catch (_) {}
        endGesture();
        suppressClickUntil = Date.now() + 300;
        return;
      }
      if (gesture.dragging && gesture.marker) {
        const t = state.trees.find((x) => String(x.id).toUpperCase() === String(gesture.treeId || "").toUpperCase());
        if (t && t.x != null && t.y != null) {
          gesture.marker.style.left = Number(t.x).toFixed(3) + "%";
          gesture.marker.style.top = Number(t.y).toFixed(3) + "%";
          const ink = findInkEl(gesture.treeId);
          if (ink && t.path && t.path.length >= 2) ink.setAttribute("d", pathToSvgD(t.path));
        }
        try { gesture.marker.releasePointerCapture(gesture.pointerId); } catch (_) {}
      }
      endGesture();
      suppressClickUntil = Date.now() + 300;
    }, { passive: false });

    viewer.addEventListener("click", (e) => {
      if (Date.now() < suppressClickUntil) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Mouse click fallback: if no freehand completed, treat as tap-place / select
      // (pen/mouse freehand already handled on pointerup; this catches marker select edge cases)
      const hitInk = e.target && e.target.closest && e.target.closest("path.annot-ink");
      if (hitInk) {
        const tid = hitInk.getAttribute("data-tree-id");
        if (tid) {
          selectTreeFromList(tid);
          return;
        }
      }
      handleOverlayClick(e);
    });
  }

  function initAnnotControls() {
    function toggleMode() {
      setAnnotateMode(!state.annotateMode);
    }
    ["btn-annot-mode", "btn-annot-mode-bar", "btn-annot-mode-float"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("click", toggleMode);
    });
    document.addEventListener("click", (e) => {
      const seg = e.target.closest && e.target.closest(".annot-seg[data-id-mode]");
      if (!seg) return;
      setIdMode(seg.getAttribute("data-id-mode"));
    });
    ["btn-annot-export", "btn-annot-export-bar", "btn-annot-export-float", "btn-annot-export-list"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("click", exportTreeListCsv);
    });
    ["btn-annot-export-xlsx", "btn-annot-export-xlsx-bar", "btn-annot-export-xlsx-list"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("click", exportTreeListXlsx);
    });

    const layer = $("map-annotate-layer");
    if (layer) {
      bindAnnotOverlayPointers(layer);
    }
    ensureAnnotLayerObserver();
    syncAnnotLayerToContent();
    window.addEventListener("resize", function () {
      applyMapRefZoom();
    });

    const ok = $("btn-annot-id-ok");
    const cancel = $("btn-annot-id-cancel");
    const input = $("annot-id-input");
    if (ok) ok.addEventListener("click", confirmIdDialog);
    if (cancel) cancel.addEventListener("click", hideIdDialog);
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); confirmIdDialog(); }
        if (e.key === "Escape") { e.preventDefault(); hideIdDialog(); }
      });
    }
    const dlg = $("annot-id-dialog");
    if (dlg) {
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg) hideIdDialog();
      });
    }

    setIdMode("auto");
    setAnnotateMode(false);
    updateFloatBarVisibility(document.body.classList.contains("has-map-ref"));
  }

  function init() {
    const treeBox = $("tree-list");
    if (treeBox) bindTreeListInteractions(treeBox);
    initHideMediaToggle();
    initHideMapToggle();
    initHideTreesToggle();
    initTreeListPdfImport();
    bindProjectBackupUi();

    function isExcelOrCsvFile(file) {
      if (!file) return false;
      const name = (file.name || "").toLowerCase();
      const type = (file.type || "").toLowerCase();
      if (/\.(xlsx|xls|csv)$/i.test(name)) return true;
      if (type.indexOf("csv") >= 0) return true;
      if (type.indexOf("sheet") >= 0 || type.indexOf("excel") >= 0) return true;
      if (type === "application/vnd.ms-excel") return true;
      if (type === "text/csv" || type === "text/plain") {
        // allow plain text only when extension looks like csv (handled above) — skip
      }
      return false;
    }
    function bindExcelInput(el) {
      if (!el) return;
      el.addEventListener("change", () => {
        const f = el.files && el.files[0];
        if (!f) {
          el.value = "";
          return;
        }
        if (!isExcelOrCsvFile(f)) {
          setImportStatus("請選擇 Excel／CSV 檔（.xlsx／.xls／.csv；目前：" + (f.name || "未知類型") + "）", "warn");
          el.value = "";
          return;
        }
        importExcelFile(f).catch((err) => {
          console.error(err);
          setImportStatus("Excel 匯入失敗：" + (err && err.message ? err.message : err), "error");
        });
        el.value = "";
      });
    }
    bindExcelInput($("excel-file-input"));
    bindExcelInput($("excel-file-input-side"));

    function bindMapInput(el) {
      if (!el) return;
      el.addEventListener("change", () => {
        const f = el.files && el.files[0];
        if (!f) {
          el.value = "";
          return;
        }
        const fname = f.name || "";
        const ftype = (f.type || "").toLowerCase();
        const isPdf = /\.pdf$/i.test(fname) || ftype.indexOf("pdf") >= 0;
        const isImage = /^image\//.test(ftype) ||
          /\.(png|jpe?g|gif|webp|bmp|heic|heif|tif{1,2})$/i.test(fname);
        if (!isPdf && !isImage) {
          setImportStatus("請選擇 PDF 或圖片檔（目前：" + (fname || "未知類型") + "）", "warn");
          el.value = "";
          return;
        }
        showMapRef(f);
        el.value = "";
      });
    }
    bindMapInput($("map-ref-file-input"));
    bindMapInput($("map-ref-file-input-side"));

    const btnClearMap = $("btn-map-ref-clear");
    if (btnClearMap) btnClearMap.addEventListener("click", clearMapRef);

    const btnMapSave = $("btn-map-save");
    if (btnMapSave && !btnMapSave._mapSaveBound) {
      btnMapSave._mapSaveBound = true;
      const runSave = function (ev) {
        if (ev) {
          ev.preventDefault();
          ev.stopPropagation();
        }
        setImportStatus("儲存地圖中…", "");
        try {
          const ret = saveMapCompositePng();
          if (ret && typeof ret.then === "function") {
            ret.catch(function (err) {
              console.error(err);
              setImportStatus("儲存地圖失敗：" + (err && err.message ? err.message : err), "error");
            });
          }
        } catch (err) {
          console.error(err);
          setImportStatus("儲存地圖失敗：" + (err && err.message ? err.message : err), "error");
        }
      };
      btnMapSave.addEventListener("click", runSave);
    }

    const mzin = $("map-ref-zoom-in");
    const mzout = $("map-ref-zoom-out");
    const mzreset = $("map-ref-zoom-reset");
    if (mzin) mzin.addEventListener("click", () => stepMapRefZoom(1));
    if (mzout) mzout.addEventListener("click", () => stepMapRefZoom(-1));
    if (mzreset) mzreset.addEventListener("click", () => resetMapRefZoom());
    bindMapRefZoomGestures();

    const btnToggleMap = $("btn-map-ref-toggle");
    if (btnToggleMap) {
      btnToggleMap.addEventListener("click", () => {
        if (!state.mapRefUrl) {
          setImportStatus("尚未匯入地圖 PDF／圖片", "warn");
          return;
        }
        document.body.classList.toggle("force-map-ref");
        updateMapRefVisibility();
        schedulePersist();
      });
    }

    initAnnotControls();
    bindInkControls();
    bindMapCropUi();

    // Re-evaluate visibility when vectors change (poll light)
    setInterval(function () {
      updateMapRefVisibility();
      ensureLeafletAnnotBinding();
    }, 1500);

    // Restore annotated/imported trees after GpkgViewer boots
    setTimeout(function () {
      restoreSession().catch((err) => console.warn("restoreSession", err));
    }, 400);
  }

  function setTrees(trees, sourceName) {
    clearLeafletAnnotMarkers();
    state.trees = (trees || []).map((t) => Object.assign({ x: null, y: null, annot: false, leafletMarker: null }, t));
    state.sourceName = sourceName || "";
    renderTreeList();
    schedulePersist();
  }

  function applyTreeAttr(treeId, key, value) {
    if (!treeId || !key) return;
    if (key === "Tree ID" || key === "TreeID" || key === "treeId") {
      renameTreeId(treeId, value);
      return;
    }
    const want = String(treeId).trim().toUpperCase();
    state.trees.forEach((t) => {
      if (String(t.id).trim().toUpperCase() !== want) return;
      t.props = t.props || {};
      t.props[key] = value;
      if (t.feature) {
        t.feature.properties = t.feature.properties || t.props;
        t.feature.properties[key] = value;
      }
      if (t.leafletMarker && t.leafletMarker.feature && t.leafletMarker.feature.properties) {
        t.leafletMarker.feature.properties[key] = value;
      }
    });
    schedulePersist();
    // Keep list row in sync without fighting an open inline editor
    const box = $("tree-list");
    if (box && !box.querySelector(".tree-list-field.editing")) {
      const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const wantId = String(treeId).toUpperCase();
      box.querySelectorAll('.tree-list-field[data-field="' + esc(key) + '"]').forEach((el) => {
        if (String(el.getAttribute("data-tree-id") || "").toUpperCase() !== wantId) return;
        el.textContent = displayListVal(value);
        el.classList.toggle("empty", value == null || value === "");
      });
    }
  }

  window.GpkgImport = {
    importExcelFile: importExcelFile,
    showMapRef: showMapRef,
    clearMapRef: clearMapRef,
    clearTreeList: clearTreeList,
    setTrees: setTrees,
    renderTreeList: renderTreeList,
    syncTreeListHighlight: syncTreeListHighlight,
    updateMapRefVisibility: updateMapRefVisibility,
    getTrees: function () { return state.trees.slice(); },
    getState: function () { return state; },
    applyTreeAttr: applyTreeAttr,
    renameTreeId: renameTreeId,
    persistSession: persistSession,
    restoreSession: restoreSession,
    applyHideMedia: applyHideMedia,
    applyHideMap: applyHideMap,
    applyHideTrees: applyHideTrees,
    isAnnotateMode: function () { return !!state.annotateMode; },
    setAnnotateMode: setAnnotateMode,
    handleLeafletClick: handleLeafletClick,
    exportTreeListCsv: exportTreeListCsv,
    exportTreeListXlsx: exportTreeListXlsx,
    saveMapCompositePng: saveMapCompositePng,
    updateTreeXy: updateTreeXy
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
