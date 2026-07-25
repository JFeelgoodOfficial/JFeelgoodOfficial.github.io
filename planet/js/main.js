// Boot + frame loop for the jfeelgood planet. Stages later phases plug into:
// dressing, zones, hud, gallery, interaction. This file owns the renderer,
// the load sequence (bake → ENTER), pointer lock, and the render loop.

import * as THREE from 'three';
import { C, LANDING_DIR, NORTH, SUN } from './config.js';
import { createPlanet, bakePlanet, updatePlanet } from './planet.js';
import { skydomeVert, skydomeFrag } from './shaders.js';
import { createPost } from './post.js';
import { createWeather } from './weather.js';
import { input, initInput, lockPointer, isActive } from './input.js';
import { initTouch, setTouchMode } from './touch.js';
import { walk, stepWalk, updateWalkCamera, spawnAt } from './walk.js';
import { vehicleActive, stepVehicle, updateVehicleCamera } from './vehicles.js';
import { skiRideActive, stepSkiRide, updateSkiRideCamera } from './skislope.js';
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
// `?debug` (no value) read as '' and fell through as falsy; only `?debug=…`
// ever armed the headless path. Normalise so both spellings work — `?debug=at:x`
// still carries its zone name.
const DEBUG = params.has('debug') ? (params.get('debug') || '1') : null;
const FLY = params.has('fly');

// Phones and tablets run the same world on a lighter budget. The head probe in
// index.html sets html.touch before any module loads. ?touch / ?notouch force it
// either way for testing on a desktop.
const TOUCH = params.has('touch')
  || (document.documentElement.classList.contains('touch') && !params.has('notouch'));

// Build-time budgets have to be cut BEFORE createDressing/buildFoliage run.
// C is a plain object and dressing.js reads these inside its builders, so
// mutating it here lands. C.DRESS_RADIUS is deliberately left alone —
// foliage.js captures INNER = C.DRESS_RADIUS * 0.85 at module load, so changing
// it now would desync the two scatter systems.
if (TOUCH) {
  C.DRESS_GRASS = 3500;
  C.DRESS_TREES = 40;
  C.DRESS_SHRUBS = 70;
  C.DRESS_ROCKS = 28;
}

const canvas = document.createElement('canvas');
canvas.className = 'planet-canvas';
document.body.appendChild(canvas);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, C.MAX_PIXEL_RATIO));
renderer.outputColorSpace = THREE.SRGBColorSpace;
// The planet's shaders are hand-tuned against a raw (untone-mapped) sRGB
// canvas; post.js adds bloom on top without re-grading, so tone mapping stays
// off to protect that palette.
renderer.toneMapping = THREE.NoToneMapping;
renderer.setClearColor(0x040308, 1);
// Soft sun shadows (disabled on the lowest quality tier).
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x171021, 260, 1500);

// near 0.25 on phones: the eye sits 1.8 above the feet so nothing renders
// closer, and a 0.1/12000 range is 120,000:1 — enough to z-fight the detail
// patch on the 16/24-bit depth buffers common on mobile GPUs. far stays put;
// planet.js sizes the skydome from camera.far and clips it below ~8000.
const camera = new THREE.PerspectiveCamera(C.FOV, innerWidth / innerHeight, TOUCH ? 0.25 : 0.1, 12000);
camera.up.copy(LANDING_DIR);

// --- lighting (dressing + structures use MeshStandard) ---
// The sun's DIRECTION is fixed; its position is re-centred on the player each
// frame so the shadow frustum travels with them instead of sitting at the
// planet's core. weather.js still owns its colour/intensity.
const sun = new THREE.DirectionalLight(C.SUN_TINT, 2.2);
sun.position.copy(SUN).multiplyScalar(3000);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 900;
sun.shadow.camera.left = -110;
sun.shadow.camera.right = 110;
sun.shadow.camera.top = 110;
sun.shadow.camera.bottom = -110;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.6;
scene.add(sun);
scene.add(sun.target);
const SHADOW_DIST = 320; // how far up-sun the shadow camera rides
const hemi = new THREE.HemisphereLight(0xf0d8a8, 0x241a12, 0.5);
scene.add(hemi);
// Cool fill so faces turned away from the sun aren't dead flat.
const fill = new THREE.DirectionalLight(0x8ea6d6, 0.3);
fill.position.copy(SUN).multiplyScalar(-1800).add(new THREE.Vector3(0, 600, 0));
scene.add(fill);

// --- planet ---
const planet = createPlanet(scene);

// --- dynamic weather (fog / clouds / light / precipitation) ---
const weather = createWeather({ scene, planet, sun, hemi, camera });

// Sky-tinted environment map: gives every MeshStandardMaterial (town buildings,
// vehicles, townsfolk) grounded reflections + soft image-based ambient instead
// of flat black metal. Built once from a gradient dome.
function buildEnvironment() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envScene = new THREE.Scene();
  const domeMat = new THREE.ShaderMaterial({
    vertexShader: skydomeVert,
    fragmentShader: skydomeFrag,
    uniforms: {
      uHorizon: { value: new THREE.Color(C.SKY_HORIZON) },
      uZenith: { value: new THREE.Color(C.SKY_ZENITH) },
      uBelow: { value: new THREE.Color(0x1a1208) }, // warm ground bounce
    },
    side: THREE.BackSide,
    depthWrite: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), domeMat);
  envScene.add(dome);
  scene.environment = pmrem.fromScene(envScene, 0.04).texture;
  scene.environmentIntensity = 0.55;
  dome.geometry.dispose();
  domeMat.dispose();
  pmrem.dispose();
}

// Adaptive post-processing (additive bloom); falls back to a direct render on
// the lowest tier.
const post = createPost(renderer, { strength: 0.95, threshold: 0.6, quality: 'high' });

// Touch devices boot straight into the lowest tier: pixel ratio 1, no shadows,
// no bloom. Deliberately reusing 'low' rather than inventing a 'mobile' string —
// planet.js, terrainDetail.js and monteringger.js all branch on === 'low', and a
// new name would silently skip every one of those reductions.
let quality = TOUCH ? 'low' : 'high';
let running = false;
const clock = new THREE.Clock();

// One place to apply a quality tier to everything that scales.
function applyQuality(q) {
  quality = q;
  if (q === 'high') {
    renderer.setPixelRatio(Math.min(devicePixelRatio, C.MAX_PIXEL_RATIO));
    renderer.shadowMap.enabled = true;
    sun.shadow.mapSize.set(2048, 2048);
    post.setEnabled(true); post.setQuality('high'); post.setStrength(0.95);
  } else if (q === 'medium') {
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
    renderer.shadowMap.enabled = true;
    sun.shadow.mapSize.set(1024, 1024);
    post.setEnabled(true); post.setQuality('medium'); post.setStrength(0.85);
  } else {
    renderer.setPixelRatio(1);
    renderer.shadowMap.enabled = false;
    post.setEnabled(false);
  }
  if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  post.setSize();
}
if (TOUCH) applyQuality('low');

// Keep the shadow frustum centred on the player (fixed sun direction).
const _shadowCtr = new THREE.Vector3();
function updateSunShadow() {
  camera.getWorldPosition(_shadowCtr);
  sun.target.position.copy(_shadowCtr);
  sun.position.copy(_shadowCtr).addScaledVector(SUN, SHADOW_DIST);
  sun.target.updateMatrixWorld();
}

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
      // mirror frame(): whichever movement mode is live gets stepped
      if (vehicleActive()) { stepVehicle(dt, i * dt); updateVehicleCamera(camera); }
      else if (skiRideActive()) { stepSkiRide(dt); updateSkiRideCamera(camera); }
      else { stepWalk(dt); updateWalkCamera(camera); } // camera must lead updateWorld (interaction reads it)
      try { weather.update(dt, i * dt); } catch (e) { /* ignore in headless */ }
      updateWorld(dt, i * dt, camera);
    }
  },
  interact: () => handleInteract(),
  weather,
};

// --- load sequence ---
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

// Nothing heavy runs until the visitor picks the world over the classic site.
// Baking a planet behind a title screen costs a phone real battery for someone
// who was only ever heading to classic.html.
let loadStarted = false;
function startLoad() {
  if (loadStarted) return;
  loadStarted = true;
  if (loaderEl) { loaderEl.classList.remove('stage-choice'); loaderEl.classList.add('stage-loading'); }

  bakePlanet(planet, (f) => setProgress(f * 0.9, 'shaping the terrain…'), () => {
    setProgress(0.92, 'growing the valley…');
    buildEnvironment(); // sky reflections ready before the world builds
    buildWorld({ scene, planet, camera, renderer, quality, getQuality }).then(() => {
      setProgress(1, 'ready');
      if (statusEl) statusEl.textContent = '';
      // start rendering behind the loader so entering reveals a live world
      startRenderLoop();
      if (DEBUG) { enterWorld(); return; } // headless/debug: skip the click gate
      // Touch has no pointer lock to acquire, so drop straight in. Desktop needs
      // one more click: requestPointerLock is only reliably granted inside a
      // fresh user gesture, and the bake took far longer than that.
      if (TOUCH) enterWorld();
      else if (enterBtn) enterBtn.hidden = false;
    }).catch((e) => { console.error('world build failed', e); });
  });
}

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

// Title screen: "ENTER THE WORLD" starts the bake; "CLASSIC SITE" is a plain
// link and needs no wiring. ?debug loads headlessly with no click at all.
if (enterWorldBtn) enterWorldBtn.addEventListener('click', startLoad);
if (enterBtn) enterBtn.addEventListener('click', enterWorld);
canvas.addEventListener('click', () => { if (running && !input.locked && !document.querySelector('.card-overlay:not([hidden]),.viewer-overlay:not([hidden])')) lockPointer(canvas); });

initInput(canvas,
  () => { try { handleInteract(); } catch (e) { console.error(e); } },
  () => { if (hudEl) hudEl.classList.remove('locked'); }
);

if (TOUCH) {
  initTouch(canvas, { onInteract: () => { try { handleInteract(); } catch (e) { console.error(e); } } });
}

if (DEBUG) startLoad();

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
    post.render(gs, camera);
    return;
  }

  if (walk.planet) {
    if (TOUCH) setTouchMode(vehicleActive() ? 'vehicle' : 'walk');
    if (vehicleActive()) {
      if (isActive() || DEBUG) { stepVehicle(dt, t); updateVehicleCamera(camera); }
    } else if (skiRideActive()) {
      // riding the chairlift: the walker is parented to a seat by skislope.js
      if (isActive() || DEBUG) { stepSkiRide(dt); updateSkiRideCamera(camera); }
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
    } else if (isActive() || DEBUG) {
      stepWalk(dt);
      updateWalkCamera(camera);
    }
    // the crosshair marks where the interact raycast points — needed on touch too
    if (isActive() && hudEl) hudEl.classList.add('locked');
  }

  updatePlanet(planet, t, camera, quality);
  try { weather.update(dt, t); } catch (e) { console.error(e); }
  try { updateWorld(dt, t, camera); } catch (e) { console.error(e); }
  if (renderer.shadowMap.enabled) updateSunShadow();
  post.render(scene, camera);
}

// Phones rotate, and the DPR can change when a window moves between displays,
// so re-apply the whole tier rather than just the size.
function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  // devicePixelRatio isn't fixed — it changes when a window moves between
  // displays, and setSize alone never re-read it.
  renderer.setPixelRatio(quality === 'low' ? 1
    : Math.min(devicePixelRatio, quality === 'medium' ? 1.25 : C.MAX_PIXEL_RATIO));
  post.setSize();
}
// Mobile browsers fire resize continuously as the URL bar collapses, and
// onResize reallocates render targets — debounce it there.
let resizeT = 0;
addEventListener('resize', () => {
  if (!TOUCH) { onResize(); return; }
  clearTimeout(resizeT);
  resizeT = setTimeout(onResize, 150);
});
addEventListener('orientationchange', () => setTimeout(onResize, 250));

// iOS drops the WebGL context when it runs out of GPU memory, silently leaving
// a black canvas. Say what happened and offer the door that always works.
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  renderer.setAnimationLoop(null);
  running = false;
  const el = document.getElementById('nogl');
  if (el) {
    const p = el.querySelector('p');
    if (p) p.innerHTML = 'This device ran out of memory for the world.<br>Reload to try again — everything here also lives on the classic site.';
    el.hidden = false;
  }
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

// exports for later-phase modules
export { scene, planet, camera, renderer, canvas };
export function getQuality() { return quality; }
export function setQuality(q) { applyQuality(q); }
