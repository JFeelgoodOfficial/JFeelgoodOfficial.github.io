// The sea around the headland, and the reflecting pool in the sunset court.
// One shader: animated normal from summed waves + noise, Fresnel between the
// deep-water colour and skyColor(reflected ray) — the very same function the
// dome uses, so the reflection is always the sky that is actually overhead —
// plus a tight sun glitter and a distance fade into the horizon colour.

import * as THREE from 'three';
import { SKY_GLSL, skyUniforms } from './sky.js';

const vert = /* glsl */`
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const frag = /* glsl */`
precision highp float;
${SKY_GLSL}
uniform vec3 uSeaDeep;
uniform vec3 uSeaShallow;
uniform float uScale;      // wave scale multiplier (pool = smaller, calmer)
uniform float uCalm;       // 0 = open sea, 1 = still pool
varying vec3 vWorld;

// Analytic derivatives of a few directional waves. px is roughly how many
// metres one pixel covers here: any wave shorter than that cannot be resolved
// and only produces moiré, so each term is faded out by its own wavelength.
vec2 waveGrad(vec2 p, float t, float px) {
  vec2 g = vec2(0.0);
  // (direction, wavelength, amplitude, speed)
  vec2 d1 = normalize(vec2(0.8, 0.6));  float k1 = 6.2831 / 9.0;  float a1 = 0.22;
  vec2 d2 = normalize(vec2(-0.5, 0.85)); float k2 = 6.2831 / 4.6;  float a2 = 0.10;
  vec2 d3 = normalize(vec2(0.3, -0.95)); float k3 = 6.2831 / 2.1;  float a3 = 0.045;
  vec2 d4 = normalize(vec2(-0.9, -0.3)); float k4 = 6.2831 / 1.1;  float a4 = 0.02;
  g += d1 * k1 * a1 * cos(dot(p, d1) * k1 + t * 1.1) * exp(-px * k1 * 2.5);
  g += d2 * k2 * a2 * cos(dot(p, d2) * k2 - t * 1.6) * exp(-px * k2 * 2.5);
  g += d3 * k3 * a3 * cos(dot(p, d3) * k3 + t * 2.4) * exp(-px * k3 * 2.5);
  g += d4 * k4 * a4 * cos(dot(p, d4) * k4 - t * 3.1) * exp(-px * k4 * 2.5);
  return g;
}

void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-3);

  vec2 p = vWorld.xz * uScale;
  float t = uTime;
  // the pixel footprint in wave space, which is what decides how much detail
  // this fragment can carry without aliasing
  float px = max(length(fwidth(p)), 1e-4);
  vec2 g = waveGrad(p, t, px) * (1.0 - uCalm * 0.85);
  // fine ripples from noise derivatives (finite difference), faded the same way
  float e = 0.08;
  vec3 np = vec3(p * 1.7, t * 0.35);
  float n0 = fbm3(np);
  float nx = fbm3(np + vec3(e, 0.0, 0.0));
  float nz = fbm3(np + vec3(0.0, e, 0.0));
  g += vec2(nx - n0, nz - n0) / e * (0.06 - uCalm * 0.045) * exp(-px * 22.0);
  // and a plain distance fade, so the horizon settles into a mirror
  // (the obvious name for it, flat, is a reserved word in GLSL ES 3.0)
  float far = smoothstep(40.0, 500.0, dist);
  g *= (1.0 - far * 0.9);
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));

  vec3 R = reflect(-V, N);
  R.y = max(R.y, 0.015);
  vec3 sky = skyColor(normalize(R));

  float NdV = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  // deep colour, a little brighter where the sun's light scatters through
  float sunUp = clamp(uSunDir.y * 4.0, 0.0, 1.0);
  vec3 water = mix(uSeaDeep, uSeaShallow, 0.35 * pow(1.0 - NdV, 2.0)) * (0.6 + 0.4 * sunUp);
  water = mix(water, water * 0.35, uSpace * 0.7);
  vec3 col = mix(water, sky, F);

  // sun glitter: tight highlight + broad sheen
  vec3 H = normalize(V + uSunDir);
  float NdH = max(dot(N, H), 0.0);
  float glint = pow(NdH, 900.0) * 3.0 + pow(NdH, 80.0) * 0.12;
  col += uSunColor * glint * uSunIntensity * (1.0 - far * 0.5) * exp(-px * 1.2);

  // fade the far sea into the sky at the horizon
  vec3 hdir = normalize(vec3(-V.x, 0.004, -V.z));
  col = mix(col, skyColor(hdir), smoothstep(700.0, 4000.0, dist));

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function makeWaterMaterial(scale, calm, tint) {
  const uniforms = {
    ...skyUniforms,   // shared by reference: the sky drives the water
    uScale: { value: scale },
    uCalm: { value: calm },
  };
  // a tinted body of water (the pool) keeps its own colours instead
  if (tint) {
    uniforms.uSeaDeep = { value: new THREE.Color(tint.deep) };
    uniforms.uSeaShallow = { value: new THREE.Color(tint.shallow) };
  }
  return new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms,
    fog: false,
  });
}

export function createSea(y) {
  const geo = new THREE.PlaneGeometry(9000, 9000, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const sea = new THREE.Mesh(geo, makeWaterMaterial(1.0, 0.0));
  sea.position.y = y;
  sea.frustumCulled = false;
  sea.name = 'sea';
  return sea;
}

// A still pool: same shader, tiny calm ripples.
export function createPool(w, d, x, y, z) {
  const geo = new THREE.PlaneGeometry(w, d, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const pool = new THREE.Mesh(geo, makeWaterMaterial(2.6, 1.0, { deep: 0x24333a, shallow: 0x6e909a }));
  pool.position.set(x, y, z);
  pool.name = 'pool';
  return pool;
}
