// First-person walker on a flat floor with axis-aligned box collision. The
// player is a circle in the xz plane; walls, plinths and benches register as
// boxes and the walker slides along them. Reads the shared `input` singleton
// (keyboard/mouse in input.js, thumbstick/drag in touch.js).

import * as THREE from 'three';
import { C } from './config.js';
import { input } from './input.js';

export const walker = {
  pos: new THREE.Vector3(0, C.EYE, 0),
  vel: new THREE.Vector3(),
  heading: 0, // yaw: 0 looks down +z, +PI/2 looks down +x
  pitch: 0,
  vUp: 0,
  grounded: true,
  frozen: false, // overlays freeze movement (look still works so the cursor can be released)
};

// colliders: { x0, x1, z0, z1 } in world xz, optionally { y1 } (walk-under height)
const boxes = [];
export function addBox(x0, x1, z0, z1, opts = {}) {
  const b = { x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1), ...opts };
  boxes.push(b);
  return b;
}
export function clearBoxes() { boxes.length = 0; }

// walkable bounds: a list of rectangles; the player must stay inside their union
const areas = [];
export function addArea(x0, x1, z0, z1) { areas.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1) }); }

export function spawn(x, z, heading = 0, pitch = 0) {
  walker.pos.set(x, C.EYE, z);
  walker.vel.set(0, 0, 0);
  walker.heading = heading;
  walker.pitch = pitch;
  walker.vUp = 0;
  walker.grounded = true;
}

const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _wish = new THREE.Vector3();

export function stepWalker(dt) {
  // look
  walker.heading -= input.mouseX * C.LOOK_SENS;
  walker.pitch -= input.mouseY * C.LOOK_SENS;
  walker.pitch = Math.max(-C.MAX_PITCH, Math.min(C.MAX_PITCH, walker.pitch));
  input.mouseX = 0; input.mouseY = 0;

  const canMove = !walker.frozen;
  _fwd.set(Math.sin(walker.heading), 0, Math.cos(walker.heading));
  // right = fwd × up: was (cos h, 0, -sin h), which is actually the LEFT
  // vector for this heading convention (checked against how heading responds
  // to mouseX above) — that's why strafe-right/the stick's right side moved
  // the walker to their left. Negated to the true right-hand side.
  _right.set(-Math.cos(walker.heading), 0, Math.sin(walker.heading));
  let f = 0, s = 0;
  if (canMove) {
    if (input.analog) { f = input.moveY; s = input.moveX; }
    else { f = (input.forward ? 1 : 0) - (input.reverse ? 1 : 0); s = (input.right ? 1 : 0) - (input.left ? 1 : 0); }
  }
  _wish.set(0, 0, 0).addScaledVector(_fwd, f).addScaledVector(_right, s);
  const mag = Math.min(1, _wish.length());
  if (mag > 1e-4) _wish.multiplyScalar(1 / _wish.length());
  const speed = (input.boost ? C.RUN_SPEED : C.WALK_SPEED) * mag;
  // accelerate toward the wish velocity (gives a little weight to starts/stops)
  const tx = _wish.x * speed, tz = _wish.z * speed;
  const a = C.ACCEL * dt;
  walker.vel.x += Math.max(-a, Math.min(a, tx - walker.vel.x));
  walker.vel.z += Math.max(-a, Math.min(a, tz - walker.vel.z));

  walker.pos.x += walker.vel.x * dt;
  walker.pos.z += walker.vel.z * dt;

  // vertical (a small hop; the floor is flat)
  if (canMove && input.jump && walker.grounded) { walker.vUp = C.JUMP; walker.grounded = false; }
  walker.vUp -= C.GRAVITY * dt;
  walker.pos.y += walker.vUp * dt;
  if (walker.pos.y <= C.EYE) { walker.pos.y = C.EYE; walker.vUp = 0; walker.grounded = true; }

  collide();
}

function collide() {
  const p = walker.pos, r = C.PLAYER_RADIUS;
  const feet = p.y - C.EYE;
  // boxes: push out along the axis of least penetration
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.y1 !== undefined && feet > b.y1) continue;
    if (p.x + r <= b.x0 || p.x - r >= b.x1 || p.z + r <= b.z0 || p.z - r >= b.z1) continue;
    const dxL = p.x + r - b.x0, dxR = b.x1 - (p.x - r);
    const dzL = p.z + r - b.z0, dzR = b.z1 - (p.z - r);
    const m = Math.min(dxL, dxR, dzL, dzR);
    if (m === dxL) p.x = b.x0 - r;
    else if (m === dxR) p.x = b.x1 + r;
    else if (m === dzL) p.z = b.z0 - r;
    else p.z = b.z1 + r;
  }
  // keep inside the union of walkable areas: if outside all, snap to nearest
  if (areas.length) {
    let inside = false;
    for (const a of areas) {
      if (p.x >= a.x0 + r && p.x <= a.x1 - r && p.z >= a.z0 + r && p.z <= a.z1 - r) { inside = true; break; }
    }
    if (!inside) {
      let best = null, bd = Infinity, bx = 0, bz = 0;
      for (const a of areas) {
        const cx = Math.max(a.x0 + r, Math.min(a.x1 - r, p.x));
        const cz = Math.max(a.z0 + r, Math.min(a.z1 - r, p.z));
        const d = (cx - p.x) ** 2 + (cz - p.z) ** 2;
        if (d < bd) { bd = d; best = a; bx = cx; bz = cz; }
      }
      if (best) { p.x = bx; p.z = bz; }
    }
  }
}

const _look = new THREE.Vector3();
export function updateCamera(camera) {
  camera.up.set(0, 1, 0);
  camera.position.copy(walker.pos);
  _look.set(
    Math.sin(walker.heading) * Math.cos(walker.pitch),
    Math.sin(walker.pitch),
    Math.cos(walker.heading) * Math.cos(walker.pitch)
  );
  camera.lookAt(walker.pos.x + _look.x, walker.pos.y + _look.y, walker.pos.z + _look.z);
}

export function lookDir(out) {
  return out.set(
    Math.sin(walker.heading) * Math.cos(walker.pitch),
    Math.sin(walker.pitch),
    Math.cos(walker.heading) * Math.cos(walker.pitch)
  );
}
