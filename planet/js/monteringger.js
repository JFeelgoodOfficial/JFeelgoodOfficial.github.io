// Mont Le Ringger — a walkable mountain hike in the PLAINS biome.
//
// This replaces an old, orphaned flat-world "Mountain Hike 3D" prototype that
// once lived in this file. The trail/summit ideas survive; the world does not:
// everything here is projected onto the live sphere planet and wired into the
// same systems the rest of the surface content uses (walk.js floor resolvers,
// interact.js, hud.js, the compass).
//
// The peak is a tall, steep rocky cone. A single spiral switchback trail is the
// ONLY walkable route up: the mountain registers a structure resolver whose
// floor() lifts the walker only inside a narrow trail corridor and returns
// -Infinity everywhere else on the cone, so stepping off the trail drops you
// back to the flattened base — the cliffs cannot be climbed. A big trailhead
// sign reads "MONT LE RINGGER"; the summit carries a stone cairn, a fluttering
// flag, and an interactable that opens the view out over the whole world.
//
// Local coordinates: a fixed tangent frame at the peak axis `mDir` (up=mDir,
// plus `east`,`north` from frameAt). A local point is (lx along east, lz along
// north, lift = radial height above baseR). The forward/inverse maps below are
// exact inverses AND place meshes on real sphere directions (radius baseR+lift),
// so the visible cone/ribbon and the invisible collision floor never drift.

import * as THREE from 'three';
import { C, LANDING_DIR } from './config.js';
import { biomeAt } from './biomes.js';
import { frameAt } from './layout.js';
import { addStructureResolver, removeStructureResolver, addPad, teleportTo } from './walk.js';
import { addInteractable } from './interact.js';
import { showCard } from './hud.js';

// --- proportions (grounded in RADIUS=800, TERRAIN_HEIGHT=50, WALK_SPEED=7) ---
const R_BASE = 135;    // footprint radius (tangent world units)
const H_SUMMIT = 185;  // summit lift above the base — dwarfs natural peaks (~50)
const TURNS = 6;       // spiral switchback loops
const TRAIL_HW = 6.5;  // trail half-width — comfortably walkable at WALK_SPEED 7
const SHRINK = 0.9;    // trail radius shrinks R_BASE -> R_BASE*0.1 at the summit
const RIM_MARGIN = 5;  // beyond R_BASE + this, you're off the mountain
const RAMP_GATE = 3;   // only clamp to the trail once this far up (seamless base)

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

// --- deterministic value-noise fbm (seeded per mountain, for rocky faces) ----
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

// Pick a strong plains site in a reachable band, clear of spawn and the given
// avoid directions (the biomeCivs settlements). Mirrors biomeCivs.scanSites.
function scanPlainsSite(planet, avoidDirs) {
  const spawn = LANDING_DIR.clone().normalize();
  const N = 6000, ga = Math.PI * (3 - Math.sqrt(5)), d = new THREE.Vector3();
  // three passes, relaxing the plains-weight bar so a site is always found
  for (const minW of [0.55, 0.4, 0.0]) {
    let best = null;
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const rr = Math.sqrt(Math.max(0, 1 - y * y));
      const th = ga * i;
      d.set(Math.cos(th) * rr, y, Math.sin(th) * rr);
      if (Math.abs(d.y) > 0.7) continue;              // off the poles
      const g = planet.groundAtLocal(d);
      if (g < 4) continue;                            // dry land
      const dist = Math.acos(clamp(d.dot(spawn), -1, 1)) * planet.radius;
      if (dist < 320 || dist > 820) continue;         // reachable, clear of spawn
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

// ===========================================================================
export function buildMonteRingger(ctx, tm, opts = {}) {
  const { planet, scene } = ctx;
  const avoidDirs = (opts.avoidDirs || []).map((a) => (a.clone ? a.clone().normalize() : new THREE.Vector3().fromArray(a).normalize()));

  const site = scanPlainsSite(planet, avoidDirs);
  if (!site) return null; // no dry plains anywhere — nothing to build

  // --- fixed tangent frame at the peak axis ---
  const mDir = site.dir.clone().normalize();
  const up = new THREE.Vector3(), north = new THREE.Vector3(), east = new THREE.Vector3();
  frameAt(mDir, up, north, east);
  const baseR = planet.radius + planet.groundAtLocal(mDir);
  const seed = hashDir(mDir);
  const fbm = makeNoise(seed);

  // Flatten a disc of terrain to baseR so the cone base sits flush (no seam) and
  // off-trail ground around the mountain is level. addPad only ever raises.
  addPad(mDir, (R_BASE + RIM_MARGIN) / planet.radius, baseR, 0.18);

  // --- local <-> world maps (exact inverses; place on real sphere dirs) ------
  // world = normalize(mDir*baseR + east*lx + north*lz) * (baseR + lift)
  const _d = new THREE.Vector3();
  function worldOf(lx, lz, lift, out) {
    _d.copy(mDir).multiplyScalar(baseR).addScaledVector(east, lx).addScaledVector(north, lz).normalize();
    return out.copy(_d).multiplyScalar(baseR + lift);
  }
  // inverse: lx = baseR·(P·east)/(P·mDir), lz = baseR·(P·north)/(P·mDir), lift = |P|-baseR
  const _L = { lx: 0, lz: 0, lift: 0 };
  function localOf(P) {
    const pm = P.dot(mDir);
    if (pm < baseR * 0.5) { _L.lift = -1e9; return false; } // far side / below — bail
    _L.lx = baseR * P.dot(east) / pm;
    _L.lz = baseR * P.dot(north) / pm;
    _L.lift = P.length() - baseR;
    return true;
  }

  // --- spiral switchback trail centerline (local x,z + ramp height) ----------
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
  // Closest centerline parameter: the spiral crosses polar angle φ once per loop,
  // so enumerate one candidate per turn and refine — correct even where the
  // switchbacks stack directly above one another.
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

  // --- the structure resolver: floor carries you up the trail, wall holds you on it
  const _n = new THREE.Vector3();
  const resolver = {
    floor(P) {
      if (!localOf(P)) return -Infinity;
      const d = Math.hypot(_L.lx, _L.lz);
      if (d > R_BASE + RIM_MARGIN) return -Infinity;      // off the mountain
      const t = closestT(_L.lx, _L.lz);
      centerAt(t, _c);
      const off = Math.hypot(_L.lx - _c.x, _L.lz - _c.z);
      if (off > TRAIL_HW) return -Infinity;               // off the ramp -> cliff (falls to base)
      return baseR + _c.h;                                // ride the ramp
    },
    wall(P) {
      if (!localOf(P)) return;
      const d = Math.hypot(_L.lx, _L.lz);
      if (d > R_BASE + RIM_MARGIN || _L.lift < RAMP_GATE) return; // free to roam at the base
      const t = closestT(_L.lx, _L.lz);
      centerAt(t, _c);
      const ex = _L.lx - _c.x, ez = _L.lz - _c.z, off = Math.hypot(ex, ez);
      if (off <= TRAIL_HW || off < 1e-4) return;
      const push = off - TRAIL_HW;
      _n.copy(east).multiplyScalar(-ex / off).addScaledVector(north, -ez / off);
      P.addScaledVector(_n, push);                        // nudge back toward the centerline
    },
  };
  addStructureResolver(resolver);

  // --- meshes ---------------------------------------------------------------
  const group = new THREE.Group();
  scene.add(group);

  const rock = new THREE.MeshStandardMaterial({ color: C.PALETTE.mid, roughness: 0.97, metalness: 0.04, flatShading: true });
  const rockLow = new THREE.MeshStandardMaterial({ color: C.PALETTE.low, roughness: 0.95, metalness: 0.05, flatShading: true });

  group.add(buildCone());
  group.add(buildTrailRibbon());

  // rocky cone body: rings from the base rim up to a flat summit cap, displaced
  // by fbm so the faces read as broken rock. Steep by construction (H/R ~ 1.4).
  function buildCone() {
    const NR = 44, NS = 120;
    const pos = [], idx = [];
    const w = new THREE.Vector3();
    for (let i = 0; i <= NR; i++) {
      const s = i / NR;                          // 0 base -> 1 apex
      const cap = s > 0.9 ? smoothCap(s) : 1;    // flatten the top for the cairn
      for (let j = 0; j <= NS; j++) {
        const a = (j / NS) * Math.PI * 2;
        const rough = fbm(Math.cos(a) * 1.7 + 5, Math.sin(a) * 1.7 - 3, s * 3.2, 4);
        const edge = Math.sin(s * Math.PI);      // fade noise out at base & apex
        const rr = R_BASE * (1 - s) * cap * (1 + rough * 0.10 * edge);
        const lift = H_SUMMIT * (s * cap + (1 - cap)) + rough * 9 * edge;
        const lx = Math.cos(a) * rr, lz = Math.sin(a) * rr;
        worldOf(lx, lz, Math.max(lift, 0), w);
        pos.push(w.x, w.y, w.z);
      }
    }
    const row = NS + 1;
    for (let i = 0; i < NR; i++) {
      for (let j = 0; j < NS; j++) {
        const a = i * row + j, b = a + 1, cc = a + row, dd = cc + 1;
        idx.push(a, cc, b, b, cc, dd);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, rock);
    m.material.polygonOffset = true; m.material.polygonOffsetFactor = 1; m.material.polygonOffsetUnits = 1;
    return m;
  }
  function smoothCap(s) { const t = clamp((1 - s) / 0.1, 0, 1); return 0.12 + 0.88 * (t * t * (3 - 2 * t)); }

  // the walkable trail, a ribbon laid exactly on the collision centerline
  function buildTrailRibbon() {
    const NT = 360;
    const pos = [], idx = [];
    const a = { x: 0, z: 0, h: 0 }, b = { x: 0, z: 0, h: 0 };
    const wl = new THREE.Vector3(), wr = new THREE.Vector3();
    for (let i = 0; i <= NT; i++) {
      const t = i / NT;
      centerAt(t, a);
      centerAt(Math.min(1, t + 1 / NT), b);
      let tx = b.x - a.x, tz = b.z - a.z;
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const nx = -tz, nz = tx;                   // left normal in the local plane
      worldOf(a.x + nx * TRAIL_HW, a.z + nz * TRAIL_HW, a.h + 0.25, wl);
      worldOf(a.x - nx * TRAIL_HW, a.z - nz * TRAIL_HW, a.h + 0.25, wr);
      pos.push(wl.x, wl.y, wl.z, wr.x, wr.y, wr.z);
    }
    for (let i = 0; i < NT; i++) {
      const a0 = i * 2, b0 = a0 + 1, c0 = a0 + 2, d0 = a0 + 3;
      idx.push(a0, c0, b0, b0, c0, d0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, rockLow);
    m.renderOrder = 1;
    return m;
  }

  // --- trailhead sign: big "MONT LE RINGGER" at the foot of the trail --------
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
  // stand the sign just outside the trailhead (t=0 is at angle 0 -> +east rim)
  placeLocal(signGroup, R_BASE + 2.5, 0, 0, LANDING_DIR);
  group.add(signGroup);

  // --- summit cairn + fluttering flag ---------------------------------------
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

  // --- interactions + compass -----------------------------------------------
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

  // fluttering flag
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
      // self-check: floor invariants along the trail vs. off it (for tests).
      // on-trail: centerline at t=0.5 (angle 0, radius radAt(0.5)); off-trail:
      // angle 0 at a radius midway between two switchback arms (in the gap).
      probe: () => {
        const mid = centerAt(0.5, { x: 0, z: 0, h: 0 });
        const gapR = (radAt(2 / TURNS) + radAt(3 / TURNS)) / 2; // between arms k=2,3 at angle 0
        const on = resolver.floor(worldOf(mid.x, mid.z, mid.h, new THREE.Vector3()));
        const off = resolver.floor(worldOf(gapR, 0, mid.h, new THREE.Vector3()));
        const far = resolver.floor(LANDING_DIR.clone().multiplyScalar(baseR));
        return { baseR, expectMid: baseR + 0.5 * H_SUMMIT, on, off, far };
      },
    };
  }

  return { compass, updaters: [flagWave], dir: mDir, dispose };
}
