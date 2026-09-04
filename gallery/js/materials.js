// Procedural PBR materials. Nothing here is fetched: every albedo, roughness
// and normal map is drawn into a canvas at load from tileable lattice noise
// (integer frequencies wrap at the texture edge, so octaves tile cleanly).
// Polished concrete floors, lime plaster walls, sawn stone terraces, oiled oak,
// and the small set of plain materials the fixtures use.

import * as THREE from 'three';

// --- tileable value noise -------------------------------------------------
function hash2(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 982451653) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967295;
}
// noise over the unit square with `freq` cells, wrapping at the edges
function lattice(u, v, freq, seed) {
  const x = u * freq, y = v * freq;
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % freq) + freq) % freq, x1 = (x0 + 1) % freq;
  const y0 = ((iy % freq) + freq) % freq, y1 = (y0 + 1) % freq;
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed), c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}
function fbm(u, v, freq, octaves, seed, gain = 0.5) {
  let s = 0, a = 1, f = freq, norm = 0;
  for (let i = 0; i < octaves; i++) {
    s += a * lattice(u, v, f, seed + i * 7); norm += a; a *= gain; f *= 2;
  }
  return s / norm;
}

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

// height (Float32Array, 0..1) -> tangent-space normal map canvas
function normalFromHeight(height, size, strength) {
  const cv = makeCanvas(size);
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size, yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size, xp = (x + 1) % size;
      const dx = (height[y * size + xp] - height[y * size + xm]) * strength;
      const dy = (height[yp * size + x] - height[ym * size + x]) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function toTexture(canvas, { srgb = false, repeat = 1, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.repeat.set(repeat, repeat);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// Generic writer: fn(u,v) -> { r,g,b (0..1 sRGB), rough (0..1), h (0..1) }
function bake(size, fn) {
  const alb = makeCanvas(size), rgh = makeCanvas(size);
  const ac = alb.getContext('2d'), rc = rgh.getContext('2d');
  const ai = ac.createImageData(size, size), ri = rc.createImageData(size, size);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = fn(x / size, y / size);
      const i = (y * size + x) * 4;
      ai.data[i] = p.r * 255; ai.data[i + 1] = p.g * 255; ai.data[i + 2] = p.b * 255; ai.data[i + 3] = 255;
      const rv = Math.max(0, Math.min(1, p.rough)) * 255;
      ri.data[i] = rv; ri.data[i + 1] = rv; ri.data[i + 2] = rv; ri.data[i + 3] = 255;
      height[y * size + x] = p.h;
    }
  }
  ac.putImageData(ai, 0, 0); rc.putImageData(ri, 0, 0);
  return { alb, rgh, height };
}

// --- the surfaces -----------------------------------------------------------

function polishedConcrete(size) {
  const { alb, rgh, height } = bake(size, (u, v) => {
    const big = fbm(u, v, 3, 4, 11);           // broad mottling
    const mid = fbm(u, v, 12, 4, 23);
    const fine = lattice(u, v, size / 2, 41);  // grain
    const speck = lattice(u, v, size / 3, 57) > 0.965 ? 1 : 0;
    // trowel arcs: faint long streaks
    const streak = Math.sin((u * 3 + fbm(u, v, 2, 2, 71) * 1.5) * 6.2831) * 0.5 + 0.5;
    let g = 0.56 + (big - 0.5) * 0.16 + (mid - 0.5) * 0.06 + (fine - 0.5) * 0.03 + (streak - 0.5) * 0.02 - speck * 0.18;
    const warm = 0.012 * (mid - 0.5);
    return {
      r: g + warm, g: g, b: g - warm * 0.6,
      rough: 0.28 + (big - 0.5) * 0.18 + (fine - 0.5) * 0.08 + speck * 0.3,
      h: 0.5 + (mid - 0.5) * 0.4 + (fine - 0.5) * 0.15 - speck * 0.4,
    };
  });
  return {
    map: toTexture(alb, { srgb: true }),
    roughnessMap: toTexture(rgh),
    normalMap: toTexture(normalFromHeight(height, size, 0.9)),
  };
}

function limePlaster(size) {
  const { alb, rgh, height } = bake(size, (u, v) => {
    const big = fbm(u, v, 2, 3, 101);
    const fine = fbm(u, v, 24, 3, 113);
    const g = 0.915 + (big - 0.5) * 0.035 + (fine - 0.5) * 0.02;
    return {
      r: g + 0.008, g: g + 0.002, b: g - 0.012,
      rough: 0.86 + (fine - 0.5) * 0.1,
      h: 0.5 + (fine - 0.5) * 0.5 + (big - 0.5) * 0.2,
    };
  });
  return {
    map: toTexture(alb, { srgb: true }),
    roughnessMap: toTexture(rgh),
    normalMap: toTexture(normalFromHeight(height, size, 0.35)),
  };
}

// sawn limestone slabs, 4 x 4 per tile, with tight grout lines
function stoneSlabs(size) {
  const N = 4, grout = 0.008;
  const { alb, rgh, height } = bake(size, (u, v) => {
    const su = u * N, sv = v * N;
    const iu = Math.floor(su), iv = Math.floor(sv);
    const fu = su - iu, fv = sv - iv;
    const edge = Math.min(fu, 1 - fu, fv, 1 - fv);
    const inGrout = edge < grout;
    const tone = hash2(iu, iv, 5) * 0.12 - 0.06;
    const vein = fbm(u, v, 6, 4, 131);
    const fine = fbm(u, v, 40, 3, 149);
    let g = 0.66 + tone + (vein - 0.5) * 0.12 + (fine - 0.5) * 0.04;
    let r = g + 0.03, b = g - 0.04;
    let rough = 0.62 + (fine - 0.5) * 0.15;
    let h = 0.5 + (fine - 0.5) * 0.25 + (vein - 0.5) * 0.1 + tone * 0.6;
    if (inGrout) { r = g = b = 0.32; rough = 0.95; h = 0.1; }
    else { const bevel = Math.min(1, (edge - grout) / 0.02); h = h * bevel + 0.2 * (1 - bevel); }
    return { r, g, b, rough, h };
  });
  return {
    map: toTexture(alb, { srgb: true }),
    roughnessMap: toTexture(rgh),
    normalMap: toTexture(normalFromHeight(height, size, 1.6)),
  };
}

function oiledOak(size) {
  const { alb, rgh, height } = bake(size, (u, v) => {
    const warp = fbm(u, v, 2, 3, 211) * 0.25;
    const ring = Math.sin((v * 34 + warp * 6 + Math.sin(u * 6.2831) * 0.15) * 6.2831);
    const grain = fbm(u, v, 48, 2, 223);
    const k = ring * 0.5 + 0.5;
    const base = 0.42 + k * 0.09 + (grain - 0.5) * 0.06;
    return {
      r: base + 0.14, g: base + 0.02, b: base - 0.12,
      rough: 0.5 + (1 - k) * 0.18 + (grain - 0.5) * 0.1,
      h: 0.5 + k * 0.2 + (grain - 0.5) * 0.3,
    };
  });
  return {
    map: toTexture(alb, { srgb: true }),
    roughnessMap: toTexture(rgh),
    normalMap: toTexture(normalFromHeight(height, size, 0.6)),
  };
}

// --- material set ----------------------------------------------------------

export function createMaterials(quality = 'high') {
  const size = quality === 'low' ? 512 : 1024;
  const concrete = polishedConcrete(size);
  const plaster = limePlaster(size / 2);
  const stone = stoneSlabs(size);
  const oak = oiledOak(size / 2);

  const mats = {
    // repeats are set per-mesh via userData.tile (m per repeat) in building.js
    concreteFloor: new THREE.MeshStandardMaterial({
      ...concrete, roughness: 1, metalness: 0.02, envMapIntensity: 0.4,
      normalScale: new THREE.Vector2(0.35, 0.35),
    }),
    plaster: new THREE.MeshStandardMaterial({
      ...plaster, roughness: 1, metalness: 0, envMapIntensity: 0.22,
      normalScale: new THREE.Vector2(0.4, 0.4),
    }),
    stone: new THREE.MeshStandardMaterial({
      ...stone, roughness: 1, metalness: 0, envMapIntensity: 0.9,
      normalScale: new THREE.Vector2(0.8, 0.8),
    }),
    oak: new THREE.MeshStandardMaterial({
      ...oak, roughness: 1, metalness: 0, envMapIntensity: 0.7,
      normalScale: new THREE.Vector2(0.5, 0.5),
    }),
    ceiling: new THREE.MeshStandardMaterial({ color: 0xf1efe9, roughness: 0.95, metalness: 0, envMapIntensity: 0.12 }),
    frame: new THREE.MeshStandardMaterial({ color: 0x1c1613, roughness: 0.42, metalness: 0.05, envMapIntensity: 0.8 }),
    frameLight: new THREE.MeshStandardMaterial({ color: 0xd8c9a8, roughness: 0.6, metalness: 0 }),
    plaque: new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.7, metalness: 0 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.32, metalness: 0.9, envMapIntensity: 1.2 }),
    blackSteel: new THREE.MeshStandardMaterial({ color: 0x1a1b1e, roughness: 0.45, metalness: 0.75, envMapIntensity: 0.9 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0xdfeef2, roughness: 0.06, metalness: 0, transparent: true, opacity: 0.22,
      envMapIntensity: 1.4, side: THREE.DoubleSide, depthWrite: false, reflectivity: 0.9,
    }),
    lightStrip: new THREE.MeshStandardMaterial({ color: 0xfff4e0, emissive: 0xfff1d8, emissiveIntensity: 1.6, roughness: 1 }),
    lightStripCool: new THREE.MeshStandardMaterial({ color: 0xf4f6ff, emissive: 0xe6ecff, emissiveIntensity: 1.6, roughness: 1 }),
    bookCloth: new THREE.MeshStandardMaterial({ color: 0x2b2420, roughness: 0.9 }),
    pages: new THREE.MeshStandardMaterial({ color: 0xf1e9d8, roughness: 0.95 }),
  };

  // The polished floor and the stone terraces take a live planar reflection
  // (reflector.js) injected into the material object itself via
  // onBeforeCompile — every mesh sharing that exact material gets the
  // reflection, regardless of whether it's actually a floor. `stone` is also
  // used for vertical/decorative surfaces (the plinth, return walls, the pool
  // curb) that must NOT sample a reflection meant only for the y=0 plane, so
  // they get their own clone that reflector.attach() never touches.
  mats.concreteFloor.userData.reflective = true;
  mats.stoneWall = mats.stone.clone();
  return mats;
}

// Set a material's texture repeat for a mesh of world size (w, d) so `tile`
// metres map onto one texture repeat. Materials are shared, so a mesh that
// needs a different repeat gets a cloned material with cloned maps.
export function tiled(mat, w, d, tile) {
  const m = mat.clone();
  for (const k of ['map', 'roughnessMap', 'normalMap']) {
    if (m[k]) { m[k] = m[k].clone(); m[k].repeat.set(w / tile, d / tile); m[k].needsUpdate = true; }
  }
  m.userData = { ...mat.userData };
  return m;
}
