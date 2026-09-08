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
  let persistTimer = null;
  let restoring = false;

  const state = {
    trees: [],          // { id, props, feature, hasCoords, x, y, annot, leafletMarker }
    sourceName: "",
    mapRefUrl: null,
    mapRefRasterUrl: null, // PNG/JPG blob used for annotate when PDF was rasterized
    mapRefKind: null,   // "pdf" | "image"
    mapRefName: "",
    mapRefMeta: null,   // { name, kind } when map blob cannot be restored
    mapRefZoom: { scale: 1, x: 0, y: 0 },
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
        annot: !!t.annot,
        source: t.source || (t.annot ? "annotate" : "import"),
        geometry: (t.feature && t.feature.geometry) ? t.feature.geometry : null
      };
    });
  }

  function persistSession() {
    persistTimer = null;
    if (restoring) return;
    const mapMeta = state.mapRefUrl
      ? { name: state.mapRefName || "", kind: state.mapRefKind || null }
      : (state.mapRefMeta || null);
    const payload = {
      v: 1,
      savedAt: Date.now(),
      sourceName: state.sourceName || "",
      idMode: state.idMode || "auto",
      forceMapRef: document.body.classList.contains("force-map-ref"),
      mapRef: mapMeta,
      trees: serializeTrees()
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
    if (!data || !Array.isArray(data.trees) || !data.trees.length) return;

    restoring = true;
    try {
      state.sourceName = data.sourceName || "";
      if (data.idMode) setIdMode(data.idMode);
      state.mapRefMeta = data.mapRef || null;

      clearLeafletAnnotMarkers();
      state.trees = data.trees.map((rec) => {
        const feature = rebuildFeature(rec);
        const hasCoords = !!(feature.geometry && feature.geometry.type === "Point");
        return {
          id: String(rec.id),
          props: feature.properties,
          feature: feature,
          hasCoords: hasCoords,
          x: rec.x == null || rec.x === "" ? null : Number(rec.x),
          y: rec.y == null || rec.y === "" ? null : Number(rec.y),
          annot: !!rec.annot,
          leafletMarker: null,
          source: rec.source || ""
        };
      });

      renderTreeList();

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
          permanent: true, direction: "top", offset: [0, -6], className: "annot-leaflet-label"
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

  /** Mobile/iPad keyboard hints for inline list edits. */
  function configureListInlineInput(inp, field) {
    if (!inp) return;
    inp.setAttribute("type", "text");
    const f = String(field || "");
    const fl = f.toLowerCase();
    const isMetric = f === "DBH" || f === "Height" || f === "Spread" ||
      fl === "dbh" || fl === "height" || fl === "spread";
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
      inp.setAttribute("autocomplete", "off");
      inp.setAttribute("spellcheck", isRemarks ? "true" : "false");
      return;
    }
    // Tree ID and other text fields
    inp.setAttribute("autocapitalize", "off");
    inp.setAttribute("autocomplete", "off");
  }

  function startTreeListFieldEdit(fieldEl) {
    if (!fieldEl || fieldEl.classList.contains("editing")) return;
    const treeId = fieldEl.getAttribute("data-tree-id");
    const field = fieldEl.getAttribute("data-field");
    if (!treeId || !field) return;
    const t = state.trees.find((x) => String(x.id).toUpperCase() === String(treeId).toUpperCase());
    if (!t) return;
    selectTreeFromList(treeId);
    const old = (field === "Tree ID")
      ? String(t.id)
      : (t.props && t.props[field] != null ? String(t.props[field]) : "");
    fieldEl.classList.add("editing");
    fieldEl.innerHTML = "<input type='text' class='tree-list-input' />";
    const inp = fieldEl.querySelector("input");
    configureListInlineInput(inp, field);
    inp.value = old;
    inp.focus();
    inp.select();
    let done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      fieldEl.classList.remove("editing");
      const text = inp.value;
      if (!ok || text === old) {
        fieldEl.textContent = field === "Tree ID" ? old : displayListVal(old);
        fieldEl.classList.toggle("empty", field !== "Tree ID" && (old == null || old === ""));
        return;
      }
      if (field === "Tree ID") {
        if (!renameTreeId(treeId, text)) {
          fieldEl.textContent = old;
          return;
        }
        return;
      }
      applyTreeAttr(treeId, field, text);
      // applyTreeAttr schedules persist + may re-render; if not:
      if (fieldEl.isConnected) {
        fieldEl.textContent = displayListVal(text);
        fieldEl.classList.toggle("empty", text === "");
      }
      if (window.GpkgMedia && window.GpkgMedia.getState &&
          String(window.GpkgMedia.getState().treeId || "").toUpperCase() === String(treeId).toUpperCase()) {
        window.GpkgMedia.setSelectedTree(treeId, t.props);
      }
      setImportStatus("已更新 " + field, "ok");
    }
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
      if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    });
    inp.addEventListener("blur", () => finish(true));
    // Stop row selection while typing
    inp.addEventListener("click", (ev) => ev.stopPropagation());
    inp.addEventListener("pointerdown", (ev) => ev.stopPropagation());
  }

  function bindTreeListInteractions(box) {
    if (!box || box._listEditBound) return;
    box._listEditBound = true;

    // Single tap/click on a value field → inline edit (Pencil / finger / mouse).
    // Tap on row chrome (not a field) → select only.
    let editedByPointer = 0;
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
      const field = e.target.closest && e.target.closest(".tree-list-field");
      const row = e.target.closest && e.target.closest(".tree-list-row");
      if (field) {
        e.preventDefault();
        startTreeListFieldEdit(field);
        return;
      }
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

    // Pen / touch: open edit on pointerup (do not require double-tap)
    box.addEventListener("pointerup", (e) => {
      if (e.pointerType === "mouse") return; // click handles mouse
      if (e.pointerType !== "pen" && e.pointerType !== "touch") return;
      const field = e.target.closest && e.target.closest(".tree-list-field");
      if (!field || !box.contains(field)) return;
      if (field.classList.contains("editing")) return;
      if (e.target.closest && e.target.closest(".tree-list-input")) return;
      editedByPointer = Date.now();
      e.preventDefault();
      startTreeListFieldEdit(field);
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
      syncAnnotLayerToContent();
    }
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
   * Layer lives inside #map-ref-zoom-stage so CSS zoom/pan keeps markers glued to the map.
   */
  function syncAnnotLayerToContent() {
    const layer = $("map-annotate-layer");
    const stage = $("map-ref-zoom-stage");
    if (!layer || !stage) return;
    const media = getMapRefMediaEl();
    const sw = stage.clientWidth || 0;
    const sh = stage.clientHeight || 0;
    if (!media || !sw || !sh) {
      layer.style.left = "0";
      layer.style.top = "0";
      layer.style.width = "100%";
      layer.style.height = "100%";
      return;
    }
    // Prefer the img element's layout box inside the stage (not assuming it fills stage),
    // then object-fit:contain letterbox within that box — same space markers/% use.
    const iw = media.clientWidth || sw;
    const ih = media.clientHeight || sh;
    let il = 0;
    let it = 0;
    if (media.offsetParent === stage) {
      il = media.offsetLeft || 0;
      it = media.offsetTop || 0;
    } else {
      // Fallback: compare untransformed layout via client rects only when scale≈1;
      // otherwise keep stage-relative 0,0 if sizes match.
      il = Math.max(0, Math.round((sw - iw) / 2));
      it = Math.max(0, Math.round((sh - ih) / 2));
    }
    const box = containBox(iw, ih, media.naturalWidth, media.naturalHeight);
    layer.style.left = (il + box.left).toFixed(2) + "px";
    layer.style.top = (it + box.top).toFixed(2) + "px";
    layer.style.width = box.width.toFixed(2) + "px";
    layer.style.height = box.height.toFixed(2) + "px";
  }

  function ensureAnnotLayerObserver() {
    const viewer = $("map-ref-viewer");
    if (!viewer || typeof ResizeObserver === "undefined") return;
    if (state.annotLayerRo) return;
    state.annotLayerRo = new ResizeObserver(function () {
      syncAnnotLayerToContent();
    });
    state.annotLayerRo.observe(viewer);
    const stage = $("map-ref-zoom-stage");
    if (stage) state.annotLayerRo.observe(stage);
    const img = $("map-ref-img");
    if (img) {
      state.annotLayerRo.observe(img);
      if (!img._annotSyncBound) {
        img._annotSyncBound = true;
        img.addEventListener("load", function () { syncAnnotLayerToContent(); });
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

  function applyMapRefZoom() {
    const stage = $("map-ref-zoom-stage");
    const z = state.mapRefZoom;
    if (stage) {
      stage.style.transform = "translate(" + z.x.toFixed(1) + "px," + z.y.toFixed(1) + "px) scale(" + z.scale.toFixed(3) + ")";
    }
    const resetBtn = $("map-ref-zoom-reset");
    if (resetBtn) resetBtn.textContent = z.scale <= 1.01 ? "1×" : (Math.round(z.scale * 10) / 10) + "×";
    // Layout box unchanged by transform; keep content-box layer aligned after panel changes
    syncAnnotLayerToContent();
  }

  function resetMapRefZoom() {
    state.mapRefZoom.scale = 1;
    state.mapRefZoom.x = 0;
    state.mapRefZoom.y = 0;
    applyMapRefZoom();
  }

  function stepMapRefZoom(dir) {
    const z = state.mapRefZoom;
    const next = clampZoom(z.scale + dir * MAP_ZOOM_STEP, MAP_ZOOM_MIN, MAP_ZOOM_MAX);
    if (next <= 1.01) {
      resetMapRefZoom();
      return;
    }
    z.scale = next;
    applyMapRefZoom();
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

    viewer.addEventListener("touchstart", (e) => {
      // Let annotate mode own single-finger taps; still allow pinch zoom
      if (!e.touches) return;
      if (e.touches.length === 2) {
        pinch = {
          dist: dist(e.touches[0], e.touches[1]),
          scale: state.mapRefZoom.scale,
          x: state.mapRefZoom.x,
          y: state.mapRefZoom.y
        };
        pan = null;
        e.preventDefault();
        return;
      }
      pinch = null;
      // Pan when zoomed — including annotate mode (letterbox / areas not on the layer)
      if (state.mapRefZoom.scale > 1.01 && e.touches.length === 1) {
        const t = e.touches[0];
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
        state.mapRefZoom.scale = next;
        if (next <= 1.01) {
          state.mapRefZoom.x = 0;
          state.mapRefZoom.y = 0;
        } else {
          state.mapRefZoom.x = pinch.x;
          state.mapRefZoom.y = pinch.y;
        }
        applyMapRefZoom();
        return;
      }
      if (pan && e.touches && e.touches.length === 1) {
        e.preventDefault();
        const t = e.touches[0];
        state.mapRefZoom.x = pan.ox + (t.clientX - pan.x0);
        state.mapRefZoom.y = pan.oy + (t.clientY - pan.y0);
        applyMapRefZoom();
      }
    }, { passive: false });

    viewer.addEventListener("touchend", () => {
      if (state.mapRefZoom.scale <= 1.01) resetMapRefZoom();
      pinch = null;
      pan = null;
    }, { passive: true });
  }

  function showMapRef(file) {
    revokeMapRefUrl();
    hideMapRefViewers();
    resetMapRefZoom();
    const name = file.name || "map";
    const lower = name.toLowerCase();
    const url = rememberUrl(URL.createObjectURL(file));
    state.mapRefUrl = url;
    state.mapRefName = name;
    state.mapRefRasterized = false;

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
      syncAnnotLayerToContent();
      renderAnnotOverlay();
      updateMapRestoreHint();
      schedulePersist();
      setImportStatus(statusMsg, "ok");
    }

    if (/\.pdf$/i.test(lower) || (file.type && file.type.indexOf("pdf") >= 0)) {
      state.mapRefKind = "pdf";
      if (openTab) {
        openTab.hidden = false;
        openTab.href = url;
        openTab.setAttribute("download", name);
        openTab.textContent = "新分頁開啟地圖 PDF";
      }
      // Prefer rasterized page-1 image so annotate % matches map pixels (same as PNG/JPG)
      setImportStatus("正在將 PDF 轉成影像以便加樹…", "");
      rasterizeMapRefPdf(url).then(function (ok) {
        if (ok) {
          finishShow("已載入地圖參考：" + name + "（PDF 第 1 頁影像 · 可開「加樹模式」）");
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
        finishShow("已載入地圖參考：" + name + "（PDF 檢視器 · 建議改用 PNG／JPG 加樹）");
      });
      return;
    }

    state.mapRefKind = "image";
    if (img) {
      const onReady = function () {
        img.removeEventListener("load", onReady);
        syncAnnotLayerToContent();
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
      openTab.textContent = "新分頁開啟地圖圖片";
    }
    finishShow("已載入地圖參考：" + name + "（可按「切換地圖」返回 Leaflet；可開「加樹模式」點擊加樹）");
  }

  function clearMapRef() {
    revokeMapRefUrl();
    hideMapRefViewers();
    resetMapRefZoom();
    state.mapRefMeta = null;
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
          ? "加樹模式（手動編號）：點地圖後輸入編號；長按標記可拖移"
          : "加樹模式（自動編號）：點地圖放置 T1、T2…；長按標記可拖移",
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
          ? "手動編號：點地圖後輸入樹木 ID。短點選取；長按拖移。座標相對地圖內容 %（隨縮放黏住）。"
          : "自動編號：點地圖依序 T1、T2…。短點選取；長按拖移。PNG／JPG 最佳；PDF 會轉影像頁。";
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
        radius: 4.5,
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
    if (layer) {
      Array.prototype.forEach.call(layer.querySelectorAll(".annot-marker"), (el) => {
        el.classList.toggle("on", treeId && String(el.getAttribute("data-tree-id")).toUpperCase() === String(treeId).toUpperCase());
      });
    }
    const want = treeId ? String(treeId).toUpperCase() : "";
    state.trees.forEach((t) => {
      if (!t.leafletMarker) return;
      const on = !!(want && String(t.id).toUpperCase() === want);
      try {
        if (t.leafletMarker.setStyle) {
          t.leafletMarker.setStyle({
            radius: on ? 5 : 4.5,
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

  function updateTreeXy(treeId, x, y) {
    const want = String(treeId || "").toUpperCase();
    const t = state.trees.find((x0) => String(x0.id).toUpperCase() === want);
    if (!t) return false;
    const nx = Math.max(0, Math.min(100, Number(x)));
    const ny = Math.max(0, Math.min(100, Number(y)));
    if (!isFinite(nx) || !isFinite(ny)) return false;
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
    // Keep overlay marker in sync (may already be at this %)
    const layer = $("map-annotate-layer");
    if (layer) {
      Array.prototype.forEach.call(layer.querySelectorAll(".annot-marker"), (el) => {
        if (String(el.getAttribute("data-tree-id") || "").toUpperCase() !== want) return;
        el.style.left = nx.toFixed(3) + "%";
        el.style.top = ny.toFixed(3) + "%";
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
    if (!layer || layer._annotPtrBound) return;
    layer._annotPtrBound = true;

    const LONG_MS = 450;
    const MOVE_CANCEL_PX = 14;
    let gesture = null; // { pointerId, marker, treeId, startX, startY, longTimer, dragging, suppressed, startLeft, startTop }
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
      gesture = null;
    }

    function pctFromClient(clientX, clientY) {
      return pctFromEvent(layer, clientX, clientY);
    }

    function beginDrag() {
      if (!gesture || !gesture.marker) return;
      gesture.dragging = true;
      gesture.marker.classList.remove("pressing");
      gesture.marker.classList.add("dragging");
      try { gesture.marker.setPointerCapture(gesture.pointerId); } catch (_) {}
      selectTreeFromList(gesture.treeId);
      setImportStatus("拖移 " + gesture.treeId + " …鬆開後儲存位置", "ok");
    }

    function applyMarkerVisual(clientX, clientY) {
      if (!gesture || !gesture.marker) return;
      const pct = pctFromClient(clientX, clientY);
      if (!pct) return pct;
      gesture.marker.style.left = pct.x.toFixed(3) + "%";
      gesture.marker.style.top = pct.y.toFixed(3) + "%";
      return pct;
    }

    layer.addEventListener("pointerdown", (e) => {
      if (!state.annotateMode) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const hit = e.target && e.target.closest && e.target.closest(".annot-marker");
      if (!hit || !layer.contains(hit)) {
        // Empty overlay: short tap handled on pointerup / click
        gesture = {
          pointerId: e.pointerId,
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
          oy: 0
        };
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const tid = hit.getAttribute("data-tree-id");
      gesture = {
        pointerId: e.pointerId,
        marker: hit,
        treeId: tid,
        startX: e.clientX,
        startY: e.clientY,
        longTimer: null,
        dragging: false,
        suppressed: false,
        place: false
      };
      hit.classList.add("pressing");
      gesture.longTimer = setTimeout(() => {
        if (!gesture || gesture.pointerId !== e.pointerId || gesture.suppressed) return;
        beginDrag();
      }, LONG_MS);
    });

    layer.addEventListener("pointermove", (e) => {
      if (!gesture || gesture.pointerId !== e.pointerId) return;
      const dx = e.clientX - gesture.startX;
      const dy = e.clientY - gesture.startY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (gesture.panning) {
        e.preventDefault();
        state.mapRefZoom.x = gesture.ox + dx;
        state.mapRefZoom.y = gesture.oy + dy;
        applyMapRefZoom();
        return;
      }
      if (!gesture.dragging) {
        if (dist > MOVE_CANCEL_PX) {
          // Moved too early → cancel long-press / place; empty drag pans when zoomed
          gesture.suppressed = true;
          clearLongTimer();
          if (gesture.marker) gesture.marker.classList.remove("pressing");
          if (gesture.place && state.mapRefZoom.scale > 1.01) {
            gesture.panning = true;
            gesture.ox = state.mapRefZoom.x;
            gesture.oy = state.mapRefZoom.y;
            e.preventDefault();
            state.mapRefZoom.x = gesture.ox + dx;
            state.mapRefZoom.y = gesture.oy + dy;
            applyMapRefZoom();
          }
        }
        return;
      }
      e.preventDefault();
      applyMarkerVisual(e.clientX, e.clientY);
    });

    function finishPointer(e) {
      if (!gesture || gesture.pointerId !== e.pointerId) return;
      const g = gesture;
      clearLongTimer();
      if (g.dragging && g.marker && g.treeId) {
        e.preventDefault();
        e.stopPropagation();
        const pct = applyMarkerVisual(e.clientX, e.clientY) || pctFromClient(e.clientX, e.clientY);
        g.marker.classList.remove("dragging", "pressing");
        try { g.marker.releasePointerCapture(g.pointerId); } catch (_) {}
        suppressClickUntil = Date.now() + 500;
        if (pct) {
          updateTreeXy(g.treeId, pct.x, pct.y);
          setImportStatus(
            "已移動 " + g.treeId + " · x " + fmtXy(pct.x) + "% y " + fmtXy(pct.y) + "%",
            "ok"
          );
        }
        endGesture();
        return;
      }
      // Short tap (or finished pan — never place after a pan)
      const wasSuppressed = g.suppressed || g.panning;
      const marker = g.marker;
      const treeId = g.treeId;
      const place = g.place;
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
      if (place && state.annotateMode) {
        // Pen/touch place on pointerup; mouse uses click below
        if (e.pointerType === "pen" || e.pointerType === "touch") {
          suppressClickUntil = Date.now() + 450;
          handleOverlayClick(e);
        }
      }
    }

    layer.addEventListener("pointerup", finishPointer);
    layer.addEventListener("pointercancel", (e) => {
      if (!gesture || gesture.pointerId !== e.pointerId) return;
      if (gesture.dragging && gesture.marker) {
        // Revert visual to stored tree coords
        const t = state.trees.find((x) => String(x.id).toUpperCase() === String(gesture.treeId || "").toUpperCase());
        if (t && t.x != null && t.y != null) {
          gesture.marker.style.left = Number(t.x).toFixed(3) + "%";
          gesture.marker.style.top = Number(t.y).toFixed(3) + "%";
        }
        try { gesture.marker.releasePointerCapture(gesture.pointerId); } catch (_) {}
      }
      endGesture();
      suppressClickUntil = Date.now() + 300;
    });

    layer.addEventListener("click", (e) => {
      if (Date.now() < suppressClickUntil) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Mouse (and synthesised click): place or select via existing handler
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
      syncAnnotLayerToContent();
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
