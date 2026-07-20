// Single-planet builder, adapted from Feelgood Space Flight's planet.js.
// One config (no CONFIGS loop, no gas giants, no floating origin, no spin), so
// the game's co-rotation and un-rotation math all collapses away: children of
// `surface` live in the unrotated object frame, and groundAtLocal is a direct
// terrain.js sample. Terrain displacement is baked into the geometry on the
// CPU during the loading screen, then the surface uses the pass-through vertex
// shader; the fragment shader still evaluates the same field per pixel.

import * as THREE from 'three';
import { C, SUN } from './config.js';
import { groundHeight, elevationAt } from './terrain.js';
import {
  surfaceBakedVert, surfaceFrag, waterFrag, atmosphereFrag, cloudFrag,
  skydomeVert, skydomeFrag,
} from './shaders.js';

export function createPlanet(scene) {
  const radius = C.RADIUS;
  const p = C.PALETTE;

  // --- surface ---
  const surfaceUniforms = {
    uSun: { value: SUN.clone() },
    uSeaLevel: { value: C.SEA_LEVEL },
    uAmp: { value: C.TERRAIN_HEIGHT },
    uRadius: { value: radius },
    uOct: { value: 6 },
    uIceLat: { value: C.ICE_LAT },
    uColDeep: { value: new THREE.Color(p.deep) },
    uColShallow: { value: new THREE.Color(p.shallow) },
    uColSand: { value: new THREE.Color(p.sand) },
    uColLow: { value: new THREE.Color(p.low) },
    uColMid: { value: new THREE.Color(p.mid) },
    uColHigh: { value: new THREE.Color(p.high) },
  };
  const surfaceMat = new THREE.ShaderMaterial({
    // We bake displacement on the CPU before the first render, so the surface
    // can use the pass-through vertex stage from the start.
    vertexShader: surfaceBakedVert,
    fragmentShader: surfaceFrag,
    uniforms: surfaceUniforms,
  });
  const seg = 288;
  const surfaceGeo = new THREE.SphereGeometry(radius, seg, seg / 2);
  const surface = new THREE.Mesh(surfaceGeo, surfaceMat);
  surface.frustumCulled = false;
  scene.add(surface);

  // --- water ---
  const water = new THREE.Mesh(
    new THREE.SphereGeometry(radius + C.WALK_WATER_LEVEL, 160, 80),
    new THREE.ShaderMaterial({
      vertexShader: surfaceBakedVert,
      fragmentShader: waterFrag,
      uniforms: {
        uSun: { value: SUN.clone() },
        uWaterColor: { value: new THREE.Color(C.WATER.color) },
        uGloss: { value: C.WATER.gloss },
      },
    })
  );
  water.frustumCulled = false;
  scene.add(water);

  // --- clouds ---
  const cloudMat = new THREE.ShaderMaterial({
    vertexShader: surfaceBakedVert,
    fragmentShader: cloudFrag,
    uniforms: {
      uSun: { value: SUN.clone() },
      uTime: { value: 0 },
      uCover: { value: C.CLOUD_COVER },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide, // read the layer from below, standing under it
  });
  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.06, 128, 64),
    cloudMat
  );
  clouds.renderOrder = 1;
  clouds.frustumCulled = false;
  scene.add(clouds);

  // --- atmosphere limb shell ---
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(radius * C.ATMO_SHELL, 96, 48),
    new THREE.ShaderMaterial({
      vertexShader: surfaceBakedVert,
      fragmentShader: atmosphereFrag,
      uniforms: {
        uSun: { value: SUN.clone() },
        uColor: { value: new THREE.Color(0xcaa45a) },
      },
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  atmosphere.renderOrder = 2;
  atmosphere.frustumCulled = false;
  scene.add(atmosphere);

  // --- skydome (follows the camera; its local +Y is aligned each frame to the
  // player's up, so the gradient horizon tracks the true horizon) ---
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: skydomeVert,
    fragmentShader: skydomeFrag,
    uniforms: {
      uHorizon: { value: new THREE.Color(C.SKY_HORIZON) },
      uZenith: { value: new THREE.Color(C.SKY_ZENITH) },
      uBelow: { value: new THREE.Color(C.SKY_BELOW) },
    },
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);

  const planet = {
    radius,
    surface, water, clouds, atmosphere, sky,
    surfaceUniforms,
    seaR: radius + C.WALK_WATER_LEVEL,
    // Ground height above the base sphere for a unit direction in object space
    // (== world space; no spin). 0 over water.
    groundAtLocal: (dir) =>
      groundHeight(dir.x, dir.y, dir.z, C.SEA_LEVEL, C.TERRAIN_HEIGHT),
  };
  return planet;
}

// Chunked CPU displacement bake. Yields to the event loop every ~BUDGET_MS so
// the loading bar can advance. onProgress(0..1) and onDone() drive the loader.
export function bakePlanet(planet, onProgress, onDone) {
  const pos = planet.surface.geometry.attributes.position;
  const total = pos.count;
  const inv = 1 / planet.radius;
  const seaLevel = C.SEA_LEVEL;
  const amp = C.TERRAIN_HEIGHT;
  const BUDGET_MS = 12;
  let vi = 0;

  function slice() {
    const t0 = performance.now();
    for (; vi < total; vi++) {
      const x = pos.getX(vi), y = pos.getY(vi), z = pos.getZ(vi);
      const dx = x * inv, dy = y * inv, dz = z * inv;
      const disp = Math.max(elevationAt(dx, dy, dz) - seaLevel, 0) * amp;
      if (disp > 0) pos.setXYZ(vi, x + dx * disp, y + dy * disp, z + dz * disp);
      if ((vi & 1023) === 1023 && performance.now() - t0 > BUDGET_MS) {
        vi++;
        onProgress && onProgress(vi / total);
        setTimeout(slice, 0);
        return;
      }
    }
    pos.needsUpdate = true;
    planet.surface.geometry.computeVertexNormals();
    planet.surface.geometry.computeBoundingSphere();
    onProgress && onProgress(1);
    onDone && onDone();
  }
  setTimeout(slice, 0);
}

const _cam = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);

// Per-frame update: clouds drift, surface octave LOD by camera distance, and
// the skydome rides with the camera. `t` is elapsed seconds. The dome's local
// +Y is aligned to the player's up (camera.up) so its horizon gradient sits at
// the true horizon.
export function updatePlanet(planet, t, camera, quality) {
  planet.clouds.material.uniforms.uTime.value = t;

  camera.getWorldPosition(_cam);
  const distR = _cam.length() / planet.radius; // planet centered at origin
  let oct = distR < 1.4 ? 6 : distR < 4 ? 4 : 3;
  if (quality === 'low' && oct > 4) oct = 4;
  planet.surfaceUniforms.uOct.value = oct;

  planet.sky.position.copy(_cam);
  planet.sky.scale.setScalar(Math.max(camera.far * 0.5, 4000));
  planet.sky.quaternion.setFromUnitVectors(_yAxis, camera.up);
}
