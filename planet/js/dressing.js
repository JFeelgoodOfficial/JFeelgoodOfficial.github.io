// On-foot surface dressing — instanced wind-swept grass, autumn trees, shrubs,
// and rocks. Ported near-verbatim from Feelgood Space Flight's dressing.js.
// Adaptations for the website: local config.js, the planet doesn't spin so
// makeSite's un-spin collapses to identity (the landing direction IS the
// object-space up), and a `clearings` list keeps foliage out of the zone pads,
// paths, and billboard sightlines.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { C } from './config.js';
import { groundHeight } from './terrain.js';
import { fbm2, mulberry32 } from './noise2.js';

const AUTUMN = {
  gold: new THREE.Color('#d9a13b'),
  amber: new THREE.Color('#c97b2d'),
  rust: new THREE.Color('#a85a24'),
  green: new THREE.Color('#5d7038'),
  deepGreen: new THREE.Color('#40512c'),
};
function mixAutumn(t) {
  const c = new THREE.Color();
  if (t < 0.45) c.copy(AUTUMN.green).lerp(AUTUMN.gold, t / 0.45);
  else if (t < 0.8) c.copy(AUTUMN.gold).lerp(AUTUMN.amber, (t - 0.45) / 0.35);
  else c.copy(AUTUMN.amber).lerp(AUTUMN.rust, (t - 0.8) / 0.2);
  return c;
}

const _d0 = new THREE.Vector3();
const _t1s = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _qAlign = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _dummy = new THREE.Object3D();
const _col = new THREE.Color();
const _wp = new THREE.Vector3();

// Sampling context around the landing direction. No spin: worldUp === object
// space up. `clearings` is [{dir:unit Vector3, r:units}] — placement inside any
// is rejected so structures/paths keep clear ground.
function makeSite(planet, worldUp, clearings) {
  _d0.copy(worldUp).normalize();
  const d0 = _d0.clone();
  const ref = Math.abs(d0.y) < 0.94 ? _yAxis : new THREE.Vector3(1, 0, 0);
  const t1 = new THREE.Vector3().crossVectors(d0, ref).normalize();
  const t2 = new THREE.Vector3().crossVectors(d0, t1).normalize();

  const seaLevel = C.SEA_LEVEL;
  const amp = C.TERRAIN_HEIGHT;
  const radius = planet.radius;

  // Precompute clearing centers as surface points for chord-distance tests.
  const clr = (clearings || []).map((c) => ({
    p: c.dir.clone().normalize().multiplyScalar(radius),
    r2: c.r * c.r,
  }));

  return {
    planet, d0, t1, t2, radius,
    seed: (Math.abs(Math.floor((d0.x * 12.9898 + d0.y * 78.233 + d0.z * 37.719) * 43758.5453)) >>> 0) || 1,
    dirAt(ox, oz, out) {
      out.copy(this.d0)
        .addScaledVector(this.t1, ox / this.radius)
        .addScaledVector(this.t2, oz / this.radius)
        .normalize();
      return out;
    },
    heightAt(dir) {
      return groundHeight(dir.x, dir.y, dir.z, seaLevel, amp);
    },
    depthAt(h) { return Math.max(C.WALK_WATER_LEVEL - h, 0); },
    hasWater: true,
    slopeAt(ox, oz) {
      const e = 2.0;
      const hx1 = this.heightAt(this.dirAt(ox + e, oz, _probe));
      const hx0 = this.heightAt(this.dirAt(ox - e, oz, _probe));
      const hz1 = this.heightAt(this.dirAt(ox, oz + e, _probe));
      const hz0 = this.heightAt(this.dirAt(ox, oz - e, _probe));
      const gx = (hx1 - hx0) / (2 * e);
      const gz = (hz1 - hz0) / (2 * e);
      return Math.sqrt(gx * gx + gz * gz);
    },
    // True if the direction falls inside any clearing (chord distance).
    inClearing(dir) {
      if (clr.length === 0) return false;
      _wp.copy(dir).multiplyScalar(this.radius);
      for (let i = 0; i < clr.length; i++) {
        if (_wp.distanceToSquared(clr[i].p) < clr[i].r2) return true;
      }
      return false;
    },
    pose(dir, h, yOff, yaw, sx, sy, sz) {
      _dummy.position.copy(dir).multiplyScalar(this.radius + h + yOff);
      _qAlign.setFromUnitVectors(_yAxis, dir);
      _qYaw.setFromAxisAngle(_yAxis, yaw);
      _dummy.quaternion.copy(_qAlign).multiply(_qYaw);
      _dummy.scale.set(sx, sy, sz);
      _dummy.updateMatrix();
      return _dummy;
    },
  };
}

function createGrass(site, dress, meshes, disposables) {
  const rand = mulberry32(site.seed ^ 42);
  const geo = new THREE.PlaneGeometry(0.26, 1, 1, 3);
  geo.translate(0, 0.5, 0);
  const p = geo.attributes.position;
  const cols = new Float32Array(p.count * 3);
  const root = new THREE.Color(dress.grass.root);
  const tip = new THREE.Color(dress.grass.tip);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    p.setX(i, p.getX(i) * (1 - y * 0.85));
    _col.copy(root).lerp(tip, y * y);
    cols[i * 3] = _col.r; cols[i * 3 + 1] = _col.g; cols[i * 3 + 2] = _col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.9, side: THREE.DoubleSide,
    emissive: new THREE.Color(dress.grass.emissive), emissiveIntensity: 0.42,
  });
  const timeUniform = { value: 0 };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeUniform;
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        vec4 ip = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float sway = sin(uTime * 1.7 + ip.x * 0.32 + ip.z * 0.41) * 0.6
                   + sin(uTime * 3.3 + ip.x * 0.83 - ip.z * 0.52) * 0.25;
        float bend = transformed.y * transformed.y;
        transformed.x += sway * 0.16 * bend;
        transformed.z += sway * 0.09 * bend;
      }`
    );
  };

  const COUNT = C.DRESS_GRASS;
  const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
  mesh.frustumCulled = false;
  const discR = C.DRESS_RADIUS * 0.68;
  let placed = 0, attempts = 0;
  while (placed < COUNT && attempts < COUNT * 6) {
    attempts++;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * discR;
    const ox = Math.cos(a) * r, oz = Math.sin(a) * r;
    const dir = site.dirAt(ox, oz, _dir);
    const h = site.heightAt(dir);
    if (h < C.WALK_WATER_LEVEL + 0.45) continue;
    if (h > 45) continue;
    if (site.slopeAt(ox, oz) > 0.42) continue;
    if (fbm2(ox * 0.02, oz * 0.02, 2) < -0.55) continue;
    if (site.inClearing(dir)) continue;
    const s = 0.38 + rand() * 0.42;
    mesh.setMatrixAt(placed, site.pose(dir, h, -0.35, rand() * Math.PI, s * (0.9 + rand() * 0.6), s, s).matrix);
    _col.setHSL(0.105 + rand() * 0.03, 0.6 + rand() * 0.2, 0.55 + rand() * 0.2);
    mesh.setColorAt(placed, _col);
    placed++;
  }
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  meshes.push(mesh);
  disposables.push(geo, mat);
  return { timeUniform, mat };
}

function buildTreeGeometry(kind, rand, hueShift) {
  const parts = [];
  const trunkCol = new THREE.Color('#5d4630');
  const trunkCol2 = new THREE.Color('#4b3826');
  const paintColor = (g, col, jitter = 0) => {
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      _col.copy(col);
      if (jitter > 0) _col.offsetHSL(0, 0, (rand() - 0.5) * jitter);
      arr[i * 3] = _col.r; arr[i * 3 + 1] = _col.g; arr[i * 3 + 2] = _col.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  };
  const trunkH = kind === 2 ? 5.2 : 3.6 + rand() * 1.2;
  const trunk = new THREE.CylinderGeometry(0.16, 0.34, trunkH, 7);
  trunk.translate(0, trunkH / 2, 0);
  parts.push(paintColor(trunk, rand() > 0.5 ? trunkCol : trunkCol2));
  const branchN = kind === 2 ? 4 : 3;
  for (let b = 0; b < branchN; b++) {
    const br = new THREE.CylinderGeometry(0.05, 0.12, 1.6 + rand(), 5);
    br.translate(0, 0.8, 0);
    br.rotateZ(0.5 + rand() * 0.6);
    br.rotateY(rand() * Math.PI * 2);
    br.translate(0, trunkH * (0.55 + rand() * 0.3), 0);
    parts.push(paintColor(br, trunkCol2));
  }
  const blob = (r, x, y, z, col) => {
    const g = new THREE.IcosahedronGeometry(r, 1);
    const pp = g.attributes.position;
    for (let i = 0; i < pp.count; i++) {
      const vx = pp.getX(i), vy = pp.getY(i), vz = pp.getZ(i);
      const d = fbm2(vx * 0.9 + x * 7, vz * 0.9 + y * 5, 2) * r * 0.3;
      pp.setXYZ(i, vx + d, vy * 0.82 + d * 0.5, vz + d);
    }
    g.computeVertexNormals();
    g.translate(x, y, z);
    parts.push(paintColor(g, col, 0.09));
  };
  if (kind === 2) {
    const shades = [new THREE.Color('#44582c'), new THREE.Color('#51652f'), new THREE.Color('#3a4c27')];
    for (let i = 0; i < 3; i++) {
      const cone = new THREE.ConeGeometry(2.2 - i * 0.62, 2.6, 8);
      cone.translate(0, trunkH * 0.72 + i * 1.7, 0);
      parts.push(paintColor(cone, shades[i % 3], 0.06));
    }
  } else {
    const baseCol = mixAutumn(kind === 0 ? 0.35 + rand() * 0.3 : 0.68 + rand() * 0.3);
    if (hueShift) baseCol.offsetHSL(hueShift, 0, 0);
    blob(2.3, 0, trunkH + 1.5, 0, baseCol);
    blob(1.7, 1.1, trunkH + 0.8, 0.5, baseCol.clone().offsetHSL(0.015, 0, 0.03));
    blob(1.5, -1.0, trunkH + 1.0, -0.4, baseCol.clone().offsetHSL(-0.015, 0, -0.03));
    if (rand() > 0.4) blob(1.1, 0.2, trunkH + 2.8, 0.2, baseCol.clone().offsetHSL(0.02, 0.05, 0.05));
  }
  const flat = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(flat, false);
  flat.forEach((g, i) => { if (g !== parts[i]) g.dispose(); });
  parts.forEach((g) => g.dispose());
  return merged;
}

function createTrees(site, dress, meshes, disposables) {
  const rand = mulberry32(site.seed ^ 2024);
  const hueShift = dress.treeHueShift || 0;
  const variants = [
    buildTreeGeometry(0, rand, hueShift),
    buildTreeGeometry(1, rand, hueShift),
    buildTreeGeometry(2, rand, hueShift),
  ];
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  const perVariant = C.DRESS_TREES;
  const treeMeshes = variants.map((g) => {
    const m = new THREE.InstancedMesh(g, mat, perVariant);
    m.frustumCulled = false;
    meshes.push(m);
    disposables.push(g);
    return m;
  });
  disposables.push(mat);
  const counts = [0, 0, 0];
  let attempts = 0;
  const target = perVariant * 3;
  let placed = 0;
  while (placed < target && attempts < target * 14) {
    attempts++;
    const a = rand() * Math.PI * 2;
    const r = 18 + Math.sqrt(rand()) * (C.DRESS_RADIUS - 18);
    const ox = Math.cos(a) * r, oz = Math.sin(a) * r;
    const dir = site.dirAt(ox, oz, _dir);
    const h = site.heightAt(dir);
    if (h < C.WALK_WATER_LEVEL + 0.7) continue;
    if (h > 60) continue;
    if (site.slopeAt(ox, oz) > 0.4) continue;
    if (site.inClearing(dir)) continue;
    const forest = fbm2(ox * 0.011 + 7.3, oz * 0.011 - 3.1, 3);
    const isConiferZone = h > 26 || r > C.DRESS_RADIUS * 0.7;
    if (!isConiferZone && forest < 0.08) continue;
    if (isConiferZone && forest < -0.25) continue;
    let kind;
    if (isConiferZone) kind = rand() > 0.35 ? 2 : 0;
    else kind = rand() > 0.72 ? 2 : rand() > 0.5 ? 0 : 1;
    if (counts[kind] >= perVariant) continue;
    const s = (kind === 2 ? 1.1 : 0.9) + rand() * (kind === 2 ? 1.1 : 0.9);
    treeMeshes[kind].setMatrixAt(counts[kind], site.pose(dir, h, -0.4, rand() * Math.PI * 2, s, s * (0.9 + rand() * 0.25), s).matrix);
    const v = 0.82 + rand() * 0.35;
    _col.setRGB(v, v, v);
    treeMeshes[kind].setColorAt(counts[kind], _col);
    counts[kind]++;
    placed++;
  }
  treeMeshes.forEach((m, i) => {
    m.count = counts[i];
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });
}

function createShrubs(site, dress, meshes, disposables) {
  const rand = mulberry32(site.seed ^ 555);
  const geo = new THREE.IcosahedronGeometry(0.7, 1);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
    const d = fbm2(vx * 2.1, vz * 2.1 + 3, 2) * 0.25;
    p.setXYZ(i, vx + d, Math.max(vy * 0.55, -0.1), vz + d);
  }
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ roughness: 1 });
  const COUNT = C.DRESS_SHRUBS;
  const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
  mesh.frustumCulled = false;
  const hueShift = dress.treeHueShift || 0;
  let placed = 0, attempts = 0;
  while (placed < COUNT && attempts < COUNT * 8) {
    attempts++;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * C.DRESS_RADIUS;
    const ox = Math.cos(a) * r, oz = Math.sin(a) * r;
    const dir = site.dirAt(ox, oz, _dir);
    const h = site.heightAt(dir);
    if (h < C.WALK_WATER_LEVEL + 0.5) continue;
    if (h > 55) continue;
    if (site.slopeAt(ox, oz) > 0.45) continue;
    if (site.inClearing(dir)) continue;
    const s = 0.7 + rand() * 1.6;
    mesh.setMatrixAt(placed, site.pose(dir, h, -0.15, rand() * Math.PI * 2, s, s * (0.6 + rand() * 0.5), s).matrix);
    _col.copy(mixAutumn(rand()));
    if (hueShift) _col.offsetHSL(hueShift, 0, 0);
    _col.offsetHSL(0, 0, (rand() - 0.5) * 0.1);
    mesh.setColorAt(placed, _col);
    placed++;
  }
  mesh.count = placed;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  meshes.push(mesh);
  disposables.push(geo, mat);
}

function createRocks(site, dress, meshes, disposables) {
  const rand = mulberry32(site.seed ^ 909);
  const variants = [];
  for (let v = 0; v < 3; v++) {
    const g = new THREE.DodecahedronGeometry(1, 1);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
      const d = fbm2(vx * 1.4 + v * 8, vz * 1.4 - v * 4, 2) * 0.35;
      p.setXYZ(i, vx + d, vy * 0.75 + d * 0.4, vz + d);
    }
    g.computeVertexNormals();
    variants.push(g);
  }
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true });
  disposables.push(mat);
  const tint = dress.rockTint ? new THREE.Color(dress.rockTint) : null;
  const perVariant = C.DRESS_ROCKS;
  variants.forEach((g) => {
    const mesh = new THREE.InstancedMesh(g, mat, perVariant);
    mesh.frustumCulled = false;
    let placed = 0, attempts = 0;
    while (placed < perVariant && attempts < perVariant * 12) {
      attempts++;
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * C.DRESS_RADIUS;
      const ox = Math.cos(a) * r, oz = Math.sin(a) * r;
      const dir = site.dirAt(ox, oz, _dir);
      const h = site.heightAt(dir);
      if (h < C.WALK_WATER_LEVEL - 0.5) continue;
      if (site.slopeAt(ox, oz) > 0.75) continue;
      if (site.inClearing(dir)) continue;
      const s = 0.35 + Math.pow(rand(), 2.2) * 3.4;
      _dummy.position.copy(dir).multiplyScalar(site.radius + h + s * 0.12 - 0.1);
      _qAlign.setFromUnitVectors(_yAxis, dir);
      _qYaw.setFromEuler(new THREE.Euler(rand() * 0.4, rand() * Math.PI * 2, rand() * 0.4));
      _dummy.quaternion.copy(_qAlign).multiply(_qYaw);
      _dummy.scale.set(s * (0.7 + rand() * 0.6), s * (0.55 + rand() * 0.5), s * (0.7 + rand() * 0.6));
      _dummy.updateMatrix();
      mesh.setMatrixAt(placed, _dummy.matrix);
      const gsh = 0.42 + rand() * 0.28;
      _col.setRGB(gsh, gsh * (0.97 + rand() * 0.05), gsh * 0.94);
      if (tint) _col.lerp(tint, 0.45);
      mesh.setColorAt(placed, _col);
      placed++;
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    meshes.push(mesh);
    disposables.push(g);
  });
}

// Spawn dressing around `worldUp` (unit landing direction). `clearings` is an
// array of {dir:unit Vector3, r:units}. Returns { update(t), dispose() }.
export function createDressing(planet, worldUp, clearings) {
  const dress = {
    grass: C.GRASS,
    trees: true,
    shrubs: true,
    rocks: true,
  };
  const site = makeSite(planet, worldUp, clearings);
  const meshes = [];
  const disposables = [];
  let grass = null;

  grass = createGrass(site, dress, meshes, disposables);
  createTrees(site, dress, meshes, disposables);
  createShrubs(site, dress, meshes, disposables);
  createRocks(site, dress, meshes, disposables);

  for (const m of meshes) planet.surface.add(m);

  return {
    update(t) {
      if (grass) grass.timeUniform.value = t;
    },
    dispose() {
      for (const m of meshes) { planet.surface.remove(m); m.dispose(); }
      for (const d of disposables) d.dispose();
      meshes.length = 0;
      disposables.length = 0;
    },
  };
}
