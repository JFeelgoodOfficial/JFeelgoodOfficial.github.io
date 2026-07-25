// Mont Le Ringger — a photorealistic alpine peak and hike, out on the plains.
//
// The mountain is ONE pure height function, `surfaceH(lx, lz)`, expressed in a
// fixed tangent frame at the peak axis. That single function is the rendered
// mesh, the collision floor, and the scatter placement — so the rock you see and
// the rock you stand on can never drift apart.
//
// Shape: a radial profile (gentle meadow apron -> steep body -> summit dome)
// multiplied by ridged multifractal noise for real ridges and gullies, plus a
// few subsidiary shoulders for layered ridgelines and a set of teeth that break
// the crown into a jagged spire. The switchback trail is then CARVED into that
// rock as a bench — a cut-bank on the uphill side, a fill shoulder on the
// downhill side — so the path is a visible notch, not a ramp floating on stilts.
//
// Off the bench the mountain is scree: too steep to climb, and `wall()` slides
// you back down. The meadow apron around the base stays gently walkable, so you
// can wander the flowers and boulders but the trail is the only way to the top.
//
// Lighting is baked, because this renderer has no shadow maps and the planet
// surface is a raw ShaderMaterial that could never receive one: ambient
// occlusion from local cavity, real cast shadows from a sun march over the
// height grid, and a warm/cool split from the sun angle all go into vertex
// colours. A MeshStandardMaterial carries them so scene fog, the sun and the
// hemisphere light (all mutated live by weather.js) apply for free, with
// onBeforeCompile adding per-pixel rock grain, snow on ledges, a fresnel rim,
// and the local aerial haze that makes the ridgelines recede.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { C, LANDING_DIR, SUN } from './config.js';
import { biomeAt } from './biomes.js';
import { frameAt, addSurfaceExclusion, removeSurfaceExclusion } from './layout.js';
import { addStructureResolver, removeStructureResolver, addPad, teleportTo } from './walk.js';
import { addInteractable } from './interact.js';
import { showCard } from './hud.js';
import { mulberry32 } from './noise2.js';

// --- proportions (RADIUS=800, TERRAIN_HEIGHT=50, WALK_SPEED=7) --------------
const R_BASE = 210;     // heightfield rim: the mountain reaches 0 here
const H_TOP = 300;      // crown height above baseR — six times a natural peak
const R_MESH = 320;     // mesh outer edge; the skirt tucks under the terrain
const RIM_MARGIN = 8;   // floor()/wall() footprint cutoff
const TURNS = 4;        // switchback loops
const R_TRAIL0 = 178;   // trailhead radius (inside the rim, on the meadow)
const R_TRAIL1 = 5;     // the spiral closes on the axis, so the trail reaches the top
const SHRINK = (R_TRAIL0 - R_TRAIL1) / R_TRAIL0;
const TRAIL_HW = 6.5;   // bench half-width
const CARVE_OUT = 9.5;  // cut/fill shoulder half-width (keep rock between arms)
const RAMP_GATE = 14;   // corridor clamp engages once the TRAIL is this high
const SCREE_TAN = 0.70; // 35° — steeper than this off-trail and you slide
const SCREE_RAMP = 0.35;
const SLIDE_RATE = 24;  // units/s at full steepness (beats WALK_RUN_SPEED 14)
const SUM_R = 4;        // standing perch at the very top (small: keep the spire)

// Pad kept close to the mountain's own footprint: a wider pad would flatten a
// broad ring of plains around it AND force the site scan to find an improbably
// large patch of dry land. The mesh takes max(surfaceH, pad) so the two always
// agree even where the pad's blend ring reaches inside R_BASE.
const PAD_ANG = 0.2882;
const PAD_BLEND = 0.28;

// profile term weights (sum to 1); ranges overlap on purpose — abutting them
// leaves dead-flat shelves at the joins and the mountain reads as a wedding cake
const APR = 0.045, BODY = 0.825, SPI = 0.130;

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function sstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
function sm01(x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); }
function smd01(x) { return (x <= 0 || x >= 1) ? 0 : 6 * x * (1 - x); }
function lerp(a, b, t) { return a + (b - a) * t; }

// --- seeded 3D value noise (iq hash — same family as the terrain field) -----
function makeNoise(seed) {
  const s = (seed >>> 0) % 65536;
  const sx = (s % 97) * 0.137, sy = ((s >> 4) % 89) * 0.211, sz = ((s >> 8) % 83) * 0.171;
  function h3(x, y, z) {
    let a = (x + sx) * 0.3183099 + 0.1; a -= Math.floor(a);
    let b = (y + sy) * 0.3183099 + 0.1; b -= Math.floor(b);
    let c = (z + sz) * 0.3183099 + 0.1; c -= Math.floor(c);
    a *= 17; b *= 17; c *= 17;
    const v = a * b * c * (a + b + c);
    return v - Math.floor(v);
  }
  function vnoise(x, y, z) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    let fx = x - ix, fy = y - iy, fz = z - iz;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    const c000 = h3(ix, iy, iz), c100 = h3(ix + 1, iy, iz);
    const c010 = h3(ix, iy + 1, iz), c110 = h3(ix + 1, iy + 1, iz);
    const c001 = h3(ix, iy, iz + 1), c101 = h3(ix + 1, iy, iz + 1);
    const c011 = h3(ix, iy + 1, iz + 1), c111 = h3(ix + 1, iy + 1, iz + 1);
    return (
      (c000 * (1 - fx) + c100 * fx) * (1 - fy) * (1 - fz) +
      (c010 * (1 - fx) + c110 * fx) * fy * (1 - fz) +
      (c001 * (1 - fx) + c101 * fx) * (1 - fy) * fz +
      (c011 * (1 - fx) + c111 * fx) * fy * fz
    );
  }
  return {
    vnoise,
    fbm(x, y, z, oct) {
      let v = 0, a = 0.5, n = 0;
      for (let i = 0; i < oct; i++) { v += a * vnoise(x, y, z); n += a; x *= 2.03; y *= 2.03; z *= 2.03; a *= 0.5; }
      return (v / n) * 2 - 1;
    },
    // weighted ridged multifractal — sharp crests, smooth valleys
    ridged(x, y, z, oct) {
      let v = 0, a = 0.5, w = 1;
      for (let i = 0; i < oct; i++) {
        let n = 1 - Math.abs(2 * vnoise(x, y, z) - 1);
        n *= n;
        v += a * n * w;
        w = clamp(n * 1.6, 0, 1);
        x *= 2.11; y *= 2.11; z *= 2.11; a *= 0.5;
      }
      return v;
    },
  };
}

function hashDir(d) {
  return (Math.imul((d.x * 9973) | 0, 0x9e3779b1) ^
          Math.imul((d.y * 8161) | 0, 0x85ebca77) ^
          Math.imul((d.z * 7027) | 0, 0xc2b2ae35)) >>> 0;
}

// --- site selection ---------------------------------------------------------
// Two stages: a cheap centre filter over the whole sphere, then a rim test on
// only the best few. Rim-testing all 6000 candidates would cost over a second.
// `rimScale` shrinks the tested disc in later passes: the heightfield only
// reaches R_BASE (gnomonic 210 ~= arc 207), well inside the pad, so a slightly
// smaller dry disc is still a mountain standing entirely on land.
const PASSES = [
  { minW: 0.55, minD: 500, maxD: 1150, avoid: 420, rimBiome: true, relief: 26, rimScale: 1.0 },
  { minW: 0.40, minD: 500, maxD: 1150, avoid: 420, rimBiome: false, relief: 34, rimScale: 1.0 },
  { minW: 0.25, minD: 500, maxD: 1150, avoid: 360, rimBiome: false, relief: 46, rimScale: 0.86 },
  { minW: 0.00, minD: 460, maxD: 1300, avoid: 300, rimBiome: false, relief: 70, rimScale: 0.74 },
];
const SHORTLIST = 220;   // rim tests are ~0.2 ms each; test essentially all of them

function rimOk(planet, cand, pass) {
  const up = new THREE.Vector3(), n = new THREE.Vector3(), e = new THREE.Vector3();
  frameAt(cand.dir, up, n, e);
  const p = new THREE.Vector3();
  let lo = cand.g, hi = cand.g;
  for (const frac of [1.0, 0.62]) {
    const a = PAD_ANG * pass.rimScale * frac;
    for (let k = 0; k < 16; k++) {
      const th = k * Math.PI / 8;
      p.copy(cand.dir).multiplyScalar(Math.cos(a))
        .addScaledVector(n, Math.sin(a) * Math.cos(th))
        .addScaledVector(e, Math.sin(a) * Math.sin(th)).normalize();
      const g = planet.groundAtLocal(p);
      if (g < 2.5) return false;                                 // rim in water
      if (pass.rimBiome && biomeAt(p).plains < 0.20) return false;
      if (g < lo) lo = g;
      if (g > hi) hi = g;
    }
  }
  return (hi - lo) <= pass.relief;                               // no cliff under the pad
}

function scanPlainsSite(planet, avoidDirs) {
  const spawn = LANDING_DIR.clone().normalize();
  const sun = SUN.clone().normalize();
  const N = 6000, ga = Math.PI * (3 - Math.sqrt(5)), d = new THREE.Vector3();
  // Per-filter reject counts, published as window.__mrScan. A footprint this
  // large is genuinely hard to place, and when no site is found the mountain
  // silently doesn't exist — these counters say which constraint was binding.
  const stats = [];

  for (const pass of PASSES) {
    const st = { pole: 0, wet: 0, band: 0, sun: 0, biome: 0, avoid: 0, kept: 0, rim: 0 };
    stats.push(st);
    if (typeof window !== 'undefined') window.__mrScan = stats;
    const short = [];
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const rr = Math.sqrt(Math.max(0, 1 - y * y));
      const th = ga * i;
      d.set(Math.cos(th) * rr, y, Math.sin(th) * rr);
      if (Math.abs(d.y) > 0.7) { st.pole++; continue; }
      const g = planet.groundAtLocal(d);
      if (g < 4) { st.wet++; continue; }
      const dist = Math.acos(clamp(d.dot(spawn), -1, 1)) * planet.radius;
      if (dist < pass.minD || dist > pass.maxD) { st.band++; continue; }
      // The sun never moves. Far enough around the planet it sits below the
      // local horizon — a 300-unit mountain in permanent night. Demand real
      // daylight, and prefer a raking golden-hour angle.
      const sunUp = d.dot(sun);
      if (sunUp < 0.30) { st.sun++; continue; }
      const b = biomeAt(d);
      if (b.name !== 'plains' || b.plains < pass.minW) { st.biome++; continue; }
      let far = true;
      for (const a of avoidDirs) {
        if (Math.acos(clamp(d.dot(a), -1, 1)) * planet.radius < pass.avoid) { far = false; break; }
      }
      if (!far) { st.avoid++; continue; }
      st.kept++;
      // prefer solidly inland ground — a big footprint near a coast fails the rim test
      const score = b.plains * 400 - dist * 0.25 - Math.abs(sunUp - 0.45) * 260 + g * 6;
      short.push({ dir: d.clone(), score, dist, g, sunUp });
    }
    short.sort((a, b) => b.score - a.score);
    for (const cand of short.slice(0, SHORTLIST)) {
      st.rim++;
      if (rimOk(planet, cand, pass)) return cand;
    }
  }
  return null;
}

// ===========================================================================
export function buildMonteRingger(ctx, tm, opts = {}) {
  const { planet, scene } = ctx;
  const avoidDirs = (opts.avoidDirs || []).map((a) => (a.clone ? a.clone().normalize() : new THREE.Vector3().fromArray(a).normalize()));

  const site = scanPlainsSite(planet, avoidDirs);
  if (!site) return null;

  // --- fixed tangent frame at the peak axis ---
  const mDir = site.dir.clone().normalize();
  const up = new THREE.Vector3(), north = new THREE.Vector3(), east = new THREE.Vector3();
  frameAt(mDir, up, north, east);
  const baseR = planet.radius + planet.groundAtLocal(mDir);
  const seed = hashDir(mDir);
  const nz = makeNoise(seed);
  const rnd = mulberry32(seed ^ 0x9e37);

  // Pad sized so its FLAT core (212) clears the whole heightfield (210): every
  // surfaceH sample then sits cleanly above baseR with no terrain lookup.
  addPad(mDir, PAD_ANG, baseR, PAD_BLEND);
  const excl = addSurfaceExclusion(mDir, 216, 183, 26);

  // --- local <-> world maps (exact inverses) --------------------------------
  const _d = new THREE.Vector3();
  function dirOf(lx, lz, out) {
    return out.copy(mDir).multiplyScalar(baseR).addScaledVector(east, lx).addScaledVector(north, lz).normalize();
  }
  function worldOf(lx, lz, lift, out) {
    dirOf(lx, lz, _d);
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

  // --- radial profile -------------------------------------------------------
  // s = 1 - r/R_BASE : 0 at the rim, 1 on the axis
  function shape(s) {
    return APR * sm01(s / 0.34)
         + BODY * sm01((s - 0.22) / 0.68)
         + SPI * sm01((s - 0.66) / 0.34);
  }
  function shapeD(s) {
    return APR * smd01(s / 0.34) / 0.34
         + BODY * smd01((s - 0.22) / 0.68) / 0.68
         + SPI * smd01((s - 0.66) / 0.34) / 0.34;
  }

  // --- subsidiary shoulders (layered ridgelines) + summit teeth --------------
  const SHOULDERS = [];
  for (let i = 0; i < 3; i++) {
    SHOULDERS.push({
      u: 0.34 + rnd() * 0.24,                 // fraction of R_BASE
      phi: rnd() * Math.PI * 2,
      h: 34 + rnd() * 30,
      sr: 26 + rnd() * 16,
      sphi: 0.26 + rnd() * 0.18,
    });
  }
  // the crown: a cluster of sharp teeth. Linear falloff (not Gaussian) keeps the
  // tips genuinely pointed instead of rounding them into domes.
  // Held off the axis (r >= 16) so they ring the true summit rather than
  // out-topping it — you climb to the high point and they frame the view.
  const TEETH = [];
  for (let i = 0; i < 5; i++) {
    TEETH.push({
      r: 20 + rnd() * 28,
      phi: rnd() * Math.PI * 2,
      h: 20 + rnd() * 30,
      rad: 8 + rnd() * 8,
    });
  }
  function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
  function shoulders(r, phi) {
    let v = 0;
    for (let i = 0; i < SHOULDERS.length; i++) {
      const s = SHOULDERS[i];
      const dr = r - s.u * R_BASE;
      const dp = wrapPi(phi - s.phi);
      v += s.h * Math.exp(-(dr * dr / (2 * s.sr * s.sr) + dp * dp / (2 * s.sphi * s.sphi)));
    }
    return v;
  }
  function teeth(lx, lz, r) {
    if (r > 62) return 0;
    let v = 0;
    for (let i = 0; i < TEETH.length; i++) {
      const t = TEETH[i];
      const tx = Math.cos(t.phi) * t.r, tz = Math.sin(t.phi) * t.r;
      const dd = Math.hypot(lx - tx, lz - tz);
      if (dd < t.rad) v += t.h * Math.pow(1 - dd / t.rad, 1.4); // linear-ish => sharp tip
    }
    return v;
  }

  // --- relief noise ---------------------------------------------------------
  // Amplitude tracks the profile height, so the meadow stays a gentle walkable
  // apron while the upper mountain breaks up into real ridges, gullies and
  // crags. Two ridged octaves give the crests; the angular `spur` term adds
  // buttresses running down the fall line, which is what reads as "alpine"
  // rather than "noisy dome".
  function mountainRelief(lx, lz, r, s) {
    const envRim = sm01(s / 0.16);                       // -> 0 at the rim: seamless
    const amp = clamp(Math.pow(shape(s), 0.45) * 1.30, 0.06, 1.20);
    const R1 = nz.ridged(lx * 0.016, lz * 0.016, 2.5, 5);      // broad ridgelines
    const R2 = nz.ridged(lx * 0.055, lz * 0.055, -7.1, 4);     // crags
    const med = nz.fbm(lx * 0.030, lz * 0.030, 5.1, 4);
    const fine = nz.fbm(lx * 0.110, lz * 0.110, -2.3, 3);
    const phi = Math.atan2(lz, lx);
    // sampled on a circle in noise space => seam-free across phi = ±pi
    const spur = nz.ridged(Math.cos(phi) * 2.6, Math.sin(phi) * 2.6, s * 1.1 + 3.7, 3);
    return envRim * amp * (
      58 * (R1 - 0.42)
      + 18 * (R2 - 0.42)
      + 12 * med
      + 3.5 * fine
      + 30 * (spur - 0.42) * sm01(s / 0.55)
    );
  }

  // --- spiral switchback trail ---------------------------------------------
  // Perfectly concentric arms read as machined terraces, so let the switchbacks
  // wander a little the way a real cut trail does. closestT still inverts the
  // ANGLE analytically (unchanged) and refines numerically, so this is free.
  function radAt(t) {
    // wander fades out at the top so the final approach to the summit is stable
    const w = 1 - sm01((t - 0.78) / 0.22);
    return Math.max(3, R_TRAIL0 * (1 - SHRINK * t)
      + (Math.sin(t * 17.3 + 1.7) * 6.5 + Math.sin(t * 6.1 + 4.2) * 4.5) * w);
  }
  function angleAt(t) { return t * Math.PI * 2 * TURNS; }
  // The bench sits at the mountain's OWN elevation for its radius, so the trail
  // is cut into rock rather than carried on a viaduct — then over the last
  // stretch it climbs the final scramble onto the true crown.
  function trailH(t) {
    const base = H_TOP * shape(1 - radAt(t) / R_BASE);
    return lerp(base, CROWN_H, sm01((t - 0.84) / 0.16));
  }
  // Path width tapers to a narrow scramble near the top, so the last section
  // doesn't bulldoze the summit spire flat.
  function hwAt(t) { return lerp(TRAIL_HW, 2.8, sm01((t - 0.80) / 0.20)); }
  function carveAt(t) { return lerp(CARVE_OUT, 4.2, sm01((t - 0.80) / 0.20)); }
  const _c = { x: 0, z: 0, h: 0 };
  function centerAt(t, out) {
    const a = angleAt(t), r = radAt(t);
    out.x = Math.cos(a) * r; out.z = Math.sin(a) * r; out.h = trailH(t);
    return out;
  }
  function distToC(lx, lz, t) {
    const a = angleAt(t), r = radAt(t);
    return Math.hypot(lx - Math.cos(a) * r, lz - Math.sin(a) * r);
  }
  // one candidate per turn + refine — correct where switchbacks stack
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

  // The mountain before the trail is cut into it, and before the teeth. Kept
  // separate so the summit height can be read without recursing through the
  // carve, and so the teeth can be measured against it.
  let HORN = 34;  // central horn making the axis the unambiguous high point
  function baseFieldH(lx, lz) {
    const r = Math.hypot(lx, lz);
    if (r >= R_BASE) return 0;                            // rim: exactly zero
    const s = 1 - r / R_BASE;
    const horn = HORN * Math.pow(clamp(1 - r / 30, 0, 1), 1.35);
    const h = H_TOP * shape(s) + mountainRelief(lx, lz, r, s)
            + shoulders(r, Math.atan2(lz, lx)) + horn;
    return h < 0 ? 0 : h;
  }
  function rawH(lx, lz) {
    const r = Math.hypot(lx, lz);
    if (r >= R_BASE) return 0;
    return baseFieldH(lx, lz) + teeth(lx, lz, r);
  }

  // Guarantee the axis really is the top. Ridged noise is free to throw a crest
  // higher than the centre, so measure the summit region and raise the horn
  // until the axis wins — otherwise you climb to the top and a crag blocks the
  // view you came for.
  function maxOver(fn, radius, n) {
    let m = 0;
    for (let i = 0; i < n; i++) {
      const a = i * 2.39996, rr = Math.sqrt(i / n) * radius;
      m = Math.max(m, fn(Math.cos(a) * rr, Math.sin(a) * rr));
    }
    return m;
  }
  for (let pass = 0; pass < 4; pass++) {
    const axis = baseFieldH(0, 0);
    const mx = maxOver(baseFieldH, 130, 6000);
    if (mx <= axis - 12) break;
    HORN = Math.min(HORN + (mx - axis) + 14, 130);   // bounded: keeps the peak inside
  }                                                   // the atmosphere shell on any seed
  // Then cap every tooth so its apex stays below the crown.
  const SUM_X = 0, SUM_Z = 0;                             // the summit IS the axis
  const CROWN_H = baseFieldH(0, 0);                       // teeth never reach the axis
  for (const t of TEETH) {
    const tx = Math.cos(t.phi) * t.r, tz = Math.sin(t.phi) * t.r;
    t.h = Math.min(t.h, CROWN_H - 6 - baseFieldH(tx, tz));
    if (t.h < 3) t.h = 0;
  }
  const SUM_H = CROWN_H;

  // --- THE height function: mesh, collision and scatter all read this --------
  function surfaceH(lx, lz) {
    const r = Math.hypot(lx, lz);
    if (r >= R_BASE) return 0;
    let h = rawH(lx, lz);
    // bench carve: one symmetric lerp IS a cut-bank uphill + a fill shoulder
    // downhill. Inside the half-width the weight is exactly 1, so the walkable
    // surface is identically trailH and floor() can never disagree with the mesh.
    const t = closestT(lx, lz);
    centerAt(t, _c);
    const off = Math.hypot(lx - _c.x, lz - _c.z);
    const co = carveAt(t);
    if (off < co) h = lerp(h, _c.h, 1 - sstep(hwAt(t), co, off));
    // a small standing perch at the very top, level with the crown so the summit
    // keeps its height — just flat enough to stand on
    if (r < SUM_R + 4) h = lerp(h, SUM_H, 1 - sstep(SUM_R, SUM_R + 4, r));
    return h;
  }

  // mirror of walk.js floorRadius' pad blend (note: THREE's smoothstep takes x first)
  function padGroundAt(dir) {
    const g = planet.radius + planet.groundAtLocal(dir);
    const c = clamp(dir.dot(mDir), -1, 1);
    if (c < Math.cos(PAD_ANG)) return g;
    const ang = Math.acos(Math.min(c, 1));
    const t = THREE.MathUtils.smoothstep(ang, PAD_ANG * (1 - PAD_BLEND), PAD_ANG);
    return Math.max(g, THREE.MathUtils.lerp(baseR, g, t));
  }

  // --- coarse height grid: sun-shadow marching + scatter read this ----------
  const G = 129, GS = (2 * R_BASE) / (G - 1);
  const grid = new Float32Array(G * G);
  for (let j = 0; j < G; j++) {
    const lz = -R_BASE + j * GS;
    for (let i = 0; i < G; i++) grid[j * G + i] = surfaceH(-R_BASE + i * GS, lz);
  }
  function gridH(lx, lz) {
    const fx = clamp((lx + R_BASE) / GS, 0, G - 1.001);
    const fz = clamp((lz + R_BASE) / GS, 0, G - 1.001);
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j;
    const a = grid[j * G + i], b = grid[j * G + i + 1];
    const cc = grid[(j + 1) * G + i], dd = grid[(j + 1) * G + i + 1];
    return lerp(lerp(a, b, u), lerp(cc, dd, u), v);
  }

  // ==========================================================================
  // Collision — one source of truth, plus a scree slide off the bench
  let lastDt = 1 / 60;
  const _n = new THREE.Vector3();
  const resolver = {
    floor(P) {
      if (!localOf(P)) return -Infinity;
      const d = Math.hypot(_L.lx, _L.lz);
      if (d > R_BASE + RIM_MARGIN) return -Infinity;
      const surf = surfaceH(_L.lx, _L.lz);
      if (surf <= 0) return -Infinity;                    // rim band: the pad owns it
      // No "too far below" guard here: spawnAt() and the vehicle floor query
      // both ask without a radius (lift reads ~0), and rejecting them would drop
      // a teleport or a spawn INSIDE the rock. The mountain is simply solid.
      return baseR + surf;
    },
    wall(P) {
      if (!localOf(P)) return;
      if (Math.hypot(_L.lx, _L.lz) > R_BASE) return;
      const t = closestT(_L.lx, _L.lz);
      centerAt(t, _c);
      const ex = _L.lx - _c.x, ez = _L.lz - _c.z, off = Math.hypot(ex, ez);
      // free to move around on the summit perch itself
      if (Math.hypot(_L.lx, _L.lz) < SUM_R + 3) return;
      const hw = hwAt(t);
      if (off <= hw + 1.0) return;                        // on the bench: walk freely
      // (1) stepping off the bench where the trail is already high: pull back onto
      // it. Only within the engineered shoulder — past that you're on wild rock.
      if (_c.h >= RAMP_GATE && off < carveAt(t) + 4 && off > 1e-4) {
        _n.copy(east).multiplyScalar(-ex / off).addScaledVector(north, -ez / off);
        P.addScaledVector(_n, off - hw);
        return;
      }
      // (2) wild rock: gentle ground is walkable, scree slides you back down
      const e = 1.2;
      const gx = (surfaceH(_L.lx + e, _L.lz) - surfaceH(_L.lx - e, _L.lz)) / (2 * e);
      const gz = (surfaceH(_L.lx, _L.lz + e) - surfaceH(_L.lx, _L.lz - e)) / (2 * e);
      const g = Math.hypot(gx, gz);
      if (g <= SCREE_TAN) return;
      const k = Math.min((g - SCREE_TAN) / SCREE_RAMP, 1);
      _n.copy(east).multiplyScalar(-gx / g).addScaledVector(north, -gz / g);
      P.addScaledVector(_n, SLIDE_RATE * k * lastDt);
    },
  };
  addStructureResolver(resolver);

  // ==========================================================================
  // Mesh
  const group = new THREE.Group();
  scene.add(group);

  // adaptive polar rings: dense at the spire, coarse over the meadow + skirt
  const ringR = [];
  for (let r = 1.8; r < R_BASE - 0.5;) {
    ringR.push(r);
    r += clamp(0.030 * r, 1.8, 3.6);
  }
  ringR.push(R_BASE);
  for (let r = R_BASE + 9; r < R_MESH; r += 9) ringR.push(r);
  ringR.push(R_MESH);
  const NR = ringR.length, NS = 256, ROW = NS + 1;

  const vCount = NR * ROW + 1;                            // +1 apex
  const positions = new Float32Array(vCount * 3);
  const colors = new Float32Array(vCount * 3);
  const hArr = new Float32Array(NR * ROW);
  const _w = new THREE.Vector3(), _dv = new THREE.Vector3();

  // pass 1 — positions + heights
  for (let i = 0; i < NR; i++) {
    const r = ringR[i];
    const phase = (i & 1) ? Math.PI / NS : 0;             // stagger kills radial spokes
    for (let j = 0; j < ROW; j++) {
      const a = (j % NS) * (Math.PI * 2 / NS) + phase;
      const lx = Math.cos(a) * r, lz = Math.sin(a) * r;
      let lift;
      if (r <= R_BASE) {
        lift = surfaceH(lx, lz);
        if (r > 120) {
          // never let the detail patch poke through where terrain exceeds baseR
          const pg = padGroundAt(dirOf(lx, lz, _dv)) - baseR;
          if (pg > lift) lift = pg;
        }
      } else {
        const tuck = sstep(R_BASE, R_MESH, r) * 34;
        lift = padGroundAt(dirOf(lx, lz, _dv)) - baseR - tuck;
      }
      const k = i * ROW + j;
      hArr[k] = lift;
      worldOf(lx, lz, lift, _w);
      positions[k * 3] = _w.x; positions[k * 3 + 1] = _w.y; positions[k * 3 + 2] = _w.z;
    }
  }
  const apex = NR * ROW;
  worldOf(0, 0, surfaceH(0, 0), _w);
  positions[apex * 3] = _w.x; positions[apex * 3 + 1] = _w.y; positions[apex * 3 + 2] = _w.z;

  // pass 2 — slope, cavity, baked sun shadow, banded colour
  const sunL = { x: SUN.dot(east), z: SUN.dot(north), u: SUN.dot(mDir) };
  const sunHL = Math.hypot(sunL.x, sunL.z) || 1e-4;
  const sunAx = sunL.x / sunHL, sunAz = sunL.z / sunHL, sunTan = sunL.u / sunHL;

  const cMeadow = new THREE.Color(0x5f7a3a);   // == terrainDetail cGrass: invisible seam
  const cMeadowIn = new THREE.Color(0x6b8a3f);
  const cMoss = new THREE.Color(0x415f2c);
  const cScree = new THREE.Color(0x9c8a5e);    // == cSand
  const cRockW = new THREE.Color(0x6a5f52);    // == cRock
  const cRockG = new THREE.Color(0x7c7a76);
  const cSnow = new THREE.Color(0xdfe7f0);
  const cLichen = new THREE.Color(0x8f9a5e);
  const cWarm = new THREE.Color(0xffdba1);
  const cCool = new THREE.Color(0x7f95c8);
  const _col = new THREE.Color();

  for (let i = 0; i < NR; i++) {
    const r = ringR[i];
    const rm = Math.max(r, 2);
    const dR = (ringR[Math.min(i + 1, NR - 1)] - ringR[Math.max(i - 1, 0)]) || 1;
    const dPhi = (Math.PI * 2 / NS) * 2;
    const phaseC = (i & 1) ? Math.PI / NS : 0;
    for (let j = 0; j < ROW; j++) {
      const k = i * ROW + j;
      const h = hArr[k];
      const ang = (j % NS) * (Math.PI * 2 / NS) + phaseC;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const lx = ca * r, lz = sa * r;
      const jm = (j - 1 + NS) % NS, jp = (j + 1) % NS;
      const hUp = hArr[Math.min(i + 1, NR - 1) * ROW + j];
      const hDn = hArr[Math.max(i - 1, 0) * ROW + j];
      const hL = hArr[i * ROW + jm], hR = hArr[i * ROW + jp];
      const gR = (hUp - hDn) / dR;
      const gP = (hR - hL) / (dPhi * rm);
      const grad = Math.hypot(gR, gP);
      const cav = h - 0.25 * (hUp + hDn + hL + hR);

      // cast shadow: march the coarse grid toward the sun
      let shadow = 1;
      if (r < R_BASE) {
        for (let m = 4; m <= 96; m += 4) {
          const sh = gridH(lx + sunAx * m, lz + sunAz * m);
          if (sh > h + sunTan * m + 0.5) { shadow = 0.62; break; }
        }
      }

      const a = clamp(h / H_TOP, 0, 1);
      _col.copy(r > R_BASE - 26 ? cMeadow : cMeadowIn);
      if (cav < 0 && a < 0.10) _col.lerp(cMoss, clamp(-cav * 0.35, 0, 0.55));
      _col.lerp(cScree, sstep(0.05, 0.17, a));
      _col.lerp(cRockW, sstep(0.15, 0.36, a));
      _col.lerp(cRockG, sstep(0.42, 0.74, a));
      _col.lerp(cRockG, sstep(0.55, 1.15, grad));          // steep anywhere -> bare rock
      if (a > 0.08 && a < 0.5 && ((k * 2654435761) >>> 0) % 100 < 30) _col.lerp(cLichen, 0.25);
      // snow above the snowline, sliding off the steepest faces and lingering in
      // shaded crevices — the "snow-dusted summit / residual snow" of the brief
      const snowMask = sstep(0.50, 0.86, a) * (0.30 + 0.70 * (1 - sstep(0.55, 1.5, grad)))
                     + sstep(0.28, 0.95, a) * clamp(-cav * 0.30, 0, 0.55)
                     + (shadow < 1 ? sstep(0.44, 0.80, a) * 0.16 : 0);
      _col.lerp(cSnow, clamp(snowMask, 0, 1) * 0.82);   // dusted, not buried

      const ao = clamp(0.60 + 0.40 * sstep(-3.0, 1.5, cav), 0, 1);
      _col.multiplyScalar(ao * shadow);
      // golden-hour east face / cool blue west slope, from the fixed sun.
      // surface normal in the local frame is normalize(-dH/dx, -dH/dz, 1)
      const gx = gR * ca - gP * sa;
      const gz = gR * sa + gP * ca;
      const lam = clamp((-gx * sunL.x - gz * sunL.z + sunL.u) / Math.sqrt(1 + gx * gx + gz * gz), -1, 1);
      if (lam > 0) _col.lerp(cWarm, lam * 0.14); else _col.lerp(cCool, -lam * 0.18);
      const grain = 0.92 + 0.16 * (((k * 1103515245 + 12345) >>> 8 & 255) / 255);
      _col.multiplyScalar(grain);

      colors[k * 3] = _col.r; colors[k * 3 + 1] = _col.g; colors[k * 3 + 2] = _col.b;
    }
  }
  _col.copy(cSnow).multiplyScalar(0.95);
  colors[apex * 3] = _col.r; colors[apex * 3 + 1] = _col.g; colors[apex * 3 + 2] = _col.b;

  const idx = [];
  for (let i = 0; i < NR - 1; i++) {
    for (let j = 0; j < NS; j++) {
      const a = i * ROW + j, b = a + 1, cc = a + ROW, dd = cc + 1;
      idx.push(a, cc, b, b, cc, dd);
    }
  }
  for (let j = 0; j < NS; j++) idx.push(apex, j, j + 1);   // apex fan (ring 0 is innermost)

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const uni = {
    uSunDir: { value: SUN.clone().normalize() },
    uBaseR: { value: baseR },
    uTopH: { value: H_TOP },
    uDetail: { value: 1.0 },
    uHaze: { value: new THREE.Color(0x171021) },
    uRim: { value: new THREE.Color(0xffcf8a) },
  };

  const rockMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.94, metalness: 0.0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  rockMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n  vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos;
        uniform vec3 uSunDir; uniform float uBaseR; uniform float uTopH;
        uniform float uDetail; uniform vec3 uHaze; uniform vec3 uRim;
        float mh( vec3 p ) { p = fract( p * 0.3183099 + 0.1 ) * 17.0;
          return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }
        float vn( vec3 p ) { vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix( mix( mix( mh(i), mh(i+vec3(1,0,0)), f.x ),
                           mix( mh(i+vec3(0,1,0)), mh(i+vec3(1,1,0)), f.x ), f.y ),
                      mix( mix( mh(i+vec3(0,0,1)), mh(i+vec3(1,0,1)), f.x ),
                           mix( mh(i+vec3(0,1,1)), mh(i+vec3(1,1,1)), f.x ), f.y ), f.z ); }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 wp = vWPos;
          vec3 nw = inverseTransformDirection( normal, viewMatrix );
          float dist = length( vViewPosition );
          // world-space 3D noise IS the tri-planar result: no stretching on the
          // 68-degree faces, no blend seams, one sample instead of three.
          vec3 q  = wp * 0.42;
          vec3 j0 = vec3( vn(q), vn(q + vec3(31.4,0.0,0.0)), vn(q + vec3(0.0,17.9,0.0)) ) - 0.5;
          float f1 = 1.0 - smoothstep( 60.0, 210.0, dist );
          nw = normalize( nw + j0 * ( 0.42 * f1 ) );
          float fineK = uDetail * ( 1.0 - smoothstep( 12.0, 46.0, dist ) );
          float gr = 0.0;
          if ( fineK > 0.01 ) {
            vec3 q2 = wp * 2.6;
            vec3 j1 = vec3( vn(q2), vn(q2 + vec3(7.7,0.0,0.0)), vn(q2 + vec3(0.0,5.3,0.0)) ) - 0.5;
            nw = normalize( nw + j1 * ( 0.30 * fineK ) );
            gr = j1.x * fineK;
          }
          normal = normalize( transformDirection( nw, viewMatrix ) );
          vec3 upv = normalize( wp );
          float upn = saturate( dot( nw, upv ) );
          float alt = ( length( wp ) - uBaseR ) / uTopH;
          // settles on ledges, slides off the faces — and stays light enough that
          // the baked rock banding still reads through it
          float snow = smoothstep( 0.60, 0.94, alt ) * smoothstep( 0.62, 0.92, upn );
          diffuseColor.rgb  = mix( diffuseColor.rgb, vec3(0.745,0.808,0.905), snow * 0.40 );
          diffuseColor.rgb *= 0.90 + 0.20 * ( j0.y + 0.5 ) + gr * 0.16;
          roughnessFactor   = mix( roughnessFactor, 0.60, snow );
          roughnessFactor   = clamp( roughnessFactor - upn * 0.05, 0.35, 1.0 );
        }`)
      .replace('#include <opaque_fragment>', `
        {
          vec3 V = normalize( vViewPosition );
          float fres = pow( 1.0 - saturate( dot( normal, V ) ), 3.0 );
          vec3 Lv = normalize( ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz );
          float back = saturate( -dot( normal, Lv ) );
          outgoingLight += uRim * ( fres * ( 0.22 + 0.78 * back ) * 0.38 );
          // local aerial perspective: scene fog starts at 260+, but everything on
          // the mountain is nearer than that, so without this the ridgelines read
          // flat. This is what makes them recede.
          float haze = smoothstep( 55.0, 340.0, length( vViewPosition ) ) * 0.20;
          outgoingLight = mix( outgoingLight, uHaze, haze );
        }
        #include <opaque_fragment>`);
  };

  const mountain = new THREE.Mesh(geo, rockMat);
  group.add(mountain);

  // --- trail ribbon: the worn dirt-and-scree surface on the carved bench ----
  function buildRibbon() {
    const NT = 900, ACROSS = 4;
    const pos = [], col = [], ix = [];
    const a = { x: 0, z: 0, h: 0 }, b = { x: 0, z: 0, h: 0 };
    const w = new THREE.Vector3();
    const cMid = new THREE.Color(0xa89268), cEdge = new THREE.Color(0x6f6047);
    for (let i = 0; i <= NT; i++) {
      const t = i / NT;
      centerAt(t, a);
      centerAt(Math.min(1, t + 1 / NT), b);
      let tx = b.x - a.x, tz = b.z - a.z;
      const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      const nx = -tz, nz = tx;
      for (let s = 0; s <= ACROSS; s++) {
        const u = (s / ACROSS) * 2 - 1;                   // -1 .. +1 across
        const wob = nz2(t * 40 + s) * 0.5;
        const off = u * (hwAt(t) - 0.5) + wob * (hwAt(t) / TRAIL_HW);
        worldOf(a.x + nx * off, a.z + nz * off, a.h + 0.12, w);
        pos.push(w.x, w.y, w.z);
        _col.copy(cMid).lerp(cEdge, Math.abs(u) * 0.85);
        _col.multiplyScalar(0.92 + 0.16 * (((i * 31 + s * 7) >>> 0 & 15) / 15));
        col.push(_col.r, _col.g, _col.b);
      }
    }
    const rw = ACROSS + 1;
    for (let i = 0; i < NT; i++) {
      for (let s = 0; s < ACROSS; s++) {
        const p0 = i * rw + s, p1 = p0 + 1, p2 = p0 + rw, p3 = p2 + 1;
        ix.push(p0, p2, p1, p1, p2, p3);
      }
    }
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g2.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g2.setIndex(ix);
    g2.computeVertexNormals();
    g2.computeBoundingSphere();
    const m = new THREE.Mesh(g2, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.98, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    }));
    m.renderOrder = 2;
    return m;
  }
  function nz2(x) { const v = Math.sin(x * 12.9898) * 43758.5453; return (v - Math.floor(v)) * 2 - 1; }
  group.add(buildRibbon());

  // ==========================================================================
  // Scatter: granite boulders, talus, alpine grass and wildflowers
  const _dummy = new THREE.Object3D();
  const _yAxis = new THREE.Vector3(0, 1, 0);
  const _qA = new THREE.Quaternion(), _qY = new THREE.Quaternion();
  const _sd = new THREE.Vector3();
  const scatterMeshes = [];

  function gridSlope(lx, lz) {
    const e = 2.5;
    const gx = (gridH(lx + e, lz) - gridH(lx - e, lz)) / (2 * e);
    const gz = (gridH(lx, lz + e) - gridH(lx, lz - e)) / (2 * e);
    return Math.hypot(gx, gz);
  }
  // `pad` is clearance beyond the path's local half-width, which narrows near the top
  function offTrail(lx, lz, pad) {
    const t = closestT(lx, lz);
    centerAt(t, _c);
    return Math.hypot(lx - _c.x, lz - _c.z) > hwAt(t) + pad;
  }
  function place(mesh, n, dir, h, yOff, yaw, sx, sy, sz, tilt, tint) {
    _dummy.position.copy(dir).multiplyScalar(baseR + h + yOff);
    _qA.setFromUnitVectors(_yAxis, dir);
    _qY.setFromEuler(new THREE.Euler(tilt ? (rnd() - 0.5) * 0.5 : 0, yaw, tilt ? (rnd() - 0.5) * 0.5 : 0));
    _dummy.quaternion.copy(_qA).multiply(_qY);
    _dummy.scale.set(sx, sy, sz);
    _dummy.updateMatrix();
    mesh.setMatrixAt(n, _dummy.matrix);
    if (tint) mesh.setColorAt(n, tint);
  }

  // fbm-displaced dodecahedra, the same recipe dressing.js uses for its rocks
  function boulderGeo(v) {
    const g = new THREE.DodecahedronGeometry(1, 1);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const d = nz.fbm(x * 1.4 + v * 8, y * 1.4, z * 1.4 - v * 4, 2) * 0.34;
      p.setXYZ(i, x + d, y * 0.78 + d * 0.4, z + d);
    }
    g.computeVertexNormals();
    return g;
  }
  // no vertexColors: the dodecahedra carry no colour attribute, so per-instance
  // instanceColor is the whole story (same as dressing.js's rocks)
  const bMat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0.02, flatShading: true });
  const boulders = [];
  for (let v = 0; v < 3; v++) {
    const m = new THREE.InstancedMesh(boulderGeo(v), bMat, 150);
    m.frustumCulled = false; m.count = 0;
    group.add(m); boulders.push(m); scatterMeshes.push(m);
  }
  const bCount = [0, 0, 0];
  for (let i = 0; i < 2600 && (bCount[0] + bCount[1] + bCount[2]) < 450; i++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * (R_BASE - 4);
    const lx = Math.cos(a) * r, lz = Math.sin(a) * r;
    const h = gridH(lx, lz);
    if (h <= 0.2) continue;
    const g = gridSlope(lx, lz);
    if (g < 0.35 || g > 1.6) continue;
    if (!offTrail(lx, lz, 0.8)) continue;
    // cluster along the trail edges and in mid-slope talus fields
    const t = closestT(lx, lz); centerAt(t, _c);
    const dTrail = Math.hypot(lx - _c.x, lz - _c.z);
    const near = dTrail < 14 ? 3 : 1;
    if (rnd() > 0.16 * near) continue;
    const v = i % 3;
    if (bCount[v] >= 150) continue;
    const s = 0.4 + Math.pow(rnd(), 2.2) * 3.2;
    const gs = 0.42 + rnd() * 0.28;
    _col.setRGB(gs, gs * (0.97 + rnd() * 0.05), gs * 0.94);
    if (h / H_TOP < 0.4 && rnd() < 0.3) _col.lerp(cLichen, 0.25);
    _col.multiplyScalar(clamp(0.72 + 0.28 * sstep(0, 1.2, g), 0.6, 1));
    place(boulders[v], bCount[v]++, dirOf(lx, lz, _sd), h, s * 0.1 - 0.15, rnd() * 6.28,
      s * (0.7 + rnd() * 0.6), s * (0.55 + rnd() * 0.5), s * (0.7 + rnd() * 0.6), true, _col.clone());
  }
  for (let v = 0; v < 3; v++) {
    boulders[v].count = bCount[v];
    boulders[v].instanceMatrix.needsUpdate = true;
    if (boulders[v].instanceColor) boulders[v].instanceColor.needsUpdate = true;
  }

  // alpine grass tufts + wildflowers on the meadow apron and lower trail
  const bladeGeo = new THREE.PlaneGeometry(0.26, 1, 1, 3);
  bladeGeo.translate(0, 0.5, 0);
  {
    const p = bladeGeo.attributes.position;
    const cAttr = new Float32Array(p.count * 3);
    // a greyscale root->tip ramp; the per-instance colour supplies the hue, so
    // the two multiply to a natural blade instead of double-darkening
    const root = new THREE.Color(0x8a8a8a), tip = new THREE.Color(0xffffff);
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      p.setX(i, p.getX(i) * (1 - y * 0.85));
      _col.copy(root).lerp(tip, y);
      cAttr[i * 3] = _col.r; cAttr[i * 3 + 1] = _col.g; cAttr[i * 3 + 2] = _col.b;
    }
    bladeGeo.setAttribute('color', new THREE.Float32BufferAttribute(cAttr, 3));
  }
  const grassTime = { value: 0 };
  const grassMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.9, side: THREE.DoubleSide,
    emissive: 0x1a2410, emissiveIntensity: 0.35,
  });
  grassMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = grassTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 iOrg = ( instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
          float ph = iOrg.x * 0.7 + iOrg.z * 0.9;
          transformed.x += sin( uTime * 1.7 + ph ) * 0.20 * position.y * position.y;
          transformed.z += cos( uTime * 1.3 + ph ) * 0.16 * position.y * position.y;
        #endif`);
  };
  const grass = new THREE.InstancedMesh(bladeGeo, grassMat, 3000);
  grass.frustumCulled = false; grass.count = 0;
  group.add(grass); scatterMeshes.push(grass);

  // small crossed quads, nestled down in the grass — a single flat card at this
  // size reads as a floating square
  const petal = mergeGeometries([
    new THREE.PlaneGeometry(0.17, 0.17).rotateY(Math.PI / 4),
    new THREE.PlaneGeometry(0.17, 0.17).rotateY(-Math.PI / 4),
  ], false);
  petal.translate(0, 0.3, 0);
  const flowerMat = new THREE.MeshStandardMaterial({ roughness: 0.8, side: THREE.DoubleSide });
  const flowers = new THREE.InstancedMesh(petal, flowerMat, 520);
  flowers.frustumCulled = false; flowers.count = 0;
  group.add(flowers); scatterMeshes.push(flowers);

  let gN = 0, fN = 0;
  for (let i = 0; i < 14000 && gN < 3000; i++) {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * (R_BASE - 2);
    const lx = Math.cos(a) * r, lz = Math.sin(a) * r;
    const h = gridH(lx, lz);
    if (h <= 0.15) continue;
    const alt = h / H_TOP;
    const t = closestT(lx, lz); centerAt(t, _c);
    const dTrail = Math.hypot(lx - _c.x, lz - _c.z);
    if (dTrail < TRAIL_HW + 0.6) continue;
    // meadow, plus a thin green fringe following the trail a little higher
    const ok = alt < 0.10 || (dTrail < 16 && alt < 0.22);
    if (!ok) continue;
    if (gridSlope(lx, lz) > 0.55) continue;
    if (nz.fbm(lx * 0.03, lz * 0.03, 11.3, 2) < -0.25) continue;   // patchy cover
    const s = 0.5 + rnd() * 0.7;
    _col.setHSL(0.24 + rnd() * 0.05, 0.42, 0.36 + rnd() * 0.14);
    place(grass, gN++, dirOf(lx, lz, _sd), h, -0.05, rnd() * 6.28, s, s * (0.8 + rnd() * 0.6), s, false, _col.clone());
    if (fN < 520 && rnd() < 0.17) {
      _col.setHSL(rnd() < 0.5 ? 0.13 + rnd() * 0.06 : 0.75 + rnd() * 0.15, 0.62, 0.62);
      place(flowers, fN++, dirOf(lx, lz, _sd), h, 0.1, rnd() * 6.28, s, s, s, false, _col.clone());
    }
  }
  grass.count = gN; grass.instanceMatrix.needsUpdate = true;
  if (grass.instanceColor) grass.instanceColor.needsUpdate = true;
  flowers.count = fN; flowers.instanceMatrix.needsUpdate = true;
  if (flowers.instanceColor) flowers.instanceColor.needsUpdate = true;

  // ==========================================================================
  // Trailhead sign, summit cairn + flag
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
  // outward = away from the mountain axis, in the tangent plane at that point
  const _o1 = new THREE.Vector3(), _o2 = new THREE.Vector3(), _outw = new THREE.Vector3();
  function outwardAt(lx, lz, out) {
    const r = Math.hypot(lx, lz);
    if (r < 1e-3) return out.copy(north);          // on the axis: no outward direction
    const k = 1 + 0.5 / r;
    worldOf(lx * k, lz * k, 0, _o1);
    worldOf(lx, lz, 0, _o2);
    return out.subVectors(_o1, _o2).normalize();
  }

  // Canvas aspect matches the board (20 x 3.9) so the lettering isn't stretched,
  // and the size is fitted to the actual measured width so nothing clips.
  function signTexture(text) {
    const cv = document.createElement('canvas');
    cv.width = 2048; cv.height = 400;
    const c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    const maxW = cv.width - 150;
    let size = 230;
    c.font = `700 ${size}px Georgia, serif`;
    const w = c.measureText(text).width;
    if (w > maxW) {
      size = Math.max(24, Math.floor(size * maxW / w));
      c.font = `700 ${size}px Georgia, serif`;
    }
    c.fillStyle = '#f5e1b8';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, cv.width / 2, cv.height / 2);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }
  const signTex = signTexture('MONT LE RINGGER');
  const signGroup = new THREE.Group();
  const beam = new THREE.MeshStandardMaterial({ color: 0x3a2f22, roughness: 0.85, metalness: 0.05 });
  for (const sx of [-9, 9]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 11, 10), beam);
    post.position.set(sx, 5.5, 0); signGroup.add(post);
  }
  const board = new THREE.Mesh(new THREE.BoxGeometry(20, 3.9, 0.14), beam);
  board.position.set(0, 7.2, 0); signGroup.add(board);
  // two front-facing panels back to back: readable from BOTH approaches, and
  // never mirrored the way a single DoubleSide plane would be
  function panel(flip) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(20, 3.9),
      new THREE.MeshBasicMaterial({ map: signTex, transparent: true, toneMapped: false, side: THREE.FrontSide, depthWrite: false }));
    m.position.set(0, 7.2, flip ? -0.36 : 0.36);
    if (flip) m.rotation.y = Math.PI;
    return m;
  }
  signGroup.add(panel(false), panel(true));
  const SGN_X = 176, SGN_Z = 13;
  placeLocal(signGroup, SGN_X, SGN_Z, surfaceH(SGN_X, SGN_Z), outwardAt(SGN_X, SGN_Z, _outw));
  group.add(signGroup);

  const summitGroup = new THREE.Group();
  const cairnMat = new THREE.MeshStandardMaterial({ color: 0xb9b2a4, roughness: 0.9, metalness: 0.05, flatShading: true });
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
  // just off the axis, so there is clear ground to stand on at the very top
  const CRN_X = 2.6, CRN_Z = 0.6;
  placeLocal(summitGroup, CRN_X, CRN_Z, surfaceH(CRN_X, CRN_Z), outwardAt(CRN_X, CRN_Z, _outw));
  group.add(summitGroup);

  // --- interactions + compass ----------------------------------------------
  const summitWorld = worldOf(SUM_X, SUM_Z, SUM_H, new THREE.Vector3());
  addInteractable({
    pos: summitWorld.clone(), radius: 9,
    prompt: 'Take in the view &nbsp; <b>E</b>',
    action: () => showCard({
      kicker: 'Mont Le Ringger · the summit',
      title: 'The world, laid out below',
      meta: `${Math.round(CROWN_H)} units above the plains — the true summit`,
      body: [
        'You stand on the very top, the cairn beside you and the flag snapping in the thin wind. The rock teeth ring the crown just below, and the switchbacks fall away beneath your boots, band after band of scree and broken granite.',
        'The plains roll out to a curved horizon six hundred paces away, and beyond it the world simply bends out of sight. Settlements are pinpricks. The clouds are below you.',
      ],
    }),
  });
  const thX = R_TRAIL0, thZ = 0;
  addInteractable({
    pos: worldOf(thX, thZ, surfaceH(thX, thZ) + 2, new THREE.Vector3()), radius: 7,
    prompt: '<b>E</b> — Mont Le Ringger',
    action: () => showCard({
      kicker: 'trailhead',
      title: 'Mont Le Ringger',
      body: [
        'A jagged, snow-dusted peak standing three hundred units out of the plains. The trail leaves the meadow here as a narrow dirt-and-scree switchback and climbs, band by band, to the summit spire.',
        'It is the only way up — the faces to either side are loose scree and will slide you straight back down. Stay on the path. It is an arduous walk, and the view at the cairn is worth every step.',
      ],
    }),
  });

  const compass = [{ name: 'Mont Le Ringger', pos: mDir.clone().multiplyScalar(baseR + CROWN_H + 10) }];

  // --- per-frame ------------------------------------------------------------
  let trimmed = false;
  function tick(dt, t) {
    lastDt = clamp(dt, 1 / 240, 1 / 20);
    grassTime.value = t;
    flag.rotation.y = Math.sin(t * 2) * 0.35;
    flag.rotation.z = Math.sin(t * 3.3) * 0.06;
    // keep the local haze locked to whatever weather is doing to the fog
    if (scene.fog) uni.uHaze.value.copy(scene.fog.color);
    if (!trimmed && typeof window !== 'undefined' && window.__debug
        && window.__debug.quality && window.__debug.quality() === 'low') {
      trimmed = true;
      uni.uDetail.value = 0;
      grass.count = Math.min(gN, 1200);
      flowers.count = Math.min(fN, 200);
      for (let v = 0; v < 3; v++) boulders[v].count = Math.min(bCount[v], 80);
    }
  }

  function dispose() {
    removeStructureResolver(resolver);
    removeSurfaceExclusion(excl);
    if (group.parent) group.parent.remove(group);
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
      }
      if (o.isInstancedMesh) o.dispose();
    });
  }

  if (typeof window !== 'undefined') {
    window.__monteRingger = {
      dir: mDir.toArray(),
      dist: site.dist,
      sunUp: site.sunUp,
      base: () => teleportTo(planet, worldOf(R_TRAIL0 + 12, 0, 0, new THREE.Vector3()).normalize()),
      summit: () => teleportTo(planet, summitWorld.clone().normalize()),
      floorAt: (arr) => resolver.floor(new THREE.Vector3().fromArray(arr)),
      heightAt: (lx, lz) => surfaceH(lx, lz),
      // stand at a local spot and face the peak (or away from it) — for tests
      viewFrom: (lx, lz, pitchDeg = 0, outward = false) => {
        const w = window.__debug && window.__debug.walk;
        teleportTo(planet, dirOf(lx, lz, new THREE.Vector3()));
        if (!w) return;
        const u = w.player.clone().normalize();
        const to = mDir.clone().addScaledVector(u, -mDir.dot(u));
        if (to.lengthSq() > 1e-8) {
          to.normalize();
          w.heading.copy(outward ? to.negate() : to);
        }
        w.pitch = (pitchDeg * Math.PI) / 180;
      },
      probe: () => {
        const mid = centerAt(0.5, { x: 0, z: 0, h: 0 });
        const on = resolver.floor(worldOf(mid.x, mid.z, mid.h, new THREE.Vector3()));
        // At angle 0 the arms sit at t = k/TURNS; halfway between two of them is
        // wild rock, well below the arm above it.
        const gapR = (radAt(1 / TURNS) + radAt(2 / TURNS)) / 2;
        const off = resolver.floor(worldOf(gapR, 0, mid.h, new THREE.Vector3()));
        const far = resolver.floor(LANDING_DIR.clone().multiplyScalar(baseR));
        // scree slide: pushing an off-trail point must move it, and must not oscillate
        const p1 = worldOf(gapR, 0, gridH(gapR, 0), new THREE.Vector3());
        const p0 = p1.clone();
        resolver.wall(p1);
        const moved = p1.distanceTo(p0);
        const p2 = p1.clone(); resolver.wall(p2);
        return {
          baseR, expectMid: baseR + mid.h, on, off, far, moved,
          moved2: p2.distanceTo(p1), verts: vCount, tris: idx.length / 3,
          boulders: bCount[0] + bCount[1] + bCount[2], grass: gN, flowers: fN,
          trailTop: trailH(1), crown: surfaceH(0, 0), rawCrown: CROWN_H,
          // the summit must be reachable: standing floor at the axis, and the
          // path's top must arrive at the crown rather than stopping below it
          summitFloor: resolver.floor(worldOf(0, 0, CROWN_H, new THREE.Vector3())) - baseR,
          // nothing on the mountain may out-top the perch
          maxAnywhere: (() => {
            let m = 0;
            for (let i = 0; i < 4000; i++) {
              const a = i * 2.39996, rr = Math.sqrt(i / 4000) * 90;
              m = Math.max(m, surfaceH(Math.cos(a) * rr, Math.sin(a) * rr));
            }
            return m;
          })(),
        };
      },
    };
  }

  return { compass, updaters: [tick], dir: mDir, dispose };
}
