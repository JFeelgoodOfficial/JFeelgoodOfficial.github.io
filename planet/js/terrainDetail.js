// terrainDetail.js — a high-resolution ground patch that follows the player (or
// the piloted vehicle) across the planet, laid on top of the coarse baked
// surface sphere. The base sphere is a single fixed 288² mesh (~17 units per
// segment at this radius), which reads soft up close; this patch re-displaces a
// fine grid from the SAME analytic height field (planet.groundAtLocal, i.e.
// terrain.js) every time the centre moves, and shades it with a real PBR
// material lit by the scene's sun + hemisphere. That gives crisp, textured near
// ground and slope-aware relief without touching the height field or the mobile
// fallback. Like foliage.js it re-streams around a moving centre, so cost is a
// periodic rebuild, not per-frame.

import * as THREE from 'three';

const RESTREAM = 14;   // rebuild once the centre has moved this many units

export function buildTerrainDetail(planet, spawnDir, opts = {}) {
  const N = opts.grid ?? (opts.quality === 'low' ? 40 : 64); // cells per side
  const HALF = opts.half ?? 82;                                // world units from centre to edge
  const BIAS = 0.06;                                           // small lift above the coarse mesh (polygonOffset handles z-fight)
  const R = planet.radius;
  const seaR = planet.seaR;

  const verts = (N + 1) * (N + 1);
  const positions = new Float32Array(verts * 3);
  const colors = new Float32Array(verts * 3);
  const indices = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * (N + 1) + i;
      const b = a + 1;
      const c = a + (N + 1);
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(indices);

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.95, metalness: 0.0,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 0;

  // palette for the near ground, tuned to read as real earth under PBR light
  const cSand = new THREE.Color(0x9c8a5e);
  const cGrass = new THREE.Color(0x5f7a3a);
  const cMoss = new THREE.Color(0x415f2c);
  const cRock = new THREE.Color(0x6a5f52);
  const cSnow = new THREE.Color(0xdfe7f0);
  const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _up = new THREE.Vector3();
  const _dir = new THREE.Vector3(), _flat = new THREE.Vector3(), _c = new THREE.Color();
  const _center = new THREE.Vector3();
  let last = null;

  function restream(centreWorld) {
    _up.copy(centreWorld).normalize();
    // a stable tangent basis at the centre
    _t1.set(0, 1, 0);
    if (Math.abs(_up.y) > 0.9) _t1.set(1, 0, 0);
    _t1.crossVectors(_t1, _up).normalize();
    _t2.crossVectors(_up, _t1).normalize();
    const base = _center.copy(_up).multiplyScalar(R);

    for (let j = 0; j <= N; j++) {
      const z = (j / N - 0.5) * 2 * HALF;
      for (let i = 0; i <= N; i++) {
        const x = (i / N - 0.5) * 2 * HALF;
        _flat.copy(base).addScaledVector(_t1, x).addScaledVector(_t2, z);
        _dir.copy(_flat).normalize();
        const h = planet.groundAtLocal(_dir);
        const idx = (j * (N + 1) + i) * 3;
        // drape to ground; below sea we clamp to the sea shell so the patch
        // never pokes above the water plane.
        let rr = R + h;
        const onLand = h > 0.001;
        if (rr < seaR) rr = seaR - 0.05;
        else rr += BIAS;
        positions[idx] = _dir.x * rr;
        positions[idx + 1] = _dir.y * rr;
        positions[idx + 2] = _dir.z * rr;
        // colour by height + latitude (snow) with a little deterministic grain
        const e = Math.min(h / 34, 1);
        _c.copy(cSand).lerp(cGrass, Math.min(e / 0.18, 1));
        _c.lerp(cMoss, Math.max(0, Math.min((e - 0.2) / 0.35, 1)));
        _c.lerp(cRock, Math.max(0, Math.min((e - 0.55) / 0.35, 1)));
        const lat = Math.abs(_dir.y);
        if (lat > 0.72) _c.lerp(cSnow, Math.min((lat - 0.72) / 0.15, 1));
        const grain = 0.9 + 0.2 * fract(Math.sin((i * 12.9 + j * 78.2)) * 43758.5);
        _c.multiplyScalar(onLand ? grain : 1.0);
        colors[idx] = _c.r; colors[idx + 1] = _c.g; colors[idx + 2] = _c.b;
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    if (!last) last = new THREE.Vector3();
    last.copy(centreWorld);
  }

  restream(spawnDir.clone().multiplyScalar(R));

  return {
    mesh,
    update(centreWorld) {
      if (!last || centreWorld.distanceTo(last) > RESTREAM) restream(centreWorld);
    },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

function fract(x) { return x - Math.floor(x); }
