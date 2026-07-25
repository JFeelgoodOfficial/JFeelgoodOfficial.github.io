// Drivable / flyable vehicles parked in a hangar on the planet surface. Walk up
// to any of the four — a UAV drone, a plane, a tank, a motorcycle — and press E
// to take control; a third-person chase camera follows you across the terrain,
// and E again drops you back on foot beside where you left it.
//
// Like walk.js, every vehicle lives in the sphere's radial frame: "up" is the
// normalized position and the ground vehicles snap to the same walkable floor
// (walk.js floorRadiusAt) the character uses, so they ride the real terrain and
// structure pads. Air vehicles free-fly between that floor and an altitude cap.
//
// The vehicle bodies here are built from primitives. Each build*() returns
// { group, parts }, so a real GLTF model can be swapped in later by replacing a
// single builder (load a GLB, normalize its scale/forward axis, hand back the
// same shape) with no other change to the controller, camera, or mode switch.

import * as THREE from 'three';
import { C } from './config.js';
import { input } from './input.js';
import { spawnAt, floorRadiusAt, addPad } from './walk.js';
import { addInteractable } from './interact.js';
import { showHint, showPrompt, hidePrompt } from './hud.js';
import { frameAt } from './layout.js';

// --- tuning per vehicle. camDist/camHeight frame the chase cam. ------------
const DEFS = {
  drone: {
    kind: 'air', hover: true, name: 'UAV drone',
    accel: 24, maxSpeed: 42, yaw: 1.7, climb: 24, clearance: 2.0, maxAlt: 340,
    lookMul: 1.0, propRate: 55, rideH: 0.5, camDist: 9, camHeight: 3.6,
    controls: 'W/S move · A/D yaw · SPACE climb · SHIFT descend · MOUSE look · E land & exit',
    build: buildDrone,
  },
  plane: {
    kind: 'air', hover: false, name: 'plane',
    accel: 20, minSpeed: 24, cruise: 48, maxSpeed: 82, maxBank: 0.95, turnFromBank: 1.0,
    pitchKey: 0.8, clearance: 3.2, maxAlt: 430, lookMul: 0.85, propRate: 90, rideH: 0.7,
    camDist: 17, camHeight: 5.4,
    controls: 'W/S throttle · A/D bank & turn · MOUSE / SPACE·SHIFT pitch · E exit',
    build: buildPlane,
  },
  tank: {
    kind: 'ground', name: 'tank',
    accel: 11, maxSpeed: 22, revFrac: 0.5, brake: 16, turn: 1.0, lean: 0.1, rideH: 0.55,
    boost: 1.2, wheelRate: 0, camDist: 15, camHeight: 6.4,
    controls: 'W/S drive · A/D turn · SHIFT boost · MOUSE look · E disembark',
    build: buildTank,
  },
  motorcycle: {
    kind: 'ground', name: 'motorcycle',
    accel: 28, maxSpeed: 46, revFrac: 0.35, brake: 34, turn: 1.9, lean: 0.55, rideH: 0.35,
    boost: 1.5, wheelRate: 1.55, camDist: 8, camHeight: 3.2,
    controls: 'W/S throttle · A/D steer · SHIFT boost · MOUSE look · E dismount',
    build: buildMotorcycle,
  },
  horse: {
    kind: 'ground', name: 'horse', mount: true,
    accel: 16, maxSpeed: 30, revFrac: 0.28, brake: 20, turn: 1.7, lean: 0.12, rideH: 0.05,
    boost: 1.7, wheelRate: 0, camDist: 8.5, camHeight: 4.0,
    controls: 'W/S ride · A/D rein · SHIFT gallop · MOUSE look · E dismount',
    build: buildHorse,
  },
};
const PARK_ORDER = ['drone', 'plane', 'tank', 'motorcycle'];
const HORSE_COUNT = 3;

let planet = null, scene = null;
let active = null;
let lastDt = 1 / 60;
let camInit = false;
const vehicles = [];

// scratch
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _north = new THREE.Vector3();
const _east = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _desired = new THREE.Vector3();

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
function projectTangent(v, up) { v.addScaledVector(up, -v.dot(up)); }

// ---------------------------------------------------------------------------
// Build: hangar + four parked vehicles. Returns compass entries for world.js.
export function buildVehicles(ctx) {
  planet = ctx.planet; scene = ctx.scene;
  const zones = ctx.zones;
  const gdir = zones.garage;

  buildGarage(ctx, gdir);

  frameAt(gdir, _up, _north, _east);
  const fwdT = new THREE.Vector3().copy(zones.spawn);
  projectTangent(fwdT, _up);
  if (fwdT.lengthSq() < 1e-6) fwdT.copy(_north);
  fwdT.normalize();

  PARK_ORDER.forEach((kind, i) => {
    const def = DEFS[kind];
    const built = def.build();
    scene.add(built.group);

    const off = (i - 1.5) * 8;     // spread side to side along the hangar mouth
    const fwd = 19;                // stand out in front of the open hangar mouth
    const dir = new THREE.Vector3().copy(gdir)
      .addScaledVector(_east, off / planet.radius)
      .addScaledVector(fwdT, fwd / planet.radius)
      .normalize();
    const floorR = floorRadiusAt(planet, dir);

    const v = {
      def, group: built.group, parts: built.parts,
      pos: dir.clone().multiplyScalar(floorR + def.rideH),
      heading: fwdT.clone(), forward: fwdT.clone(),
      speed: 0, roll: 0, wheelSpin: 0, propSpin: 0, speed01: 0,
      interactable: null,
    };
    orientVehicle(v);
    v.interactable = addInteractable({
      pos: v.pos.clone(), radius: 5.5,
      prompt: `<b>E</b> — pilot the ${def.name}`,
      action: () => enterVehicle(v),
    });
    vehicles.push(v);
  });

  // --- stables: a paddock of horses off to one side of the hangar ----------
  // Direction of the paddock centre: out front of the garage and to the east.
  const stableDir = new THREE.Vector3().copy(gdir)
    .addScaledVector(_east, 40 / planet.radius)
    .addScaledVector(fwdT, 12 / planet.radius)
    .normalize();
  buildPaddock(stableDir, fwdT);
  for (let i = 0; i < HORSE_COUNT; i++) {
    const def = DEFS.horse;
    const built = def.build();
    scene.add(built.group);
    const off = (i - (HORSE_COUNT - 1) / 2) * 6;
    const dir = new THREE.Vector3().copy(stableDir)
      .addScaledVector(_east, off / planet.radius)
      .addScaledVector(fwdT, (i % 2 ? 3 : -3) / planet.radius)
      .normalize();
    const floorR = floorRadiusAt(planet, dir);
    const v = {
      def, group: built.group, parts: built.parts,
      pos: dir.clone().multiplyScalar(floorR + def.rideH),
      heading: fwdT.clone(), forward: fwdT.clone(),
      speed: 0, roll: 0, wheelSpin: 0, propSpin: 0, speed01: 0, gaitPhase: i * 1.7,
      interactable: null,
    };
    orientVehicle(v);
    v.interactable = addInteractable({
      pos: v.pos.clone(), radius: 4.5,
      prompt: '<b>E</b> — mount the horse',
      action: () => enterVehicle(v),
    });
    vehicles.push(v);
  }

  // headless/debug hooks
  if (typeof window !== 'undefined' && window.__debug) {
    window.__debug.enterVehicle = (i = 0) => enterVehicle(vehicles[i]);
    window.__debug.exitVehicle = exitVehicle;
    window.__debug.vehicleActive = vehicleActive;
    window.__debug.vehicles = vehicles;
    window.__debug.mountHorse = () => { const h = vehicles.find((x) => x.def.mount); if (h) enterVehicle(h); return !!h; };
  }

  const gpos = gdir.clone().multiplyScalar(planet.radius + planet.groundAtLocal(gdir));
  const spos = stableDir.clone().multiplyScalar(planet.radius + planet.groundAtLocal(stableDir));
  return { compass: [{ name: 'GARAGE', pos: gpos }, { name: 'STABLES', pos: spos }] };
}

// ---------------------------------------------------------------------------
// Controllers
export function stepVehicle(dt, t) {
  if (!active) return;
  lastDt = dt;
  const v = active;
  // a def may carry its own controller/orienter (the snowboard in skislope.js);
  // everything else — enter/exit, camera, touch mode, prompts — stays shared
  if (v.def.step) {
    v.def.step(v, dt, t);
    if (v.def.orient) v.def.orient(v); else orientVehicle(v);
    animateParts(v);
    return;
  }
  if (v.def.kind === 'ground') stepGround(v, dt);
  else if (v.def.hover) stepDrone(v, dt);
  else stepPlane(v, dt);
  orientVehicle(v);
  animateParts(v);
}

function stepGround(v, dt) {
  const def = v.def;
  _up.copy(v.pos).normalize();
  projectTangent(v.heading, _up); v.heading.normalize();

  const turn = (input.left ? 1 : 0) - (input.right ? 1 : 0);
  const th = (input.forward ? 1 : 0) - (input.reverse ? 1 : 0);
  const maxS = (input.boost && def.boost) ? def.maxSpeed * def.boost : def.maxSpeed;
  if (th !== 0) v.speed += th * def.accel * dt;
  else v.speed -= Math.sign(v.speed) * Math.min(Math.abs(v.speed), def.brake * dt);
  v.speed = clamp(v.speed, -maxS * def.revFrac, maxS);

  // steer — a little planted at speed, tanks can still pivot when crawling
  const steerScale = 0.4 + 0.6 * Math.min(Math.abs(v.speed) / def.maxSpeed, 1);
  const dirSign = v.speed < -0.01 ? -1 : 1;
  v.heading.applyAxisAngle(_up, turn * def.turn * steerScale * dirSign * dt);
  projectTangent(v.heading, _up); v.heading.normalize();

  v.pos.addScaledVector(v.heading, v.speed * dt);

  // snap to the walkable floor with a touch of suspension smoothing
  _up.copy(v.pos).normalize();
  const targetR = floorRadiusAt(planet, _up) + def.rideH;
  const r = v.pos.length();
  v.pos.copy(_up).multiplyScalar(r + (targetR - r) * Math.min(1, 14 * dt));

  v.roll += ((-turn * def.lean) - v.roll) * Math.min(1, 6 * dt);
  v.wheelSpin += v.speed * dt * (def.wheelRate || 0);
  // gait clock for animated legs (horses); slow idle drift, faster under way
  v.gaitPhase = (v.gaitPhase || 0) + (0.6 + Math.abs(v.speed) * 0.16) * dt;
  v.speed01 = Math.min(Math.abs(v.speed) / def.maxSpeed, 1);
}

function applyPitch(forward, right, pitch, up) {
  if (!pitch) return;
  _tmp.copy(forward).applyAxisAngle(right, pitch).normalize();
  if (Math.abs(_tmp.dot(up)) < 0.92) forward.copy(_tmp);
}

function clampAir(v) {
  _up.copy(v.pos).normalize();
  let r = v.pos.length();
  const minR = floorRadiusAt(planet, _up) + v.def.clearance;
  const maxR = planet.radius + v.def.maxAlt;
  if (r < minR) r = minR;
  if (r > maxR) r = maxR;
  v.pos.copy(_up).multiplyScalar(r);
}

function stepDrone(v, dt) {
  const def = v.def;
  _up.copy(v.pos).normalize();
  _right.crossVectors(v.forward, _up).normalize();

  const yaw = -input.mouseX * C.LOOK_SENS * def.lookMul
    + ((input.left ? 1 : 0) - (input.right ? 1 : 0)) * def.yaw * dt;
  v.forward.applyAxisAngle(_up, yaw);
  applyPitch(v.forward, _right, -input.mouseY * C.LOOK_SENS * def.lookMul, _up);
  input.mouseX = 0; input.mouseY = 0;
  v.forward.normalize();

  const th = (input.forward ? 1 : 0) - (input.reverse ? 1 : 0);
  if (th !== 0) v.speed += th * def.accel * dt;
  else v.speed -= Math.sign(v.speed) * Math.min(Math.abs(v.speed), def.accel * 0.6 * dt);
  v.speed = clamp(v.speed, -def.maxSpeed * 0.6, def.maxSpeed);
  v.pos.addScaledVector(v.forward, v.speed * dt);

  const altI = (input.jump ? 1 : 0) - (input.boost ? 1 : 0);
  v.pos.addScaledVector(_up, altI * def.climb * dt);

  clampAir(v);
  v.roll += (0 - v.roll) * Math.min(1, 4 * dt);
  v.propSpin += dt * def.propRate;
  v.speed01 = Math.min(Math.abs(v.speed) / def.maxSpeed, 1);
}

function stepPlane(v, dt) {
  const def = v.def;
  _up.copy(v.pos).normalize();
  _right.crossVectors(v.forward, _up).normalize();

  const bankInput = (input.left ? 1 : 0) - (input.right ? 1 : 0);
  v.roll += (bankInput * def.maxBank - v.roll) * Math.min(1, 3 * dt);
  v.forward.applyAxisAngle(_up, v.roll * def.turnFromBank * dt);

  const pitch = -input.mouseY * C.LOOK_SENS * def.lookMul
    + ((input.jump ? 1 : 0) - (input.boost ? 1 : 0)) * def.pitchKey * dt;
  applyPitch(v.forward, _right, pitch, _up);
  input.mouseX = 0; input.mouseY = 0;
  v.forward.normalize();

  const th = (input.forward ? 1 : 0) - (input.reverse ? 1 : 0);
  if (th !== 0) v.speed += th * def.accel * dt;
  else v.speed += (def.cruise - v.speed) * Math.min(1, 0.5 * dt);
  v.speed = clamp(v.speed, def.minSpeed, def.maxSpeed);
  v.pos.addScaledVector(v.forward, v.speed * dt);

  clampAir(v);
  v.propSpin += dt * def.propRate;
  v.speed01 = Math.min(v.speed / def.maxSpeed, 1);
}

// Orient the body: local +Z → facing, +Y → radial-ish up, then bank by roll.
// The basis MUST be right-handed (right = up × fwd, then trueUp = fwd × right),
// or makeBasis builds a reflection and setFromRotationMatrix flips the body.
function orientVehicle(v) {
  _up.copy(v.pos).normalize();
  _fwd.copy(v.def.kind === 'ground' ? v.heading : v.forward).normalize();
  _right.crossVectors(_up, _fwd);
  if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
  _right.normalize();
  _tmp.crossVectors(_fwd, _right).normalize(); // orthonormal up (right-handed)
  if (v.roll) { _right.applyAxisAngle(_fwd, v.roll); _tmp.applyAxisAngle(_fwd, v.roll); }
  _basis.makeBasis(_right, _tmp, _fwd);
  v.group.quaternion.setFromRotationMatrix(_basis);
  v.group.position.copy(v.pos);
}

function animateParts(v) {
  const p = v.parts;
  if (p.wheels) for (const w of p.wheels) w.rotation.x = v.wheelSpin;
  if (p.rotors) for (const r of p.rotors) r.rotation.y = v.propSpin;
  if (p.props) for (const pr of p.props) pr.rotation.z = v.propSpin;
  if (p.legs) {
    // trot: diagonal leg pairs (front-left+back-right vs front-right+back-left)
    const ph = v.gaitPhase || 0;
    const amp = 0.18 + 0.55 * (v.speed01 || 0);
    const s = Math.sin(ph * 7);
    p.legs[0].rotation.x = s * amp;
    p.legs[3].rotation.x = s * amp;
    p.legs[1].rotation.x = -s * amp;
    p.legs[2].rotation.x = -s * amp;
    if (p.head) p.head.rotation.x = -0.12 + Math.sin(ph * 7) * 0.05 * (v.speed01 || 0);
    if (p.tail) p.tail.rotation.z = Math.sin(ph * 4) * 0.16;
    // a gentle body bob while moving
    if (p.body) p.body.position.y = p.bodyY + Math.abs(Math.sin(ph * 7)) * 0.06 * (v.speed01 || 0);
  }
}

// ---------------------------------------------------------------------------
// Third-person chase camera (radial up kept level so the horizon stays sane).
export function updateVehicleCamera(camera) {
  if (!active) return;
  const v = active;
  // a def camera returning true replaces the chase cam (snowboard first-person)
  if (v.def.camera && v.def.camera(camera, v, lastDt)) return;
  _up.copy(v.pos).normalize();
  _fwd.copy(v.def.kind === 'ground' ? v.heading : v.forward).normalize();
  _desired.copy(v.pos).addScaledVector(_fwd, -v.def.camDist).addScaledVector(_up, v.def.camHeight);

  // don't let the camera sink under the terrain
  _tmp.copy(_desired).normalize();
  const minR = floorRadiusAt(planet, _tmp) + 1.5;
  if (_desired.length() < minR) _desired.copy(_tmp).multiplyScalar(minR);

  if (!camInit) { _camPos.copy(_desired); camInit = true; }
  _camPos.lerp(_desired, Math.min(1, 8 * lastDt));

  camera.up.copy(_up);
  camera.position.copy(_camPos);
  _tmp.copy(v.pos).addScaledVector(_up, 1.6).addScaledVector(_fwd, 3);
  camera.lookAt(_tmp);
}

// ---------------------------------------------------------------------------
// Enter / exit
export function vehicleActive() { return !!active; }

export function enterVehicle(v) {
  active = v;
  camInit = false;
  _up.copy(v.pos).normalize();
  projectTangent(v.heading, _up);
  if (v.heading.lengthSq() < 1e-6) v.heading.copy(_north);
  v.heading.normalize();
  v.forward.copy(v.heading);
  v.roll = 0;
  v.speed = v.def.kind === 'ground' ? 0 : (v.def.hover ? 0 : v.def.minSpeed);
  input.mouseX = 0; input.mouseY = 0;
  if (v.parts.rider) v.parts.rider.visible = true; // a rider appears in the saddle
  hidePrompt();
  showHint(v.def.controls);
}

export function exitVehicle() {
  if (!active) return;
  const v = active;
  const dir = _up.copy(v.pos).normalize().clone();       // ground point below
  const stand = _tmp.copy(v.pos)
    .addScaledVector(v.def.kind === 'ground' ? v.heading : v.forward, -4)
    .normalize().clone();
  spawnAt(planet, stand, v.def.kind === 'ground' ? v.heading : v.forward);

  // settle the parked vehicle onto the ground where it was left, and move its
  // "pilot me" prompt to the new spot so you can climb back in.
  const floorR = floorRadiusAt(planet, dir);
  v.pos.copy(dir).multiplyScalar(floorR + v.def.rideH);
  v.speed = 0; v.roll = 0;
  if (v.parts.rider) v.parts.rider.visible = false; // rider dismounts
  orientVehicle(v);
  v.interactable.pos.copy(v.pos);

  active = null;
  showHint('W A S D to walk · Shift run · E near a vehicle or horse');
}

// Register an externally built vehicle (the skislope snowboard) so it shares
// enterVehicle/exitVehicle, the chase camera and the debug hooks.
export function addVehicle(v) { vehicles.push(v); return v; }

// world.js calls this on E while piloting; also drives the exit prompt.
export function vehicleInteract() { exitVehicle(); return true; }
export function updateVehiclePrompt() {
  if (active) showPrompt(`<b>E</b> — exit ${active.def.name}`);
}
export function vehicleCenter(out) { return active ? out.copy(active.pos) : null; }

// ===========================================================================
// Geometry — everything below is procedural; swap any build*() for a GLTF load.
const M = (color, rough = 0.7, metal = 0.1, opts) =>
  new THREE.MeshStandardMaterial(Object.assign({ color, roughness: rough, metalness: metal }, opts || {}));
const Box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const Cyl = (rt, rb, h, s = 16) => new THREE.CylinderGeometry(rt, rb, h, s);
const mesh = (g, m) => new THREE.Mesh(g, m);
function axleWheel(r, thick, m) { const g = Cyl(r, r, thick, 22); g.rotateZ(Math.PI / 2); return mesh(g, m); }

function makeSign(text, w = 5, h = 1) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 128;
  const c = cv.getContext('2d');
  c.clearRect(0, 0, cv.width, cv.height);
  c.fillStyle = '#f5e1b8';
  c.font = '700 78px Georgia, serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(text, 256, 70);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
}

// place a group upright at surface dir, facing faceDir (mirrors zones.place)
const _pu = new THREE.Vector3(), _pn = new THREE.Vector3(), _pe = new THREE.Vector3(), _pf = new THREE.Vector3(), _pr = new THREE.Vector3(), _pb = new THREE.Matrix4();
function placeOnSurface(pl, group, dir, faceDir) {
  frameAt(dir, _pu, _pn, _pe);
  group.position.copy(dir).multiplyScalar(pl.radius + pl.groundAtLocal(dir));
  _pf.copy(faceDir).addScaledVector(_pu, -faceDir.dot(_pu)).normalize();
  if (_pf.lengthSq() < 1e-5) _pf.copy(_pn);
  _pr.crossVectors(_pu, _pf).normalize();
  _pb.makeBasis(_pr, _pu, _pf);
  group.quaternion.setFromRotationMatrix(_pb);
}

function buildGarage(ctx, dir) {
  const { planet: pl, scene: sc, zones } = ctx;
  addPad(dir, 30 / pl.radius, pl.radius + pl.groundAtLocal(dir), 0.25);

  const g = new THREE.Group();
  const dark = M(0x2a2d33, 0.85, 0.15), steel = M(0x6b7079, 0.55, 0.4), floor = M(0x3a3d42, 0.92, 0.1);
  const trim = M(0xf5b642, 0.5, 0.2, { emissive: 0x3a2a06 });
  const W = 34, L = 26, H = 11;
  const slab = mesh(Box(W, 0.5, L), floor); slab.position.y = 0.25; g.add(slab);
  const back = mesh(Box(W, H, 0.6), dark); back.position.set(0, H / 2, -L / 2); g.add(back);
  for (const sx of [-1, 1]) {
    const wall = mesh(Box(0.6, H, L), dark); wall.position.set(sx * W / 2, H / 2, 0); g.add(wall);
  }
  const roof = mesh(Box(W + 1.4, 0.7, L + 1.4), steel); roof.position.set(0, H, 0); g.add(roof);
  const beam = mesh(Box(W, 0.8, 0.8), trim); beam.position.set(0, H - 0.4, L / 2); g.add(beam);
  const sign = makeSign('GARAGE', 12, 3); sign.position.set(0, H + 1.7, L / 2 + 0.1); g.add(sign);

  placeOnSurface(pl, g, dir, zones.spawn);
  sc.add(g);
}

// --- UAV drone (quadcopter, +Z forward) ---
function buildDrone() {
  const g = new THREE.Group();
  const bodyMat = M(0x23262b, 0.5, 0.4), armMat = M(0x15171b, 0.6, 0.3);
  const rotorMat = M(0xf5b642, 0.4, 0.25, { emissive: 0x3a2a06 });
  const body = mesh(Box(1.5, 0.5, 2.1), bodyMat); body.position.y = 0.9; g.add(body);
  const dome = mesh(new THREE.SphereGeometry(0.45, 16, 12), M(0x0a0c10, 0.2, 0.2)); dome.scale.y = 0.6; dome.position.set(0, 1.12, 0.7); g.add(dome);
  const rotors = [];
  const R = 1.5;
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const ang = Math.atan2(sx, sz);
    const arm = mesh(Box(0.16, 0.12, R * 1.4), armMat); arm.position.set(sx * R * 0.5, 0.9, sz * R * 0.5); arm.rotation.y = ang; g.add(arm);
    const hub = mesh(Cyl(0.24, 0.28, 0.3, 12), armMat); hub.position.set(sx * R, 0.95, sz * R); g.add(hub);
    const rot = new THREE.Group(); rot.position.set(sx * R, 1.12, sz * R);
    for (let b = 0; b < 2; b++) { const bl = mesh(Box(1.7, 0.04, 0.16), rotorMat); bl.rotation.y = b * Math.PI / 2; rot.add(bl); }
    g.add(rot); rotors.push(rot);
  }
  for (const sx of [-1, 1]) {
    const skid = mesh(Box(0.1, 0.1, 2.0), armMat); skid.position.set(sx * 0.8, 0.4, 0); g.add(skid);
    for (const sz of [-0.8, 0.8]) { const leg = mesh(Box(0.1, 0.5, 0.1), armMat); leg.position.set(sx * 0.8, 0.65, sz); g.add(leg); }
  }
  return { group: g, parts: { rotors } };
}

// --- tank (+Z = barrel forward) ---
function buildTank() {
  const g = new THREE.Group();
  const hullMat = M(0x4a5138, 0.8, 0.2), trackMat = M(0x1c1e1a, 0.9, 0.1), turMat = M(0x545b40, 0.75, 0.2);
  const hull = mesh(Box(3.0, 1.1, 4.6), hullMat); hull.position.y = 1.3; g.add(hull);
  const glacis = mesh(Box(3.0, 1.0, 1.4), hullMat); glacis.position.set(0, 1.35, 2.4); glacis.rotation.x = -0.5; g.add(glacis);
  for (const sx of [-1, 1]) {
    const tread = mesh(Box(0.85, 1.0, 5.0), trackMat); tread.position.set(sx * 1.7, 0.7, 0); g.add(tread);
    const roadMat = M(0x2a2c26, 0.8);
    for (let i = 0; i < 5; i++) { const w = axleWheel(0.5, 0.85, roadMat); w.position.set(sx * 1.7, 0.6, -2 + i); g.add(w); }
  }
  const turret = new THREE.Group(); turret.position.set(0, 2.1, -0.2);
  turret.add(mesh(Cyl(1.4, 1.6, 1.0, 18), turMat));
  const barrel = mesh(Cyl(0.18, 0.2, 4.0, 12), turMat); barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.1, 2.3); turret.add(barrel);
  const hatch = mesh(Cyl(0.5, 0.5, 0.3, 12), turMat); hatch.position.set(0, 0.6, -0.4); turret.add(hatch);
  g.add(turret);
  return { group: g, parts: { turret } };
}

// --- plane (+Z forward, prop at nose) ---
function buildPlane() {
  const g = new THREE.Group();
  const body = M(0xdad3c4, 0.5, 0.2), accent = M(0xf5b642, 0.4, 0.3), metal = M(0x9aa0a8, 0.4, 0.7);
  const glass = M(0x223047, 0.2, 0.6, { transparent: true, opacity: 0.6 });
  const fus = mesh(Cyl(0.55, 0.35, 5.2, 16), body); fus.rotation.x = Math.PI / 2; fus.position.set(0, 1.6, 0); g.add(fus);
  const nose = mesh(new THREE.ConeGeometry(0.55, 1.0, 16), body); nose.rotation.x = -Math.PI / 2; nose.position.set(0, 1.6, 2.9); g.add(nose);
  const cock = mesh(new THREE.SphereGeometry(0.5, 16, 12), glass); cock.scale.set(0.9, 0.7, 1.3); cock.position.set(0, 2.0, 0.5); g.add(cock);
  const wing = mesh(Box(8.4, 0.16, 1.5), body); wing.position.set(0, 1.5, 0.1); g.add(wing);
  const wtip = mesh(Box(8.6, 0.14, 0.4), accent); wtip.position.set(0, 1.5, -0.55); g.add(wtip);
  const tail = mesh(Box(3.0, 0.14, 1.0), body); tail.position.set(0, 1.7, -2.4); g.add(tail);
  const fin = mesh(Box(0.16, 1.3, 1.1), body); fin.position.set(0, 2.2, -2.4); g.add(fin);
  const finA = mesh(Box(0.18, 0.6, 0.4), accent); finA.position.set(0, 2.7, -2.55); g.add(finA);
  const props = [];
  const prop = new THREE.Group(); prop.position.set(0, 1.6, 3.5);
  const phub = mesh(Cyl(0.15, 0.15, 0.3, 10), metal); phub.rotation.x = Math.PI / 2; prop.add(phub);
  for (let i = 0; i < 2; i++) { const bl = mesh(Box(0.18, 2.4, 0.06), metal); bl.rotation.z = i * Math.PI / 2; prop.add(bl); }
  g.add(prop); props.push(prop);
  for (const sx of [-1, 1]) {
    const leg = mesh(Box(0.1, 0.7, 0.1), metal); leg.position.set(sx * 1.4, 1.0, 0.4); g.add(leg);
    const w = axleWheel(0.3, 0.16, M(0x15151a, 0.9)); w.position.set(sx * 1.4, 0.65, 0.4); g.add(w);
  }
  return { group: g, parts: { props } };
}

// --- horse (+Z forward). Hooves at y≈0; legs pivot at the hip for the gait. ---
function buildHorse() {
  const g = new THREE.Group();
  const coats = [0x6b4a2f, 0x3a2a20, 0x8a6a45, 0x2b2b2f, 0xa8895f];
  const coat = coats[Math.floor((0.5 + 0.5 * Math.sin(vehicles.length * 12.9)) * coats.length) % coats.length];
  const hide = M(coat, 0.75, 0.02), mane = M(0x241813, 0.8), hoofM = M(0x1b1712, 0.7);
  const tack = M(0x3a241a, 0.6, 0.1), leather = M(0x5a3a22, 0.6);

  const hipY = 1.35, bodyY = hipY + 0.28;
  const body = mesh(Box(0.85, 0.9, 2.1), hide); body.position.set(0, bodyY, -0.1); g.add(body);
  // chest + rump rounding
  const chest = mesh(new THREE.SphereGeometry(0.52, 14, 10), hide); chest.scale.set(0.85, 0.9, 0.8); chest.position.set(0, bodyY, 0.95); g.add(chest);
  const rump = mesh(new THREE.SphereGeometry(0.55, 14, 10), hide); rump.scale.set(0.9, 0.95, 0.9); rump.position.set(0, bodyY, -1.15); g.add(rump);

  // neck + head
  const neck = mesh(Box(0.42, 1.0, 0.5), hide); neck.position.set(0, bodyY + 0.5, 1.15); neck.rotation.x = -0.6; g.add(neck);
  const head = new THREE.Group(); head.position.set(0, bodyY + 0.95, 1.55);
  const skull = mesh(Box(0.34, 0.42, 0.5), hide); skull.position.set(0, 0, 0); head.add(skull);
  const muzzle = mesh(Box(0.26, 0.28, 0.5), hide); muzzle.position.set(0, -0.08, 0.42); head.add(muzzle);
  for (const sx of [-1, 1]) { const ear = mesh(new THREE.ConeGeometry(0.09, 0.28, 6), hide); ear.position.set(sx * 0.12, 0.3, -0.05); head.add(ear); }
  head.add(mesh(Box(0.1, 0.5, 0.1), mane)); // forelock stub
  g.add(head);
  // mane along the neck
  const maneStrip = mesh(Box(0.08, 0.9, 0.5), mane); maneStrip.position.set(0, bodyY + 0.55, 1.12); maneStrip.rotation.x = -0.6; g.add(maneStrip);

  // tail
  const tail = new THREE.Group(); tail.position.set(0, bodyY + 0.1, -1.55);
  const tuft = mesh(Box(0.16, 1.0, 0.16), mane); tuft.position.set(0, -0.45, -0.1); tuft.rotation.x = 0.5; tail.add(tuft);
  g.add(tail);

  // saddle + stirrups
  const saddle = mesh(Box(0.7, 0.22, 0.9), tack); saddle.position.set(0, bodyY + 0.5, -0.2); g.add(saddle);
  for (const sx of [-1, 1]) { const st = mesh(Box(0.06, 0.5, 0.06), leather); st.position.set(sx * 0.42, bodyY + 0.1, -0.2); g.add(st); }

  // four legs (groups pivoting at the hip)
  const legs = [];
  const legMat = M(coat, 0.75, 0.02);
  const legPos = [[-0.32, 0.85], [0.32, 0.85], [-0.32, -1.0], [0.32, -1.0]]; // FL, FR, BL, BR
  for (const [lx, lz] of legPos) {
    const leg = new THREE.Group(); leg.position.set(lx, hipY, lz);
    const shin = mesh(Box(0.22, 1.3, 0.26), legMat); shin.position.y = -0.62; leg.add(shin);
    const hoof = mesh(Box(0.26, 0.22, 0.32), hoofM); hoof.position.y = -1.28; leg.add(hoof);
    g.add(leg); legs.push(leg);
  }

  // rider (hidden until mounted): a simple seated figure in the saddle
  const rider = new THREE.Group(); rider.position.set(0, bodyY + 0.55, -0.2); rider.visible = false;
  const rcoat = M(0x3a5a7a, 0.7), rskin = M(0xd8a77a, 0.6);
  rider.add(mesh(Box(0.44, 0.7, 0.36), rcoat)); // torso
  const rhead = mesh(new THREE.SphereGeometry(0.2, 12, 10), rskin); rhead.position.y = 0.55; rider.add(rhead);
  for (const sx of [-1, 1]) { const thigh = mesh(Box(0.16, 0.16, 0.6), M(0x2a2f3a, 0.7)); thigh.position.set(sx * 0.16, -0.25, 0.28); thigh.rotation.x = 0.9; rider.add(thigh); }
  for (const sx of [-1, 1]) { const arm = mesh(Box(0.13, 0.5, 0.13), rcoat); arm.position.set(sx * 0.3, 0.05, 0.14); arm.rotation.x = 0.7; rider.add(arm); }
  g.add(rider);

  return { group: g, parts: { legs, head, tail, body, bodyY, rider } };
}

// A rail paddock so the horses read as "stables" beside the hangar.
function buildPaddock(dir, faceDir) {
  const g = new THREE.Group();
  const rail = M(0x6e4a2e, 0.85), post = M(0x53381f, 0.9);
  const half = 14, gap = 3.5;
  for (let side = 0; side < 4; side++) {
    const along = side < 2 ? 'x' : 'z';
    const sign = side % 2 ? 1 : -1;
    for (let i = -half; i <= half; i += gap) {
      // leave a gate on the front (side 2, near the middle)
      if (side === 2 && Math.abs(i) < gap) continue;
      const p = mesh(Box(0.24, 2.0, 0.24), post);
      if (along === 'x') p.position.set(i, 1.0, sign * half); else p.position.set(sign * half, 1.0, i);
      g.add(p);
    }
    const beam = mesh(along === 'x' ? Box(half * 2, 0.16, 0.16) : Box(0.16, 0.16, half * 2), rail);
    if (along === 'x') beam.position.set(0, 1.4, sign * half); else beam.position.set(sign * half, 1.4, 0);
    g.add(beam);
    const beam2 = beam.clone(); beam2.position.y = 0.7; g.add(beam2);
  }
  const sign = makeSign('STABLES', 10, 2.6); sign.position.set(0, 3.2, half + 0.1); g.add(sign);
  placeOnSurface(planet, g, dir, faceDir);
  scene.add(g);
}

// --- motorcycle (+Z forward) ---
function buildMotorcycle() {
  const g = new THREE.Group();
  const body = M(0x8a1f1f, 0.4, 0.5), metalM = M(0x2b2e33, 0.5, 0.7), tire = M(0x121316, 0.9, 0.05), chrome = M(0xcfd3d8, 0.3, 0.85);
  const wheels = [];
  for (const z of [1.15, -1.15]) {
    const w = axleWheel(0.62, 0.28, tire); w.position.set(0, 0.62, z); g.add(w); wheels.push(w);
    const hub = axleWheel(0.2, 0.3, chrome); hub.position.set(0, 0.62, z); g.add(hub);
  }
  const frame = mesh(Box(0.24, 0.5, 2.2), metalM); frame.position.set(0, 1.05, 0); frame.rotation.x = 0.1; g.add(frame);
  const tank = mesh(Box(0.5, 0.4, 0.9), body); tank.position.set(0, 1.35, 0.2); g.add(tank);
  const seat = mesh(Box(0.42, 0.22, 1.0), M(0x15151a, 0.7)); seat.position.set(0, 1.35, -0.7); g.add(seat);
  const eng = mesh(Box(0.6, 0.5, 0.6), M(0x3a3d42, 0.5, 0.7)); eng.position.set(0, 0.75, 0.1); g.add(eng);
  const fork = mesh(Box(0.14, 1.2, 0.14), chrome); fork.position.set(0, 1.0, 1.15); fork.rotation.x = -0.35; g.add(fork);
  const bar = mesh(Cyl(0.05, 0.05, 0.9, 8), metalM); bar.rotation.z = Math.PI / 2; bar.position.set(0, 1.55, 1.0); g.add(bar);
  const light = mesh(new THREE.SphereGeometry(0.18, 12, 10), M(0xfff2c0, 0.3, 0.1, { emissive: 0x8a7a30 })); light.position.set(0, 1.5, 1.3); g.add(light);
  return { group: g, parts: { wheels } };
}
