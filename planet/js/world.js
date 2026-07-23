// Orchestrates everything on the planet surface: foliage (with clearings), the
// content zones, the texture manager, the interaction scan, and the HUD. main.js
// calls buildWorld() during loading, enterContent() on ENTER, updateWorld() each
// frame, and handleInteract() when E is pressed.

import * as THREE from 'three';
import { C, NORTH } from './config.js';
import { createDressing } from './dressing.js';
import { resolveZones, zoneDir } from './layout.js';
import { makeTextureManager } from './textures.js';
import { buildZones } from './zones.js';
import { buildGallery, galleryActive, updateGallery, galleryInteract, getGalleryScene, setExitHandler } from './gallery.js';
import { buildVehicles, vehicleActive, exitVehicle, updateVehiclePrompt, vehicleCenter } from './vehicles.js';
import { buildFoliage } from './foliage.js';
import { initBiomeCivs } from './biomeCivs.js';
import { spawnAt } from './walk.js';
import {
  updateInteract, fireInteract, currentFocus, clearInteractables,
} from './interact.js';
import {
  initHud, initCompassScratch, showPrompt, hidePrompt, showHint, showCard,
  updateCompass, isOverlayOpen, closeOverlays,
} from './hud.js';
import { buildCitizenCard } from './citydialogue.js';

let dressing = null;
let foliage = null;
let biomeCivs = null;
let zones = null;
let tm = null;
let ctx = null;
let compassEntries = [];
let zoneUpdaters = [];
let pendingTalk = null; // nearest city citizen in talk range this frame, or null

const _camPos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _centre = new THREE.Vector3();

function buildClearings() {
  const clr = [];
  clr.push({ dir: zones.spawn, r: 16 });
  clr.push({ dir: zones.gallery, r: 36 });
  clr.push({ dir: zones.selfwork, r: 28 });
  clr.push({ dir: zones.books, r: 18 });
  clr.push({ dir: zones.collect, r: 18 });
  clr.push({ dir: zones.nova, r: 14 });
  clr.push({ dir: zones.garage, r: 34 });
  for (const b of zones.billboards) clr.push({ dir: b, r: 22 });
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    clr.push({ dir: zoneDir(140 + (0 - 140) * t, 95 + (160 - 95) * t), r: 8 });
  }
  return clr;
}

export async function buildWorld(context) {
  ctx = context;
  zones = resolveZones();
  ctx.zones = zones;
  initCompassScratch(THREE); // ready before the pre-ENTER render loop touches it

  const clearings = buildClearings();
  dressing = createDressing(ctx.planet, zones.spawn, clearings);

  tm = makeTextureManager(ctx.renderer, { maxResident: 48, hz: 4 });

  const built = buildZones(ctx, tm);
  compassEntries = built.compass;
  zoneUpdaters = built.updaters;

  // the garage + its four vehicles, and the streaming biome foliage that
  // follows the player/vehicle across the whole planet
  const veh = buildVehicles(ctx);
  if (veh && veh.compass) compassEntries = compassEntries.concat(veh.compass);
  foliage = buildFoliage(ctx.planet, zones.spawn);

  // Living civilisations: one dormant city seed per biome, woken by proximity,
  // growing while the player is near and ending by ascension or catastrophe.
  // Their compass markers guide the player out to them across the wilds.
  biomeCivs = initBiomeCivs(ctx.planet, { notify: showHint });
  compassEntries = compassEntries.concat(biomeCivs.compassEntries());

  await buildGallery(ctx, zones, tm);
  window.__tm = tm; // gallery grabs this to lazily register interior textures

  // leaving the gallery drops the player back outside its door on the planet
  setExitHandler((exit) => { if (exit) spawnAt(ctx.planet, exit.dir, exit.heading); });

  // texture-resident count for headless tests
  if (window.__debug) window.__debug.textureCount = () => tm.count;
}

export function activeScene() { return getGalleryScene(); }

export function enterContent(relock) {
  initHud({ relock, onClose: () => {} });
  initCompassScratch(THREE);
  showHint('W A S D to walk · Shift run · Space jump · E interact · Follow the compass to distant settlements in the wilds — grab a vehicle at the garage to reach them faster');
}

export function handleInteract() {
  if (isOverlayOpen()) { closeOverlays(); return; }
  if (galleryActive()) { galleryInteract(); return; }
  if (vehicleActive()) { exitVehicle(); return; }
  if (pendingTalk) { showCard(buildCitizenCard(pendingTalk.citizen, pendingTalk.life)); return; }
  fireInteract();
}

export function updateWorld(dt, t, camera) {
  if (galleryActive()) {
    // gallery sets the camera, moves the player, runs its own texture update,
    // and flags proximity to the exit door.
    updateGallery(dt, t, camera, tm);
    camera.getWorldPosition(_camPos);
    camera.getWorldDirection(_fwd);
    if (!isOverlayOpen() && !window.__galleryNearDoor) {
      const focus = updateInteract(_camPos, _fwd);
      if (focus && focus.prompt) showPrompt(focus.prompt);
      else hidePrompt();
    }
    return;
  }

  camera.getWorldPosition(_camPos);
  camera.getWorldDirection(_fwd);
  _up.copy(camera.up);

  if (dressing) dressing.update(t);
  tm.update(_camPos, performance.now());
  for (const fn of zoneUpdaters) fn(dt, t);

  // While piloting a vehicle the chase camera is nowhere near the player, so
  // the vehicle module owns the prompt and the foliage follows the vehicle.
  if (vehicleActive()) {
    if (foliage) foliage.update(vehicleCenter(_centre), t);
    if (biomeCivs) biomeCivs.update(dt, t, _centre);
    updateVehiclePrompt();
    updateCompass(compassEntries, _camPos, _fwd, _up, THREE);
    return;
  }

  if (foliage) foliage.update(_camPos, t);
  if (biomeCivs) biomeCivs.update(dt, t, _camPos);

  if (isOverlayOpen()) { hidePrompt(); pendingTalk = null; }
  else {
    // A nearby city citizen takes priority over the generic interact scan.
    pendingTalk = biomeCivs ? biomeCivs.talkTarget(_camPos) : null;
    if (pendingTalk) {
      showPrompt(`Talk to ${pendingTalk.citizen.name} &nbsp; <b>E</b>`);
    } else {
      const focus = updateInteract(_camPos, _fwd);
      if (focus && focus.prompt) showPrompt(focus.prompt);
      else hidePrompt();
    }
  }
  updateCompass(compassEntries, _camPos, _fwd, _up, THREE);
}

export function resolveZoneJump(name) {
  if (!zones) return null;
  if (name === 'spawn') return { dir: zones.spawn, heading: NORTH };
  let dir = null;
  if (name === 'billboards') dir = zones.billboards[2];
  else if (name === 'interior' || name === 'gallery') dir = zones.gallery;
  else if (zones[name]) dir = zones[name];
  if (!dir) return null;

  // Stand back ~22 units toward spawn from the structure center so the debug
  // jump looks AT it instead of landing inside it, then face the structure.
  const back = 22;
  const tan = new THREE.Vector3().subVectors(zones.spawn, dir);
  tan.addScaledVector(dir, -tan.dot(dir));
  if (tan.lengthSq() < 1e-6) tan.copy(NORTH);
  tan.normalize();
  const standDir = dir.clone().multiplyScalar(C.RADIUS).addScaledVector(tan, back).normalize();
  const heading = new THREE.Vector3().subVectors(dir, standDir); // look at structure
  return { dir: standDir, heading };
}

export { tm };
