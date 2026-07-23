/**
 * town.js — the permanent city: a warm, purposeful market town draped over the
 * planet's forest/mainland biome. It replaces the old transient "hyper-growth"
 * skyline. Modeled on the concept art (a medieval market town with canals, a
 * waterwheel, market stalls, farms and flower gardens) but ringed by genuinely
 * TALL residential towers whose vertical travel is by working ELEVATOR, not
 * stairs.
 *
 * Coordinate model matches city.js: the returned `group` is parented to
 * planet.surface (unrotated object space); we build in a flat local X/Z frame
 * with +Y = radial up at the landing dir, orient the group so that flat grid
 * bends onto the tangent plane, and drape every element onto the real terrain
 * with sampleGroundLocalY (solves the sphere exactly per local point).
 *
 * The town is fully built and permanent — no growth, no catastrophe. It exposes
 * a crowd host (groundLocalYAt / plazaCenters / collidersLocal), player-solid
 * colliders (world space), enterable structures + elevators for walk.js, and a
 * set of info/elevator interaction points the settlement controller wires up.
 */

import * as THREE from 'three';
import { makeStructure } from './city.js';

const YAXIS = new THREE.Vector3(0, 1, 0);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T = {
  BASE_OFFSET: 0.05,
  SINK: 0.35,
  FOUNDATION: 3.0,
  PLAZA_R: 18,
  CORE_R0: 22, CORE_R1: 56,      // low warm houses live in this band
  TOWER_R0: 70, TOWER_R1: 96,    // tall residential towers ring the outside
  ELEVATOR_SPEED: 7.0,           // units/sec (well under the walker's step-up per frame)
};

// ---- shared canvas textures (built once per town) -------------------------
function warmWindowTexture(rng, warm = '#ffd98a') {
  const cols = 6, rows = 16, cell = 12, pad = 6;
  const w = cols * cell + pad * 2, h = rows * cell + pad * 2;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#161016'; ctx.fillRect(0, 0, w, h);
  for (let r = 0; r < rows; r++) for (let x = 0; x < cols; x++) {
    const lit = rng() < 0.55;
    ctx.fillStyle = lit ? warm : '#241c22';
    ctx.globalAlpha = lit ? 0.9 + rng() * 0.1 : 1;
    ctx.fillRect(pad + x * cell + 1.5, pad + r * cell + 1.5, cell - 3, cell - 3);
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function tiledSoilTexture() {
  const s = 64;
  const c = document.createElement('canvas'); c.width = s; c.height = s;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#5a4230'; ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = '#4a3526'; ctx.lineWidth = 3;
  for (let y = 6; y < s; y += 10) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke(); }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export function createTown(planet, worldUp, opts = {}) {
  const radius = opts.radius ?? 150;
  const seed = opts.seed ?? 1;
  const rng = mulberry32(seed >>> 0);

  const group = new THREE.Group();
  group.name = 'PermanentTown';

  // A warm hemisphere fill so the town reads at the dim space-ambient budget.
  group.add(new THREE.HemisphereLight(0xbcd0ff, 0x3a2a1c, 0.85));

  // ---- orient + place on the surface (ported from city.js) ----------------
  const dirSeeded = worldUp.clone().normalize();
  const rotY = planet.surface?.rotation?.y ?? 0;
  const dirLocal = dirSeeded.clone().applyAxisAngle(YAXIS, -rotY);
  const quat = new THREE.Quaternion().setFromUnitVectors(YAXIS, dirLocal);
  group.quaternion.copy(quat);

  const groundBase = planet.body?.groundAtLocal ? planet.body.groundAtLocal(dirLocal) : 0;
  let baseRadius = (planet.radius ?? 800) + groundBase + T.BASE_OFFSET;
  if (planet.water?.r && baseRadius < planet.water.r + 0.4) baseRadius = planet.water.r + 0.4;
  group.position.copy(dirLocal.clone().multiplyScalar(baseRadius));

  const _wp = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  function sampleGroundLocalY(lx, lz) {
    _wp.set(lx, 0, lz).applyQuaternion(quat).add(group.position);
    _dir.copy(_wp).normalize();
    const h = planet.body?.groundAtLocal ? planet.body.groundAtLocal(_dir) : 0;
    const planetR = planet.radius ?? 800;
    let rr = planetR + h;
    if (planet.water?.r) rr = Math.max(rr, planet.water.r + 0.4);
    const d2 = lx * lx + lz * lz;
    return Math.sqrt(Math.max(rr * rr - d2, 0)) - baseRadius - T.SINK;
  }

  const _q = group.quaternion.clone();
  const _pos = group.position.clone();
  function localToWorld(v) { return v.clone().applyQuaternion(_q).add(_pos); }

  // ---- collectors ---------------------------------------------------------
  const colliders = [];        // local flat {x,z,radius} — player-solid (world-converted by controller)
  const collidersLocal = [];   // {x,z,radius} — crowd avoidance
  const waypoints = [];        // {x,z} — crowd wander targets
  const structures = [];       // makeStructure contracts for walk.js floors/walls
  const elevators = [];        // dynamic lift controllers
  const infoPoints = [];       // {local:Vector3, radius, prompt, kind}
  const roleAnchors = {};      // role -> {x,z} (dialogue/wander flavor)
  const updaters = [];         // per-frame animators (waterwheel, banners)

  function addCollider(x, z, r) { colliders.push({ x, z, radius: r }); collidersLocal.push({ x, z, radius: r }); }

  // shared materials
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0xb8a488, roughness: 0.9, metalness: 0.0 });
  const timberMat = new THREE.MeshStandardMaterial({ color: 0x6e4a2e, roughness: 0.85 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x9c3b26, roughness: 0.7 });
  const plasterMat = new THREE.MeshStandardMaterial({ color: 0xe6dcc4, roughness: 0.9 });
  const waterMat = new THREE.MeshStandardMaterial({ color: 0x2f6f8f, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.82 });
  const soilTex = tiledSoilTexture();

  const _m = new THREE.Matrix4();
  const _dm = new THREE.Object3D();

  function place(mesh, x, y, z, ry = 0) { mesh.position.set(x, y, z); mesh.rotation.y = ry; group.add(mesh); return mesh; }

  // -------------------------------------------------------------------------
  // Plaza + central town hall (bell tower)
  // -------------------------------------------------------------------------
  const plazaY = sampleGroundLocalY(0, 0);
  const plaza = new THREE.Mesh(new THREE.CylinderGeometry(T.PLAZA_R, T.PLAZA_R + 1.5, 0.6, 40),
    new THREE.MeshStandardMaterial({ color: 0xcdbfa2, roughness: 0.95 }));
  place(plaza, 0, plazaY + 0.05, 0);
  waypoints.push({ x: 0, z: 0 }, { x: 8, z: 6 }, { x: -8, z: 6 }, { x: 6, z: -8 });

  // town hall a little north of the plaza
  {
    const hx = 0, hz = -T.PLAZA_R - 8;
    const gy = sampleGroundLocalY(hx, hz);
    const hall = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(20, 12, 14), stoneMat);
    base.position.y = 6; hall.add(base);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(15, 6, 4), roofMat);
    roof.position.y = 15; roof.rotation.y = Math.PI / 4; hall.add(roof);
    // bell tower
    const tower = new THREE.Mesh(new THREE.BoxGeometry(5, 26, 5), stoneMat);
    tower.position.set(0, 13, -4); hall.add(tower);
    const spire = new THREE.Mesh(new THREE.ConeGeometry(3.6, 8, 4), roofMat);
    spire.position.set(0, 30, -4); spire.rotation.y = Math.PI / 4; hall.add(spire);
    const flag = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3, 0.2),
      new THREE.MeshStandardMaterial({ color: 0xf5b642, emissive: 0xf5b642, emissiveIntensity: 0.3 }));
    flag.position.set(0, 35, -4); hall.add(flag);
    place(hall, hx, gy, hz);
    addCollider(hx, hz, 12);
    roleAnchors.caretaker = { x: hx, z: hz + 9 };
    waypoints.push({ x: hx, z: hz + 11 });
    infoPoints.push({ local: new THREE.Vector3(hx, gy + 2, hz + 11), radius: 6, prompt: 'Town Hall', kind: 'townhall' });
  }

  // -------------------------------------------------------------------------
  // Warm low core houses
  // -------------------------------------------------------------------------
  const houseCount = 26;
  for (let i = 0; i < houseCount; i++) {
    const ang = rng() * Math.PI * 2;
    const rr = THREE.MathUtils.lerp(T.CORE_R0, T.CORE_R1, rng());
    const x = Math.cos(ang) * rr, z = Math.sin(ang) * rr;
    const gy = sampleGroundLocalY(x, z);
    const w = 6 + rng() * 4, d = 6 + rng() * 4, hgt = 6 + rng() * 5;
    const ry = rng() * Math.PI * 2;
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, d), rng() < 0.5 ? plasterMat : timberMat);
    wall.position.y = hgt / 2 + T.FOUNDATION / 2 - T.FOUNDATION / 2;
    const house = new THREE.Group(); house.add(wall);
    const foundation = new THREE.Mesh(new THREE.BoxGeometry(w, T.FOUNDATION, d), stoneMat);
    foundation.position.y = -T.FOUNDATION / 2; house.add(foundation);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.75, 3.5 + rng() * 1.5, 4), roofMat);
    roof.position.y = hgt + 1.4; roof.rotation.y = Math.PI / 4; house.add(roof);
    place(house, x, gy, z, ry);
    addCollider(x, z, Math.max(w, d) * 0.5 + 0.4);
  }

  // -------------------------------------------------------------------------
  // Canal + rotating waterwheel (a nod to the concept art)
  // -------------------------------------------------------------------------
  {
    const canal = new THREE.Group();
    const segs = 7;
    for (let i = 0; i < segs; i++) {
      const t = i / (segs - 1);
      const cx = THREE.MathUtils.lerp(-60, 60, t);
      const cz = Math.sin(t * Math.PI) * 26 + 30;
      const gy = sampleGroundLocalY(cx, cz);
      const water = new THREE.Mesh(new THREE.BoxGeometry(18, 0.5, 8), waterMat);
      water.position.set(cx, gy - 0.4, cz); water.rotation.y = t * 0.4; canal.add(water);
      const bank = new THREE.Mesh(new THREE.BoxGeometry(19, 1.2, 1.5), stoneMat);
      bank.position.set(cx, gy + 0.1, cz + 4.6); canal.add(bank);
      const bank2 = bank.clone(); bank2.position.z = cz - 4.6; canal.add(bank2);
    }
    group.add(canal);
    // waterwheel beside the canal
    const wwX = -40, wwZ = 46;
    const wy = sampleGroundLocalY(wwX, wwZ);
    const wheel = new THREE.Group();
    const rim = new THREE.Mesh(new THREE.TorusGeometry(5, 0.5, 8, 24), timberMat);
    wheel.add(rim);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const paddle = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.3, 3.2), timberMat);
      paddle.position.set(Math.cos(a) * 4.6, Math.sin(a) * 4.6, 0);
      paddle.rotation.z = a; wheel.add(paddle);
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.3, 9.2, 0.3), timberMat);
      spoke.rotation.z = a; wheel.add(spoke);
    }
    wheel.position.set(wwX, wy + 4.6, wwZ);
    wheel.rotation.y = Math.PI / 2;
    group.add(wheel);
    const mill = new THREE.Mesh(new THREE.BoxGeometry(8, 9, 8), plasterMat);
    place(mill, wwX - 6, wy + 4.5, wwZ);
    addCollider(wwX - 6, wwZ, 5);
    updaters.push((dt) => { wheel.rotation.x += dt * 0.6; });
  }

  // -------------------------------------------------------------------------
  // Market stalls + market building (merchant anchor)
  // -------------------------------------------------------------------------
  const awningColors = [0xc94f4f, 0x4f7fc9, 0x4faf6a, 0xd9a441, 0x8a5fbf];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const rr = T.PLAZA_R + 4 + (i % 2) * 3;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    const gy = sampleGroundLocalY(x, z);
    const stall = new THREE.Group();
    for (const sx of [-2, 2]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 3, 6), timberMat);
      post.position.set(sx, 1.5, 0); stall.add(post);
    }
    const counter = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1, 1.4), timberMat);
    counter.position.y = 1; stall.add(counter);
    const awning = new THREE.Mesh(new THREE.BoxGeometry(5, 0.2, 2.4),
      new THREE.MeshStandardMaterial({ color: awningColors[i % awningColors.length], roughness: 0.8 }));
    awning.position.y = 3; awning.rotation.x = -0.2; stall.add(awning);
    place(stall, x, gy, z, a + Math.PI / 2);
    waypoints.push({ x, z });
  }
  {
    // dedicated market hall
    const mx = T.PLAZA_R + 14, mz = 4;
    const gy = sampleGroundLocalY(mx, mz);
    const hall = new THREE.Mesh(new THREE.BoxGeometry(14, 8, 10), plasterMat);
    place(hall, mx, gy + 4, mz);
    const roof = place(new THREE.Mesh(new THREE.BoxGeometry(15, 1, 11), roofMat), mx, gy + 8.5, mz);
    addCollider(mx, mz, 8);
    roleAnchors.merchant = { x: mx, z: mz + 7 };
    waypoints.push({ x: mx, z: mz + 7 });
    infoPoints.push({ local: new THREE.Vector3(mx, gy + 2, mz + 7), radius: 6, prompt: 'Market', kind: 'market' });
  }

  // -------------------------------------------------------------------------
  // Bakery + perfumery (artisan anchors)
  // -------------------------------------------------------------------------
  function craftBuilding(x, z, color, kind, label, role) {
    const gy = sampleGroundLocalY(x, z);
    const b = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(9, 8, 9), plasterMat);
    body.position.y = 4; b.add(body);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(7.5, 4, 4), roofMat);
    roof.position.y = 10; roof.rotation.y = Math.PI / 4; b.add(roof);
    const sign = new THREE.Mesh(new THREE.BoxGeometry(3, 1.4, 0.3),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.6 }));
    sign.position.set(0, 6, 4.7); b.add(sign);
    place(b, x, gy, z);
    addCollider(x, z, 6);
    roleAnchors[role] = roleAnchors[role] || { x, z: z + 6 };
    waypoints.push({ x, z: z + 6 });
    infoPoints.push({ local: new THREE.Vector3(x, gy + 2, z + 6), radius: 6, prompt: label, kind });
  }
  craftBuilding(-T.PLAZA_R - 16, 12, 0xe0a24a, 'bakery', 'Bakery', 'artisan');
  craftBuilding(-T.PLAZA_R - 16, -14, 0xbf6ad9, 'perfumery', 'Perfumery', 'artisan');

  // -------------------------------------------------------------------------
  // Farm district (tilled rows + instanced crops), seasonal-tinted
  // -------------------------------------------------------------------------
  const cropMat = new THREE.MeshStandardMaterial({ color: 0xc9b23a, roughness: 0.8 });
  {
    const fx0 = 78, fz0 = -40; // farm center (+X, -Z quadrant, outside the tower ring gap)
    const plotW = 22, plotD = 16, plotsX = 3, plotsZ = 2;
    const cropGeo = new THREE.ConeGeometry(0.4, 1.6, 5);
    const perPlot = 60;
    const cropMesh = new THREE.InstancedMesh(cropGeo, cropMat, plotsX * plotsZ * perPlot);
    let ci = 0;
    for (let px = 0; px < plotsX; px++) for (let pz = 0; pz < plotsZ; pz++) {
      const cx = fx0 + (px - 1) * (plotW + 4);
      const cz = fz0 + (pz - 0.5) * (plotD + 4);
      const gy = sampleGroundLocalY(cx, cz);
      const soil = new THREE.Mesh(new THREE.BoxGeometry(plotW, 0.4, plotD),
        new THREE.MeshStandardMaterial({ map: soilTex.clone(), roughness: 1.0 }));
      soil.material.map.repeat.set(4, 3);
      place(soil, cx, gy + 0.1, cz);
      for (let k = 0; k < perPlot; k++) {
        const rx = cx + (rng() - 0.5) * (plotW - 2);
        const rz = cz + (rng() - 0.5) * (plotD - 2);
        _dm.position.set(rx, sampleGroundLocalY(rx, rz) + 0.8, rz);
        _dm.scale.set(1, 0.7 + rng() * 0.6, 1);
        _dm.rotation.set(0, rng() * Math.PI, 0);
        _dm.updateMatrix();
        cropMesh.setMatrixAt(ci++, _dm.matrix);
      }
      waypoints.push({ x: cx, z: cz });
    }
    cropMesh.instanceMatrix.needsUpdate = true;
    cropMesh.frustumCulled = false;
    group.add(cropMesh);
    roleAnchors.farmer = { x: fx0, z: fz0 };
    // a barn
    const by = sampleGroundLocalY(fx0, fz0 + 26);
    const barn = new THREE.Mesh(new THREE.BoxGeometry(12, 8, 10), timberMat);
    place(barn, fx0, by + 4, fz0 + 26);
    const barnRoof = place(new THREE.Mesh(new THREE.ConeGeometry(9, 4, 4), roofMat), fx0, by + 10, fz0 + 26);
    barnRoof.rotation.y = Math.PI / 4;
    addCollider(fx0, fz0 + 26, 7);
    // expose the crop material so the controller can retint it with the season
    group.userData.cropMat = cropMat;
  }

  // -------------------------------------------------------------------------
  // Garden district (instanced colorful flowers) — feeds bloom_points
  // -------------------------------------------------------------------------
  {
    const gx0 = -78, gz0 = -40;
    const flowerColors = [0xe0587f, 0xe8c14a, 0x8a5fd0, 0xef7f4f, 0xffffff, 0x6ab0e0];
    const bedW = 22, bedD = 16, bedsX = 3, bedsZ = 2, perBed = 80;
    const petalGeo = new THREE.SphereGeometry(0.35, 6, 5);
    const stemGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.9, 4);
    const stemMat = new THREE.MeshStandardMaterial({ color: 0x3f7a3a, roughness: 0.8 });
    const total = bedsX * bedsZ * perBed;
    const petalMesh = new THREE.InstancedMesh(petalGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }), total);
    petalMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3);
    const stemMesh = new THREE.InstancedMesh(stemGeo, stemMat, total);
    let fi = 0; const col = new THREE.Color();
    for (let bx = 0; bx < bedsX; bx++) for (let bz = 0; bz < bedsZ; bz++) {
      const cx = gx0 + (bx - 1) * (bedW + 4);
      const cz = gz0 + (bz - 0.5) * (bedD + 4);
      const gy = sampleGroundLocalY(cx, cz);
      const bed = new THREE.Mesh(new THREE.BoxGeometry(bedW, 0.5, bedD),
        new THREE.MeshStandardMaterial({ color: 0x4a3526, roughness: 1 }));
      place(bed, cx, gy + 0.15, cz);
      const border = new THREE.Mesh(new THREE.BoxGeometry(bedW + 1, 0.7, bedD + 1),
        new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.9 }));
      place(border, cx, gy + 0.1, cz);
      for (let k = 0; k < perBed; k++) {
        const rx = cx + (rng() - 0.5) * (bedW - 2);
        const rz = cz + (rng() - 0.5) * (bedD - 2);
        const fy = sampleGroundLocalY(rx, rz);
        _dm.position.set(rx, fy + 0.45, rz); _dm.scale.set(1, 1, 1); _dm.rotation.set(0, 0, 0);
        _dm.updateMatrix(); stemMesh.setMatrixAt(fi, _dm.matrix);
        _dm.position.set(rx, fy + 1.0, rz); _dm.updateMatrix(); petalMesh.setMatrixAt(fi, _dm.matrix);
        col.set(flowerColors[Math.floor(rng() * flowerColors.length)]);
        petalMesh.setColorAt(fi, col);
        fi++;
      }
      waypoints.push({ x: cx, z: cz });
    }
    petalMesh.instanceMatrix.needsUpdate = true;
    petalMesh.instanceColor.needsUpdate = true;
    stemMesh.instanceMatrix.needsUpdate = true;
    petalMesh.frustumCulled = false; stemMesh.frustumCulled = false;
    group.add(stemMesh, petalMesh);
    roleAnchors.gardener = { x: gx0, z: gz0 };
    infoPoints.push({ local: new THREE.Vector3(gx0, sampleGroundLocalY(gx0, gz0) + 2, gz0 + 10), radius: 8, prompt: 'Flower Gardens', kind: 'gardens' });
  }

  // -------------------------------------------------------------------------
  // Tall residential tower ring — a few enterable, with working elevators
  // -------------------------------------------------------------------------
  const towerCount = 12;
  const enterableEvery = 4; // towers 0,4,8 get an elevator + observation deck
  const winTex = warmWindowTexture(rng);
  for (let i = 0; i < towerCount; i++) {
    const a = (i / towerCount) * Math.PI * 2 + 0.12;
    const rr = THREE.MathUtils.lerp(T.TOWER_R0, T.TOWER_R1, rng());
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    const gy = sampleGroundLocalY(x, z);
    const w = 10 + rng() * 4, d = 10 + rng() * 4;
    const hgt = THREE.MathUtils.lerp(42, 80, rng());
    const enterable = i % enterableEvery === 0;

    const tower = new THREE.Group();
    const bodyTex = winTex.clone(); bodyTex.needsUpdate = true;
    bodyTex.repeat.set(Math.max(2, Math.round(w / 4)), Math.max(6, Math.round(hgt / 5)));
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x8f8a7e, roughness: 0.8,
      map: bodyTex, emissive: 0xffca73, emissiveMap: bodyTex, emissiveIntensity: 0.5,
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, hgt + T.FOUNDATION, d), bodyMat);
    body.position.y = (hgt + T.FOUNDATION) / 2 - T.FOUNDATION; tower.add(body);
    // a red-tile crown so the towers still feel of-a-piece with the town
    const crown = new THREE.Mesh(new THREE.BoxGeometry(w + 1.5, 2, d + 1.5), roofMat);
    crown.position.y = hgt; tower.add(crown);
    place(tower, x, gy, z, a);
    addCollider(x, z, Math.max(w, d) * 0.5 + 0.5);

    if (enterable) {
      buildElevatorTower(x, z, gy, a, w, d, hgt);
    }
  }

  // Build an exterior elevator running up the plaza-facing side of a tower to a
  // railed observation deck near the top. The car is a dynamic walkable surface;
  // the deck is a static one. Two call points let the player ride up/down.
  function buildElevatorTower(x, z, gy, a, w, d, hgt) {
    // face toward the plaza (town center)
    const inward = Math.atan2(-z, -x);
    const off = Math.max(w, d) * 0.5 + 2.4;
    const ex = x + Math.cos(inward) * off;
    const ez = z + Math.sin(inward) * off;
    const baseY = sampleGroundLocalY(ex, ez);
    const deckY = gy + hgt - 6;
    const half = 2.2;

    // rails/guides up the face (visual)
    const guideMat = new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.6, metalness: 0.5 });
    for (const sx of [-half, half]) {
      const gx = ex + Math.cos(inward + Math.PI / 2) * sx;
      const gz = ez + Math.sin(inward + Math.PI / 2) * sx;
      const guide = new THREE.Mesh(new THREE.BoxGeometry(0.35, hgt, 0.35), guideMat);
      place(guide, gx, baseY + hgt / 2, gz);
    }

    // observation deck (static walkable slab + railings) at the top
    const deck = new THREE.Group();
    const slab = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 4, 0.4, half * 2 + 4), stoneMat);
    slab.position.y = deckY; deck.add(slab);
    const railMat = new THREE.MeshStandardMaterial({ color: 0x9a7a4a, roughness: 0.7 });
    for (let s = 0; s < 4; s++) {
      const rr = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 4, 1, 0.2), railMat);
      const ra = (s / 4) * Math.PI * 2;
      rr.position.set(ex + Math.cos(ra) * (half + 2), deckY + 1, ez + Math.sin(ra) * (half + 2));
      rr.rotation.y = ra; deck.add(rr);
    }
    // position deck contents around (ex,ez): slab already centered at deckY but
    // we placed it at local 0; move the group to (ex,0,ez)
    slab.position.set(ex, deckY, ez);
    group.add(deck);
    // deck as a static structure (world-drape handled: local Y is deckY)
    structures.push(makeStructure(ex, ez, deckY, [{ x0: -half - 2, x1: half + 2, z0: -half - 2, z1: half + 2, y: 0 }], [], half + 2));

    // the car
    const carMat = new THREE.MeshStandardMaterial({ color: 0xcaa46a, roughness: 0.6, metalness: 0.2 });
    const car = new THREE.Group();
    const floor = new THREE.Mesh(new THREE.BoxGeometry(half * 2, 0.3, half * 2), carMat);
    car.add(floor);
    const cage = new THREE.Mesh(new THREE.BoxGeometry(half * 2, 3, half * 2),
      new THREE.MeshStandardMaterial({ color: 0xf5b642, transparent: true, opacity: 0.18 }));
    cage.position.y = 1.5; car.add(cage);
    car.position.set(ex, baseY, ez);
    group.add(car);

    let carY = baseY, targetY = baseY;
    const lift = {
      callTop() { targetY = deckY; },
      callBottom() { targetY = baseY; },
      // dynamic walkable-surface contract in city-local space
      surfaceYAt(px, pz, feetY) {
        const dx = px - ex, dz = pz - ez;
        if (Math.abs(dx) > half + 0.3 || Math.abs(dz) > half + 0.3) return null;
        if (carY <= feetY + 0.7) return carY; // catch only when at/under the feet
        return null;
      },
      resolveWalls() { return false; }, // open lift
      update(dt) {
        const dy = targetY - carY;
        if (Math.abs(dy) > 0.001) {
          const step = Math.sign(dy) * Math.min(Math.abs(dy), T.ELEVATOR_SPEED * dt);
          carY += step;
          car.position.y = carY;
        }
      },
    };
    structures.push(lift);
    elevators.push(lift);

    // call points: at the base (ride up) and on the deck (ride down)
    infoPoints.push({ local: new THREE.Vector3(ex, baseY + 1, ez), radius: 3.2, prompt: 'Ride the elevator up', kind: 'elevator-up', lift });
    infoPoints.push({ local: new THREE.Vector3(ex, deckY + 1, ez), radius: 3.6, prompt: 'Ride the elevator down', kind: 'elevator-down', lift });
    waypoints.push({ x: ex, z: ez });
  }

  // -------------------------------------------------------------------------
  // Street lamps for warmth
  // -------------------------------------------------------------------------
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffdf9a, emissive: 0xffcf7a, emissiveIntensity: 1.4 });
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const rr = T.PLAZA_R + 3;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    const gy = sampleGroundLocalY(x, z);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 5, 6), timberMat);
    place(post, x, gy + 2.5, z);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6), lampMat);
    place(lamp, x, gy + 5.2, z);
  }

  // -------------------------------------------------------------------------
  // update / dispose
  // -------------------------------------------------------------------------
  function update(dt, t, night) {
    for (const fn of updaters) fn(dt, t);
    for (const el of elevators) el.update(dt);
  }

  function dispose() {
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { if (m.map) m.map.dispose(); if (m.emissiveMap && m.emissiveMap !== m.map) m.emissiveMap.dispose(); m.dispose(); }
      }
      if (o.isInstancedMesh) o.dispose();
    });
    group.clear();
  }

  return {
    group, update, dispose,
    quaternion: group.quaternion,
    position: group.position,
    localToWorld,
    colliders,           // local {x,z,radius} — controller converts to world for walk.addCollider
    collidersLocal,      // {x,z,radius} — crowd host
    plazaCenters: waypoints,
    groundLocalYAt: sampleGroundLocalY,
    structures,          // includes elevators (dynamic) + decks (static)
    elevators,
    infoPoints,          // {local, radius, prompt, kind, lift?}
    roleAnchors,
    center: dirLocal.clone(),
  };
}
