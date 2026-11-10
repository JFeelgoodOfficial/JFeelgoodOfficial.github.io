// The gallery itself: renderer, loading sequence, pointer lock, quality tiers
// and the per-frame order (walk → camera → world update → floor reflection
// pass → scene render through the HDR bloom pipeline).
//
// boot.js owns the title screen and imports this module only once the visitor
// asks for the gallery, so everything below — three.js included — is off the
// critical path of the front page. startLoad() is exported for it to call.

import * as THREE from 'three';
import { C } from './config.js';
import { createPost } from './post.js';
import { input, initInput, lockPointer, isActive } from './input.js';
import { initTouch } from './touch.js';
import { walker, stepWalker, updateCamera, spawn } from './walker.js';
import { buildWorld, updateWorld, renderReflection, setReflectionEnabled, resizeReflection, handleInteract, resolvePlace, shadowsDirty, degradeLighting, lightingReport, probeLighting, startWelcome, setProbeFail } from './world.js';
import { showHint, isOverlayOpen } from './hud.js';

if (document.documentElement.classList.contains('no-webgl')) {
  const el = document.getElementById('nogl');
  if (el) el.hidden = false;
  const ld = document.getElementById('loader');
  if (ld) ld.style.display = 'none';
  throw new Error('WebGL2 unavailable');
}

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug') ? (params.get('debug') || '1') : null;
const TOUCH = params.has('touch') || (document.documentElement.classList.contains('touch') && !params.has('notouch'));
const FORCE_Q = params.get('q'); // ?q=low|medium|high for testing
const DIAG = params.has('diag'); // ?diag — on-screen GPU/shader report (no devtools on a phone)
// ?lit=noenv|nopoint|lambert|basic forces a rung of the lighting fallback
// ladder (world.js) on any device, which is how you find out from a phone
// which rung it needs without waiting for the self-test to decide.
const FORCE_LIT = params.get('lit');
// ?probefail — pretend every lighting self-test reading came back black, to
// exercise the whole fallback ladder on a device that does not need it
const PROBE_FAIL = params.has('probefail');

const canvas = document.createElement('canvas');
canvas.className = 'gallery-canvas';
document.body.appendChild(canvas);

let quality = FORCE_Q || (TOUCH ? 'low' : 'high');

// Only the low tier draws the scene straight to the canvas. The other two draw
// it into post.js's own multisampled target and hand the canvas one full-screen
// quad, so antialiasing the canvas as well would be a second set of samples
// that nothing ever uses. (A visitor demoted to low mid-visit loses edge
// smoothing; they were demoted because the frame rate needed it more.)
const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === 'low', powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, C.MAX_PIXEL_RATIO));
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Khronos neutral: colour-accurate below 0.76, soft roll-off above. The
// paintings undo it exactly in their own shader (art.js), so they show true.
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = C.EXPOSURE;
renderer.setClearColor(0x000000, 1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false; // redrawn only when world.js says the light or the visitor moved (shadowsDirty)
renderer.info.autoReset = false; // reset once per frame in step(), so the counters cover every pass

// A lit program that fails to link takes every MeshStandardMaterial with it:
// the building draws nothing and the gallery goes black around the paintings,
// which are unlit and keep showing. Drivers differ in what they will accept, so
// rather than trusting that the shader is small enough, catch the failure and
// take lights out until it compiles.
const shaderErrors = [];
renderer.debug.onShaderError = (gl, program, vs, fs) => {
  const log = (gl.getProgramInfoLog(program) || '').trim()
    || (gl.getShaderInfoLog(fs) || '').trim()
    || (gl.getShaderInfoLog(vs) || '').trim()
    || 'no driver log';
  shaderErrors.push(log);
  console.error('gallery: shader error —', log);
  if (shaderErrors.length <= 8) degradeLighting(); // enough calls to walk the whole ladder
  if (DIAG) updateDiag();
};

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(C.FOV, innerWidth / innerHeight, TOUCH ? 0.2 : 0.08, 6000);

const post = createPost(renderer, { strength: 0.55, threshold: 1.0, knee: 0.5, quality });
let running = false;
const clock = new THREE.Clock();

// The one place the quality tiers map to a device pixel ratio cap — applyQuality()
// and onResize() both need this, and they used to compute it separately.
function pixelRatioForTier(q) {
  if (q === 'low') return 1;
  return Math.min(devicePixelRatio, q === 'medium' ? 1.25 : C.MAX_PIXEL_RATIO);
}

function applyQuality(q) {
  quality = q;
  renderer.setPixelRatio(pixelRatioForTier(q));
  if (q === 'high') {
    renderer.shadowMap.enabled = true;
    post.setEnabled(true); post.setQuality('high');
    setReflectionEnabled(true);
  } else if (q === 'medium') {
    renderer.shadowMap.enabled = true;
    post.setEnabled(true); post.setQuality('medium');
    setReflectionEnabled(true);
  } else {
    renderer.shadowMap.enabled = false;
    post.setEnabled(false);
    setReflectionEnabled(false);
  }
  post.setSize();
  resizeReflection();
  shadowsDirty();
}

// --- load sequence -----------------------------------------------------------
const loaderEl = document.getElementById('loader');
const fillEl = document.getElementById('loader-fill');
const statusEl = document.getElementById('loader-status');
const enterBtn = document.getElementById('enter-btn');
const hudEl = document.getElementById('hud');

function setProgress(f, label) {
  if (fillEl) fillEl.style.width = Math.round(f * 100) + '%';
  if (label && statusEl) statusEl.textContent = label;
}

// Resolves once the world is ready to be entered and rejects if it could not be
// built; boot.js owns the failure screen, so nothing is caught here.
let loadPromise = null;
export function startLoad() {
  if (loadPromise) return loadPromise;
  if (loaderEl) { loaderEl.classList.remove('stage-choice'); loaderEl.classList.add('stage-loading'); }
  if (PROBE_FAIL) setProbeFail(true);
  loadPromise = buildWorld({ scene, renderer, camera, quality, progress: setProgress, forceRung: FORCE_LIT, relock: () => lockPointer(canvas) })
    .then(async () => {
      // the world is built; now switch the renderer itself to the tier
      // (?q=low has to actually turn the reflection, bloom and shadows off)
      applyQuality(quality);
      await warmShaders();
      if (statusEl) statusEl.textContent = '';
      startRenderLoop();
      if (DEBUG) { enterWorld(); return; }
      if (TOUCH) enterWorld();
      else if (enterBtn) {
        enterBtn.hidden = false;
        // the button that had focus was hidden when loading began; without
        // this a keyboard visitor has to hunt for the way in
        if (!document.activeElement || document.activeElement === document.body) enterBtn.focus({ preventScroll: true });
      }
    });
  if (DEBUG) loadPromise.catch((e) => console.error('gallery build failed', e));
  return loadPromise;
}

// The lighting self-test renders the west wing with shadows off, and three.js
// does not look at a material's program again just because shadowMap.enabled
// changed afterwards. So everything that test drew kept its shadowless program
// for the rest of the visit: the west wing took no shadow from its own walls
// and roof, and the low sun lit the inside of a windowless room. Compiling
// here, with the tier applied and the real render target bound, gives every
// material the program its first visible frame needs — off the main thread
// where the driver allows it — and one whole frame behind the loader then
// warms the reflection and bloom passes too.
async function warmShaders() {
  try {
    updateCamera(camera);
    renderer.setRenderTarget(post.sceneTarget);
    await renderer.compileAsync(scene, camera);
  } catch (e) { console.warn('gallery: shader warm-up skipped', e); }
  renderer.setRenderTarget(null);
  frame(true);
}

let entered = false;
function enterWorld() {
  if (entered) return;
  entered = true;
  input.enabled = true;
  if (DEBUG && DEBUG.startsWith('at:')) jumpTo(DEBUG.slice(3));
  // the fading button would otherwise keep the keyboard for its last second
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  if (loaderEl) { loaderEl.classList.add('fading'); setTimeout(() => { if (!failed) loaderEl.style.display = 'none'; }, 900); }
  if (hudEl) hudEl.hidden = false;
  // the floating WELCOME is placed from where the visitor actually stands, so
  // it can only be built once the jump above has happened
  startWelcome();
  if (!DEBUG) lockPointer(canvas);
}

function jumpTo(name) {
  const p = resolvePlace(name);
  if (p) spawn(p.x, p.z, p.heading, 0);
}

if (enterBtn) enterBtn.addEventListener('click', enterWorld);
canvas.addEventListener('click', () => {
  if (running && entered && !input.locked && !isOverlayOpen()) lockPointer(canvas);
});

const RESUME = 'Click to look around with the mouse · arrow keys turn';
initInput(canvas,
  () => { try { handleInteract(); } catch (e) { console.error(e); } },
  // the pointer is free again (Esc, or a card opened): say how to pick it back up
  () => { if (entered && !isOverlayOpen()) showHint(RESUME); },
  () => { if (entered && !isOverlayOpen()) showHint(RESUME); }
);
if (TOUCH) initTouch(canvas, { onInteract: () => { try { handleInteract(); } catch (e) { console.error(e); } } });
// ?debug and the headless checks import this module directly and expect the
// world without a click; boot.js calls startLoad() for everyone else.
if (DEBUG) startLoad();

// --- render loop -------------------------------------------------------------
function startRenderLoop() {
  if (running) return;
  running = true;
  clock.start();
  renderer.setAnimationLoop(frame);
}

// A frame nobody can see is not drawn. Behind the opaque loader the world
// still updates, so paintings stream in while the visitor reads the controls,
// but nothing is rendered; under an open card, or with the pointer released,
// the picture is still and a few frames a second keep it honest.
const IDLE_INTERVAL = 0.25;
let idleT = 0, hudLocked = false, failed = false;

function frame(force) {
  try { step(force === true); }
  catch (e) {
    // setAnimationLoop only asks for the next frame after this one returns, so
    // an exception here would otherwise leave a frozen picture and no message
    console.error('gallery: frame failed', e);
    stop('The gallery ran into a problem and had to stop.<br>Reload to try again — everything here also lives on the classic site.');
  }
}

function step(force) {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  const active = isActive();

  if (active || DEBUG) stepWalker(dt);
  updateCamera(camera);
  if (active !== hudLocked && hudEl) { hudLocked = active; hudEl.classList.toggle('locked', active); }
  try { updateWorld(dt, t, camera); } catch (e) { console.error(e); }

  if (!force && !DEBUG) {
    if (!entered) return;
    if (!active || isOverlayOpen()) {
      idleT += dt;
      if (idleT < IDLE_INTERVAL) return;
    }
  }
  // time since the last frame that was actually drawn
  const drawn = Math.max(dt, idleT);
  idleT = 0;

  if (drawn > 0) fps = fps * 0.9 + (1 / drawn) * 0.1;
  if (!DEBUG && !FORCE_Q && active && !force) monitorFps(dt);
  if (DIAG && t - diagT > 0.5) { diagT = t; updateDiag(); }

  // the draw counters would otherwise only ever describe the last pass (the
  // bloom composite: one quad), which is what ?diag used to report
  renderer.info.reset();
  try { renderReflection(camera); } catch (e) { console.error(e); }
  post.render(scene, camera);
}

// Take the gallery down and say why, on the card the no-WebGL path already has.
function stop(html) {
  failed = true;
  renderer.setAnimationLoop(null);
  running = false;
  input.enabled = false;
  // a locked pointer cannot click the link on the card
  if (document.pointerLockElement) document.exitPointerLock();
  const el = document.getElementById('nogl');
  if (el) {
    const p = el.querySelector('p');
    if (p) p.innerHTML = html;
    el.hidden = false;
    const a = el.querySelector('a');
    if (a) a.focus({ preventScroll: true });
  }
}

// --- on-screen diagnostics (?diag) -------------------------------------------
// A phone has no console, so everything needed to tell "the lights are dim"
// from "the lit shader never compiled" goes on the screen.
let diagEl = null, diagT = 0;
function updateDiag() {
  if (!DIAG) return;
  if (!diagEl) {
    diagEl = document.createElement('pre');
    diagEl.className = 'diag';
    diagEl.setAttribute('style', 'position:fixed;left:8px;top:8px;z-index:9999;margin:0;padding:8px 10px;max-width:min(92vw,520px);max-height:60vh;overflow:auto;background:rgba(0,0,0,.72);color:#e9e4d8;font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;border:1px solid rgba(233,228,216,.25);border-radius:6px;pointer-events:none');
    document.body.appendChild(diagEl);
  }
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const l = lightingReport();
  const r = renderer.info.render;
  diagEl.textContent = [
    `gpu      ${dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'hidden'}`,
    `vendor   ${dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'hidden'}`,
    `tier     ${quality}  dpr ${renderer.getPixelRatio().toFixed(2)}  touch ${TOUCH}`,
    `uniforms ${gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS)} frag / ${gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS)} vert`,
    `lights   rung ${l.rung}  pool ${l.pool} of ${l.fixtures} fixtures  ambient ${l.ambient}  env ${l.env ? 'on' : 'off'}${l.flattened ? '  FLATTENED' : ''}`,
    `probe    ${l.probes.map((p) => `${p.rung}:${p.lum}`).join('  ') || 'none'}`,
    `draw     ${r.calls} calls  ${r.triangles} tris  ${fps.toFixed(0)} fps`,
    `programs ${renderer.info.programs ? renderer.info.programs.length : 0}`,
    shaderErrors.length ? `\nSHADER ERRORS (${shaderErrors.length}):\n${shaderErrors.slice(0, 2).join('\n\n').slice(0, 900)}` : '\nno shader errors',
  ].join('\n');
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(pixelRatioForTier(quality));
  post.setSize();
  resizeReflection();
}
// every resize reallocates the bloom and reflection targets, and a window
// being dragged fires one per frame
let resizeT = 0;
addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(onResize, TOUCH ? 150 : 80);
});
addEventListener('orientationchange', () => setTimeout(onResize, 250));

canvas.addEventListener('webglcontextlost', (e) => {
  // no preventDefault: that would promise the browser a restore handler, and
  // rebuilding the world in place is a reload by another name
  stop('This device ran out of memory for the gallery.<br>Reload to try again — everything here also lives on the classic site.');
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) renderer.setAnimationLoop(null);
  else if (running) { clock.getDelta(); renderer.setAnimationLoop(frame); }
});

// Automatic downgrade: a tier that averages under 30 fps over three seconds of
// actual walking drops to the next one. It never climbs back.
let fps = 60;
let fpsFrames = 0, fpsAccum = 0;
function monitorFps(dt) {
  if (quality === 'low') return;
  fpsAccum += dt; fpsFrames++;
  if (fpsAccum >= 3) {
    const fps = fpsFrames / fpsAccum;
    if (fps < 30) applyQuality(quality === 'high' ? 'medium' : 'low');
    fpsFrames = 0; fpsAccum = 0;
  }
}

// headless tests + debug (?debug, ?diag) — not left on window for every visitor
if (DEBUG || DIAG) window.__debug = {
  walker, camera, scene, renderer, input,
  get ready() { return running; },
  quality: () => quality,
  setQuality: applyQuality,
  teleport: (x, z, heading) => spawn(x, z, heading ?? walker.heading, 0),
  goto: jumpTo,
  look(yawDeg = 0, pitchDeg = 0) { walker.heading = THREE.MathUtils.degToRad(yawDeg); walker.pitch = THREE.MathUtils.degToRad(pitchDeg); },
  sim(seconds) {
    const dt = 1 / 60;
    for (let i = 0; i < Math.round(seconds * 60); i++) { stepWalker(dt); updateCamera(camera); updateWorld(dt, i * dt, camera); }
  },
  interact: () => handleInteract(),
  frame: () => frame(true),
  lighting: () => lightingReport(),
  probe: () => probeLighting(),
  welcome: () => startWelcome(),
  shaderErrors: () => shaderErrors.slice(),
  degrade: () => degradeLighting(), // exercise the fallback ladder by hand
};

export { scene, camera, renderer, canvas };
