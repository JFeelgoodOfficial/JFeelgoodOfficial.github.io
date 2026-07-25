// Every tunable for the jfeelgood planet in one place, following the game's
// constants.js discipline. Values ported from Feelgood Space Flight where the
// mechanic is the same (walking, dressing), re-tuned where the context differs
// (single small planet, website audience on integrated GPUs).

import * as THREE from 'three';

export const C = {
  // --- the planet ---
  // Radius chosen so a ~230-unit content disc reads flat-ish against the
  // fixed terrain noise field (see LANDING_DIR note): at 800 the best discs
  // are 100% dry with gentle relief. No spin: the sun never moves, the whole
  // content zone stays in daylight, and every spin/un-spin transform from the
  // game collapses to identity.
  RADIUS: 800,
  SEA_LEVEL: 0.5, // terrain elevation below this is under water
  TERRAIN_HEIGHT: 50, // peak displacement above sea level
  ICE_LAT: 0.78, // |unit y| where polar ice begins
  ATMO_SHELL: 1.68, // atmosphere shell radius, × planet radius (clears Mont Le Ringger's summit)
  CLOUD_COVER: 0.45,

  // --- palette: the site's gold-on-dark brand, as terrain bands ---
  PALETTE: {
    deep: 0x060410,
    shallow: 0x1c1436,
    sand: 0xcaa45a,
    low: 0x8a6a2e,
    mid: 0x4a3a28,
    high: 0xf5e1b8,
  },
  WATER: { color: 0x0a0820, gloss: 1.0 },
  GRASS: { root: 0xa8842f, tip: 0xf7d06a, emissive: 0xc9a24a },

  // --- sky ---
  SKY_HORIZON: 0xd9a13b, // dusk gold at the horizon
  SKY_ZENITH: 0x0a0716, // deep indigo overhead (stars live up here)
  SKY_BELOW: 0x040308, // under the horizon line
  SUN_TINT: 0xffe7b0,

  // --- on-foot walking (ported from the game's WALK_* block, re-tuned) ---
  WALK_SPEED: 7.0,
  WALK_RUN_SPEED: 14.0,
  WALK_WADE_SPEED: 4.5,
  WALK_SWIM_SPEED: 4.5,
  WALK_ACCEL_GROUND: 42.0,
  WALK_ACCEL_AIR: 9.0,
  WALK_ACCEL_SWIM: 10.0,
  WALK_EYE_HEIGHT: 1.8,
  WALK_JUMP: 9.0,
  WALK_GRAVITY: 24.0,
  WALK_WATER_LEVEL: 1.5, // sea surface height above the base sphere
  WALK_SWIM_DEPTH: 1.1,
  WALK_WADE_DEPTH: 0.22,
  WALK_BUOYANCY: 0.55,
  LOOK_SENS: 0.0022, // radians of look per pixel of mouse travel
  MAX_PITCH: 1.483, // ~85°
  GROUND_SNAP: 8.0, // max step-down that still counts as grounded

  // --- surface dressing budgets (integrated-GPU friendly) ---
  DRESS_RADIUS: 240.0,
  DRESS_GRASS: 12000,
  DRESS_TREES: 90, // per tree variant (×3)
  DRESS_SHRUBS: 180,
  DRESS_ROCKS: 60, // per rock variant (×3)

  // --- render ---
  FOV: 70,
  MAX_PIXEL_RATIO: 1.5,
};

// The landing site. Derived offline by scanning ~6000 Fibonacci-sphere
// directions against terrain.js for a 230-unit disc that is 100% dry with
// gentle relief (mean height ~8, max ~13) outside the polar ice — see the
// repo history for the scan script. Everything on the planet is placed in
// this direction's tangent frame.
export const LANDING_DIR = new THREE.Vector3(-0.309869, -0.325499, -0.893326);

// Tangent frame at the landing site: NORTH is world +Y projected onto the
// tangent plane, EAST = NORTH × up. Zone bearings below are degrees
// clockwise from NORTH as seen standing at spawn.
export const NORTH = new THREE.Vector3(-0.106671, 0.945542, -0.307524);
export const EAST = new THREE.Vector3(-0.944777, 0.0, 0.327715);

// Fixed sun: 28° off the landing zenith toward azimuth 230°, so the whole
// content zone sits in permanent warm afternoon light with long shadows.
export const SUN = new THREE.Vector3(0.098368, -0.572735, -0.813817);

// --- content zone layout: bearing (deg from NORTH, clockwise) + surface
// distance (units along the great circle from spawn). Structures sit on
// flat platform pads (padR = pad surface height above the base sphere is
// resolved at build time from the local terrain).
export const ZONES = {
  spawn: { bearing: 0, dist: 0 },
  billboards: [
    { bearing: 300, dist: 95 }, // Poetry of Solace
    { bearing: 330, dist: 115 }, // Adonis
    { bearing: 0, dist: 75 }, // Veritas — straight ahead, nearest
    { bearing: 30, dist: 115 }, // Path of Privilege
    { bearing: 60, dist: 95 }, // A Simple Meditation
  ],
  gallery: { bearing: 0, dist: 165 },
  selfwork: { bearing: 100, dist: 120 },
  story: { bearing: 140, dist: 95 }, // path start; easels run toward gallery
  books: { bearing: 200, dist: 100 },
  collect: { bearing: 240, dist: 90 },
  nova: { bearing: 160, dist: 170 },
  garage: { bearing: 270, dist: 84 }, // the vehicle hangar
};
