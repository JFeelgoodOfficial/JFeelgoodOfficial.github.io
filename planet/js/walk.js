// First-person character controller on a sphere, extracted from Feelgood Space
// Flight's walk.js (stepWalk core + updateWalkCamera FP branch). The game's
// couplings are gone: ship.position → a local `player` Vector3, the planet
// spins so all co-rotation/un-rotation is dropped, and the world/ content
// dispatch + city collision is replaced by a generic collider/pad registry.
//
// The planet is centered at the world origin, so `up` is just the normalized
// player position and radial distance `r` is its length.

import * as THREE from 'three';
import { C } from './config.js';
import { input } from './input.js';

const LOOK_SENS = C.LOOK_SENS;
const MAX_PITCH = C.MAX_PITCH;
const GROUND_SNAP = C.GROUND_SNAP;
const SWIM_SETTLE = 6.0;
const SHORE_HOP = 6.5;

// scratch vectors — zero per-frame allocation
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _look = new THREE.Vector3();
const _target = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _v = new THREE.Vector3();
const _wp = new THREE.Vector3();

export const walk = {
  planet: null,
  player: new THREE.Vector3(), // feet position (world)
  heading: new THREE.Vector3(1, 0, 0), // tangent forward
  facing: new THREE.Vector3(1, 0, 0),
  vel: new THREE.Vector3(),
  pitch: 0,
  vUp: 0,
  grounded: false,
  swimming: false,
  jumpHeld: false,
  mode: 'idle',
  speed01: 0,
};

// Generic push-out colliders (world-space spheres in the XZ-tangent sense) and
// ground pads (flat discs). Both are registered by zones.js in world space.
// A collider: { pos: Vector3, radius }. A pad: { pos: Vector3 (on surface),
// up: Vector3, radiusR: number (surface radial height), padR: number,
// blendR: number } — see registerPad.
const colliders = [];
const pads = [];

// Structure-collision resolvers: biomeCivs registers one for the town, and
// monteringger.js registers one for the mountain trail. Each is
// { wall(playerWorldVec3), floor(playerWorldVec3) -> world radius or -Infinity }.
// Floors carry the walker above terrain (building interiors, the mountain ramp);
// walls block. Composable so the town and the mountain coexist.
const structureFns = [];
export function addStructureResolver(fn) { if (fn) structureFns.push(fn); }
export function removeStructureResolver(fn) {
  const i = structureFns.indexOf(fn);
  if (i >= 0) structureFns.splice(i, 1);
}
// Back-compat single-resolver setter (clears the registry, then adds).
export function setStructureResolver(fn) { structureFns.length = 0; if (fn) structureFns.push(fn); }

export function clearColliders() { colliders.length = 0; pads.length = 0; }
export function addCollider(pos, radius) { colliders.push({ pos: pos.clone(), radius }); }
// A flat circular pad centered at `centerDir` (unit) whose top sits at radial
// height `heightR` above the planet center, blended back to terrain across the
// outer `blend` fraction of its radius.
export function addPad(centerDir, angularRadius, heightR, blend = 0.15) {
  pads.push({ dir: centerDir.clone().normalize(), cosR: Math.cos(angularRadius), heightR, blend, angularRadius });
}

function projectTangent(v, up) { v.addScaledVector(up, -v.dot(up)); }

// Radial height of the walkable floor under unit direction `up`: max of the
// terrain and any pad the point is inside (pads never dig below terrain).
function floorRadius(planet, up, atR) {
  let r = planet.radius + planet.groundAtLocal(up);
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    const c = up.dot(pad.dir); // cosine of angular distance to pad center
    if (c >= pad.cosR) {
      // inside the pad; blend to terrain across the outer rim
      const ang = Math.acos(Math.min(c, 1));
      const t = THREE.MathUtils.smoothstep(ang, pad.angularRadius * (1 - pad.blend), pad.angularRadius);
      const padTop = pad.heightR;
      r = Math.max(r, THREE.MathUtils.lerp(padTop, r, t));
    }
  }
  // Structure floors (city interiors via biomeCivs, the mountain trail via
  // monteringger) sit above terrain. Evaluate each at the caller's own world
  // position (up * atR) so the walker and vehicles are resolved at their own
  // spot; the walker passes its real radius so this equals walk.player.
  if (structureFns.length) {
    _wp.copy(up).multiplyScalar(atR != null ? atR : r);
    for (let i = 0; i < structureFns.length; i++) {
      const sr = structureFns[i].floor(_wp);
      if (sr > r) r = sr;
    }
  }
  return r;
}

function waterDepth(planet, up) {
  return Math.max(planet.seaR - (planet.radius + planet.groundAtLocal(up)), 0);
}

// Exported so the vehicle controller (vehicles.js) rides on the exact same
// walkable floor — terrain plus any structure pad — that the on-foot walker uses.
export function floorRadiusAt(planet, up) { return floorRadius(planet, up); }
export function waterDepthAt(planet, up) { return waterDepth(planet, up); }

// Place the walker at a unit direction, feet on the floor, facing `headingDir`.
export function spawnAt(planet, dir, headingDir) {
  walk.planet = planet;
  _up.copy(dir).normalize();
  walk.heading.copy(headingDir);
  projectTangent(walk.heading, _up);
  if (walk.heading.lengthSq() < 1e-6) walk.heading.set(_up.z, _up.x, _up.y);
  walk.heading.normalize();
  walk.facing.copy(walk.heading);
  walk.vel.set(0, 0, 0);
  walk.pitch = 0;
  walk.vUp = 0;
  walk.grounded = true;
  walk.swimming = false;
  const r = floorRadius(planet, _up);
  walk.player.copy(_up).multiplyScalar(r);
}

// Teleport helper for debug jumps between zones.
export function teleportTo(planet, dir) {
  spawnAt(planet, dir, walk.heading.lengthSq() > 1e-6 ? walk.heading : new THREE.Vector3(1, 0, 0));
}

export function stepWalk(dt) {
  const planet = walk.planet;
  if (!planet) return;

  _up.copy(walk.player).normalize();

  // --- mouse look ---
  const yaw = -input.mouseX * LOOK_SENS;
  walk.pitch -= input.mouseY * LOOK_SENS;
  walk.pitch = Math.min(Math.max(walk.pitch, -MAX_PITCH), MAX_PITCH);
  input.mouseX = 0;
  input.mouseY = 0;

  projectTangent(walk.heading, _up);
  if (walk.heading.lengthSq() < 1e-6) walk.heading.set(_up.z, _up.x, _up.y);
  walk.heading.normalize();
  walk.heading.applyAxisAngle(_up, yaw);
  projectTangent(walk.heading, _up);
  walk.heading.normalize();

  // --- environment at the current spot ---
  let r = walk.player.length();
  let depth = waterDepth(planet, _up);
  walk.swimming = depth > C.WALK_SWIM_DEPTH && r <= planet.seaR + 0.05;
  const wading = !walk.swimming && depth > C.WALK_WADE_DEPTH;

  // --- planar movement ---
  _right.crossVectors(walk.heading, _up).normalize();
  const fwd = (input.forward ? 1 : 0) - (input.reverse ? 1 : 0);
  const strafe = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  _wish.set(0, 0, 0);
  _wish.addScaledVector(walk.heading, fwd);
  _wish.addScaledVector(_right, strafe);
  const targetSpeed = walk.swimming
    ? C.WALK_SWIM_SPEED
    : wading ? C.WALK_WADE_SPEED
      : input.boost ? C.WALK_RUN_SPEED : C.WALK_SPEED;
  if (_wish.lengthSq() > 0) _wish.normalize().multiplyScalar(targetSpeed);

  projectTangent(walk.vel, _up);
  const accel = walk.swimming ? C.WALK_ACCEL_SWIM
    : walk.grounded ? C.WALK_ACCEL_GROUND : C.WALK_ACCEL_AIR;
  _move.subVectors(_wish, walk.vel);
  const gap = _move.length();
  const step = accel * dt;
  if (gap > step && gap > 1e-6) walk.vel.addScaledVector(_move, step / gap);
  else walk.vel.copy(_wish);
  walk.player.addScaledVector(walk.vel, dt);

  // --- collider push-out (slide along, don't pass through) ---
  for (let i = 0; i < colliders.length; i++) {
    const col = colliders[i];
    _v.subVectors(walk.player, col.pos);
    // work in the tangent plane so tall posts still block regardless of height
    const along = _v.dot(_up);
    _v.addScaledVector(_up, -along); // horizontal offset from collider axis
    const d = _v.length();
    if (d < col.radius && d > 1e-5) {
      walk.player.addScaledVector(_v, (col.radius - d) / d);
    }
  }

  // --- structure wall push-out (doorways stay open; trail edges hold) ---
  for (let i = 0; i < structureFns.length; i++) {
    if (structureFns[i].wall) structureFns[i].wall(walk.player);
  }

  // --- recompute up / radius after horizontal step ---
  _up.copy(walk.player).normalize();
  r = walk.player.length();
  const surfaceR = floorRadius(planet, _up, r);
  depth = waterDepth(planet, _up);
  walk.swimming = depth > C.WALK_SWIM_DEPTH && r <= planet.seaR + 0.05;

  // --- vertical integration ---
  if (walk.swimming) {
    walk.grounded = false;
    walk.vUp = 0;
    const rideR = planet.seaR - C.WALK_BUOYANCY;
    r += (rideR - r) * Math.min(1, SWIM_SETTLE * dt);
    if (r < surfaceR + 0.1) r = surfaceR + 0.1;
    if (input.jump && !walk.jumpHeld && depth < C.WALK_SWIM_DEPTH + 0.35) {
      walk.vUp = SHORE_HOP;
      r += walk.vUp * dt;
    }
  } else if (walk.vUp <= 0 && r <= surfaceR + GROUND_SNAP) {
    r = surfaceR;
    walk.grounded = true;
    walk.vUp = 0;
    if (input.jump && !walk.jumpHeld) walk.vUp = C.WALK_JUMP;
  } else {
    walk.grounded = false;
    walk.vUp -= C.WALK_GRAVITY * dt;
    r += walk.vUp * dt;
    if (r <= surfaceR) { r = surfaceR; walk.grounded = true; walk.vUp = 0; }
  }
  walk.jumpHeld = input.jump;

  walk.player.copy(_up).multiplyScalar(r);

  // --- facing for any visible body / motion state ---
  const hSpeed = walk.vel.length();
  walk.mode = walk.swimming ? 'swim' : !walk.grounded ? 'jump' : hSpeed > 0.6 ? 'run' : 'idle';
  walk.speed01 = Math.min(hSpeed / C.WALK_RUN_SPEED, 1);
  if (hSpeed > 0.4) {
    _fwd.copy(walk.vel).multiplyScalar(1 / hSpeed);
    walk.facing.lerp(_fwd, Math.min(1, 12.0 * dt));
  }
  projectTangent(walk.facing, _up);
  if (walk.facing.lengthSq() < 1e-6) walk.facing.copy(walk.heading);
  walk.facing.normalize();
}

// First-person camera at eye height, looking along heading pitched up/down.
export function updateWalkCamera(camera) {
  const planet = walk.planet;
  if (!planet) return;
  _up.copy(walk.player).normalize();
  _right.crossVectors(walk.heading, _up).normalize();
  _look.copy(walk.heading).applyAxisAngle(_right, walk.pitch);

  const eye = C.WALK_EYE_HEIGHT;
  camera.position.copy(walk.player).addScaledVector(_up, eye);
  _target.copy(camera.position).add(_look);
  camera.up.copy(_up);
  camera.lookAt(_target);
}

// Where the camera is aiming (unit), for interaction raycasts.
export function lookDir(out) {
  _up.copy(walk.player).normalize();
  _right.crossVectors(walk.heading, _up).normalize();
  return out.copy(walk.heading).applyAxisAngle(_right, walk.pitch).normalize();
}
