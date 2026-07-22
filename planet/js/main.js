// Boot + frame loop for the jfeelgood planet. Stages later phases plug into:
// dressing, zones, hud, gallery, interaction. This file owns the renderer,
// the load sequence (bake → ENTER), pointer lock, and the render loop.

import * as THREE from 'three';
import { C, LANDING_DIR, NORTH, SUN } from './config.js';
import { createPlanet, bakePlanet, updatePlanet } from './planet.js';
import { input, initInput, lockPointer } from './input.js';
import { walk, stepWalk, updateWalkCamera, spawnAt } from './walk.js';
import { vehicleActive, stepVehicle, updateVehicleCamera } from './vehicles.js';
import { buildWorld, enterContent, updateWorld, resolveZoneJump, handleInteract, activeScene } from './world.js';

// no-WebGL gate already flagged the <html> element; bail to the card.
if (document.documentElement.classList.contains('no-webgl')) {
  const el = document.getElementById('nogl');
  if (el) el.hidden = false;
  const ld = document.getElementById('loader');
  if (ld) ld.style.display = 'none';
  throw new Error('WebGL2 unavailable');
}

const params = new URLSearchParams(location.search);
const DEBUG = params.get('debug');
const FLY = params.has('fly');

const canvas = document.createElement('canvas');
canvas.className = 'planet-canvas';
document.body.appendChild(canvas);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, C.MAX_PIXEL_RATIO));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x040308, 1);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x171021, 260, 1500);

const camera = new THREE.PerspectiveCamera(C.FOV, innerWidth / innerHeight, 0.1, 12000);
camera.up.copy(LANDING_DIR);

// --- lighting (dressing + structures use MeshStandard) ---
const sun = new THREE.DirectionalLight(C.SUN_TINT, 2.2);
sun.position.copy(SUN).multiplyScalar(3000);
scene.add(sun);
scene.add(new THREE.HemisphereLight(0xf0d8a8, 0x241a12, 0.5));

// --- planet ---
const planet = createPlanet(scene);

let quality = 'high';
let running = false;
const clock = new THREE.Clock();

// exposed for headless tests + debug jumps
window.__debug = {
  walk, planet, camera, scene, renderer, input,
  get ready() { return running; },
  quality: () => quality,
  look(yawDeg = 0, pitchDeg = 0) {
    // rotate heading around up by yaw, set pitch — for pointer-lock-less tests
    const up = walk.player.clone().normalize();
    walk.heading.applyAxisAngle(up, THREE.MathUtils.degToRad(yawDeg));
    walk.pitch = THREE.MathUtils.degToRad(pitchDeg);
  },
  // deterministic sim step for headless tests (rAF is throttled in headless):
  // set __debug.input.forward = true, then call sim(seconds).
  sim(seconds) {
    const dt = 1 / 60;
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      stepWalk(dt);
      updateWalkCamera(camera); // camera must lead updateWorld (interaction reads it)
      updateWorld(dt, i * dt, camera);
    }
  },
  interact: () => handleInteract(),
};

// --- load sequence ---
const loaderEl = document.getElementById('loader');
const fillEl = document.getElementById('loader-fill');
const statusEl = document.getElementById('loader-status');
const enterBtn = document.getElementById('enter-btn');
const controlsEl = document.getElementById('loader-controls');
const hudEl = document.getElementById('hud');

function setProgress(f, label) {
  if (fillEl) fillEl.style.width = Math.round(f * 100) + '%';
  if (label && statusEl) statusEl.textContent = label;
}

bakePlanet(planet, (f) => setProgress(f * 0.9, 'shaping the terrain…'), () => {
  setProgress(0.92, 'growing the valley…');
  // give later phases a beat to build zones/dressing before revealing ENTER
  buildWorld({ scene, planet, camera, renderer, quality }).then(() => {
    setProgress(1, 'ready');
    if (statusEl) statusEl.textContent = '';
    if (enterBtn) enterBtn.hidden = false;
    if (controlsEl) controlsEl.hidden = false;
    // start rendering behind the loader so ENTER reveals a live world
    startRenderLoop();
    if (DEBUG) enterWorld(); // headless/debug: skip the click gate
  }).catch((e) => { console.error('world build failed', e); });
});

function enterWorld() {
  // spawn at the landing site facing north
  spawnAt(planet, LANDING_DIR, NORTH);
  if (DEBUG && DEBUG.startsWith('at:')) jumpToZone(DEBUG.slice(3));
  if (loaderEl) { loaderEl.classList.add('fading'); setTimeout(() => (loaderEl.style.display = 'none'), 900); }
  if (hudEl) hudEl.hidden = false;
  if (!DEBUG) lockPointer(canvas);
  try { enterContent(() => lockPointer(canvas)); } catch (e) { console.error(e); }
}

function jumpToZone(name) {
  const d = resolveZoneJump(name);
  if (d) { spawnAt(planet, d.dir, d.heading || NORTH); if (d.pitch) walk.pitch = d.pitch; }
}

if (enterBtn) enterBtn.addEventListener('click', enterWorld);
canvas.addEventListener('click', () => { if (running && !input.locked && !document.querySelector('.card-overlay:not([hidden]),.viewer-overlay:not([hidden])')) lockPointer(canvas); });

initInput(canvas,
  () => { try { handleInteract(); } catch (e) { console.error(e); } },
  () => { if (hudEl) hudEl.classList.remove('locked'); }
);

// --- render loop ---
function startRenderLoop() {
  if (running) return;
  running = true;
  clock.start();
  renderer.setAnimationLoop(frame);
}

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  if (!DEBUG) monitorFps(dt);

  const gs = activeScene(); // non-null while inside the gallery interior
  if (gs) {
    // interior: world.updateWorld drives the flat walker + interior camera
    try { updateWorld(dt, t, camera); } catch (e) { console.error(e); }
    renderer.render(gs, camera);
    return;
  }

  if (walk.planet) {
    if (vehicleActive()) {
      if (input.locked || DEBUG) { stepVehicle(dt, t); updateVehicleCamera(camera); }
    } else if (FLY) {
      // noclip: move the player freely along heading/up for debug screenshots
      const up = walk.player.clone().normalize();
      const right = new THREE.Vector3().crossVectors(walk.heading, up).normalize();
      const move = new THREE.Vector3();
      const f = (input.forward ? 1 : 0) - (input.reverse ? 1 : 0);
      const s = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      move.addScaledVector(walk.heading, f).addScaledVector(right, s);
      if (input.jump) move.add(up);
      if (input.boost) move.multiplyScalar(3);
      walk.player.addScaledVector(move, 40 * dt);
      // still consume mouse look
      walk.pitch -= input.mouseY * C.LOOK_SENS;
      const yaw = -input.mouseX * C.LOOK_SENS;
      walk.heading.applyAxisAngle(up, yaw);
      input.mouseX = 0; input.mouseY = 0;
      updateWalkCamera(camera);
    } else if (input.locked || DEBUG) {
      stepWalk(dt);
      updateWalkCamera(camera);
    }
    if (input.locked && hudEl) hudEl.classList.add('locked');
  }

  updatePlanet(planet, t, camera, quality);
  try { updateWorld(dt, t, camera); } catch (e) { console.error(e); }
  renderer.render(scene, camera);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// Pause the render loop when the tab is hidden (saves battery/CPU); resume on
// return. clock keeps its own delta so time doesn't jump.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) renderer.setAnimationLoop(null);
  else if (running) { clock.getDelta(); renderer.setAnimationLoop(frame); }
});

// One-shot automatic quality downgrade: if the first few seconds average under
// ~28 FPS, drop the pixel ratio and cap surface octaves (quality='low' feeds
// updatePlanet). Cheap and non-destructive — no geometry rebuild.
let fpsFrames = 0, fpsAccum = 0, fpsChecked = false;
function monitorFps(dt) {
  if (fpsChecked || quality === 'low') return;
  fpsAccum += dt; fpsFrames++;
  if (fpsAccum >= 3) {
    const fps = fpsFrames / fpsAccum;
    if (fps < 28) {
      quality = 'low';
      renderer.setPixelRatio(1);
    }
    fpsChecked = true;
  }
}

// exports for later-phase modules
export { scene, planet, camera, renderer, canvas };
export function getQuality() { return quality; }
export function setQuality(q) { quality = q; }
