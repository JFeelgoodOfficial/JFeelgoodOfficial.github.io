// Every tunable for the jfeelgood gallery in one place. Metres, +y up. The
// building runs along +x: sunrise terrace at the west end, the two indoor wings
// either side of an open sunset court, and the star deck at the east end. The
// sky is one procedural dome whose look is driven by where the visitor stands
// (see sky.js) — it is a sunrise at the west end, a sunset over the court, and
// deep space over the east deck, blending inside the windowless wings where
// nobody can see it change.

import * as THREE from 'three';

export const C = {
  // --- walking ---
  EYE: 1.7,
  WALK_SPEED: 3.6,
  RUN_SPEED: 7.2,
  ACCEL: 30,
  GRAVITY: 22,
  JUMP: 5.5,
  PLAYER_RADIUS: 0.45,
  LOOK_SENS: 0.0022,
  MAX_PITCH: 1.45,

  // --- render ---
  FOV: 68,
  MAX_PIXEL_RATIO: 1.5,
  EXPOSURE: 1.0,

  // --- building ---
  WING_HALF_W: 7,       // interior half-width (z) of a wing
  WING_H: 6.2,          // interior clear height
  WALL_T: 0.5,          // wall thickness
  ROOF_T: 0.6,
  HANG_Y: 1.62,         // painting centre height
  ART_MAX: 2.1,         // max painting dimension (m)
  ART_MAX_FEATURED: 2.8,
  ART_MAX_SELFWORK: 2.4,
  SLOT_STEP: 3.0,       // wall spacing between paintings (186 works have to fit)
  SEA_Y: -7,            // sea surface (the gallery stands on a headland plinth)

  // --- lighting ---
  // Ceiling fixtures are data, not scene lights: a pool of this many real
  // PointLights follows the visitor and is aimed at the nearest ones
  // (lights.js). The number is a shader budget, not a look — three.js unrolls
  // one full GGX evaluation per light into every lit fragment shader, and the
  // 22 lights this replaced compiled a shader mobile drivers refused to link,
  // which drew the whole building as nothing at all.
  LIGHT_POOL: { low: 6, medium: 8, high: 8 },
  // Wing fixtures hang in pairs (z = ±3.6) every STEP metres, reaching RANGE.
  // The two together set what the pool has to hold. At STEP 12 / RANGE 26 the
  // visitor stands inside the reach of five rows and six slots hold the nearest
  // three, which is what a corridor needs: the pool ranks fixtures by their
  // contribution where the visitor stands, but the camera is looking 10 to 25 m
  // down the wing, and those far surfaces are lit by exactly the fixtures a
  // smaller pool drops — cutting it to four measurably dims the room ahead.
  // Shorten RANGE much below STEP * 2 and the ceiling ahead goes dark too: the
  // long reach is what makes a wing read as a lit room rather than a row of
  // spots.
  WING_LIGHT_STEP: 12,
  WING_LIGHT_RANGE: 26,
  WING_LIGHT_I: 95,
};

// --- plan (x ranges) ---
export const PLAN = {
  terrace: { x0: -150, x1: -112 },   // sunrise terrace (open)
  west:    { x0: -112, x1: -28 },    // west wing (indoor)
  court:   { x0: -28, x1: 12 },      // sunset court (roofless, open to the south sea)
  east:    { x0: 12, x1: 96 },       // east wing (indoor)
  deck:    { x0: 96, x1: 134 },      // star deck (open)
};
// half-depth (z) of the open areas
export const TERRACE_HALF_Z = 17;
export const COURT_SOUTH_Z = -22;   // court terrace edge toward the sea
export const DECK_HALF_Z = 17;

// Sky state s: 0 = sunrise, 1 = sunset, 2 = deep space. Piecewise-linear in x.
export function skyStateAt(x) {
  if (x <= -92) return 0;
  if (x < -48) return (x + 92) / 44;
  if (x <= 32) return 1;
  if (x < 76) return 1 + (x - 32) / 44;
  return 2;
}

// Where the visitor starts: on the sunrise terrace facing the sea.
export const SPAWN = { x: -128, z: 0, heading: -Math.PI / 2 }; // heading: yaw, 0 = +z, -PI/2 = -x

// Named jump points for ?debug=at:<name> and the compass.
export const PLACES = {
  terrace: { x: -130, z: 0, heading: -Math.PI / 2, label: 'SUNRISE TERRACE' },
  west:    { x: -70, z: 3.5, heading: Math.PI / 2, label: 'WEST WING' },
  court:   { x: -8, z: 0, heading: Math.PI, label: 'SUNSET COURT' },
  east:    { x: 54, z: 3.5, heading: Math.PI / 2, label: 'EAST WING' },
  deck:    { x: 116, z: 0, heading: Math.PI / 2, label: 'STAR DECK' },
};

// The three sky presets. sunDir points FROM the scene TOWARD the sun.
export const SKY = {
  sunrise: {
    sunDir: new THREE.Vector3(-1, 0.075, 0.28).normalize(),
    sunColor: new THREE.Color(0xffd9a6),
    sunIntensity: 2.1,
    horizon: new THREE.Color(0xffc088),  // peach at the horizon
    horizonFar: new THREE.Color(0xd9b4b8), // horizon away from the sun: rose-grey
    zenith: new THREE.Color(0x5f8bc6),   // pale morning blue overhead
    glow: new THREE.Color(0xffb060),
    haze: 1.0,     // horizon band thickness
    cloud: 0.45,   // cloud coverage
    cloudLit: new THREE.Color(0xffd7b0),
    cloudShade: new THREE.Color(0x9a86a0),
    // the hemisphere stands in for bounce, and it reaches indoors where the sky
    // cannot — so it is kept close to neutral or the wings turn peach
    hemiSky: new THREE.Color(0xd6e0f2),
    hemiGround: new THREE.Color(0x9a9086),
    hemiIntensity: 0.6,
    seaDeep: new THREE.Color(0x0e2a3f),
    seaShallow: new THREE.Color(0x3d7a8a),
    envIntensity: 0.8,
    space: 0,
  },
  sunset: {
    sunDir: new THREE.Vector3(0.18, 0.1, -1).normalize(),
    sunColor: new THREE.Color(0xff9a3c),
    sunIntensity: 1.9,
    horizon: new THREE.Color(0xf5843c),  // deep orange
    horizonFar: new THREE.Color(0xa06078),
    zenith: new THREE.Color(0x2a2454),   // violet overhead
    glow: new THREE.Color(0xff6f2a),
    haze: 1.3,
    cloud: 0.5,
    cloudLit: new THREE.Color(0xffb070),
    cloudShade: new THREE.Color(0x5a3a5a),
    hemiSky: new THREE.Color(0xc2b2c6),
    hemiGround: new THREE.Color(0x8a7a70),
    hemiIntensity: 0.55,
    seaDeep: new THREE.Color(0x14122c),
    seaShallow: new THREE.Color(0x6a4a5a),
    envIntensity: 0.75,
    space: 0,
  },
  space: {
    sunDir: new THREE.Vector3(0.3, 0.6, -0.5).normalize(),
    sunColor: new THREE.Color(0x9fb4ff),
    sunIntensity: 0.22,
    horizon: new THREE.Color(0x0a0d1c),
    horizonFar: new THREE.Color(0x070812),
    zenith: new THREE.Color(0x010207),
    glow: new THREE.Color(0x000000),
    haze: 0.6,
    cloud: 0,
    cloudLit: new THREE.Color(0x000000),
    cloudShade: new THREE.Color(0x000000),
    hemiSky: new THREE.Color(0x4a5a80),
    hemiGround: new THREE.Color(0x15181f),
    hemiIntensity: 0.3,
    seaDeep: new THREE.Color(0x03040a),
    seaShallow: new THREE.Color(0x0c1226),
    envIntensity: 0.5,
    space: 1,
  },
};
