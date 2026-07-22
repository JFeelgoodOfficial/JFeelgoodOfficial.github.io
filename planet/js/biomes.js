// Regional biomes for the planet. The terrain SHAPE (hills, mountains, valleys,
// lakes) already comes from terrain.js / the surface shader and is left
// untouched — re-deriving that field in two places (JS collision + GLSL colour)
// is exactly the drift trap the terrain.js header warns about. Instead this
// module partitions the surface into large regions — lush forest, desert,
// alpine, and plains — with a slow-moving 3D noise, and the streaming foliage
// (foliage.js) reads those weights to decide what to scatter where. So the same
// ground you drive over reads as forest, desert, or bare highland without ever
// moving the collision floor.

import { elevationAt } from './terrain.js';
import { C } from './config.js';

// --- a small, self-contained 3D value-noise fbm (independent of the terrain
// field, tuned to a low frequency so biome regions are continent-sized) ---
function fract(x) { return x - Math.floor(x); }
function hash3(x, y, z) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return fract(h);
}
function vnoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const c000 = hash3(ix, iy, iz), c100 = hash3(ix + 1, iy, iz);
  const c010 = hash3(ix, iy + 1, iz), c110 = hash3(ix + 1, iy + 1, iz);
  const c001 = hash3(ix, iy, iz + 1), c101 = hash3(ix + 1, iy, iz + 1);
  const c011 = hash3(ix, iy + 1, iz + 1), c111 = hash3(ix + 1, iy + 1, iz + 1);
  return (
    (c000 * (1 - fx) + c100 * fx) * (1 - fy) * (1 - fz) +
    (c010 * (1 - fx) + c110 * fx) * fy * (1 - fz) +
    (c001 * (1 - fx) + c101 * fx) * (1 - fy) * fz +
    (c011 * (1 - fx) + c111 * fx) * fy * fz
  );
}
function fbm(x, y, z, oct) {
  let v = 0, a = 0.5;
  for (let i = 0; i < oct; i++) { v += a * vnoise(x, y, z); x *= 2.07; y *= 2.07; z *= 2.07; a *= 0.5; }
  return v;
}

const MOIST_F = 2.3; // moisture region frequency (higher = smaller regions)
const TEMP_F = 1.7;  // temperature region frequency
const SNOW_H = 34;    // height above which highlands turn to bare rock / snow

function smooth01(x, a, b) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

// Classify a normalized surface direction into biome weights. Returns an object
// with 0..1 weights that sum-ish to a dominant biome, plus helpers foliage.js
// uses directly. `dir` is a unit Vector3 in planet object space (== world).
export function biomeAt(dir) {
  const x = dir.x, y = dir.y, z = dir.z;
  const moist = fbm(x * MOIST_F + 1.7, y * MOIST_F + 5.2, z * MOIST_F - 2.4, 4); // ~0.15..0.85
  const temp = fbm(x * TEMP_F - 3.1, y * TEMP_F + 0.9, z * TEMP_F + 4.6, 3);
  const elev = elevationAt(x, y, z);
  const height = Math.max(elev - C.SEA_LEVEL, 0) * C.TERRAIN_HEIGHT;

  // alpine: driven by real terrain height so it hugs the actual peaks
  const alpine = smooth01(height, 22, SNOW_H);
  // desert: warm + dry, only in the lowlands
  const desert = smooth01(temp, 0.52, 0.68) * smooth01(0.5, moist, 0.42) * (1 - alpine);
  // forest: moist, temperate, mid elevations
  const forest = smooth01(moist, 0.5, 0.66) * (1 - desert) * (1 - alpine * 0.8);
  const plains = Math.max(0, 1 - forest - desert - alpine);

  let name = 'plains';
  let best = plains;
  if (forest > best) { best = forest; name = 'forest'; }
  if (desert > best) { best = desert; name = 'desert'; }
  if (alpine > best) { best = alpine; name = 'alpine'; }

  return { name, forest, desert, alpine, plains, height, moist, temp };
}
