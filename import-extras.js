/**
 * Excel / CSV tree-list import + map PDF/image reference panel + from-scratch annotate.
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

  const SPECIES_HINTS = ["species", "scientific", "學名", "树种", "樹種", "chinese name", "中文名"];
  const DBH_HINTS = ["dbh", "diameter", "胸徑", "胸径"];
  const HEIGHT_HINTS = ["overall height (m)", "overall height", "height_m", "height", "高度", "h"];
  const SPREAD_HINTS = ["crown spread (m)", "crown spread", "spread_m", "spread", "crown", "冠幅", "s"];
  const DEFECT_HINTS = ["defect", "缺陷", "condition"];
  const REMARKS_HINTS = ["remarks", "備註", "备注", "remark", "note", "notes", "註解", "附註"];
  const LOCATION_HINTS = ["location", "位置", "site", "address", "地點", "地点"];
  const LAT_HINTS = ["lat", "latitude", "緯度", "纬度", "y_wgs", "wgs_y", "wgs84_y"];
  const LON_HINTS = ["lon", "lng", "long", "longitude", "經度", "经度", "x_wgs", "wgs_x", "wgs84_x"];
  const X_HINTS = ["x", "easting", "east", "hk_e", "hk1980_e", "東距", "东距"];
  const Y_HINTS = ["y", "northing", "north", "hk_n", "hk1980_n", "北距"];

  const LS_SESSION = "tp-pane-session-trees";
  const LS_HIDE_MEDIA = "tp-pane-hide-media";
  const LS_INK_PREFS = "tp-pane-ink-prefs";
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
    const key = state.drawMapKey || mapInkKey(state.mapRefName);
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

  function bindInkControls() {
    loadInkPrefs();
    syncInkControlsUi();
    const colorEl = $("map-ink-color");
    const widthEl = $("map-ink-width");
    if (colorEl && !colorEl._inkBound) {
      colorEl._inkBound = true;
      colorEl.addEventListener("input", function () {
        state.inkColor = colorEl.value || "#38bdf8";
        saveInkPrefs();
      });
      colorEl.addEventListener("change", function () {
        state.inkColor = colorEl.value || "#38bdf8";
        saveInkPrefs();
      });
    }
    if (widthEl && !widthEl._inkBound) {
      widthEl._inkBound = true;
      widthEl.addEventListener("input", function () {
        const w = Number(widthEl.value);
        if (isFinite(w) && w > 0) state.inkWidth = w;
        saveInkPrefs();
      });
      widthEl.addEventListener("change", function () {
        const w = Number(widthEl.value);
        if (isFinite(w) && w > 0) state.inkWidth = w;
        saveInkPrefs();
      });
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

      if (state.mapRefMeta && state.mapRefMeta.name && !state.mapRefUrl) {
        setImportStatus(
          "已還原 " + state.trees.length + " 棵樹與標記。請重新匯入地圖：" + state.mapRefMeta.name,
          "warn"
        );
      } else {
        setImportStatus("已還原 " + state.trees.length + " 棵樹（本機自動儲存）", "ok");
      }
      if (state.trees.length) selectTreeFromList(state.trees[0].id);
    } finally {
      restoring = false;
    }
  }

  function updateMapRestoreHint() {
    let el = $("map-restore-hint");
    const need = !!(state.mapRefMeta && state.mapRefMeta.name && !state.mapRefUrl);
    if (!need) {
      if (el) el.hidden = true;
      return;
    }
    if (!el) {
      const panel = $("tree-list-panel");
      if (!panel) return;
      el = document.createElement("div");
      el.id = "map-restore-hint";
      el.className = "map-restore-hint";
      panel.insertBefore(el, panel.querySelector(".tree-list"));
    }
    el.hidden = false;
    el.innerHTML = "地圖檔無法自動還原 — 請重新<strong>匯入地圖</strong>：" +
      escapeHtml(state.mapRefMeta.name) +
      ' <label class="btn map-restore-btn">選擇地圖' +
      '<input type="file" accept=".pdf,image/*,application/pdf" hidden id="map-restore-file" /></label>';
    const inp = el.querySelector("#map-restore-file");
    if (inp && !inp._bound) {
      inp._bound = true;
      inp.addEventListener("change", () => {
        const f = inp.files && inp.files[0];
        if (f) showMapRef(f);
        inp.value = "";
      });
    }
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
    if (window.GpkgViewer && window.GpkgViewer.invalidateMap) {
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
          permanent: false, direction: "top", offset: [0, -4], className: "annot-leaflet-label"
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
    const isRemarks = f === "Remarks" || fl === "remarks" || f === "備註" || f === "备注";
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

  function removeListEditOverlay() {
    const el = document.getElementById("tree-list-edit-overlay");
    if (el && el.parentNode) el.parentNode.removeChild(el);
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
    if (fieldEl.classList.contains("tree-list-remarks") || fieldEl.classList.contains("tree-list-sp")) {
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
    const remarksCol = findCol(headers, REMARKS_HINTS);
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
      renameNice(props, remarksCol, "Remarks");
      renameNice(props, defectCol, "Defect");
      renameNice(props, locCol, "Location");
      // Ensure metrics / remarks exist for attrs card (empty editable)
      if (!Object.prototype.hasOwnProperty.call(props, "Species")) props.Species = "";
      if (!Object.prototype.hasOwnProperty.call(props, "DBH")) props.DBH = "";
      if (!Object.prototype.hasOwnProperty.call(props, "Height")) props.Height = "";
      if (!Object.prototype.hasOwnProperty.call(props, "Spread")) props.Spread = "";
      if (!Object.prototype.hasOwnProperty.call(props, "Remarks")) props.Remarks = "";

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
    if (img && !img.hidden && img.getAttribute("src") && img.naturalWidth > 0) return img;
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
        const base = (document.querySelector('script[src*="pdf.min.js"]') || {}).src || "vendor/pdf.min.js";
        lib.GlobalWorkerOptions.workerSrc = String(base).replace(/pdf\.min\.js(\?.*)?$/i, "pdf.worker.min.js$1");
      }
    } catch (e) { /* ignore */ }
    return lib;
  }

  /**
   * Rasterize PDF page 1 to a PNG blob URL and show via #map-ref-img so annotate
   * shares the same image content-box coordinate space as PNG/JPG maps.
   */
  function rasterizeMapRefPdf(pdfUrl) {
    const lib = ensurePdfjsForMapRef();
    if (!lib) return Promise.resolve(false);
    return (async function () {
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
   * Layout-size zoom (Option 1): enlarge #map-ref-zoom-stage width/height by scale,
   * pan with viewer scrollLeft/scrollTop. Never use transform:scale() — WebKit hit-tests
   * the untransformed box, which broke Apple Pencil above ~1.9×.
   * state.mapRefZoom.x/y are scroll offsets (CSS px).
   */
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

      const resetBtn = $("map-ref-zoom-reset");
      if (resetBtn) resetBtn.textContent = scale <= 1.01 ? "1×" : (Math.round(scale * 10) / 10) + "×";
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

    function finishShow(statusMsg) {
      if (label) label.textContent = "地圖參考 · " + name;
      document.body.classList.add("force-map-ref");
      state.mapRefMeta = { name: name, kind: state.mapRefKind };
      updateMapRefVisibility();
      ensureAnnotLayerObserver();
      applyMapRefZoom();
      renderAnnotOverlay();
      updateMapRestoreHint();
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
      // Prefer rasterized page-1 image so annotate % matches map pixels (same as PNG/JPG)
      setImportStatus("正在將 PDF 轉成影像以便加樹…", "");
      rasterizeMapRefPdf(url).then(function (ok) {
        if (ok) {
          finishShow("已載入地圖參考：" + name + "（PDF 第 1 頁影像 · 可直接畫墨跡）");
          return;
        }
        // Fallback: native PDF viewer (less accurate for annotate)
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
    finishShow("已載入地圖參考：" + name + "（可按「切換地圖」返回 Leaflet；可直接畫墨跡；開「加樹模式」短點加樹）");
  }

  function clearMapRef() {
    saveCurrentMapInk();
    revokeMapRefUrl();
    hideMapRefViewers();
    resetMapRefZoom();
    state.mapRefMeta = null;
    state.drawStrokes = [];
    state.drawMapKey = null;
    document.body.classList.remove("force-map-ref");
    updateMapRefVisibility();
    renderAnnotOverlay();
    updateMapRestoreHint();
    schedulePersist();
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
    schedulePersist();
  }

  function syncTreeListHighlight(treeId) {
    const box = $("tree-list");
    if (!box || !state.trees.length) return;
    Array.prototype.forEach.call(box.querySelectorAll(".tree-list-row"), (el) => {
      const id = el.getAttribute("data-tree-id");
      const on = treeId && String(id).toUpperCase() === String(treeId).toUpperCase();
      el.classList.toggle("on", on);
      el.setAttribute("aria-selected", on ? "true" : "false");
    });
    highlightAnnotMarker(treeId);
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
      setImportStatus(
        state.idMode === "manual"
          ? "加樹模式（手動編號）：短點地圖放置後輸入編號；長按標記可拖移。自由畫＝純墨跡，不加樹"
          : "加樹模式（自動編號）：短點地圖 → T1、T2…；長按標記可拖移。自由畫＝純墨跡，不加樹",
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
    const hint = $("annot-hint");
    if (hint) {
      if (state.annotateMode) {
        hint.textContent = state.idMode === "manual"
          ? "加樹（手動）：短點地圖後輸入 ID。自由畫＝純墨跡（不加樹）。長按標記可拖移；雙指縮放／平移。"
          : "加樹（自動）：短點地圖 → T1、T2…。自由畫＝純墨跡（不加樹）。長按標記可拖移；雙指縮放／平移。";
      } else {
        hint.textContent = "地圖可直接用 Pencil／手指畫墨跡（不加樹）。要加樹請開「加樹模式」再短點地圖。PNG／JPG 最佳。";
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
        radius: 2.75,
        color: "#fbbf24",
        weight: 1,
        fillColor: "#f59e0b",
        fillOpacity: 0.95,
        className: "annot-leaflet-marker",
        bubblingMouseEvents: false
      });
      marker.bindTooltip(String(tree.id), { permanent: false, direction: "top", offset: [0, -4], className: "annot-leaflet-label" });
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
        '" vector-effect="non-scaling-stroke"></path>';
    });
    state.trees.forEach((t) => {
      if (t.x == null || t.y == null) return;
      const tid = escapeHtml(t.id);
      const on = !!(selU && String(t.id).toUpperCase() === selU);
      const inkPts = (t.path && t.path.length >= 2) ? t.path : null;
      if (inkPts) {
        pathsHtml += '<path class="annot-ink' + (on ? " on" : "") + '" data-tree-id="' + tid +
          '" d="' + pathToSvgD(inkPts) + '" fill="none" vector-effect="non-scaling-stroke"></path>';
      }
      markersHtml += '<button type="button" class="annot-marker' + (inkPts ? " has-path" : "") +
        (on ? " on" : "") + '" data-tree-id="' + tid +
        '" style="left:' + Number(t.x).toFixed(3) + "%;top:" + Number(t.y).toFixed(3) + '%" title="' +
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
    const nx = Math.max(0, Math.min(100, Number(x)));
    const ny = Math.max(0, Math.min(100, Number(y)));
    if (!isFinite(nx) || !isFinite(ny)) return false;
    const ox = t.x != null && isFinite(Number(t.x)) ? Number(t.x) : nx;
    const oy = t.y != null && isFinite(Number(t.y)) ? Number(t.y) : ny;
    if (pathOpt && Array.isArray(pathOpt)) {
      t.path = simplifyPath(pathOpt) || normalizePath(pathOpt);
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
    const lines = ["Tree ID,Species,DBH,Height,Spread,Remarks,Defect,Location,x,y,Latitude,Longitude,Source"];
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
        csvCell(p.Remarks), csvCell(p.Defect), csvCell(p.Location), x, y, lat, lng, csvCell(src)
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

  function bindAnnotOverlayPointers(layer) {
    // Bind on #map-ref-viewer so letterbox + zoom chrome still receive Pencil/pen.
    // Zoom uses layout-size enlargement (not CSS scale), so layer rect == hit-test box.
    const viewer = $("map-ref-viewer");
    if (!layer || !viewer || viewer._annotPtrBound) return;
    viewer._annotPtrBound = true;

    const LONG_MS = 450;
    const MOVE_CANCEL_PX = 14;
    let gesture = null;
    let suppressClickUntil = 0;

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
      prev.setAttribute("stroke", state.inkColor || "#38bdf8");
      prev.setAttribute("stroke-width", String(state.inkWidth || 2.25));
    }

    function beginDrag() {
      if (!gesture || !gesture.marker) return;
      const t = state.trees.find(function (x) {
        return String(x.id).toUpperCase() === String(gesture.treeId || "").toUpperCase();
      });
      gesture.dragging = true;
      gesture.marker.classList.remove("pressing");
      gesture.marker.classList.add("dragging");
      gesture.originX = t && t.x != null ? Number(t.x) : null;
      gesture.originY = t && t.y != null ? Number(t.y) : null;
      gesture.basePath = (t && t.path && t.path.length)
        ? t.path.map(function (p) { return { x: p.x, y: p.y }; })
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
      gesture = {
        pointerId: e.pointerId,
        mode: "draw",
        marker: null,
        treeId: null,
        startX: e.clientX,
        startY: e.clientY,
        longTimer: null,
        dragging: false,
        suppressed: false,
        place: false,
        panning: false,
        points: firstPct ? [firstPct] : []
      };
      try { viewer.setPointerCapture(e.pointerId); } catch (_) {}
      showPreview(gesture.points);
    }

    function finishDraw(e) {
      const g = gesture;
      const pts = simplifyPath(g && g.points ? g.points : null) || normalizePath(g && g.points);
      clearPreview();
      try { viewer.releasePointerCapture(e.pointerId); } catch (_) {}
      endGesture();
      suppressClickUntil = Date.now() + 450;
      if (!pts || pts.length < 2) return; // ignore tiny dots — not ink
      state.drawStrokes = state.drawStrokes || [];
      state.drawStrokes.push({
        path: pts,
        color: state.inkColor || "#38bdf8",
        width: state.inkWidth || 2.25
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

      // Pen / mouse: freehand draw (primary)
      if (isPenLike) {
        e.preventDefault();
        e.stopPropagation();
        startDraw(e, pct);
        return;
      }

      // Touch: pending — short tap places; drag when zoomed pans; drag unzoomed draws
      gesture = {
        pointerId: e.pointerId,
        mode: "touch-pending",
        marker: null,
        treeId: null,
        startX: e.clientX,
        startY: e.clientY,
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

      if (gesture.mode === "touch-pending" && !gesture.dragging) {
        if (dist > MOVE_CANCEL_PX) {
          gesture.suppressed = true;
          if (state.mapRefZoom.scale > 1.01) {
            // Finger pan when zoomed — never create a tree from a pan
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
          // Unzoomed finger stroke → freehand draw
          gesture.mode = "draw";
          gesture.place = false;
          try { viewer.setPointerCapture(e.pointerId); } catch (_) {}
          const pct = pctFromClient(e.clientX, e.clientY);
          if (pct) gesture.points.push(pct);
          showPreview(gesture.points);
          e.preventDefault();
          return;
        }
        // Track early samples for a possible short freehand
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
      // Light touch tap still places (single-point / tiny mark)
      if (place && state.annotateMode && e.pointerType === "touch") {
        suppressClickUntil = Date.now() + 450;
        const pct = pctFromClient(e.clientX, e.clientY);
        if (!pct) return;
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
    ["btn-annot-export", "btn-annot-export-bar", "btn-annot-export-float"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("click", exportTreeListCsv);
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
    isAnnotateMode: function () { return !!state.annotateMode; },
    setAnnotateMode: setAnnotateMode,
    handleLeafletClick: handleLeafletClick,
    exportTreeListCsv: exportTreeListCsv,
    updateTreeXy: updateTreeXy
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
