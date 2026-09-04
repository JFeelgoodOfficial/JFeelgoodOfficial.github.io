// One procedural sky for the whole gallery. Its look is a blend of three
// presets (sunrise / sunset / deep space, config.js) weighted by where the
// visitor stands: skyStateAt(x) gives s in [0,2] and setSkyState() lerps every
// uniform. The same GLSL skyColor() is compiled into the water shader so the
// sea always reflects exactly the sky above it, and PMREM environment maps are
// baked from it once per preset for the PBR materials indoors.

import * as THREE from 'three';
import { SKY } from './config.js';

// Shared uniforms — the dome, the water and the env bake all read these.
export const skyUniforms = {
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunColor: { value: new THREE.Color() },
  uSunIntensity: { value: 1 },
  uHorizon: { value: new THREE.Color() },
  uHorizonFar: { value: new THREE.Color() },
  uZenith: { value: new THREE.Color() },
  uGlow: { value: new THREE.Color() },
  uHaze: { value: 1 },
  uCloud: { value: 0.4 },
  uCloudLit: { value: new THREE.Color() },
  uCloudShade: { value: new THREE.Color() },
  uSpace: { value: 0 },
  uTime: { value: 0 },
  uSeaDeep: { value: new THREE.Color() },
  uSeaShallow: { value: new THREE.Color() },
};

// GLSL: noise + the sky function. Uniform declarations included so any shader
// that pastes this in can call skyColor(dir).
export const SKY_GLSL = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uHorizon;
uniform vec3 uHorizonFar;
uniform vec3 uZenith;
uniform vec3 uGlow;
uniform float uHaze;
uniform float uCloud;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform float uSpace;
uniform float uTime;

float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s;
}
float fbm3(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.1 + vec3(3.3, 1.1, 7.7); a *= 0.5; }
  return s;
}

// --- stars: three cell layers on the unit sphere ---
float starLayer(vec3 d, float scale, float thresh, float size) {
  vec3 cell = floor(d * scale);
  vec3 h = hash33(cell);
  vec3 center = (cell + 0.15 + 0.7 * h) / scale;
  float dist = length(normalize(center) - d) * scale;
  float pick = step(thresh, hash13(cell + 17.0));
  float star = smoothstep(size, 0.0, dist);
  float twinkle = 0.78 + 0.22 * sin(uTime * (1.5 + 2.0 * h.x) + h.y * 40.0);
  return star * pick * twinkle * (0.4 + 0.6 * h.z);
}

vec3 spaceColor(vec3 d) {
  // galactic plane tilted across the sky
  vec3 gN = normalize(vec3(0.55, 0.6, -0.58));
  float band = exp(-pow(dot(d, gN) * 5.5, 2.0));
  float dust = fbm(d * 4.0 + 5.0);
  float lanes = smoothstep(0.25, 0.7, fbm(d * 7.0 + 21.0));
  float mw = band * (0.25 + 0.75 * dust) * (0.35 + 0.65 * lanes);
  vec3 mwCol = mix(vec3(0.55, 0.5, 0.75), vec3(0.95, 0.9, 0.85), dust) * mw * 0.9;

  // a nebula low over the eastern sea
  vec3 nDir = normalize(vec3(0.75, 0.28, 0.6));
  float nf = fbm(d * 2.6 + 11.0);
  float neb = pow(nf, 2.6) * exp(-pow(length(d - nDir) * 1.9, 2.0)) * 1.8;
  vec3 nebCol = mix(vec3(0.85, 0.25, 0.55), vec3(0.2, 0.55, 0.85), fbm3(d * 3.0 + 40.0)) * neb;

  float stars = starLayer(d, 60.0, 0.86, 0.06) * 1.2
              + starLayer(d, 120.0, 0.9, 0.05) * 0.7
              + starLayer(d, 260.0, 0.93, 0.06) * 0.35;
  stars *= 1.0 + 1.5 * band;               // denser along the plane
  vec3 starCol = mix(vec3(0.85, 0.9, 1.0), vec3(1.0, 0.9, 0.75), hash13(floor(d * 60.0)));

  vec3 base = mix(uHorizon, uZenith, smoothstep(-0.05, 0.6, d.y));
  return base + mwCol + nebCol + starCol * stars;
}

vec3 skyColor(vec3 d) {
  float y = d.y;
  float up = clamp(y, 0.0, 1.0);
  float cosT = dot(d, uSunDir);

  // horizon colour warms toward the sun's azimuth
  vec2 dh = normalize(d.xz + vec2(1e-4, 0.0));
  vec2 sh = normalize(uSunDir.xz + vec2(1e-4, 0.0));
  float az = dot(dh, sh) * 0.5 + 0.5;
  vec3 horizon = mix(uHorizonFar, uHorizon, pow(az, 1.6));

  float g = 1.0 - exp(-up * (3.4 / uHaze));
  vec3 col = mix(horizon, uZenith, g);
  // just under the horizon: the band darkens (the sea hides most of it)
  col *= mix(0.45, 1.0, smoothstep(-0.12, 0.0, y));

  // forward scattering around the sun
  float c = max(cosT, 0.0);
  float mie = pow(c, 5.0) * 0.55 + pow(c, 40.0) * 0.9;
  col += uGlow * mie * (1.0 - 0.6 * up) * uSunIntensity * 0.45;
  // low, wide warm spread along the horizon toward the sun
  col += uGlow * 0.35 * pow(az, 5.0) * exp(-up * 7.0) * step(-0.02, y) * uSunIntensity * 0.4;

  // sun disc (bright enough to bloom)
  float ang = acos(clamp(cosT, -1.0, 1.0));
  float disc = 1.0 - smoothstep(0.0085, 0.0125, ang);
  col += uSunColor * disc * uSunIntensity * 5.0 * step(0.0, y + 0.004);

  // clouds: fbm on a plane projected onto the sky, drifting slowly
  if (uCloud > 0.001 && y > 0.005) {
    vec2 cp = d.xz / (y + 0.09);
    vec3 p = vec3(cp * 0.55 + vec2(uTime * 0.006, uTime * 0.002), uTime * 0.01);
    float n = fbm(p);
    float cov = smoothstep(1.0 - uCloud * 0.85, 1.0 - uCloud * 0.85 + 0.42, n);
    cov *= smoothstep(0.0, 0.14, y) * (1.0 - smoothstep(0.55, 1.0, y) * 0.5);
    float lit = pow(c, 2.5);
    // edges toward the sun catch light
    float rim = smoothstep(0.35, 0.9, n) * lit;
    vec3 cc = mix(uCloudShade, uCloudLit, 0.3 + 0.7 * lit) + uCloudLit * rim * 0.6;
    col = mix(col, cc, cov * 0.9);
  }

  if (uSpace > 0.001) col = mix(col, spaceColor(d), uSpace);
  return col;
}
`;

const domeVert = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const domeFrag = /* glsl */`
precision highp float;
${SKY_GLSL}
varying vec3 vDir;
void main() {
  vec3 col = skyColor(normalize(vDir));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createSkyDome(radius = 4200) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: domeVert,
    fragmentShader: domeFrag,
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), mat);
  dome.frustumCulled = false;
  dome.renderOrder = -10;
  dome.name = 'sky';
  return dome;
}

// ---------------------------------------------------------------------------
// State blending. s in [0, 2]. Returns the interpolated preset (colours and
// scalars) and writes it into the uniforms.
const _a = new THREE.Color(), _b = new THREE.Color();
const _v = new THREE.Vector3();
const _cur = {
  sunDir: new THREE.Vector3(),
  sunColor: new THREE.Color(),
  sunIntensity: 1,
  hemiSky: new THREE.Color(),
  hemiGround: new THREE.Color(),
  hemiIntensity: 0.5,
  envIntensity: 0.8,
  space: 0,
  horizon: new THREE.Color(),
  zenith: new THREE.Color(),
  w: [1, 0, 0],
};

function lerpColor(out, a, b, t) { return out.copy(a).lerp(b, t); }

export function setSkyState(s) {
  s = Math.max(0, Math.min(2, s));
  let A, B, t;
  if (s <= 1) { A = SKY.sunrise; B = SKY.sunset; t = s; }
  else { A = SKY.sunset; B = SKY.space; t = s - 1; }
  const u = skyUniforms;
  // the sun slides along the horizon between presets rather than through the
  // ground: slerp-ish via normalized lerp with a lift
  _v.copy(A.sunDir).lerp(B.sunDir, t);
  if (_v.lengthSq() < 0.05) _v.set(0, 1, 0);
  _v.normalize();
  u.uSunDir.value.copy(_v);
  _cur.sunDir.copy(_v);
  lerpColor(u.uSunColor.value, A.sunColor, B.sunColor, t);
  _cur.sunColor.copy(u.uSunColor.value);
  u.uSunIntensity.value = _cur.sunIntensity = THREE.MathUtils.lerp(A.sunIntensity, B.sunIntensity, t);
  lerpColor(u.uHorizon.value, A.horizon, B.horizon, t);
  lerpColor(u.uHorizonFar.value, A.horizonFar, B.horizonFar, t);
  lerpColor(u.uZenith.value, A.zenith, B.zenith, t);
  lerpColor(u.uGlow.value, A.glow, B.glow, t);
  u.uHaze.value = THREE.MathUtils.lerp(A.haze, B.haze, t);
  u.uCloud.value = THREE.MathUtils.lerp(A.cloud, B.cloud, t);
  lerpColor(u.uCloudLit.value, A.cloudLit, B.cloudLit, t);
  lerpColor(u.uCloudShade.value, A.cloudShade, B.cloudShade, t);
  u.uSpace.value = _cur.space = THREE.MathUtils.lerp(A.space, B.space, t);
  lerpColor(u.uSeaDeep.value, A.seaDeep, B.seaDeep, t);
  lerpColor(u.uSeaShallow.value, A.seaShallow, B.seaShallow, t);
  lerpColor(_cur.hemiSky, A.hemiSky, B.hemiSky, t);
  lerpColor(_cur.hemiGround, A.hemiGround, B.hemiGround, t);
  _cur.hemiIntensity = THREE.MathUtils.lerp(A.hemiIntensity, B.hemiIntensity, t);
  _cur.envIntensity = THREE.MathUtils.lerp(A.envIntensity, B.envIntensity, t);
  _cur.horizon.copy(u.uHorizon.value);
  _cur.zenith.copy(u.uZenith.value);
  _cur.w[0] = Math.max(0, 1 - s);
  _cur.w[1] = 1 - Math.abs(s - 1);
  _cur.w[2] = Math.max(0, s - 1);
  return _cur;
}

export function currentSky() { return _cur; }

// ---------------------------------------------------------------------------
// Environment maps: one PMREM per preset, baked from the dome itself.
export function bakeEnvironments(renderer, dome) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envScene = new THREE.Scene();
  const parent = dome.parent;
  envScene.add(dome);
  const out = {};
  const saveTime = skyUniforms.uTime.value;
  for (const [name, s] of [['sunrise', 0], ['sunset', 1], ['space', 2]]) {
    setSkyState(s);
    out[name] = pmrem.fromScene(envScene, 0.02, 1, 10000).texture;
  }
  skyUniforms.uTime.value = saveTime;
  envScene.remove(dome);
  if (parent) parent.add(dome);
  pmrem.dispose();
  return out;
}
