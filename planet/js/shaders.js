// All GLSL for the planet, as template-literal strings (no build step / no
// ?raw imports). surface.frag, surfaceBaked.vert, water.frag, atmosphere.frag
// and cloud.frag are copied verbatim from Feelgood Space Flight
// (game/src/shaders/*); the skydome pair is new (the game's screen-space
// skyfog.frag needs a post composer we don't run here).

// --- terra surface, post-bake pass-through vertex stage ---
// The warped-fbm + ridged displacement is baked into the geometry on the CPU
// (planet.js, via terrain.js), so this is just a pass-through that forwards
// object position / world normal / view dir to the fragment shader.
export const surfaceBakedVert = /* glsl */`
varying vec3 vObjPos;
varying vec3 vWorldNormal;
varying vec3 vViewDir;

void main() {
  vObjPos = position; // already displaced; normalize() in the fragment
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vViewDir = cameraPosition - world.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// --- terra surface fragment: banded terrain colour + ice + relief bump ---
export const surfaceFrag = /* glsl */`
varying vec3 vObjPos;
varying vec3 vWorldNormal;
varying vec3 vViewDir;

uniform vec3 uSun;
uniform float uSeaLevel;
uniform float uAmp;
uniform float uRadius;
uniform int uOct;
uniform float uIceLat;
uniform vec3 uColDeep;
uniform vec3 uColShallow;
uniform vec3 uColSand;
uniform vec3 uColLow;
uniform vec3 uColMid;
uniform vec3 uColHigh;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i + vec3(0, 0, 0)), hash(i + vec3(1, 0, 0)), f.x),
        mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
        mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p, int oct) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 7; i++) {
    if (i >= oct) break;
    v += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}
float ridged(vec3 p, int oct) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    if (i >= oct) break;
    v += a * (1.0 - abs(2.0 * vnoise(p) - 1.0));
    p *= 2.11;
    a *= 0.5;
  }
  return v;
}
float elevation(vec3 p, int oct) {
  vec3 warp = vec3(fbm(p * 1.3 + 4.1, 3), fbm(p * 1.3 + 8.7, 3), fbm(p * 1.3 + 1.9, 3));
  float base = fbm(p * 1.8 + warp * 0.6, oct);
  float mask = smoothstep(0.5, 0.62, base);
  return base * 0.72 + ridged(p * 3.5, 4) * 0.28 * mask;
}

void main() {
  vec3 p = normalize(vObjPos);
  float elev = elevation(p, uOct);
  float lat = abs(p.y);

  vec3 col;
  if (elev < uSeaLevel) {
    float d = elev / max(uSeaLevel, 1e-4);
    col = mix(uColDeep, uColShallow, d * d);
  } else {
    float e = (elev - uSeaLevel) / (1.0 - uSeaLevel);
    col = mix(uColSand, uColLow, smoothstep(0.02, 0.18, e));
    col = mix(col, uColMid, smoothstep(0.28, 0.58, e));
    col = mix(col, uColHigh, smoothstep(0.62, 0.84, e));
    if (uOct >= 6) {
      float grain = fbm(p * 40.0, 3);
      col *= 0.88 + 0.24 * grain;
    }
  }
  col = mix(col, vec3(0.90, 0.94, 1.0),
            smoothstep(uIceLat, uIceLat + 0.21, lat + (elev - 0.5) * 0.15));

  vec3 N = normalize(vWorldNormal), S = normalize(uSun), V = normalize(vViewDir);

  if (uAmp > 0.0 && elev > uSeaLevel) {
    vec3 dpx = dFdx(vObjPos);
    vec3 dpy = dFdy(vObjPos);
    vec3 r1 = cross(dpy, N);
    vec3 r2 = cross(N, dpx);
    float det = dot(dpx, r1);
    if (abs(det) > 1e-10) {
      vec3 grad = (r1 * dFdx(elev) + r2 * dFdy(elev)) / det;
      vec3 pert = grad * uAmp * 1.4;
      pert *= 3.0 / max(3.0, length(pert));
      N = normalize(N - pert);
    }
  }

  float ndl = dot(N, S);
  float day = smoothstep(-0.12, 0.28, ndl);
  vec3 lit = col * (0.06 + 0.94 * day);

  float rim = pow(1.0 - max(dot(normalize(vWorldNormal), V), 0.0), 3.0) * day;
  lit += vec3(0.35, 0.45, 0.7) * rim * 0.35;

  gl_FragColor = vec4(lit, 1.0);
}
`;

// --- sea surface ---
export const waterFrag = /* glsl */`
varying vec3 vObjPos;
varying vec3 vWorldNormal;
varying vec3 vViewDir;

uniform vec3 uSun;
uniform vec3 uWaterColor;
uniform float uGloss;

void main() {
  vec3 N = normalize(vWorldNormal), S = normalize(uSun), V = normalize(vViewDir);
  float day = smoothstep(-0.12, 0.28, dot(N, S));

  vec3 col = uWaterColor * (0.05 + 0.95 * day);

  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += vec3(0.25, 0.4, 0.6) * fres * 0.5 * day * uGloss;

  vec3 H = normalize(S + V);
  col += vec3(1.0, 0.95, 0.8) * pow(max(dot(N, H), 0.0), 90.0) * day * uGloss;

  gl_FragColor = vec4(col, 1.0);
}
`;

// --- atmospheric limb (backside shell, additive) ---
export const atmosphereFrag = /* glsl */`
varying vec3 vWorldNormal;
varying vec3 vViewDir;

uniform vec3 uSun;
uniform vec3 uColor;

void main() {
  vec3 N = normalize(vWorldNormal), V = normalize(vViewDir);
  float fres = pow(1.0 - abs(dot(N, V)), 2.4);
  float sun = smoothstep(-0.35, 0.6, dot(-N, normalize(uSun)));
  float a = fres * (0.25 + 0.75 * sun);
  gl_FragColor = vec4(uColor * a, a);
}
`;

// --- cloud layer ---
export const cloudFrag = /* glsl */`
varying vec3 vObjPos;
varying vec3 vWorldNormal;

uniform vec3 uSun;
uniform float uTime;
uniform float uCover;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i + vec3(0, 0, 0)), hash(i + vec3(1, 0, 0)), f.x),
        mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
        mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.05; a *= 0.5; }
  return v;
}

void main() {
  vec3 p = normalize(vObjPos);
  float d = fbm(p * 2.4 + vec3(uTime * 0.006, 0.0, uTime * 0.004));
  d = d * 0.7 + fbm(p * 5.0 - vec3(0.0, uTime * 0.008, 0.0)) * 0.3;

  float lo = mix(0.62, 0.4, uCover);
  float cover = smoothstep(lo, lo + 0.16, d);
  if (cover < 0.01) discard;

  float ndl = dot(normalize(vWorldNormal), normalize(uSun));
  float day = smoothstep(-0.1, 0.32, ndl);
  vec3 col = mix(vec3(0.55, 0.6, 0.72), vec3(1.0), day);

  gl_FragColor = vec4(col, cover * (0.15 + 0.85 * day));
}
`;

// --- skydome: inverted sphere, gradient horizon→zenith + hashed starfield ---
export const skydomeVert = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  // keep the dome centered on the camera so it never clips
  vec4 world = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * world;
}
`;

export const skydomeFrag = /* glsl */`
varying vec3 vDir;

uniform vec3 uHorizon;
uniform vec3 uZenith;
uniform vec3 uBelow;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  vec3 dir = normalize(vDir);
  float up = dir.y; // dome is built in a local frame where +Y is the sky up

  vec3 col;
  if (up >= 0.0) {
    float t = pow(clamp(up, 0.0, 1.0), 0.6);
    col = mix(uHorizon, uZenith, t);
    // stars only high up, faint, hashed by direction
    float star = hash(floor(dir * 240.0));
    float tw = smoothstep(0.9975, 1.0, star) * smoothstep(0.15, 0.6, up);
    col += vec3(tw) * 0.8;
  } else {
    col = mix(uHorizon, uBelow, pow(clamp(-up, 0.0, 1.0), 0.5));
  }

  gl_FragColor = vec4(col, 1.0);
}
`;
