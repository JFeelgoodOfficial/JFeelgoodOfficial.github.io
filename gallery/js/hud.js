// DOM HUD: the E-prompt, the shared info card, the full-resolution archive
// viewer, and the compass strip. Opening any overlay releases the pointer lock
// (so the cursor can click links/close); closing it re-locks and resumes the
// walk. All styling lives in gallery/css/gallery.css.

import { resetTouch, touchActive } from './touch.js';

const $ = (id) => document.getElementById(id);

let relock = () => {};
let onClose = () => {};
let overlayOpen = false;

// Every prompt goes through showPrompt() and every control legend through
// showHint(), so this is the one place that has to know that the keyboard
// glyphs baked into world.js / art.js aren't what a phone shows.
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
    if (!overlayOpen) return;
    if (e.code === 'Escape') { closeOverlays(); e.stopPropagation(); }
    else if (e.code === 'Tab') trapTab(e);
  });
  for (const id of ['card', 'viewer']) {
    const el = $(id);
    if (el) el.addEventListener('click', (e) => { if (e.target === el) closeOverlays(); });
  }
}

// --- prompt ---
// world.js calls one of these every frame. The DOM is only touched when the
// answer changes, which is also what lets #prompt be a live region: a screen
// reader hears "E — Veritas" once, on arrival, not sixty times a second.
let promptHtml = null;
export function showPrompt(html) {
  if (html === promptHtml) return;
  const el = $('prompt');
  if (!el) return;
  promptHtml = html;
  el.innerHTML = touchify(html);
  el.hidden = false;
  // lights up the ACT button — on touch there's no key to try speculatively
  document.body.classList.add('has-prompt');
}
export function hidePrompt() {
  if (promptHtml === null) return;
  promptHtml = null;
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
  clearTimeout(el._t); clearTimeout(el._t2);
  el._t = setTimeout(() => { el.style.opacity = '0'; el._t2 = setTimeout(() => (el.hidden = true), 1000); }, 6000);
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
      ${data.img ? `<img src="${data.img}" alt="${escapeHtml(data.alt || data.title || '')}"${data.w && data.h ? ` width="${data.w}" height="${data.h}"` : ''} decoding="async">` : ''}
      <div class="card-text">
        ${data.kicker ? `<div class="card-kicker">${escapeHtml(data.kicker)}</div>` : ''}
        <h2 class="card-title" id="card-title">${escapeHtml(data.title || '')}</h2>
        ${data.meta ? `<div class="card-meta">${escapeHtml(data.meta)}</div>` : ''}
        <div class="card-body">${body}</div>
        ${stock}
        ${acts ? `<div class="card-actions">${acts}</div>` : ''}
      </div>
    </div>`;
  el.querySelector('.card-close').addEventListener('click', closeOverlays);
  el.setAttribute('aria-labelledby', 'card-title');
  openOverlay(el);
  return el;
}

// --- archive viewer (the work, full frame) ---
// data.w/h are the work's pixel proportions, not the size of the file being
// shown: they are here so the overlay reserves the right shape and the image
// does not shove the caption around when it lands.
export function showViewer(data) {
  const el = $('viewer');
  if (!el) return;
  const size = data.w && data.h ? ` width="${data.w}" height="${data.h}"` : '';
  const alt = escapeHtml(data.alt || `${data.title || 'Untitled'}, a painting by JFeelgood`);
  el.innerHTML = `
    <div class="viewer-box">
      <button class="card-close" aria-label="Close">×</button>
      <img src="${data.full}" alt="${alt}"${size} decoding="async">
      <div class="viewer-caption">${escapeHtml(data.title || '')}</div>
      <div class="viewer-sub">${data.href ? `<a href="${data.href}" target="_blank" rel="noopener">open this work full frame ↗</a>` : ''}</div>
    </div>`;
  el.querySelector('.card-close').addEventListener('click', closeOverlays);
  el.setAttribute('aria-label', data.title || 'Untitled work');
  openOverlay(el);
  return el;
}

// Both overlays are modal dialogs (role and aria-modal are in index.html):
// focus goes to the close button on the way in, Tab stays inside, and whatever
// had focus before gets it back on the way out.
let returnFocus = null;
function openOverlay(el) {
  el.hidden = false;
  overlayOpen = true;
  if (document.pointerLockElement) document.exitPointerLock();
  // touch has no lock to drop — instead let go of the stick/buttons and get the
  // controls out from in front of the card
  document.documentElement.classList.add('overlay-open');
  resetTouch();
  const a = document.activeElement;
  returnFocus = a && a !== document.body && !el.contains(a) ? a : null;
  const close = el.querySelector('.card-close');
  if (close) close.focus({ preventScroll: true });
}

const FOCUSABLE = 'a[href], button:not([disabled])';
function trapTab(e) {
  const el = ['card', 'viewer'].map($).find((o) => o && !o.hidden);
  if (!el) return;
  const items = [...el.querySelectorAll(FOCUSABLE)];
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  const at = document.activeElement;
  if (!el.contains(at)) { first.focus(); e.preventDefault(); }
  else if (e.shiftKey && at === first) { last.focus(); e.preventDefault(); }
  else if (!e.shiftKey && at === last) { first.focus(); e.preventDefault(); }
}

export function isOverlayOpen() { return overlayOpen; }

export function closeOverlays() {
  let closed = false;
  for (const id of ['card', 'viewer']) {
    const e = $(id);
    if (e && !e.hidden) { e.hidden = true; e.innerHTML = ''; closed = true; }
  }
  overlayOpen = false;
  document.documentElement.classList.remove('overlay-open');
  if (closed) {
    if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
    onClose(); relock();
  }
}

// --- compass strip ---
// entries: [{ name, pos:Vector3 }]. Places ticks by horizontal bearing
// relative to the camera forward, within ±HALF degrees.
const HALF = 75;
const _marks = [];
let _compassEl = null;
export function updateCompass(entries, camPos, fwd, up, THREE) {
  const el = _compassEl || (_compassEl = $('compass'));
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
  _placed.length = 0;
  for (const m of _marks) {
    let clash = false;
    for (let i = 0; i < _placed.length; i++) if (Math.abs(_placed[i] - m.x) < minGap) { clash = true; break; }
    if (clash) continue;
    _placed.push(m.x);
    const dim = Math.abs(m.ang) > half * 0.6 ? ' dim' : '';
    html += `<span class="tick${dim}" style="left:${m.x.toFixed(1)}%">${m.name}</span>`;
  }
  // a visitor standing still, or looking at a card, produces the same strip
  // every frame; only write it when a tick has actually moved
  if (html !== _compassHtml) { _compassHtml = html; el.innerHTML = html; }
}
const _placed = [];
let _compassHtml = '';

// scratch (module-level; set lazily to avoid importing THREE just for types)
let _v1, _v2;
export function initCompassScratch(THREE) { _v1 = new THREE.Vector3(); _v2 = new THREE.Vector3(); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
