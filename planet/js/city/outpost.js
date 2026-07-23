/**
 * outpost.js — a small, persistent science outpost for the non-mainland biomes
 * (desert / alpine / plains). Replaces the old transient biome cities: instead
 * of a civilisation that rises and falls, each far biome now holds a handful of
 * scientists studying the terrain from a compact research station (a dome, a
 * dish antenna, solar panels, sensor masts and supply crates). Nothing grows,
 * nothing is destroyed.
 *
 * Same coordinate model as town.js/city.js: `group` is parented to
 * planet.surface, built in a flat local frame draped onto the real terrain.
 */

import * as THREE from 'three';

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

// biome -> palette accents so each station reads as belonging to its world
const BIOME_TINT = {
  desert: { hull: 0xcaa477, accent: 0xff9a4a },
  alpine: { hull: 0xd8e6f0, accent: 0x6ac8ff },
  plains: { hull: 0xaebf9a, accent: 0x8adf6a },
  forest: { hull: 0x9ab58a, accent: 0x7dff6a },
};

export function createOutpost(planet, worldUp, opts = {}) {
  const seed = (opts.seed ?? 1) >>> 0;
  const rng = mulberry32(seed);
  const biome = opts.biome || 'plains';
  const tint = BIOME_TINT[biome] || BIOME_TINT.plains;

  const group = new THREE.Group();
  group.name = 'Outpost:' + biome;
  group.add(new THREE.HemisphereLight(0xcfe0ff, 0x2a241c, 0.7));

  // orient + place (as town.js)
  const dirSeeded = worldUp.clone().normalize();
  const rotY = planet.surface?.rotation?.y ?? 0;
  const dirLocal = dirSeeded.clone().applyAxisAngle(YAXIS, -rotY);
  const quat = new THREE.Quaternion().setFromUnitVectors(YAXIS, dirLocal);
  group.quaternion.copy(quat);
  const groundBase = planet.body?.groundAtLocal ? planet.body.groundAtLocal(dirLocal) : 0;
  let baseRadius = (planet.radius ?? 800) + groundBase + 0.05;
  if (planet.water?.r && baseRadius < planet.water.r + 0.4) baseRadius = planet.water.r + 0.4;
  group.position.copy(dirLocal.clone().multiplyScalar(baseRadius));

  const _wp = new THREE.Vector3(), _dir = new THREE.Vector3();
  function groundLocalYAt(lx, lz) {
    _wp.set(lx, 0, lz).applyQuaternion(quat).add(group.position);
    _dir.copy(_wp).normalize();
    const h = planet.body?.groundAtLocal ? planet.body.groundAtLocal(_dir) : 0;
    const planetR = planet.radius ?? 800;
    let rr = planetR + h;
    if (planet.water?.r) rr = Math.max(rr, planet.water.r + 0.4);
    const d2 = lx * lx + lz * lz;
    return Math.sqrt(Math.max(rr * rr - d2, 0)) - baseRadius - 0.35;
  }
  const _q = group.quaternion.clone(), _pos = group.position.clone();
  function localToWorld(v) { return v.clone().applyQuaternion(_q).add(_pos); }

  const colliders = [], collidersLocal = [], waypoints = [], infoPoints = [];
  function addCollider(x, z, r) { colliders.push({ x, z, radius: r }); collidersLocal.push({ x, z, radius: r }); }

  const hullMat = new THREE.MeshStandardMaterial({ color: tint.hull, roughness: 0.6, metalness: 0.3 });
  const accentMat = new THREE.MeshStandardMaterial({ color: tint.accent, emissive: tint.accent, emissiveIntensity: 0.4, roughness: 0.5 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.7, metalness: 0.4 });
  const updaters = [];

  // main dome
  {
    const gy = groundLocalYAt(0, 0);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(7, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), hullMat);
    dome.position.set(0, gy, 0); group.add(dome);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(7.2, 7.6, 1.4, 20), darkMat);
    ring.position.set(0, gy + 0.7, 0); group.add(ring);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), accentMat);
    beacon.position.set(0, gy + 7.4, 0); group.add(beacon);
    addCollider(0, 0, 7.4);
    infoPoints.push({ local: new THREE.Vector3(0, gy + 2, 9), radius: 6, prompt: 'Research Station', kind: 'outpost' });
    waypoints.push({ x: 0, z: 10 }, { x: 9, z: -3 }, { x: -9, z: -3 });
  }

  // dish antenna (slowly sweeps)
  {
    const dx = 12, dz = 4; const gy = groundLocalYAt(dx, dz);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 6, 8), darkMat);
    mast.position.set(dx, gy + 3, dz); group.add(mast);
    const dish = new THREE.Mesh(new THREE.SphereGeometry(3, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.4),
      new THREE.MeshStandardMaterial({ color: tint.hull, roughness: 0.5, metalness: 0.4, side: THREE.DoubleSide }));
    dish.rotation.x = -Math.PI / 3; dish.position.set(dx, gy + 6.5, dz);
    group.add(dish);
    addCollider(dx, dz, 2);
    updaters.push((dt, t) => { dish.rotation.y = Math.sin(t * 0.2) * 0.8; });
  }

  // solar panels + sensor masts + crates
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 1;
    const x = Math.cos(a) * 14, z = Math.sin(a) * 14; const gy = groundLocalYAt(x, z);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(4, 0.2, 2.4),
      new THREE.MeshStandardMaterial({ color: 0x1b2b55, emissive: 0x22407a, emissiveIntensity: 0.3, roughness: 0.4 }));
    panel.position.set(x, gy + 1.6, z); panel.rotation.x = -0.5; panel.rotation.y = a; group.add(panel);
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1.6, 6), darkMat);
    stand.position.set(x, gy + 0.8, z); group.add(stand);
  }
  for (let i = 0; i < 4; i++) {
    const x = (rng() - 0.5) * 22, z = (rng() - 0.5) * 22 - 6; const gy = groundLocalYAt(x, z);
    const crate = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.4, 1.6), hullMat);
    crate.position.set(x, gy + 0.7, z); crate.rotation.y = rng() * Math.PI; group.add(crate);
  }
  {
    const mx = -12, mz = 6; const gy = groundLocalYAt(mx, mz);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 8, 6), darkMat);
    mast.position.set(mx, gy + 4, mz); group.add(mast);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), accentMat);
    tip.position.set(mx, gy + 8, mz); group.add(tip);
    updaters.push((dt, t) => { tip.material.emissiveIntensity = 0.3 + 0.4 * (0.5 + 0.5 * Math.sin(t * 3)); });
  }

  function update(dt, t) { for (const fn of updaters) fn(dt, t); }
  function dispose() {
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { const m = Array.isArray(o.material) ? o.material : [o.material]; m.forEach((x) => x.dispose()); }
    });
    group.clear();
  }

  return {
    group, update, dispose,
    quaternion: group.quaternion, position: group.position, localToWorld,
    colliders, collidersLocal,
    plazaCenters: waypoints,
    groundLocalYAt,
    structures: [],
    infoPoints,
    roleAnchors: { scientist: { x: 0, z: 10 } },
    center: dirLocal.clone(),
    biome,
  };
}
