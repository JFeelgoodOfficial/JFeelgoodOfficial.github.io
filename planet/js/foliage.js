// Streaming, biome-aware foliage that follows whoever is exploring — on foot or
// in a vehicle. The static dressing (dressing.js) only covers a 240-unit bubble
// around spawn; vehicles cross the whole 800-radius planet, so this module keeps
// a fixed-capacity set of InstancedMeshes and re-scatters their instances around
// the current centre whenever it moves past a threshold. Each candidate point is
// classified by biomes.js, so you drive from lush forest into open desert into
// bare highland and the ground cover changes with you. Instance COUNTS are fixed
// (no per-move geometry rebuilds), so the cost of a re-stream is just writing
// matrices.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { C } from './config.js';
import { groundHeight } from './terrain.js';
import { biomeAt } from './biomes.js';
import { mulberry32 } from './noise2.js';
import { exclusionBlocks } from './layout.js';

const WATER = C.WALK_WATER_LEVEL;
const R_BIG = 420;     // scatter radius for trees / cacti / rocks (units)
const R_GRASS = 150;   // scatter radius for grass tufts
const RESTREAM = 55;   // re-scatter once the centre has moved this far
const INNER = C.DRESS_RADIUS * 0.85; // keep clear of the static spawn dressing

const CAP = { broadleaf: 150, pine: 150, cactus: 90, rock: 150, grass: 3200 };

const _dir = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _qA = new THREE.Quaternion();
const _qY = new THREE.Quaternion();
const _dummy = new THREE.Object3D();
const _col = new THREE.Color();
const _spawn = new THREE.Vector3();
const _sp = new THREE.Vector3();

function paint(geo, col, jitter, rand) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    _col.copy(col);
    if (jitter) _col.offsetHSL(0, 0, (rand() - 0.5) * jitter);
    arr[i * 3] = _col.r; arr[i * 3 + 1] = _col.g; arr[i * 3 + 2] = _col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

// --- geometry builders (built once, instanced many) ---
function broadleafGeo(rand) {
  const parts = [];
  const trunkH = 3.4 + rand() * 1.4;
  const trunk = new THREE.CylinderGeometry(0.18, 0.36, trunkH, 7);
  trunk.translate(0, trunkH / 2, 0);
  parts.push(paint(trunk, new THREE.Color('#5a4327'), 0, rand));
  const leaf = new THREE.Color('#3f6a2c');
  const blob = (r, x, y, z, c) => {
    const g = new THREE.IcosahedronGeometry(r, 1);
    g.translate(x, y, z);
    parts.push(paint(g, c, 0.1, rand));
  };
  blob(2.2, 0, trunkH + 1.4, 0, leaf);
  blob(1.6, 1.1, trunkH + 0.7, 0.4, leaf.clone().offsetHSL(0.02, 0, 0.03));
  blob(1.5, -1.0, trunkH + 0.9, -0.4, leaf.clone().offsetHSL(-0.02, 0, -0.02));
  const flat = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(flat, false);
  parts.forEach((g) => g.dispose());
  return merged;
}
function pineGeo(rand) {
  const parts = [];
  const trunkH = 5.0 + rand() * 1.5;
  const trunk = new THREE.CylinderGeometry(0.14, 0.3, trunkH, 6);
  trunk.translate(0, trunkH / 2, 0);
  parts.push(paint(trunk, new THREE.Color('#4b3826'), 0, rand));
  const shades = [new THREE.Color('#31502a'), new THREE.Color('#3c5c2f'), new THREE.Color('#2b471f')];
  for (let i = 0; i < 3; i++) {
    const cone = new THREE.ConeGeometry(2.1 - i * 0.6, 2.6, 8);
    cone.translate(0, trunkH * 0.62 + i * 1.7, 0);
    parts.push(paint(cone, shades[i], 0.06, rand));
  }
  const flat = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(flat, false);
  parts.forEach((g) => g.dispose());
  return merged;
}
function cactusGeo(rand) {
  const parts = [];
  const skin = new THREE.Color('#4e7a3a');
  const body = new THREE.CylinderGeometry(0.5, 0.6, 4.2, 9);
  body.translate(0, 2.1, 0);
  parts.push(paint(body, skin, 0.05, rand));
  const arm = (sx) => {
    const a = new THREE.CylinderGeometry(0.28, 0.32, 1.8, 8);
    a.rotateZ(sx * 1.2); a.translate(sx * 0.7, 2.0, 0);
    const up = new THREE.CylinderGeometry(0.28, 0.3, 1.3, 8);
    up.translate(sx * 1.15, 2.9, 0);
    parts.push(paint(a, skin, 0.05, rand), paint(up, skin, 0.05, rand));
  };
  arm(1); if (rand() > 0.4) arm(-1);
  const flat = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(flat, false);
  parts.forEach((g) => g.dispose());
  return merged;
}
function rockGeo(rand) {
  const g = new THREE.DodecahedronGeometry(1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
    const d = (rand() - 0.5) * 0.5;
    p.setXYZ(i, vx + d, vy * 0.72 + d * 0.4, vz + d);
  }
  g.computeVertexNormals();
  return g;
}

function makeInstanced(geo, cap, matOpts) {
  const mat = new THREE.MeshStandardMaterial(Object.assign({ vertexColors: true, roughness: 0.95 }, matOpts || {}));
  const m = new THREE.InstancedMesh(geo, mat, cap);
  m.frustumCulled = false;
  m.count = 0;
  return m;
}

export function buildFoliage(planet, spawnDir) {
  _spawn.copy(spawnDir).normalize();
  _sp.copy(_spawn).multiplyScalar(planet.radius);
  const seaLevel = C.SEA_LEVEL, amp = C.TERRAIN_HEIGHT, radius = planet.radius;
  const gRand = mulberry32(20240722);

  const broadleaf = makeInstanced(broadleafGeo(gRand), CAP.broadleaf);
  const pine = makeInstanced(pineGeo(gRand), CAP.pine);
  const cactus = makeInstanced(cactusGeo(gRand), CAP.cactus);
  const rock = makeInstanced(rockGeo(gRand), CAP.rock, { flatShading: true, roughness: 0.95 });

  // grass tuft (a swept blade card, wind handled in the vertex shader)
  const gGeo = new THREE.PlaneGeometry(0.26, 1, 1, 3);
  gGeo.translate(0, 0.5, 0);
  const gp = gGeo.attributes.position;
  for (let i = 0; i < gp.count; i++) gp.setX(i, gp.getX(i) * (1 - gp.getY(i) * 0.85));
  const grassMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide, emissive: new THREE.Color('#8f7a2a'), emissiveIntensity: 0.3 });
  const timeU = { value: 0 };
  grassMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = timeU;
    sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>',
      `#include <begin_vertex>
      { vec4 ip = instanceMatrix * vec4(0.0,0.0,0.0,1.0);
        float sway = sin(uTime*1.7 + ip.x*0.3 + ip.z*0.4)*0.6 + sin(uTime*3.1 + ip.x*0.8 - ip.z*0.5)*0.25;
        float bend = transformed.y*transformed.y;
        transformed.x += sway*0.16*bend; transformed.z += sway*0.09*bend; }`);
  };
  const grass = new THREE.InstancedMesh(gGeo, grassMat, CAP.grass);
  grass.frustumCulled = false; grass.count = 0;

  const meshes = [broadleaf, pine, cactus, rock, grass];
  for (const m of meshes) planet.surface.add(m);

  // tangent basis around an arbitrary centre direction
  const t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), c0 = new THREE.Vector3();
  function basis(centreDir) {
    c0.copy(centreDir).normalize();
    const ref = Math.abs(c0.y) < 0.94 ? _yAxis : new THREE.Vector3(1, 0, 0);
    t1.crossVectors(c0, ref).normalize();
    t2.crossVectors(c0, t1).normalize();
  }
  function dirAt(ox, oz, out) {
    return out.copy(c0).addScaledVector(t1, ox / radius).addScaledVector(t2, oz / radius).normalize();
  }
  function heightAt(dir) { return groundHeight(dir.x, dir.y, dir.z, seaLevel, amp); }
  function slope(ox, oz) {
    const e = 2.2;
    const h = (a, b) => heightAt(dirAt(a, b, _dir));
    const gx = (h(ox + e, oz) - h(ox - e, oz)) / (2 * e);
    const gz = (h(ox, oz + e) - h(ox, oz - e)) / (2 * e);
    return Math.hypot(gx, gz);
  }
  function farFromSpawn(dir) {
    _dummy.position.copy(dir).multiplyScalar(radius);
    return _dummy.position.distanceTo(_sp) > INNER;
  }
  function setPose(mesh, idx, dir, h, yOff, yaw, sx, sy, sz, tint) {
    _dummy.position.copy(dir).multiplyScalar(radius + h + yOff);
    _qA.setFromUnitVectors(_yAxis, dir);
    _qY.setFromAxisAngle(_yAxis, yaw);
    _dummy.quaternion.copy(_qA).multiply(_qY);
    _dummy.scale.set(sx, sy, sz);
    _dummy.updateMatrix();
    mesh.setMatrixAt(idx, _dummy.matrix);
    if (tint) mesh.setColorAt(idx, tint);
  }

  const counts = { broadleaf: 0, pine: 0, cactus: 0, rock: 0, grass: 0 };
  let lastCentre = null;

  function restream(centreDir, rand) {
    basis(centreDir);
    counts.broadleaf = counts.pine = counts.cactus = counts.rock = counts.grass = 0;

    // big scatter: trees, cacti, rocks
    const attempts = 2200;
    for (let i = 0; i < attempts; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * R_BIG;
      const ox = Math.cos(a) * r, oz = Math.sin(a) * r;
      const dir = dirAt(ox, oz, _dir);
      const h = heightAt(dir);
      if (h < WATER + 0.6) continue;
      if (!farFromSpawn(dir)) continue;
      if (exclusionBlocks(dir)) continue;
      if (slope(ox, oz) > 0.5) continue;
      const b = biomeAt(dir);

      if (b.desert > 0.45 && counts.cactus < CAP.cactus) {
        if (rand() < 0.12 * b.desert) {
          const s = 0.7 + rand() * 0.7;
          setPose(cactus, counts.cactus++, dir, h, -0.2, rand() * 6.28, s, s * (0.9 + rand() * 0.5), s, whiten(rand));
          continue;
        }
      }
      // rocks in desert + alpine
      if ((b.desert > 0.35 || b.alpine > 0.4) && counts.rock < CAP.rock && rand() < 0.14) {
        const s = 0.4 + Math.pow(rand(), 2) * 3.0;
        _col.setRGB(0.5, 0.47, 0.42);
        if (b.desert > 0.4) _col.setRGB(0.68, 0.56, 0.36);
        setPose(rock, counts.rock++, dir, h, s * 0.1 - 0.1, rand() * 6.28, s, s * 0.75, s, _col.clone());
        continue;
      }
      // pines in forest highlands + alpine fringe
      const pineChance = 0.16 * b.forest + 0.1 * b.alpine;
      const leafChance = 0.2 * b.forest + 0.03 * b.plains;
      if (h < 46 && counts.pine < CAP.pine && rand() < pineChance) {
        const s = 0.9 + rand() * 0.8;
        setPose(pine, counts.pine++, dir, h, -0.4, rand() * 6.28, s, s * (0.9 + rand() * 0.3), s, whiten(rand));
      } else if (h < 42 && counts.broadleaf < CAP.broadleaf && rand() < leafChance) {
        const s = 0.85 + rand() * 0.7;
        setPose(broadleaf, counts.broadleaf++, dir, h, -0.4, rand() * 6.28, s, s * (0.9 + rand() * 0.3), s, whiten(rand));
      }
    }

    // grass: dense in forest/plains, none in desert/alpine
    const gAtt = 5200;
    for (let i = 0; i < gAtt && counts.grass < CAP.grass; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * R_GRASS;
      const ox = Math.cos(a) * r, oz = Math.sin(a) * r;
      const dir = dirAt(ox, oz, _dir);
      const h = heightAt(dir);
      if (h < WATER + 0.5 || h > 44) continue;
      if (!farFromSpawn(dir)) continue;
      if (exclusionBlocks(dir)) continue;
      if (slope(ox, oz) > 0.45) continue;
      const b = biomeAt(dir);
      const cover = b.forest + b.plains * 0.7;
      if (cover < 0.25 || rand() > cover) continue;
      const s = 0.4 + rand() * 0.5;
      // green in forest, golden on the plains
      _col.setHSL(0.18 + 0.08 * b.forest + rand() * 0.03, 0.5, 0.42 + rand() * 0.15);
      setPose(grass, counts.grass++, dir, h, -0.35, rand() * 3.14, s * (0.9 + rand() * 0.5), s, s, _col.clone());
    }

    for (const [m, key] of [[broadleaf, 'broadleaf'], [pine, 'pine'], [cactus, 'cactus'], [rock, 'rock'], [grass, 'grass']]) {
      m.count = counts[key];
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  function whiten(rand) { const v = 0.82 + rand() * 0.35; return _col.setRGB(v, v, v).clone(); }

  return {
    update(centreWorld, t) {
      timeU.value = t;
      if (!centreWorld) return;
      _dir.copy(centreWorld).normalize();
      if (lastCentre && _dir.distanceTo(lastCentre) * radius < RESTREAM) return;
      if (!lastCentre) lastCentre = new THREE.Vector3();
      lastCentre.copy(_dir);
      // seed by a coarse cell so a given locale regenerates identically
      const seed = ((Math.floor(_dir.x * 40) * 73856093) ^ (Math.floor(_dir.y * 40) * 19349663) ^ (Math.floor(_dir.z * 40) * 83492791)) >>> 0;
      restream(_dir, mulberry32(seed || 1));
    },
    dispose() {
      for (const m of meshes) { planet.surface.remove(m); m.geometry.dispose(); m.material.dispose(); }
      meshes.length = 0;
    },
  };
}
