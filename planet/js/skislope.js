// Val Feelgood — a snow-plains ski resort: one groomed piste down a real
// mountain, a rideable chairlift to the summit, a rental shack at the top, and
// a terrain park (three kickers and a half-pipe) carved into the run.
//
// The mountain follows the Mont Le Ringger discipline exactly: it is ONE pure
// height function, `surfaceH(lx, lz)`, in a fixed tangent frame — and that
// single function is the rendered mesh, the collision floor, and the scatter
// placement. The piste, the terraces, the kickers and the half-pipe are all
// analytic terms INSIDE surfaceH, so the lip you see is the lip you launch off.
//
// The frame is rotated so +lz runs downhill toward the sun's azimuth: the ski
// face sits in permanent afternoon light. The footprint is an ellipse
// (R_WIDE x R_LONG) rather than a disc, because a ski mountain is a long face,
// not a cone.
//
// Snowboarding is a vehicle (vehicles.js) whose def carries its own
// step/orient/camera: gravity accelerates you along the local downhill
// gradient, carving kills lateral slip, and air happens when the floor falls
// away faster than a glued board could follow — so kicker lips and the pipe
// wall throw you with the momentum you actually carried, no canned tricks.
// The chairlift is NOT a vehicle: chairs loop on a cable as ambient animation,
// and riding one simply parents the walker to a seat until the top station.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { C, LANDING_DIR, SUN } from './config.js';
import { biomeAt } from './biomes.js';
import { frameAt, addSurfaceExclusion, removeSurfaceExclusion } from './layout.js';
import {
  walk, addStructureResolver, removeStructureResolver, addPad, addCollider,
  teleportTo, spawnAt, floorRadiusAt, waterDepthAt, updateWalkCamera,
} from './walk.js';
import { addInteractable } from './interact.js';
import { showCard, showDialogue, showHint } from './hud.js';
import { addVehicle, enterVehicle, exitVehicle, vehicleActive } from './vehicles.js';
import { input } from './input.js';
import { addWeatherRegion, removeWeatherRegion } from './weather.js';
import { mulberry32 } from './noise2.js';

// --- proportions (RADIUS=800, WALK_GRAVITY=24) ------------------------------
const R_WIDE = 170;      // heightfield half-extent across the face (lx)
const R_LONG = 280;      // heightfield half-extent along the fall line (lz)
const H_TOP = 160;       // summit height above baseR
const H_BASE = 6;        // base-terrace height (a groomed apron, not bare rim)
const LZ_TOP = -200;     // summit terrace centre (piste starts here)
const LZ_BASE = 232;     // base terrace centre (run-out ends here)
const PISTE_LEN = LZ_BASE - LZ_TOP;
const T_SUM_R = 20;      // summit terrace radius
const T_BASE_R = 24;     // base terrace radius
const SHOULDER = 76;     // half-width of the high shoulder the piste rides on
const RIM_MARGIN = 0.045; // floor() footprint cutoff beyond q=1
const SCREE_TAN = 0.70;  // off-piste steeper than 35° slides you (walkers only)
const SCREE_RAMP = 0.35;
const SLIDE_RATE = 24;

// Pad + exclusion mirror monteringger: the pad flattens the plains under the
// footprint so the rim meets real ground; the exclusion keeps foliage and the
// terrain-detail patch from poking through the mountain's own mesh.
const PAD_ANG = 0.36;
const PAD_BLEND = 0.18;

// --- terrain park -----------------------------------------------------------
// Kickers: approach ramp -> sharp lip -> dished landing, laterally faded so a
// slow rider can go around. All heights are offsets ON TOP of the piste grade.
const KICKERS = [
  { kz: 52, kx: -8, hk: 2.2 },
  { kz: 90, kx: 0, hk: 3.2 },
  { kz: 128, kx: 8, hk: 4.2 },
];
// Half-pipe: flat bottom F, wall radius RW, depth D below the deck. The wall
// follows the circle until it reaches deck level, so the heightfield stays
// single-valued and the gradient finite (~78° at the very lip).
const PIPE_Z0 = 150, PIPE_Z1 = 218;
const PIPE_F = 5, PIPE_RW = 7, PIPE_D = 5.5;
const PIPE_XMAX = Math.sqrt(PIPE_RW * PIPE_RW - (PIPE_RW - PIPE_D) * (PIPE_RW - PIPE_D));

// --- chairlift --------------------------------------------------------------
const LIFT_SPEED = 9;    // cable speed, units/s (base->summit in ~55 s)
const CHAIRS = 12;
const TOWERS = 6;
const TOWER_H = 11;      // cable height above ground at a tower
const STATION_H = 3.6;   // bullwheel axle height above a station platform
const HANG = 2.1;        // seat drop below the cable
const CABLE_GAP = 1.1;   // up/down cable lateral half-separation

// --- snowboard tuning -------------------------------------------------------
const TURN = 2.2;        // rad/s at full speed scale
const GRIP = 7;          // lateral slip decay (carving)
const GRIP_SKID = 1.8;   // ... while braking (S) — lets the tail slide out
const BRAKE = 10;        // u/s² speed scrub while braking
const DRAG = 0.0045;     // v² drag
const DRAG_TUCK = 0.0028; // ... while tucking (W)
const MAXV = 42;
const OLLIE = 6.5;       // Space pop, u/s

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function sstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
function sm01(x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); }
function lerp(a, b, t) { return a + (b - a) * t; }

// --- seeded 3D value noise (same family as monteringger/terrain) ------------
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
// Same two-stage scan as Mont Le Ringger, with a cold-latitude bias: the score
// prefers sites toward (but off) the polar ice, so the resort reads as "the
// snow plains" — high, dry, pale ground under a sky the weather region keeps
// snowing. Later passes relax everything so the resort essentially always lands.
const PASSES = [
  { minW: 0.50, minD: 520, maxD: 1250, avoid: 430, relief: 30, rimScale: 1.00, cold: 0.38, maxWet: 0 },
  { minW: 0.35, minD: 500, maxD: 1300, avoid: 400, relief: 44, rimScale: 0.90, cold: 0.30, maxWet: 0 },
  { minW: 0.20, minD: 480, maxD: 1350, avoid: 340, relief: 62, rimScale: 0.78, cold: 0.20, maxWet: 1 },
  { minW: 0.00, minD: 440, maxD: 1500, avoid: 280, relief: 92, rimScale: 0.64, cold: 0.00, maxWet: 3 },
];
const SHORTLIST = 220;

// Test the actual elliptical footprint (not the pad disc): 16 points around the
// ellipse at two radial fractions. The features all live inside ~0.85 of the
// footprint and the floor is max(mountain, terrain), so a couple of wet rim
// samples in the late passes is a shoreline at the meadow edge, not a drowned
// piste — hence maxWet.
function rimOk(planet, cand, pass) {
  const up = new THREE.Vector3(), n = new THREE.Vector3(), e = new THREE.Vector3();
  frameAt(cand.dir, up, n, e);
  const p = new THREE.Vector3();
  let lo = cand.g, hi = cand.g, wet = 0;
  const aW = (R_WIDE / C.RADIUS) * pass.rimScale;
  const aL = (R_LONG / C.RADIUS) * pass.rimScale;
  for (const frac of [1.0, 0.62]) {
    for (let k = 0; k < 16; k++) {
      const th = k * Math.PI / 8;
      const ax = aW * frac * Math.cos(th), az = aL * frac * Math.sin(th);
      const a = Math.hypot(ax, az);
      p.copy(cand.dir).multiplyScalar(Math.cos(a))
        .addScaledVector(e, Math.sin(a) * (a > 1e-9 ? ax / a : 0))
        .addScaledVector(n, Math.sin(a) * (a > 1e-9 ? az / a : 0)).normalize();
      const g = planet.groundAtLocal(p);
      if (g < 2.5) { if (++wet > pass.maxWet) return false; continue; }
      if (g < lo) lo = g;
      if (g > hi) hi = g;
    }
  }
  return (hi - lo) <= pass.relief;
}

function scanSnowSite(planet, avoidDirs) {
  const spawn = LANDING_DIR.clone().normalize();
  const sun = SUN.clone().normalize();
  const N = 6000, ga = Math.PI * (3 - Math.sqrt(5)), d = new THREE.Vector3();
  const stats = [];

  for (const pass of PASSES) {
    const st = { pole: 0, wet: 0, band: 0, sun: 0, biome: 0, cold: 0, avoid: 0, kept: 0, rim: 0 };
    stats.push(st);
    if (typeof window !== 'undefined') window.__skiScan = stats;
    const short = [];
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const rr = Math.sqrt(Math.max(0, 1 - y * y));
      const th = ga * i;
      d.set(Math.cos(th) * rr, y, Math.sin(th) * rr);
      if (Math.abs(d.y) > 0.72) { st.pole++; continue; }         // stay off the ice caps
      const g = planet.groundAtLocal(d);
      if (g < 4) { st.wet++; continue; }
      const dist = Math.acos(clamp(d.dot(spawn), -1, 1)) * planet.radius;
      if (dist < pass.minD || dist > pass.maxD) { st.band++; continue; }
      const sunUp = d.dot(sun);
      if (sunUp < 0.30) { st.sun++; continue; }                  // the face must see daylight
      const b = biomeAt(d);
      if (b.name !== 'plains' || b.plains < pass.minW) { st.biome++; continue; }
      const coldFit = sm01((Math.abs(d.y) - 0.28) / 0.26);
      if (coldFit < pass.cold) { st.cold++; continue; }
      let far = true;
      for (const a of avoidDirs) {
        if (Math.acos(clamp(d.dot(a), -1, 1)) * planet.radius < pass.avoid) { far = false; break; }
      }
      if (!far) { st.avoid++; continue; }
      st.kept++;
      const score = b.plains * 320 + coldFit * 260 - dist * 0.18
                  - Math.abs(sunUp - 0.45) * 200 + g * 5;
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
// Chairlift ride + snowboard state that the frame loop (main.js) reaches
// without a build handle. Everything is set by buildSkiSlope; before the build
// (or if the site scan somehow fails) all of these are inert.
let lift = null;        // { chairs, posAt, upLen, L, topSpawn(), basePos }
let rideChair = null;   // the chair the walker is parented to, or null
const board = { equipped: false, v: null, riding: false };
let fpCam = false;      // snowboard camera: first-person vs chase (KeyC)

const _rv = new THREE.Vector3();

export function skiRideActive() { return !!rideChair; }

// E while riding the lift: hop off mid-air, back into normal walk gravity.
export function skiLiftInteract() {
  if (!rideChair) return false;
  rideChair = null;
  walk.vUp = 0;
  walk.grounded = false;
  showHint('You slip off the chair and drop.');
  return true;
}

// While riding, the walker IS the seat: position copied every frame, look free.
export function stepSkiRide(dt) {
  if (!rideChair || !lift) return;
  const seat = rideChair.seat;
  _rv.copy(seat).normalize();
  walk.player.copy(seat).addScaledVector(_rv, -0.7); // feet just below the bench
  walk.vel.set(0, 0, 0);
  walk.vUp = 0;
  walk.grounded = false;
  // mouse look (same maths as stepWalk, minus movement)
  const yaw = -input.mouseX * C.LOOK_SENS;
  walk.pitch = clamp(walk.pitch - input.mouseY * C.LOOK_SENS, -C.MAX_PITCH, C.MAX_PITCH);
  input.mouseX = 0; input.mouseY = 0;
  walk.heading.addScaledVector(_rv, -walk.heading.dot(_rv));
  if (walk.heading.lengthSq() < 1e-8) walk.heading.set(_rv.z, _rv.x, _rv.y);
  walk.heading.normalize().applyAxisAngle(_rv, yaw);
  walk.heading.addScaledVector(_rv, -walk.heading.dot(_rv)).normalize();
  // top station: unload onto the summit terrace facing the piste
  if (rideChair.s > lift.upLen - 8 && rideChair.s < lift.upLen + 6) {
    rideChair = null;
    lift.topSpawn();
    showHint('Top station. The Summit Shack rents snowboards — E at the counter.');
  }
}

// Seat-eye first person: the walker's own camera already frames it right.
export function updateSkiRideCamera(camera) { updateWalkCamera(camera); }

// ===========================================================================
export function buildSkiSlope(ctx, tm, opts = {}) {
  const { planet, scene } = ctx;
  const getQuality = ctx.getQuality || (() => ctx.quality || 'high');
  const avoidDirs = (opts.avoidDirs || []).map((a) => (a.clone ? a.clone().normalize() : new THREE.Vector3().fromArray(a).normalize()));

  const site = scanSnowSite(planet, avoidDirs);
  if (!site) return null;

  // --- tangent frame, rotated so +lz (north) runs DOWNHILL toward the sun ---
  const mDir = site.dir.clone().normalize();
  const up = new THREE.Vector3(), fN = new THREE.Vector3(), fE = new THREE.Vector3();
  frameAt(mDir, up, fN, fE);
  const north = SUN.clone().addScaledVector(up, -SUN.dot(up)); // downhill azimuth
  if (north.lengthSq() < 1e-6) north.copy(fN);
  north.normalize();
  const east = new THREE.Vector3().crossVectors(north, up).normalize();
  const baseR = planet.radius + planet.groundAtLocal(mDir);
  const seed = hashDir(mDir);
  const nz = makeNoise(seed);
  const rnd = mulberry32(seed ^ 0x51ab);

  addPad(mDir, PAD_ANG, baseR, PAD_BLEND);
  const excl = addSurfaceExclusion(mDir, 268, 248, 30);
  // Snowy, but not permanently: the 'snow' state's near-white fog over a white
  // mountain is close to a whiteout, and you cannot read a piste you cannot see.
  const wxRegion = addWeatherRegion(mDir, Math.cos(0.55),
    ['clear', 'clear', 'snow', 'snow', 'cloudy', 'overcast', 'clear', 'foggy']);

  // --- local <-> world maps (exact inverses, gnomonic like monteringger) ----
  const _d = new THREE.Vector3();
  function dirOf(lx, lz, out) {
    return out.copy(mDir).multiplyScalar(baseR).addScaledVector(east, lx).addScaledVector(north, lz).normalize();
  }
  function worldOf(lx, lz, lift_, out) {
    dirOf(lx, lz, _d);
    return out.copy(_d).multiplyScalar(baseR + lift_);
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

  // --- the piste: centreline, width, grade ----------------------------------
  // The centreline wanders like a cut trail but straightens onto both terraces.
  function cx(lz) {
    const wob = 26 * Math.sin(lz * 0.011 + 1.3) + 14 * Math.sin(lz * 0.027);
    const fadeT = sm01((lz - (LZ_TOP + 8)) / 50);
    const fadeB = 1 - sm01((lz - (LZ_BASE - 58)) / 50);
    return wob * fadeT * fadeB;
  }
  // wider through the terrain park so there is room around the features
  function hwAt(lz) {
    return 16 + 6 * (sm01((lz - 16) / 25) * (1 - sm01((lz - 222) / 20)));
  }
  function coAt(lz) { return hwAt(lz) + 10; }
  // Monotone grade: a smoothstep profile is 0-sloped on both terraces and
  // peaks at 28° mid-run — 15–30° across the honest skiing band.
  function hp(lz) {
    const u = clamp((lz - LZ_TOP) / PISTE_LEN, 0, 1);
    const s = 1 - u;
    return H_BASE + (H_TOP - H_BASE) * s * s * (3 - 2 * s);
  }

  // --- terrain park features (offsets on top of the piste grade) ------------
  function kickerAt(off, lz) {
    let v = 0;
    for (let i = 0; i < KICKERS.length; i++) {
      const k = KICKERS[i];
      const a = lz - k.kz;
      if (a < -14 || a > 26) continue;
      const lat = 1 - sstep(5.5, 9.0, Math.abs(off - k.kx));
      if (lat <= 0) continue;
      let t;
      if (a < 0) t = k.hk * Math.pow(sm01((a + 14) / 14), 1.6);          // approach ramp
      else if (a < 0.8) t = k.hk * (1 - sm01(a / 0.8));                  // the lip
      else t = -1.2 * Math.sin(Math.PI * (a - 0.8) / 25.2);              // dished landing
      v += t * lat;
    }
    return v;
  }
  function pipeAt(off, lz) {
    if (lz < PIPE_Z0 || lz > PIPE_Z1) return 0;
    const fade = sm01((lz - PIPE_Z0) / 12) * (1 - sm01((lz - (PIPE_Z1 - 12)) / 12));
    if (fade <= 0) return 0;
    const x = Math.abs(off);
    let p = 0;
    if (x < PIPE_F) p = -PIPE_D;
    else if (x - PIPE_F < PIPE_XMAX) {
      const xr = x - PIPE_F;
      p = -PIPE_D + (PIPE_RW - Math.sqrt(PIPE_RW * PIPE_RW - xr * xr));
    }
    return p * fade;
  }
  function features(off, lz) { return kickerAt(off, lz) + pipeAt(off, lz); }

  // --- lift line local geometry (needs cx/hw; feeds a station mini-terrace) --
  const liftBaseLz = LZ_BASE - 2;
  const liftBaseLx = cx(liftBaseLz) - (hwAt(liftBaseLz) + 17);
  const STATION_B = { lx: liftBaseLx, lz: liftBaseLz, h: H_BASE + 1.2, r: 9 };
  const LIFT_TOP = { lx: -13, lz: LZ_TOP + 4 };

  // --- the mountain body -----------------------------------------------------
  function qOf(lx, lz) { return Math.hypot(lx / R_WIDE, lz / R_LONG); }
  // crest height along the fall line: the piste grade in front, a short steep
  // craggy wall behind the summit
  const BACK_SPAN = R_LONG * 0.98 + LZ_TOP;
  function crest(lz) {
    if (lz >= LZ_TOP) return hp(lz);
    return H_TOP * sm01((lz + R_LONG * 0.98) / BACK_SPAN);
  }
  function latEnv(lx, lz) {
    const wEdge = R_WIDE * Math.sqrt(Math.max(1e-4, 1 - (lz / R_LONG) * (lz / R_LONG)));
    const sh = Math.min(SHOULDER, wEdge * 0.55);
    const a = Math.abs(lx);
    if (a <= sh) return 1;
    return 1 - sm01((a - sh) / Math.max(wEdge - sh, 8));
  }
  function mountainRelief(lx, lz, q, body) {
    const s = 1 - q;
    const envRim = sm01(s / 0.14);
    if (envRim <= 0) return 0;
    // tame near the piste so the face stays honest; full crags on flanks/back
    const dOff = Math.abs(lx - cx(lz));
    const co = coAt(lz);
    const face = (lz > LZ_TOP - 10) ? (1 - sstep(co + 4, co + 60, dOff)) : 0;
    const ampK = lerp(1.0, 0.10, clamp(face, 0, 1));
    const amp = clamp(Math.pow(body / H_TOP, 0.5) * 1.1, 0.05, 1.0);
    const R1 = nz.ridged(lx * 0.014, lz * 0.014, 2.5, 4);
    const R2 = nz.ridged(lx * 0.05, lz * 0.05, -7.1, 3);
    const med = nz.fbm(lx * 0.03, lz * 0.03, 5.1, 3);
    const fine = nz.fbm(lx * 0.11, lz * 0.11, -2.3, 2);
    return envRim * ampK * amp * (40 * (R1 - 0.42) + 14 * (R2 - 0.42) + 9 * med + 2.5 * fine);
  }

  // --- THE height function: mesh, collision and scatter all read this --------
  function surfaceH(lx, lz) {
    const q = qOf(lx, lz);
    if (q >= 1) return 0;
    const body = crest(lz) * latEnv(lx, lz);
    let h = body + mountainRelief(lx, lz, q, body);
    if (h < 0) h = 0;
    // groomed piste: one symmetric lerp is a cut-bank + fill shoulder, and
    // inside the half-width the surface is identically grade + park features
    if (lz > LZ_TOP - 20 && lz < LZ_BASE + 34) {
      const off = lx - cx(lz);
      const co = coAt(lz);
      if (Math.abs(off) < co) {
        const target = hp(lz) + features(off, lz);
        h = lerp(h, target, 1 - sstep(hwAt(lz), co, Math.abs(off)));
      }
    }
    // flat terraces: summit (shop + lift top), base (lodge), lift base platform
    const dS = Math.hypot(lx, lz - LZ_TOP);
    if (dS < T_SUM_R + 14) h = lerp(h, H_TOP, 1 - sstep(T_SUM_R, T_SUM_R + 14, dS));
    const dB = Math.hypot(lx, lz - LZ_BASE);
    if (dB < T_BASE_R + 16) h = lerp(h, H_BASE, 1 - sstep(T_BASE_R, T_BASE_R + 16, dB));
    const dL = Math.hypot(lx - STATION_B.lx, lz - STATION_B.lz);
    if (dL < STATION_B.r + 8) h = lerp(h, STATION_B.h, 1 - sstep(STATION_B.r, STATION_B.r + 8, dL));
    return h;
  }

  // mirror of walk.js floorRadius' pad blend
  function padGroundAt(dir) {
    const g = planet.radius + planet.groundAtLocal(dir);
    const c = clamp(dir.dot(mDir), -1, 1);
    if (c < Math.cos(PAD_ANG)) return g;
    const ang = Math.acos(Math.min(c, 1));
    const t = THREE.MathUtils.smoothstep(ang, PAD_ANG * (1 - PAD_BLEND), PAD_ANG);
    return Math.max(g, THREE.MathUtils.lerp(baseR, g, t));
  }

  // --- coarse height grid: shadow marching, scatter and colour slopes -------
  const GX = 161, GZ = 201;
  const GSX = (2 * R_WIDE) / (GX - 1), GSZ = (2 * R_LONG) / (GZ - 1);
  const grid = new Float32Array(GX * GZ);
  for (let j = 0; j < GZ; j++) {
    const lz = -R_LONG + j * GSZ;
    for (let i = 0; i < GX; i++) grid[j * GX + i] = surfaceH(-R_WIDE + i * GSX, lz);
  }
  function gridH(lx, lz) {
    const fx = clamp((lx + R_WIDE) / GSX, 0, GX - 1.001);
    const fz = clamp((lz + R_LONG) / GSZ, 0, GZ - 1.001);
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j;
    const a = grid[j * GX + i], b = grid[j * GX + i + 1];
    const cc = grid[(j + 1) * GX + i], dd = grid[(j + 1) * GX + i + 1];
    return lerp(lerp(a, b, u), lerp(cc, dd, u), v);
  }
  function gridSlope(lx, lz) {
    const e = 3;
    const gx = (gridH(lx + e, lz) - gridH(lx - e, lz)) / (2 * e);
    const gz = (gridH(lx, lz + e) - gridH(lx, lz - e)) / (2 * e);
    return Math.hypot(gx, gz);
  }

  // ==========================================================================
  // Collision — one source of truth; scree slide only off-piste, walkers only
  let lastDt = 1 / 60;
  const _n = new THREE.Vector3();
  const resolver = {
    floor(P) {
      if (!localOf(P)) return -Infinity;
      const q = qOf(_L.lx, _L.lz);
      if (q > 1 + RIM_MARGIN) return -Infinity;
      const surf = surfaceH(_L.lx, _L.lz);
      if (surf <= 0) return -Infinity;                   // rim band: the pad owns it
      return baseR + surf;
    },
    wall(P) {
      if (!localOf(P)) return;
      if (qOf(_L.lx, _L.lz) >= 1) return;
      if (board.riding && vehicleActive()) return;       // the board runs its own physics
      // the groomed corridor, terraces and stations are always free to roam
      const off = Math.abs(_L.lx - cx(_L.lz));
      if (_L.lz > LZ_TOP - 20 && _L.lz < LZ_BASE + 34 && off < hwAt(_L.lz) + 1) return;
      if (Math.hypot(_L.lx, _L.lz - LZ_TOP) < T_SUM_R + 3) return;
      if (Math.hypot(_L.lx, _L.lz - LZ_BASE) < T_BASE_R + 3) return;
      if (Math.hypot(_L.lx - STATION_B.lx, _L.lz - STATION_B.lz) < STATION_B.r + 3) return;
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
  // Mesh — elliptical-polar rings for the mountain, plus a fine groomed ribbon
  const group = new THREE.Group();
  scene.add(group);

  const cSnow = new THREE.Color(0xdfe7f0);   // == monteringger / terrainDetail snow
  const cGroom = new THREE.Color(0xe9eff7);
  const cIce = new THREE.Color(0xcfe0f2);
  const cRockG = new THREE.Color(0x7c7a76);
  const cRockW = new THREE.Color(0x6a5f52);
  const cMeadow = new THREE.Color(0x5f7a3a);
  const cWarm = new THREE.Color(0xffe2b8);
  const cCool = new THREE.Color(0x8fa5cf);
  const _col = new THREE.Color();

  // baked sun, in the local frame (for the shadow march + warm/cool split)
  const sunL = { x: SUN.dot(east), z: SUN.dot(north), u: SUN.dot(mDir) };
  const sunHL = Math.hypot(sunL.x, sunL.z) || 1e-4;
  const sunAx = sunL.x / sunHL, sunAz = sunL.z / sunHL, sunTan = sunL.u / sunHL;
  // bias 2.2: the coarse grid over-reads the carved piste by a unit or two, and
  // a lower bias speckles the groomed flats with false self-shadow dots
  function marchShadow(lx, lz, h) {
    for (let m = 4; m <= 96; m += 4) {
      if (gridH(lx + sunAx * m, lz + sunAz * m) > h + sunTan * m + 2.2) return 0.68;
    }
    return 1;
  }

  const uni = {
    uSunDir: { value: SUN.clone().normalize() },
    uDetail: { value: 1.0 },
    uHaze: { value: new THREE.Color(0x171021) },
    uRim: { value: new THREE.Color(0xdfe9ff) },
    uAcross: { value: east.clone() },
  };
  // Snow shader: shared by the mountain and the ribbon. Per-pixel powder grain,
  // sparkle glints, corduroy micro-stripes on the groomed mask (aPiste), a cool
  // fresnel rim and the local aerial haze — the monteringger skeleton, re-tuned
  // from rock to snow.
  function snowShader(sh) {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPiste;\nvarying vec3 vWPos;\nvarying float vPiste;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n  vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n  vPiste = aPiste;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos; varying float vPiste;
        uniform vec3 uSunDir; uniform float uDetail; uniform vec3 uHaze; uniform vec3 uRim;
        uniform vec3 uAcross;
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
          // broad wind-packed drifts — two octaves so the lattice of a single
          // value-noise read doesn't print a dot grid on the smooth flats
          vec3 q  = wp * 0.30;
          vec3 j0 = vec3( vn(q), vn(q + vec3(31.4,0.0,0.0)), vn(q + vec3(0.0,17.9,0.0)) ) - 0.5;
          vec3 qb = wp * 0.113 + vec3(7.7, 3.1, 9.4);
          vec3 jb = vec3( vn(qb), vn(qb + vec3(11.1,0.0,0.0)), vn(qb + vec3(0.0,5.7,0.0)) ) - 0.5;
          j0 = j0 * 0.55 + jb * 0.45;
          // Kept gentle: a sunlit snowfield sits just under the bloom threshold,
          // and a stronger tilt flickers patches over it — which reads as a grid
          // of glowing dashes rather than as drifted snow.
          float f1 = 1.0 - smoothstep( 60.0, 220.0, dist );
          nw = normalize( nw + j0 * ( 0.055 * f1 * (1.0 - vPiste * 0.7) ) );
          float fineK = uDetail * ( 1.0 - smoothstep( 10.0, 44.0, dist ) );
          float gr = 0.0;
          if ( fineK > 0.01 ) {
            vec3 q2 = wp * 2.4;
            vec3 j1 = vec3( vn(q2), vn(q2 + vec3(7.7,0.0,0.0)), vn(q2 + vec3(0.0,5.3,0.0)) ) - 0.5;
            nw = normalize( nw + j1 * ( 0.14 * fineK ) );
            gr = j1.x * fineK;
            // Corduroy: fresh grooming stripes running down the piste. The
            // stripe is ~0.9 units, so past ~26 it goes sub-pixel and aliases
            // into bright blobs under the low sun — it gets its own tight fade
            // and stays shallow, and the far piste falls back to plain snow.
            float cordK = vPiste * ( 1.0 - smoothstep( 8.0, 26.0, dist ) );
            if ( cordK > 0.01 ) {
              float cord = sin( dot( wp, uAcross ) * 7.0 );
              nw = normalize( nw + uAcross * ( cord * 0.020 * cordK ) );
              gr += cord * 0.6 * cordK;
            }
          }
          normal = normalize( transformDirection( nw, viewMatrix ) );
          diffuseColor.rgb *= 0.965 + 0.07 * ( j0.y + 0.5 ) + gr * 0.045;
          roughnessFactor = mix( roughnessFactor, 0.70, vPiste * 0.6 );
          // Sparkle: rare bright grains where the fine noise peaks. The sample
          // domain is SHEARED, not axis-aligned — value noise read on a plane
          // parallel to its own lattice prints a regular dot grid, which on
          // ground this flat reads as a printed texture rather than as snow.
          if ( fineK > 0.01 ) {
            vec3 gp = vec3( dot( wp, vec3(  6.1, 2.9, -1.7 ) ),
                            dot( wp, vec3( -2.3, 5.4,  3.8 ) ),
                            dot( wp, vec3(  3.3, -1.9, 6.7 ) ) );
            float spark = smoothstep( 0.975, 0.998, vn( gp ) ) * fineK;
            diffuseColor.rgb += vec3( 0.22, 0.24, 0.28 ) * spark;
            roughnessFactor -= spark * 0.2;
          }
          roughnessFactor = clamp( roughnessFactor, 0.42, 1.0 );
        }`)
      .replace('#include <opaque_fragment>', `
        {
          vec3 V = normalize( vViewPosition );
          float fres = pow( 1.0 - saturate( dot( normal, V ) ), 3.0 );
          vec3 Lv = normalize( ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz );
          float back = saturate( -dot( normal, Lv ) );
          outgoingLight += uRim * ( fres * ( 0.20 + 0.80 * back ) * 0.30 );
          float haze = smoothstep( 55.0, 340.0, length( vViewPosition ) ) * 0.20;
          outgoingLight = mix( outgoingLight, uHaze, haze );
        }
        #include <opaque_fragment>`);
  }

  const snowMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.82, metalness: 0.0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  snowMat.onBeforeCompile = snowShader;
  const ribbonMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.78, metalness: 0.0,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  ribbonMat.onBeforeCompile = snowShader;

  // vertex colour shared by both meshes
  const _sv = new THREE.Vector3();
  function shadeVertex(lx, lz, h, out) {
    const q = qOf(lx, lz);
    const grad = gridSlope(lx, lz);
    const e = 3;
    const cav = h - 0.25 * (gridH(lx + e, lz) + gridH(lx - e, lz) + gridH(lx, lz + e) + gridH(lx, lz - e));
    const off = Math.abs(lx - cx(lz));
    const hw = hwAt(lz);
    const piste = (lz > LZ_TOP - 20 && lz < LZ_BASE + 34) ? 1 - sstep(hw, hw + 8, off) : 0;

    out.copy(cSnow);
    out.lerp(cGroom, piste * 0.9);
    // bare rock where it is too steep to hold snow, and on the craggy back wall
    out.lerp(cRockG, sstep(0.85, 1.35, grad) * (1 - piste));
    if (lz < LZ_TOP - 6) out.lerp(cRockW, sstep(0.6, 1.1, grad) * 0.55);
    // the snowline: melt out to meadow in the rim band, matching the plains
    out.lerp(cMeadow, sstep(0.855, 0.985, q));
    // wind-scoured blue in hollows
    if (cav < 0) out.lerp(cCool, clamp(-cav * 0.14, 0, 0.42));
    const shadow = q < 1 ? marchShadow(lx, lz, h) : 1;
    const ao = clamp(0.60 + 0.40 * sstep(-3.0, 1.5, cav), 0, 1);
    out.multiplyScalar(ao * (shadow === 1 ? 1 : 0.72));
    // Warm sun face / cool shade. Snow is nearly a lambertian white card, so
    // without a strong directional term under this sun it clips to a flat sheet
    // and the whole mountain loses its form — this IS the shape you read.
    const gx = (gridH(lx + e, lz) - gridH(lx - e, lz)) / (2 * e);
    const gz = (gridH(lx, lz + e) - gridH(lx, lz - e)) / (2 * e);
    const lam = clamp((-gx * sunL.x - gz * sunL.z + sunL.u) / Math.sqrt(1 + gx * gx + gz * gz), -1, 1);
    if (lam > 0) out.lerp(cWarm, lam * 0.18); else out.lerp(cCool, -lam * 0.55);
    out.multiplyScalar(0.50 + 0.50 * clamp((lam + 0.25) / 1.25, 0, 1));
    // Headroom: a 2.2-intensity sun plus the env map clips a white albedo to
    // paper, so the snow is authored dark and the light does the brightening.
    // This also keeps the sunlit face under post.js's 0.6 bloom threshold —
    // above it the whole slope glows and every surface detail is lost.
    out.multiplyScalar(0.52);
    return piste;
  }

  // --- mountain mesh ---------------------------------------------------------
  {
    const NRQ = 106, NS = 220, ROW = NS + 1;
    const qs = [];
    for (let i = 1; i <= NRQ; i++) qs.push(i / NRQ);
    for (let qq = 1.05; qq < 1.86; qq += 0.05) qs.push(qq);     // skirt
    const NR = qs.length;
    const vCount = NR * ROW + 1;
    const positions = new Float32Array(vCount * 3);
    const colors = new Float32Array(vCount * 3);
    const pisteA = new Float32Array(vCount);
    const _w = new THREE.Vector3();

    for (let i = 0; i < NR; i++) {
      const qq = qs[i];
      const phase = (i & 1) ? Math.PI / NS : 0;
      for (let j = 0; j < ROW; j++) {
        const a = (j % NS) * (Math.PI * 2 / NS) + phase;
        const lx = Math.cos(a) * qq * R_WIDE, lz = Math.sin(a) * qq * R_LONG;
        let lift_;
        if (qq <= 1) {
          lift_ = surfaceH(lx, lz);
          if (qq > 0.6) {
            const pg = padGroundAt(dirOf(lx, lz, _sv)) - baseR;
            if (pg > lift_) lift_ = pg;
          }
        } else {
          const tuck = sstep(1, 1.86, qq) * 34;
          lift_ = padGroundAt(dirOf(lx, lz, _sv)) - baseR - tuck;
        }
        const k = i * ROW + j;
        worldOf(lx, lz, lift_, _w);
        positions[k * 3] = _w.x; positions[k * 3 + 1] = _w.y; positions[k * 3 + 2] = _w.z;
        if (qq <= 1) {
          pisteA[k] = shadeVertex(lx, lz, lift_, _col);
        } else {
          _col.copy(cMeadow).multiplyScalar(0.9);
          pisteA[k] = 0;
        }
        colors[k * 3] = _col.r; colors[k * 3 + 1] = _col.g; colors[k * 3 + 2] = _col.b;
      }
    }
    const apex = NR * ROW;
    worldOf(0, 0, surfaceH(0, 0), _w);
    positions[apex * 3] = _w.x; positions[apex * 3 + 1] = _w.y; positions[apex * 3 + 2] = _w.z;
    pisteA[apex] = shadeVertex(0, 0, surfaceH(0, 0), _col);
    colors[apex * 3] = _col.r; colors[apex * 3 + 1] = _col.g; colors[apex * 3 + 2] = _col.b;

    const idx = [];
    for (let i = 0; i < NR - 1; i++) {
      for (let j = 0; j < NS; j++) {
        const a = i * ROW + j, b = a + 1, cc = a + ROW, dd = cc + 1;
        idx.push(a, cc, b, b, cc, dd);
      }
    }
    for (let j = 0; j < NS; j++) idx.push(apex, j, j + 1);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('aPiste', new THREE.Float32BufferAttribute(pisteA, 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    group.add(new THREE.Mesh(geo, snowMat));
  }

  // --- groomed ribbon: a fine lattice over the corridor so the kicker lips ---
  // and pipe walls render crisply (collision is analytic either way)
  {
    const z0 = LZ_TOP - 16, z1 = LZ_BASE + 12, STEP = 1.1, ACROSS = 64;
    const ROWS = Math.floor((z1 - z0) / STEP) + 1;
    const rw = ACROSS + 1;
    const positions = new Float32Array(ROWS * rw * 3);
    const colors = new Float32Array(ROWS * rw * 3);
    const pisteA = new Float32Array(ROWS * rw);
    const _w = new THREE.Vector3();
    for (let i = 0; i < ROWS; i++) {
      const lz = z0 + i * STEP;
      const cxx = cx(lz), hw = hwAt(lz);
      for (let s = 0; s <= ACROSS; s++) {
        const u = (s / ACROSS) * 2 - 1;
        const off = u * (hw + 4);
        const lx = cxx + off;
        const h = surfaceH(lx, lz);
        const k = i * rw + s;
        worldOf(lx, lz, h + 0.1, _w);
        positions[k * 3] = _w.x; positions[k * 3 + 1] = _w.y; positions[k * 3 + 2] = _w.z;
        pisteA[k] = shadeVertex(lx, lz, h, _col);
        // ice sheen + depth shading inside the pipe, so the trench reads
        const pd = pipeAt(off, lz);
        if (pd < 0) {
          _col.lerp(cIce, clamp(-pd / PIPE_D, 0, 1) * 0.5);
          _col.multiplyScalar(1 + pd * 0.05);
        }
        colors[k * 3] = _col.r; colors[k * 3 + 1] = _col.g; colors[k * 3 + 2] = _col.b;
      }
    }
    const idx = [];
    for (let i = 0; i < ROWS - 1; i++) {
      for (let s = 0; s < ACROSS; s++) {
        const p0 = i * rw + s, p1 = p0 + 1, p2 = p0 + rw, p3 = p2 + 1;
        idx.push(p0, p2, p1, p1, p2, p3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('aPiste', new THREE.Float32BufferAttribute(pisteA, 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, ribbonMat);
    m.renderOrder = 2;
    group.add(m);
  }

  // ==========================================================================
  // Placement helpers (shared by the lift, the buildings and the scatter)
  const _pu = new THREE.Vector3(), _pf = new THREE.Vector3(), _pr = new THREE.Vector3(), _pb = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  function placeLocal(g, lx, lz, lift_, faceDir) {
    worldOf(lx, lz, lift_, _pos);
    g.position.copy(_pos);
    _pu.copy(_pos).normalize();
    _pf.copy(faceDir).addScaledVector(_pu, -faceDir.dot(_pu));
    if (_pf.lengthSq() < 1e-5) _pf.copy(north);
    _pf.normalize();
    _pr.crossVectors(_pu, _pf).normalize();
    _pb.makeBasis(_pr, _pu, _pf);
    g.quaternion.setFromRotationMatrix(_pb);
  }

  function signTexture(text) {
    const cv = document.createElement('canvas');
    cv.width = 2048; cv.height = 400;
    const c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    const maxW = cv.width - 150;
    let size = 220;
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
  function signPanels(tex, w, h) {
    const g = new THREE.Group();
    for (const flip of [false, true]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, side: THREE.FrontSide, depthWrite: false }));
      m.position.z = flip ? -0.06 : 0.06;
      if (flip) m.rotation.y = Math.PI;
      g.add(m);
    }
    return g;
  }

  const M = (color, rough = 0.7, metal = 0.1, o) =>
    new THREE.MeshStandardMaterial(Object.assign({ color, roughness: rough, metalness: metal }, o || {}));
  const Box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const Cyl = (rt, rb, h, s = 12) => new THREE.CylinderGeometry(rt, rb, h, s);
  const mesh = (g, m) => new THREE.Mesh(g, m);

  const wood = M(0x4a3527, 0.85, 0.05);
  const woodDark = M(0x33241a, 0.9, 0.02);
  const steel = M(0x37455c, 0.55, 0.45);
  const steelDark = M(0x232b38, 0.6, 0.4);
  const glow = M(0x3a2a12, 0.6, 0.0, { emissive: 0xffc46a, emissiveIntensity: 1.5 });
  const snowCap = M(0xdfe7f0, 0.9, 0.0);

  // ==========================================================================
  // Chairlift — towers, a sagging looped cable, chairs that always run
  const liftGroup = new THREE.Group();
  group.add(liftGroup);

  // nodes: base bullwheel -> towers riding the piste's left edge -> top bullwheel
  const nodes = [];
  {
    const bh = surfaceH(STATION_B.lx, STATION_B.lz);
    nodes.push({ lx: STATION_B.lx, lz: STATION_B.lz, h: bh + STATION_H, station: true });
    for (let i = 1; i <= TOWERS; i++) {
      const t = i / (TOWERS + 1);
      const lz = lerp(STATION_B.lz, LIFT_TOP.lz, t);
      const lx = cx(lz) - (hwAt(lz) + 17);
      nodes.push({ lx, lz, h: surfaceH(lx, lz) + TOWER_H, tower: true });
    }
    const th = surfaceH(LIFT_TOP.lx, LIFT_TOP.lz);
    nodes.push({ lx: LIFT_TOP.lx, lz: LIFT_TOP.lz, h: th + STATION_H, station: true });
  }

  // the loop: up-line (base->top, cable offset -CABLE_GAP in lx), top arc,
  // down-line (top->base, +CABLE_GAP), bottom arc — closed, with catenary sag
  const loopPts = [];
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _mid = new THREE.Vector3();
  function pushSpan(n0, n1, side) {
    worldOf(n0.lx + side * CABLE_GAP, n0.lz, n0.h, _a);
    worldOf(n1.lx + side * CABLE_GAP, n1.lz, n1.h, _b);
    const span = _a.distanceTo(_b);
    const sag = 1.4 * Math.min(span / 90, 1.6);
    const SEG = 8;
    for (let s = (loopPts.length ? 1 : 0); s <= SEG; s++) {
      const t = s / SEG;
      _mid.lerpVectors(_a, _b, t);
      _pu.copy(_mid).normalize();
      _mid.addScaledVector(_pu, -sag * 4 * t * (1 - t));
      loopPts.push(_mid.clone());
    }
  }
  function pushArc(node, fromSide, toSide) {
    // half-circle around the bullwheel, in the local tangent plane
    worldOf(node.lx, node.lz, node.h, _mid);
    const centre = _mid.clone();
    _pu.copy(centre).normalize();
    const start = worldOf(node.lx + fromSide * CABLE_GAP, node.lz, node.h, _a).clone().sub(centre);
    for (let s = 1; s <= 6; s++) {
      const ang = (s / 6) * Math.PI * (toSide > fromSide ? -1 : 1);
      loopPts.push(centre.clone().add(start.clone().applyAxisAngle(_pu, ang)));
    }
  }
  let upLen = 0;
  {
    for (let i = 0; i < nodes.length - 1; i++) pushSpan(nodes[i], nodes[i + 1], -1);
    const cum0 = [];
    for (let i = 0; i < loopPts.length; i++) cum0.push(i ? cum0[i - 1] + loopPts[i].distanceTo(loopPts[i - 1]) : 0);
    upLen = cum0[cum0.length - 1];
    pushArc(nodes[nodes.length - 1], -1, 1);
    for (let i = nodes.length - 1; i > 0; i--) pushSpan(nodes[i], nodes[i - 1], 1);
    pushArc(nodes[0], 1, -1);
    loopPts.push(loopPts[0].clone());          // close
  }
  const cum = [0];
  for (let i = 1; i < loopPts.length; i++) cum.push(cum[i - 1] + loopPts[i].distanceTo(loopPts[i - 1]));
  const LOOP_L = cum[cum.length - 1];
  function loopPosAt(s, out) {
    s = ((s % LOOP_L) + LOOP_L) % LOOP_L;
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const t = (s - cum[lo]) / Math.max(cum[hi] - cum[lo], 1e-6);
    return out.copy(loopPts[lo]).lerp(loopPts[hi], t);
  }

  // cable render: one line around the whole loop
  {
    const pos = new Float32Array(loopPts.length * 3);
    for (let i = 0; i < loopPts.length; i++) { pos[i * 3] = loopPts[i].x; pos[i * 3 + 1] = loopPts[i].y; pos[i * 3 + 2] = loopPts[i].z; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x2b313c, transparent: true, opacity: 0.9 }));
    line.frustumCulled = false;
    liftGroup.add(line);
  }

  // towers
  for (const nd of nodes) {
    if (!nd.tower) continue;
    const t = new THREE.Group();
    const h = TOWER_H;
    const mast = mesh(Cyl(0.32, 0.5, h, 10), steel); mast.position.y = h / 2; t.add(mast);
    const arm = mesh(Box(2 * CABLE_GAP + 1.6, 0.28, 0.5), steel); arm.position.y = h; t.add(arm);
    for (const sx of [-CABLE_GAP, CABLE_GAP]) {
      const sheave = mesh(Cyl(0.28, 0.28, 0.5, 10), steelDark);
      sheave.rotation.z = Math.PI / 2; sheave.position.set(sx, h - 0.1, 0); t.add(sheave);
    }
    placeLocal(t, nd.lx, nd.lz, surfaceH(nd.lx, nd.lz), east);
    liftGroup.add(t);
    addCollider(worldOf(nd.lx, nd.lz, surfaceH(nd.lx, nd.lz), new THREE.Vector3()), 1.4);
  }

  // stations: platform, support mast, bullwheel, canopy
  function buildStation(nd, name) {
    const st = new THREE.Group();
    st.add((() => { const p = mesh(Box(7, 0.5, 5.5), steelDark); p.position.y = 0.25; return p; })());
    const mast = mesh(Cyl(0.4, 0.55, STATION_H, 10), steel); mast.position.y = STATION_H / 2; st.add(mast);
    const wheel = mesh(Cyl(1.25, 1.25, 0.3, 20), steelDark); wheel.position.y = STATION_H; st.add(wheel);
    const roof = mesh(Box(7.4, 0.24, 5.9), steel); roof.position.y = STATION_H + 1.5; st.add(roof);
    const cap = mesh(Box(7.4, 0.1, 5.9), snowCap); cap.position.y = STATION_H + 1.63; st.add(cap);
    for (const [sx, sz] of [[-3.4, -2.6], [3.4, -2.6], [-3.4, 2.6], [3.4, 2.6]]) {
      const leg = mesh(Box(0.2, STATION_H + 1.5, 0.2), steel); leg.position.set(sx, (STATION_H + 1.5) / 2, sz); st.add(leg);
    }
    if (name) {
      const sg = signPanels(signTexture(name), 6.6, 1.15);
      sg.position.y = STATION_H + 2.4;
      st.add(sg);
    }
    placeLocal(st, nd.lx, nd.lz, surfaceH(nd.lx, nd.lz), north);
    liftGroup.add(st);
  }
  buildStation(nodes[0], 'VAL FEELGOOD EXPRESS');
  buildStation(nodes[nodes.length - 1], null);

  // chairs: one merged geometry, twelve meshes riding the loop
  const chairGeo = (() => {
    const parts = [];
    const add = (g, x, y, z, rx = 0) => { g.translate(0, 0, 0); if (rx) g.rotateX(rx); g.translate(x, y, z); parts.push(g); };
    add(Cyl(0.05, 0.05, 1.9, 8), 0, -0.95, 0);                    // hanger
    add(Box(1.7, 0.12, 0.6), 0, -2.05, 0.12);                     // bench
    add(Box(1.7, 0.72, 0.1), 0, -1.72, -0.22);                    // backrest
    add(Box(0.09, 0.5, 0.55), -0.85, -1.83, 0.05);                // armrests
    add(Box(0.09, 0.5, 0.55), 0.85, -1.83, 0.05);
    add(Box(1.6, 0.06, 0.06), 0, -2.55, 0.42);                    // footrest
    return mergeGeometries(parts, false);
  })();
  const chairs = [];
  for (let i = 0; i < CHAIRS; i++) {
    const m = mesh(chairGeo, steel);
    m.frustumCulled = false;
    liftGroup.add(m);
    chairs.push({ mesh: m, s0: (i * LOOP_L) / CHAIRS, s: (i * LOOP_L) / CHAIRS, seat: new THREE.Vector3() });
  }
  const _cp = new THREE.Vector3(), _cq = new THREE.Vector3(), _cf = new THREE.Vector3(), _cr = new THREE.Vector3(), _cu = new THREE.Vector3(), _cm = new THREE.Matrix4();
  let liftS = 0;
  function tickLift(dt) {
    liftS += LIFT_SPEED * dt;
    for (const ch of chairs) {
      ch.s = (ch.s0 + liftS) % LOOP_L;
      loopPosAt(ch.s, _cp);
      loopPosAt(ch.s + 1.5, _cq);
      _cu.copy(_cp).normalize();
      _cf.subVectors(_cq, _cp);
      _cf.addScaledVector(_cu, -_cf.dot(_cu));
      if (_cf.lengthSq() < 1e-8) _cf.copy(north);
      _cf.normalize();
      _cr.crossVectors(_cu, _cf).normalize();
      _cm.makeBasis(_cr, _cu, _cf);
      ch.mesh.quaternion.setFromRotationMatrix(_cm);
      ch.mesh.position.copy(_cp);
      ch.seat.copy(_cp).addScaledVector(_cu, -HANG);
    }
  }
  tickLift(0);

  const liftBaseWorld = worldOf(STATION_B.lx, STATION_B.lz, STATION_B.h + 1, new THREE.Vector3());
  const topSpawnDir = dirOf(-4, LZ_TOP + 9, new THREE.Vector3()).clone();
  lift = {
    chairs, upLen, L: LOOP_L,
    basePos: liftBaseWorld.clone(),
    topSpawn: () => spawnAt(planet, topSpawnDir, north),
  };

  function boardLift() {
    if (rideChair) return;
    if (vehicleActive()) return;
    let best = null, bestD = Infinity;
    for (const ch of chairs) {
      if (ch.s > upLen - 12) continue;               // already unloading
      const d = ch.seat.distanceTo(liftBaseWorld);
      if (d < bestD) { bestD = d; best = ch; }
    }
    if (!best) return;
    rideChair = best;
    walk.pitch = 0;
    showHint('Riding the Val Feelgood Express — E to hop off early');
  }

  // ==========================================================================
  // Buildings: base lodge (A-frame) + summit rental shack
  const lodgePosL = { lx: 8, lz: LZ_BASE + 4 };
  {
    const lodge = new THREE.Group();
    const deck = mesh(Box(11, 0.4, 8), woodDark); deck.position.y = 0.2; lodge.add(deck);
    const back = mesh(Box(8.4, 3.6, 0.24), woodDark); back.position.set(0, 2.0, -3.4); lodge.add(back);
    const front = mesh(Box(8.4, 3.6, 0.24), woodDark); front.position.set(0, 2.0, 3.4); lodge.add(front);
    for (const sx of [-1, 1]) {
      const side = mesh(Box(0.24, 3.6, 6.8), woodDark); side.position.set(sx * 4.2, 2.0, 0); lodge.add(side);
    }
    for (const s of [-1, 1]) {
      const slab = mesh(Box(5.6, 0.26, 8.8), wood);
      slab.position.set(s * 2.1, 5.35, 0); slab.rotation.z = -s * 0.62; lodge.add(slab);
      const cap = mesh(Box(5.6, 0.12, 8.8), snowCap);
      cap.position.set(s * 2.16, 5.5, 0); cap.rotation.z = -s * 0.62; lodge.add(cap);
    }
    for (const wx of [-2.2, 2.2]) {
      const win = mesh(new THREE.PlaneGeometry(1.5, 1.1), glow); win.position.set(wx, 2.2, 3.54); lodge.add(win);
    }
    const door = mesh(Box(1.3, 2.4, 0.1), wood); door.position.set(0, 1.4, 3.53); lodge.add(door);
    const sg = signPanels(signTexture('VAL FEELGOOD · SKI AREA'), 9, 1.5);
    sg.position.y = 7.7; lodge.add(sg);
    placeLocal(lodge, lodgePosL.lx, lodgePosL.lz, surfaceH(lodgePosL.lx, lodgePosL.lz), north);
    group.add(lodge);
    addCollider(worldOf(lodgePosL.lx, lodgePosL.lz, H_BASE, new THREE.Vector3()), 5.2);
  }

  const shopPosL = { lx: 7, lz: LZ_TOP - 7 };
  {
    const shop = new THREE.Group();
    const slab = mesh(Box(7.6, 0.3, 6), woodDark); slab.position.y = 0.15; shop.add(slab);
    const backW = mesh(Box(7, 2.9, 0.24), wood); backW.position.set(0, 1.6, -2.8); shop.add(backW);
    for (const sx of [-1, 1]) {
      const side = mesh(Box(0.24, 2.9, 5.6), wood); side.position.set(sx * 3.5, 1.6, 0); shop.add(side);
      const frontSeg = mesh(Box(2.5, 2.9, 0.24), wood); frontSeg.position.set(sx * 2.25, 1.6, 2.8); shop.add(frontSeg);
    }
    const lintel = mesh(Box(2.2, 0.9, 0.24), wood); lintel.position.set(0, 2.6, 2.8); shop.add(lintel);
    for (const sx of [-2.2, 2.2]) {
      const win = mesh(new THREE.PlaneGeometry(1.3, 1.0), glow); win.position.set(sx, 1.9, 2.94); shop.add(win);
    }
    for (const s of [-1, 1]) {
      const slope = mesh(Box(4.6, 0.22, 6.8), woodDark);
      slope.position.set(s * 1.75, 4.3, 0); slope.rotation.z = -s * 0.62; shop.add(slope);
      const cap = mesh(Box(4.6, 0.12, 6.8), snowCap);
      cap.position.set(s * 1.8, 4.45, 0); cap.rotation.z = -s * 0.62; shop.add(cap);
    }
    // a rack of rental boards leaning on the front wall
    for (let i = 0; i < 4; i++) {
      const bd = mesh(Box(0.3, 1.5, 0.05), M([0xd8352a, 0x2f6fba, 0xf5b642, 0x3f9d5a][i], 0.4, 0.2));
      bd.position.set(-2.9 + i * 0.45, 0.95, 3.0); bd.rotation.x = -0.22; shop.add(bd);
    }
    const sg = signPanels(signTexture('THE SUMMIT SHACK'), 6.4, 1.15);
    sg.position.y = 6.3; shop.add(sg);
    placeLocal(shop, shopPosL.lx, shopPosL.lz, H_TOP, north);
    group.add(shop);
    addCollider(worldOf(shopPosL.lx, shopPosL.lz, H_TOP, new THREE.Vector3()), 4.4);
  }

  // ==========================================================================
  // Snowboard — a vehicle whose def carries its own physics/orientation/camera
  const _u = new THREE.Vector3(), _gd = new THREE.Vector3(), _gn2 = new THREE.Vector3(), _ge2 = new THREE.Vector3(), _gu2 = new THREE.Vector3();
  const _down = new THREE.Vector3(), _lat2 = new THREE.Vector3(), _sn = new THREE.Vector3();
  const _bf = new THREE.Vector3(), _br = new THREE.Vector3(), _bu = new THREE.Vector3(), _bm = new THREE.Matrix4();
  const _ct = new THREE.Vector3();
  let gGx = 0, gGz = 0;

  // floor gradient in the walker's shared floor field — the board rides pads,
  // terraces and the mountain alike, so off-piste and even off-mountain works
  function floorGrad(upDir) {
    frameAt(upDir, _gu2, _gn2, _ge2);
    const e = 1.6, R = C.RADIUS;
    const fpx = floorRadiusAt(planet, _gd.copy(upDir).addScaledVector(_ge2, e / R).normalize());
    const fmx = floorRadiusAt(planet, _gd.copy(upDir).addScaledVector(_ge2, -e / R).normalize());
    const fpz = floorRadiusAt(planet, _gd.copy(upDir).addScaledVector(_gn2, e / R).normalize());
    const fmz = floorRadiusAt(planet, _gd.copy(upDir).addScaledVector(_gn2, -e / R).normalize());
    gGx = (fpx - fmx) / (2 * e);
    gGz = (fpz - fmz) / (2 * e);
  }
  function onMountain(P) { return localOf(P) && qOf(_L.lx, _L.lz) < 1; }

  function stepBoard(v, dt) {
    const def = v.def;
    _u.copy(v.pos).normalize();
    if (input.camToggle) {
      fpCam = !fpCam;
      input.camToggle = false;
      if (v.parts.rider) v.parts.rider.visible = !fpCam;
    }
    // steering is on the keys; eat the mouse so dismounting doesn't snap the view
    input.mouseX = 0; input.mouseY = 0;

    v.heading.addScaledVector(_u, -v.heading.dot(_u));
    if (v.heading.lengthSq() < 1e-8) v.heading.copy(north);
    v.heading.normalize();

    floorGrad(_u);
    const g = Math.hypot(gGx, gGz);
    const invSlope = 1 / Math.sqrt(1 + g * g);
    _sn.copy(_u).addScaledVector(_ge2, -gGx).addScaledVector(_gn2, -gGz).normalize();
    const turn = (input.left ? 1 : 0) - (input.right ? 1 : 0);

    if (!v.air) {
      // gravity's along-slope component pulls straight downhill
      if (g > 1e-4) {
        _down.copy(_ge2).multiplyScalar(-gGx).addScaledVector(_gn2, -gGz).multiplyScalar(1 / g);
        _down.addScaledVector(_u, -_down.dot(_u)).normalize();
        v.vel.addScaledVector(_down, C.WALK_GRAVITY * g * invSlope * dt);
      }
      const spd0 = v.vel.length();
      const steerK = 0.35 + 0.65 * Math.min(spd0 / 18, 1);
      v.heading.applyAxisAngle(_u, turn * TURN * steerK * dt);
      v.heading.addScaledVector(_u, -v.heading.dot(_u)).normalize();
      // carve: the edge kills lateral slip; braking loosens the edge and scrubs
      v.vel.addScaledVector(_u, -v.vel.dot(_u));
      let vp = v.vel.dot(v.heading);
      _lat2.copy(v.vel).addScaledVector(v.heading, -vp);
      const braking = input.reverse;
      const latK = Math.exp(-(braking ? GRIP_SKID : GRIP) * dt);
      if (braking) vp -= Math.sign(vp) * Math.min(Math.abs(vp), BRAKE * dt);
      const sprayPow = _lat2.length() * (1 - latK) * spd0;
      v.vel.copy(v.heading).multiplyScalar(vp).addScaledVector(_lat2, latK);
      const offMountain = !onMountain(v.pos);
      const dragC = (input.forward ? DRAG_TUCK : DRAG) * (offMountain ? 3 : 1);
      const spd1 = v.vel.length();
      v.vel.multiplyScalar(Math.max(0, 1 - dragC * spd1 * dt));
      if (spd1 > MAXV) v.vel.multiplyScalar(MAXV / spd1);
      // the surface's own vertical rate under our motion (the ramp we ride)
      const ve = v.vel.dot(_ge2), vn = v.vel.dot(_gn2);
      const sRate = -(gGx * ve + gGz * vn) * invSlope;
      // move, then decide: still glued, or did the floor fall away?
      v.pos.addScaledVector(v.vel, dt);
      _u.copy(v.pos).normalize();
      const fR = floorRadiusAt(planet, _u) + def.rideH;
      const r = v.pos.length();
      const ollie = input.jump && !v.jumpHeld;
      v.jumpHeld = input.jump;
      const drop = r - fR;                              // how far the floor fell
      const expect = Math.max(0, -sRate) * dt;          // what a glued board sees
      const convex = v.sRatePrev > 4 && sRate < v.sRatePrev * 0.4; // pipe/kicker lip
      if (ollie || drop > expect + 0.30 || convex) {
        v.air = true;
        // capped so a max-speed wall hit is a big air, not a ballistic launch
        v.vUp = Math.min(Math.max(convex ? v.sRatePrev : sRate, 0), 14) + (ollie ? OLLIE : 0);
        v.spin = turn * 2.4;                            // carve rate carries into the air
        if (drop > 0.05) v.pos.copy(_u).multiplyScalar(r);
      } else {
        v.pos.copy(_u).multiplyScalar(fR);
        v.vUp = 0;
        if (sprayPow > 26 && spd1 > 6) emitSpray(v, _lat2, spd1);
      }
      v.sRatePrev = sRate;
    } else {
      v.jumpHeld = input.jump;
      v.vUp -= C.WALK_GRAVITY * dt;
      v.pos.addScaledVector(v.vel, dt).addScaledVector(_u, v.vUp * dt);
      // momentum spin, with a light hand of air steering
      v.heading.applyAxisAngle(_u, (v.spin + turn * 1.2) * dt);
      v.spin *= Math.exp(-0.4 * dt);
      _u.copy(v.pos).normalize();
      v.heading.addScaledVector(_u, -v.heading.dot(_u)).normalize();
      const fR = floorRadiusAt(planet, _u) + def.rideH;
      const r = v.pos.length();
      if (v.vUp <= 0 && r <= fR) {
        v.pos.copy(_u).multiplyScalar(fR);
        v.vel.addScaledVector(_u, -v.vel.dot(_u));
        const spd = v.vel.length();
        if (spd > 0.2) {
          // a sideways landing scrubs speed; a clean one rides away
          const align = Math.max(0, v.vel.dot(v.heading) / spd);
          v.vel.multiplyScalar(0.72 + 0.28 * align);
        }
        v.air = false; v.vUp = 0; v.spin = 0; v.sRatePrev = 0;
        emitSpray(v, v.vel, v.vel.length() * 0.4);
      }
    }
    // eased slope normal for the body; radial in the air so flips read level
    v.slopeN.lerp(v.air ? _u : _sn, Math.min(1, (v.air ? 4 : 12) * dt)).normalize();
    const sp = v.vel.length();
    v.roll += ((-turn * 0.45 * Math.min(sp / 20, 1)) - v.roll) * Math.min(1, 8 * dt);
    v.forward.copy(v.heading);
    v.speed = sp;
    v.speed01 = Math.min(sp / MAXV, 1);
    // only bail into the water when we're actually AT the water: the floor can
    // carry the board high and dry above wet terrain at the mountain rim
    if (v.pos.length() < planet.seaR + 0.4 && waterDepthAt(planet, _u) > 0.5) {
      exitVehicle();
      showHint('The board is not a boat.');
    }
  }

  function orientBoard(v) {
    _bu.copy(v.slopeN);
    _bf.copy(v.heading).addScaledVector(_bu, -v.heading.dot(_bu));
    if (_bf.lengthSq() < 1e-6) _bf.copy(north);
    _bf.normalize();
    _br.crossVectors(_bu, _bf);
    if (_br.lengthSq() < 1e-6) _br.set(1, 0, 0);
    _br.normalize();
    _ct.crossVectors(_bf, _br).normalize();               // right-handed true up
    if (v.roll) { _br.applyAxisAngle(_bf, v.roll); _ct.applyAxisAngle(_bf, v.roll); }
    _bm.makeBasis(_br, _ct, _bf);
    v.group.quaternion.setFromRotationMatrix(_bm);
    v.group.position.copy(v.pos);
  }

  function boardCamera(camera, v) {
    if (!fpCam) return false;                             // fall through: chase cam
    _u.copy(v.pos).normalize();
    camera.up.copy(_u);
    camera.position.copy(v.pos).addScaledVector(_u, 1.55);
    _ct.copy(camera.position).add(v.heading).addScaledVector(_u, -0.12 - 0.22 * v.speed01);
    camera.lookAt(_ct);
    return true;
  }

  const BOARD_DEF = {
    kind: 'board', hover: true, name: 'snowboard', rideH: 0.18, maxSpeed: MAXV,
    camDist: 8.5, camHeight: 3.0,
    controls: 'W tuck · S brake · A/D carve · SPACE ollie · C camera · E dismount',
    step: stepBoard, orient: orientBoard, camera: boardCamera,
  };

  function buildBoardVehicle() {
    const g = new THREE.Group();
    g.visible = false;
    const deckM = M(0xd8352a, 0.35, 0.15);
    const deck = mesh(Box(0.34, 0.05, 1.58), deckM); deck.position.y = 0.09; g.add(deck);
    for (const s of [-1, 1]) {
      const tail = mesh(Box(0.34, 0.05, 0.24), deckM);
      tail.position.set(0, 0.14, s * 0.86); tail.rotation.x = -s * 0.5; g.add(tail);
    }
    const stripe = mesh(Box(0.16, 0.052, 1.2), M(0xf5e1b8, 0.4, 0.1)); stripe.position.y = 0.095; g.add(stripe);
    for (const s of [-1, 1]) {
      const bind = mesh(Box(0.3, 0.1, 0.3), steelDark);
      bind.position.set(0, 0.15, s * 0.36); bind.rotation.y = s * 0.3; g.add(bind);
    }
    // the rider, knees bent, stood across the board (hidden in first person)
    const rider = new THREE.Group();
    rider.rotation.y = 0.55;
    const jacket = M(0x2f6fba, 0.7, 0.02), pants = M(0x22262e, 0.75), skin = M(0xd8a77a, 0.6);
    for (const s of [-1, 1]) {
      const leg = mesh(Box(0.17, 0.62, 0.2), pants);
      leg.position.set(0.05 * s, 0.48, s * 0.34); leg.rotation.x = -s * 0.18; rider.add(leg);
    }
    const torso = mesh(Box(0.46, 0.62, 0.3), jacket); torso.position.y = 1.05; torso.rotation.y = -0.2; rider.add(torso);
    const head = mesh(new THREE.SphereGeometry(0.19, 12, 10), skin); head.position.y = 1.55; rider.add(head);
    const beanie = mesh(new THREE.SphereGeometry(0.2, 12, 8, 0, Math.PI * 2, 0, 1.4), M(0xd8352a, 0.8)); beanie.position.y = 1.6; rider.add(beanie);
    for (const s of [-1, 1]) {
      const arm = mesh(Box(0.13, 0.5, 0.13), jacket);
      arm.position.set(s * 0.32, 1.0, s * 0.12); arm.rotation.z = s * 0.5; rider.add(arm);
    }
    rider.visible = false;
    g.add(rider);
    scene.add(g);
    return { group: g, parts: { rider } };
  }

  let followItem = null;
  function equipBoard() {
    if (!board.v) {
      const built = buildBoardVehicle();
      followItem = addInteractable({
        pos: new THREE.Vector3(), radius: 0,
        prompt: '<b>E</b> — drop in',
        action: dropIn,
      });
      board.v = {
        def: BOARD_DEF, group: built.group, parts: built.parts,
        pos: new THREE.Vector3().copy(walk.player), heading: north.clone(), forward: north.clone(),
        vel: new THREE.Vector3(), vUp: 0, air: false, spin: 0, sRatePrev: 0, jumpHeld: false,
        slopeN: walk.player.clone().normalize(),
        speed: 0, roll: 0, wheelSpin: 0, propSpin: 0, speed01: 0,
        interactable: followItem,
      };
      addVehicle(board.v);
    }
    board.equipped = true;
  }
  function returnBoard() {
    board.equipped = false;
    if (followItem) followItem.radius = 0;
  }
  function dropIn() {
    if (!board.equipped || !board.v || vehicleActive() || rideChair) return;
    const v = board.v;
    _u.copy(walk.player).normalize();
    const fR = floorRadiusAt(planet, _u) + BOARD_DEF.rideH;
    v.pos.copy(_u).multiplyScalar(Math.max(fR, walk.player.length()));
    v.heading.copy(walk.heading).addScaledVector(_u, -walk.heading.dot(_u)).normalize();
    v.forward.copy(v.heading);
    v.vel.set(0, 0, 0);
    v.vUp = 0; v.air = false; v.spin = 0; v.roll = 0; v.sRatePrev = 0;
    v.jumpHeld = !!input.jump;
    v.slopeN.copy(_u);
    input.camToggle = false;
    v.group.visible = true;
    board.riding = true;
    enterVehicle(v);
    if (v.parts.rider) v.parts.rider.visible = !fpCam;
  }

  // ==========================================================================
  // Carve spray — a small recycled particle pool, skipped on the low tier
  const SPRAY_N = 240;
  const sprayPos = new Float32Array(SPRAY_N * 3);
  const sprayVel = [];
  const sprayLife = new Float32Array(SPRAY_N);
  for (let i = 0; i < SPRAY_N; i++) sprayVel.push(new THREE.Vector3());
  let sprayHead = 0;
  const sprayGeo = new THREE.BufferGeometry();
  sprayGeo.setAttribute('position', new THREE.BufferAttribute(sprayPos, 3));
  const sprayPts = new THREE.Points(sprayGeo, new THREE.PointsMaterial({
    color: 0xf2f7ff, size: 0.42, sizeAttenuation: true, transparent: true, opacity: 0.85, depthWrite: false,
  }));
  sprayPts.frustumCulled = false;
  sprayPts.renderOrder = 3;
  group.add(sprayPts);
  function emitSpray(v, latDir, power) {
    if (getQuality() === 'low') return;
    const n = clamp(Math.round(power / 14), 1, 4);
    _u.copy(v.pos).normalize();
    for (let i = 0; i < n; i++) {
      const k = sprayHead = (sprayHead + 1) % SPRAY_N;
      sprayPos[k * 3] = v.pos.x + (Math.random() - 0.5) * 0.5;
      sprayPos[k * 3 + 1] = v.pos.y + (Math.random() - 0.5) * 0.5;
      sprayPos[k * 3 + 2] = v.pos.z + (Math.random() - 0.5) * 0.5;
      sprayVel[k].copy(latDir).multiplyScalar(0.35 + Math.random() * 0.3)
        .addScaledVector(_u, 2.2 + Math.random() * 2.6);
      sprayLife[k] = 0.55 + Math.random() * 0.3;
    }
  }
  function tickSpray(dt) {
    let any = false;
    for (let i = 0; i < SPRAY_N; i++) {
      if (sprayLife[i] <= 0) continue;
      any = true;
      sprayLife[i] -= dt;
      const vv = sprayVel[i];
      _sv.set(sprayPos[i * 3], sprayPos[i * 3 + 1], sprayPos[i * 3 + 2]);
      _u.copy(_sv).normalize();
      vv.addScaledVector(_u, -C.WALK_GRAVITY * 0.7 * dt);
      sprayPos[i * 3] += vv.x * dt;
      sprayPos[i * 3 + 1] += vv.y * dt;
      sprayPos[i * 3 + 2] += vv.z * dt;
      if (sprayLife[i] <= 0) { sprayPos[i * 3] = 0; sprayPos[i * 3 + 1] = 0; sprayPos[i * 3 + 2] = 0; }
    }
    if (any) sprayGeo.attributes.position.needsUpdate = true;
    sprayPts.visible = any;
  }

  // ==========================================================================
  // Scatter — snow-laden pines on the flanks, piste-edge poles, crag boulders
  const scatterMeshes = [];
  const _dummy = new THREE.Object3D();
  const _yAxis = new THREE.Vector3(0, 1, 0);
  const _qA = new THREE.Quaternion(), _qY = new THREE.Quaternion();
  function place(meshI, n, dir, h, yOff, yaw, sx, sy, sz, tilt, tint) {
    _dummy.position.copy(dir).multiplyScalar(baseR + h + yOff);
    _qA.setFromUnitVectors(_yAxis, dir);
    _qY.setFromEuler(new THREE.Euler(tilt ? (rnd() - 0.5) * 0.3 : 0, yaw, tilt ? (rnd() - 0.5) * 0.3 : 0));
    _dummy.quaternion.copy(_qA).multiply(_qY);
    _dummy.scale.set(sx, sy, sz);
    _dummy.updateMatrix();
    meshI.setMatrixAt(n, _dummy.matrix);
    if (tint) meshI.setColorAt(n, tint);
  }
  function offPiste(lx, lz, pad) {
    if (lz < LZ_TOP - 20 || lz > LZ_BASE + 34) return true;
    return Math.abs(lx - cx(lz)) > coAt(lz) + pad;
  }
  function nearLiftLine(lx, lz) {
    if (lz < LIFT_TOP.lz - 8 || lz > STATION_B.lz + 8) return false;
    return Math.abs(lx - (cx(lz) - (hwAt(lz) + 17))) < 6;
  }

  // pines: trunk + snow-dusted cone stack, merged, tinted per instance
  const pineGeo = (() => {
    const parts = [];
    const trunk = Cyl(0.12, 0.2, 1.4, 7); trunk.translate(0, 0.7, 0); parts.push(trunk);
    for (let i = 0; i < 3; i++) {
      const cone = new THREE.ConeGeometry(1.5 - i * 0.42, 1.7, 8);
      cone.translate(0, 1.6 + i * 1.05, 0);
      parts.push(cone);
    }
    return mergeGeometries(parts, false);
  })();
  const pineMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.0 });
  const pines = new THREE.InstancedMesh(pineGeo, pineMat, 150);
  pines.frustumCulled = false; pines.count = 0;
  group.add(pines); scatterMeshes.push(pines);
  let pineN = 0;
  const cPineLo = new THREE.Color(0x2e4a33), cPineHi = new THREE.Color(0xb8c8bc);
  for (let i = 0; i < 2400 && pineN < 150; i++) {
    const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd());
    const lx = Math.cos(a) * rr * (R_WIDE - 6), lz = Math.sin(a) * rr * (R_LONG - 6);
    const h = gridH(lx, lz);
    if (h <= 0.4) continue;
    if (h / H_TOP > 0.52) continue;                        // treeline
    if (gridSlope(lx, lz) > 0.85) continue;
    if (!offPiste(lx, lz, 6)) continue;
    if (nearLiftLine(lx, lz)) continue;
    if (Math.hypot(lx, lz - LZ_BASE) < T_BASE_R + 8) continue;
    if (rnd() > 0.4) continue;
    const s = 0.8 + rnd() * 1.6;
    // higher trees carry more snow
    _col.copy(cPineLo).lerp(cPineHi, 0.25 + 0.55 * clamp(h / (H_TOP * 0.5), 0, 1));
    place(pines, pineN++, dirOf(lx, lz, _sv), h, -0.1, rnd() * 6.28, s, s * (0.9 + rnd() * 0.4), s, true, _col.clone());
  }
  pines.count = pineN;
  pines.instanceMatrix.needsUpdate = true;
  if (pines.instanceColor) pines.instanceColor.needsUpdate = true;

  // piste-edge marker poles, orange, both edges
  const poleGeo = Cyl(0.05, 0.05, 1.7, 6); poleGeo.translate(0, 0.85, 0);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.6, emissive: 0x351200, emissiveIntensity: 0.8 });
  const poles = new THREE.InstancedMesh(poleGeo, poleMat, 90);
  poles.frustumCulled = false; poles.count = 0;
  group.add(poles); scatterMeshes.push(poles);
  let poleN = 0;
  for (let lz = LZ_TOP + 20; lz < LZ_BASE - 18 && poleN < 88; lz += 14) {
    for (const side of [-1, 1]) {
      const lx = cx(lz) + side * (hwAt(lz) + 1.6);
      place(poles, poleN++, dirOf(lx, lz, _sv), surfaceH(lx, lz), 0, 0, 1, 1, 1, false, null);
    }
  }
  poles.count = poleN;
  poles.instanceMatrix.needsUpdate = true;

  // boulders for the crags (the same fbm-displaced dodecahedra recipe)
  function boulderGeo(vv) {
    const g = new THREE.DodecahedronGeometry(1, 1);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const d = nz.fbm(x * 1.4 + vv * 8, y * 1.4, z * 1.4 - vv * 4, 2) * 0.34;
      p.setXYZ(i, x + d, y * 0.78 + d * 0.4, z + d);
    }
    g.computeVertexNormals();
    return g;
  }
  const bMat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0.02, flatShading: true });
  const boulders = new THREE.InstancedMesh(boulderGeo(1), bMat, 70);
  boulders.frustumCulled = false; boulders.count = 0;
  group.add(boulders); scatterMeshes.push(boulders);
  let bN = 0;
  for (let i = 0; i < 1400 && bN < 70; i++) {
    const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd());
    const lx = Math.cos(a) * rr * (R_WIDE - 4), lz = Math.sin(a) * rr * (R_LONG - 4);
    const h = gridH(lx, lz);
    if (h <= 0.3) continue;
    const g = gridSlope(lx, lz);
    if (g < 0.45 || g > 1.7) continue;
    if (!offPiste(lx, lz, 3)) continue;
    if (rnd() > 0.25) continue;
    const s = 0.5 + Math.pow(rnd(), 2) * 2.6;
    const gs = 0.45 + rnd() * 0.25;
    _col.setRGB(gs, gs, gs * 0.98);
    // snow caps the tops of the highest boulders
    if (h / H_TOP > 0.5) _col.lerp(cSnow, 0.35);
    place(boulders, bN++, dirOf(lx, lz, _sv), h, s * 0.1 - 0.12, rnd() * 6.28,
      s * (0.7 + rnd() * 0.6), s * (0.55 + rnd() * 0.5), s * (0.7 + rnd() * 0.6), true, _col.clone());
  }
  boulders.count = bN;
  boulders.instanceMatrix.needsUpdate = true;
  if (boulders.instanceColor) boulders.instanceColor.needsUpdate = true;

  // ==========================================================================
  // Interactions + compass
  const shopWorld = worldOf(shopPosL.lx, shopPosL.lz, H_TOP + 1.6, new THREE.Vector3());
  const lodgeWorld = worldOf(lodgePosL.lx, lodgePosL.lz, H_BASE + 1.6, new THREE.Vector3());
  const summitWorld = worldOf(0, LZ_TOP, H_TOP, new THREE.Vector3());

  addInteractable({
    pos: lodgeWorld.clone(), radius: 7,
    prompt: '<b>E</b> — Val Feelgood Ski Area',
    action: () => showCard({
      kicker: 'the snow plains',
      title: 'Val Feelgood Ski Area',
      meta: 'one lift · one long groomed run · a terrain park halfway down',
      body: [
        'The chairlift beside the lodge runs to the summit, where the Summit Shack rents snowboards. Ride up, strap in, and the piste brings you all the way back here.',
        'Halfway down, the terrain park: three kickers of growing ambition, then a half-pipe. Speed is your friend on the lips — and your problem on the landings.',
      ],
    }),
  });

  addInteractable({
    pos: liftBaseWorld.clone(), radius: 6,
    prompt: '<b>E</b> — ride the chairlift',
    action: boardLift,
  });

  function shopDialogue() {
    const choices = [];
    if (!board.equipped) {
      choices.push({
        label: 'Rent a snowboard',
        action: equipBoard,
        say: 'One board, waxed this morning. It\'s yours until you bring it back. Step outside and press E to drop in — anywhere on the mountain.',
        then: [],
      });
    } else {
      choices.push({
        label: 'Return the board',
        action: returnBoard,
        say: 'Back on the rack it goes. The mountain will still be here when you want it again.',
        then: [],
      });
    }
    choices.push({
      label: 'How do I ride?',
      say: 'Point it downhill and gravity does the work. A and D carve, W tucks for speed, S brakes. SPACE pops an ollie, C swaps the camera, E steps off. Hit the kicker lips with speed and the mountain will throw you — land straight or you\'ll scrub.',
      then: [],
    });
    choices.push({ label: 'Just looking, thanks.', end: true });
    showDialogue({
      kicker: 'the summit shack',
      title: 'The Summit Shack',
      greeting: board.equipped
        ? 'Board treating you right? The pipe\'s freshly cut, if you\'re feeling brave.'
        : 'Afternoon! Cold one up here. Rent you a board? The whole run back to the lodge is groomed.',
      choices,
    });
  }
  addInteractable({
    pos: shopWorld.clone(), radius: 6.5,
    prompt: '<b>E</b> — The Summit Shack',
    action: shopDialogue,
  });

  const compass = [{ name: 'SKI RESORT', pos: worldOf(0, LZ_TOP, H_TOP + 12, new THREE.Vector3()) }];

  // --- per-frame -------------------------------------------------------------
  let trimmed = false;
  const _fp = new THREE.Vector3();
  function tick(dt, t) {
    lastDt = clamp(dt, 1 / 240, 1 / 20);
    tickLift(dt);
    tickSpray(dt);
    if (scene.fog) uni.uHaze.value.copy(scene.fog.color);
    // dismounting the board (E -> vehicles.exitVehicle) leaves it "carried":
    // hide the mesh and park its prompt until the next drop-in
    if (board.riding && !vehicleActive()) {
      board.riding = false;
      if (board.v) board.v.group.visible = false;
    }
    // the drop-in prompt follows the walker while a board is equipped, except
    // near the shop / lift / lodge so it can't shadow their prompts
    if (followItem) {
      let on = board.equipped && !board.riding && !rideChair && !vehicleActive();
      if (on) {
        _fp.copy(walk.player);
        on = onMountain(_fp)
          && _fp.distanceTo(shopWorld) > 11
          && _fp.distanceTo(liftBaseWorld) > 9
          && _fp.distanceTo(lodgeWorld) > 11;
      }
      followItem.radius = on ? 3.4 : 0;
      if (on) followItem.pos.copy(walk.player);
    }
    if (!trimmed && typeof window !== 'undefined' && window.__debug
        && window.__debug.quality && window.__debug.quality() === 'low') {
      trimmed = true;
      uni.uDetail.value = 0;
      pines.count = Math.min(pineN, 70);
      boulders.count = Math.min(bN, 30);
    }
  }

  function dispose() {
    removeStructureResolver(resolver);
    removeSurfaceExclusion(excl);
    removeWeatherRegion(wxRegion);
    lift = null;
    rideChair = null;
    if (group.parent) group.parent.remove(group);
    group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
      }
      if (o.isInstancedMesh) o.dispose();
    });
    if (board.v && board.v.group.parent) board.v.group.parent.remove(board.v.group);
  }

  const baseApproachDir = dirOf(0, LZ_BASE + 16, new THREE.Vector3()).clone();
  const uphill = north.clone().negate();

  if (typeof window !== 'undefined') {
    window.__skiSlope = {
      dir: mDir.toArray(),
      dist: site.dist,
      sunUp: site.sunUp,
      base: () => teleportTo(planet, dirOf(0, LZ_BASE + 6, new THREE.Vector3())),
      summit: () => teleportTo(planet, dirOf(-2, LZ_TOP + 7, new THREE.Vector3())),
      shop: () => teleportTo(planet, dirOf(6, LZ_TOP - 4, new THREE.Vector3())),
      equip: () => { equipBoard(); return board.equipped; },
      drop: (lz = LZ_TOP + 42) => {
        spawnAt(planet, dirOf(cx(lz), lz, new THREE.Vector3()), north);
        equipBoard();
        dropIn();
        return vehicleActive();
      },
      ride: () => {
        teleportTo(planet, dirOf(STATION_B.lx + 4, STATION_B.lz + 4, new THREE.Vector3()));
        boardLift();
        return skiRideActive();
      },
      offRide: () => { rideChair = null; },
      // stand at a local spot facing a local target — for tests + screenshots
      view: (lx, lz, tlx, tlz, pitchDeg = 0) => {
        teleportTo(planet, dirOf(lx, lz, new THREE.Vector3()));
        const from = walk.player.clone();
        const to = worldOf(tlx, tlz, surfaceH(tlx, tlz), new THREE.Vector3());
        const u = from.clone().normalize();
        const h = to.sub(from);
        h.addScaledVector(u, -h.dot(u));
        if (h.lengthSq() > 1e-8) walk.heading.copy(h.normalize());
        walk.pitch = (pitchDeg * Math.PI) / 180;
      },
      heightAt: (lx, lz) => surfaceH(lx, lz),
      floorAt: (arr) => resolver.floor(new THREE.Vector3().fromArray(arr)),
      boardState: () => (board.v ? {
        equipped: board.equipped, riding: board.riding, air: board.v.air,
        speed: board.v.vel.length(), vUp: board.v.vUp,
        local: (localOf(board.v.pos), { lx: _L.lx, lz: _L.lz }),
      } : null),
      liftState: () => ({ L: LOOP_L, upLen, chairs: chairs.map((c) => c.s) }),
      fp: () => fpCam,
      probe: () => {
        // piste surface == grade + park features across the whole run
        let pisteErr = 0;
        for (let i = 0; i <= 20; i++) {
          const lz = lerp(LZ_TOP + 36, LZ_BASE - 40, i / 20);
          const lx = cx(lz);
          pisteErr = Math.max(pisteErr, Math.abs(surfaceH(lx, lz) - (hp(lz) + features(0, lz))));
        }
        // honest grade through the skiing band
        let gMin = 9, gMax = 0;
        for (let i = 0; i <= 40; i++) {
          const u = lerp(0.15, 0.85, i / 40);
          const lz = LZ_TOP + u * PISTE_LEN;
          const e = 0.5;
          const gz = Math.abs(hp(lz + e) - hp(lz - e)) / (2 * e);
          gMin = Math.min(gMin, gz); gMax = Math.max(gMax, gz);
        }
        // pipe symmetry + kicker lip drop
        let pipeAsym = 0;
        const plz = (PIPE_Z0 + PIPE_Z1) / 2, pcx = cx(plz);
        for (let u = 2; u <= 10; u += 1) {
          pipeAsym = Math.max(pipeAsym, Math.abs(surfaceH(pcx + u, plz) - surfaceH(pcx - u, plz)));
        }
        const k = KICKERS[2];
        const klx = cx(k.kz) + k.kx;
        const lipDrop = surfaceH(klx, k.kz - 0.2) - surfaceH(klx, k.kz + 1.2);
        // chairs sane
        const ss = chairs.map((c) => c.s).sort((a, b) => a - b);
        let gapMin = Infinity, gapMax = 0;
        for (let i = 0; i < ss.length; i++) {
          const gap = i ? ss[i] - ss[i - 1] : ss[0] + LOOP_L - ss[ss.length - 1];
          gapMin = Math.min(gapMin, gap); gapMax = Math.max(gapMax, gap);
        }
        let nan = false;
        for (let i = 0; i < grid.length; i++) if (!Number.isFinite(grid[i])) { nan = true; break; }
        return {
          baseR,
          pisteErr, gMin, gMax, pipeAsym, lipDrop,
          summitFlat: Math.abs(surfaceH(5, LZ_TOP - 5) - H_TOP),
          baseFlat: Math.abs(surfaceH(6, LZ_BASE + 6) - H_BASE),
          floorMid: resolver.floor(worldOf(cx(0), 0, hp(0), new THREE.Vector3())) - baseR,
          floorFar: resolver.floor(LANDING_DIR.clone().multiplyScalar(baseR)),
          chairGapMin: gapMin, chairGapMax: gapMax, loopL: LOOP_L, upLen,
          nan,
        };
      },
    };
  }

  return {
    compass,
    updaters: [tick],
    dir: mDir,
    jump: () => ({ dir: baseApproachDir, heading: uphill }),
    dispose,
  };
}
