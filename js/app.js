import { openPdfjs, closePdfjs, renderBase, paintAnnots, totalRot, readImageFile, canvasToBytes } from './core.js';
import { bbox, hit, move, resized, drawAnnot, dispDims, deltaMatrix, FONTS, norm } from './annots.js';
import { buildPdf, compressPdf, rasterizeDoc, imagesToPdf } from './exporter.js';
import { makeZip } from './zip.js';
import { icon } from './icons.js';

const { PDFDocument } = window.PDFLib;

// Keep in sync with "version" in package.json on each release.
const APP_VERSION = '1.0.0';

// ============================================================ helpers
const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = true;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const baseName = () => (S.fileName || 'document').replace(/\.pdf$/i, '');

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

async function busy(msg, fn) {
  $('#busyText').textContent = msg;
  $('#busy').classList.remove('hidden');
  const set = (m) => ($('#busyText').textContent = m);
  try { return await fn(set); }
  catch (e) { console.error(e); toast(e.message || 'Something went wrong'); return undefined; }
  finally { $('#busy').classList.add('hidden'); }
}

// ---------- Android app (Capacitor) ----------
// Android's WebView ignores <a download> and the Web Share API, so the APK
// saves and shares through native plugins instead.
const cap = window.Capacitor;
const isNative = !!cap?.isNativePlatform?.();
const plugin = (name) => cap?.Plugins?.[name];

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

async function nativeShare(blob, name) {
  const { Filesystem, Share } = cap.Plugins;
  const { uri } = await Filesystem.writeFile({ path: name, data: await blobToBase64(blob), directory: 'CACHE' });
  try { await Share.share({ title: name, files: [uri], dialogTitle: 'Save or share' }); }
  catch (e) { if (!/cancel/i.test(e?.message || '')) throw e; }
}

async function nativeSave(blob, name) {
  const { Filesystem } = cap.Plugins;
  try {
    const perm = await Filesystem.checkPermissions();
    if (perm.publicStorage !== 'granted' && (await Filesystem.requestPermissions()).publicStorage !== 'granted') throw new Error('denied');
    await Filesystem.writeFile({ path: `PDF Editor/${name}`, data: await blobToBase64(blob), directory: 'DOCUMENTS', recursive: true });
    toast(`Saved to Documents/PDF Editor/${name}`, 4000);
  } catch (e) {
    console.warn('Saving to Documents failed, opening share sheet instead', e);
    await nativeShare(blob, name);
  }
}

function download(blob, name) {
  if (isNative) { nativeSave(blob, name).catch((e) => toast(e?.message || 'Could not save the file')); return; }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function shareOrDownload(blob, name, preferShare) {
  if (isNative) {
    try { await (preferShare ? nativeShare(blob, name) : nativeSave(blob, name)); }
    catch (e) { toast(e?.message || 'Could not save the file'); }
    return;
  }
  const file = new File([blob], name, { type: blob.type });
  if (preferShare && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  download(blob, name);
}

// Simple concurrency limiter for heavy page renders
function limiter(n) {
  let active = 0; const q = [];
  const next = () => {
    if (active >= n || !q.length) return;
    active++;
    const { fn, res, rej } = q.shift();
    fn().then(res, rej).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}
const queue = limiter(2);

// ============================================================ state
const DEFAULT_OPTS = () => ({
  text: { color: '#111111', size: 16, font: 'Helvetica' },
  pen: { color: '#2563eb', width: 3 },
  highlight: { color: '#facc15', width: 16 },
  shape: { color: '#dc2626', width: 3, kind: 'rect', fill: false },
});

const S = {
  open: false,
  fileName: 'document.pdf',
  sources: [],      // {id, name, bytes, doc (pdf.js), version, hasForm}
  pages: [],        // {id, src, index, w, h, ox, oy, baseRot, rot, annots[]}
  images: {},       // id -> dataUrl
  settings: { watermark: null, pageNumbers: null, meta: {} },
  tool: 'select',
  optsOpen: true,
  opts: DEFAULT_OPTS(),
  selected: null,   // {pageId, id}
  live: null,
  pageSel: new Set(),
  zoom: 1,
  view: 'home',
  dirty: false,
  viewerStale: true,
  thumbsStale: true,
};

const pageById = (id) => S.pages.find((p) => p.id === id);
const srcById = (id) => S.sources.find((s) => s.id === id);
const findAnnot = (p, id) => p && p.annots.find((a) => a.id === id);

// ---------- undo / redo ----------
const undoStack = [], redoStack = [];
const snap = () => JSON.stringify({ pages: S.pages, settings: S.settings });
function checkpoint() {
  undoStack.push(snap());
  if (undoStack.length > 80) undoStack.shift();
  redoStack.length = 0;
  S.dirty = true;
  updateChrome();
}
function restore(json) {
  const o = JSON.parse(json);
  S.pages = o.pages; S.settings = o.settings;
  S.selected = null;
  S.pageSel = new Set([...S.pageSel].filter((id) => pageById(id)));
  structureChanged();
  updateSelBar();
}
function undo() { if (!undoStack.length) return; redoStack.push(snap()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snap()); restore(redoStack.pop()); }

// ---------- images used in annotations ----------
const imgEls = new Map();
let overlayRaf = 0;
function getImg(id) {
  let el = imgEls.get(id);
  if (!el && S.images[id]) {
    el = new Image();
    el.onload = () => {
      cancelAnimationFrame(overlayRaf);
      overlayRaf = requestAnimationFrame(() => { for (const id of views.keys()) drawOverlay(id); });
    };
    el.src = S.images[id];
    imgEls.set(id, el);
  }
  return el;
}

// ============================================================ loading files
function askPassword(name, wrong) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'password', autocomplete: 'off' });
    openSheet({
      title: 'Password required',
      body: [
        h('p', { class: 'note' }, `"${name}" is password-protected.`),
        wrong && h('p', { class: 'note warn' }, 'That password was not correct. Try again.'),
        h('label', { class: 'field' }, 'Password', inp),
        h('p', { class: 'note' }, 'After unlocking, pages are converted to images so the file can be edited and saved without the password. Text will no longer be selectable.'),
      ],
      buttons: [
        { label: 'Cancel', onClick: (close) => { close(); resolve(null); } },
        { label: 'Unlock', cls: 'primary', onClick: (close) => { close(); resolve(inp.value); } },
      ],
      onDismiss: () => resolve(null),
    });
    setTimeout(() => inp.focus(), 50);
  });
}

async function openWithPassword(bytes, name) {
  let pw, wrong = false;
  for (;;) {
    try { return await openPdfjs(bytes, pw); }
    catch (e) {
      if (e.name !== 'PasswordException') throw e;
      $('#busy').classList.add('hidden');
      pw = await askPassword(name, wrong);
      if (pw == null) return null;
      $('#busy').classList.remove('hidden');
      wrong = true;
    }
  }
}

async function addPdfBytes(bytes, name, insertAt = S.pages.length) {
  let lib = null, needsRaster = false;
  try { lib = await PDFDocument.load(bytes, { updateMetadata: false }); }
  catch (e) { needsRaster = true; } // encrypted or damaged: pdf.js can usually still read it

  if (needsRaster) {
    const d = await openWithPassword(bytes, name);
    if (!d) return false;
    $('#busyText').textContent = 'Unlocking pages…';
    bytes = await rasterizeDoc(d, { dpi: 150, quality: 0.85 });
    closePdfjs(d);
    lib = await PDFDocument.load(bytes);
    toast('Unlocked. Pages were converted to images.');
  }

  const doc = await openPdfjs(bytes);
  const src = { id: uid(), name, bytes, doc, version: 0, hasForm: false };
  try { src.hasForm = lib.getForm().getFields().length > 0; } catch { /* no form */ }

  const newPages = [];
  for (let i = 0; i < doc.numPages; i++) {
    const pg = await doc.getPage(i + 1);
    const [x0, y0, x1, y1] = pg.view;
    newPages.push({ id: uid(), src: src.id, index: i, w: x1 - x0, h: y1 - y0, ox: x0, oy: y0, baseRot: pg.rotate || 0, rot: 0, annots: [] });
  }

  if (!S.open) {
    S.fileName = name;
    try {
      const { info } = await doc.getMetadata();
      S.settings.meta = { title: info?.Title || '', author: info?.Author || '', subject: info?.Subject || '', keywords: info?.Keywords || '' };
    } catch { /* ignore */ }
  }
  if (S.open) checkpoint();
  S.sources.push(src);
  S.pages.splice(insertAt, 0, ...newPages);
  S.open = true;
  structureChanged();
  return true;
}

async function handleFiles(fileList, insertAt = S.pages.length) {
  const files = [...fileList];
  const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  const imgs = files.filter((f) => f.type.startsWith('image/'));
  if (!pdfs.length && !imgs.length) { toast('Please choose PDF or image files.'); return; }
  const wasOpen = S.open;
  await busy('Opening…', async (set) => {
    let at = insertAt;
    for (const f of pdfs) {
      set(`Opening ${f.name}…`);
      const before = S.pages.length;
      await addPdfBytes(new Uint8Array(await f.arrayBuffer()), f.name, at);
      at += S.pages.length - before;
    }
    if (imgs.length) { $('#busy').classList.add('hidden'); await imagesFlow(imgs, at); }
  });
  if (!wasOpen && S.open) setView('edit');
  else if (wasOpen && pdfs.length) toast(`Added ${pdfs.length} PDF${pdfs.length > 1 ? 's' : ''}`);
}

function imagesFlow(files, insertAt) {
  return new Promise((resolve) => {
    const size = h('select', {}, h('option', { value: 'a4' }, 'A4'), h('option', { value: 'letter' }, 'US Letter'), h('option', { value: 'fit' }, 'Same as image'));
    const margin = h('select', {}, h('option', { value: '0' }, 'None'), h('option', { value: '18', selected: true }, 'Small'), h('option', { value: '40' }, 'Large'));
    openSheet({
      title: `Add ${files.length} image${files.length > 1 ? 's' : ''} as pages`,
      body: [
        h('div', { class: 'row' }, h('label', { class: 'field' }, 'Page size', size), h('label', { class: 'field' }, 'Margin', margin)),
        h('p', { class: 'note' }, 'Each image becomes one page, in the order you picked them. Landscape images get landscape pages.'),
      ],
      buttons: [
        { label: 'Cancel', onClick: (c) => { c(); resolve(); } },
        {
          label: 'Create pages', cls: 'primary', onClick: async (c) => {
            c();
            const wasOpen = S.open;
            await busy('Converting images…', async (set) => {
              const ims = [];
              for (let i = 0; i < files.length; i++) { set(`Reading image ${i + 1} of ${files.length}…`); ims.push(await readImageFile(files[i], 3000)); }
              set('Building pages…');
              const bytes = await imagesToPdf(ims, { size: size.value, margin: +margin.value });
              await addPdfBytes(bytes, wasOpen ? 'images.pdf' : 'images.pdf', insertAt);
            });
            if (!wasOpen && S.open) setView('edit');
            resolve();
          },
        },
      ],
      onDismiss: resolve,
    });
  });
}

let pdfPickAt = 0, imgPickMode = 'pages', imgPickAt = 0, pendingPlace = null;
function pickPdf(insertAt = S.pages.length) { pdfPickAt = insertAt; $('#filePdf').click(); }
function pickImages(insertAt = S.pages.length) { imgPickMode = 'pages'; imgPickAt = insertAt; $('#fileImg').multiple = true; $('#fileImg').click(); }
function pickPlaceImage(place) { imgPickMode = 'place'; pendingPlace = place; $('#fileImg').multiple = false; $('#fileImg').click(); }

function newBlankDoc() {
  S.open = true; S.fileName = 'document.pdf';
  S.pages = [{ id: uid(), src: null, index: 0, w: 595.28, h: 841.89, ox: 0, oy: 0, baseRot: 0, rot: 0, annots: [] }];
  structureChanged();
  setView('edit');
}

async function closeDoc() {
  if (S.dirty && !(await confirmSheet('Close document?', 'Unsaved changes will be lost.', 'Close', true))) return;
  for (const s of S.sources) closePdfjs(s.doc);
  Object.assign(S, {
    open: false, fileName: 'document.pdf', sources: [], pages: [], images: {}, selected: null, live: null,
    settings: { watermark: null, pageNumbers: null, meta: {} }, pageSel: new Set(), dirty: false, zoom: 1,
  });
  imgEls.clear(); renderCache.clear();
  undoStack.length = redoStack.length = 0;
  structureChanged(); updateSelBar();
  setView('home');
}

// ============================================================ chrome / views
function updateChrome() {
  $('#docName').textContent = S.open ? `${S.fileName} · ${S.pages.length} page${S.pages.length === 1 ? '' : 's'}` : '';
  $('#btnSave').disabled = !S.open || !S.pages.length;
  $('#btnUndo').disabled = !undoStack.length;
  $('#btnRedo').disabled = !redoStack.length;
  for (const t of document.querySelectorAll('.tab[data-view="edit"], .tab[data-view="pages"]')) t.disabled = !S.open;
}

function setView(v) {
  if (!S.open && (v === 'edit' || v === 'pages')) v = 'home';
  S.view = v;
  const map = { home: '#viewHome', edit: '#viewEdit', pages: '#viewPages', tools: '#viewTools' };
  for (const [k, sel] of Object.entries(map)) $(sel).classList.toggle('active', k === v);
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.view === v);
  document.body.classList.toggle('editing', v === 'edit');
  $('#toolbar').classList.toggle('hidden', v !== 'edit');
  if (v !== 'edit' && S.selected) select(null);
  renderToolOpts(); updateSelBar();
  if (v === 'edit' && S.viewerStale) buildViewer();
  if (v === 'pages' && S.thumbsStale) buildThumbs();
  if (v === 'pages') updatePageActions();
  if (v === 'tools') buildToolCards();
  updateChrome();
}

function structureChanged() {
  S.viewerStale = true; S.thumbsStale = true;
  if (S.view === 'edit') buildViewer();
  if (S.view === 'pages') buildThumbs();
  updateChrome();
}

function refreshOverlays() {
  for (const id of views.keys()) drawOverlay(id);
  S.thumbsStale = true;
}

// ============================================================ editor viewer
const views = new Map();
const renderCache = new Map();
let io = null;

function cacheSet(k, c) {
  renderCache.set(k, c);
  while (renderCache.size > 10) renderCache.delete(renderCache.keys().next().value);
}

function buildViewer() {
  S.viewerStale = false;
  const scroller = $('#viewEdit');
  const ratio = scroller.scrollHeight ? scroller.scrollTop / scroller.scrollHeight : 0;
  const viewer = $('#viewer');
  viewer.innerHTML = '';
  views.clear();
  io && io.disconnect();
  $('#zoomLabel').textContent = Math.round(S.zoom * 100) + '%';
  viewer.classList.toggle('drawing', DRAW_TOOLS.has(S.tool));
  if (!S.pages.length) {
    viewer.append(h('div', { class: 'page-empty' }, h('p', {}, 'This document has no pages.'), h('button', { class: 'btn primary', onclick: () => pickPdf(0) }, 'Add a PDF')));
    return;
  }
  const avail = Math.min((scroller.clientWidth || window.innerWidth) - 24, 900);
  io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) paintBase(e.target.dataset.id);
  }, { root: scroller, rootMargin: '900px 0px' });

  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  S.pages.forEach((p, i) => {
    const [dw, dh] = dispDims(p.w, p.h, totalRot(p));
    const cssW = Math.max(120, Math.round(avail * S.zoom));
    const cssH = Math.round(dh * (cssW / dw));
    const el = h('div', { class: 'page', 'data-id': p.id, style: `width:${cssW}px;height:${cssH}px` });
    const base = h('canvas', { class: 'base' });
    const ov = h('canvas', { class: 'overlay' });
    ov.width = Math.round(cssW * dpr); ov.height = Math.round(cssH * dpr);
    el.append(base, ov, h('div', { class: 'page-num' }, `${i + 1} / ${S.pages.length}`));
    viewer.append(el);
    const v = { id: p.id, el, base, ov, dw, dh, cssW, cssH, dpr, painted: null };
    views.set(p.id, v);
    attachPointer(v);
    drawOverlay(p.id);
    io.observe(el);
  });
  requestAnimationFrame(() => { scroller.scrollTop = ratio * scroller.scrollHeight; });
}

async function paintBase(id) {
  const v = views.get(id), p = pageById(id);
  if (!v || !p) return;
  const src = srcById(p.src);
  const pxW = Math.round(v.cssW * v.dpr);
  const key = `${src ? src.id + ':' + src.version : 'blank'}|${p.index}|${totalRot(p)}|${pxW}`;
  if (v.painted === key) return;
  v.painted = key;
  let c = renderCache.get(key);
  if (!c) {
    try { c = await queue(() => renderBase(p, src, pxW / v.dw)); }
    catch (e) { console.warn(e); v.painted = null; return; }
    cacheSet(key, c);
  }
  if (views.get(id) !== v) return;
  v.base.width = c.width; v.base.height = c.height;
  v.base.getContext('2d').drawImage(c, 0, 0);
}

function stampsFor(p) {
  const start = S.settings.pageNumbers?.start ?? 1;
  return { settings: S.settings, n: S.pages.indexOf(p) + start, total: S.pages.length + start - 1 };
}

function drawOverlay(id) {
  const v = views.get(id), p = pageById(id);
  if (!v || !p) return;
  const ctx = v.ov.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, v.ov.width, v.ov.height);
  const k = v.ov.width / v.dw;
  paintAnnots(ctx, p, k, getImg, stampsFor(p));
  if (S.live && S.live.pageId === id) {
    ctx.setTransform(new DOMMatrix().scale(k, k));
    drawAnnot(ctx, S.live.a, getImg);
  }
  const sel = S.selected && S.selected.pageId === id ? findAnnot(p, S.selected.id) : null;
  if (sel) {
    const [w0, h0] = dispDims(p.w, p.h, sel.r0);
    ctx.setTransform(new DOMMatrix().scale(k, k).multiply(deltaMatrix(totalRot(p) - sel.r0, w0, h0)));
    const b = bbox(sel), px = v.dpr / k; // points per CSS pixel
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 1.5 * px;
    ctx.setLineDash([5 * px, 4 * px]);
    ctx.strokeRect(b.x - 3 * px, b.y - 3 * px, b.w + 6 * px, b.h + 6 * px);
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff'; ctx.lineWidth = 2 * px;
    ctx.beginPath(); ctx.arc(b.x + b.w + 3 * px, b.y + b.h + 3 * px, 9 * px, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  v.el.classList.toggle('has-sel', !!sel);
}

// ---------- pointer interaction ----------
const DRAW_TOOLS = new Set(['pen', 'highlight', 'shape', 'whiteout', 'redact']);
let drag = null;

function attachPointer(v) {
  const id = v.id;
  v.ov.addEventListener('pointerdown', (e) => onDown(e, id));
  v.ov.addEventListener('pointermove', (e) => onMove(e, id));
  v.ov.addEventListener('pointerup', (e) => onUp(e, id));
  v.ov.addEventListener('pointercancel', () => {
    if (drag && drag.id === id) { if (drag.moved) afterAnnotChange(id); drag = null; }
    if (S.live) { S.live = null; drawOverlay(id); }
  });
}

function evPt(e, id) {
  const v = views.get(id);
  const rc = v.ov.getBoundingClientRect();
  return { u: ((e.clientX - rc.left) * v.dw) / rc.width, v: ((e.clientY - rc.top) * v.dh) / rc.height, ppx: v.dw / rc.width };
}

function toAnnotSpace(p, a, pt) {
  const [w0, h0] = dispDims(p.w, p.h, a.r0);
  const q = deltaMatrix(totalRot(p) - a.r0, w0, h0).inverse().transformPoint(new DOMPoint(pt.u, pt.v));
  return { x: q.x, y: q.y };
}

function onDown(e, id) {
  if (e.button > 0) return;
  const p = pageById(id); if (!p) return;
  const pt = evPt(e, id), tool = S.tool, o = S.opts[tool] || {}, r = totalRot(p);
  const capture = () => { try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ } };

  if (tool === 'select') {
    const cur = S.selected && S.selected.pageId === id ? findAnnot(p, S.selected.id) : null;
    if (cur) {
      const q = toAnnotSpace(p, cur, pt), b = bbox(cur);
      if (Math.hypot(q.x - (b.x + b.w + 3 * pt.ppx), q.y - (b.y + b.h + 3 * pt.ppx)) < 20 * pt.ppx) {
        drag = { mode: 'resize', id, a: cur, orig: structuredClone(cur), ob: b, start: q, moved: false };
        capture(); e.preventDefault(); return;
      }
    }
    for (let i = p.annots.length - 1; i >= 0; i--) {
      const a = p.annots[i], q = toAnnotSpace(p, a, pt);
      if (hit(a, q.x, q.y, 6 * pt.ppx)) {
        const wasSel = S.selected && S.selected.id === a.id;
        if (!wasSel) select(id, a.id);
        drag = { mode: 'move', id, a, last: q, moved: false, wasSel };
        capture(); return;
      }
    }
    if (S.selected) select(null);
    return;
  }
  if (tool === 'pen' || tool === 'highlight') {
    const hl = tool === 'highlight';
    S.live = { pageId: id, a: { id: uid(), type: 'pen', r0: r, points: [[pt.u, pt.v]], color: o.color, width: o.width, opacity: hl ? 0.4 : 1, hl } };
  } else if (tool === 'shape') {
    S.live = { pageId: id, a: { id: uid(), type: 'shape', kind: o.kind, r0: r, x1: pt.u, y1: pt.v, x2: pt.u, y2: pt.v, color: o.color, width: o.width, fill: !!o.fill } };
  } else if (tool === 'whiteout' || tool === 'redact') {
    S.live = { pageId: id, sx: pt.u, sy: pt.v, a: { id: uid(), type: tool === 'whiteout' ? 'box' : 'redact', r0: r, x: pt.u, y: pt.v, w: 0, h: 0, fill: '#ffffff' } };
  } else {
    drag = { mode: 'tap', id, u: pt.u, v: pt.v, cx: e.clientX, cy: e.clientY };
    return;
  }
  drag = { mode: 'live', id };
  capture(); e.preventDefault();
  drawOverlay(id);
}

function onMove(e, id) {
  if (!drag || drag.id !== id || drag.mode === 'tap') return;
  const p = pageById(id); if (!p) return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  if (drag.mode === 'move' || drag.mode === 'resize') {
    const pt = evPt(e, id);
    const q = toAnnotSpace(p, drag.a, pt);
    if (drag.mode === 'move') {
      const dx = q.x - drag.last.x, dy = q.y - drag.last.y;
      if (!drag.moved) { if (Math.hypot(dx, dy) < 3 * pt.ppx) return; checkpoint(); drag.moved = true; }
      move(drag.a, dx, dy);
      drag.last = q;
    } else {
      if (!drag.moved) { checkpoint(); drag.moved = true; }
      Object.assign(drag.a, resized(drag.orig, drag.ob, drag.ob.w + (q.x - drag.start.x), drag.ob.h + (q.y - drag.start.y)));
    }
    drawOverlay(id);
    return;
  }
  if (drag.mode === 'live' && S.live) {
    const a = S.live.a;
    for (const ev of (evs.length ? evs : [e])) {
      const pt = evPt(ev, id);
      if (a.type === 'pen') {
        const last = a.points[a.points.length - 1];
        if (Math.hypot(pt.u - last[0], pt.v - last[1]) > 0.8 * pt.ppx) a.points.push([pt.u, pt.v]);
      } else if (a.type === 'shape') { a.x2 = pt.u; a.y2 = pt.v; }
      else {
        a.x = Math.min(S.live.sx, pt.u); a.y = Math.min(S.live.sy, pt.v);
        a.w = Math.abs(pt.u - S.live.sx); a.h = Math.abs(pt.v - S.live.sy);
      }
    }
    drawOverlay(id);
  }
}

function onUp(e, id) {
  const d = drag; drag = null;
  if (!d || d.id !== id) return;
  if (d.mode === 'move' || d.mode === 'resize') {
    if (d.moved) afterAnnotChange(id);
    else if (d.mode === 'move' && d.wasSel && (d.a.type === 'text' || d.a.type === 'stamp')) editSelected();
    return;
  }
  if (d.mode === 'live') {
    const L = S.live; S.live = null;
    if (!L) return;
    const a = L.a;
    let ok = true;
    if (a.type === 'shape') ok = Math.hypot(a.x2 - a.x1, a.y2 - a.y1) > 3;
    if (a.type === 'box' || a.type === 'redact') ok = a.w > 3 && a.h > 3;
    if (ok) { checkpoint(); pageById(id).annots.push(a); afterAnnotChange(id); }
    else drawOverlay(id);
    return;
  }
  if (d.mode === 'tap' && Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < 10) placeAt(id, d.u, d.v);
}

function afterAnnotChange(id) {
  drawOverlay(id);
  S.thumbsStale = true;
  S.dirty = true;
  updateChrome();
}

function placeAt(pageId, u, v) {
  const place = { pageId, u, v };
  if (S.tool === 'text') openTextEditor(null, place);
  else if (S.tool === 'image') pickPlaceImage(place);
  else if (S.tool === 'signature') openSignature(place);
  else if (S.tool === 'stamp') openStampPicker(place);
}

function addAnnot(pageId, a, { selectIt = true } = {}) {
  const p = pageById(pageId); if (!p) return;
  checkpoint();
  p.annots.push(a);
  if (selectIt) { setTool('select'); select(pageId, a.id); } else drawOverlay(pageId);
  afterAnnotChange(pageId);
}

function addImageAnnot(place, im, targetW) {
  const p = pageById(place.pageId); if (!p) return;
  const r = totalRot(p);
  const [dw, dh] = dispDims(p.w, p.h, r);
  let w = Math.min(targetW, dw * 0.8), hh = (w * im.h) / im.w;
  if (hh > dh * 0.8) { hh = dh * 0.8; w = (hh * im.w) / im.h; }
  const imgId = uid();
  S.images[imgId] = im.dataUrl;
  addAnnot(place.pageId, {
    id: uid(), type: 'image', r0: r, img: imgId,
    x: clamp(place.u - w / 2, 0, dw - w), y: clamp(place.v - hh / 2, 0, dh - hh), w, h: hh,
  });
}

// ---------- selection ----------
function select(pageId, id) {
  const prev = S.selected;
  S.selected = pageId ? { pageId, id } : null;
  if (prev) drawOverlay(prev.pageId);
  if (pageId) drawOverlay(pageId);
  updateSelBar();
}

function selectedAnnot() {
  if (!S.selected) return null;
  return findAnnot(pageById(S.selected.pageId), S.selected.id);
}

function deleteSelected() {
  const a = selectedAnnot(); if (!a) return;
  const p = pageById(S.selected.pageId);
  checkpoint();
  p.annots = p.annots.filter((x) => x !== a);
  const pid = p.id;
  select(null);
  afterAnnotChange(pid);
}

function duplicateSelected() {
  const a = selectedAnnot(); if (!a) return;
  const pid = S.selected.pageId;
  const c = structuredClone(a);
  c.id = uid();
  move(c, 14, 14);
  addAnnot(pid, c);
}

function bringFront() {
  const a = selectedAnnot(); if (!a) return;
  const p = pageById(S.selected.pageId);
  checkpoint();
  p.annots = p.annots.filter((x) => x !== a).concat(a);
  afterAnnotChange(p.id);
}

function editSelected() {
  const a = selectedAnnot(); if (!a) return;
  if (a.type === 'text') openTextEditor(a);
  else if (a.type === 'stamp') openStampPicker(null, a);
}

function updateSelBar() {
  const bar = $('#selBar');
  const a = S.view === 'edit' ? selectedAnnot() : null;
  document.body.classList.toggle('has-sel', !!a);
  if (!a) { bar.classList.add('hidden'); renderToolOpts(); return; }
  bar.innerHTML = '';
  if (a.type === 'text' || a.type === 'stamp') bar.append(h('button', { class: 'btn', onclick: editSelected }, 'Edit'));
  bar.append(
    h('button', { class: 'btn', onclick: duplicateSelected }, 'Duplicate'),
    h('button', { class: 'btn', onclick: bringFront }, 'Front'),
    h('button', { class: 'btn danger', onclick: deleteSelected }, 'Delete'),
    h('button', { class: 'btn primary', onclick: () => select(null) }, 'Done'),
  );
  bar.classList.remove('hidden');
  $('#toolOpts').classList.add('hidden');
  document.body.classList.remove('has-opts');
}

// ============================================================ toolbar + tool options
const TOOLS = [
  ['select', 'select', 'Select'], ['text', 'text', 'Text'], ['pen', 'pen', 'Draw'], ['highlight', 'highlight', 'Highlight'],
  ['shape', 'shape', 'Shapes'], ['signature', 'sign', 'Sign'], ['image', 'image', 'Image'], ['stamp', 'stamp', 'Stamp'],
  ['whiteout', 'whiteout', 'Whiteout'], ['redact', 'redact', 'Redact'],
];

function buildToolbar() {
  const tb = $('#toolbar');
  tb.innerHTML = '';
  for (const [id, ic, label] of TOOLS) {
    tb.append(h('button', { class: 'tool' + (S.tool === id ? ' active' : ''), 'data-tool': id, onclick: () => setTool(id, true), html: icon(ic) + `<span>${label}</span>` }));
  }
}

function setTool(t, fromUser) {
  if (fromUser && S.tool === t) S.optsOpen = !S.optsOpen;
  else S.optsOpen = true;
  S.tool = t;
  if (t !== 'select' && S.selected) select(null);
  for (const b of document.querySelectorAll('.tool')) b.classList.toggle('active', b.dataset.tool === t);
  $('#viewer').classList.toggle('drawing', DRAW_TOOLS.has(t));
  renderToolOpts();
}

const COLORS = ['#111111', '#dc2626', '#2563eb', '#16a34a', '#f59e0b', '#7c3aed', '#ffffff'];
const HL_COLORS = ['#facc15', '#4ade80', '#f472b6', '#60a5fa', '#fb923c'];

function colorPicker(value, onChange, palette = COLORS) {
  const wrap = h('div', { class: 'swatches' });
  const render = (val) => {
    wrap.innerHTML = '';
    for (const c of palette) {
      wrap.append(h('button', { class: 'swatch' + (c.toLowerCase() === val.toLowerCase() ? ' active' : ''), style: `background:${c}`, 'aria-label': c, onclick: () => { onChange(c); render(c); } }));
    }
    const custom = h('input', { type: 'color', class: 'swatch-custom', value: val, 'aria-label': 'Custom colour' });
    custom.addEventListener('input', () => { onChange(custom.value); });
    wrap.append(custom);
  };
  render(value);
  return wrap;
}

function rangeRow(label, min, max, step, value, onInput, unit = '') {
  const out = h('span', {}, `${value}${unit}`);
  const inp = h('input', { type: 'range', min, max, step, value });
  inp.addEventListener('input', () => { out.textContent = inp.value + unit; onInput(+inp.value); });
  return h('label', { class: 'range-row' }, label, inp, out);
}

function seg(options, value, onChange) {
  const wrap = h('div', { class: 'seg' });
  for (const [v, label] of options) {
    wrap.append(h('button', {
      class: v === value ? 'active' : '', onclick: (e) => {
        for (const b of wrap.children) b.classList.remove('active');
        e.currentTarget.classList.add('active'); onChange(v);
      },
    }, label));
  }
  return wrap;
}

function renderToolOpts() {
  const box = $('#toolOpts');
  box.innerHTML = '';
  const t = S.tool, o = S.opts[t];
  const hints = {
    text: 'Tap the page where you want to add text.',
    whiteout: 'Drag over anything to cover it with white. Great for fixing mistakes.',
    redact: 'Drag to black out sensitive info. On save, these pages are flattened so the hidden text is truly removed.',
    image: 'Tap the page where the image should go.',
    signature: 'Tap the page where you want to sign.',
    stamp: 'Tap the page to place a stamp.',
  };
  if (hints[t]) box.append(h('div', { class: 'opt-hint' }, hints[t]));
  if (t === 'text') {
    box.append(colorPicker(o.color, (c) => (o.color = c)), rangeRow('Size', 8, 72, 1, o.size, (v) => (o.size = v)));
  } else if (t === 'pen') {
    box.append(colorPicker(o.color, (c) => (o.color = c)), rangeRow('Width', 1, 20, 1, o.width, (v) => (o.width = v)));
  } else if (t === 'highlight') {
    box.append(colorPicker(o.color, (c) => (o.color = c), HL_COLORS), rangeRow('Width', 6, 40, 1, o.width, (v) => (o.width = v)));
  } else if (t === 'shape') {
    box.append(
      seg([['rect', 'Box'], ['ellipse', 'Circle'], ['line', 'Line'], ['arrow', 'Arrow']], o.kind, (v) => (o.kind = v)),
      seg([['0', 'Outline'], ['1', 'Filled']], o.fill ? '1' : '0', (v) => (o.fill = v === '1')),
      colorPicker(o.color, (c) => (o.color = c)),
      rangeRow('Width', 1, 16, 1, o.width, (v) => (o.width = v)),
    );
  }
  const show = S.view === 'edit' && S.optsOpen && box.children.length && !selectedAnnot();
  box.classList.toggle('hidden', !show);
  document.body.classList.toggle('has-opts', !!show);
}

// ============================================================ sheets (modals)
let sheetDismiss = null;
function openSheet({ title, body = [], buttons = [], onDismiss }) {
  if (sheetDismiss) { const d = sheetDismiss; sheetDismiss = null; d(); }
  $('#sheetTitle').textContent = title;
  const b = $('#sheetBody'), f = $('#sheetFoot');
  b.innerHTML = ''; f.innerHTML = '';
  for (const el of [body].flat()) if (el) b.append(el);
  let closed = false;
  const close = () => { if (closed) return; closed = true; sheetDismiss = null; $('#sheetBackdrop').classList.add('hidden'); };
  for (const btn of buttons) {
    f.append(h('button', { class: 'btn ' + (btn.cls || ''), onclick: () => btn.onClick(close) }, btn.label));
  }
  sheetDismiss = () => { close(); onDismiss && onDismiss(); };
  $('#sheetBackdrop').classList.remove('hidden');
  b.scrollTop = 0;
  return close;
}
function dismissSheet() { if (sheetDismiss) sheetDismiss(); }

function confirmSheet(title, msg, ok = 'OK', danger = false) {
  return new Promise((res) => {
    openSheet({
      title, body: [h('p', { class: 'note' }, msg)],
      buttons: [
        { label: 'Cancel', onClick: (c) => { c(); res(false); } },
        { label: ok, cls: danger ? 'primary' : 'primary', onClick: (c) => { c(); res(true); } },
      ],
      onDismiss: () => res(false),
    });
  });
}

// ---------- text editor ----------
function openTextEditor(existing, place) {
  const o = S.opts.text;
  const cur = existing ? { ...existing } : { text: '', font: o.font, fontSize: o.size, color: o.color };
  const ta = h('textarea', { placeholder: 'Type your text…' });
  ta.value = cur.text;
  const font = h('select', {}, Object.entries(FONTS).map(([k, f]) => h('option', { value: k, selected: k === cur.font }, f.label)));
  const size = h('input', { type: 'number', min: 4, max: 300, value: Math.round(cur.fontSize) });
  let color = cur.color;
  const body = [
    h('label', { class: 'field' }, 'Text', ta),
    h('div', { class: 'row' }, h('label', { class: 'field' }, 'Font', font), h('label', { class: 'field' }, 'Size (pt)', size)),
    h('div', { class: 'field' }, 'Colour', colorPicker(color, (c) => (color = c))),
  ];
  const buttons = [{ label: 'Cancel', onClick: (c) => c() }];
  if (existing) buttons.push({ label: 'Delete', cls: 'danger', onClick: (c) => { c(); deleteSelected(); } });
  buttons.push({
    label: 'Done', cls: 'primary', onClick: (c) => {
      c();
      const text = ta.value.replace(/\s+$/, '');
      const fs = clamp(+size.value || 16, 4, 300);
      Object.assign(S.opts.text, { font: font.value, size: Math.round(fs), color });
      if (existing) {
        if (!text) { deleteSelected(); return; }
        checkpoint();
        Object.assign(existing, { text, font: font.value, fontSize: fs, color });
        afterAnnotChange(S.selected.pageId);
      } else if (text) {
        const p = pageById(place.pageId);
        addAnnot(place.pageId, { id: uid(), type: 'text', r0: totalRot(p), x: place.u, y: Math.max(0, place.v - fs * 0.6), text, font: font.value, fontSize: fs, color });
      }
    },
  });
  openSheet({ title: existing ? 'Edit text' : 'Add text', body, buttons });
  setTimeout(() => ta.focus(), 60);
}

// ---------- signature ----------
const SIG_KEY = 'pdfeditor.signatures';
const loadSigs = () => { try { return JSON.parse(localStorage.getItem(SIG_KEY) || '[]'); } catch { return []; } };
const saveSig = (url) => { try { localStorage.setItem(SIG_KEY, JSON.stringify([url, ...loadSigs().filter((s) => s !== url)].slice(0, 6))); } catch { /* storage full */ } };

function trimCanvas(c) {
  const ctx = c.getContext('2d');
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return { dataUrl: out.toDataURL('image/png'), w: out.width, h: out.height };
}

function openSignature(place) {
  let mode = 'draw', color = '#111111';
  const pad = h('canvas', { class: 'sig-pad' });
  const typed = h('input', { type: 'text', placeholder: 'Type your name' });
  const typeFonts = ['"Segoe Script", "Brush Script MT", "Apple Chancery", cursive', '"Lucida Handwriting", "Snell Roundhand", cursive', 'Georgia, serif'];
  let typeFont = 0;
  const drawArea = h('div', {}, pad, h('div', { class: 'row', style: 'margin-top:8px;align-items:center' },
    seg([['#111111', 'Black'], ['#1d4ed8', 'Blue']], color, (c) => { color = c; }),
    h('button', { class: 'btn', style: 'flex:0', onclick: () => pad.getContext('2d').clearRect(0, 0, pad.width, pad.height) }, 'Clear')));
  const typeArea = h('div', { class: 'hidden' }, h('label', { class: 'field' }, 'Your name', typed),
    h('div', { class: 'field', style: 'margin-top:8px' }, 'Style', seg([['0', 'Script'], ['1', 'Hand'], ['2', 'Serif']], '0', (v) => (typeFont = +v))));
  const saved = loadSigs();
  const sigList = saved.length ? h('div', {}, h('div', { class: 'field' }, 'Saved signatures'),
    h('div', { class: 'sig-list' }, saved.map((url) => h('button', {
      onclick: async () => {
        close();
        const img = new Image(); img.src = url; await img.decode();
        addImageAnnot(place, { dataUrl: url, w: img.naturalWidth, h: img.naturalHeight }, 150);
      },
    }, h('img', { src: url, alt: 'Saved signature' }))))) : null;

  const close = openSheet({
    title: 'Signature',
    body: [
      seg([['draw', 'Draw'], ['type', 'Type']], 'draw', (v) => { mode = v; drawArea.classList.toggle('hidden', v !== 'draw'); typeArea.classList.toggle('hidden', v !== 'type'); }),
      drawArea, typeArea, sigList,
    ],
    buttons: [
      { label: 'Cancel', onClick: (c) => c() },
      {
        label: 'Place signature', cls: 'primary', onClick: (c) => {
          let res;
          if (mode === 'draw') res = trimCanvas(pad);
          else {
            const name = typed.value.trim();
            if (!name) { toast('Type your name first'); return; }
            const cv = document.createElement('canvas'); cv.width = 1400; cv.height = 300;
            const cx = cv.getContext('2d');
            cx.fillStyle = color; cx.font = `64px ${typeFonts[typeFont]}`; cx.textBaseline = 'middle';
            cx.fillText(name, 20, 150);
            res = trimCanvas(cv);
          }
          if (!res) { toast('Draw your signature first'); return; }
          c();
          saveSig(res.dataUrl);
          addImageAnnot(place, res, 160);
        },
      },
    ],
  });

  // set up pad after it is visible
  requestAnimationFrame(() => {
    const dpr = window.devicePixelRatio || 1;
    pad.width = pad.clientWidth * dpr; pad.height = pad.clientHeight * dpr;
    const ctx = pad.getContext('2d');
    let drawing = false, last = null;
    const pos = (e) => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr]; };
    pad.onpointerdown = (e) => { drawing = true; last = pos(e); pad.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.arc(last[0], last[1], 1.4 * dpr, 0, 7); ctx.fillStyle = color; ctx.fill(); };
    pad.onpointermove = (e) => {
      if (!drawing) return;
      for (const ev of (e.getCoalescedEvents ? e.getCoalescedEvents() : [e])) {
        const p = pos(ev);
        ctx.strokeStyle = color; ctx.lineWidth = 2.8 * dpr; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
        last = p;
      }
    };
    pad.onpointerup = pad.onpointercancel = () => { drawing = false; };
  });
}

// ---------- stamps ----------
function openStampPicker(place, existing) {
  const today = new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  const presets = [['APPROVED', '#16a34a'], ['REJECTED', '#dc2626'], ['DRAFT', '#6b7280'], ['CONFIDENTIAL', '#dc2626'], ['PAID', '#2563eb'], ['FINAL', '#7c3aed'], ['RECEIVED', '#0891b2'], [today, '#2563eb']];
  const custom = h('input', { type: 'text', placeholder: 'Custom stamp text', value: existing ? existing.text : '' });
  let color = existing ? existing.color : '#dc2626';
  const apply = (text, col) => {
    text = text.trim(); if (!text) { toast('Enter stamp text'); return; }
    dismissSheet();
    if (existing) {
      checkpoint(); existing.text = text; existing.color = col; afterAnnotChange(S.selected.pageId); return;
    }
    const p = pageById(place.pageId);
    const a = { id: uid(), type: 'stamp', r0: totalRot(p), x: 0, y: 0, text, color: col, fontSize: 16 };
    const b = bbox(a);
    a.x = place.u - b.w / 2; a.y = place.v - b.h / 2;
    addAnnot(place.pageId, a);
  };
  openSheet({
    title: existing ? 'Edit stamp' : 'Choose a stamp',
    body: [
      h('div', { class: 'stamp-grid' }, presets.map(([t, c]) => h('button', { style: `color:${c}`, onclick: () => apply(t, c) }, t))),
      h('label', { class: 'field' }, 'Custom', custom),
      h('div', { class: 'field' }, 'Colour', colorPicker(color, (c) => (color = c))),
    ],
    buttons: [
      { label: 'Cancel', onClick: (c) => c() },
      { label: existing ? 'Update' : 'Use custom', cls: 'primary', onClick: () => apply(custom.value, color) },
    ],
  });
}

// ============================================================ pages view
const thumbViews = new Map();
let tio = null;

function buildThumbs() {
  S.thumbsStale = false;
  const grid = $('#thumbGrid');
  grid.innerHTML = ''; thumbViews.clear();
  tio && tio.disconnect();
  tio = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) paintThumb(e.target.dataset.id);
  }, { root: $('#viewPages'), rootMargin: '400px 0px' });
  S.pages.forEach((p, i) => {
    const c = h('canvas');
    const btn = h('button', { class: 'thumb' + (S.pageSel.has(p.id) ? ' selected' : ''), 'data-id': p.id, onclick: () => toggleSel(p.id) },
      h('div', { class: 'tframe' }, c, h('div', { class: 'check', html: icon('check') })), h('span', {}, `${i + 1}`));
    grid.append(btn);
    thumbViews.set(p.id, { c, btn, done: false });
    tio.observe(btn);
  });
  updatePageActions();
}

async function paintThumb(id) {
  const tv = thumbViews.get(id), p = pageById(id);
  if (!tv || tv.done || !p) return;
  tv.done = true;
  const [dw, dh] = dispDims(p.w, p.h, totalRot(p));
  const scale = (260 * Math.min(window.devicePixelRatio || 1, 2)) / 2 / Math.max(dw, dh);
  try {
    const c = await queue(() => renderBase(p, srcById(p.src), scale));
    paintAnnots(c.getContext('2d'), p, c.width / dw, getImg, stampsFor(p));
    if (thumbViews.get(id) !== tv) return;
    tv.c.width = c.width; tv.c.height = c.height;
    tv.c.getContext('2d').drawImage(c, 0, 0);
  } catch (e) { console.warn(e); }
}

function toggleSel(id) {
  if (S.pageSel.has(id)) S.pageSel.delete(id); else S.pageSel.add(id);
  thumbViews.get(id)?.btn.classList.toggle('selected', S.pageSel.has(id));
  updatePageActions();
}

const selIdx = () => S.pages.map((p, i) => (S.pageSel.has(p.id) ? i : -1)).filter((i) => i >= 0);
function needSel() { if (!S.pageSel.size) { toast('Select one or more pages first'); return false; } return true; }

function updatePageActions() {
  const n = S.pageSel.size;
  $('#pagesHint').textContent = n ? `${n} page${n > 1 ? 's' : ''} selected` : 'Tap pages to select them, then pick an action.';
  const bar = $('#pageActions');
  bar.innerHTML = '';
  const chip = (ic, label, fn, cls = '') => bar.append(h('button', { class: 'chip ' + cls, onclick: fn, html: icon(ic) + label }));
  chip('all', n === S.pages.length && n ? 'Select none' : 'Select all', () => {
    S.pageSel = n === S.pages.length ? new Set() : new Set(S.pages.map((p) => p.id));
    for (const [id, tv] of thumbViews) tv.btn.classList.toggle('selected', S.pageSel.has(id));
    updatePageActions();
  });
  chip('rotl', 'Rotate left', () => rotateSel(-90));
  chip('rotr', 'Rotate right', () => rotateSel(90));
  chip('left', 'Move up', () => moveSel(-1));
  chip('right', 'Move down', () => moveSel(1));
  chip('copy', 'Duplicate', duplicateSel);
  chip('extract', 'Extract', extractSel);
  chip('open', 'Open', openSel);
  chip('trash', 'Delete', deleteSel, 'danger');
  chip('blank', 'Blank page', insertBlank);
  chip('plus', 'Add PDF', () => pickPdf(insertPos()));
  chip('image', 'Add images', () => pickImages(insertPos()));
  chip('reverse', 'Reverse order', () => { checkpoint(); S.pages.reverse(); structureChanged(); });
}

const insertPos = () => { const idx = selIdx(); return idx.length ? idx[idx.length - 1] + 1 : S.pages.length; };

function rotateSel(d) {
  if (!needSel()) return;
  checkpoint();
  for (const p of S.pages) if (S.pageSel.has(p.id)) p.rot = norm(p.rot + d);
  structureChanged();
}

function moveSel(dir) {
  if (!needSel()) return;
  checkpoint();
  const a = S.pages, sel = (i) => S.pageSel.has(a[i].id);
  if (dir < 0) { for (let i = 1; i < a.length; i++) if (sel(i) && !sel(i - 1)) [a[i - 1], a[i]] = [a[i], a[i - 1]]; }
  else { for (let i = a.length - 2; i >= 0; i--) if (sel(i) && !sel(i + 1)) [a[i + 1], a[i]] = [a[i], a[i + 1]]; }
  structureChanged();
}

function clonePage(p) {
  const c = structuredClone(p);
  c.id = uid();
  c.annots.forEach((a) => (a.id = uid()));
  return c;
}

function duplicateSel() {
  if (!needSel()) return;
  checkpoint();
  const out = [];
  for (const p of S.pages) { out.push(p); if (S.pageSel.has(p.id)) out.push(clonePage(p)); }
  S.pages = out;
  structureChanged();
}

async function deleteSel() {
  if (!needSel()) return;
  const n = S.pageSel.size;
  if (n === S.pages.length && !(await confirmSheet('Delete all pages?', 'The document will be empty. You can undo this.', 'Delete all', true))) return;
  checkpoint();
  S.pages = S.pages.filter((p) => !S.pageSel.has(p.id));
  S.pageSel.clear();
  structureChanged();
  toast(`Deleted ${n} page${n > 1 ? 's' : ''}`);
}

function insertBlank() {
  const at = insertPos();
  const ref = S.pages[Math.max(0, at - 1)];
  let w = 595.28, hh = 841.89;
  if (ref) [w, hh] = dispDims(ref.w, ref.h, totalRot(ref));
  checkpoint();
  S.pages.splice(at, 0, { id: uid(), src: null, index: 0, w, h: hh, ox: 0, oy: 0, baseRot: 0, rot: 0, annots: [] });
  structureChanged();
  toast('Blank page added');
}

function openSel() {
  const idx = selIdx();
  const target = S.pages[idx[0] ?? 0];
  setView('edit');
  if (!target) return;
  requestAnimationFrame(() => views.get(target.id)?.el.scrollIntoView({ block: 'start' }));
}

async function extractSel() {
  if (!needSel()) return;
  const pages = S.pages.filter((p) => S.pageSel.has(p.id));
  await busy('Extracting pages…', async () => {
    const bytes = await buildPdf(stateFor(), { pages });
    download(new Blob([bytes], { type: 'application/pdf' }), `${baseName()}-pages.pdf`);
  });
}

// ============================================================ tools view
const stateFor = () => ({ sources: S.sources, pages: S.pages, images: S.images, settings: S.settings });

function needDoc() {
  if (!S.open || !S.pages.length) { toast('Open a PDF first'); return false; }
  return true;
}

function buildToolCards() {
  const wrap = $('#toolCards');
  wrap.innerHTML = '';
  const section = (t) => wrap.append(h('div', { class: 'tools-section' }, t));
  const card = (ic, title, desc, fn) => wrap.append(h('button', { class: 'tool-card', onclick: fn },
    h('div', { class: 'tc-icon', html: icon(ic) }), h('b', {}, title), h('small', {}, desc)));
  const goTool = (t) => () => { if (!needDoc()) return; setView('edit'); setTool(t); };

  section('Edit & sign');
  card('text', 'Add text', 'Type anywhere on a page', goTool('text'));
  card('sign', 'Sign', 'Draw or type your signature', goTool('signature'));
  card('form', 'Fill form', 'Fill in fillable PDF fields', () => needDoc() && openForms());
  card('redact', 'Redact', 'Permanently black out info', goTool('redact'));
  section('Organize');
  card('merge', 'Merge PDFs', 'Combine several PDFs into one', () => pickPdf(S.pages.length));
  card('split', 'Split PDF', 'Break into several files', () => needDoc() && openSplit());
  card('extract', 'Extract pages', 'Save chosen pages as a new PDF', () => needDoc() && openExtract());
  card('pages', 'Organize pages', 'Reorder, rotate, delete, duplicate', () => needDoc() && setView('pages'));
  section('Convert');
  card('image', 'Images to PDF', 'JPG, PNG and more to PDF', () => pickImages(S.pages.length));
  card('download', 'PDF to images', 'Save pages as JPG or PNG', () => needDoc() && openToImages());
  card('txt', 'Extract text', 'Copy all the text from the PDF', () => needDoc() && extractText());
  section('Optimize & finish');
  card('compress', 'Compress', 'Make the file smaller', () => needDoc() && openCompress());
  card('water', 'Watermark', 'Add text across every page', () => needDoc() && openWatermark());
  card('hash', 'Page numbers', 'Number every page', () => needDoc() && openPageNumbers());
  card('lock', 'Unlock PDF', 'Open a password-protected PDF', () => pickPdf(S.pages.length));
  card('info', 'Document details', 'Title, author, keywords', () => needDoc() && openMeta());
}

function parseRanges(str, n) {
  const groups = [];
  for (const part of str.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)?\s*(-)?\s*(\d+)?$/);
    if (!m || (!m[1] && !m[3])) throw new Error(`Couldn't understand "${part}"`);
    const a = m[1] ? +m[1] : 1;
    const b = m[2] ? (m[3] ? +m[3] : n) : a;
    if (a < 1 || b > n || a > b) throw new Error(`"${part}" is outside pages 1–${n}`);
    const g = [];
    for (let i = a; i <= b; i++) g.push(i - 1);
    groups.push(g);
  }
  if (!groups.length) throw new Error('Enter at least one page');
  return groups;
}

function openSplit() {
  let mode = 'every';
  const every = h('input', { type: 'number', min: 1, value: 1 });
  const ranges = h('input', { type: 'text', placeholder: 'e.g. 1-3, 4-6, 7-' });
  const everyF = h('label', { class: 'field' }, 'Pages per file', every);
  const rangesF = h('label', { class: 'field hidden' }, 'Ranges (each range becomes one file)', ranges);
  openSheet({
    title: 'Split PDF',
    body: [
      seg([['every', 'Every N pages'], ['ranges', 'Custom ranges']], mode, (v) => { mode = v; everyF.classList.toggle('hidden', v !== 'every'); rangesF.classList.toggle('hidden', v !== 'ranges'); }),
      everyF, rangesF,
      h('p', { class: 'note' }, `This document has ${S.pages.length} pages. Several files are saved together as one ZIP.`),
    ],
    buttons: [
      { label: 'Cancel', onClick: (c) => c() },
      {
        label: 'Split', cls: 'primary', onClick: async (c) => {
          let groups;
          try {
            if (mode === 'every') {
              const k = Math.max(1, Math.floor(+every.value || 1));
              groups = [];
              for (let i = 0; i < S.pages.length; i += k) groups.push([...Array(Math.min(k, S.pages.length - i)).keys()].map((j) => i + j));
            } else groups = parseRanges(ranges.value, S.pages.length);
          } catch (e) { toast(e.message); return; }
          c();
          await busy('Splitting…', async (set) => {
            const files = [];
            for (let i = 0; i < groups.length; i++) {
              set(`Creating file ${i + 1} of ${groups.length}…`);
              const bytes = await buildPdf(stateFor(), { pages: groups[i].map((j) => S.pages[j]) });
              const g = groups[i];
              files.push({ name: `${baseName()}_${g[0] + 1}${g.length > 1 ? '-' + (g[g.length - 1] + 1) : ''}.pdf`, data: bytes });
            }
            if (files.length === 1) download(new Blob([files[0].data], { type: 'application/pdf' }), files[0].name);
            else download(makeZip(files), `${baseName()}-split.zip`);
            toast(`Created ${files.length} file${files.length > 1 ? 's' : ''}`);
          });
        },
      },
    ],
  });
}

function openExtract() {
  const pre = selIdx().map((i) => i + 1).join(', ');
  const ranges = h('input', { type: 'text', value: pre || '1', placeholder: 'e.g. 1, 3, 5-8' });
  const del = h('input', { type: 'checkbox' });
  openSheet({
    title: 'Extract pages',
    body: [
      h('label', { class: 'field' }, `Pages to extract (1–${S.pages.length})`, ranges),
      h('label', { class: 'check-row' }, del, 'Also remove them from this document'),
    ],
    buttons: [
      { label: 'Cancel', onClick: (c) => c() },
      {
        label: 'Extract', cls: 'primary', onClick: async (c) => {
          let idx;
          try { idx = [...new Set(parseRanges(ranges.value, S.pages.length).flat())]; } catch (e) { toast(e.message); return; }
          c();
          const pages = idx.map((i) => S.pages[i]);
          await busy('Extracting…', async () => {
            const bytes = await buildPdf(stateFor(), { pages });
            download(new Blob([bytes], { type: 'application/pdf' }), `${baseName()}-extract.pdf`);
          });
          if (del.checked) { checkpoint(); const ids = new Set(pages.map((p) => p.id)); S.pages = S.pages.filter((p) => !ids.has(p.id)); structureChanged(); }
        },
      },
    ],
  });
}

function openToImages() {
  let fmt = 'jpg', dpi = 150;
  const ranges = h('input', { type: 'text', placeholder: `All pages (or e.g. 1-3, 5)` });
  openSheet({
    title: 'PDF to images',
    body: [
      h('div', { class: 'field' }, 'Format', seg([['jpg', 'JPG'], ['png', 'PNG']], fmt, (v) => (fmt = v))),
      h('div', { class: 'field' }, 'Quality', seg([['72', 'Screen'], ['150', 'Standard'], ['300', 'Print']], String(dpi), (v) => (dpi = +v))),
      h('label', { class: 'field' }, 'Pages', ranges),
      h('p', { class: 'note' }, 'Your edits, watermark and page numbers are included. Several images are saved as one ZIP.'),
    ],
    buttons: [
      { label: 'Cancel', onClick: (c) => c() },
      {
        label: 'Convert', cls: 'primary', onClick: async (c) => {
          let idx;
          try { idx = ranges.value.trim() ? [...new Set(parseRanges(ranges.value, S.pages.length).flat())] : S.pages.map((_, i) => i); }
          catch (e) { toast(e.message); return; }
          c();
          await busy('Rendering pages…', async (set) => {
            const files = [];
            for (let n = 0; n < idx.length; n++) {
              set(`Page ${n + 1} of ${idx.length}…`);
              const p = S.pages[idx[n]];
              const [dw] = dispDims(p.w, p.h, totalRot(p));
              const cv = await renderBase(p, srcById(p.src), dpi / 72);
              await Promise.all(p.annots.filter((a) => a.type === 'image').map((a) => getImg(a.img)?.decode?.().catch(() => {})));
              paintAnnots(cv.getContext('2d'), p, cv.width / dw, getImg, stampsFor(p));
              const data = await canvasToBytes(cv, fmt === 'png' ? 'image/png' : 'image/jpeg', 0.92);
              files.push({ name: `${baseName()}-page-${idx[n] + 1}.${fmt}`, data });
              cv.width = cv.height = 0;
            }
            if (files.length === 1) download(new Blob([files[0].data], { type: fmt === 'png' ? 'image/png' : 'image/jpeg' }), files[0].name);
            else download(makeZip(files), `${baseName()}-images.zip`);
          });
        },
      },
    ],
  });
}

function openCompress() {
  let level = 'balanced', gray = false;
  const LEVELS = { strong: { dpi: 72, quality: 0.5 }, balanced: { dpi: 110, quality: 0.65 }, light: { dpi: 150, quality: 0.8 } };
  const grayBox = h('input', { type: 'checkbox' });
  grayBox.addEventListener('change', () => (gray = grayBox.checked));
  openSheet({
    title: 'Compress PDF',
    body: [
      h('div', { class: 'field' }, 'Compression', seg([['strong', 'Strong'], ['balanced', 'Balanced'], ['light', 'Light']], level, (v) => (level = v))),
      h('label', { class: 'check-row' }, grayBox, 'Convert to black & white (smaller)'),
      h('p', { class: 'note warn' }, 'Compression turns pages into images. The text will look the same but can no longer be selected or searched.'),
    ],
    buttons: [
      { label: 'Cancel', onClick: (c) => c() },
      {
        label: 'Compress', cls: 'primary', onClick: async (c) => {
          c();
          const res = await busy('Preparing…', async (set) => {
            const original = await buildPdf(stateFor(), { onProgress: (i, n) => set(`Preparing page ${i + 1} of ${n}…`) });
            const small = await compressPdf(original, { ...LEVELS[level], gray, onProgress: (i, n) => set(`Compressing page ${i + 1} of ${n}…`) });
            return { original, small };
          });
          if (!res) return;
          const { original, small } = res;
          const saved = 1 - small.length / original.length;
          const better = small.length < original.length;
          openSheet({
            title: better ? 'Compressed' : 'Already compact',
            body: [
              h('p', { class: 'note' }, `Before: ${fmtSize(original.length)} · After: ${fmtSize(small.length)}`),
              better ? h('p', { class: 'note' }, `Saved ${Math.round(saved * 100)}%.`) : h('p', { class: 'note warn' }, 'Compressing made this file bigger, so the original is the better choice. You can still download either one.'),
            ],
            buttons: [
              { label: 'Download original', onClick: (cl) => { cl(); download(new Blob([original], { type: 'application/pdf' }), `${baseName()}.pdf`); } },
              { label: 'Download compressed', cls: 'primary', onClick: (cl) => { cl(); download(new Blob([small], { type: 'application/pdf' }), `${baseName()}-compressed.pdf`); } },
            ],
          });
        },
      },
    ],
  });
}

function openWatermark() {
  const wm = S.settings.watermark || { text: 'CONFIDENTIAL', size: 60, opacity: 0.18, color: '#dc2626', angle: 45 };
  const cfg = { ...wm };
  const text = h('input', { type: 'text', value: cfg.text });
  const size = h('input', { type: 'number', min: 8, max: 200, value: cfg.size });
  openSheet({
    title: 'Watermark',
    body: [
      h('label', { class: 'field' }, 'Text', text),
      h('div', { class: 'row' }, h('label', { class: 'field' }, 'Size (pt)', size),
        h('div', { class: 'field' }, 'Angle', seg([['0', '0°'], ['30', '30°'], ['45', '45°'], ['90', '90°']], String(cfg.angle), (v) => (cfg.angle = +v)))),
      rangeRow('Opacity', 0.05, 1, 0.05, cfg.opacity, (v) => (cfg.opacity = v)),
      h('div', { class: 'field' }, 'Colour', colorPicker(cfg.color, (c) => (cfg.color = c))),
      h('p', { class: 'note' }, 'Applied to every page. You can preview it in the editor before saving.'),
    ],
    buttons: [
      { label: 'Cancel', onClick: (c) => c() },
      S.settings.watermark && { label: 'Remove', cls: 'danger', onClick: (c) => { c(); checkpoint(); S.settings.watermark = null; refreshOverlays(); toast('Watermark removed'); } },
      {
        label: 'Apply', cls: 'primary', onClick: (c) => {
          if (!text.value.trim()) { toast('Enter watermark text'); return; }
          c(); checkpoint();
          S.settings.watermark = { ...cfg, text: text.value.trim(), size: clamp(+size.value || 60, 8, 200) };
          refreshOverlays(); toast('Watermark added');
          if (S.view !== 'edit') setView('edit');
        },
      },
    ].filter(Boolean),
  });
}

function openPageNumbers() {
  const pn = S.settings.pageNumbers || { pos: 'bottom-center', format: '{n}', size: 11, start: 1, color: '#111111' };
  const cfg = { ...pn };
  const pos = h('select', {}, [['bottom-center', 'Bottom centre'], ['bottom-right', 'Bottom right'], ['bottom-left', 'Bottom left'], ['top-center', 'Top centre'], ['top-right', 'Top right'], ['top-left', 'Top left']]
    .map(([v, l]) => h('option', { value: v, selected: v === cfg.pos }, l)));
  const formats = ['{n}', 'Page {n}', 'Page {n} of {total}', '{n} / {total}', '- {n} -'];
  const fmt = h('select', {}, formats.map((f) => h('option', { value: f, selected: f === cfg.format }, f.replace('{n}', '1').replace('{total}', String(S.pages.length)))));
  const size = h('input', { type: 'number', min: 6, max: 48, value: cfg.size });
  const start = h('input', { type: 'number', min: 0, value: cfg.start });
  openSheet({
    title: 'Page numbers',
    body: [
      h('div', { class: 'row' }, h('label', { class: 'field' }, 'Position', pos), h('label', { class: 'field' }, 'Style', fmt)),
      h('div', { class: 'row' }, h('label', { class: 'field' }, 'Size (pt)', size), h('label', { class: 'field' }, 'Start at', start)),
      h('div', { class: 'field' }, 'Colour', colorPicker(cfg.color, (c) => (cfg.color = c))),
    ],
    buttons: [
      { label: 'Cancel', onClick: (c) => c() },
      S.settings.pageNumbers && { label: 'Remove', cls: 'danger', onClick: (c) => { c(); checkpoint(); S.settings.pageNumbers = null; refreshOverlays(); toast('Page numbers removed'); } },
      {
        label: 'Apply', cls: 'primary', onClick: (c) => {
          c(); checkpoint();
          S.settings.pageNumbers = { ...cfg, pos: pos.value, format: fmt.value, size: clamp(+size.value || 11, 6, 48), start: Math.max(0, Math.floor(+start.value || 0)) };
          refreshOverlays(); toast('Page numbers added');
          if (S.view !== 'edit') setView('edit');
        },
      },
    ].filter(Boolean),
  });
}

async function openForms() {
  const used = new Set(S.pages.map((p) => p.src));
  const srcs = S.sources.filter((s) => s.hasForm && used.has(s.id));
  if (!srcs.length) { toast('No fillable form fields found in this PDF'); return; }
  const L = window.PDFLib;
  const entries = [];
  const libs = await busy('Reading form…', () => Promise.all(srcs.map((s) => PDFDocument.load(s.bytes))));
  if (!libs) return;
  const body = [];
  srcs.forEach((s, si) => {
    const form = libs[si].getForm();
    if (srcs.length > 1) body.push(h('b', {}, s.name));
    const list = h('div', { class: 'form-fields' });
    for (const f of form.getFields()) {
      const name = f.getName();
      let input = null, get = null;
      if (f instanceof L.PDFTextField) {
        input = h('input', { type: 'text', value: f.getText() || '' });
        get = () => f.setText(input.value);
      } else if (f instanceof L.PDFCheckBox) {
        input = h('input', { type: 'checkbox', checked: f.isChecked() });
        get = () => (input.checked ? f.check() : f.uncheck());
        list.append(h('label', { class: 'check-row' }, input, name));
        entries.push(get);
        continue;
      } else if (f instanceof L.PDFDropdown || f instanceof L.PDFOptionList || f instanceof L.PDFRadioGroup) {
        const cur = f instanceof L.PDFRadioGroup ? f.getSelected() : (f.getSelected() || [])[0];
        input = h('select', {}, h('option', { value: '' }, '—'), f.getOptions().map((o) => h('option', { value: o, selected: o === cur }, o)));
        get = () => { if (input.value) f.select(input.value); else if (!(f instanceof L.PDFRadioGroup)) f.clear(); else f.clear(); };
      } else continue;
      list.append(h('label', { class: 'field' }, name, input));
      entries.push(get);
    }
    body.push(list);
  });
  if (!entries.length) { toast('This form has no fields that can be filled here'); return; }
  const flat = h('input', { type: 'checkbox' });
  body.push(h('label', { class: 'check-row' }, flat, 'Lock answers (flatten) so they can\'t be changed'));
  body.push(h('p', { class: 'note' }, 'Form changes are applied directly and can\'t be undone with the Undo button.'));
  openSheet({
    title: 'Fill form',
    body,
    buttons: [
      { label: 'Cancel', onClick: (c) => c() },
      {
        label: 'Apply', cls: 'primary', onClick: async (c) => {
          c();
          await busy('Filling form…', async () => {
            for (const get of entries) { try { get(); } catch (e) { console.warn(e); } }
            for (let si = 0; si < srcs.length; si++) {
              const lib = libs[si];
              try { if (flat.checked) lib.getForm().flatten(); }
              catch (e) { console.warn(e); }
              const bytes = await lib.save();
              const s = srcs[si];
              closePdfjs(s.doc);
              s.bytes = bytes; s.doc = await openPdfjs(bytes); s.version++;
              s.hasForm = !flat.checked;
            }
            S.dirty = true;
            structureChanged();
            toast('Form updated');
          });
        },
      },
    ],
  });
}

function openMeta() {
  const m = S.settings.meta || {};
  const f = {};
  const field = (k, label) => { f[k] = h('input', { type: 'text', value: m[k] || '' }); return h('label', { class: 'field' }, label, f[k]); };
  const fname = h('input', { type: 'text', value: S.fileName });
  openSheet({
    title: 'Document details',
    body: [h('label', { class: 'field' }, 'File name', fname), field('title', 'Title'), field('author', 'Author'), field('subject', 'Subject'), field('keywords', 'Keywords (comma separated)')],
    buttons: [
      { label: 'Cancel', onClick: (c) => c() },
      {
        label: 'Save details', cls: 'primary', onClick: (c) => {
          c(); checkpoint();
          S.settings.meta = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value.trim()]));
          const n = fname.value.trim();
          if (n) S.fileName = /\.pdf$/i.test(n) ? n : n + '.pdf';
          updateChrome(); toast('Details saved');
        },
      },
    ],
  });
}

async function extractText() {
  const text = await busy('Reading text…', async (set) => {
    const parts = [];
    for (let i = 0; i < S.pages.length; i++) {
      set(`Reading page ${i + 1} of ${S.pages.length}…`);
      const p = S.pages[i];
      let t = '';
      const src = srcById(p.src);
      if (src) {
        const pg = await src.doc.getPage(p.index + 1);
        const tc = await pg.getTextContent();
        t = tc.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+\n/g, '\n').trim();
      }
      const extra = p.annots.filter((a) => a.type === 'text').map((a) => a.text).join('\n');
      parts.push(`--- Page ${i + 1} ---\n${[t, extra].filter(Boolean).join('\n')}`);
    }
    return parts.join('\n\n');
  });
  if (text == null) return;
  const empty = !text.replace(/--- Page \d+ ---/g, '').trim();
  const ta = h('textarea', { readonly: true, style: 'min-height:260px;font-size:13px' });
  ta.value = text;
  openSheet({
    title: 'Extracted text',
    body: [empty ? h('p', { class: 'note warn' }, 'No text found. This PDF may be scanned images; text can only be read from PDFs that contain real text.') : null, h('label', { class: 'field' }, 'Text', ta)],
    buttons: [
      { label: 'Copy', onClick: async () => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { ta.select(); document.execCommand('copy'); toast('Copied'); } } },
      { label: 'Download .txt', cls: 'primary', onClick: (c) => { c(); download(new Blob([text], { type: 'text/plain' }), `${baseName()}.txt`); } },
    ],
  });
}

// ============================================================ save / menu
function openSave() {
  if (!needDoc()) return;
  const name = h('input', { type: 'text', value: `${baseName()}-edited` });
  const canShare = isNative || !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] }));
  const run = async (share) => {
    const fname = (name.value.trim() || baseName()).replace(/\.pdf$/i, '') + '.pdf';
    dismissSheet();
    const bytes = await busy('Saving PDF…', (set) => buildPdf(stateFor(), { onProgress: (i, n) => set(`Saving page ${Math.min(i + 1, n)} of ${n}…`) }));
    if (!bytes) return;
    await shareOrDownload(new Blob([bytes], { type: 'application/pdf' }), fname, share);
    S.dirty = false;
    toast(`Saved ${fname} (${fmtSize(bytes.length)})`);
  };
  const hasRedact = S.pages.some((p) => p.annots.some((a) => a.type === 'redact'));
  openSheet({
    title: 'Save PDF',
    body: [
      h('label', { class: 'field' }, 'File name', name),
      h('p', { class: 'note' }, 'All your edits are written into the PDF.'),
      hasRedact && h('p', { class: 'note warn' }, 'Pages with redactions are flattened into images so the hidden text is gone for good.'),
    ],
    buttons: [canShare && { label: 'Share…', onClick: () => run(true) }, { label: 'Download', cls: 'primary', onClick: () => run(false) }].filter(Boolean),
  });
}

let installPrompt = null;
function openMenu() {
  const item = (label, fn) => h('button', { onclick: () => { dismissSheet(); fn(); } }, label);
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  openSheet({
    title: 'Menu',
    body: [h('div', { class: 'menu-list' },
      item(S.open ? 'Open a different PDF…' : 'Open PDF…', async () => { if (S.open) { await closeDoc(); if (S.open) return; } pickPdf(0); }),
      S.open && item('Add PDF to this document…', () => pickPdf(S.pages.length)),
      S.open && item('Save / share…', openSave),
      S.open && item('Document details…', openMeta),
      S.open && item('Close document', closeDoc),
      installPrompt && item('Install app on this device', async () => { installPrompt.prompt(); installPrompt = null; }),
      !installPrompt && ios && item('Install on iPhone: tap Share → "Add to Home Screen"', () => {}),
      item('About', () => openSheet({
        title: 'About PDF Editor',
        body: [h('p', { class: 'note' }, `Version ${APP_VERSION}`),
          h('p', { class: 'note' }, 'Everything happens on your device: your PDFs are never uploaded. Works offline after the first visit.'),
          h('p', { class: 'note' }, 'Built with pdf.js (Mozilla) and pdf-lib.')],
        buttons: [{ label: 'Close', cls: 'primary', onClick: (c) => c() }],
      })),
    )],
  });
}

// ============================================================ wiring
function init() {
  $('#btnMenu').innerHTML = icon('menu');
  $('#btnUndo').innerHTML = icon('undo');
  $('#btnRedo').innerHTML = icon('redo');
  $('#sheetClose').innerHTML = icon('close');
  for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon);
  buildToolbar();

  $('#btnMenu').onclick = openMenu;
  $('#btnUndo').onclick = undo;
  $('#btnRedo').onclick = redo;
  $('#btnSave').onclick = openSave;
  $('#sheetClose').onclick = dismissSheet;
  $('#sheetBackdrop').addEventListener('click', (e) => { if (e.target.id === 'sheetBackdrop') dismissSheet(); });
  for (const t of document.querySelectorAll('.tab')) t.onclick = () => setView(t.dataset.view);
  $('#homeOpen').onclick = () => pickPdf(0);
  $('#homeImages').onclick = () => pickImages(0);
  $('#homeBlank').onclick = newBlankDoc;

  const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
  const zoomBy = (d) => {
    const i = ZOOMS.findIndex((z) => z >= S.zoom - 0.001);
    S.zoom = ZOOMS[clamp(i + d, 0, ZOOMS.length - 1)];
    buildViewer();
  };
  $('#zoomIn').onclick = () => zoomBy(1);
  $('#zoomOut').onclick = () => zoomBy(-1);

  $('#filePdf').addEventListener('change', async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    if (files.length) await handleFiles(files, pdfPickAt);
  });
  $('#fileImg').addEventListener('change', async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    if (!files.length) return;
    if (imgPickMode === 'place' && pendingPlace) {
      const place = pendingPlace; pendingPlace = null;
      const im = await busy('Loading image…', () => readImageFile(files[0], 2000));
      if (im) addImageAnnot(place, im, 220);
    } else {
      const wasOpen = S.open;
      await imagesFlow(files, imgPickAt);
      if (!wasOpen && S.open) setView('edit');
    }
  });

  // drag & drop (desktop)
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('#dropZone').classList.remove('hidden'); } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropZone').classList.add('hidden'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; $('#dropZone').classList.add('hidden');
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files, S.pages.length);
  });

  // keyboard shortcuts (desktop)
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select')) return;
    // While a sheet is open, only Escape is handled; other shortcuts would act on the page behind it.
    if (sheetDismiss) { if (e.key === 'Escape') dismissSheet(); return; }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); openSave(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && S.selected) { e.preventDefault(); deleteSelected(); }
    else if (e.key === 'Escape') { if (sheetDismiss) dismissSheet(); else if (S.selected) select(null); }
  });

  let lastW = window.innerWidth, rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (Math.abs(window.innerWidth - lastW) < 20) return;
      lastW = window.innerWidth; S.viewerStale = true;
      if (S.view === 'edit') buildViewer();
    }, 250);
  });

  window.addEventListener('beforeunload', (e) => { if (S.dirty && S.open) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });

  // Android hardware back button: close a sheet, then clear selection, then go back to the editor, then exit.
  if (isNative && plugin('App')) {
    plugin('App').addListener('backButton', () => {
      if (sheetDismiss) dismissSheet();
      else if (S.selected) select(null);
      else if (S.view !== 'edit' && S.view !== 'home') setView(S.open ? 'edit' : 'home');
      else plugin('App').exitApp();
    });
  }

  // The APK already ships every file, so it needs no offline cache.
  if (!isNative && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // Open files passed by the OS to the installed app (desktop PWA)
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files?.length) return;
      const files = await Promise.all(params.files.map((fh) => fh.getFile()));
      handleFiles(files, S.pages.length);
    });
  }

  updateChrome();
  setView('home');
}

init();

// expose for debugging / automated tests
window.__pdfEditor = { S, buildPdf: () => buildPdf(stateFor()), setTool, setView, undo, redo };
