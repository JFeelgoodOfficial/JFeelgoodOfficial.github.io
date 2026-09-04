// On-screen controls for phones and tablets. Everything here writes into the
// same `input` singleton the keyboard fills, so walk.js, gallery.js and
// vehicles.js need no idea touch exists:
//
//   left thumbstick  -> input.forward / reverse / left / right (+ boost when shoved)
//   drag the canvas  -> input.mouseX / mouseY (same units the mouse accumulates)
//   ▲ button (hold)  -> input.jump   (SPACE: jump, or climb/pitch in a vehicle)
//   RUN button       -> input.boost  (SHIFT: sprint, or descend/boost in a vehicle)
//   ACT button       -> the E handler (world.handleInteract)
//
// iOS has no Pointer Lock API, so nothing here depends on it — main.js gates
// stepping on isActive() rather than input.locked.

import { input } from './input.js';

const DEAD = 0.28;    // fraction of the stick radius that still reads as centred
const DIAG = 0.38;    // axis threshold — anything above it on both axes is a diagonal
const RUN_AT = 0.86;  // shove the stick past this and you sprint without the button
const LOOK_MUL = 2.2; // a thumb drags fewer pixels than a mouse does; scale to match

let root = null;
let stickEl = null;
let knobEl = null;

let stickId = null, lookId = null;
let stickCx = 0, stickCy = 0, stickR = 56;
let lookX = 0, lookY = 0;
let runOn = false, stickRun = false;
let mode = 'walk';

function applyBoost() { input.boost = runOn || (mode === 'walk' && stickRun); }

// main.js flips this when a vehicle is boarded. On foot, shoving the stick to
// the rim sprints; in a vehicle input.boost means *descend* (drone) or boost
// (ground), so full throttle must not trigger it — the RUN button owns it there.
export function setTouchMode(m) {
  if (m === mode) return;
  mode = m;
  applyBoost();
}

// Safari throws here if the pointer has already been released, and capture is
// only an ergonomic nicety — a thumb that slides off the stick keeps steering.
// Never let it take the handler down with it.
function capture(el, id) {
  try { el.setPointerCapture(id); } catch (e) { /* pointer already gone */ }
}

function clearMove() {
  input.forward = input.reverse = input.left = input.right = false;
  input.analog = false;
  input.moveX = input.moveY = 0;
  stickRun = false;
  applyBoost();
}

// Drop every held control. Called when an overlay opens (hud.js) so a card
// can't be read while the walker keeps sprinting into a wall.
export function resetTouch() {
  stickId = null;
  lookId = null;
  runOn = false;
  clearMove();
  input.jump = false;
  if (knobEl) knobEl.style.transform = '';
  if (root) root.querySelectorAll('.touch-btn.on').forEach((b) => b.classList.remove('on'));
}

export function touchActive() { return !!root; }

function stickTo(x, y) {
  let dx = x - stickCx;
  let dy = y - stickCy;
  const d = Math.hypot(dx, dy) || 1;
  const mag = Math.min(d / stickR, 1);
  if (d > stickR) { dx *= stickR / d; dy *= stickR / d; }
  knobEl.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;

  if (mag < DEAD) { clearMove(); return; }
  const len = Math.hypot(dx, dy) || 1;
  const nx = (dx / len) * mag;
  const ny = (dy / len) * mag;
  // analog for the outdoor walker...
  input.analog = true;
  input.moveX = nx;
  input.moveY = -ny; // screen +y is toward the player, i.e. backwards
  // ...and mirrored into the booleans so the gallery walker and every vehicle
  // read the stick without knowing it exists.
  input.forward = input.moveY > DIAG;
  input.reverse = input.moveY < -DIAG;
  input.left = input.moveX < -DIAG;
  input.right = input.moveX > DIAG;
  stickRun = mag > RUN_AT;
  applyBoost();
}

function buildDom() {
  root = document.createElement('div');
  root.id = 'touch';
  root.innerHTML = `
    <div class="touch-stick" id="touch-stick"><div class="touch-knob" id="touch-knob"></div></div>
    <div class="touch-buttons">
      <button class="touch-btn touch-act" data-act="interact" type="button">ACT</button>
      <div class="touch-row">
        <button class="touch-btn" data-act="run" type="button">RUN</button>
        <button class="touch-btn" data-act="jump" type="button">▲</button>
      </div>
    </div>`;
  // inside #hud so it appears with the HUD and hides with it before ENTER
  (document.getElementById('hud') || document.body).appendChild(root);
  stickEl = root.querySelector('#touch-stick');
  knobEl = root.querySelector('#touch-knob');
}

export function initTouch(canvas, opts = {}) {
  if (root) return;
  const onInteract = opts.onInteract || (() => {});
  input.touch = true;
  buildDom();

  // --- thumbstick ---
  stickEl.addEventListener('pointerdown', (e) => {
    if (stickId !== null) return;
    const r = stickEl.getBoundingClientRect();
    stickCx = r.left + r.width / 2;
    stickCy = r.top + r.height / 2;
    stickR = r.width / 2;
    stickId = e.pointerId;
    capture(stickEl, e.pointerId);
    stickTo(e.clientX, e.clientY);
    e.preventDefault();
  });
  stickEl.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickId) return;
    stickTo(e.clientX, e.clientY);
    e.preventDefault();
  });
  const stickUp = (e) => {
    if (e.pointerId !== stickId) return;
    stickId = null;
    clearMove();
    knobEl.style.transform = '';
  };
  stickEl.addEventListener('pointerup', stickUp);
  stickEl.addEventListener('pointercancel', stickUp);

  // --- buttons ---
  for (const btn of root.querySelectorAll('.touch-btn')) {
    const act = btn.dataset.act;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      capture(btn, e.pointerId);
      if (act === 'jump') { input.jump = true; btn.classList.add('on'); }
      else if (act === 'run') { runOn = !runOn; applyBoost(); btn.classList.toggle('on', runOn); }
      else onInteract();
    });
    const up = (e) => {
      if (btn.hasPointerCapture && btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId);
      if (act === 'jump') { input.jump = false; btn.classList.remove('on'); }
    };
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // --- drag anywhere else to look ---
  // The canvas sits under every control, so a drag that starts on the stick or
  // a button never reaches here; anything else does.
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || lookId !== null) return;
    lookId = e.pointerId;
    lookX = e.clientX;
    lookY = e.clientY;
    capture(canvas, e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lookId) return;
    input.mouseX += (e.clientX - lookX) * LOOK_MUL;
    input.mouseY += (e.clientY - lookY) * LOOK_MUL;
    lookX = e.clientX;
    lookY = e.clientY;
    e.preventDefault();
  });
  const lookUp = (e) => { if (e.pointerId === lookId) lookId = null; };
  canvas.addEventListener('pointerup', lookUp);
  canvas.addEventListener('pointercancel', lookUp);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // A backgrounded tab keeps whatever was held; drop it.
  document.addEventListener('visibilitychange', () => { if (document.hidden) resetTouch(); });
}
