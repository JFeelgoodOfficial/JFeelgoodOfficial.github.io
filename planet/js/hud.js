// DOM HUD: the E-prompt, the shared info card, the full-resolution archive
// viewer, and the compass strip. Opening any overlay releases the pointer lock
// (so the cursor can click links/close); closing it re-locks and resumes the
// walk. All styling lives in planet/css/planet.css.

import { resetTouch, touchActive } from './touch.js';

const $ = (id) => document.getElementById(id);

let relock = () => {};
let onClose = () => {};

// Every prompt goes through showPrompt() and every control legend through
// showHint(), so this is the one place that has to know the keyboard glyphs
// baked into zones.js / vehicles.js / world.js aren't what a phone shows.
// Longest phrases first — "Shift run" has to be caught before a bare "SHIFT".
const GLYPHS = [
  [/W A S D to walk/g, 'STICK to walk'],
  [/Shift run/g, 'RUN to sprint'],
  [/Space jump/g, '▲ to jump'],
  [/E interact/g, 'ACT to interact'],
  [/MOUSE \/ SPACE·SHIFT/g, 'DRAG / ▲ RUN'],
  [/<b>E<\/b>/g, '<b>ACT</b>'],
  [/W\/S/g, 'STICK ↑↓'],
  [/A\/D/g, 'STICK ←→'],
  [/SPACE/g, '▲'],
  [/SHIFT/g, 'RUN'],
  [/MOUSE/g, 'DRAG'],
  // prose in card bodies ("Walk with W A S D, run with Shift…")
  [/W A S D/g, 'the stick'],
  [/\bShift\b/g, 'a full push of the stick'],
  [/\bSpace\b/g, 'the ▲ button'],
  [/\bE\b/g, 'ACT'],
];
function touchify(s) {
  if (!touchActive()) return s;
  return GLYPHS.reduce((acc, [re, to]) => acc.replace(re, to), String(s));
}

export function initHud(opts = {}) {
  relock = opts.relock || (() => {});
  onClose = opts.onClose || (() => {});
  // close on Esc / backdrop click
  addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && isOverlayOpen()) { closeOverlays(); e.stopPropagation(); }
  });
  for (const id of ['card', 'viewer']) {
    const el = $(id);
    if (el) el.addEventListener('click', (e) => { if (e.target === el) closeOverlays(); });
  }
}

// --- prompt ---
export function showPrompt(html) {
  const el = $('prompt');
  if (!el) return;
  el.innerHTML = touchify(html);
  el.hidden = false;
  // lights up the ACT button — on touch there's no key to try speculatively
  document.body.classList.add('has-prompt');
}
export function hidePrompt() {
  const el = $('prompt');
  if (el) el.hidden = true;
  document.body.classList.remove('has-prompt');
}

export function showHint(text) {
  const el = $('hint');
  if (!el) return;
  el.textContent = touchify(text);
  el.hidden = false;
  el.style.opacity = '1'; // the previous hint's fade-out leaves this at 0
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; setTimeout(() => (el.hidden = true), 1000); }, 6000);
}

// --- info card ---
// data: { kicker, title, meta, body:[..], img, alt, actions:[{label,href,ghost}], stock }
export function showCard(data) {
  const el = $('card');
  if (!el) return;
  const acts = (data.actions || []).map((a) =>
    `<a class="card-btn${a.ghost ? ' ghost' : ''}" href="${a.href}" target="_blank" rel="noopener">${a.label}</a>`
  ).join('');
  // card prose names keys too ("run with Shift") — swap those on touch as well
  const body = (data.body || []).map((p) => `<p>${touchify(escapeHtml(p))}</p>`).join('');
  const stock = data.stock ? `<div class="card-stock" data-stock>${escapeHtml(data.stock)}</div>` : '';
  el.innerHTML = `
    <div class="card-box">
      <button class="card-close" aria-label="Close">×</button>
      ${data.img ? `<img src="${data.img}" alt="${escapeHtml(data.alt || data.title || '')}">` : ''}
      <div class="card-text">
        ${data.kicker ? `<div class="card-kicker">${escapeHtml(data.kicker)}</div>` : ''}
        <h2 class="card-title">${escapeHtml(data.title || '')}</h2>
        ${data.meta ? `<div class="card-meta">${escapeHtml(data.meta)}</div>` : ''}
        <div class="card-body">${body}</div>
        ${stock}
        ${acts ? `<div class="card-actions">${acts}</div>` : ''}
      </div>
    </div>`;
  el.querySelector('.card-close').addEventListener('click', closeOverlays);
  openOverlay(el);
  return el;
}

// --- interactive citizen dialogue tree ---
// data: { kicker, title, greeting, choices:[{ label, say, end, then:[{label,say}] }] }
// Renders the greeting + choice buttons; a choice shows its response and any
// follow-up choices, with a "Back" to the greeting. "Say goodbye" (end) closes.
export function showDialogue(data) {
  const el = $('card');
  if (!el) return;
  const head = `
    <button class="card-close" aria-label="Close">×</button>
    <div class="card-text">
      ${data.kicker ? `<div class="card-kicker">${escapeHtml(data.kicker)}</div>` : ''}
      <h2 class="card-title">${escapeHtml(data.title || '')}</h2>`;

  function render(text, options, showBack) {
    const btns = options.map((o, i) =>
      `<button class="dlg-choice" data-i="${i}">${escapeHtml(o.label)}</button>`
    ).join('');
    const back = showBack ? `<button class="dlg-choice ghost" data-back="1">← Back</button>` : '';
    el.innerHTML = `
      <div class="card-box dialogue">
        ${head}
        <div class="card-body dlg-say"><p>${escapeHtml(text)}</p></div>
        <div class="dlg-choices">${btns}${back}</div>
      </div></div>`;
    el.querySelector('.card-close').addEventListener('click', closeOverlays);
    el.querySelectorAll('.dlg-choice').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.dataset.back) { greeting(); return; }
        const o = options[+b.dataset.i];
        if (!o) return;
        if (o.end) { closeOverlays(); return; }
        render(o.say || '', o.then || [], true);
      });
    });
  }
  function greeting() { render(data.greeting || '', data.choices || [], false); }

  greeting();
  openOverlay(el);
  return el;
}

// --- archive viewer (full-res image) ---
export function showViewer(data) {
  const el = $('viewer');
  if (!el) return;
  el.innerHTML = `
    <div class="viewer-box">
      <button class="card-close" aria-label="Close">×</button>
      <img src="${data.full}" alt="${escapeHtml(data.title || '')}">
      <div class="viewer-caption">${escapeHtml(data.title || '')}</div>
      <div class="viewer-sub">${data.href ? `<a href="${data.href}" target="_blank" rel="noopener">open full resolution ↗</a>` : ''}</div>
    </div>`;
  el.querySelector('.card-close').addEventListener('click', closeOverlays);
  openOverlay(el);
  return el;
}

function openOverlay(el) {
  el.hidden = false;
  if (document.pointerLockElement) document.exitPointerLock();
  // touch has no lock to drop — instead let go of the stick/buttons and get the
  // controls out from in front of the card
  document.documentElement.classList.add('overlay-open');
  resetTouch();
}

export function isOverlayOpen() {
  return ['card', 'viewer'].some((id) => { const e = $(id); return e && !e.hidden; });
}

export function closeOverlays() {
  let closed = false;
  for (const id of ['card', 'viewer']) {
    const e = $(id);
    if (e && !e.hidden) { e.hidden = true; e.innerHTML = ''; closed = true; }
  }
  document.documentElement.classList.remove('overlay-open');
  if (closed) { onClose(); relock(); }
}

// --- compass strip ---
// entries: [{ name, pos:Vector3 }]. Places ticks by horizontal bearing
// relative to the camera forward, within ±HALF degrees.
const HALF = 75;
const _marks = [];
export function updateCompass(entries, camPos, fwd, up, THREE) {
  const el = $('compass');
  if (!el || !_v1 || !_v2) return;
  // A phone strip is ~390px wide, so the desktop ±75° fan crams a dozen labels
  // into unreadable mush. Narrow the fan and enforce a minimum gap.
  const touch = touchActive();
  const half = touch ? 45 : HALF;
  const minGap = touch ? 26 : 13; // percent of the strip
  const right = _v1.crossVectors(fwd, up).normalize();
  _marks.length = 0;
  for (const e of entries) {
    _v2.subVectors(e.pos, camPos);
    // project onto the horizontal (tangent) plane
    _v2.addScaledVector(up, -_v2.dot(up));
    if (_v2.lengthSq() < 1e-4) continue;
    _v2.normalize();
    const f = _v2.dot(fwd);
    const r = _v2.dot(right);
    const ang = Math.atan2(r, f) * 180 / Math.PI; // -180..180, 0 = ahead
    if (Math.abs(ang) > half) continue;
    _marks.push({ x: 50 + (ang / half) * 50, ang, name: e.name });
  }
  // what's straight ahead matters most, so it wins any collision
  _marks.sort((a, b) => Math.abs(a.ang) - Math.abs(b.ang));
  let html = '';
  const placed = [];
  for (const m of _marks) {
    if (placed.some((p) => Math.abs(p - m.x) < minGap)) continue;
    placed.push(m.x);
    const dim = Math.abs(m.ang) > half * 0.6 ? ' dim' : '';
    html += `<span class="tick${dim}" style="left:${m.x.toFixed(1)}%">${m.name}</span>`;
  }
  el.innerHTML = html;
}

// scratch (module-level; set lazily to avoid importing THREE just for types)
let _v1, _v2;
export function initCompassScratch(THREE) { _v1 = new THREE.Vector3(); _v2 = new THREE.Vector3(); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
