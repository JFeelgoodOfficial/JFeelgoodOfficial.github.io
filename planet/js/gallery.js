// The Archives gallery: a landmark rotunda on the terrain whose door leads
// into a separate flat-floored interior scene holding all 186 archive works.
// The interior is its own THREE.Scene with a simple flat-gravity walker and
// AABB corridor collision — so while you are inside, the planet scene isn't
// rendered and its GPU budget is free. Painting textures load by proximity
// (textures.js), capped so memory stays bounded even with 186 works.

import * as THREE from 'three';
import { C } from './config.js';
import { zoneDir, frameAt } from './layout.js';
import { addCollider, addPad, walk } from './walk.js';
import { addInteractable, addRayTarget, currentFocus, fireInteract } from './interact.js';
import { makeArtPanel } from './panels.js';
import { showPrompt, hidePrompt, showViewer, isOverlayOpen } from './hud.js';
import { input } from './input.js';
import { ARCHIVES } from './content.js';

// --- interior geometry constants (metres, flat local frame) ---
const OUT = 36; // outer wall half-extent
const INN = 28; // inner courtyard half-extent (corridor width = 8)
const WALL_H = 6.5;
const EYE = 1.7;
const DOOR_HALF = 3.5; // door gap half-width on the south (-z) outer wall
const SPEED = 6.5, RUN = 12, ACCEL = 40, GRAV = 22, JUMP = 7;

let scene = null;
let active = false;
let player = new THREE.Vector3();
let heading = 0, pitch = 0, vUp = 0, grounded = true;
let interiorTM = null;
let fadeEl = null;
let exitPos = null; // where to drop the player on the planet when leaving
let onExitToWorld = null;

const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Exterior rotunda + door, on the planet surface at the gallery zone.
export async function buildGallery(ctx, zones, tm) {
  const { planet, scene: worldScene } = ctx;
  const dir = zones.gallery;
  frameAt(dir, new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3());
  addPad(dir, 34 / planet.radius, planet.radius + planet.groundAtLocal(dir), 0.2);

  const g = new THREE.Group();
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a2320, roughness: 0.9 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xf5b642, emissive: 0x3a2a06, roughness: 0.5 });

  // cylinder shell (open front via a separate door arch in front of it)
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(16, 16, 12, 40, 1, true), wallMat);
  shell.material.side = THREE.DoubleSide;
  shell.position.y = 6;
  g.add(shell);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(16, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), wallMat.clone());
  dome.material.side = THREE.DoubleSide;
  dome.position.y = 12;
  g.add(dome);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(16, 0.5, 12, 40), trimMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 12;
  g.add(ring);
  // door frame at the front (+z toward spawn)
  const arch = new THREE.Mesh(new THREE.BoxGeometry(7, 8, 1), trimMat);
  arch.position.set(0, 4, 16);
  g.add(arch);
  const doorway = new THREE.Mesh(new THREE.BoxGeometry(5, 6.4, 1.2), new THREE.MeshBasicMaterial({ color: 0x05040a }));
  doorway.position.set(0, 3.2, 16.1);
  g.add(doorway);
  // "THE ARCHIVES" sign
  const sign = makeSign('THE  ARCHIVES');
  sign.position.set(0, 8.4, 16.2);
  g.add(sign);

  placeOnSurface(planet, g, dir, zones.spawn);
  worldScene.add(g);
  addCollider(g.position, 15); // rotunda shell — walk around, enter via door

  // door interactable (in front of the doorway)
  _dir.set(0, 1.6, 17).applyQuaternion(g.quaternion).add(g.position);
  const doorPos = _dir.clone();
  addInteractable({
    pos: doorPos, radius: 6,
    prompt: '<b>E</b> — enter the Archives',
    action: () => enterGallery(),
  });

  // remember where to spawn back on the planet (just outside the door)
  exitPos = { dir: zones.gallery.clone(), heading: new THREE.Vector3().subVectors(zones.spawn, zones.gallery) };

  // build the interior scene now (geometry only; textures load on proximity)
  buildInterior(ctx.renderer);

  // debug hook for headless tests
  if (typeof window !== 'undefined') window.__enterGallery = enterGallery;
}

function makeSign(text) {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 128;
  const c = cv.getContext('2d');
  c.fillStyle = 'rgba(0,0,0,0)';
  c.fillRect(0, 0, cv.width, cv.height);
  c.fillStyle = '#f5e1b8';
  c.font = '600 72px Georgia, serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, 512, 68);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.125), mat);
  return m;
}

// place group upright at dir facing faceDir (same as zones.place)
const _u = new THREE.Vector3(), _n = new THREE.Vector3(), _e = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _b = new THREE.Matrix4();
function placeOnSurface(planet, group, dir, faceDir) {
  frameAt(dir, _u, _n, _e);
  group.position.copy(dir).multiplyScalar(planet.radius + planet.groundAtLocal(dir));
  _f.copy(faceDir).addScaledVector(_u, -faceDir.dot(_u)).normalize();
  if (_f.lengthSq() < 1e-5) _f.copy(_n);
  _r.crossVectors(_u, _f).normalize();
  _b.makeBasis(_r, _u, _f);
  group.quaternion.setFromRotationMatrix(_b);
}

// ---------------------------------------------------------------------------
// Interior scene: an ambulatory loop with paintings on the outer (inward) and
// inner (outward) walls.
function buildInterior(renderer) {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14100f);
  scene.fog = new THREE.Fog(0x14100f, 20, 90);

  scene.add(new THREE.HemisphereLight(0xfff2d8, 0x2a2018, 1.15));
  scene.add(new THREE.AmbientLight(0xffe9cc, 0.35));
  const key = new THREE.DirectionalLight(0xffe8c0, 0.9);
  key.position.set(20, 40, 10);
  scene.add(key);
  // warm spots implied by emissive strip lights along the top of each wall
  const stripMat = new THREE.MeshBasicMaterial({ color: 0xf5d79a, toneMapped: false });

  const floorMat = new THREE.MeshStandardMaterial({ color: 0x2a2019, roughness: 0.85 });
  const floorSq = new THREE.Mesh(new THREE.PlaneGeometry(OUT * 2, OUT * 2), floorMat);
  floorSq.rotation.x = -Math.PI / 2;
  scene.add(floorSq);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(OUT * 2, OUT * 2), new THREE.MeshStandardMaterial({ color: 0x0f0c0a, roughness: 1 }));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = WALL_H;
  scene.add(ceil);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2b2621, roughness: 0.92 });
  // outer walls (4) and inner courtyard box (4), built as boxes
  const mkWall = (w, d, x, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, WALL_H, d), wallMat);
    m.position.set(x, WALL_H / 2, z);
    scene.add(m);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(w * 0.98, 0.2, d * 0.98), stripMat);
    strip.position.set(x, WALL_H - 0.3, z);
    scene.add(strip);
    return m;
  };
  // outer
  mkWall(OUT * 2, 0.5, 0, OUT);   // north (+z)
  mkWall(OUT * 2, 0.5, 0, -OUT);  // south (-z) — door gap handled by collision
  mkWall(0.5, OUT * 2, OUT, 0);   // east
  mkWall(0.5, OUT * 2, -OUT, 0);  // west
  // inner courtyard (solid block walls)
  mkWall(INN * 2, 0.5, 0, INN);
  mkWall(INN * 2, 0.5, 0, -INN);
  mkWall(0.5, INN * 2, INN, 0);
  mkWall(0.5, INN * 2, -INN, 0);

  // door portal back to the planet, on the south outer wall gap
  const back = new THREE.Mesh(new THREE.PlaneGeometry(DOOR_HALF * 2, 5), new THREE.MeshBasicMaterial({ color: 0xf5b642, transparent: true, opacity: 0.15, side: THREE.DoubleSide, toneMapped: false }));
  back.position.set(0, 2.5, -OUT + 0.3);
  scene.add(back);
  addInteractable_interior = { pos: new THREE.Vector3(0, 1.6, -OUT + 2), radius: 3.5 };

  // --- hang the 186 works ---
  interiorTM = null; // set by caller's tm; we register into the shared manager
  hangPaintings(renderer);
}

let addInteractable_interior = null;
const galleryPanels = [];

// slot generator: walk each of the 8 walls, emitting {pos, normal, up} slots.
function* slots() {
  const midY = 3.2;
  const step = 3.0;
  // outer walls face inward (normal toward center); inner walls face outward.
  const segs = [
    // outer north (+z), normal -z, run along x
    { fixed: 'z', at: OUT - 0.3, from: -OUT + 4, to: OUT - 4, nx: 0, nz: -1, axis: 'x' },
    { fixed: 'x', at: OUT - 0.3, from: OUT - 4, to: -OUT + 4, nx: -1, nz: 0, axis: 'z' }, // east
    { fixed: 'z', at: -OUT + 0.3, from: OUT - 4, to: -OUT + 4, nx: 0, nz: 1, axis: 'x', skipDoor: true }, // south (door)
    { fixed: 'x', at: -OUT + 0.3, from: -OUT + 4, to: OUT - 4, nx: 1, nz: 0, axis: 'z' }, // west
    // inner walls face outward
    { fixed: 'z', at: INN + 0.3, from: INN - 2, to: -INN + 2, nx: 0, nz: 1, axis: 'x' },
    { fixed: 'x', at: INN + 0.3, from: -INN + 2, to: INN - 2, nx: 1, nz: 0, axis: 'z' },
    { fixed: 'z', at: -INN - 0.3, from: -INN + 2, to: INN - 2, nx: 0, nz: -1, axis: 'x' },
    { fixed: 'x', at: -INN - 0.3, from: INN - 2, to: -INN + 2, nx: -1, nz: 0, axis: 'z' },
  ];
  for (const s of segs) {
    const len = Math.abs(s.to - s.from);
    const n = Math.floor(len / step);
    const dir = Math.sign(s.to - s.from);
    for (let i = 0; i <= n; i++) {
      const v = s.from + dir * i * step;
      if (s.skipDoor && Math.abs(v) < DOOR_HALF + 2) continue;
      const pos = new THREE.Vector3();
      if (s.axis === 'x') pos.set(v, midY, s.at);
      else pos.set(s.at, midY, v);
      yield { pos, nx: s.nx, nz: s.nz };
    }
  }
}

function hangPaintings(renderer) {
  const it = slots();
  for (let i = 0; i < ARCHIVES.length; i++) {
    const slot = it.next();
    if (slot.done) break;
    const s = slot.value;
    const work = ARCHIVES[i];
    const panel = makeArtPanel({ maxW: 2.4, maxH: 2.4, frameW: 0.1 });
    panel.group.position.copy(s.pos);
    // face along the wall normal
    const yaw = Math.atan2(s.nx, s.nz);
    panel.group.rotation.y = yaw;
    scene.add(panel.group);
    galleryPanels.push({ panel, work, pos: s.pos.clone() });
  }
}

// register interior panels into the shared texture manager (called on enter)
function registerInteriorTextures(tm) {
  if (interiorTM) return; // already registered
  interiorTM = tm;
  for (const gp of galleryPanels) {
    tm.register({
      mesh: gp.panel.art, url: gp.work.thumb, worldPos: gp.pos,
      loadDist: 26, keepDist: 40, maxDim: 0, anisotropy: 8, onSize: gp.panel.onSize,
    });
    addRayTarget({
      mesh: gp.panel.art, tag: 'gallery',
      prompt: `<b>E</b> — ${gp.work.title}`,
      action: () => showViewer({ full: gp.work.full, title: gp.work.title, href: gp.work.full }),
    });
  }
}

// ---------------------------------------------------------------------------
export function galleryActive() { return active; }
export function getGalleryScene() { return active ? scene : null; }

function ensureFade() {
  if (fadeEl) return fadeEl;
  fadeEl = document.createElement('div');
  fadeEl.id = 'fade';
  document.body.appendChild(fadeEl);
  return fadeEl;
}

function enterGallery() {
  const f = ensureFade();
  f.classList.add('on');
  setTimeout(() => {
    active = true;
    // register interior textures with the shared manager on first entry
    if (window.__tm) registerInteriorTextures(window.__tm);
    // drop the player just inside the south door, facing north (into the ring)
    player.set(0, EYE, -OUT + 4);
    heading = 0; pitch = 0; vUp = 0; grounded = true;
    f.classList.remove('on');
  }, 300);
}

export function exitGallery() {
  const f = ensureFade();
  f.classList.add('on');
  setTimeout(() => {
    active = false;
    if (onExitToWorld) onExitToWorld(exitPos);
    f.classList.remove('on');
  }, 300);
}

export function setExitHandler(fn) { onExitToWorld = fn; }

// flat-frame walker + camera, run each frame while inside.
export function updateGallery(dt, t, camera, tm) {
  if (window.__tm !== tm) window.__tm = tm; // stash for lazy interior register
  if (!interiorTM && tm) registerInteriorTextures(tm);

  // mouse look
  heading -= input.mouseX * C.LOOK_SENS;
  pitch -= input.mouseY * C.LOOK_SENS;
  pitch = Math.max(-1.4, Math.min(1.4, pitch));
  input.mouseX = 0; input.mouseY = 0;

  const canMove = !isOverlayOpen();
  _fwd.set(Math.sin(heading), 0, Math.cos(heading));
  _right.set(Math.cos(heading), 0, -Math.sin(heading));
  const f = canMove ? ((input.forward ? 1 : 0) - (input.reverse ? 1 : 0)) : 0;
  const s = canMove ? ((input.right ? 1 : 0) - (input.left ? 1 : 0)) : 0;
  const spd = input.boost ? RUN : SPEED;
  const wishX = (_fwd.x * f + _right.x * s);
  const wishZ = (_fwd.z * f + _right.z * s);
  const wl = Math.hypot(wishX, wishZ) || 1;
  const tvx = (wishX / wl) * spd * (f || s ? 1 : 0);
  const tvz = (wishZ / wl) * spd * (f || s ? 1 : 0);
  // simple velocity (no persistent momentum needed indoors)
  player.x += tvx * dt;
  player.z += tvz * dt;

  // vertical
  if (canMove && input.jump && grounded) { vUp = JUMP; grounded = false; }
  vUp -= GRAV * dt;
  player.y += vUp * dt;
  if (player.y <= EYE) { player.y = EYE; vUp = 0; grounded = true; }

  collideInterior();

  camera.up.set(0, 1, 0);
  camera.position.copy(player);
  const look = new THREE.Vector3(
    Math.sin(heading) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(heading) * Math.cos(pitch)
  );
  camera.lookAt(player.x + look.x, player.y + look.y, player.z + look.z);

  // texture proximity + interaction
  tm.update(player, performance.now());

  // exit prompt near the door, else painting raycast prompt
  const nearDoor = addInteractable_interior && player.distanceTo(addInteractable_interior.pos) < addInteractable_interior.radius && Math.abs(player.x) < DOOR_HALF + 1;
  if (!isOverlayOpen()) {
    // reuse interact ray scan for paintings via world.updateInteractionPrompt;
    // handle door here
    if (nearDoor) showPrompt('<b>E</b> — step back outside');
  }
  window.__galleryNearDoor = nearDoor;
}

// gallery-specific E handler: door exit takes precedence, else painting view.
export function galleryInteract() {
  if (window.__galleryNearDoor) { exitGallery(); return true; }
  const focus = currentFocus();
  if (focus && focus.action) { focus.action(); return true; }
  return false;
}

function collideInterior() {
  const B = OUT - 0.5, I = INN + 0.5, PR = 0.5;
  // keep inside outer box (allow the door gap on -z)
  if (player.x > B - PR) player.x = B - PR;
  if (player.x < -B + PR) player.x = -B + PR;
  if (player.z > B - PR) player.z = B - PR;
  if (player.z < -B + PR) {
    // door gap: allow passing only within the gap width, else block
    if (Math.abs(player.x) > DOOR_HALF) player.z = -B + PR;
    else if (player.z < -OUT - 3) { /* stepped fully out — trigger exit */ exitGallery(); }
  }
  // push out of the inner courtyard block
  if (Math.abs(player.x) < I && Math.abs(player.z) < I) {
    const dx = I - Math.abs(player.x);
    const dz = I - Math.abs(player.z);
    if (dx < dz) player.x += (player.x >= 0 ? dx : -dx);
    else player.z += (player.z >= 0 ? dz : -dz);
  }
}

// no-op hooks referenced by world.js for symmetry
export function enterGalleryFromWorld() { enterGallery(); }
