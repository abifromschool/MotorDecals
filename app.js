(() => {
  // ---------- state ----------
  let data = null;
  let layers = [];
  // Primary selection — drives the props panel; -1 when nothing selected.
  // When selectedIdx >= 0 it is always also present in selectedIdxs.
  let selectedIdx = -1;
  // Full selection set of layer indices; supports multi-select operations.
  const selectedIdxs = new Set();
  // Per-layer-object lock (WeakSet → unaffected by index shifts on delete/move).
  const lockedLayers = new WeakSet();
  let dragState = null;
  let marqueeRect = null;  // {panel, el, x0, y0} during marquee selection

  const MAX_DECALS = 30;

  // ---------- undo / redo ----------
  // Snapshot-based: each entry stashes a deep clone of `layers` plus the
  // current selection. Cheap for <30 decals. Continuous edits (typing in an
  // input, dragging the color slider) are coalesced via `pushHistoryForField`.
  const history = [];
  const redoStack = [];
  const MAX_HISTORY = 100;
  const editTimers = new Map();

  function captureSnapshot() {
    return {
      layers: JSON.parse(JSON.stringify(layers)),
      selectedIdx,
      selectedIdxs: [...selectedIdxs],
    };
  }

  function pushHistory() {
    history.push(captureSnapshot());
    if (history.length > MAX_HISTORY) history.shift();
    redoStack.length = 0;
  }

  // For property-input streams: snapshot only on the first edit in a 500ms
  // window per field, so typing or slider-dragging is one undo step.
  function pushHistoryForField(field) {
    if (!editTimers.has(field)) pushHistory();
    else clearTimeout(editTimers.get(field));
    editTimers.set(field, setTimeout(() => editTimers.delete(field), 500));
  }

  function applySnapshot(snap) {
    // Mutate `layers` in place to preserve `data.decal.decalLayers` reference.
    layers.length = 0;
    for (const l of snap.layers) layers.push(l);
    selectedIdxs.clear();
    for (const i of snap.selectedIdxs) selectedIdxs.add(i);
    selectedIdx = snap.selectedIdx;
  }

  function undo() {
    if (!history.length) { toast('Nothing to undo'); return; }
    redoStack.push(captureSnapshot());
    if (redoStack.length > MAX_HISTORY) redoStack.shift();
    applySnapshot(history.pop());
    refreshAll();
  }

  function redo() {
    if (!redoStack.length) { toast('Nothing to redo'); return; }
    history.push(captureSnapshot());
    applySnapshot(redoStack.pop());
    refreshAll();
  }

  function clearHistory() {
    history.length = 0;
    redoStack.length = 0;
    editTimers.clear();
  }

  // flags bit 1 (value 2) toggles the game's auto-mirror across the vehicle
  // centerline. Confirmed empirically: same decal, same position, only flags
  // changes between un-mirrored (264) and mirrored (266).
  const MIRROR_FLAG = 2;
  // Flip toggles bits 0 and 4 together (value 17). Confirmed via diff:
  // an un-flipped decal has flags 264, the same decal flipped has 281 (264+17).
  const FLIP_FLAG = 17;
  const isMirrored = l => ((l.flags || 0) & MIRROR_FLAG) !== 0;
  const isFlipped = l => ((l.flags || 0) & FLIP_FLAG) !== 0;
  const setBit = (l, bit, on) => {
    const f = l.flags || 0;
    l.flags = on ? (f | bit) : (f & ~bit);
  };
  const setMirrored = (l, on) => setBit(l, MIRROR_FLAG, on);
  const setFlipped = (l, on) => setBit(l, FLIP_FLAG, on);

  const FACES = ['left', 'front', 'right', 'back', 'top'];
  const panels = {};

  // ---------- decal asset library ----------
  // assetIndex: lowercase key (filename without extension) → URL string
  // imageCache: key → { state, img, tinted: Map<colorKey, HTMLCanvasElement> }
  const assetIndex = new Map();
  const imageCache = new Map();
  const missingReported = new Set();

  // The game references decals as `<parentFolder>_<filenameWithoutExt>`, e.g.
  // Decal/DecalTextures/GeomShape_01/001-circle.png → "GeomShape_01_001-circle".
  // Matching is case-insensitive.
  function pathToKey(path) {
    const norm = path.replace(/\\/g, '/');
    const parts = norm.split('/').filter(Boolean);
    const file = parts[parts.length - 1] || '';
    const base = file.replace(/\.[^.]+$/, '');
    const parent = parts.length >= 2 ? parts[parts.length - 2] : '';
    return (parent ? `${parent}_${base}` : base).toLowerCase();
  }

  function addAsset(key, url, revocable) {
    if (assetIndex.has(key)) return false;
    assetIndex.set(key, { url, revocable });
    return true;
  }

  function loadManifest() {
    if (!Array.isArray(window.DECAL_MANIFEST)) return 0;
    let count = 0;
    for (const path of window.DECAL_MANIFEST) {
      if (!/\.(png|jpg|jpeg|webp)$/i.test(path)) continue;
      // encode path segments so spaces / unicode in folder names survive
      const url = path.split('/').map(encodeURIComponent).join('/');
      if (addAsset(pathToKey(path), url, false)) count++;
    }
    return count;
  }

  function indexAssets(files) {
    // wipe any previously loaded asset state (manifest or prior pick)
    for (const v of assetIndex.values()) if (v.revocable) URL.revokeObjectURL(v.url);
    assetIndex.clear();
    imageCache.clear();
    missingReported.clear();
    let count = 0;
    for (const f of files) {
      if (!/\.(png|jpg|jpeg|webp)$/i.test(f.name)) continue;
      // webkitRelativePath gives the path under the picked folder, including subfolders
      const path = f.webkitRelativePath || f.name;
      const key = pathToKey(path);
      if (addAsset(key, URL.createObjectURL(f), true)) count++;
    }
    return count;
  }

  function loadDecalImage(decalKey) {
    const key = decalKey.toLowerCase();
    let cached = imageCache.get(key);
    if (cached) return cached;
    const asset = assetIndex.get(key);
    if (!asset) {
      if (!missingReported.has(key)) missingReported.add(key);
      cached = { state: 'error' };
      imageCache.set(key, cached);
      return cached;
    }
    cached = { state: 'loading', tinted: new Map() };
    imageCache.set(key, cached);
    const img = new Image();
    img.onload = () => {
      cached.img = img;
      cached.state = 'ready';
      drawAll();
    };
    img.onerror = () => { cached.state = 'error'; };
    img.src = asset.url;
    return cached;
  }

  // Build (and cache) a canvas with the decal image tinted by the given color.
  function getTintedCanvas(cached, color) {
    const ck = `${color.r},${color.g},${color.b},${color.a}`;
    let canvas = cached.tinted.get(ck);
    if (canvas) return canvas;
    const img = cached.img;
    canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const c = canvas.getContext('2d');
    // 1. paint solid color
    c.fillStyle = `rgb(${color.r},${color.g},${color.b})`;
    c.fillRect(0, 0, canvas.width, canvas.height);
    // 2. clip to image alpha (keeps only the decal's shape)
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(img, 0, 0);
    c.globalCompositeOperation = 'source-over';
    cached.tinted.set(ck, canvas);
    return canvas;
  }

  // ---------- DOM ----------
  const fileInput = document.getElementById('file-input');
  const pasteBtn = document.getElementById('paste-btn');
  const decalsInput = document.getElementById('decals-input');
  const decalsStatus = document.getElementById('decals-status');
  const copyBtn = document.getElementById('copy-btn');
  const exportBtn = document.getElementById('export-btn');
  const resetViewsBtn = document.getElementById('reset-views-btn');
  const vehicleLabel = document.getElementById('vehicle-label');
  const listEl = document.getElementById('decal-list');
  const toastEl = document.getElementById('toast');
  const propsPanel = document.getElementById('props-panel');
  const propKey = document.getElementById('prop-key');
  const propFace = document.getElementById('prop-face');
  const propX = document.getElementById('prop-x');
  const propY = document.getElementById('prop-y');
  const propRoll = document.getElementById('prop-roll');
  const propScale = document.getElementById('prop-scale');
  const propStretch = document.getElementById('prop-stretch');
  const propCoverage = document.getElementById('prop-coverage');
  const propFlags = document.getElementById('prop-flags');
  const propColor = document.getElementById('prop-color');
  const propHex = document.getElementById('prop-hex');
  const propR = document.getElementById('prop-r');
  const propG = document.getElementById('prop-g');
  const propB = document.getElementById('prop-b');
  const propA = document.getElementById('prop-a');
  const propsHeading = document.getElementById('props-heading');
  const mirrorBtn = document.getElementById('mirror-btn');
  const flipBtn = document.getElementById('flip-btn');
  const lockBtn = document.getElementById('lock-btn');
  const raiseBtn = document.getElementById('raise-btn');
  const lowerBtn = document.getElementById('lower-btn');
  const duplicateBtn = document.getElementById('duplicate-btn');
  const deleteBtn = document.getElementById('delete-btn');
  const pickerSearch = document.getElementById('picker-search');
  const pickerGrid = document.getElementById('picker-grid');

  // ---------- asset picker / place mode ----------
  // State must be declared before any code that calls populatePicker(), which
  // touches `pickerKeys` via the let binding's TDZ.
  let armedKey = null;  // decalKey waiting to be placed
  let pickerKeys = [];  // sorted list of all asset keys for filtering

  decalsInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const count = indexAssets(files);
    decalsStatus.textContent = `${count} decal assets`;
    populatePicker();
    drawAll();
    toast(`Indexed ${count} decal assets`);
    decalsInput.value = '';
  });

  // Auto-load from bundled manifest if present
  {
    const n = loadManifest();
    if (n > 0) decalsStatus.textContent = `${n} decal assets`;
    populatePicker();
  }

  function populatePicker() {
    pickerKeys = Array.from(assetIndex.keys()).sort();
    renderPickerGrid('');
    // Pre-warm imageCache so canvas rendering is instant on JSON paste — no
    // load flicker as decals come into view. Each key kicks off its own
    // HTMLImageElement load and stores it in imageCache for later getTintedCanvas.
    for (const key of pickerKeys) loadDecalImage(key);
  }

  function renderPickerGrid(filter) {
    pickerGrid.innerHTML = '';
    const f = filter.trim().toLowerCase();
    const matches = f ? pickerKeys.filter(k => k.includes(f)) : pickerKeys;
    // Cap to a reasonable number per render to avoid stalls on the full 479
    const cap = 600;
    for (const key of matches.slice(0, cap)) {
      const asset = assetIndex.get(key);
      const cell = document.createElement('div');
      cell.className = 'picker-cell' + (key === armedKey ? ' armed' : '');
      cell.title = key;
      cell.dataset.key = key;
      const img = document.createElement('img');
      img.src = asset.url;
      img.alt = key;
      cell.appendChild(img);
      cell.addEventListener('click', () => armForPlacement(key));
      pickerGrid.appendChild(cell);
    }
  }

  pickerSearch.addEventListener('input', () => renderPickerGrid(pickerSearch.value));

  function armForPlacement(key) {
    if (armedKey === key) {
      cancelPlacement();
      return;
    }
    armedKey = key;
    document.body.classList.add('placing');
    pickerGrid.querySelectorAll('.picker-cell').forEach(c => {
      c.classList.toggle('armed', c.dataset.key === key);
    });
    toast(`Click a panel to place "${key}". Esc to cancel.`);
  }

  function cancelPlacement() {
    if (!armedKey) return;
    armedKey = null;
    document.body.classList.remove('placing');
    pickerGrid.querySelectorAll('.picker-cell.armed').forEach(c => c.classList.remove('armed'));
  }

  // Default rotation for a new decal on a given face. Yaw values per the handoff
  // (yaw≈90 left, yaw≈-90 right, yaw≈0 back, yaw≈180 front, |pitch|>45 top).
  function defaultRotationForFace(face) {
    switch (face) {
      case 'left':  return { pitch: 0,   yaw: 90,   roll: 0 };
      case 'right': return { pitch: 0,   yaw: -90,  roll: 0 };
      case 'back':  return { pitch: 0,   yaw: 0,    roll: 0 };
      case 'front': return { pitch: 0,   yaw: 180,  roll: 0 };
      case 'top':   return { pitch: -90, yaw: 0,    roll: 0 };
      default:      return { pitch: 0,   yaw: 0,    roll: 0 };
    }
  }

  function placeNewDecal(panel, worldX, worldY) {
    if (!armedKey || !data) {
      if (!data) toast('Load a JSON file first', true);
      return;
    }
    if (layers.length >= MAX_DECALS) {
      toast(`Decal cap reached (${MAX_DECALS}). Delete one first.`, true);
      return;
    }
    pushHistory();
    const layer = {
      decalKey: armedKey,
      color: { b: 255, g: 255, r: 255, a: 255 },
      position: { x: worldX, y: worldY },
      rotation: defaultRotationForFace(panel.face),
      decalScale: 0.5,
      stretch: 1,
      coverage: 1,
      flags: 264,
    };
    layers.push(layer);
    selectOnly(layers.length - 1);
    cancelPlacement();
    refreshAll();
    toast(`Placed ${layer.decalKey}`);
  }

  // ---------- toast ----------
  let toastTimer = null;
  function toast(msg, isError = false) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('error', isError);
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  // ---------- init panels ----------
  document.querySelectorAll('.view-panel').forEach(el => {
    const face = el.dataset.face;
    const canvas = el.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const statusEl = el.querySelector('.panel-status');
    panels[face] = {
      el, canvas, ctx, statusEl,
      face,
      view: { scale: 1, ox: 0, oy: 0 },
      // entries: [{ idx, mirrored }] — mirrored=true means render the phantom of layers[idx]
      entries: [],
    };
  });

  // ---------- selection helpers ----------
  function isSelected(i) { return selectedIdxs.has(i); }
  function isLocked(i) { return i >= 0 && layers[i] && lockedLayers.has(layers[i]); }

  function selectOnly(i) {
    selectedIdxs.clear();
    if (i >= 0) selectedIdxs.add(i);
    selectedIdx = i;
  }

  function selectToggle(i) {
    if (selectedIdxs.has(i)) {
      selectedIdxs.delete(i);
      if (selectedIdx === i) {
        // Promote the next-most-recent selection (highest remaining idx) to primary.
        selectedIdx = selectedIdxs.size ? Math.max(...selectedIdxs) : -1;
      }
    } else {
      selectedIdxs.add(i);
      selectedIdx = i;
    }
  }

  function selectAdd(i) {
    selectedIdxs.add(i);
    selectedIdx = i;
  }

  function clearSelection() {
    selectedIdxs.clear();
    selectedIdx = -1;
  }

  // After any structural change to `layers` (delete, move), call this to fix up
  // selection indices. `mapper(oldIdx) → newIdx | -1` describes the remap.
  function remapSelection(mapper) {
    const next = new Set();
    for (const i of selectedIdxs) {
      const j = mapper(i);
      if (j >= 0) next.add(j);
    }
    selectedIdxs.clear();
    for (const j of next) selectedIdxs.add(j);
    selectedIdx = selectedIdx >= 0 ? mapper(selectedIdx) : -1;
    if (selectedIdx < 0 && selectedIdxs.size) selectedIdx = Math.max(...selectedIdxs);
  }

  // ---------- view classification ----------
  function classifyView(layer) {
    const { pitch, yaw } = layer.rotation;
    if (Math.abs(pitch) > 45) return 'top';
    const y = ((yaw % 360) + 540) % 360 - 180;
    if (y >= 45 && y <= 135) return 'left';
    if (y <= -45 && y >= -135) return 'right';
    // Per handoff: yaw ≈ 0° → back, yaw ≈ ±180° → front (confirmed by user).
    if (y > -45 && y < 45) return 'back';
    return 'front';
  }

  // Mirror is across the vehicle's left-right plane: x→-x, yaw→-yaw, roll→-roll.
  function predictMirror(src) {
    return {
      x: -src.position.x,
      y: src.position.y,
      yaw: -src.rotation.yaw,
      roll: -(src.rotation.roll || 0),
    };
  }

  // Which panel renders the mirror phantom for a given source face.
  function phantomFace(face) {
    if (face === 'left') return 'right';
    if (face === 'right') return 'left';
    return face; // front/back/top: phantom appears on same panel, mirrored across centerline
  }

  function updatePanelEntries() {
    for (const f of FACES) panels[f].entries = [];
    layers.forEach((l, i) => {
      const face = classifyView(l);
      if (panels[face]) panels[face].entries.push({ idx: i, mirrored: false });
      if (isMirrored(l)) {
        const pf = phantomFace(face);
        if (pf && panels[pf]) panels[pf].entries.push({ idx: i, mirrored: true });
      }
    });
  }

  // Resolve an entry to its effective render position/rotation.
  function effective(entry) {
    const l = layers[entry.idx];
    if (!entry.mirrored) {
      return { x: l.position.x, y: l.position.y, roll: l.rotation.roll || 0 };
    }
    const pred = predictMirror(l);
    return { x: pred.x, y: pred.y, roll: pred.roll };
  }

  // ---------- coordinate transforms (Y-flipped) ----------
  function worldToScreen(panel, x, y) {
    const rect = panel.canvas.getBoundingClientRect();
    return {
      sx: rect.width / 2 + (x + panel.view.ox) * panel.view.scale,
      sy: rect.height / 2 + (-y + panel.view.oy) * panel.view.scale,
    };
  }

  function screenToWorld(panel, sx, sy) {
    const rect = panel.canvas.getBoundingClientRect();
    return {
      x: (sx - rect.width / 2) / panel.view.scale - panel.view.ox,
      y: -((sy - rect.height / 2) / panel.view.scale - panel.view.oy),
    };
  }

  // Width in world units for a given decal. Calibrated against in-game side-view
  // screenshots: four scale-0.5 circles span roughly the cab door width. If the
  // editor still looks off, this is the knob — bump until decal-to-spacing ratio
  // matches the in-game look.
  function decalSizePx(l) {
    return (l.decalScale || 0.5) * 250;
  }

  function fitPanel(panel) {
    if (!panel.entries.length) {
      panel.view = { scale: 1, ox: 0, oy: 0 };
      return;
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const e of panel.entries) {
      const l = layers[e.idx];
      const eff = effective(e);
      const sz = decalSizePx(l);
      minX = Math.min(minX, eff.x - sz);
      maxX = Math.max(maxX, eff.x + sz);
      minY = Math.min(minY, eff.y - sz);
      maxY = Math.max(maxY, eff.y + sz);
    }
    const rect = panel.canvas.getBoundingClientRect();
    const pad = 40;
    const w = maxX - minX || 1;
    const h = maxY - minY || 1;
    const sx = (rect.width - pad * 2) / w;
    const sy = (rect.height - pad * 2) / h;
    panel.view.scale = Math.min(sx, sy, 4);
    panel.view.ox = -(minX + maxX) / 2;
    panel.view.oy = (minY + maxY) / 2;
  }

  function fitAllPanels() {
    for (const f of FACES) fitPanel(panels[f]);
  }

  // ---------- drawing ----------
  function drawPanel(panel) {
    const rect = panel.canvas.getBoundingClientRect();
    const { ctx } = panel;
    ctx.clearRect(0, 0, rect.width, rect.height);

    // grid
    ctx.strokeStyle = '#1f1f1f';
    ctx.lineWidth = 1;
    const gridStep = 50;
    const gridScreen = gridStep * panel.view.scale;
    if (gridScreen > 10) {
      const o = worldToScreen(panel, 0, 0);
      const startX = o.sx % gridScreen;
      const startY = o.sy % gridScreen;
      ctx.beginPath();
      for (let x = startX; x < rect.width; x += gridScreen) {
        ctx.moveTo(x, 0); ctx.lineTo(x, rect.height);
      }
      for (let y = startY; y < rect.height; y += gridScreen) {
        ctx.moveTo(0, y); ctx.lineTo(rect.width, y);
      }
      ctx.stroke();
    }

    // centerline (x = 0) — useful since the mirror axis runs through it
    const center = worldToScreen(panel, 0, 0);
    ctx.strokeStyle = '#2a2a2a';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(center.sx, 0); ctx.lineTo(center.sx, rect.height);
    ctx.stroke();
    ctx.setLineDash([]);

    // origin crosshair
    ctx.strokeStyle = '#333';
    ctx.beginPath();
    ctx.moveTo(center.sx - 8, center.sy); ctx.lineTo(center.sx + 8, center.sy);
    ctx.moveTo(center.sx, center.sy - 8); ctx.lineTo(center.sx, center.sy + 8);
    ctx.stroke();

    // Layer ordering: array[N-1] = topmost (standard painters algorithm — later
    // in the array is drawn later and ends up on top). Phantoms render under
    // real decals so they don't cover them.
    const real = panel.entries.filter(e => !e.mirrored).sort((a, b) => a.idx - b.idx);
    const phantoms = panel.entries.filter(e => e.mirrored).sort((a, b) => a.idx - b.idx);
    const selStateFor = e => e.idx === selectedIdx ? 'primary' : (isSelected(e.idx) ? 'secondary' : 'none');
    for (const e of phantoms) drawEntry(panel, e, selStateFor(e));
    for (const e of real) drawEntry(panel, e, selStateFor(e));

    panel.statusEl.textContent = panel.entries.length ? `${panel.entries.filter(e => !e.mirrored).length} decals` : '';
    panel.el.classList.toggle('has-selection', panel.entries.some(e => isSelected(e.idx)));
  }

  function drawEntry(panel, entry, selState) {
    const selected = selState !== 'none';
    const isPrimary = selState === 'primary';
    const l = layers[entry.idx];
    const eff = effective(entry);
    const { sx, sy } = worldToScreen(panel, eff.x, eff.y);
    const c = l.color;
    const sizeW = decalSizePx(l);
    const w = sizeW * panel.view.scale * (l.stretch || 1);
    const h = sizeW * panel.view.scale;
    const roll = (eff.roll * Math.PI) / 180;

    const { ctx } = panel;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(-roll);
    // Mirror ghost: reflect the art horizontally so it matches the in-game render.
    if (entry.mirrored) ctx.scale(-1, 1);
    if (isFlipped(l)) ctx.scale(1, -1);

    const phantomAlpha = entry.mirrored ? 0.55 : 1;
    ctx.globalAlpha = phantomAlpha * (c.a / 255);

    const cached = assetIndex.size ? loadDecalImage(l.decalKey) : null;
    const hasImage = cached && cached.state === 'ready';

    if (hasImage) {
      const tinted = getTintedCanvas(cached, c);
      ctx.drawImage(tinted, -w / 2, -h / 2, w, h);
    } else {
      ctx.fillStyle = `rgb(${c.r}, ${c.g}, ${c.b})`;
      ctx.globalAlpha *= 0.75;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.globalAlpha = phantomAlpha * (c.a / 255);
    }

    // selection / phantom / lock outline
    const locked = isLocked(entry.idx);
    if (isPrimary)        ctx.strokeStyle = '#7ab8ff';
    else if (selected)    ctx.strokeStyle = 'rgba(122,184,255,0.7)';
    else if (locked)      ctx.strokeStyle = 'rgba(255,170,80,0.6)';
    else if (entry.mirrored) ctx.strokeStyle = 'rgba(122,184,255,0.5)';
    else                  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = isPrimary ? 2 : 1;
    if (entry.mirrored || locked) ctx.setLineDash([4, 3]);
    ctx.globalAlpha = phantomAlpha;
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    if (entry.mirrored || locked) ctx.setLineDash([]);

    // label fallback only when there's no real art to look at
    if (!hasImage && w > 30 && h > 14) {
      ctx.fillStyle = brightnessOnDark(c) > 0.5 ? '#000' : '#fff';
      ctx.globalAlpha = entry.mirrored ? 0.6 : 1;
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const baseLabel = l.decalKey.length > 18 ? l.decalKey.slice(0, 16) + '…' : l.decalKey;
      const label = entry.mirrored ? `↔ ${baseLabel}` : baseLabel;
      ctx.fillText(label, 0, 0);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function brightnessOnDark(c) {
    return (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) / 255;
  }

  function drawAll() {
    for (const f of FACES) drawPanel(panels[f]);
  }

  // ---------- hit testing ----------
  // Hit-test in reverse of draw order so the topmost (highest idx, real) wins.
  function decalAtInPanel(panel, sx, sy) {
    const real = panel.entries.filter(e => !e.mirrored).sort((a, b) => b.idx - a.idx);
    const phantoms = panel.entries.filter(e => e.mirrored).sort((a, b) => b.idx - a.idx);
    const ordered = real.concat(phantoms);
    for (const entry of ordered) {
      const l = layers[entry.idx];
      const eff = effective(entry);
      const p = worldToScreen(panel, eff.x, eff.y);
      const sizeW = decalSizePx(l);
      const w = sizeW * panel.view.scale * Math.abs(l.stretch || 1);
      const h = sizeW * panel.view.scale;
      const roll = (eff.roll * Math.PI) / 180;
      const dx = sx - p.sx, dy = sy - p.sy;
      const cos = Math.cos(roll), sin = Math.sin(roll);
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;
      if (Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2) return { idx: entry.idx, mirrored: entry.mirrored };
    }
    return null;
  }

  // ---------- canvas sizing ----------
  function resizeAll() {
    const dpr = window.devicePixelRatio || 1;
    for (const f of FACES) {
      const p = panels[f];
      const rect = p.canvas.getBoundingClientRect();
      p.canvas.width = rect.width * dpr;
      p.canvas.height = rect.height * dpr;
      p.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    drawAll();
  }
  window.addEventListener('resize', resizeAll);

  // ---------- list ----------
  function renderList() {
    if (!layers.length) {
      listEl.innerHTML = '<div id="empty-state"><p>No decals in this file.</p></div>';
      return;
    }
    listEl.innerHTML = '';
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      const row = document.createElement('div');
      const classes = ['decal-row'];
      if (isSelected(i)) classes.push('selected');
      if (isLocked(i)) classes.push('locked');
      row.className = classes.join(' ');
      row.dataset.idx = i;
      const c = l.color;
      const face = classifyView(l);
      const mir = isMirrored(l);
      row.innerHTML = `
        <div class="swatch" style="background: rgb(${c.r},${c.g},${c.b})"></div>
        <div class="decal-info">
          <div class="decal-key">${escapeHtml(l.decalKey)}${mir ? '<span class="pair-badge" title="Mirrored (in-game flag)">↔</span>' : ''}</div>
          <div class="decal-meta">${face} · x ${l.position.x.toFixed(0)}, y ${l.position.y.toFixed(0)}</div>
        </div>
      `;
      row.addEventListener('click', (ev) => {
        if (ev.ctrlKey || ev.metaKey) {
          selectToggle(i);
        } else {
          selectOnly(i);
        }
        refreshAll();
      });
      listEl.appendChild(row);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ---------- import ----------
  function loadJsonText(text, source = 'clipboard') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      toast('Invalid JSON: ' + err.message, true);
      return false;
    }
    if (!parsed.decal || !Array.isArray(parsed.decal.decalLayers)) {
      toast('JSON missing decal.decalLayers', true);
      return false;
    }
    data = parsed;
    layers = data.decal.decalLayers;
    clearSelection();
    clearHistory();
    copyBtn.disabled = false;
    exportBtn.disabled = false;
    updateCountBadge();
    updatePanelEntries();
    renderList();
    renderProps();
    resizeAll();
    drawAll();
    const mirCount = layers.filter(isMirrored).length;
    toast(`Loaded ${layers.length} decals${mirCount ? ` · ${mirCount} mirrored` : ''}`);
    return true;
  }

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    loadJsonText(text, file.name);
    fileInput.value = '';
  });

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) { toast('Clipboard is empty', true); return; }
      loadJsonText(text, 'clipboard');
    } catch (err) {
      toast('Clipboard read blocked — paste manually with Ctrl+V', true);
    }
  }

  pasteBtn.addEventListener('click', pasteFromClipboard);

  document.addEventListener('paste', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const text = e.clipboardData && e.clipboardData.getData('text');
    if (text) {
      loadJsonText(text, 'paste');
      e.preventDefault();
    }
  });

  // ---------- export ----------
  async function copyToClipboard() {
    if (!data) return;
    const json = JSON.stringify(data);
    try {
      await navigator.clipboard.writeText(json);
      toast('Copied to clipboard');
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = json;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('Copied to clipboard'); }
      catch (e2) { toast('Could not copy', true); }
      document.body.removeChild(ta);
    }
  }

  copyBtn.addEventListener('click', copyToClipboard);

  resetViewsBtn.addEventListener('click', () => {
    fitAllPanels();
    drawAll();
    toast('Views reset');
  });

  document.addEventListener('keydown', (e) => {
    const isCopy = (e.ctrlKey || e.metaKey) && e.key === 'c';
    if (!isCopy || !data) return;
    const sel = window.getSelection();
    if (sel && sel.toString().length > 0) return;
    const t = document.activeElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    copyToClipboard();
    e.preventDefault();
  });

  exportBtn.addEventListener('click', () => {
    if (!data) return;
    const json = JSON.stringify(data);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeKey = (data.vehicleKey || 'decals').replace(/[^a-z0-9_-]/gi, '_');
    a.download = `${safeKey}_edited.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ---------- mouse (per-panel) ----------
  for (const f of FACES) {
    const panel = panels[f];
    const cv = panel.canvas;

    cv.addEventListener('mousedown', (e) => {
      const rect = cv.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (e.button === 1 || e.shiftKey || e.button === 2) {
        dragState = { mode: 'pan', panel, startSx: sx, startSy: sy, startOx: panel.view.ox, startOy: panel.view.oy };
        cv.classList.add('dragging');
        e.preventDefault();
        return;
      }

      // Placement mode wins over selection — left-click drops a new decal at
      // the click point in the panel's world coords.
      if (armedKey && e.button === 0) {
        const world = screenToWorld(panel, sx, sy);
        placeNewDecal(panel, world.x, world.y);
        e.preventDefault();
        return;
      }

      const additive = e.ctrlKey || e.metaKey;
      const hit = decalAtInPanel(panel, sx, sy);
      if (hit) {
        // Ctrl/Cmd+click is a pure selection toggle — no drag is started even
        // if the user mistakenly moves the mouse after.
        if (additive) {
          selectToggle(hit.idx);
          refreshAll();
          e.preventDefault();
          return;
        }
        // Plain click: select only that decal (unless it was already part of a
        // multi-selection, in which case keep the group so we can drag it).
        if (!isSelected(hit.idx)) {
          selectOnly(hit.idx);
        } else {
          selectedIdx = hit.idx;  // promote to primary, keep group
        }
        if (!hit.mirrored && !isLocked(hit.idx)) {
          // Capture per-decal starting positions so dragging the primary moves
          // every selected (unlocked) decal by the same delta.
          const startPositions = new Map();
          for (const i of selectedIdxs) {
            if (isLocked(i)) continue;
            startPositions.set(i, { x: layers[i].position.x, y: layers[i].position.y });
          }
          dragState = {
            mode: 'decal', panel,
            idx: hit.idx,
            startSx: sx, startSy: sy,
            startPositions,
            moved: false,  // set true on first real movement → triggers one history push
          };
          cv.classList.add('dragging');
        }
        refreshAll();
      } else {
        // Empty space: start a marquee. On mouseup, anything inside it joins
        // the selection (additive when ctrl/cmd held, replacing otherwise).
        marqueeRect = {
          panel, additive,
          startSx: sx, startSy: sy,
          curSx: sx, curSy: sy,
          el: createMarqueeEl(panel, sx, sy),
          moved: false,
        };
        e.preventDefault();
      }
    });

    cv.addEventListener('contextmenu', (e) => e.preventDefault());

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = cv.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const before = screenToWorld(panel, sx, sy);
      const factor = Math.exp(-e.deltaY * 0.001);
      panel.view.scale = Math.max(0.05, Math.min(20, panel.view.scale * factor));
      const after = screenToWorld(panel, sx, sy);
      panel.view.ox += after.x - before.x;
      panel.view.oy += -(after.y - before.y);
      drawPanel(panel);
    }, { passive: false });

    cv.addEventListener('dblclick', () => {
      fitPanel(panel);
      drawPanel(panel);
    });
  }

  window.addEventListener('mousemove', (e) => {
    if (marqueeRect) {
      const rect = marqueeRect.panel.canvas.getBoundingClientRect();
      marqueeRect.curSx = e.clientX - rect.left;
      marqueeRect.curSy = e.clientY - rect.top;
      const dx = marqueeRect.curSx - marqueeRect.startSx;
      const dy = marqueeRect.curSy - marqueeRect.startSy;
      if (Math.abs(dx) + Math.abs(dy) > 3) marqueeRect.moved = true;
      updateMarqueeEl(marqueeRect);
      return;
    }
    if (!dragState) return;
    const panel = dragState.panel;
    const rect = panel.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    if (dragState.mode === 'pan') {
      panel.view.ox = dragState.startOx + (sx - dragState.startSx) / panel.view.scale;
      panel.view.oy = dragState.startOy + (sy - dragState.startSy) / panel.view.scale;
      drawPanel(panel);
    } else if (dragState.mode === 'decal') {
      const dx = (sx - dragState.startSx) / panel.view.scale;
      const dy = (sy - dragState.startSy) / panel.view.scale;
      // Snapshot on the first real movement so a click that didn't drag
      // doesn't pollute the undo stack.
      if (!dragState.moved && (Math.abs(dx) > 0 || Math.abs(dy) > 0)) {
        pushHistory();
        dragState.moved = true;
      }
      for (const [i, start] of dragState.startPositions) {
        const l = layers[i];
        l.position.x = start.x + dx;
        l.position.y = start.y - dy;
      }
      const primary = layers[dragState.idx];
      panel.statusEl.textContent = `${primary.decalKey}: x ${primary.position.x.toFixed(2)}, y ${primary.position.y.toFixed(2)}`;
      drawAll();
      renderList();
      renderProps();
    }
  });

  window.addEventListener('mouseup', () => {
    if (marqueeRect) finalizeMarquee();
    if (dragState) {
      dragState.panel.canvas.classList.remove('dragging');
      dragState = null;
    }
  });

  // ---------- marquee selection ----------
  function createMarqueeEl(panel, sx, sy) {
    const el = document.createElement('div');
    el.className = 'marquee-rect';
    el.style.left = sx + 'px';
    el.style.top = sy + 'px';
    el.style.width = '0px';
    el.style.height = '0px';
    panel.el.appendChild(el);
    return el;
  }

  function updateMarqueeEl(m) {
    const x = Math.min(m.startSx, m.curSx);
    const y = Math.min(m.startSy, m.curSy);
    m.el.style.left = x + 'px';
    m.el.style.top = y + 'px';
    m.el.style.width = Math.abs(m.curSx - m.startSx) + 'px';
    m.el.style.height = Math.abs(m.curSy - m.startSy) + 'px';
  }

  function finalizeMarquee() {
    const m = marqueeRect;
    marqueeRect = null;
    m.el.remove();

    // If the user just clicked (no drag), treat as a plain deselect.
    if (!m.moved) {
      clearSelection();
      refreshAll();
      return;
    }

    // Marquee rect in screen space → world bounds for hit testing.
    const a = screenToWorld(m.panel, m.startSx, m.startSy);
    const b = screenToWorld(m.panel, m.curSx, m.curSy);
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);

    if (!m.additive) clearSelection();

    // Real entries only — phantoms route to their source via selection of the
    // source layer index, but a phantom click adding the source feels strange,
    // so we limit marquee to real entries on this panel.
    for (const entry of m.panel.entries) {
      if (entry.mirrored) continue;
      const l = layers[entry.idx];
      const x = l.position.x, y = l.position.y;
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
        selectAdd(entry.idx);
      }
    }
    refreshAll();
  }

  // ---------- props panel ----------
  function toHex2(n) { return Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0'); }
  function colorToHex(c) { return '#' + toHex2(c.r) + toHex2(c.g) + toHex2(c.b); }
  function parseHex(s) {
    const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
  }

  function renderProps() {
    if (selectedIdx < 0 || !layers[selectedIdx]) {
      propsPanel.classList.add('hidden');
      return;
    }
    propsPanel.classList.remove('hidden');
    const l = layers[selectedIdx];
    const n = selectedIdxs.size;
    propsHeading.textContent = n > 1 ? `Selected (${n})` : 'Selected';
    propKey.textContent = l.decalKey;
    propKey.title = l.decalKey;
    const mir = isMirrored(l);
    propFace.textContent = classifyView(l) + (mir ? ' (mirrored)' : '') + (isLocked(selectedIdx) ? ' · locked' : '');
    mirrorBtn.textContent = mir ? 'Unmirror' : 'Mirror';
    mirrorBtn.title = mir ? 'Clear mirror (M)' : 'Mirror — clones text decals, otherwise sets flag (M)';
    lockBtn.textContent = isLocked(selectedIdx) ? 'Unlock' : 'Lock';
    if (document.activeElement !== propX) propX.value = l.position.x.toFixed(2);
    if (document.activeElement !== propY) propY.value = l.position.y.toFixed(2);
    if (document.activeElement !== propRoll) propRoll.value = (l.rotation.roll || 0).toFixed(2);
    if (document.activeElement !== propScale) propScale.value = (l.decalScale || 0.5).toFixed(3);
    if (document.activeElement !== propStretch) propStretch.value = (l.stretch || 1).toFixed(3);
    if (document.activeElement !== propCoverage) propCoverage.value = (l.coverage != null ? l.coverage : 1).toFixed(3);
    if (document.activeElement !== propFlags) propFlags.value = l.flags || 0;
    const c = l.color || { r: 255, g: 255, b: 255, a: 255 };
    if (document.activeElement !== propColor) propColor.value = colorToHex(c);
    if (document.activeElement !== propHex) propHex.value = colorToHex(c);
    if (document.activeElement !== propR) propR.value = c.r;
    if (document.activeElement !== propG) propG.value = c.g;
    if (document.activeElement !== propB) propB.value = c.b;
    if (document.activeElement !== propA) propA.value = c.a;
    flipBtn.classList.toggle('active', isFlipped(l));
    mirrorBtn.classList.toggle('active', mir);
    lockBtn.classList.toggle('active', isLocked(selectedIdx));
    updateCountBadge();
  }

  function refreshAll() {
    updatePanelEntries();
    renderList();
    renderProps();
    drawAll();
    updateCountBadge();
  }

  // Apply `setter` to every selected (unlocked) layer.
  function propEdit(setter) {
    if (!selectedIdxs.size) return;
    let touched = false;
    for (const i of selectedIdxs) {
      if (isLocked(i)) continue;
      setter(layers[i]);
      touched = true;
    }
    if (!touched) return;
    drawAll();
    renderList();
  }
  function bindPropInput(input, field, apply) {
    input.addEventListener('input', () => {
      pushHistoryForField(field);
      apply();
    });
  }
  bindPropInput(propX, 'pos', () => {
    const v = parseFloat(propX.value);
    if (!Number.isNaN(v)) propEdit(l => l.position.x = v);
  });
  bindPropInput(propY, 'pos', () => {
    const v = parseFloat(propY.value);
    if (!Number.isNaN(v)) propEdit(l => l.position.y = v);
  });
  bindPropInput(propRoll, 'roll', () => {
    const v = parseFloat(propRoll.value);
    if (!Number.isNaN(v)) propEdit(l => l.rotation.roll = v);
  });
  bindPropInput(propScale, 'scale', () => {
    const v = parseFloat(propScale.value);
    if (!Number.isNaN(v) && v > 0) propEdit(l => l.decalScale = v);
  });
  bindPropInput(propStretch, 'stretch', () => {
    const v = parseFloat(propStretch.value);
    if (!Number.isNaN(v) && v !== 0) propEdit(l => l.stretch = v);
  });
  bindPropInput(propCoverage, 'coverage', () => {
    const v = parseFloat(propCoverage.value);
    if (!Number.isNaN(v)) propEdit(l => l.coverage = v);
  });
  bindPropInput(propFlags, 'flags', () => {
    const v = parseInt(propFlags.value, 10);
    if (!Number.isNaN(v) && v >= 0) propEdit(l => l.flags = v);
  });

  // Color picker: native, hex, and RGBA inputs all stay in sync. Each writes
  // through to every selected layer's color.
  function applyColor(partial) {
    propEdit(l => {
      l.color = Object.assign({ r: 255, g: 255, b: 255, a: 255 }, l.color, partial);
    });
    // Sync the other input controls to the new value (driven by the primary).
    if (selectedIdx >= 0) {
      const c = layers[selectedIdx].color;
      if (document.activeElement !== propColor) propColor.value = colorToHex(c);
      if (document.activeElement !== propHex)   propHex.value   = colorToHex(c);
      if (document.activeElement !== propR)     propR.value     = c.r;
      if (document.activeElement !== propG)     propG.value     = c.g;
      if (document.activeElement !== propB)     propB.value     = c.b;
      if (document.activeElement !== propA)     propA.value     = c.a;
    }
  }
  propColor.addEventListener('input', () => {
    const rgb = parseHex(propColor.value);
    if (rgb) { pushHistoryForField('color'); applyColor(rgb); }
  });
  propHex.addEventListener('input', () => {
    const rgb = parseHex(propHex.value);
    if (rgb) { pushHistoryForField('color'); applyColor(rgb); }
  });
  function bindRgbInput(input, ch) {
    input.addEventListener('input', () => {
      const v = parseInt(input.value, 10);
      if (!Number.isNaN(v) && v >= 0 && v <= 255) {
        pushHistoryForField('color');
        applyColor({ [ch]: v });
      }
    });
  }
  bindRgbInput(propR, 'r');
  bindRgbInput(propG, 'g');
  bindRgbInput(propB, 'b');
  bindRgbInput(propA, 'a');

  // ---------- count badge ----------
  const countBadge = document.getElementById('count-badge');
  function updateCountBadge() {
    if (!countBadge) return;
    countBadge.textContent = `${layers.length} / ${MAX_DECALS}`;
    countBadge.classList.toggle('over', layers.length > MAX_DECALS);
    if (data) {
      vehicleLabel.textContent = data.vehicleKey
        ? `${data.vehicleKey} · ${layers.length} decals`
        : `${layers.length} decals`;
    }
  }

  // ---------- text detection (drives auto mirror mode) ----------
  // Decals matching these patterns get cloned on mirror instead of flag-mirrored,
  // because flag-mirror would render their text backwards.
  //
  // Patterns:
  //   - Folder-name based: Numbers_*, Letters_*, Text_*, Words_*, *_sign*
  //   - Recycling: confirmed text-y ranges of Recycle_*. 10, 22, and 45+ are
  //     pure shapes per user, the rest (0t–9t, 11–21, 23–44) are text.
  const TEXT_KEY_PATTERNS = [
    /^(numbers?|letters?|alphabet|text|words?)_/i,
    /_(text|words?|sign)_/i,
    /sign\b/i,
    /recycle_(\dt|1[1-9]|2[013-9]|3\d|4[0-4])(?!\d)/i,
  ];
  function isTextDecal(layer) {
    const key = layer.decalKey || '';
    return TEXT_KEY_PATTERNS.some(re => re.test(key));
  }

  // ---------- mirror / flip / lock / move / dupe / delete ----------
  // Mirror — auto-detects text and clones, otherwise toggles the flag.
  function mirrorAction(idx) {
    const l = layers[idx];
    if (isTextDecal(l)) {
      // Text decal: clone to mirror position so the art stays readable.
      if (layers.length >= MAX_DECALS) {
        toast(`Decal cap reached (${MAX_DECALS}). Delete one first.`, true);
        return;
      }
      pushHistory();
      const copy = JSON.parse(JSON.stringify(l));
      copy.position.x = -l.position.x;
      copy.rotation.yaw = -l.rotation.yaw;
      copy.rotation.roll = -(l.rotation.roll || 0);
      // Strip any inherited mirror flag — this is a standalone real decal.
      setMirrored(copy, false);
      layers.push(copy);
      selectOnly(layers.length - 1);
      refreshAll();
      toast(`Cloned ${l.decalKey} (text-safe mirror)`);
    } else {
      // Non-text: cheap flag-based mirror. Game renders the auto-mirror; no
      // extra slot used.
      pushHistory();
      const now = !isMirrored(l);
      setMirrored(l, now);
      refreshAll();
      toast(now ? 'Mirror flag set' : 'Mirror flag cleared');
    }
  }

  function toggleFlip(idx) {
    pushHistory();
    const l = layers[idx];
    const now = !isFlipped(l);
    setFlipped(l, now);
    refreshAll();
    toast(now ? 'Flipped (flag bits 0+4)' : 'Unflipped');
  }

  function toggleLock(idx) {
    const l = layers[idx];
    if (lockedLayers.has(l)) lockedLayers.delete(l);
    else lockedLayers.add(l);
    renderList();
    renderProps();
    drawAll();
    toast(lockedLayers.has(l) ? 'Locked' : 'Unlocked');
  }

  // Reordering operates on the PRIMARY only — moving multiple layers at once
  // is ambiguous when they're not contiguous and rarely useful.
  function moveLayer(idx, delta) {
    const target = idx + delta;
    if (target < 0 || target >= layers.length) return;
    pushHistory();
    const [l] = layers.splice(idx, 1);
    layers.splice(target, 0, l);
    // Remap selection across the swap (other selected indices may shift by 1).
    const lo = Math.min(idx, target), hi = Math.max(idx, target);
    remapSelection(i => {
      if (i === idx) return target;
      if (i >= lo && i <= hi) return i + (delta > 0 ? -1 : +1);
      return i;
    });
    refreshAll();
  }

  // Duplicate every selected layer in turn. Stops at the 30-cap.
  function duplicateSelection() {
    if (!selectedIdxs.size) return;
    if (layers.length >= MAX_DECALS) {
      toast(`Decal cap reached (${MAX_DECALS}). Delete one first.`, true);
      return;
    }
    pushHistory();
    const sources = [...selectedIdxs].sort((a, b) => a - b);
    let added = 0;
    const newIdxs = [];
    for (const i of sources) {
      if (layers.length >= MAX_DECALS) break;
      const copy = JSON.parse(JSON.stringify(layers[i]));
      copy.position.x += 10;
      layers.push(copy);
      newIdxs.push(layers.length - 1);
      added++;
    }
    selectedIdxs.clear();
    for (const i of newIdxs) selectedIdxs.add(i);
    selectedIdx = newIdxs[newIdxs.length - 1];
    refreshAll();
    toast(`Duplicated ${added}${added < sources.length ? ` (${sources.length - added} skipped — cap)` : ''}`);
  }

  // Delete every selected layer in descending order so index shifts don't
  // misalign. Locked layers are skipped.
  function deleteSelection() {
    if (!selectedIdxs.size) return;
    const toDelete = [...selectedIdxs].filter(i => !isLocked(i)).sort((a, b) => b - a);
    if (!toDelete.length) {
      toast('All selected decals are locked', true);
      return;
    }
    pushHistory();
    for (const i of toDelete) layers.splice(i, 1);
    clearSelection();
    refreshAll();
    toast(`Deleted ${toDelete.length}`);
  }

  mirrorBtn.addEventListener('click', () => {
    if (selectedIdxs.size === 0) return;
    for (const i of [...selectedIdxs]) mirrorAction(i);
  });
  flipBtn.addEventListener('click', () => {
    for (const i of selectedIdxs) if (!isLocked(i)) toggleFlip(i);
  });
  lockBtn.addEventListener('click', () => {
    for (const i of [...selectedIdxs]) toggleLock(i);
  });
  raiseBtn.addEventListener('click', () => { if (selectedIdx >= 0) moveLayer(selectedIdx, +1); });
  lowerBtn.addEventListener('click', () => { if (selectedIdx >= 0) moveLayer(selectedIdx, -1); });
  duplicateBtn.addEventListener('click', duplicateSelection);
  deleteBtn.addEventListener('click', deleteSelection);

  // ---------- keyboard shortcuts ----------
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      if (e.key === 'Escape' && armedKey) { cancelPlacement(); e.preventDefault(); }
      return;
    }
    if (e.key === 'Escape') {
      if (armedKey) { cancelPlacement(); e.preventDefault(); return; }
      if (selectedIdxs.size) { clearSelection(); refreshAll(); e.preventDefault(); return; }
    }
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      // Ctrl+Z / Ctrl+Shift+Z (also Ctrl+Y) = undo / redo
      if (k === 'z') {
        if (e.shiftKey) redo(); else undo();
        e.preventDefault();
        return;
      }
      if (k === 'y') { redo(); e.preventDefault(); return; }
      if (k === 'd' && selectedIdxs.size) { duplicateSelection(); e.preventDefault(); }
      else if (k === 'a' && layers.length) {
        selectedIdxs.clear();
        for (let i = 0; i < layers.length; i++) selectedIdxs.add(i);
        selectedIdx = layers.length - 1;
        refreshAll();
        e.preventDefault();
      }
      return;
    }
    if (!selectedIdxs.size) return;
    const step = e.shiftKey ? 50 : (e.altKey ? 0.5 : 5);
    const rotStep = e.shiftKey ? 15 : 1;
    const k = e.key.toLowerCase();

    // One-shot actions (operate on primary).
    if (k === 'm') { for (const i of [...selectedIdxs]) mirrorAction(i); e.preventDefault(); return; }
    if (k === 'f') { for (const i of selectedIdxs) if (!isLocked(i)) toggleFlip(i); e.preventDefault(); return; }
    if (k === 'l') { for (const i of [...selectedIdxs]) toggleLock(i); e.preventDefault(); return; }
    if (k === ']') { if (selectedIdx >= 0) moveLayer(selectedIdx, +1); e.preventDefault(); return; }
    if (k === '[') { if (selectedIdx >= 0) moveLayer(selectedIdx, -1); e.preventDefault(); return; }
    if (k === 'delete' || k === 'backspace' || e.key === 'Delete' || e.key === 'Backspace') {
      deleteSelection(); e.preventDefault(); return;
    }

    // Nudges / rotations applied to every selected (unlocked) layer.
    // Coalesce consecutive presses of the same key into one undo step.
    let touched = false;
    const isNudge = 'wasdqe'.includes(k);
    if (isNudge) pushHistoryForField(`nudge:${k}`);
    for (const i of selectedIdxs) {
      if (isLocked(i)) continue;
      const l = layers[i];
      switch (k) {
        case 'w': l.position.y += step; touched = true; break;
        case 's': l.position.y -= step; touched = true; break;
        case 'a': l.position.x -= step; touched = true; break;
        case 'd': l.position.x += step; touched = true; break;
        case 'q': l.rotation.roll = (l.rotation.roll || 0) - rotStep; touched = true; break;
        case 'e': l.rotation.roll = (l.rotation.roll || 0) + rotStep; touched = true; break;
      }
    }
    if (touched) {
      e.preventDefault();
      drawAll();
      renderList();
      renderProps();
    }
  });

  // ---------- init ----------
  resizeAll();
  updateCountBadge();
})();
