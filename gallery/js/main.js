// Boot + frame loop for the jfeelgood gallery. Owns the renderer, the title
// screen → loading → ENTER sequence, pointer lock, quality tiers and the
// per-frame order: walk → camera → world update → floor reflection pass →
// scene render (through the HDR bloom pipeline).

import * as THREE from 'three';
import { C } from './config.js';
import { createPost } from './post.js';
import { input, initInput, lockPointer, isActive } from './input.js';
import { initTouch } from './touch.js';
import { walker, stepWalker, updateCamera, spawn } from './walker.js';
import { buildWorld, updateWorld, renderReflection, setReflectionEnabled, resizeReflection, handleInteract, resolvePlace, degradeLighting, lightingReport, probeLighting, startWelcome, setProbeFail } from './world.js';

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

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
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
renderer.shadowMap.autoUpdate = false; // rendered once per frame by hand (the reflection pass shares them)

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

let quality = FORCE_Q || (TOUCH ? 'low' : 'high');
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
}

// --- load sequence -----------------------------------------------------------
const loaderEl = document.getElementById('loader');
const fillEl = document.getElementById('loader-fill');
const statusEl = document.getElementById('loader-status');
const enterBtn = document.getElementById('enter-btn');
const enterWorldBtn = document.getElementById('enter-world');
const hudEl = document.getElementById('hud');

function setProgress(f, label) {
  if (fillEl) fillEl.style.width = Math.round(f * 100) + '%';
  if (label && statusEl) statusEl.textContent = label;
}

let loadStarted = false;
function startLoad() {
  if (loadStarted) return;
  loadStarted = true;
  if (loaderEl) { loaderEl.classList.remove('stage-choice'); loaderEl.classList.add('stage-loading'); }
  if (PROBE_FAIL) setProbeFail(true);
  buildWorld({ scene, renderer, camera, quality, progress: setProgress, forceRung: FORCE_LIT, relock: () => lockPointer(canvas) })
    .then(() => {
      if (statusEl) statusEl.textContent = '';
      // the world is built; now switch the renderer itself to the tier
      // (?q=low has to actually turn the reflection, bloom and shadows off)
      applyQuality(quality);
      startRenderLoop();
      if (DEBUG) { enterWorld(); return; }
      if (TOUCH) enterWorld();
      else if (enterBtn) enterBtn.hidden = false;
    })
    .catch((e) => { console.error('gallery build failed', e); if (statusEl) statusEl.textContent = 'something went wrong — the classic site has everything'; });
}

function enterWorld() {
  if (DEBUG && DEBUG.startsWith('at:')) jumpTo(DEBUG.slice(3));
  if (loaderEl) { loaderEl.classList.add('fading'); setTimeout(() => (loaderEl.style.display = 'none'), 900); }
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

if (enterWorldBtn) enterWorldBtn.addEventListener('click', startLoad);
if (enterBtn) enterBtn.addEventListener('click', enterWorld);
canvas.addEventListener('click', () => {
  if (running && !input.locked && !document.querySelector('.card-overlay:not([hidden]),.viewer-overlay:not([hidden])')) lockPointer(canvas);
});

initInput(canvas,
  () => { try { handleInteract(); } catch (e) { console.error(e); } },
  () => { if (hudEl) hudEl.classList.remove('locked'); }
);
if (TOUCH) initTouch(canvas, { onInteract: () => { try { handleInteract(); } catch (e) { console.error(e); } } });
if (DEBUG) startLoad();

// --- render loop -------------------------------------------------------------
function startRenderLoop() {
  if (running) return;
  running = true;
  clock.start();
  renderer.setAnimationLoop(frame);
}

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  if (dt > 0) fps = fps * 0.9 + (1 / dt) * 0.1;
  if (!DEBUG && !FORCE_Q) monitorFps(dt);
  if (DIAG && t - diagT > 0.5) { diagT = t; updateDiag(); }

  if (isActive() || DEBUG) stepWalker(dt);
  updateCamera(camera);
  if (isActive() && hudEl) hudEl.classList.add('locked');
  try { updateWorld(dt, t, camera); } catch (e) { console.error(e); }

  if (renderer.shadowMap.enabled) renderer.shadowMap.needsUpdate = true;
  try { renderReflection(camera); } catch (e) { console.error(e); }
  post.render(scene, camera);
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
let resizeT = 0;
addEventListener('resize', () => {
  if (!TOUCH) { onResize(); return; }
  clearTimeout(resizeT);
  resizeT = setTimeout(onResize, 150);
});
addEventListener('orientationchange', () => setTimeout(onResize, 250));

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  renderer.setAnimationLoop(null);
  running = false;
  const el = document.getElementById('nogl');
  if (el) {
    const p = el.querySelector('p');
    if (p) p.innerHTML = 'This device ran out of memory for the gallery.<br>Reload to try again — everything here also lives on the classic site.';
    el.hidden = false;
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) renderer.setAnimationLoop(null);
  else if (running) { clock.getDelta(); renderer.setAnimationLoop(frame); }
});

// One-shot automatic downgrade if the first seconds run slow.
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

// headless tests + debug
window.__debug = {
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
  frame: () => frame(),
  lighting: () => lightingReport(),
  probe: () => probeLighting(),
  welcome: () => startWelcome(),
  shaderErrors: () => shaderErrors.slice(),
  degrade: () => degradeLighting(), // exercise the fallback ladder by hand
};

export { scene, camera, renderer, canvas };
