/**
 * Excel / CSV tree-list import + map PDF/image reference panel + from-scratch annotate.
 * Works without a GeoPackage. Hooks into window.GpkgViewer (set by app.js).
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

  const SPECIES_HINTS = ["species", "scientific", "學名", "树种", "樹種", "chinese name", "中文名"];
  const DBH_HINTS = ["dbh", "diameter", "胸徑", "胸径"];
  const HEIGHT_HINTS = ["overall height (m)", "overall height", "height_m", "height", "高度"];
  const SPREAD_HINTS = ["crown spread (m)", "crown spread", "spread_m", "spread", "crown", "冠幅"];
  const DEFECT_HINTS = ["defect", "缺陷", "condition", "remarks", "備註", "备注"];
  const LOCATION_HINTS = ["location", "位置", "site", "address", "地點", "地点"];
  const LAT_HINTS = ["lat", "latitude", "緯度", "纬度", "y_wgs", "wgs_y", "wgs84_y"];
  const LON_HINTS = ["lon", "lng", "long", "longitude", "經度", "经度", "x_wgs", "wgs_x", "wgs84_x"];
  const X_HINTS = ["x", "easting", "east", "hk_e", "hk1980_e", "東距", "东距"];
  const Y_HINTS = ["y", "northing", "north", "hk_n", "hk1980_n", "北距"];

  const state = {
    trees: [],          // { id, props, feature, hasCoords, x, y, annot, leafletMarker }
    sourceName: "",
    mapRefUrl: null,
    mapRefKind: null,   // "pdf" | "image"
    mapRefName: "",
    objectUrls: [],
    annotateMode: false,
    idMode: "auto",     // "auto" | "manual"
    pendingPlace: null, // { x, y, lat, lng, source }
    leafletAnnotLayer: null,
    leafletBound: false
  };

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
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
    const headers = rows[0].map((h) => stripBom(String(h || "")).trim());
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
    // Normalize BOM on keys (CSV / some Excel exports)
    rows = rows.map((row) => {
      const out = {};
      Object.keys(row).forEach((k) => {
        out[stripBom(k).trim() || k] = row[k];
      });
      return out;
    });
    const headers = Object.keys(rows[0]);
    const resolved = resolveIdCol(headers, rows);
    const idCol = resolved.col;
    if (!idCol) {
      throw new Error("找不到樹木編號欄。現有欄名：" + (headers.map((h) => stripBom(h).trim() || "(空白)").join("、") || "（無）"));
    }
    const speciesCol = findCol(headers, SPECIES_HINTS);
    const dbhCol = findCol(headers, DBH_HINTS);
    const heightCol = findCol(headers, HEIGHT_HINTS);
    const spreadCol = findCol(headers, SPREAD_HINTS);
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
      renameNice(props, heightCol, "Height");
      renameNice(props, spreadCol, "Spread");
      renameNice(props, defectCol, "Defect");
      renameNice(props, locCol, "Location");
      // Ensure metrics exist for attrs card (empty editable)
      if (!Object.prototype.hasOwnProperty.call(props, "DBH")) props.DBH = "";
      if (!Object.prototype.hasOwnProperty.call(props, "Height")) props.Height = "";
      if (!Object.prototype.hasOwnProperty.call(props, "Spread")) props.Spread = "";

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
    return { features: features, idCol: idCol, idColNote: resolved.note };
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
      if (panel) panel.hidden = true;
      box.innerHTML = "";
      if (countEl) countEl.textContent = "";
      document.body.classList.remove("has-tree-list");
      renderAnnotOverlay();
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
    let html = "";
    state.trees.forEach((t) => {
      const sp = t.props.Species || t.props.species || "";
      const on = selected && String(selected).toUpperCase() === String(t.id).toUpperCase();
      const xy = (t.x != null && t.y != null)
        ? '<span class="tree-list-xy" title="Relative x/y %">x ' + fmtXy(t.x) + '% · y ' + fmtXy(t.y) + "%</span>"
        : "";
      html += '<div class="tree-list-row' + (on ? " on" : "") + '" data-tree-id="' + escapeHtml(t.id) + '">' +
        '<button type="button" class="tree-list-item' + (on ? " on" : "") + '" data-tree-id="' +
        escapeHtml(t.id) + '">' +
        '<strong>' + escapeHtml(t.id) + '</strong>' +
        (sp ? '<span class="tree-list-sp">' + escapeHtml(String(sp)) + "</span>" : "") +
        xy +
        (t.hasCoords ? '<span class="tree-list-pin" title="有座標">📍</span>' : "") +
        "</button>" +
        '<button type="button" class="tree-list-del" data-del-id="' + escapeHtml(t.id) +
        '" title="刪除 Delete" aria-label="刪除 ' + escapeHtml(t.id) + '">✕</button>' +
        "</div>";
    });
    box.innerHTML = html;
    renderAnnotOverlay();
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
        const btn = el.querySelector(".tree-list-item");
        if (btn) btn.classList.toggle("on", on);
      });
      Array.prototype.forEach.call(box.querySelectorAll(".tree-list-item"), (el) => {
        el.classList.toggle("on", String(el.getAttribute("data-tree-id")).toUpperCase() === String(treeId).toUpperCase());
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

  function showMapRef(file) {
    revokeMapRefUrl();
    hideMapRefViewers();
    const name = file.name || "map";
    const lower = name.toLowerCase();
    const url = rememberUrl(URL.createObjectURL(file));
    state.mapRefUrl = url;
    state.mapRefName = name;

    const frame = $("map-ref-frame");
    const obj = $("map-ref-object");
    const emb = $("map-ref-embed");
    const img = $("map-ref-img");
    const label = $("map-ref-label");
    const openTab = $("map-ref-open-tab");

    if (/\.pdf$/i.test(lower) || (file.type && file.type.indexOf("pdf") >= 0)) {
      state.mapRefKind = "pdf";
      // Safari often fails blob: PDF inside iframe — prefer <object> with nested <embed> fallback
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
        // Keep iframe hidden; object/embed cover Safari. Link below always works.
        frame.hidden = true;
        frame.removeAttribute("src");
      }
      if (openTab) {
        openTab.hidden = false;
        openTab.href = url;
        openTab.setAttribute("download", name);
        openTab.textContent = "新分頁開啟地圖 PDF";
      }
    } else {
      state.mapRefKind = "image";
      if (img) {
        img.hidden = false;
        img.src = url;
        img.alt = name;
      }
      if (openTab) {
        openTab.hidden = false;
        openTab.href = url;
        openTab.removeAttribute("download");
        openTab.textContent = "新分頁開啟地圖圖片";
      }
    }
    if (label) label.textContent = "地圖參考 · " + name;
    // Always force-show after import so user sees PDF/image immediately
    // (even if Leaflet demo trees / GPKG markers exist — toggle can switch back)
    document.body.classList.add("force-map-ref");
    updateMapRefVisibility();
    renderAnnotOverlay();
    setImportStatus("已載入地圖參考：" + name + "（可按「切換地圖」返回 Leaflet；可開「加樹模式」點擊加樹）", "ok");
  }

  function clearMapRef() {
    revokeMapRefUrl();
    hideMapRefViewers();
    document.body.classList.remove("force-map-ref");
    updateMapRefVisibility();
    renderAnnotOverlay();
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
  }

  function syncTreeListHighlight(treeId) {
    const box = $("tree-list");
    if (!box || !state.trees.length) return;
    Array.prototype.forEach.call(box.querySelectorAll(".tree-list-row"), (el) => {
      const id = el.getAttribute("data-tree-id");
      const on = treeId && String(id).toUpperCase() === String(treeId).toUpperCase();
      el.classList.toggle("on", on);
      const btn = el.querySelector(".tree-list-item");
      if (btn) btn.classList.toggle("on", on);
    });
    highlightAnnotMarker(treeId);
  }

  function clearTreeList() {
    clearLeafletAnnotMarkers();
    state.trees = [];
    state.sourceName = "";
    renderTreeList();
  }

  /* ---------- From-scratch annotate mode ---------- */

  function existingIdSet() {
    const s = {};
    state.trees.forEach((t) => { s[String(t.id).toUpperCase()] = true; });
    return s;
  }

  function nextAutoId() {
    const used = existingIdSet();
    let n = 1;
    while (used["T" + n]) n += 1;
    return "T" + n;
  }

  function setIdMode(mode) {
    state.idMode = mode === "manual" ? "manual" : "auto";
    Array.prototype.forEach.call(document.querySelectorAll(".annot-seg[data-id-mode]"), (btn) => {
      btn.classList.toggle("on", btn.getAttribute("data-id-mode") === state.idMode);
    });
    updateAnnotUi();
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
        btn.textContent = state.annotateMode ? "加樹 · 開" : "加樹模式";
      }
    });
    const layer = $("map-annotate-layer");
    if (layer) {
      layer.classList.toggle("active", state.annotateMode);
      layer.setAttribute("aria-hidden", state.annotateMode ? "false" : "true");
    }
    updatePdfHint();
    updateAnnotUi();
    ensureLeafletAnnotBinding();
    updateFloatBarVisibility(document.body.classList.contains("has-map-ref"));
    if (state.annotateMode) {
      setImportStatus(
        state.idMode === "manual"
          ? "加樹模式（手動編號）：點地圖後輸入編號"
          : "加樹模式（自動編號）：點地圖放置 T1、T2…",
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
    const show = state.annotateMode && state.mapRefKind === "pdf" && document.body.classList.contains("has-map-ref");
    hint.hidden = !show;
  }

  function updateAnnotUi() {
    const hint = $("annot-hint");
    if (hint) {
      if (state.annotateMode) {
        hint.textContent = state.idMode === "manual"
          ? "手動編號：點地圖後輸入樹木 ID。座標以檢視框 % 記錄。"
          : "自動編號：點地圖依序 T1、T2…（略過已有編號）。PNG／JPG 最佳。";
      } else {
        hint.textContent = "開啟「加樹模式」後，點地圖圖片或 Leaflet 放置樹木。PNG／JPG 地圖最合適。";
      }
    }
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
    const x = place && place.x != null ? Number(place.x) : null;
    const y = place && place.y != null ? Number(place.y) : null;
    const props = {
      "Tree ID": id,
      Species: "",
      DBH: "",
      Height: "",
      Spread: "",
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
    setImportStatus("已加樹 " + id + (x != null ? (" · x " + fmtXy(x) + "% y " + fmtXy(y) + "%") : ""), "ok");
    return true;
  }

  function addLeafletAnnotMarker(tree) {
    try {
      const map = window.GpkgViewer && window.GpkgViewer.getMap && window.GpkgViewer.getMap();
      if (!map || typeof L === "undefined") return null;
      ensureLeafletAnnotLayer(map);
      const ll = L.latLng(tree.feature.geometry.coordinates[1], tree.feature.geometry.coordinates[0]);
      const marker = L.circleMarker(ll, {
        radius: 7,
        color: "#fbbf24",
        weight: 2,
        fillColor: "#f59e0b",
        fillOpacity: 0.9,
        className: "annot-leaflet-marker"
      });
      marker.bindTooltip(String(tree.id), { permanent: true, direction: "top", offset: [0, -8], className: "annot-leaflet-label" });
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
    let html = "";
    state.trees.forEach((t) => {
      if (t.x == null || t.y == null) return;
      // Only show overlay markers for map-ref annotations (or all — useful when map-ref visible)
      html += '<button type="button" class="annot-marker" data-tree-id="' + escapeHtml(t.id) +
        '" style="left:' + Number(t.x).toFixed(3) + "%;top:" + Number(t.y).toFixed(3) + '%" title="' +
        escapeHtml(t.id) + '">' +
        '<span class="annot-marker-dot"></span>' +
        '<span class="annot-marker-label">' + escapeHtml(t.id) + "</span>" +
        "</button>";
    });
    layer.innerHTML = html;
    const selected = (window.GpkgMedia && window.GpkgMedia.getState)
      ? window.GpkgMedia.getState().treeId
      : null;
    if (selected) highlightAnnotMarker(selected);
  }

  function highlightAnnotMarker(treeId) {
    const layer = $("map-annotate-layer");
    if (!layer) return;
    Array.prototype.forEach.call(layer.querySelectorAll(".annot-marker"), (el) => {
      el.classList.toggle("on", treeId && String(el.getAttribute("data-tree-id")).toUpperCase() === String(treeId).toUpperCase());
    });
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
    setImportStatus("已刪除 " + treeId, "");
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
    const lines = ["Tree ID,Species,DBH,Height,Spread,Defect,Location,x,y,Latitude,Longitude,Source"];
    state.trees.forEach((t) => {
      const p = t.props || {};
      const id = String(t.id);
      const x = t.x != null ? Number(t.x).toFixed(2) : "";
      const y = t.y != null ? Number(t.y).toFixed(2) : "";
      const lat = p.Latitude != null ? p.Latitude : "";
      const lng = p.Longitude != null ? p.Longitude : "";
      const src = t.source || (t.annot ? "annotate" : "import");
      lines.push([
        csvCell(id), csvCell(p.Species), csvCell(p.DBH), csvCell(p.Height), csvCell(p.Spread),
        csvCell(p.Defect), csvCell(p.Location), x, y, lat, lng, csvCell(src)
      ].join(","));
    });
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (state.sourceName ? String(state.sourceName).replace(/\.[^.]+$/, "") : "trees") + "_annotate.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 1500);
    setImportStatus("已匯出 CSV（" + state.trees.length + " 棵）", "ok");
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
    ["btn-annot-export", "btn-annot-export-bar", "btn-annot-export-float"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("click", exportTreeListCsv);
    });

    const layer = $("map-annotate-layer");
    if (layer) {
      layer.addEventListener("click", handleOverlayClick);
    }

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
    if (treeBox) {
      treeBox.addEventListener("click", (e) => {
        const del = e.target.closest(".tree-list-del");
        if (del) {
          e.preventDefault();
          e.stopPropagation();
          deleteTree(del.getAttribute("data-del-id"));
          return;
        }
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

    initAnnotControls();

    // Re-evaluate visibility when vectors change (poll light)
    setInterval(function () {
      updateMapRefVisibility();
      ensureLeafletAnnotBinding();
    }, 1500);
  }

  function setTrees(trees, sourceName) {
    clearLeafletAnnotMarkers();
    state.trees = (trees || []).map((t) => Object.assign({ x: null, y: null, annot: false, leafletMarker: null }, t));
    state.sourceName = sourceName || "";
    renderTreeList();
  }

  function applyTreeAttr(treeId, key, value) {
    if (!treeId || !key) return;
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
    isAnnotateMode: function () { return !!state.annotateMode; },
    setAnnotateMode: setAnnotateMode,
    handleLeafletClick: handleLeafletClick,
    exportTreeListCsv: exportTreeListCsv
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
