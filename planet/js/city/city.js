/**
 * city.js — Procedural neon city draped over a spherical planet surface.
 *
 * COORDINATE ASSUMPTIONS
 * - The city `group` is parented to `planet.surface` and lives in UNROTATED
 *   object space: we never read/write `planet.surface.rotation` ourselves,
 *   we just place children so the planet's own spin + floating-origin
 *   rebasing carries the city along for free.
 * - `worldUp` (THREE.Vector3, world-space) is the radial landing direction:
 *   planet center -> landing point. We build the city in a local frame
 *   where local +Y = worldUp, then set group.quaternion via
 *   quaternion.setFromUnitVectors(YAXIS, worldUp) and position the group at
 *   worldUp * (planet.radius + baseHeight), converted into planet.surface's
 *   local space (planet.surface is assumed to sit at the planet's origin,
 *   i.e. local space == planet-centered space before spin).
 * - Inside the city's own local frame (children of `group`), we use a flat
 *   X/Z grid (like a normal ground-plane city) and only the group's
 *   orientation bends that flat grid onto the sphere's tangent plane at the
 *   landing point. This is correct for city-scale footprints (~300 units)
 *   against planet radii of 800-1100 units — curvature inside the footprint
 *   is handled by draping: sampleGroundLocalY solves the sphere exactly for
 *   each flat-local point (a point d from the center sits ~d²/2R above the
 *   curved ground), so buildings/streets/NPCs all sit ON the terrain instead
 *   of floating on the tangent plane.
 * - Terrain height is sampled via `planet.body.groundAt(dir)` where `dir`
 *   is a world-space unit vector from planet center through the sample
 *   point. We reconstruct `dir` per sample as
 *   (group.position + local point rotated by group.quaternion).normalize()
 *   in planet-local space, matching the host's expected convention.
 * - +Y is always "up" (radial) inside the city's local frame; buildings
 *   extrude along local +Y.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  basicVert,
  cityWindowsVert,
  cityWindowsFrag,
  pulseGlowVert,
  pulseGlowFrag,
  cityAdsFrag,
  cityHazeFrag,
} from './shaders.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const C = {
  BASE_HEIGHT_OFFSET: 0.05,        // lift above sampled ground to avoid z-fight
  SINK: 0.35,                       // drop below analytic ground: the rendered
                                    // planet mesh is coarse (384 segs) and dips
                                    // under the analytic height between vertices
                                    // — same compensation dressing.js uses.
  FOUNDATION_DEPTH: 3.0,            // towers extend this far underground so
                                    // sloped ground never shows a gap underneath
  GRID_CELL: 18,                    // street-grid cell size (block + street)
  STREET_WIDTH: 7,                  // avenue width carved out of each cell
  WIDE_AVENUE_EVERY: 4,             // every Nth grid line is a wide avenue
  WIDE_AVENUE_WIDTH: 11,
  CORE_RADIUS_FRAC: 0.35,           // fraction of city radius considered "dense core"
  OUTSKIRT_RADIUS_FRAC: 0.85,       // beyond this, sparse outskirts
  BUILDING_MIN_FOOT: 5,             // min building footprint half-size
  BUILDING_MAX_FOOT: 9,
  BUILDING_MIN_H_CORE: 22,
  BUILDING_MAX_H_CORE: 70,
  BUILDING_MIN_H_MID: 10,
  BUILDING_MAX_H_MID: 30,
  BUILDING_MIN_H_OUT: 4,
  BUILDING_MAX_H_OUT: 12,
  SETBACK_STEP_CHANCE: 0.55,        // chance a tall building gets a setback tier
  SETBACK_SHRINK: 0.62,
  WINDOW_ROW_HEIGHT: 3.2,
  FLATTEN_RADIUS: 10,               // pad flattening radius around building centers
  PLAZA_COUNT: 3,
  PLAZA_RADIUS: 16,
  PAD_LENGTH: 20,                   // landing pad long axis (fits 12-16 unit ship)
  PAD_WIDTH: 14,
  PAD_RING_SEGMENTS: 48,
  STREETLIGHT_SPACING: 22,
  STREETLIGHT_HEIGHT: 6,
  PLANTER_CHANCE: 0.35,
  KIOSK_CHANCE: 0.12,
  RAILING_HEIGHT: 0.9,
  NEON_BLOOM_INTENSITY: 1.6,        // above 0.85 bloom threshold
  NEON_DIM_INTENSITY: 0.25,
  SIGN_FLICKER_SPEED: 4.5,
  SIGN_FLICKER_AMOUNT: 0.18,
  MOTE_COUNT: 60,
  MOTE_RISE_SPEED: 0.6,
  MOTE_SPREAD: 140,
  MOTE_HEIGHT: 45,
  TRAFFIC_COUNT: 26,                // grav-car streaks circling above rooftops
  MAX_TOWER_INSTANCES: 260,
  MAX_WINDOW_INSTANCES: 260,
  MAX_SIGN_INSTANCES: 90,
};

const YAXIS = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// mulberry32 deterministic PRNG
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromDirection(dir, extra = 0) {
  const s = Math.abs(
    Math.sin(dir.x * 12.9898 + dir.y * 78.233 + dir.z * 37.719 + extra) * 43758.5453
  );
  return Math.floor((s - Math.floor(s)) * 4294967296) >>> 0;
}

// ---------------------------------------------------------------------------
// Small canvas texture helpers (no external assets — windows moved to a
// fully procedural per-cell shader, world/shaders/cityWindows.frag)
// ---------------------------------------------------------------------------
const cssColor = (hex) => `#${hex.toString(16).padStart(6, '0')}`;

// Glowing alien advertising board: dark panel, neon border, rows of blocky
// procedural glyphs (unreadable alien script) with the occasional accent bar.
function makeAdTexture(rng, palette, vertical) {
  const w = vertical ? 128 : 256;
  const h = vertical ? 256 : 128;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0a0714';
  ctx.fillRect(0, 0, w, h);
  const neons = [
    cssColor(palette.neonPrimary),
    cssColor(palette.neonSecondaryA),
    cssColor(palette.neonSecondaryB),
  ];
  const border = neons[Math.floor(rng() * neons.length)];
  ctx.strokeStyle = border;
  ctx.lineWidth = 6;
  ctx.strokeRect(5, 5, w - 10, h - 10);

  // glyph rows
  const cellW = 18, cellH = 24, pad = 16;
  const rows = Math.floor((h - pad * 2) / (cellH + 8));
  for (let r = 0; r < rows; r++) {
    const y0 = pad + r * (cellH + 8);
    // an accent bar instead of a glyph row, sometimes
    if (rng() < 0.25) {
      ctx.fillStyle = neons[Math.floor(rng() * neons.length)];
      ctx.globalAlpha = 0.85;
      ctx.fillRect(pad, y0 + cellH * 0.3, (w - pad * 2) * (0.4 + rng() * 0.6), cellH * 0.35);
      ctx.globalAlpha = 1;
      continue;
    }
    const color = neons[Math.floor(rng() * neons.length)];
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 3;
    const count = Math.max(2, Math.floor((w - pad * 2) / cellW * (0.4 + rng() * 0.6)));
    for (let g = 0; g < count; g++) {
      const x0 = pad + g * cellW;
      if (x0 + cellW > w - pad) break;
      // each glyph: 2-4 random strokes inside its cell
      const strokes = 2 + Math.floor(rng() * 3);
      for (let s = 0; s < strokes; s++) {
        if (rng() < 0.4) {
          ctx.fillRect(x0 + rng() * 8, y0 + rng() * 12, 3 + rng() * 8, 3 + rng() * 10);
        } else {
          ctx.beginPath();
          ctx.moveTo(x0 + rng() * cellW * 0.8, y0 + rng() * cellH);
          ctx.lineTo(x0 + rng() * cellW * 0.8, y0 + rng() * cellH);
          ctx.stroke();
        }
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makePanelNoiseTexture(rng) {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 150 + Math.floor(rng() * 40);
    img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v + 8; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ---------------------------------------------------------------------------
// Palette defaults (per-planet flavor hook via opts.palette)
// ---------------------------------------------------------------------------
const DEFAULT_PALETTE = {
  neonPrimary: 0xd4408f,   // magenta
  neonSecondaryA: 0x40d4c8, // cyan
  neonSecondaryB: 0xffb347, // amber
  hullA: 0x3a3550,
  hullB: 0x2a2740,
  street: 0x1c1a28,
  plaza: 0x241f38,
  windowWarm: '#ffe9b0',
};

// ---------------------------------------------------------------------------
// Per-world style presets (opts.style). Each world picks one deterministically
// (walk.js), so every planet's city has its own skyline and color identity.
// ---------------------------------------------------------------------------
export const CITY_STYLES = [
  {
    name: 'neonMetropolis', // Tokyo/NYC — tall, dense, plastered in alien ads
    heightScale: 1.6,
    density: 1.2,
    signChance: 0.85,
    adBillboards: true,
    flickerAmount: 0.3,
    palette: {
      neonPrimary: 0xff2fa0, neonSecondaryA: 0x2fe8ff, neonSecondaryB: 0xd8ff2f,
      hullA: 0x2c2a44, hullB: 0x1d1b30, street: 0x16141f, plaza: 0x201b33,
      windowWarm: '#ffe9b0',
    },
  },
  {
    name: 'dustOutpost', // low-rise frontier town, muted rust and amber
    heightScale: 0.45,
    density: 0.7,
    signChance: 0.15,
    adBillboards: false,
    flickerAmount: 0.12,
    palette: {
      neonPrimary: 0xffb347, neonSecondaryA: 0xff7847, neonSecondaryB: 0xffd9a0,
      hullA: 0x4a3d33, hullB: 0x3a3028, street: 0x2a231c, plaza: 0x332a20,
      windowWarm: '#ffd9a0',
    },
  },
  {
    name: 'verdantTerrace', // mid-rise garden city, teal/green/violet
    heightScale: 0.8,
    density: 0.9,
    signChance: 0.45,
    adBillboards: false,
    flickerAmount: 0.18,
    palette: {
      neonPrimary: 0x40d4c8, neonSecondaryA: 0x7dff6a, neonSecondaryB: 0xb47dff,
      hullA: 0x2f4038, hullB: 0x243329, street: 0x1b241d, plaza: 0x223026,
      windowWarm: '#eaffd8',
    },
  },
  {
    name: 'tideLuminous', // neptunia's shore city — bioluminescent indigo/cyan
    heightScale: 0.8,
    density: 0.7,
    signChance: 0.5,
    adBillboards: false,
    flickerAmount: 0.15,
    palette: {
      neonPrimary: 0x4adfff, neonSecondaryA: 0x9a6aff, neonSecondaryB: 0x6a8fff,
      hullA: 0x1a1f4a, hullB: 0x252a5e, street: 0x101430, plaza: 0x161b3c,
      windowWarm: '#9ab8ff',
    },
  },
  {
    name: 'frostHaven', // cold-world settlement, ice blue/white with warm doors
    heightScale: 0.65,
    density: 0.8,
    signChance: 0.35,
    adBillboards: false,
    flickerAmount: 0.15,
    palette: {
      neonPrimary: 0x6ac8ff, neonSecondaryA: 0xdff4ff, neonSecondaryB: 0xffa347,
      hullA: 0x3d4a5c, hullB: 0x2c3847, street: 0x1e2733, plaza: 0x26313e,
      windowWarm: '#dff4ff',
    },
  },
];

// ---------------------------------------------------------------------------
// Walkable-structure helper: given axis-aligned slab/ramp surfaces and wall
// AABBs in an origin-local frame, returns the {surfaceYAt, resolveWalls}
// contract walk.js consumes. Shared by the landmark tower and the enterable
// building lobbies so both feel identical underfoot.
// ---------------------------------------------------------------------------
const STRUCT_STEP_UP = 0.7;
// Exported for stationWalk.js: the gallery's spine rooms reuse this exact
// contract so the station walker feels identical underfoot to the lobbies.
export function makeStructure(ox, oz, baseY, surfaces, walls, halfExtent) {
  return {
    x: ox, z: oz, baseY,
    // Highest walkable slab/ramp under (x,z) reachable from feetY, or null.
    surfaceYAt(x, z, feetY) {
      const lx = x - ox, lz = z - oz;
      if (lx < -halfExtent - 0.4 || lx > halfExtent + 0.4 ||
          lz < -halfExtent - 0.4 || lz > halfExtent + 0.4) return null;
      let best = null;
      for (const s of surfaces) {
        if (lx < s.x0 || lx > s.x1 || lz < s.z0 || lz > s.z1) continue;
        let y;
        if (s.ramp) {
          const t = THREE.MathUtils.clamp((lz - s.zA) / (s.zB - s.zA), 0, 1);
          y = s.yA + (s.yB - s.yA) * t;
        } else {
          y = s.y;
        }
        y += baseY;
        if (y <= feetY + STRUCT_STEP_UP && (best === null || y > best)) best = y;
      }
      return best;
    },
    // 2D AABB push-out for walls whose height band overlaps the body. p is a
    // city-local position (y = feet); returns true if it moved.
    resolveWalls(p, r) {
      let lx = p.x - ox, lz = p.z - oz;
      if (Math.abs(lx) > halfExtent + 2 || Math.abs(lz) > halfExtent + 2) return false;
      const feet = p.y - baseY;
      let pushed = false;
      for (const w of walls) {
        if (feet >= w.y1 || feet + 1.7 <= w.y0) continue;
        const ex0 = w.x0 - r, ex1 = w.x1 + r, ez0 = w.z0 - r, ez1 = w.z1 + r;
        if (lx <= ex0 || lx >= ex1 || lz <= ez0 || lz >= ez1) continue;
        const dx = Math.min(lx - ex0, ex1 - lx);
        const dz = Math.min(lz - ez0, ez1 - lz);
        if (dx < dz) lx = lx - ex0 < ex1 - lx ? ex0 : ex1;
        else lz = lz - ez0 < ez1 - lz ? ez0 : ez1;
        pushed = true;
      }
      if (pushed) { p.x = ox + lx; p.z = oz + lz; }
      return pushed;
    },
  };
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------
export function createCity(planet, worldUp, opts = {}) {
  const radius = opts.radius ?? 300;
  const style = opts.style ?? null;
  const palette = { ...DEFAULT_PALETTE, ...(style?.palette ?? {}), ...(opts.palette ?? {}) };
  const density = opts.density ?? style?.density ?? 1.0;
  const heightScale = style?.heightScale ?? 1.0;
  const signChance = style?.signChance ?? 0.6;
  const flickerAmount = style?.flickerAmount ?? C.SIGN_FLICKER_AMOUNT;
  const dirSeeded = worldUp.clone().normalize();
  const seed = opts.seed ?? seedFromDirection(dirSeeded);
  const rng = mulberry32(seed);

  const group = new THREE.Group();
  group.name = 'City';

  // Fill light: the global scene ambient is very dim (built for the vacuum of
  // space), so backlit building facades otherwise fall to near-black. A
  // hemisphere fill (cool sky above, street-toned bounce below) models the
  // facades better than a flat ambient at the same budget. It lives on the
  // city group, so it only affects the landing site and is torn down with the
  // city when the player boards (nothing else is in view on foot anyway).
  const fillLight = new THREE.HemisphereLight(0x7d8ab0, palette.plaza, 0.75);
  group.add(fillLight);

  // Shared FX uniforms: every shader-driven element (windows, signs, ads,
  // haze) reads time + night level from these two objects, so update()
  // writes two numbers instead of walking material lists.
  const fx = { uTime: { value: 0 }, uNight: { value: 0 } };
  const ownedTextures = []; // textures held in shader uniforms (not .map)
  const structures = []; // enterable buildings: landmark tower + lobbies
  const lobbies = [];    // per-lobby manifest for interior occupants (walk.js)
  let balconySpot = null; // landmark balcony perch for a lone caretaker
  // Growth support (jfeelgood): per-tower specs let setDevelopment() rescale
  // building heights so the city rises from huts to skyscrapers in place, and
  // a list of "mature" set-pieces (billboards, landmark, lobbies) that only
  // appear once the civilisation is advanced enough.
  const growSpecs = [];
  const matureExtras = []; // { obj, devMin }

  // The group lives as a child of planet.surface, whose local frame is the
  // planet's UNROTATED object space — so undo the current spin to convert
  // the world-space landing dir into the frame we actually place in.
  // (dirSeeded stays world-space for deterministic seeding.)
  const rotY = planet.surface?.rotation?.y ?? 0;
  const dirLocal = dirSeeded.clone().applyAxisAngle(YAXIS, -rotY);

  // Orient +Y to the landing dir, position at surface radial point.
  const quat = new THREE.Quaternion().setFromUnitVectors(YAXIS, dirLocal);
  group.quaternion.copy(quat);

  const groundBase = planet.body?.groundAtLocal
    ? planet.body.groundAtLocal(dirLocal)
    : planet.body?.groundAt
      ? planet.body.groundAt(dirSeeded)
      : 0;
  let baseRadius = (planet.radius ?? 900) + groundBase + C.BASE_HEIGHT_OFFSET;
  // Never sink the deck below the sea surface (or ice sheet): a city landing
  // in a wet/icy region rides just above it instead of flooding.
  if (planet.water?.r && baseRadius < planet.water.r + 0.4) {
    baseRadius = planet.water.r + 0.4;
  }
  group.position.copy(dirLocal.clone().multiplyScalar(baseRadius));

  // -------------------------------------------------------------------------
  // Terrain sampling in local (flat) space -> world dir -> planet.body height
  // -------------------------------------------------------------------------
  const tmpWorldPos = new THREE.Vector3();
  const tmpDir = new THREE.Vector3();

  function sampleGroundLocalY(localX, localZ) {
    // tmpDir is in planet.surface's unrotated frame (group lives there),
    // so sample via groundAtLocal — groundAt would un-spin it a second time.
    tmpWorldPos.set(localX, 0, localZ).applyQuaternion(quat).add(group.position);
    tmpDir.copy(tmpWorldPos).normalize();
    const h = planet.body?.groundAtLocal ? planet.body.groundAtLocal(tmpDir) : 0;
    const planetR = planet.radius ?? 900;
    // Ground radius under this point, clamped to the water surface so streets
    // crossing a wet spot ride it as a causeway instead of sinking under.
    let rr = planetR + h;
    if (planet.water?.r) rr = Math.max(rr, planet.water.r + 0.4);
    // Drop the flat tangent-plane point onto the sphere: a local point at
    // distance d from the city center sits ~d²/2R above the curved ground,
    // which floated the whole rim before. Solve the sphere exactly instead of
    // returning the radial height difference.
    const d2 = localX * localX + localZ * localZ;
    return Math.sqrt(Math.max(rr * rr - d2, 0)) - baseRadius - C.SINK;
  }

  // Is the terrain under this local point below the sea surface? (Buildings,
  // dressing, and the landing pad never go in the water; streets bridge it.)
  function isWetLocal(localX, localZ) {
    if (!planet.water?.r) return false;
    tmpWorldPos.set(localX, 0, localZ).applyQuaternion(quat).add(group.position);
    tmpDir.copy(tmpWorldPos).normalize();
    const h = planet.body?.groundAtLocal ? planet.body.groundAtLocal(tmpDir) : 0;
    return (planet.radius ?? 900) + h < planet.water.r + 0.4;
  }

  // -------------------------------------------------------------------------
  // Flattening pads: list of {x,z,r,y} — locally flattened footprints
  // -------------------------------------------------------------------------
  const flattenPads = [];
  function flattenedHeight(x, z) {
    let best = null;
    for (const p of flattenPads) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d <= p.r) {
        const blend = 1 - THREE.MathUtils.smoothstep(d, p.r * 0.6, p.r);
        if (best === null) best = p.y;
        best = THREE.MathUtils.lerp(sampleGroundLocalY(x, z), p.y, blend);
      }
    }
    return best === null ? sampleGroundLocalY(x, z) : best;
  }

  // -------------------------------------------------------------------------
  // Street grid layout
  // -------------------------------------------------------------------------
  const halfCells = Math.ceil(radius / C.GRID_CELL);
  const buildingSlots = []; // {x, z, footHalf, isCore, isMid}
  const plazaCenters = [];
  const streetMaterial = new THREE.MeshStandardMaterial({
    color: palette.street, roughness: 0.9, metalness: 0.05,
  });
  const streetGeos = [];

  // pre-pick plaza cells deterministically (retry onto dry ground)
  for (let i = 0; i < C.PLAZA_COUNT; i++) {
    let px = 0, pz = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      const ang = rng() * Math.PI * 2;
      const dist = radius * (0.15 + rng() * 0.55);
      px = Math.cos(ang) * dist;
      pz = Math.sin(ang) * dist;
      if (!isWetLocal(px, pz)) break;
    }
    plazaCenters.push({ x: px, z: pz, r: C.PLAZA_RADIUS });
  }

  // landing pad: pick an open ring position near mid-radius, on dry ground
  // (keep the last candidate as a fallback on a mostly-wet site)
  const padCenter = new THREE.Vector2();
  for (let attempt = 0; attempt < 12; attempt++) {
    const ang = rng() * Math.PI * 2;
    const dist = radius * (0.55 + rng() * 0.2);
    padCenter.set(Math.cos(ang) * dist, Math.sin(ang) * dist);
    if (!isWetLocal(padCenter.x, padCenter.y)) break;
  }
  flattenPads.push({ x: padCenter.x, z: padCenter.y, r: Math.max(C.PAD_LENGTH, C.PAD_WIDTH) * 0.75, y: sampleGroundLocalY(padCenter.x, padCenter.y) });
  for (const pz of plazaCenters) {
    flattenPads.push({ x: pz.x, z: pz.z, r: pz.r, y: sampleGroundLocalY(pz.x, pz.z) });
  }

  function inPlaza(x, z) {
    for (const p of plazaCenters) if (Math.hypot(x - p.x, z - p.z) < p.r) return true;
    if (Math.hypot(x - padCenter.x, z - padCenter.y) < Math.max(C.PAD_LENGTH, C.PAD_WIDTH) * 0.75) return true;
    return false;
  }

  // Reserve a dry cell near the center for the landmark observation tower —
  // the one building the player can enter and climb (built further down).
  let landmarkSpot = null;
  outer: for (let ring = 1; ring <= 3; ring++) {
    for (let gx = -ring; gx <= ring; gx++) {
      for (let gz = -ring; gz <= ring; gz++) {
        if (Math.max(Math.abs(gx), Math.abs(gz)) !== ring) continue;
        const cx = gx * C.GRID_CELL, cz = gz * C.GRID_CELL;
        if (inPlaza(cx, cz) || isWetLocal(cx, cz)) continue;
        landmarkSpot = { x: cx, z: cz };
        break outer;
      }
    }
  }
  if (landmarkSpot) {
    flattenPads.push({
      x: landmarkSpot.x, z: landmarkSpot.z, r: 17,
      y: sampleGroundLocalY(landmarkSpot.x, landmarkSpot.z),
    });
  }

  for (let gx = -halfCells; gx <= halfCells; gx++) {
    for (let gz = -halfCells; gz <= halfCells; gz++) {
      const cx = gx * C.GRID_CELL;
      const cz = gz * C.GRID_CELL;
      const distFromCenter = Math.hypot(cx, cz);
      if (distFromCenter > radius) continue;
      if (inPlaza(cx, cz)) continue;
      if (isWetLocal(cx, cz)) continue; // never build in the water

      if (landmarkSpot && Math.hypot(cx - landmarkSpot.x, cz - landmarkSpot.z) < 16) continue;

      const isWideRow = (gx % C.WIDE_AVENUE_EVERY === 0) || (gz % C.WIDE_AVENUE_EVERY === 0);
      const streetHalf = (isWideRow ? C.WIDE_AVENUE_WIDTH : C.STREET_WIDTH) / 2;
      const blockHalf = C.GRID_CELL / 2 - streetHalf;
      if (blockHalf <= C.BUILDING_MIN_FOOT * 0.5) continue; // pure street cell

      const fracR = distFromCenter / radius;
      const isCore = fracR < C.CORE_RADIUS_FRAC;
      const isOutskirt = fracR > C.OUTSKIRT_RADIUS_FRAC;
      const spawnChance = isCore ? 0.95 : isOutskirt ? 0.35 * density : 0.7 * density;
      if (rng() > spawnChance) continue;

      const footHalf = THREE.MathUtils.clamp(
        blockHalf * (0.55 + rng() * 0.35), C.BUILDING_MIN_FOOT, C.BUILDING_MAX_FOOT
      );
      buildingSlots.push({ x: cx + (rng() - 0.5) * 2, z: cz + (rng() - 0.5) * 2, footHalf, isCore, isOutskirt });
      flattenPads.push({ x: cx, z: cz, r: footHalf + 2, y: sampleGroundLocalY(cx, cz) });
    }
  }

  // Pick a few roomy buildings to be genuinely enterable — a lit ground-floor
  // lobby you can walk into (the rest get a mock doorway). Spread them out so
  // they aren't clustered, and keep them clear of the landmark tower.
  const lobbySlots = [];
  for (const slot of buildingSlots) {
    if (lobbySlots.length >= 4) break;
    if (slot.footHalf < C.BUILDING_MIN_FOOT - 0.1) continue;
    if (landmarkSpot && Math.hypot(slot.x - landmarkSpot.x, slot.z - landmarkSpot.z) < 32) continue;
    if (lobbySlots.some((s) => Math.hypot(s.x - slot.x, s.z - slot.z) < 40)) continue;
    slot.isLobby = true;
    lobbySlots.push(slot);
  }

  // Build a merged street-surface mesh draped to terrain height. A plain
  // CircleGeometry is a triangle FAN (center + rim vertices only), so draping
  // its vertices produced a flat cone. Use a radially subdivided ring (real
  // interior vertices) plus a tiny center cap so the surface actually follows
  // the terrain between the center and the rim.
  {
    const drape = (geo) => {
      const posAttr = geo.attributes.position;
      for (let i = 0; i < posAttr.count; i++) {
        const x = posAttr.getX(i);
        const z = posAttr.getZ(i);
        posAttr.setY(i, flattenedHeight(x, z) - 0.05);
      }
      posAttr.needsUpdate = true;
      geo.computeVertexNormals();
      streetGeos.push(geo);
    };
    const ringGeo = new THREE.RingGeometry(2, radius, 64, 20);
    ringGeo.rotateX(-Math.PI / 2);
    drape(ringGeo);
    const capGeo = new THREE.CircleGeometry(2.05, 16);
    capGeo.rotateX(-Math.PI / 2);
    drape(capGeo);
  }
  const streetMesh = new THREE.Mesh(mergeGeometries(streetGeos), streetMaterial);
  streetMesh.receiveShadow = false;
  group.add(streetMesh);

  // -------------------------------------------------------------------------
  // Buildings — InstancedMesh towers (box body) + window-strip instances +
  // rooftop neon sign instances
  // -------------------------------------------------------------------------
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  // A faint self-lit floor (the hull's own hue, dimmed) so even a fully
  // backlit facade never crushes to black against a bright horizon.
  const hullEmissive = new THREE.Color(palette.hullA).multiplyScalar(1.0);
  const hullMat = new THREE.MeshStandardMaterial({
    color: palette.hullA, roughness: 0.75, metalness: 0.2,
    map: makePanelNoiseTexture(rng),
    emissive: hullEmissive, emissiveIntensity: 0.3,
  });
  const towerCount = Math.min(buildingSlots.length, C.MAX_TOWER_INSTANCES);
  const towerMesh = new THREE.InstancedMesh(boxGeo, hullMat, towerCount);
  towerMesh.frustumCulled = false;
  const towerColor = new THREE.Color();

  // Window shell: fully procedural per-cell window grid (cityWindows.frag).
  // Each instance carries a seed so towers never share a lit pattern, and
  // individual windows wink on/off over time at night.
  const windowGeo = new THREE.BoxGeometry(1, 1, 1);
  const windowCap = Math.min(towerCount, C.MAX_WINDOW_INSTANCES);
  const windowSeeds = new Float32Array(Math.max(windowCap, 1));
  for (let i = 0; i < windowSeeds.length; i++) windowSeeds[i] = rng() * 100;
  windowGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(windowSeeds, 1));
  const windowMat = new THREE.ShaderMaterial({
    vertexShader: cityWindowsVert,
    fragmentShader: cityWindowsFrag,
    uniforms: {
      uTime: fx.uTime,
      uNight: fx.uNight,
      uWarm: { value: new THREE.Color(palette.windowWarm) },
      uFacade: { value: new THREE.Color(palette.hullB).multiplyScalar(0.55) },
    },
  });
  const windowMesh = new THREE.InstancedMesh(windowGeo, windowMat, windowCap);
  windowMesh.frustumCulled = false;

  // Rooftop signs: instanced pulse-glow shader — per-sign phase and accent
  // tint attributes give every sign its own flicker clock and neon colour.
  const signGeo = new THREE.BoxGeometry(1, 1, 1);
  const signCap = Math.min(towerCount, C.MAX_SIGN_INSTANCES);
  const signPhases = new Float32Array(Math.max(signCap, 1));
  const signTints = new Float32Array(Math.max(signCap, 1) * 3);
  signGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(signPhases, 1));
  signGeo.setAttribute('aTint', new THREE.InstancedBufferAttribute(signTints, 3));
  const signMat = new THREE.ShaderMaterial({
    vertexShader: pulseGlowVert,
    fragmentShader: pulseGlowFrag,
    uniforms: {
      uTime: fx.uTime,
      uNight: fx.uNight,
      uBase: { value: C.NEON_BLOOM_INTENSITY * 0.75 },
      uAmp: { value: C.NEON_BLOOM_INTENSITY * 0.35 },
      uSpeed: { value: 0.9 },
      uFlicker: { value: flickerAmount * 2.5 },
    },
  });
  const signMesh = new THREE.InstancedMesh(signGeo, signMat, signCap);
  signMesh.frustumCulled = false;

  const colliders = [];
  const collidersLocal = []; // city-flat {x,z,radius,height} — aliens.js format
  const billboardSpecs = []; // Tokyo-style wall ads (neonMetropolis only)
  const doorSpecs = [];      // mock lit entrances, one per instanced tower
  const dummy = new THREE.Object3D();
  const signAccentColors = [palette.neonPrimary, palette.neonSecondaryA, palette.neonSecondaryB];
  let signIdx = 0;
  let windowIdx = 0;
  let towerIdx = 0; // written-instance count (lobby slots are skipped)

  const worldPosScratch = new THREE.Vector3();

  for (let i = 0; i < towerCount; i++) {
    const slot = buildingSlots[i];
    if (slot.isLobby) continue; // built as an enterable lobby below, not here
    const heightRange = slot.isCore
      ? [C.BUILDING_MIN_H_CORE, C.BUILDING_MAX_H_CORE]
      : slot.isOutskirt
      ? [C.BUILDING_MIN_H_OUT, C.BUILDING_MAX_H_OUT]
      : [C.BUILDING_MIN_H_MID, C.BUILDING_MAX_H_MID];
    const height = THREE.MathUtils.lerp(heightRange[0], heightRange[1], rng()) * heightScale;
    const baseY = flattenedHeight(slot.x, slot.z);
    const footW = slot.footHalf * 2 * (0.85 + rng() * 0.3);
    const footD = slot.footHalf * 2 * (0.85 + rng() * 0.3);

    const doSetback = height > C.BUILDING_MIN_H_MID * 1.5 && rng() < C.SETBACK_STEP_CHANCE;
    const bodyHeight = doSetback ? height * (0.55 + rng() * 0.2) : height;

    // Extend the box down into the ground (foundation) so sloped terrain
    // under a jittered footprint never shows a gap beneath the walls.
    const rotY = rng() * Math.PI * 2;
    const inst = towerIdx++;
    dummy.position.set(slot.x, baseY - C.FOUNDATION_DEPTH + (bodyHeight + C.FOUNDATION_DEPTH) / 2, slot.z);
    dummy.scale.set(footW, bodyHeight + C.FOUNDATION_DEPTH, footD);
    dummy.rotation.set(0, rotY, 0);
    dummy.updateMatrix();
    towerMesh.setMatrixAt(inst, dummy.matrix);
    towerColor.set(rng() < 0.5 ? palette.hullA : palette.hullB);
    towerMesh.setColorAt(inst, towerColor);

    // Record everything setDevelopment() needs to regrow this tower (and its
    // window shell + rooftop sign) from the ground. jit is a deterministic
    // per-instance offset so we never touch the layout PRNG stream.
    const spec = {
      inst, x: slot.x, z: slot.z, baseY, footW, footD, rotY, bodyHeight,
      winInst: -1, signInst: -1, signRotY: 0, signFootW: footW * 0.5,
      jit: (((inst * 2654435761) >>> 0) % 1000) / 1000,
    };
    growSpecs.push(spec);

    // mock lit entrance on one face at street level (real lobbies handled
    // separately). Face the building's local +Z, whatever way it was rotated.
    doorSpecs.push({ x: slot.x, z: slot.z, rotY, footD, baseY });

    if (doSetback && signIdx < signMesh.count) {
      // upper setback tier gets its own smaller box merged visually via a
      // second instanced write reusing the tower buffer would exceed count,
      // so we approximate the setback as a stepped silhouette using the
      // sign instance as a slim rooftop crown, then place the neon sign atop.
    }

    // window strip band along the taller faces
    if (windowIdx < windowMesh.count) {
      spec.winInst = windowIdx;
      dummy.position.set(slot.x, baseY + bodyHeight * 0.55, slot.z);
      dummy.scale.set(footW * 1.001, bodyHeight * 0.85, footD * 1.001);
      dummy.updateMatrix();
      windowMesh.setMatrixAt(windowIdx, dummy.matrix);
      windowIdx++;
    }

    // rooftop neon sign (only on taller / core buildings for restraint)
    if ((slot.isCore || bodyHeight > 25) && rng() < signChance && signIdx < signMesh.count) {
      const sRot = rng() * Math.PI * 2;
      spec.signInst = signIdx;
      spec.signRotY = sRot;
      dummy.position.set(slot.x, baseY + bodyHeight + 1.4, slot.z);
      dummy.scale.set(footW * 0.5, 2.2, 0.6);
      dummy.rotation.set(0, sRot, 0);
      dummy.updateMatrix();
      signMesh.setMatrixAt(signIdx, dummy.matrix);
      signPhases[signIdx] = rng() * Math.PI * 2;
      towerColor.set(signAccentColors[Math.floor(rng() * signAccentColors.length)]);
      signTints[signIdx * 3] = towerColor.r;
      signTints[signIdx * 3 + 1] = towerColor.g;
      signTints[signIdx * 3 + 2] = towerColor.b;
      signIdx++;
    }

    // wall-mounted ad billboards (neon metropolis style)
    if (style?.adBillboards && bodyHeight > 14 && billboardSpecs.length < 40 && rng() < 0.55) {
      billboardSpecs.push({
        x: slot.x, z: slot.z, rotY, footW, footD, baseY, bodyHeight,
        face: Math.floor(rng() * 4),
        frac: 0.3 + rng() * 0.4,   // height up the wall
        vertical: rng() < 0.4,     // tall banner vs wide board
        tex: Math.floor(rng() * 4),
      });
    }

    worldPosScratch.set(slot.x, 0, slot.z).applyQuaternion(quat).add(group.position);
    colliders.push({
      center: worldPosScratch.clone(),
      radius: Math.max(footW, footD) * 0.5 + 0.4,
      height: bodyHeight,
    });
    collidersLocal.push({
      x: slot.x,
      z: slot.z,
      radius: Math.max(footW, footD) * 0.5 + 0.4,
      height: bodyHeight,
      baseY, // city-local ground level at this tower (walk.js roof checks)
    });
  }
  towerMesh.count = towerIdx;
  windowMesh.count = windowIdx;
  signMesh.count = signIdx;
  towerMesh.instanceMatrix.needsUpdate = true;
  windowMesh.instanceMatrix.needsUpdate = true;
  signMesh.instanceMatrix.needsUpdate = true;
  if (towerMesh.instanceColor) towerMesh.instanceColor.needsUpdate = true;
  group.add(towerMesh, windowMesh, signMesh);

  const adMats = []; // emissive materials that ride the day/night neon dimming

  // -------------------------------------------------------------------------
  // Mock entrances — a lit doorway panel + frame on each instanced tower, so
  // the towers read as inhabited buildings instead of blank blocks. Merged
  // into two meshes (recess + frame). Real, enterable lobbies are built later.
  // -------------------------------------------------------------------------
  if (doorSpecs.length) {
    const DOOR_W = 2.4, DOOR_HT = 3.0;
    const panelGeos = [], frameGeos = [];
    const dm = new THREE.Matrix4(), dq = new THREE.Quaternion();
    const dp = new THREE.Vector3(), ds = new THREE.Vector3(1, 1, 1);
    for (const dsp of doorSpecs) {
      const nx = Math.sin(dsp.rotY), nz = Math.cos(dsp.rotY); // local +Z, rotated
      const out = dsp.footD * 0.5;
      dq.setFromAxisAngle(YAXIS, dsp.rotY);
      // the glowing recess, sunk 0.05 into the face
      dp.set(dsp.x + nx * (out - 0.05), dsp.baseY + DOOR_HT / 2, dsp.z + nz * (out - 0.05));
      const panel = new THREE.PlaneGeometry(DOOR_W, DOOR_HT);
      panel.applyMatrix4(dm.compose(dp, dq, ds));
      panelGeos.push(panel);
      // a thin frame proud of the wall (two jambs + a lintel)
      for (const off of [-DOOR_W / 2, DOOR_W / 2]) {
        const jamb = new THREE.BoxGeometry(0.16, DOOR_HT + 0.3, 0.16);
        dp.set(dsp.x + nx * (out + 0.05) - nz * off,
               dsp.baseY + (DOOR_HT + 0.3) / 2,
               dsp.z + nz * (out + 0.05) + nx * off);
        jamb.applyMatrix4(dm.compose(dp, dq, ds));
        frameGeos.push(jamb);
      }
      const lintel = new THREE.BoxGeometry(DOOR_W + 0.3, 0.16, 0.16);
      dp.set(dsp.x + nx * (out + 0.05), dsp.baseY + DOOR_HT + 0.15, dsp.z + nz * (out + 0.05));
      lintel.applyMatrix4(dm.compose(dp, dq, ds));
      frameGeos.push(lintel);
    }
    const panelMat = new THREE.MeshStandardMaterial({
      color: 0x120a04, emissive: new THREE.Color(palette.windowWarm),
      emissiveIntensity: C.NEON_BLOOM_INTENSITY * 0.6, roughness: 0.5,
      side: THREE.DoubleSide,
    });
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x14121e, emissive: new THREE.Color(palette.neonSecondaryA),
      emissiveIntensity: C.NEON_BLOOM_INTENSITY * 0.4, roughness: 0.4,
    });
    const panelMesh = new THREE.Mesh(mergeGeometries(panelGeos), panelMat);
    const frameMesh = new THREE.Mesh(mergeGeometries(frameGeos), frameMat);
    panelMesh.frustumCulled = false;
    frameMesh.frustumCulled = false;
    group.add(panelMesh, frameMesh);
    adMats.push(panelMat, frameMat);
  }

  // -------------------------------------------------------------------------
  // Ad billboards — merged planes per texture, glued to tower walls
  // -------------------------------------------------------------------------
  if (billboardSpecs.length) {
    const adTexes = Array.from({ length: 4 }, (_, i) => makeAdTexture(rng, palette, i % 2 === 1));
    const perTexGeos = adTexes.map(() => []);
    const adMatrix = new THREE.Matrix4();
    const adQuat = new THREE.Quaternion();
    const adPos = new THREE.Vector3();
    const adScale = new THREE.Vector3(1, 1, 1);
    for (const b of billboardSpecs) {
      const w = b.vertical ? 2.2 + (b.frac % 0.1) * 10 : 5 + (b.frac % 0.2) * 20;
      const h = b.vertical ? 8 + (b.frac % 0.15) * 40 : 3 + (b.frac % 0.1) * 20;
      if (h + 2 > b.bodyHeight) continue; // wall too short for this board
      // face 0..3 -> +z, +x, -z, -x of the tower's rotated frame
      const faceAng = b.rotY + b.face * Math.PI * 0.5;
      const halfOut = (b.face % 2 === 0 ? b.footD : b.footW) * 0.5 + 0.12;
      const sin = Math.sin(faceAng), cos = Math.cos(faceAng);
      adPos.set(b.x + sin * halfOut, b.baseY + Math.min(b.bodyHeight * b.frac, b.bodyHeight - h / 2 - 1) + h / 2, b.z + cos * halfOut);
      adQuat.setFromAxisAngle(YAXIS, faceAng);
      const geo = new THREE.PlaneGeometry(w, h);
      geo.applyMatrix4(adMatrix.compose(adPos, adQuat, adScale));
      perTexGeos[b.tex].push(geo);
    }
    // Animated holo-boards (cityAds.frag): highlight sweep + scanlines +
    // occasional glitch tear over the seeded glyph canvas. Day/night level
    // rides the shared fx uniforms.
    for (let i = 0; i < adTexes.length; i++) {
      if (!perTexGeos[i].length) { adTexes[i].dispose(); continue; }
      const mat = new THREE.ShaderMaterial({
        vertexShader: basicVert,
        fragmentShader: cityAdsFrag,
        uniforms: { uMap: { value: adTexes[i] }, uTime: fx.uTime, uNight: fx.uNight },
        side: THREE.DoubleSide,
      });
      ownedTextures.push(adTexes[i]);
      const mesh = new THREE.Mesh(mergeGeometries(perTexGeos[i]), mat);
      mesh.frustumCulled = false;
      group.add(mesh);
      matureExtras.push({ obj: mesh, devMin: 0.88 }); // ads only in the late metropolis
    }
  }

  // -------------------------------------------------------------------------
  // Landmark observation tower — the one building you can enter: ground-floor
  // doorway, switchback stairs up open-air floors, railed balcony on top.
  // Axis-aligned in city-local space so walkable surfaces and walls stay
  // simple AABBs (consumed by walk.js via city.landmark).
  // -------------------------------------------------------------------------
  let landmark = null;
  if (landmarkSpot) {
    const HALF = 7, FLOOR_H = 4.5, FLOORS = 5, WALL_T = 0.4;
    const SX0 = -6.6, SX1 = -3.4;   // stairwell x band, hugging the -x wall
    const ZRUN = 4.6;               // flights run z: -ZRUN..+ZRUN
    const DOOR_HALF = 1.3, DOOR_H = 3.2, PARAPET = 1.1, SLAB_T = 0.3;
    const TOP = FLOORS * FLOOR_H;
    const lmBaseY = flattenedHeight(landmarkSpot.x, landmarkSpot.z);
    const lmSurfaces = []; // {x0,x1,z0,z1, y} flat | {..., ramp:true, zA,zB,yA,yB}
    const lmWalls = [];    // {x0,x1,z0,z1, y0,y1} — y relative to lmBaseY

    const hullGeos = [];
    const glowGeos = [];
    const lmBox = (w, h, d, x, y, z, geos = hullGeos, rotX = 0) => {
      const g = new THREE.BoxGeometry(w, h, d);
      if (rotX) g.rotateX(rotX);
      g.translate(landmarkSpot.x + x, lmBaseY + y, landmarkSpot.z + z);
      geos.push(g);
    };
    const wall = (x0, x1, z0, z1, y0, y1) => lmWalls.push({ x0, x1, z0, z1, y0, y1 });

    // ground slab (top at 0.3)
    lmBox(HALF * 2 + 0.6, 0.6, HALF * 2 + 0.6, 0, 0, 0);
    lmSurfaces.push({ x0: -HALF, x1: HALF, z0: -HALF, z1: HALF, y: 0.3 });

    // corner pillars
    for (const px of [-HALF + 0.4, HALF - 0.4]) {
      for (const pz of [-HALF + 0.4, HALF - 0.4]) {
        lmBox(0.8, TOP + PARAPET, 0.8, px, (TOP + PARAPET) / 2, pz);
        wall(px - 0.4, px + 0.4, pz - 0.4, pz + 0.4, 0, TOP + PARAPET);
      }
    }

    // -x wall: solid the full height (backs the stairwell)
    lmBox(WALL_T, TOP + PARAPET, HALF * 2, -(HALF - WALL_T / 2), (TOP + PARAPET) / 2, 0);
    wall(-HALF - 0.1, -HALF + WALL_T, -HALF - 0.1, HALF + 0.1, 0, TOP + PARAPET);

    // ground floor: +x wall with the doorway, solid ±z walls
    const doorSegLen = HALF - DOOR_HALF;
    for (const s of [-1, 1]) {
      lmBox(WALL_T, FLOOR_H, doorSegLen, HALF - WALL_T / 2, FLOOR_H / 2, s * (DOOR_HALF + doorSegLen / 2));
      wall(HALF - WALL_T, HALF + 0.1, s === -1 ? -HALF - 0.1 : DOOR_HALF, s === -1 ? -DOOR_HALF : HALF + 0.1, 0, FLOOR_H);
    }
    lmBox(WALL_T, FLOOR_H - DOOR_H, DOOR_HALF * 2, HALF - WALL_T / 2, DOOR_H + (FLOOR_H - DOOR_H) / 2, 0);
    wall(HALF - WALL_T, HALF + 0.1, -DOOR_HALF, DOOR_HALF, DOOR_H, FLOOR_H);
    for (const s of [-1, 1]) {
      lmBox(HALF * 2, FLOOR_H, WALL_T, 0, FLOOR_H / 2, s * (HALF - WALL_T / 2));
      wall(-HALF - 0.1, HALF + 0.1, s === -1 ? -HALF - 0.1 : HALF - WALL_T, s === -1 ? -HALF + WALL_T : HALF + 0.1, 0, FLOOR_H);
    }

    // upper floors: main slab (east of the stairwell), landing, parapets
    for (let f = 1; f <= FLOORS; f++) {
      const y = f * FLOOR_H + 0.3;
      const mainW = HALF - SX1;
      lmBox(mainW, SLAB_T, HALF * 2, (SX1 + HALF) / 2, y - SLAB_T / 2, 0);
      lmSurfaces.push({ x0: SX1, x1: HALF, z0: -HALF, z1: HALF, y });
      // arrival landing for the flight below (alternating side)
      const side = (f - 1) % 2 === 0 ? 1 : -1;
      lmBox(SX1 - SX0, SLAB_T, HALF - ZRUN, (SX0 + SX1) / 2, y - SLAB_T / 2, side * (ZRUN + HALF) / 2);
      lmSurfaces.push({
        x0: SX0, x1: SX1,
        z0: side === 1 ? ZRUN : -HALF, z1: side === 1 ? HALF : -ZRUN, y,
      });
      // parapet on +x and ±z (the -x side is the solid wall)
      lmBox(WALL_T * 0.6, PARAPET, HALF * 2, HALF - WALL_T * 0.3, y + PARAPET / 2, 0);
      wall(HALF - WALL_T, HALF + 0.1, -HALF - 0.1, HALF + 0.1, y, y + PARAPET);
      for (const s of [-1, 1]) {
        lmBox(HALF * 2, PARAPET, WALL_T * 0.6, 0, y + PARAPET / 2, s * (HALF - WALL_T * 0.3));
        wall(-HALF - 0.1, HALF + 0.1, s === -1 ? -HALF - 0.1 : HALF - WALL_T, s === -1 ? -HALF + WALL_T : HALF + 0.1, y, y + PARAPET);
      }
    }

    // stair flights (ramps hugging the -x wall, alternating direction)
    const run = ZRUN * 2;
    const rampLen = Math.hypot(run, FLOOR_H);
    const slope = Math.atan2(FLOOR_H, run);
    for (let f = 0; f < FLOORS; f++) {
      const up = f % 2 === 0 ? 1 : -1; // +1: rises toward +z
      lmBox(SX1 - SX0 - 0.2, 0.25, rampLen, (SX0 + SX1) / 2, (f + 0.5) * FLOOR_H + 0.3, 0, hullGeos, -up * slope);
      lmSurfaces.push({
        ramp: true, x0: SX0, x1: SX1, z0: -ZRUN, z1: ZRUN,
        zA: up === 1 ? -ZRUN : ZRUN, zB: up === 1 ? ZRUN : -ZRUN,
        yA: f * FLOOR_H + 0.3, yB: (f + 1) * FLOOR_H + 0.3,
      });
      // thin guard rail on the flight's open edge
      lmBox(0.12, 1.0, rampLen, SX1 - 0.06, (f + 0.5) * FLOOR_H + 0.3 + 0.6, 0, hullGeos, -up * slope);
    }

    // neon: doorway frame, balcony rail glow, under-slab light strips
    for (const s of [-1, 1]) lmBox(0.15, DOOR_H, 0.15, HALF + 0.05, DOOR_H / 2, s * (DOOR_HALF + 0.1), glowGeos);
    lmBox(0.15, 0.15, DOOR_HALF * 2 + 0.5, HALF + 0.05, DOOR_H + 0.1, 0, glowGeos);
    lmBox(0.1, 0.08, HALF * 2, HALF - 0.3, TOP + PARAPET + 0.05, 0, glowGeos);
    for (const s of [-1, 1]) lmBox(HALF * 2, 0.08, 0.1, 0, TOP + PARAPET + 0.05, s * (HALF - 0.3), glowGeos);
    for (let f = 1; f <= FLOORS; f++) {
      lmBox(HALF - SX1 - 1, 0.08, 0.3, (SX1 + HALF) / 2, f * FLOOR_H - 0.25, 0, glowGeos);
    }

    const lmHullMat = new THREE.MeshStandardMaterial({
      color: palette.hullA, roughness: 0.7, metalness: 0.25,
      map: makePanelNoiseTexture(rng),
      emissive: new THREE.Color(palette.hullA), emissiveIntensity: 0.3,
    });
    const lmHull = new THREE.Mesh(mergeGeometries(hullGeos), lmHullMat);
    lmHull.frustumCulled = false;
    const lmGlowMat = new THREE.MeshStandardMaterial({
      color: 0x220016, emissive: new THREE.Color(palette.neonPrimary),
      emissiveIntensity: C.NEON_BLOOM_INTENSITY, roughness: 0.3,
    });
    const lmGlow = new THREE.Mesh(mergeGeometries(glowGeos), lmGlowMat);
    lmGlow.frustumCulled = false;
    group.add(lmHull, lmGlow);
    matureExtras.push({ obj: lmHull, devMin: 0.7 }, { obj: lmGlow, devMin: 0.7 });
    adMats.push(lmGlowMat); // ride the day/night neon dimming

    // NPCs steer around the tower but never enter; the player's collision
    // skips npcOnly and uses the wall AABBs instead (so the doorway works).
    collidersLocal.push({
      x: landmarkSpot.x, z: landmarkSpot.z,
      radius: HALF * Math.SQRT2 + 0.5, height: TOP, baseY: lmBaseY, npcOnly: true,
    });

    const STEP_UP = 0.7;
    landmark = {
      x: landmarkSpot.x,
      z: landmarkSpot.z,
      baseY: lmBaseY,
      topY: lmBaseY + TOP + 0.3,
      // Highest walkable slab/ramp under (x,z) reachable from feetY, or null.
      surfaceYAt(x, z, feetY) {
        const lx = x - landmarkSpot.x, lz = z - landmarkSpot.z;
        if (lx < -HALF - 0.4 || lx > HALF + 0.4 || lz < -HALF - 0.4 || lz > HALF + 0.4) return null;
        let best = null;
        for (const s of lmSurfaces) {
          if (lx < s.x0 || lx > s.x1 || lz < s.z0 || lz > s.z1) continue;
          let y;
          if (s.ramp) {
            const t = THREE.MathUtils.clamp((lz - s.zA) / (s.zB - s.zA), 0, 1);
            y = s.yA + (s.yB - s.yA) * t;
          } else {
            y = s.y;
          }
          y += lmBaseY;
          if (y <= feetY + STEP_UP && (best === null || y > best)) best = y;
        }
        return best;
      },
      // 2D AABB push-out for walls whose height band overlaps the body.
      // p is a city-local position (y = feet); returns true if moved.
      resolveWalls(p, r) {
        let lx = p.x - landmarkSpot.x, lz = p.z - landmarkSpot.z;
        if (Math.abs(lx) > HALF + 2 || Math.abs(lz) > HALF + 2) return false;
        const feet = p.y - lmBaseY;
        let pushed = false;
        for (const w of lmWalls) {
          if (feet >= w.y1 || feet + 1.7 <= w.y0) continue;
          const ex0 = w.x0 - r, ex1 = w.x1 + r, ez0 = w.z0 - r, ez1 = w.z1 + r;
          if (lx <= ex0 || lx >= ex1 || lz <= ez0 || lz >= ez1) continue;
          const dx = Math.min(lx - ex0, ex1 - lx);
          const dz = Math.min(lz - ez0, ez1 - lz);
          if (dx < dz) lx = lx - ex0 < ex1 - lx ? ex0 : ex1;
          else lz = lz - ez0 < ez1 - lz ? ez0 : ez1;
          pushed = true;
        }
        if (pushed) {
          p.x = landmarkSpot.x + lx;
          p.z = landmarkSpot.z + lz;
        }
        return pushed;
      },
    };
    structures.push(landmark);
    // A lone caretaker stands on the balcony deck (walk.js spawns them).
    balconySpot = { x: landmarkSpot.x + 2, z: landmarkSpot.z, y: lmBaseY + TOP + 0.3 };
  }

  // -------------------------------------------------------------------------
  // Enterable building lobbies — a lit ground-floor room with a doorway you
  // can walk into; a solid tower rises above it. Axis-aligned so walls/floor
  // stay simple AABBs (walk.js consumes them via city.structures). NPCs steer
  // around the footprint (npcOnly collider) but only the player enters.
  // -------------------------------------------------------------------------
  if (lobbySlots.length) {
    const lobbyHullGeos = [], lobbyGlowGeos = [], lobbyPropGeos = [];
    const RH = 4.4, WT = 0.4, DH = 1.4, DOORH = 3.1;
    let lobbyIdx = 0;
    for (const slot of lobbySlots) {
      // Alternate the interior flavor: even = shop, odd = lounge. Occupants
      // (walk.js) match — shopkeeper + browser vs. a couple of loungers.
      const flavor = lobbyIdx % 2 === 0 ? 'shop' : 'lounge';
      const cx = slot.x, cz = slot.z;
      const hx = slot.footHalf, hz = slot.footHalf;
      const by = flattenedHeight(cx, cz);
      const height = THREE.MathUtils.lerp(C.BUILDING_MIN_H_MID * 1.4, C.BUILDING_MAX_H_CORE, rng()) * heightScale;
      const surfaces = [], walls = [];
      const box = (w, h, d, x, y, z, geos) => {
        const g = new THREE.BoxGeometry(w, h, d);
        g.translate(cx + x, by + y, cz + z);
        geos.push(g);
      };
      // door faces the city centre (reachable from a street)
      const axisX = Math.abs(cx) >= Math.abs(cz);
      const sign = axisX ? (cx > 0 ? -1 : 1) : (cz > 0 ? -1 : 1);

      // ground slab (walkable floor)
      box(hx * 2, 0.6, hz * 2, 0, 0, 0, lobbyHullGeos);
      surfaces.push({ x0: -hx, x1: hx, z0: -hz, z1: hz, y: 0.3 });
      // solid tower above the room (its underside is the lobby ceiling)
      box(hx * 2, height - RH, hz * 2, 0, RH + (height - RH) / 2, 0, lobbyHullGeos);
      // window bands on the solid upper box (a little life)
      for (const wf of [0.45, 0.72]) {
        box(hx * 2.02, 1.4, hz * 2.02, 0, RH + (height - RH) * wf, 0, lobbyGlowGeos);
      }

      // four sides: three solid full-height walls, the door side split into
      // jambs + lintel at ground and a solid band above the room.
      const wallFull = (ax, sg) => {
        if (ax === 'x') {
          box(WT, height, hz * 2, sg * (hx - WT / 2), height / 2, 0, lobbyHullGeos);
          walls.push({ x0: sg > 0 ? hx - WT : -hx, x1: sg > 0 ? hx : -hx + WT, z0: -hz - 0.1, z1: hz + 0.1, y0: 0, y1: height });
        } else {
          box(hx * 2, height, WT, 0, height / 2, sg * (hz - WT / 2), lobbyHullGeos);
          walls.push({ x0: -hx - 0.1, x1: hx + 0.1, z0: sg > 0 ? hz - WT : -hz, z1: sg > 0 ? hz : -hz + WT, y0: 0, y1: height });
        }
      };
      const wallDoor = (ax, sg) => {
        if (ax === 'x') {
          const wx = sg * (hx - WT / 2), x0 = sg > 0 ? hx - WT : -hx, x1 = sg > 0 ? hx : -hx + WT;
          const seg = hz - DH;
          for (const s of [-1, 1]) {
            box(WT, RH, seg, wx, RH / 2, s * (DH + seg / 2), lobbyHullGeos);
            walls.push({ x0, x1, z0: s < 0 ? -hz - 0.1 : DH, z1: s < 0 ? -DH : hz + 0.1, y0: 0, y1: RH });
          }
          box(WT, RH - DOORH, DH * 2, wx, DOORH + (RH - DOORH) / 2, 0, lobbyHullGeos);
          walls.push({ x0, x1, z0: -DH, z1: DH, y0: DOORH, y1: RH });
          box(WT, height - RH, hz * 2, wx, RH + (height - RH) / 2, 0, lobbyHullGeos);
          walls.push({ x0, x1, z0: -hz - 0.1, z1: hz + 0.1, y0: RH, y1: height });
          // door frame glow
          const fo = sg * (hx + 0.06);
          box(0.16, DOORH, 0.16, fo, DOORH / 2, DH, lobbyGlowGeos);
          box(0.16, DOORH, 0.16, fo, DOORH / 2, -DH, lobbyGlowGeos);
          box(0.16, 0.16, DH * 2 + 0.5, fo, DOORH + 0.05, 0, lobbyGlowGeos);
        } else {
          const wz = sg * (hz - WT / 2), z0 = sg > 0 ? hz - WT : -hz, z1 = sg > 0 ? hz : -hz + WT;
          const seg = hx - DH;
          for (const s of [-1, 1]) {
            box(seg, RH, WT, s * (DH + seg / 2), RH / 2, wz, lobbyHullGeos);
            walls.push({ x0: s < 0 ? -hx - 0.1 : DH, x1: s < 0 ? -DH : hx + 0.1, z0, z1, y0: 0, y1: RH });
          }
          box(DH * 2, RH - DOORH, WT, 0, DOORH + (RH - DOORH) / 2, wz, lobbyHullGeos);
          walls.push({ x0: -DH, x1: DH, z0, z1, y0: DOORH, y1: RH });
          box(hx * 2, height - RH, WT, 0, RH + (height - RH) / 2, wz, lobbyHullGeos);
          walls.push({ x0: -hx - 0.1, x1: hx + 0.1, z0, z1, y0: RH, y1: height });
          const fo = sg * (hz + 0.06);
          box(0.16, DOORH, 0.16, DH, DOORH / 2, fo, lobbyGlowGeos);
          box(0.16, DOORH, 0.16, -DH, DOORH / 2, fo, lobbyGlowGeos);
          box(DH * 2 + 0.5, 0.16, 0.16, 0, DOORH + 0.05, fo, lobbyGlowGeos);
        }
      };
      const doorAx = axisX ? 'x' : 'z';
      for (const ax of ['x', 'z']) {
        for (const sg of [-1, 1]) {
          if (ax === doorAx && sg === sign) wallDoor(ax, sg);
          else wallFull(ax, sg);
        }
      }
      // interior: a glowing back wall + ceiling strip so the doorway reads lit
      const backSign = -sign;
      if (axisX) box(0.1, RH - 0.8, hz * 1.5, backSign * (hx - WT - 0.1), RH / 2, 0, lobbyGlowGeos);
      else box(hx * 1.5, RH - 0.8, 0.1, 0, RH / 2, backSign * (hz - WT - 0.1), lobbyGlowGeos);
      box(hx * 1.4, 0.08, hz * 1.4, 0, RH - 0.2, 0, lobbyGlowGeos);

      // Interior furnishing, keyed off the flavor. Local axes: the "back" is
      // toward backSign along the door axis; the "side" is the other axis.
      // bx/bz map a (depth-from-door, sideways) offset into local x,z.
      const place = (depth, side, w, h, d, geos) => {
        if (axisX) box(w, h, d, backSign * depth, 0.3 + h / 2, side, geos);
        else box(d, h, w, side, 0.3 + h / 2, backSign * depth, geos);
      };
      if (flavor === 'shop') {
        // a service counter across the back, plus a shelf unit on one side
        place(hx - 1.3, 0, 2.6, 1.0, 0.7, lobbyPropGeos);
        place(hx - 1.3, 0, 2.4, 0.12, 0.5, lobbyGlowGeos); // counter light strip (sits at counter top-ish)
        place(hx - 0.5, hz - 1.0, 0.7, 2.0, 1.6, lobbyPropGeos); // shelf stack
        place(hx - 0.5, hz - 1.0, 0.5, 0.1, 1.4, lobbyGlowGeos);
      } else {
        // a lounge: two benches along the sides and a low glowing table
        place(hx - 1.0, hz - 1.0, 0.7, 0.45, 2.2, lobbyPropGeos);
        place(hx - 1.0, -(hz - 1.0), 0.7, 0.45, 2.2, lobbyPropGeos);
        place(hx - 1.8, 0, 1.1, 0.5, 1.1, lobbyPropGeos); // table
        place(hx - 1.8, 0, 0.35, 0.55, 0.35, lobbyGlowGeos); // table lamp
      }

      collidersLocal.push({
        x: cx, z: cz, radius: Math.max(hx, hz) * Math.SQRT2 + 0.4,
        height, baseY: by, npcOnly: true,
      });
      structures.push(makeStructure(cx, cz, by, surfaces, walls, Math.max(hx, hz)));
      lobbies.push({
        x: cx, z: cz, floorY: by + 0.3, half: Math.max(hx - 1.2, 1.5),
        flavor, seed: (seed ^ Math.imul(lobbyIdx + 7, 0x9e3779b1)) >>> 0,
      });
      lobbyIdx++;
    }
    const lobbyHullMat = new THREE.MeshStandardMaterial({
      color: palette.hullB, roughness: 0.72, metalness: 0.22,
      map: makePanelNoiseTexture(rng),
      emissive: new THREE.Color(palette.hullB), emissiveIntensity: 0.3,
    });
    const lobbyGlowMat = new THREE.MeshStandardMaterial({
      color: 0x120a04, emissive: new THREE.Color(palette.windowWarm),
      emissiveIntensity: C.NEON_BLOOM_INTENSITY * 0.6, roughness: 0.4,
    });
    const lobbyPropMat = new THREE.MeshStandardMaterial({
      color: palette.hullA, roughness: 0.6, metalness: 0.3,
      emissive: new THREE.Color(palette.hullA), emissiveIntensity: 0.25,
    });
    const lobbyHull = new THREE.Mesh(mergeGeometries(lobbyHullGeos), lobbyHullMat);
    const lobbyGlow = new THREE.Mesh(mergeGeometries(lobbyGlowGeos), lobbyGlowMat);
    lobbyHull.frustumCulled = false;
    lobbyGlow.frustumCulled = false;
    group.add(lobbyHull, lobbyGlow);
    matureExtras.push({ obj: lobbyHull, devMin: 0.55 }, { obj: lobbyGlow, devMin: 0.55 });
    if (lobbyPropGeos.length) {
      const props = new THREE.Mesh(mergeGeometries(lobbyPropGeos), lobbyPropMat);
      props.frustumCulled = false;
      group.add(props);
      matureExtras.push({ obj: props, devMin: 0.55 });
    }
    adMats.push(lobbyGlowMat);
  }

  // -------------------------------------------------------------------------
  // Landing pad — flat surface ringed with magenta emissive strips
  // -------------------------------------------------------------------------
  const padGroup = new THREE.Group();
  const padY = flattenedHeight(padCenter.x, padCenter.y);
  const padGeo = new THREE.BoxGeometry(C.PAD_LENGTH, 0.3, C.PAD_WIDTH);
  const padMat = new THREE.MeshStandardMaterial({ color: 0x1a1826, roughness: 0.6, metalness: 0.3 });
  const padMesh = new THREE.Mesh(padGeo, padMat);
  padMesh.position.set(padCenter.x, padY + 0.15, padCenter.y);
  padGroup.add(padMesh);

  const ringGeo = new THREE.TorusGeometry(
    Math.max(C.PAD_LENGTH, C.PAD_WIDTH) * 0.52, 0.18, 8, C.PAD_RING_SEGMENTS
  );
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0x220016, emissive: new THREE.Color(palette.neonPrimary), emissiveIntensity: C.NEON_BLOOM_INTENSITY,
  });
  const ringMesh = new THREE.Mesh(ringGeo, ringMat);
  ringMesh.rotation.x = -Math.PI / 2;
  ringMesh.scale.set(C.PAD_LENGTH / C.PAD_WIDTH, 1, 1);
  ringMesh.position.set(padCenter.x, padY + 0.25, padCenter.y);
  padGroup.add(ringMesh);

  // Arrival pulse: an expanding, fading ring that plays for a few seconds
  // after the city spawns (i.e. right as the player lands), then hides.
  const padPulseMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(palette.neonPrimary),
    transparent: true, opacity: 0.6,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const padPulse = new THREE.Mesh(new THREE.RingGeometry(0.92, 1.0, 48), padPulseMat);
  padPulse.rotation.x = -Math.PI / 2;
  padPulse.position.set(padCenter.x, padY + 0.35, padCenter.y);
  padGroup.add(padPulse);
  group.add(padGroup);

  const boardingPadLocal = new THREE.Vector3(padCenter.x, padY + 0.3, padCenter.y);
  const boardingPadWorld = boardingPadLocal.clone().applyQuaternion(quat).add(group.position);

  // -------------------------------------------------------------------------
  // Ground-level dressing: streetlights, planters, kiosks, railings (merged)
  // -------------------------------------------------------------------------
  const dressingGeos = [];
  const lightPoleMat = new THREE.MeshStandardMaterial({ color: 0x14121e, roughness: 0.7 });
  const lightHeadGeos = [];
  const lightHeadMat = new THREE.MeshStandardMaterial({
    color: 0x220016, emissive: new THREE.Color(palette.neonSecondaryA), emissiveIntensity: C.NEON_BLOOM_INTENSITY * 0.7,
  });

  for (let gx = -halfCells; gx <= halfCells; gx++) {
    for (let gz = -halfCells; gz <= halfCells; gz++) {
      const cx = gx * C.GRID_CELL;
      const cz = gz * C.GRID_CELL;
      if (Math.hypot(cx, cz) > radius) continue;
      if (rng() > 0.5) continue; // sparse placement along grid intersections
      if (isWetLocal(cx, cz)) continue; // no streetlights/kiosks in the water
      if (landmarkSpot && Math.hypot(cx - landmarkSpot.x, cz - landmarkSpot.z) < 12) continue;
      const y = flattenedHeight(cx, cz);

      const pole = new THREE.CylinderGeometry(0.12, 0.15, C.STREETLIGHT_HEIGHT, 6);
      pole.translate(cx + 1.5, y + C.STREETLIGHT_HEIGHT / 2, cz + 1.5);
      dressingGeos.push(pole);

      const head = new THREE.IcosahedronGeometry(0.35, 0);
      head.translate(cx + 1.5, y + C.STREETLIGHT_HEIGHT, cz + 1.5);
      lightHeadGeos.push(head);

      if (rng() < C.PLANTER_CHANCE) {
        const planter = new THREE.CylinderGeometry(0.6, 0.7, 0.6, 8);
        planter.translate(cx - 2, y + 0.3, cz - 2);
        dressingGeos.push(planter);
      }
      if (rng() < C.KIOSK_CHANCE) {
        const kiosk = new THREE.BoxGeometry(1.6, 2.2, 1.2);
        kiosk.translate(cx + 3, y + 1.1, cz - 1.5);
        dressingGeos.push(kiosk);
      }
    }
  }

  // plaza railings (ring of thin boxes) for flavor
  for (const pz of plazaCenters) {
    const segCount = 24;
    for (let i = 0; i < segCount; i++) {
      const ang = (i / segCount) * Math.PI * 2;
      const rx = pz.x + Math.cos(ang) * pz.r;
      const rz = pz.z + Math.sin(ang) * pz.r;
      const ry = flattenedHeight(rx, rz);
      const rail = new THREE.BoxGeometry(0.1, C.RAILING_HEIGHT, 1.4);
      rail.rotateY(ang);
      rail.translate(rx, ry + C.RAILING_HEIGHT / 2, rz);
      dressingGeos.push(rail);
    }
  }

  const dressingMat = new THREE.MeshStandardMaterial({ color: 0x1e1c2a, roughness: 0.8 });
  const dressingMesh = dressingGeos.length
    ? new THREE.Mesh(mergeGeometries(dressingGeos), dressingMat)
    : null;
  if (dressingMesh) { dressingMesh.frustumCulled = false; group.add(dressingMesh); }
  const poleMeshFinal = dressingMesh; // shares draw call with dressing via merge above
  void lightPoleMat; // pole material folded into dressingMat for draw-call budget

  const lightHeadMesh = lightHeadGeos.length
    ? new THREE.Mesh(mergeGeometries(lightHeadGeos), lightHeadMat)
    : null;
  if (lightHeadMesh) { lightHeadMesh.frustumCulled = false; group.add(lightHeadMesh); }

  // -------------------------------------------------------------------------
  // Drifting light motes (small InstancedMesh, animated in update() only)
  // -------------------------------------------------------------------------
  const moteGeo = new THREE.IcosahedronGeometry(0.12, 0);
  const moteMat = new THREE.MeshStandardMaterial({
    color: 0x220016, emissive: new THREE.Color(palette.neonSecondaryB), emissiveIntensity: C.NEON_BLOOM_INTENSITY * 0.8,
    transparent: true, opacity: 0.85,
  });
  const moteMesh = new THREE.InstancedMesh(moteGeo, moteMat, C.MOTE_COUNT);
  moteMesh.frustumCulled = false;
  const moteSeeds = [];
  for (let i = 0; i < C.MOTE_COUNT; i++) {
    moteSeeds.push({
      x: (rng() - 0.5) * C.MOTE_SPREAD,
      z: (rng() - 0.5) * C.MOTE_SPREAD,
      phase: rng() * Math.PI * 2,
      speed: 0.5 + rng() * 0.5,
    });
    dummy.position.set(moteSeeds[i].x, C.MOTE_HEIGHT * rng(), moteSeeds[i].z);
    dummy.scale.setScalar(1);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    moteMesh.setMatrixAt(i, dummy.matrix);
  }
  moteMesh.instanceMatrix.needsUpdate = true;
  group.add(moteMesh);

  // -------------------------------------------------------------------------
  // Aerial traffic — two counter-rotating lanes of emissive grav-car streaks
  // circling well above the rooftops. Purely visual (no colliders), animated
  // procedurally in update() with a reused dummy (zero allocs).
  // -------------------------------------------------------------------------
  const trafficMat = new THREE.MeshStandardMaterial({
    color: 0x0a0a12, emissive: new THREE.Color(palette.neonSecondaryA),
    emissiveIntensity: C.NEON_BLOOM_INTENSITY * 0.9, roughness: 0.4,
  });
  const trafficMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.5, 0.18, 2.6), trafficMat, C.TRAFFIC_COUNT
  );
  trafficMesh.frustumCulled = false;
  const laneAlt = C.BUILDING_MAX_H_CORE * heightScale; // clear of the tallest core tower
  const trafficSeeds = [];
  for (let i = 0; i < C.TRAFFIC_COUNT; i++) {
    trafficSeeds.push({
      lane: i % 2,
      r: radius * (i % 2 ? 0.72 : 0.48) * (0.92 + rng() * 0.16),
      alt: laneAlt + (i % 2 ? 26 : 10) + rng() * 6,
      speed: 0.08 + rng() * 0.07, // radians/sec around the loop
      phase: rng() * Math.PI * 2,
    });
  }
  group.add(trafficMesh);

  // -------------------------------------------------------------------------
  // Rim haze — additive cards around the city edge merged into one mesh: a
  // soft light-dome over the settlement, strongest at night (cityHaze.frag).
  // -------------------------------------------------------------------------
  {
    const hazeGeos = [];
    const hm = new THREE.Matrix4(), hq = new THREE.Quaternion();
    const hp = new THREE.Vector3(), hs = new THREE.Vector3(1, 1, 1);
    const cards = 8;
    const hazeW = ((Math.PI * 2 * radius) / cards) * 1.15;
    for (let i = 0; i < cards; i++) {
      const ang = (i / cards) * Math.PI * 2;
      const hx = Math.cos(ang) * radius * 1.02;
      const hz = Math.sin(ang) * radius * 1.02;
      const geo = new THREE.PlaneGeometry(hazeW, 46);
      hp.set(hx, sampleGroundLocalY(hx, hz) + 20, hz);
      hq.setFromAxisAngle(YAXIS, -ang + Math.PI / 2);
      geo.applyMatrix4(hm.compose(hp, hq, hs));
      hazeGeos.push(geo);
    }
    const hazeMat = new THREE.ShaderMaterial({
      vertexShader: basicVert,
      fragmentShader: cityHazeFrag,
      uniforms: {
        uNight: fx.uNight,
        uColor: {
          value: new THREE.Color(palette.neonPrimary)
            .lerp(new THREE.Color(palette.windowWarm), 0.35),
        },
      },
      transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const hazeMesh = new THREE.Mesh(mergeGeometries(hazeGeos), hazeMat);
    hazeMesh.frustumCulled = false;
    hazeMesh.renderOrder = 1;
    group.add(hazeMesh);
  }

  // -------------------------------------------------------------------------
  // groundHeightAt(worldPos) -> world-space height, following street level
  // -------------------------------------------------------------------------
  const invQuat = quat.clone().invert();
  const localScratch = new THREE.Vector3();
  function groundHeightAt(worldPos) {
    localScratch.copy(worldPos).sub(group.position).applyQuaternion(invQuat);
    const y = flattenedHeight(localScratch.x, localScratch.z);
    const worldY = localScratch.set(localScratch.x, y, localScratch.z)
      .applyQuaternion(quat).add(group.position);
    return worldY.y !== undefined ? worldY.clone() : worldY;
  }

  // -------------------------------------------------------------------------
  // update(t, sunDot) — day/night neon, mote drift, traffic lanes, arrival
  // pulse; zero per-frame allocs. Shader-driven elements (windows, signs,
  // ads, haze) only need the two shared fx uniforms written.
  // -------------------------------------------------------------------------
  const emissiveMeshes = [ringMesh.material, lightHeadMat, moteMat, trafficMat, ...adMats];
  const baseEmissive = emissiveMeshes.map((m) => m.emissiveIntensity);
  const moteDummy = new THREE.Object3D();
  let spawnT = null; // first update() timestamp — drives the arrival pulse

  function update(t, sunDot) {
    const nightLift = THREE.MathUtils.clamp(1 - Math.max(sunDot ?? 0, 0), 0, 1);
    fx.uTime.value = t;
    fx.uNight.value = nightLift;
    const level = THREE.MathUtils.lerp(C.NEON_DIM_INTENSITY, C.NEON_BLOOM_INTENSITY, nightLift);
    for (let i = 0; i < emissiveMeshes.length; i++) {
      emissiveMeshes[i].emissiveIntensity = level * (baseEmissive[i] / C.NEON_BLOOM_INTENSITY);
    }

    for (let i = 0; i < C.MOTE_COUNT; i++) {
      const s = moteSeeds[i];
      const y = ((t * C.MOTE_RISE_SPEED * s.speed + s.phase * 3) % C.MOTE_HEIGHT + C.MOTE_HEIGHT) % C.MOTE_HEIGHT;
      const sway = Math.sin(t * 0.3 + s.phase) * 2;
      moteDummy.position.set(s.x + sway, y, s.z);
      moteDummy.updateMatrix();
      moteMesh.setMatrixAt(i, moteDummy.matrix);
    }
    moteMesh.instanceMatrix.needsUpdate = true;

    // grav-car lanes: even instances orbit one way, odd the other; a gentle
    // vertical bob keeps them from reading as being on rails
    for (let i = 0; i < trafficSeeds.length; i++) {
      const s = trafficSeeds[i];
      const dir = s.lane ? -1 : 1;
      const a = s.phase + t * s.speed * dir;
      const cos = Math.cos(a), sin = Math.sin(a);
      moteDummy.position.set(cos * s.r, s.alt + Math.sin(t * 0.7 + s.phase) * 1.5, sin * s.r);
      moteDummy.rotation.y = Math.atan2(-sin * dir, cos * dir);
      moteDummy.updateMatrix();
      trafficMesh.setMatrixAt(i, moteDummy.matrix);
    }
    moteDummy.rotation.y = 0; // motes reuse the dummy next frame
    trafficMesh.instanceMatrix.needsUpdate = true;

    // arrival pulse: a few expanding rings right after landing, then done
    if (spawnT === null) spawnT = t;
    const age = t - spawnT;
    if (age < 6) {
      const k = (age % 1.6) / 1.6;
      const grow = 1 + k * C.PAD_LENGTH * 0.9;
      padPulse.scale.set(grow, grow, 1);
      padPulseMat.opacity = (1 - k) * 0.6;
    } else if (padPulse.visible) {
      padPulse.visible = false;
    }
  }

  // -------------------------------------------------------------------------
  // dispose()
  // -------------------------------------------------------------------------
  function dispose() {
    group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m.map) m.map.dispose();
          if (m.emissiveMap) m.emissiveMap.dispose();
          m.dispose();
        }
      }
      if (obj.dispose && obj.isInstancedMesh) obj.dispose();
    });
    // textures held in shader uniforms (ad boards) aren't reachable as .map
    for (const t of ownedTextures) t.dispose();
    group.clear();
  }

  // -------------------------------------------------------------------------
  // setDevelopment(level 0..1) — the growth mechanic (jfeelgood). Rescales
  // every tower (plus its window shell and rooftop sign) so the city
  // physically rises from a scatter of huts into a full skyline, and reveals
  // the mature set-pieces (lobbies, landmark, ad billboards) as the
  // civilisation advances. level 1 reproduces the fully-built city.
  // -------------------------------------------------------------------------
  const HUT_H = 3.5;         // height a building first appears at
  const GROW_WINDOW = 0.28;  // share of the 0..1 range a building takes to top out
  let maxBody = 1;
  for (const s of growSpecs) if (s.bodyHeight > maxBody) maxBody = s.bodyHeight;
  for (const s of growSpecs) {
    // taller buildings sprout later, so the settlement reads hut -> tower ->
    // skyscraper over time; jit spreads same-height buildings apart.
    const norm = s.bodyHeight / maxBody;
    s.t0 = THREE.MathUtils.clamp(norm * 0.72 + (s.jit - 0.5) * 0.14, 0, 1 - GROW_WINDOW);
  }
  const devDummy = new THREE.Object3D();
  const TINY = 1e-4;
  let developmentLevel = 1;
  function setDevelopment(level) {
    developmentLevel = THREE.MathUtils.clamp(level, 0, 1);
    const L = developmentLevel;
    for (const s of growSpecs) {
      const local = THREE.MathUtils.clamp((L - s.t0) / GROW_WINDOW, 0, 1);
      const appeared = L >= s.t0;
      const ch = appeared
        ? THREE.MathUtils.lerp(Math.min(HUT_H, s.bodyHeight), s.bodyHeight, local)
        : 0;
      if (appeared) {
        devDummy.position.set(s.x, s.baseY - C.FOUNDATION_DEPTH + (ch + C.FOUNDATION_DEPTH) / 2, s.z);
        devDummy.scale.set(s.footW, ch + C.FOUNDATION_DEPTH, s.footD);
        devDummy.rotation.set(0, s.rotY, 0);
      } else {
        devDummy.position.set(s.x, s.baseY - 50, s.z);
        devDummy.scale.set(TINY, TINY, TINY);
        devDummy.rotation.set(0, 0, 0);
      }
      devDummy.updateMatrix();
      towerMesh.setMatrixAt(s.inst, devDummy.matrix);
      if (s.winInst >= 0) {
        if (appeared && ch > HUT_H + 3) {
          devDummy.position.set(s.x, s.baseY + ch * 0.55, s.z);
          devDummy.scale.set(s.footW * 1.001, ch * 0.85, s.footD * 1.001);
          devDummy.rotation.set(0, s.rotY, 0);
        } else {
          devDummy.position.set(s.x, s.baseY - 50, s.z);
          devDummy.scale.set(TINY, TINY, TINY);
        }
        devDummy.updateMatrix();
        windowMesh.setMatrixAt(s.winInst, devDummy.matrix);
      }
      if (s.signInst >= 0) {
        if (local > 0.97) {
          devDummy.position.set(s.x, s.baseY + ch + 1.4, s.z);
          devDummy.scale.set(s.signFootW, 2.2, 0.6);
          devDummy.rotation.set(0, s.signRotY, 0);
        } else {
          devDummy.position.set(s.x, s.baseY - 50, s.z);
          devDummy.scale.set(TINY, TINY, TINY);
        }
        devDummy.updateMatrix();
        signMesh.setMatrixAt(s.signInst, devDummy.matrix);
      }
    }
    towerMesh.instanceMatrix.needsUpdate = true;
    windowMesh.instanceMatrix.needsUpdate = true;
    signMesh.instanceMatrix.needsUpdate = true;
    for (const e of matureExtras) e.obj.visible = L >= e.devMin;
  }
  // Start fully built unless the caller asks to grow from a seed.
  setDevelopment(opts.development ?? 1);

  return {
    group,
    update,
    dispose,
    setDevelopment,
    developmentLevel: () => developmentLevel,
    landmarkReady: () => developmentLevel >= 0.7,
    colliders, // surface-local {center,radius,height}
    collidersLocal, // city-flat {x,z,radius,height} — for aliens.js
    groundHeightAt,
    groundLocalYAt: flattenedHeight, // (x,z) -> local Y — for aliens.js
    plazaCenters, // city-flat {x,z,r} — aliens.js waypoints
    boardingPad: boardingPadWorld,
    landmark, // enterable observation tower (surfaceYAt/resolveWalls) or null
    structures, // all enterable buildings (landmark + lobbies), for walk.js
    lobbies, // interior manifests {x,z,floorY,half,flavor,seed} for occupants
    balconySpot, // {x,z,y} tower balcony perch, or null
  };
}

// ---------------------------------------------------------------------------
// Wiring into the main loop:
//
//   import { createCity } from './city.js';
//   const city = createCity(planet, landingUpVector, { radius: 300, seed: mySeed });
//   planet.surface.add(city.group);
//   // per frame: city.update(elapsedSeconds, sunDirection.dot(landingUpVector));
//   // on teardown: city.dispose(); planet.surface.remove(city.group);
// ---------------------------------------------------------------------------