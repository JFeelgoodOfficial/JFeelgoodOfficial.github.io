// Mont Le Ringger — a walkable mountain hike in the PLAINS biome.
// ... (imports and doc comment unchanged) ...

import * as THREE from 'three';
import { C, LANDING_DIR } from './config.js';
import { biomeAt } from './biomes.js';
import { frameAt } from './layout.js';
import { addStructureResolver, removeStructureResolver, addPad, teleportTo } from './walk.js';
import { addInteractable } from './interact.js';
import { showCard } from './hud.js';

const R_BASE = 135;
const H_SUMMIT = 185;
const TURNS = 6;
const TRAIL_HW = 6.5;
const SHRINK = 0.9;
const RIM_MARGIN = 5;
const RAMP_GATE = 3;

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function makeNoise(seed) {
  const s = (seed >>> 0) * 1e-4 + 1.0;
  const fract = (x) => x - Math.floor(x);
  const hash = (x, y, z) => fract(Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + s * 13.13) * 43758.5453);
  function vnoise(x, y, z) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    let fx = x - ix, fy = y - iy, fz = z - iz;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    const c000 = hash(ix, iy, iz), c100 = hash(ix + 1, iy, iz);
    const c010 = hash(ix, iy + 1, iz), c110 = hash(ix + 1, iy + 1, iz);
    const c001 = hash(ix, iy, iz + 1), c101 = hash(ix + 1, iy, iz + 1);
    const c011 = hash(ix, iy + 1, iz + 1), c111 = hash(ix + 1, iy + 1, iz + 1);
    return (
      (c000 * (1 - fx) + c100 * fx) * (1 - fy) * (1 - fz) +
      (c010 * (1 - fx) + c110 * fx) * fy * (1 - fz) +
      (c001 * (1 - fx) + c101 * fx) * (1 - fy) * fz +
      (c011 * (1 - fx) + c111 * fx) * fy * fz
    ) * 2 - 1;
  }
  return function fbm(x, y, z, oct = 4) {
    let v = 0, a = 0.5;
    for (let i = 0; i < oct; i++) { v += a * vnoise(x, y, z); x *= 2.03; y *= 2.03; z *= 2.03; a *= 0.5; }
    return v;
  };
}

function hashDir(d) {
  return (Math.imul((d.x * 9973) | 0, 0x9e3779b1) ^
          Math.imul((d.y * 8161) | 0, 0x85ebca77) ^
          Math.imul((d.z * 7027) | 0, 0xc2b2ae35)) >>> 0;
}

function scanPlainsSite(planet, avoidDirs) {
  const spawn = LANDING_DIR.clone().normalize();
  const N = 6000, ga = Math.PI * (3 - Math.sqrt(5)), d = new THREE.Vector3();
  for (const minW of [0.55, 0.4, 0.0]) {
    let best = null;
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const rr = Math.sqrt(Math.max(0, 1 - y * y));
      const th = ga * i;
      d.set(Math.cos(th) * rr, y, Math.sin(th) * rr);
      if (Math.abs(d.y) > 0.7) continue;
      const g = planet.groundAtLocal(d);
      if (g < 4) continue;
      const dist = Math.acos(clamp(d.dot(spawn), -1, 1)) * planet.radius;
      if (dist < 320 || dist > 820) continue;
      const b = biomeAt(d);
      if (b.name !== 'plains' || b.plains < minW) continue;
      let far = true;
      for (const a of avoidDirs) {
        if (Math.acos(clamp(d.dot(a), -1, 1)) * planet.radius < 220) { far = false; break; }
      }
      if (!far) continue;
      const score = b.plains * 400 - dist * 0.3;
      if (!best || score > best.score) best = { dir: d.clone(), score, dist, g };
    }
    if (best) return best;
  }
  return null;
}

// --- palette for the height/slope color blend -----------------------------
const COL_GRASS = new THREE.Color(0x4a6b34);
const COL_DIRT  = new THREE.Color(0x6e5a3f);
const COL_SCREE = new THREE.Color(0x8a8478);
const COL_ROCK  = new THREE.Color(0x6f6a63);
const COL_SNOW  = new THREE.Color(0xf3f2ee);
const COL_LICHEN = new THREE.Color(0x9aa15a);

// Blend grass -> dirt/scree -> bare rock -> snow by normalized height (s) and
// slope steepness (slope, 0 = flat, 1 = vertical), with noise-driven variation
// so bands aren't uniform rings. Returns a THREE.Color (mutated, reusable).
const _tmpA = new THREE.Color(), _tmpB = new THREE.Color();
function terrainColor(out, s, slope, n, patchN) {
  // base elevation blend
  if (s < 0.28) {
    const t = clamp(s / 0.28, 0, 1);
    out.copy(COL_GRASS).lerp(COL_DIRT, t);
  } else if (s < 0.62) {
    const t = clamp((s - 0.28) / 0.34, 0, 1);
    out.copy(COL_DIRT).lerp(COL_SCREE, t);
  } else if (s < 0.88) {
    const t = clamp((s - 0.62) / 0.26, 0, 1);
    out.copy(COL_SCREE).lerp(COL_ROCK, t);
  } else {
    const t = clamp((s - 0.88) / 0.12, 0, 1);
    out.copy(COL_ROCK).lerp(COL_SNOW, t);
  }
  // steep faces stay bare rock even at low/mid elevation (talus, cliff bands)
  if (slope > 0.45 && s < 0.88) {
    const rockPull = clamp((slope - 0.45) / 0.4, 0, 1);
    out.lerp(COL_ROCK, rockPull * 0.85);
  }
  // snow only settles in shadowed / low-slope crevices near the summit
  if (s > 0.7) {
    const settle = clamp(1 - slope * 1.6, 0, 1) * clamp((s - 0.7) / 0.3, 0, 1);
    out.lerp(COL_SNOW, settle * 0.9);
  }
  // lichen speckle on mid-elevation boulders/rock faces
  if (s > 0.15 && s < 0.7 && slope > 0.3) {
    const speck = clamp(patchN * 0.5 + 0.5, 0, 1);
    if (speck > 0.72) out.lerp(COL_LICHEN, (speck - 0.72) * 2.2);
  }
  // fine noise variation so it doesn't look flat-shaded/banded
  const wob = 1 + n * 0.08;
  out.r = clamp(out.r * wob, 0, 1);
  out.g = clamp(out.g * wob, 0, 1);
  out.b = clamp(out.b * wob, 0, 1);
  return out;
}

export function buildMonteRingger(ctx, tm, opts = {}) {
  const { planet, scene } = ctx;
  const avoidDirs = (opts.avoidDirs || []).map((a) => (a.clone ? a.clone().normalize() : new THREE.Vector3().fromArray(a).normalize()));

  const site = scanPlainsSite(planet, avoidDirs);
  if (!site) return null;

  const mDir = site.dir.clone().normalize();
  const up = new THREE.Vector3(), north = new THREE.Vector3(), east = new THREE.Vector3();
  frameAt(mDir, up, north, east);
  const baseR = planet.radius + planet.groundAtLocal(mDir);
  const seed = hashDir(mDir);
  const fbm = makeNoise(seed);
  const fbmDetail = makeNoise(seed ^ 0x51ed270b); // second octave set for lichen/AO speckle

  addPad(mDir, (R_BASE + RIM_MARGIN) / planet.radius, baseR, 0.18);

  const _d = new THREE.Vector3();
  function worldOf(lx, lz, lift, out) {
    _d.copy(mDir).multiplyScalar(baseR).addScaledVector(east, lx).addScaledVector(north, lz).normalize();
    return out.copy(_d).multiplyScalar(baseR + lift);
  }
  const _L = { lx: 0, lz: 0, lift: 0 };
  function localOf(P) {
    const pm = P.dot(mDir);
    if (pm < baseR * 0.5) { _L.lift = -1e9; return false; }
    _L.lx = baseR * P.dot(east) / pm;
    _L.lz = baseR * P.dot(north) / pm;
    _L.lift = P.length() - baseR;
    return true;
  }

  function radAt(t) { return R_BASE * (1 - SHRINK * t); }
  function angleAt(t) { return t * Math.PI * 2 * TURNS; }
  const _c = { x: 0, z: 0, h: 0 };
  function centerAt(t, out) {
    const a = angleAt(t), r = radAt(t);
    out.x = Math.cos(a) * r; out.z = Math.sin(a) * r; out.h = t * H_SUMMIT;
    return out;
  }
  function distToC(lx, lz, t) {
    const a = angleAt(t), r = radAt(t);
    const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
    return Math.hypot(lx - cx, lz - cz);
  }
  function closestT(lx, lz) {
    const phi = Math.atan2(lz, lx);
    let bestT = 0, bestD = Infinity;
    for (let k = 0; k < TURNS; k++) {
      const t = (phi + 2 * Math.PI * k) / (2 * Math.PI * TURNS);
      if (t < 0 || t > 1) continue;
      const dd = distToC(lx, lz, t);
      if (dd < bestD) { bestD = dd; bestT = t; }
    }
    for (let it = 0; it < 3; it++) {
      const e = 8e-4;
      const tm = Math.max(0, bestT - e), tp = Math.min(1, bestT + e);
      const dm = distToC(lx, lz, tm), d0 = distToC(lx, lz, bestT), dp = distToC(lx, lz, tp);
      if (dm < d0 && dm <= dp) bestT = tm; else if (dp < d0) bestT = tp; else break;
    }
    return bestT;
  }

  const _n = new THREE.Vector3();
  const resolver = {
    floor(P) {
      if (!localOf(P)) return -Infinity;
      const d = Math.hypot(_L.lx, _L.lz);
      if (d > R_BASE + RIM_MARGIN) return -Infinity;
      const t = closestT(_L.lx, _L.lz);
      centerAt(t, _c);
      const off = Math.hypot(_L.lx - _c.x, _L.lz - _c.z);
      if (off > TRAIL_HW) return -Infinity;
      return baseR + _c.h;
    },
    wall(P) {
      if (!localOf(P)) return;
      const d = Math.hypot(_L.lx, _L.lz);
      if (d > R_BASE + RIM_MARGIN || _L.lift < RAMP_GATE) return;
      const t = closestT(_L.lx, _L.lz);
      centerAt(t, _c);
      const ex = _L.lx - _c.x, ez = _L.lz - _c.z, off = Math.hypot(ex, ez);
      if (off <= TRAIL_HW || off < 1e-4) return;
      const push = off - TRAIL_HW;
      _n.copy(east).multiplyScalar(-ex / off).addScaledVector(north, -ez / off);
      P.addScaledVector(_n, push);
    },
  };
  addStructureResolver(resolver);

  const group = new THREE.Group();
  scene.add(group);

  // Vertex-colored materials replace the flat rock/rockLow materials so the
  // cone and ribbon read as real elevation-banded terrain rather than two
  // solid colors. `vertexColors: true` lets per-vertex height/slope/noise
  // blending (terrainColor) drive the surface look.
  const groundMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.95, metalness: 0.03, flatShading: false,
  });
  const trailMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.98, metalness: 0.02, flatShading: false,
  });

  group.add(buildCone());
  group.add(buildTrailRibbon());
  group.add(buildScatterRocks());
  group.add(buildRimLightShell());

  // rocky cone body: rings from the base rim up to a jagged, asymmetric
  // summit spire (no flat cap), with height/slope-driven vertex color and a
  // second noise pass darkened into crevices to fake ambient occlusion.
  function buildCone() {
    const NR = 56, NS = 140;
    const pos = [], idx = [], col = [];
    const w = new THREE.Vector3();
    const heights = new Float32Array((NR + 1) * (NS + 1));
    for (let i = 0; i <= NR; i++) {
      const s = i / NR;
      // asymmetric jagged spire: taper hard near the top, break symmetry with
      // a second noise sample so the summit isn't a smooth cone point.
      const spireSharp = s > 0.82 ? Math.pow((s - 0.82) / 0.18, 1.6) : 0;
      for (let j = 0; j <= NS; j++) {
        const a = (j / NS) * Math.PI * 2;
        const rough = fbm(Math.cos(a) * 1.7 + 5, Math.sin(a) * 1.7 - 3, s * 3.2, 4);
        const jag = fbm(Math.cos(a) * 3.1 - 2, Math.sin(a) * 3.1 + 7, s * 5.5, 3);
        const edge = Math.sin(s * Math.PI);
        const capShrink = 1 - spireSharp * 0.94; // pinch toward a ragged point, not a disc
        const rr = R_BASE * (1 - s) * capShrink * (1 + rough * 0.12 * edge + jag * 0.05 * spireSharp);
        const lift = H_SUMMIT * s + rough * 9 * edge + jag * 14 * spireSharp;
        const lx = Math.cos(a) * rr, lz = Math.sin(a) * rr;
        worldOf(lx, lz, Math.max(lift, 0), w);
        pos.push(w.x, w.y, w.z);
        heights[i * (NS + 1) + j] = Math.max(lift, 0);
      }
    }
    const row = NS + 1;
    for (let i = 0; i < NR; i++) {
      for (let j = 0; j < NS; j++) {
        const a = i * row + j, b = a + 1, cc = a + row, dd = cc + 1;
        idx.push(a, cc, b, b, cc, dd);
      }
    }
    // slope estimate from neighboring ring-height deltas + color pass
    for (let i = 0; i <= NR; i++) {
      const s = i / NR;
      const i0 = Math.max(0, i - 1), i1 = Math.min(NR, i + 1);
      for (let j = 0; j <= NS; j++) {
        const h0 = heights[i0 * row + j], h1 = heights[i1 * row + j];
        const dh = Math.abs(h1 - h0);
        const slope = clamp(dh / (H_SUMMIT / NR * 2 + 1e-3) * 0.35, 0, 1);
        const a = (j / NS) * Math.PI * 2;
        const patchN = fbmDetail(Math.cos(a) * 4.2, Math.sin(a) * 4.2, s * 6.1, 3);
        const aoN = fbmDetail(Math.cos(a) * 9.5 + 1, Math.sin(a) * 9.5 - 4, s * 12, 2);
        terrainColor(_tmpA, s, slope, patchN, patchN);
        // darken into simulated crevices where the AO noise dips low
        const ao = clamp(1 - Math.max(0, -aoN) * 0.6, 0.55, 1);
        _tmpA.multiplyScalar(ao);
        col.push(_tmpA.r, _tmpA.g, _tmpA.b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, groundMat);
    m.material.polygonOffset = true; m.material.polygonOffsetFactor = 1; m.material.polygonOffsetUnits = 1;
    return m;
  }

  // the walkable trail ribbon, colored dirt/scree by elevation to match the
  // surrounding cone rather than a single flat tone.
  function buildTrailRibbon() {
    const NT = 360;
    const pos = [], idx = [], col = [];
    const a = { x: 0, z: 0, h: 0 }, b = { x: 0, z: 0, h: 0 };
    const wl = new THREE.Vector3(), wr = new THREE.Vector3();
    for (let i = 0; i <= NT; i++) {
      const t = i / NT;
      centerAt(t, a);
      centerAt(Math.min(1, t + 1 / NT), b);
      let tx = b.x - a.x, tz = b.z - a.z;
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const nx = -tz, nz = tx;
      worldOf(a.x + nx * TRAIL_HW, a.z + nz * TRAIL_HW, a.h + 0.25, wl);
      worldOf(a.x - nx * TRAIL_HW, a.z - nz * TRAIL_HW, a.h + 0.25, wr);
      pos.push(wl.x, wl.y, wl.z, wr.x, wr.y, wr.z);
      const s = t;
      // trail tread stays worn dirt/scree longer than the surrounding slope
      terrainColor(_tmpB, s * 0.85, 0.15, fbmDetail(a.x * 0.05, a.z * 0.05, s * 4, 2), 0);
      _tmpB.multiplyScalar(0.92); // slightly darker, packed-earth tread
      col.push(_tmpB.r, _tmpB.g, _tmpB.b, _tmpB.r, _tmpB.g, _tmpB.b);
    }
    for (let i = 0; i < NT; i++) {
      const a0 = i * 2, b0 = a0 + 1, c0 = a0 + 2, d0 = a0 + 3;
      idx.push(a0, c0, b0, b0, c0, d0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, trailMat);
    m.renderOrder = 1;
    return m;
  }

  // loose granite boulders and lichen-covered rocks scattered along the trail
  // edges in the meadow band (low elevation), thinning out higher up.
  function buildScatterRocks() {
    const g = new THREE.Group();
    const boulderMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.04 });
    const NB = 140;
    const posArr = [], colArr = [], idxArr = [];
    let vOff = 0;
    for (let i = 0; i < NB; i++) {
      const t = (i / NB) * 0.55; // only along the lower/mid trail (meadow -> talus)
      centerAt(t, _c);
      const a = angleAt(t);
      const side = (i % 2 === 0) ? 1 : -1;
      const spread = TRAIL_HW + 3 + fbm(i * 3.1, 0, 0, 2) * 6;
      const nx = -Math.sin(a), nz = Math.cos(a);
      const lx = _c.x + nx * spread * side;
      const lz = _c.z + nz * spread * side;
      const size = 1.1 + Math.abs(fbm(i * 7.7, 2, 0, 2)) * 1.8;
      const geo = new THREE.DodecahedronGeometry(size, 0);
      const p = geo.attributes.position;
      const lit = fbmDetail(lx * 0.08, lz * 0.08, t * 3, 2);
      const s = t * 1.05;
      terrainColor(_tmpA, s, 0.55, lit, lit);
      if (lit > 0.35) _tmpA.lerp(COL_LICHEN, 0.35); // extra lichen bias on scatter rocks
      for (let k = 0; k < p.count; k++) {
        worldOf(lx + p.getX(k), lz + p.getY(k) + size * 0.4, t * H_SUMMIT + p.getZ(k), _d);
        posArr.push(_d.x, _d.y, _d.z);
        colArr.push(_tmpA.r, _tmpA.g, _tmpA.b);
      }
      const gi = geo.index.array;
      for (let k = 0; k < gi.length; k++) idxArr.push(gi[k] + vOff);
      vOff += p.count;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colArr, 3));
    geo.setIndex(idxArr);
    geo.computeVertexNormals();
    g.add(new THREE.Mesh(geo, boulderMat));
    return g;
  }

  // Thin, mostly-transparent shell offset outward from the cone surface,
  // additive-blended, that fakes a warm-sunward / cool-shadow fresnel rim
  // light (like the golden-hour east face / blue west face in the sunrise
  // reference) without touching the scene's actual directional light.
  function buildRimLightShell() {
    const sunDir = east.clone().add(up.clone().multiplyScalar(0.3)).normalize(); // approx sunward
    const mat = new THREE.ShaderMaterial({
      uniforms: { sunDir: { value: sunDir } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide,
      vertexShader: `
        varying vec3 vN; varying vec3 vW;
        void main() {
          vN = normalize(normalMatrix * normal);
          vW = normalize((modelMatrix * vec4(position,1.0)).xyz);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        }`,
      fragmentShader: `
        uniform vec3 sunDir;
        varying vec3 vN; varying vec3 vW;
        void main() {
          float fres = pow(1.0 - max(dot(normalize(vN), vec3(0.0,0.0,1.0)), 0.0), 2.2);
          float warm = clamp(dot(vW, sunDir), -1.0, 1.0) * 0.5 + 0.5;
          vec3 warmCol = vec3(1.0, 0.72, 0.38);
          vec3 coolCol = vec3(0.45, 0.58, 0.85);
          vec3 rim = mix(coolCol, warmCol, warm);
          gl_FragColor = vec4(rim, fres * 0.35);
        }`,
    });
    const geo = new THREE.SphereGeometry(1, 24, 16); // reused as a generic shell, scaled per-vertex below
    // Build the shell by duplicating the cone silhouette slightly enlarged is
    // overkill; instead use a simple enlarged cone proxy for the rim pass.
    const proxy = new THREE.ConeGeometry(R_BASE * 1.02, H_SUMMIT * 1.02, 48, 1, true);
    proxy.translate(0, H_SUMMIT * 0.51, 0);
    proxy.rotateX(Math.PI); // cone apex up by default points -Y; flip to +Y
    const m = new THREE.Mesh(proxy, mat);
    // orient/position the proxy onto the real summit axis
    placeLocalGroup(m, 0, 0, 0);
    return m;
  }
  function placeLocalGroup(obj, lx, lz, lift) {
    worldOf(lx, lz, lift, _d);
    obj.position.copy(_d);
    obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), mDir);
  }

  // --- trailhead sign (unchanged) --------------------------------------------
  const _pu = new THREE.Vector3(), _pf = new THREE.Vector3(), _pr = new THREE.Vector3(), _pb = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  function placeLocal(g, lx, lz, lift, faceDir) {
    worldOf(lx, lz, lift, _pos);
    g.position.copy(_pos);
    _pu.copy(_pos).normalize();
    _pf.copy(faceDir).addScaledVector(_pu, -faceDir.dot(_pu));
    if (_pf.lengthSq() < 1e-5) _pf.copy(north);
    _pf.normalize();
    _pr.crossVectors(_pu, _pf).normalize();
    _pb.makeBasis(_pr, _pu, _pf);
    g.quaternion.setFromRotationMatrix(_pb);
  }
  function makeSign(text) {
    const cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 200;
    const c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    c.fillStyle = '#f5e1b8';
    c.font = '700 120px Georgia, serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, 512, 108);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.Mesh(new THREE.PlaneGeometry(20, 3.9),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, side: THREE.DoubleSide }));
  }
  const signGroup = new THREE.Group();
  const beam = new THREE.MeshStandardMaterial({ color: 0x3a2f22, roughness: 0.85, metalness: 0.05 });
  for (const sx of [-9, 9]) {
    const postM = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 11, 10), beam);
    postM.position.set(sx, 5.5, 0); signGroup.add(postM);
  }
  const cross = new THREE.Mesh(new THREE.BoxGeometry(20, 0.6, 0.5), beam);
  cross.position.set(0, 9.4, 0); signGroup.add(cross);
  const panel = makeSign('MONT LE RINGGER');
  panel.position.set(0, 7.2, 0.35); signGroup.add(panel);
  placeLocal(signGroup, R_BASE + 2.5, 0, 0, LANDING_DIR);
  group.add(signGroup);

  // --- summit cairn + fluttering flag (unchanged) -----------------------------
  centerAt(1, _c);
  const summitGroup = new THREE.Group();
  const cairnMat = new THREE.MeshStandardMaterial({ color: C.PALETTE.high, roughness: 0.9, metalness: 0.05, flatShading: true });
  let cy = 0;
  for (let i = 0; i < 5; i++) {
    const r = 1.7 - i * 0.28;
    const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), cairnMat);
    stone.position.set(Math.sin(i * 2.1) * 0.25, cy + r * 0.6, Math.cos(i * 2.1) * 0.25);
    stone.rotation.set(i, i * 1.3, i * 0.7);
    summitGroup.add(stone);
    cy += r * 1.15;
  }
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 6, 8),
    new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.6, metalness: 0.3 }));
  pole.position.set(0, cy + 3, 0); summitGroup.add(pole);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(3, 1.8),
    new THREE.MeshStandardMaterial({ color: 0xf5b642, emissive: 0x3a2a06, roughness: 0.6, side: THREE.DoubleSide }));
  flag.position.set(1.5, cy + 4.6, 0); summitGroup.add(flag);
  placeLocal(summitGroup, _c.x, _c.z, H_SUMMIT, LANDING_DIR);
  group.add(summitGroup);

  // --- interactions + compass (unchanged) -------------------------------------
  const summitWorld = worldOf(_c.x, _c.z, H_SUMMIT, new THREE.Vector3());
  addInteractable({
    pos: summitWorld.clone(), radius: 8,
    prompt: 'Take in the view &nbsp; <b>E</b>',
    action: () => showCard({
      kicker: 'Mont Le Ringger · the summit',
      title: 'A gorgeous view of the whole world below',
      meta: `${Math.round(H_SUMMIT)} units above the plains`,
      body: [
        'You stand at the cairn, the flag snapping in the thin wind. The arduous, rocky switchbacks fall away beneath your boots.',
        'From up here you can see pretty much the whole world: the plains rolling out to the curve of the horizon, the distant settlements no bigger than pinpricks, the sea catching the low gold light. Every direction you have ever walked is laid out below you at once.',
      ],
    }),
  });

  const trailheadWorld = worldOf(R_BASE + 2.5, 0, 2, new THREE.Vector3());
  addInteractable({
    pos: trailheadWorld.clone(), radius: 6,
    prompt: '<b>E</b> — Mont Le Ringger',
    action: () => showCard({
      kicker: 'trailhead',
      title: 'Mont Le Ringger',
      body: [
        'A tall, steep peak of broken rock rising out of the plains. One switchback trail winds all the way to the summit — and it is the only way up. The cliffs to either side are not climbable, so stay on the path.',
        'It is an arduous, rocky hike, but the view from the top is worth every step. Follow the trail up and press E at the cairn.',
      ],
    }),
  });

  const compass = [{ name: 'Mont Le Ringger', pos: summitWorld.clone().normalize().multiplyScalar(baseR + H_SUMMIT + 8) }];

  function flagWave(dt, t) { flag.rotation.y = Math.sin(t * 2) * 0.35; flag.rotation.z = Math.sin(t * 3.3) * 0.06; }

  function dispose() {
    removeStructureResolver(resolver);
    if (group.parent) group.parent.remove(group);
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { const m = o.material; if (m.map) m.map.dispose(); m.dispose(); }
    });
  }

  if (typeof window !== 'undefined') {
    window.__monteRingger = {
      dir: mDir.toArray(),
      dist: site.dist,
      base: () => teleportTo(planet, worldOf(R_BASE + 2.5, 0, 0, new THREE.Vector3()).normalize()),
      summit: () => teleportTo(planet, summitWorld.clone().normalize()),
      floorAt: (arr) => resolver.floor(new THREE.Vector3().fromArray(arr)),
      probe: () => {
        const mid = centerAt(0.5, { x: 0, z: 0, h: 0 });
        const gapR = (radAt(2 / TURNS) + radAt(3 / TURNS)) / 2;
        const on = resolver.floor(worldOf(mid.x, mid.z, mid.h, new THREE.Vector3()));
        const off = resolver.floor(worldOf(gapR, 0, mid.h, new THREE.Vector3()));
        const far = resolver.floor(LANDING_DIR.clone().multiplyScalar(baseR));
        return { baseR, expectMid: baseR + 0.5 * H_SUMMIT, on, off, far };
      },
    };
  }

  return { compass, updaters: [flagWave], dir: mDir, dispose };
}