/**
 * Excel / CSV tree-list import + map PDF/image reference panel.
 * Works without a GeoPackage. Hooks into window.GpkgViewer (set by app.js).
 */
(function () {
  "use strict";

  const ID_HEADER_HINTS = [
    "tree id", "treeid", "tree_id", "tree-id",
    "tree_no", "tree no", "treeno", "tree number", "treenumber", "tree_num",
    "plant id", "plantid", "asset id", "assetid",
    "樹號", "树木编号", "樹木編號", "樹木编号", "树木編號", "編號", "编号",
    "id", "fid", "gid"
  ];

  const SPECIES_HINTS = ["species", "scientific", "學名", "树种", "樹種", "chinese name", "中文名"];
  const DBH_HINTS = ["dbh", "diameter", "胸徑", "胸径"];
  const DEFECT_HINTS = ["defect", "缺陷", "condition", "remarks", "備註", "备注"];
  const LOCATION_HINTS = ["location", "位置", "site", "address", "地點", "地点"];
  const LAT_HINTS = ["lat", "latitude", "緯度", "纬度", "y_wgs", "wgs_y", "wgs84_y"];
  const LON_HINTS = ["lon", "lng", "long", "longitude", "經度", "经度", "x_wgs", "wgs_x", "wgs84_x"];
  const X_HINTS = ["x", "easting", "east", "hk_e", "hk1980_e", "東距", "东距"];
  const Y_HINTS = ["y", "northing", "north", "hk_n", "hk1980_n", "北距"];

  const state = {
    trees: [],          // { id, props, feature, hasCoords }
    sourceName: "",
    mapRefUrl: null,
    mapRefKind: null,   // "pdf" | "image"
    mapRefName: "",
    objectUrls: []
  };

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function normHeader(h) {
    return String(h == null ? "" : h).trim().toLowerCase().replace(/[\s_\-]+/g, " ");
  }

  function compactHeader(h) {
    return normHeader(h).replace(/\s+/g, "");
  }

  function findCol(headers, hints) {
    const norms = headers.map((h) => ({ raw: h, n: normHeader(h), c: compactHeader(h) }));
    for (const hint of hints) {
      const hn = normHeader(hint);
      const hc = compactHeader(hint);
      const hit = norms.find((x) => x.n === hn || x.c === hc);
      if (hit) return hit.raw;
    }
    // partial contains for longer hints
    for (const hint of hints) {
      const hn = normHeader(hint);
      if (hn.length < 2) continue;
      const hit = norms.find((x) => x.n.indexOf(hn) >= 0 || hn.indexOf(x.n) >= 0);
      if (hit) return hit.raw;
    }
    return null;
  }

  function findIdCol(headers) {
    // Prefer explicit tree-id style over bare "id"
    const strong = ID_HEADER_HINTS.filter((h) => h !== "id" && h !== "fid" && h !== "gid" && h !== "編號" && h !== "编号");
    let col = findCol(headers, strong);
    if (col) return col;
    col = findCol(headers, ["編號", "编号", "id", "fid", "gid"]);
    return col;
  }

  function rememberUrl(url) {
    if (url && String(url).indexOf("blob:") === 0) state.objectUrls.push(url);
    return url;
  }

  function revokeMapRefUrl() {
    if (state.mapRefUrl && String(state.mapRefUrl).indexOf("blob:") === 0) {
      try { URL.revokeObjectURL(state.mapRefUrl); } catch (e) { /* ignore */ }
    }
    state.mapRefUrl = null;
    state.mapRefKind = null;
    state.mapRefName = "";
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
    const headers = rows[0].map((h) => String(h || "").trim());
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r];
      if (!cells || !cells.some((c) => String(c || "").trim() !== "")) continue;
      const obj = {};
      headers.forEach((h, i) => { obj[h || ("col" + i)] = cells[i] != null ? cells[i] : ""; });
      out.push(obj);
    }
    return out;
  }

  function sheetRowsToObjects(sheet) {
    if (typeof XLSX === "undefined") throw new Error("SheetJS (XLSX) not loaded");
    return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
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
    const wb = XLSX.read(buf, { type: "array" });
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

  function renameNice(props, fromKey, toKey) {
    if (!fromKey || fromKey === toKey) return;
    if (props[toKey] != null && props[toKey] !== "") return;
    if (props[fromKey] == null || props[fromKey] === "") return;
    props[toKey] = props[fromKey];
  }

  function rowsToFeatures(rows) {
    if (!rows || !rows.length) throw new Error("表格沒有資料列");
    const headers = Object.keys(rows[0]);
    const idCol = findIdCol(headers);
    if (!idCol) {
      throw new Error("找不到樹木編號欄（Tree ID / tree_no / 樹號 / ID …）");
    }
    const speciesCol = findCol(headers, SPECIES_HINTS);
    const dbhCol = findCol(headers, DBH_HINTS);
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
      // Canonical keys for media matching / UI
      props["Tree ID"] = id;
      renameNice(props, speciesCol, "Species");
      renameNice(props, dbhCol, "DBH");
      renameNice(props, defectCol, "Defect");
      renameNice(props, locCol, "Location");

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
    return { features: features, idCol: idCol };
  }

  function renderTreeList() {
    const box = $("tree-list");
    const panel = $("tree-list-panel");
    const countEl = $("tree-list-count");
    if (!box) return;
    if (!state.trees.length) {
      if (panel) panel.hidden = true;
      box.innerHTML = "";
      if (countEl) countEl.textContent = "";
      document.body.classList.remove("has-tree-list");
      return;
    }
    document.body.classList.add("has-tree-list");
    if (panel) panel.hidden = false;
    if (countEl) {
      const withCoords = state.trees.filter((t) => t.hasCoords).length;
      countEl.textContent = state.trees.length + " 棵" +
        (withCoords ? "（" + withCoords + " 有座標）" : "（無座標 — 請用清單選樹）");
    }
    const selected = (window.GpkgMedia && window.GpkgMedia.getState)
      ? window.GpkgMedia.getState().treeId
      : null;
    let html = "";
    state.trees.forEach((t) => {
      const sp = t.props.Species || t.props.species || "";
      const on = selected && String(selected).toUpperCase() === String(t.id).toUpperCase();
      html += '<button type="button" class="tree-list-item' + (on ? " on" : "") + '" data-tree-id="' +
        escapeHtml(t.id) + '">' +
        '<strong>' + escapeHtml(t.id) + '</strong>' +
        (sp ? '<span class="tree-list-sp">' + escapeHtml(String(sp)) + "</span>" : "") +
        (t.hasCoords ? '<span class="tree-list-pin" title="有座標">📍</span>' : "") +
        "</button>";
    });
    box.innerHTML = html;
  }

  function selectTreeFromList(treeId) {
    const t = state.trees.find((x) => String(x.id).toUpperCase() === String(treeId).toUpperCase());
    if (!t) return;
    // Highlight in list
    const box = $("tree-list");
    if (box) {
      Array.prototype.forEach.call(box.querySelectorAll(".tree-list-item"), (el) => {
        el.classList.toggle("on", String(el.getAttribute("data-tree-id")).toUpperCase() === String(treeId).toUpperCase());
      });
    }
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
    // Excel-only lists without coords keep the PDF visible.
    const show = !!(state.mapRefUrl) && (!hasMapped || document.body.classList.contains("force-map-ref"));
    panel.hidden = !show;
    document.body.classList.toggle("has-map-ref", show);
    const mapEl = $("map");
    if (mapEl) mapEl.classList.toggle("map-ref-active", show);
    if (window.GpkgViewer && window.GpkgViewer.invalidateMap) {
      setTimeout(() => window.GpkgViewer.invalidateMap(), 50);
    }
  }

  function showMapRef(file) {
    revokeMapRefUrl();
    const name = file.name || "map";
    const lower = name.toLowerCase();
    const url = rememberUrl(URL.createObjectURL(file));
    state.mapRefUrl = url;
    state.mapRefName = name;

    const frame = $("map-ref-frame");
    const img = $("map-ref-img");
    const label = $("map-ref-label");

    if (/\.pdf$/i.test(lower) || (file.type && file.type.indexOf("pdf") >= 0)) {
      state.mapRefKind = "pdf";
      if (img) { img.hidden = true; img.removeAttribute("src"); }
      if (frame) {
        frame.hidden = false;
        frame.src = url;
      }
    } else {
      state.mapRefKind = "image";
      if (frame) { frame.hidden = true; frame.removeAttribute("src"); }
      if (img) {
        img.hidden = false;
        img.src = url;
        img.alt = name;
      }
    }
    if (label) label.textContent = "地圖參考 · " + name;
    // Prefer showing reference when no GPKG vectors yet
    document.body.classList.remove("force-map-ref");
    updateMapRefVisibility();
    // If vectors exist, still show briefly with force so user sees import worked; then leave toggle
    if (window.GpkgViewer && window.GpkgViewer.hasMappedPoints && window.GpkgViewer.hasMappedPoints()) {
      // Keep Leaflet markers visible by default; user can toggle PDF
      document.body.classList.remove("force-map-ref");
      updateMapRefVisibility();
    }
    setImportStatus("已載入地圖參考：" + name, "ok");
  }

  function clearMapRef() {
    revokeMapRefUrl();
    const frame = $("map-ref-frame");
    const img = $("map-ref-img");
    if (frame) { frame.hidden = true; frame.removeAttribute("src"); }
    if (img) { img.hidden = true; img.removeAttribute("src"); }
    document.body.classList.remove("force-map-ref");
    updateMapRefVisibility();
    setImportStatus("已清除地圖參考", "");
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
    const rows = await readTableFile(file);
    const parsed = rowsToFeatures(rows);
    const features = parsed.features;

    state.sourceName = file.name;
    state.trees = features.map((ft) => ({
      id: String((ft.properties && ft.properties["Tree ID"]) || ""),
      props: ft.properties || {},
      feature: ft,
      hasCoords: !!(ft.geometry && ft.geometry.type === "Point")
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
    setImportStatus(
      "已匯入 Excel／CSV：" + state.trees.length + " 棵樹" +
      (nCoord ? "（" + nCoord + " 有座標）" : "（無座標 — 請用左側清單選樹）"),
      "ok"
    );
    updateMapRefVisibility();
  }

  function syncTreeListHighlight(treeId) {
    const box = $("tree-list");
    if (!box || !state.trees.length) return;
    Array.prototype.forEach.call(box.querySelectorAll(".tree-list-item"), (el) => {
      const id = el.getAttribute("data-tree-id");
      el.classList.toggle("on", treeId && String(id).toUpperCase() === String(treeId).toUpperCase());
    });
  }

  function clearTreeList() {
    state.trees = [];
    state.sourceName = "";
    renderTreeList();
  }

  function init() {
    const treeBox = $("tree-list");
    if (treeBox) {
      treeBox.addEventListener("click", (e) => {
        const btn = e.target.closest(".tree-list-item");
        if (!btn) return;
        selectTreeFromList(btn.getAttribute("data-tree-id"));
      });
    }

    function bindExcelInput(el) {
      if (!el) return;
      el.addEventListener("change", () => {
        const f = el.files && el.files[0];
        if (f) importExcelFile(f).catch((err) => {
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
        if (f) showMapRef(f);
        el.value = "";
      });
    }
    bindMapInput($("map-ref-file-input"));
    bindMapInput($("map-ref-file-input-side"));

    const btnClearMap = $("btn-map-ref-clear");
    if (btnClearMap) btnClearMap.addEventListener("click", clearMapRef);

    const btnToggleMap = $("btn-map-ref-toggle");
    if (btnToggleMap) {
      btnToggleMap.addEventListener("click", () => {
        if (!state.mapRefUrl) {
          setImportStatus("尚未匯入地圖 PDF／圖片", "warn");
          return;
        }
        document.body.classList.toggle("force-map-ref");
        updateMapRefVisibility();
      });
    }

    // Re-evaluate visibility when vectors change (poll light)
    setInterval(updateMapRefVisibility, 1500);
  }

  function setTrees(trees, sourceName) {
    state.trees = trees || [];
    state.sourceName = sourceName || "";
    renderTreeList();
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
    getState: function () { return state; }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
