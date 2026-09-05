// The gallery building: two windowless wings either side of an open court,
// a loggia terrace at the west end and a bare deck at the east, all on one
// stone plinth above the sea. Everything is boxes, cylinders and planes with
// the procedural materials from materials.js. Also emits the collision boxes
// (walker.js), the hanging slots for art.js, the compass points, and the
// light fixtures. Metres; +x runs west→east; the wings are centred on z = 0.
//
// Fixtures are emitted as plain data, not as scene lights: a small pool of
// real PointLights follows the visitor and is aimed at the nearest of them
// (lights.js), because every light actually in the scene costs another
// unrolled GGX evaluation in every lit fragment shader.

import * as THREE from 'three';
import { C, PLAN, TERRACE_HALF_Z, COURT_SOUTH_Z, DECK_HALF_Z } from './config.js';
import { addBox, addArea } from './walker.js';
import { makeLettering } from './art.js';

const HW = C.WING_HALF_W, T = C.WALL_T, H = C.WING_H, RT = C.ROOF_T;
const DOOR_W = 4, DOOR_H = 4.2;

// world-space UV so a shared material tiles at `tile` metres everywhere
function uvWorld(geo, tile, axisU = 'x', axisV = 'z') {
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  const ai = { x: 0, y: 1, z: 2 };
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, pos.getComponent(i, ai[axisU]) / tile, pos.getComponent(i, ai[axisV]) / tile);
  }
  uv.needsUpdate = true;
}

export function buildBuilding(scene, mats) {
  const root = new THREE.Group();
  root.name = 'building';
  scene.add(root);

  const slots = { archive: [], featured: [], selfwork: [] };
  const fixtures = []; // ceiling/deck light fixtures as data (see lights.js)
  const glow = []; // meshes whose emissive follows the sky (clerestory strips)
  const floors = []; // reflective floors (excluded from the reflection pass)

  // --- helpers -------------------------------------------------------------
  function box(w, h, d, x, y, z, mat, o = {}) {
    const geo = new THREE.BoxGeometry(w, h, d);
    if (o.tile) uvWorldBox(geo, o.tile, x, y, z);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = o.cast ?? true;
    m.receiveShadow = o.receive ?? true;
    root.add(m);
    if (o.collide !== false) addBox(x - w / 2, x + w / 2, z - d / 2, z + d / 2, o.y1 !== undefined ? { y1: o.y1 } : {});
    return m;
  }
  // box UVs in world space per face so plaster/stone tiles continue across boxes
  function uvWorldBox(geo, tile, cx, cy, cz) {
    const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i));
      const x = pos.getX(i) + cx, y = pos.getY(i) + cy, z = pos.getZ(i) + cz;
      if (nx > 0.5) uv.setXY(i, z / tile, y / tile);
      else if (ny > 0.5) uv.setXY(i, x / tile, z / tile);
      else uv.setXY(i, x / tile, y / tile);
    }
    uv.needsUpdate = true;
  }
  // A horizontal slab. `down` flips the normal for ceilings — the rotation has
  // to happen before the translate, or the plane is mirrored through the origin.
  function floor(x0, x1, z0, z1, mat, tile, y = 0, reflective = false, down = false) {
    const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
    geo.rotateX(down ? Math.PI / 2 : -Math.PI / 2);
    geo.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
    uvWorld(geo, tile);
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    root.add(m);
    if (reflective) floors.push(m);
    return m;
  }
  // a wall along x at depth z (thickness T), from x0..x1, with optional door gaps
  function wallX(x0, x1, z, gaps = []) {
    const segs = cut(x0, x1, gaps);
    for (const [a, b] of segs) box(b - a, H, T, (a + b) / 2, H / 2, z, mats.plaster, { tile: 4 });
    for (const [a, b] of gaps) box(b - a, H - DOOR_H, T, (a + b) / 2, DOOR_H + (H - DOOR_H) / 2, z, mats.plaster, { tile: 4, collide: false });
  }
  function wallZ(z0, z1, x, gaps = []) {
    const segs = cut(z0, z1, gaps);
    for (const [a, b] of segs) box(T, H, b - a, x, H / 2, (a + b) / 2, mats.plaster, { tile: 4 });
    for (const [a, b] of gaps) box(T, H - DOOR_H, b - a, x, DOOR_H + (H - DOOR_H) / 2, (a + b) / 2, mats.plaster, { tile: 4, collide: false });
  }
  function cut(a0, a1, gaps) {
    const out = []; let cur = a0;
    for (const [g0, g1] of gaps.slice().sort((p, q) => p[0] - q[0])) { if (g0 > cur) out.push([cur, g0]); cur = g1; }
    if (cur < a1) out.push([cur, a1]);
    return out;
  }
  function column(x, z, h, r = 0.22, mat = mats.plaster) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 20), mat);
    m.position.set(x, h / 2, z);
    m.castShadow = true; m.receiveShadow = true;
    root.add(m);
    addBox(x - r, x + r, z - r, z + r);
    return m;
  }
  function railing(x0, x1, z0, z1) {
    // glass balustrade with a steel handrail; thin so it barely obstructs the view
    const along = Math.abs(x1 - x0) > Math.abs(z1 - z0) ? 'x' : 'z';
    const len = along === 'x' ? x1 - x0 : z1 - z0;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const g = new THREE.Mesh(new THREE.BoxGeometry(along === 'x' ? len : 0.03, 1.05, along === 'x' ? 0.03 : len), mats.glass);
    g.position.set(cx, 0.55, cz); root.add(g);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(along === 'x' ? len : 0.08, 0.06, along === 'x' ? 0.08 : len), mats.steel);
    rail.position.set(cx, 1.1, cz); rail.castShadow = true; root.add(rail);
    const n = Math.max(2, Math.round(len / 2.4));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const px = along === 'x' ? x0 + t * len : cx, pz = along === 'z' ? z0 + t * len : cz;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.08, 0.05), mats.blackSteel);
      post.position.set(px, 0.54, pz); root.add(post);
    }
    addBox(along === 'x' ? x0 : cx - 0.2, along === 'x' ? x1 : cx + 0.2, along === 'z' ? z0 : cz - 0.2, along === 'z' ? z1 : cz + 0.2);
  }
  function bench(x, z, alongX = true) {
    const w = alongX ? 2.4 : 0.48, d = alongX ? 0.48 : 2.4;
    const seat = new THREE.Mesh(new THREE.BoxGeometry(w, 0.09, d), mats.oak);
    uvWorldBox(seat.geometry, 1.2, x, 0.45, z);
    seat.position.set(x, 0.45, z); seat.castShadow = true; seat.receiveShadow = true; root.add(seat);
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(alongX ? 0.06 : 0.42, 0.4, alongX ? 0.42 : 0.06), mats.blackSteel);
      leg.position.set(x + (alongX ? s * 1.0 : 0), 0.2, z + (alongX ? 0 : s * 1.0)); leg.castShadow = true; root.add(leg);
    }
    addBox(x - w / 2, x + w / 2, z - d / 2, z + d / 2);
  }
  function fixture(x, y, z, intensity, color = 0xfff1dc, range = 26) {
    const f = { x, y, z, intensity, color, range };
    fixtures.push(f);
    return f;
  }
  function lightStrip(x0, x1, z, y, w = 0.22, mat = mats.lightStrip) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.06, w), mat);
    s.position.set((x0 + x1) / 2, y, z);
    root.add(s);
    return s;
  }
  function sign(text, x, y, z, yaw, size, o = {}) {
    const m = makeLettering(text, { size, ...o });
    m.position.set(x, y, z);
    m.rotation.y = yaw;
    root.add(m);
    return m;
  }

  // --- plinth and sea edge ---------------------------------------------------
  const PX0 = PLAN.terrace.x0 - 2, PX1 = PLAN.deck.x1 + 2;
  const PZ0 = Math.min(COURT_SOUTH_Z, -TERRACE_HALF_Z, -DECK_HALF_Z) - 2.5;
  const PZ1 = Math.max(HW + T, TERRACE_HALF_Z, DECK_HALF_Z) + 2.5;
  const plinth = box(PX1 - PX0, 0 - C.SEA_Y + 0.6, PZ1 - PZ0, (PX0 + PX1) / 2, (C.SEA_Y - 0.6) / 2, (PZ0 + PZ1) / 2, mats.stoneWall, { tile: 4, collide: false, cast: false });
  plinth.position.y = (C.SEA_Y - 0.6 + 0) / 2 - 0.02; // top just under the floors
  // a stepped lower ledge so the headland reads as masonry, not a floating slab
  box(PX1 - PX0 + 6, 1.2, PZ1 - PZ0 + 6, (PX0 + PX1) / 2, C.SEA_Y + 0.2, (PZ0 + PZ1) / 2, mats.stoneWall, { tile: 4, collide: false, cast: false });

  // --- the two wings ---------------------------------------------------------
  const wings = [PLAN.west, PLAN.east];
  for (const w of wings) {
    const { x0, x1 } = w;
    const isWest = w === PLAN.west;
    // floor + ceiling
    floor(x0, x1, -HW, HW, mats.concreteFloor, 6, 0, true);
    const ceil = floor(x0, x1, -HW, HW, mats.ceiling, 8, H, false, true);
    ceil.receiveShadow = false;
    // side walls (solid, windowless)
    wallX(x0 - T, x1 + T, HW + T / 2, []);
    wallX(x0 - T, x1 + T, -(HW + T / 2), []);
    // end walls with offset doorways (no straight sightline through the wing)
    const dW = isWest ? [1, 1 + DOOR_W] : [1, 1 + DOOR_W];       // west door of this wing
    const dE = [-1 - DOOR_W, -1];                                  // east door of this wing
    wallZ(-(HW + T), HW + T, x0 - T / 2, [dW]);
    wallZ(-(HW + T), HW + T, x1 + T / 2, [dE]);
    // roof slab
    box(x1 - x0 + 2 * T, RT, 2 * (HW + T), (x0 + x1) / 2, H + RT / 2, 0, mats.plaster, { tile: 4, collide: false });
    // spine partition, freestanding, lower than the ceiling
    const sx0 = x0 + 12, sx1 = x1 - 12, SH = 4.3;
    box(sx1 - sx0, SH, 0.6, (sx0 + sx1) / 2, SH / 2, 0, mats.plaster, { tile: 4 });
    // light coves: two long warm strips, and a cool clerestory band that takes the sky's colour
    lightStrip(x0 + 1, x1 - 1, 4.1, H - 0.08);
    lightStrip(x0 + 1, x1 - 1, -4.1, H - 0.08);
    for (const s of [-1, 1]) {
      const band = lightStrip(x0 + 1, x1 - 1, s * (HW - 0.02), H - 0.55, 0.05, mats.lightStripCool.clone());
      band.rotation.x = Math.PI / 2; band.scale.set(1, 1, 8); // a 0.4 m glowing band along the wall top
      glow.push(band);
    }
    // Ceiling fixtures in pairs down the corridor. The wings are sealed — the
    // sky environment is turned right down on the indoor materials
    // (materials.js) and these carry the room instead.
    for (let x = x0 + 6; x < x1 - 3; x += C.WING_LIGHT_STEP) {
      fixture(x, H - 1.2, 3.6, C.WING_LIGHT_I, 0xfff1dc, C.WING_LIGHT_RANGE);
      fixture(x, H - 1.2, -3.6, C.WING_LIGHT_I, 0xfff1dc, C.WING_LIGHT_RANGE);
    }
    // benches
    for (let x = x0 + 22; x < x1 - 12; x += 26) { bench(x, 3.6); bench(x + 13, -3.6); }
    // track spots (fixtures only) along both walls and the spine
    trackSpots(x0 + 2.5, x1 - 2.5, [HW - 1.7, -(HW - 1.7), 1.4, -1.4]);

    // --- archive slots, in walking order ---
    const step2 = C.SLOT_STEP;
    for (let x = x0 + 2.6; x <= x1 - 2.6; x += step2) slots.archive.push({ x, z: HW, yaw: Math.PI });         // north wall, faces -z
    for (let x = x1 - 2.6; x >= x0 + 2.6; x -= step2) slots.archive.push({ x, z: -HW, yaw: 0 });               // south wall, faces +z
    for (let x = sx0 + 1.6; x <= sx1 - 1.6; x += step2) slots.archive.push({ x, z: 0.3, yaw: 0 });              // spine north face
    for (let x = sx1 - 1.6; x >= sx0 + 1.6; x -= step2) slots.archive.push({ x, z: -0.3, yaw: Math.PI });       // spine south face
    // end walls beside the doors
    slots.archive.push({ x: x0, z: -4.4, yaw: Math.PI / 2 }, { x: x0, z: -1.6, yaw: Math.PI / 2 });
    slots.archive.push({ x: x1, z: 4.4, yaw: -Math.PI / 2 }, { x: x1, z: 1.6, yaw: -Math.PI / 2 });

    // room name over the inner side of each door
    sign(isWest ? 'THE ARCHIVES  ·  2004 – 2013' : 'THE ARCHIVES  ·  2014 – 2025', x0 + 0.05, DOOR_H + 0.8, 3, Math.PI / 2, 0.55, { px: 110, tracking: 6 });
    sign(isWest ? 'SUNSET COURT  →' : 'STAR DECK  →', x1 - 0.05, DOOR_H + 0.8, -3, -Math.PI / 2, 0.5, { px: 110, tracking: 6 });

    addArea(x0 - 1.2, x1 + 1.2, -HW, HW);
  }

  function trackSpots(x0, x1, zs) {
    const n = Math.floor((x1 - x0) / C.SLOT_STEP) + 1;
    const geo = new THREE.CylinderGeometry(0.055, 0.07, 0.2, 12);
    const inst = new THREE.InstancedMesh(geo, mats.blackSteel, n * zs.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
    let i = 0;
    for (const z of zs) {
      const tilt = new THREE.Euler(0, 0, z > 0 ? -0.55 : 0.55);
      q.setFromEuler(tilt);
      for (let k = 0; k < n; k++) { p.set(x0 + k * C.SLOT_STEP, H - 0.22, z); m.compose(p, q, s); inst.setMatrixAt(i++, m); }
    }
    inst.count = i;
    root.add(inst);
  }

  // --- sunrise terrace (west) -----------------------------------------------
  {
    const { x0, x1 } = PLAN.terrace;
    // the terrace paving stops at the wing's west wall — the wing floor takes
    // over from there, so the two slabs meet edge to edge instead of overlapping
    floor(x0, x1, -TERRACE_HALF_Z, TERRACE_HALF_Z, mats.stone, 4, 0, true);
    // loggia: the wing roof carries on 9 m over the terrace on slim columns
    const cx0 = x1 - 9.5;
    box(x1 - T - cx0, RT, 2 * (HW + T) + 10, (cx0 + x1 - T) / 2, H + RT / 2, 0, mats.plaster, { tile: 4, collide: false });
    for (const z of [-12.5, 0, 12.5]) column(cx0 + 0.6, z, H);
    // two freestanding "sunrise walls" under the loggia carry the featured works, facing the sea
    const wx = cx0 + 3.2, WH = 4.6;
    for (const [z0, z1] of [[-12.3, -2.5], [2.5, 12.3]]) {
      box(0.5, WH, z1 - z0, wx, WH / 2, (z0 + z1) / 2, mats.plaster, { tile: 4 });
    }
    // five featured works on the sea-facing (-x) faces; the low sunrise sun
    // lights them straight on while the visitor stands with the sea behind them
    slots.featured.push({ x: wx - 0.25, z: -9.0, yaw: -Math.PI / 2 }, { x: wx - 0.25, z: -5.0, yaw: -Math.PI / 2 });
    slots.featured.push({ x: wx - 0.25, z: 4.1, yaw: -Math.PI / 2 }, { x: wx - 0.25, z: 7.4, yaw: -Math.PI / 2 }, { x: wx - 0.25, z: 10.7, yaw: -Math.PI / 2 });
    // rear faces: title lettering + a bench
    sign('JFEELGOOD', wx + 0.27, 3.6, -7.4, Math.PI / 2, 0.9, { px: 150, tracking: 22 });
    sign('Art, as an experience.', wx + 0.27, 2.6, -7.4, Math.PI / 2, 0.5, { px: 90, color: '#6a625a' });
    bench(x0 + 12, 0, false);
    bench(x0 + 12, 9, false);
    bench(x0 + 12, -9, false);
    // glass balustrade around the drop
    railing(x0, x0, -TERRACE_HALF_Z, TERRACE_HALF_Z);
    railing(x0, x1 - T, -TERRACE_HALF_Z, -TERRACE_HALF_Z);
    railing(x0, x1 - T, TERRACE_HALF_Z, TERRACE_HALF_Z);
    // the wing's outer faces beyond its width close the terrace's inner edge
    for (const s of [-1, 1]) box(T, 1.1, TERRACE_HALF_Z - HW - T, x1 - T / 2, 0.55, s * (HW + T + (TERRACE_HALF_Z - HW - T) / 2), mats.stoneWall, { tile: 4 });
    // the walkable terrace ends at the wing's west wall; the wing's own area
    // overlaps it by 1.2 m so the doorway threshold is inside both
    addArea(x0, x1 - T / 2, -TERRACE_HALF_Z, TERRACE_HALF_Z);
    // low deck lights so the terrace still reads before the sun clears the water
    fixture(x0 + 20, 3.5, -10, 18, 0xffd9b0, 22);
    fixture(x0 + 20, 3.5, 10, 18, 0xffd9b0, 22);
  }

  // --- sunset court (middle) ---------------------------------------------------
  {
    const { x0, x1 } = PLAN.court;
    // the paving is laid in four pieces around the pool so the sunk basin is
    // not covered by its own floor
    const px0 = x0 + 8, px1 = x1 - 8, pz0 = -13, pz1 = -8;
    const hx0 = px0 - 0.4, hx1 = px1 + 0.4, hz0 = pz0 - 0.4, hz1 = pz1 + 0.4;
    floor(x0, x1, COURT_SOUTH_Z, hz0, mats.stone, 4, 0, true);
    floor(x0, x1, hz1, HW + T, mats.stone, 4, 0, true);
    floor(x0, hx0, hz0, hz1, mats.stone, 4, 0, true);
    floor(hx1, x1, hz0, hz1, mats.stone, 4, 0, true);
    // north wall continues between the wings (butting their side walls), with a
    // deep canopy over the Self Work works
    wallX(x0 + T, x1 - T, HW + T / 2, []);
    box(x1 - x0 - 2 * T, RT, 5.2, (x0 + x1) / 2, H + RT / 2, HW + T - 2.6, mats.plaster, { tile: 4, collide: false });
    // beam linking the two wings along the court's south edge, on slim columns
    box(x1 - x0 - 2 * T, 0.6, 0.5, (x0 + x1) / 2, H - 0.3, -(HW + T / 2), mats.plaster, { tile: 4, collide: false });
    for (const x of [x0 + 8, x0 + 20, x0 + 32]) column(x, -(HW + T / 2), H - 0.6, 0.24);
    // stone curb around the pool
    box(px1 - px0 + 0.8, 0.12, 0.4, (px0 + px1) / 2, 0.06, pz0 - 0.2, mats.stoneWall, { tile: 4 });
    box(px1 - px0 + 0.8, 0.12, 0.4, (px0 + px1) / 2, 0.06, pz1 + 0.2, mats.stoneWall, { tile: 4 });
    box(0.4, 0.12, pz1 - pz0, px0 - 0.2, 0.06, (pz0 + pz1) / 2, mats.stoneWall, { tile: 4 });
    box(0.4, 0.12, pz1 - pz0, px1 + 0.2, 0.06, (pz0 + pz1) / 2, mats.stoneWall, { tile: 4 });
    const basin = new THREE.Mesh(new THREE.BoxGeometry(px1 - px0, 0.5, pz1 - pz0), new THREE.MeshStandardMaterial({ color: 0x1b232a, roughness: 0.6 }));
    basin.position.set((px0 + px1) / 2, -0.25, (pz0 + pz1) / 2); root.add(basin);
    addBox(px0, px1, pz0, pz1); // you can't walk on water
    // Self Work slots on the north wall, facing the sunset
    const n = 8, span = x1 - x0 - 6;
    for (let i = 0; i < n; i++) slots.selfwork.push({ x: x0 + 3 + (i + 0.5) * (span / n), z: HW, yaw: Math.PI });
    sign('SELF WORK  ·  2021', (x0 + x1) / 2, 5.4, HW - 0.02, Math.PI, 0.6, { px: 110, tracking: 8 });
    // south balustrade over the sea and the returns to the wings
    railing(x0, x1, COURT_SOUTH_Z, COURT_SOUTH_Z);
    railing(x0, x0, COURT_SOUTH_Z, -(HW + T));
    railing(x1, x1, COURT_SOUTH_Z, -(HW + T));
    bench(x0 + 6, -3, false);
    bench(x1 - 6, -3, false);
    // the court proper, plus a threshold rectangle at each wing door (the wings'
    // own areas reach 1.2 m into the court, so the two always overlap)
    addArea(x0, x1, COURT_SOUTH_Z, HW);
    addArea(x0 - 1.2, x0 + 1.2, -5.4, -0.6);
    addArea(x1 - 1.2, x1 + 1.2, 0.6, 5.4);
    fixture((x0 + x1) / 2, H - 0.4, HW - 1.5, 26, 0xffd0a0, 30);
  }

  // --- star deck (east) ------------------------------------------------------
  const cases = [];
  {
    const { x0, x1 } = PLAN.deck;
    floor(x0, x1, -DECK_HALF_Z, DECK_HALF_Z, mats.stone, 4, 0, true);
    railing(x1, x1, -DECK_HALF_Z, DECK_HALF_Z);
    railing(x0 + T, x1, -DECK_HALF_Z, -DECK_HALF_Z);
    railing(x0 + T, x1, DECK_HALF_Z, DECK_HALF_Z);
    for (const s of [-1, 1]) box(T, 1.1, DECK_HALF_Z - HW - T, x0 + T / 2, 0.55, s * (HW + T + (DECK_HALF_Z - HW - T) / 2), mats.stoneWall, { tile: 4 });
    // three lit display cases: books, the collectible cards, other worlds
    const prop = (geo, mat, x, y, z, ry = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.rotation.y = ry;
      m.castShadow = true; m.receiveShadow = true;
      root.add(m);
      return m;
    };
    const mk = (x, z, label) => {
      const base = box(1.6, 0.9, 1.0, x, 0.45, z, mats.blackSteel, {});
      const top = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.9, 0.9), mats.glass);
      top.position.set(x, 1.35, z); root.add(top);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.03, 0.8), mats.lightStrip);
      strip.position.set(x, 0.92, z); root.add(strip);
      fixture(x, 1.6, z, 6, 0xfff0dc, 8);
      // something to actually look at under the glass
      if (label === 'books') {
        for (let i = 0; i < 2; i++) {
          const w = 0.3, h = 0.05, d = 0.42;
          prop(new THREE.BoxGeometry(w, h, d), mats.bookCloth, x - 0.24 + i * 0.48, 0.965 + i * 0.001, z, i ? 0.18 : -0.12);
          prop(new THREE.BoxGeometry(w - 0.03, h * 0.7, d - 0.03), mats.pages, x - 0.24 + i * 0.48, 0.965 + i * 0.001, z, i ? 0.18 : -0.12);
        }
      } else if (label === 'collect') {
        for (let i = 0; i < 3; i++) {
          const card = prop(new THREE.BoxGeometry(0.16, 0.24, 0.012), mats.pages, x - 0.4 + i * 0.4, 1.07, z - 0.05, -0.25 + i * 0.25);
          card.rotation.x = -0.22;
        }
      } else {
        prop(new THREE.BoxGeometry(0.26, 0.5, 0.26), mats.blackSteel, x, 1.19, z, 0.5);
        prop(new THREE.SphereGeometry(0.13, 20, 14), mats.steel, x, 1.58, z);
      }
      cases.push({ x, z, y: 1.3, label, base });
      return base;
    };
    mk(x0 + 14, -7, 'books');
    mk(x0 + 14, 7, 'collect');
    mk(x0 + 27, 0, 'worlds');
    bench(x0 + 8, 0, false);
    // low path lights along the balustrades
    for (let x = x0 + 4; x < x1; x += 8) for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.1), mats.blackSteel);
      post.position.set(x, 0.25, s * (DECK_HALF_Z - 0.7)); root.add(post);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.04, 0.12), mats.lightStripCool);
      cap.position.set(x, 0.52, s * (DECK_HALF_Z - 0.7)); root.add(cap);
    }
    fixture(x0 + 10, 3.5, 0, 22, 0xd8e2ff, 30);
    fixture(x0 + 28, 3.5, 0, 22, 0xd8e2ff, 30);
    sign('STAR DECK', x0 + T + 0.05, DOOR_H + 0.8, -3, Math.PI / 2, 0.55, { px: 110, tracking: 10, color: '#e9e4d8' });
    addArea(x0 + T / 2, x1, -DECK_HALF_Z, DECK_HALF_Z);
  }

  return { root, slots, fixtures, glow, floors, cases };
}
