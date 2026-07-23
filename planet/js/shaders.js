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
  bool land = elev >= uSeaLevel;

  // --- albedo bands (unchanged palette) ---
  vec3 col;
  if (!land) {
    float d = elev / max(uSeaLevel, 1e-4);
    col = mix(uColDeep, uColShallow, d * d);
  } else {
    float e = (elev - uSeaLevel) / (1.0 - uSeaLevel);
    col = mix(uColSand, uColLow, smoothstep(0.02, 0.18, e));
    col = mix(col, uColMid, smoothstep(0.28, 0.58, e));
    col = mix(col, uColHigh, smoothstep(0.62, 0.84, e));
  }

  // --- shared tangent basis from screen-space derivatives ---
  vec3 N = normalize(vWorldNormal);
  vec3 dpx = dFdx(vObjPos), dpy = dFdy(vObjPos);
  vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
  float det = dot(dpx, r1);
  bool haveBasis = abs(det) > 1e-10;

  // macro relief bump from the elevation field + gated fine micro-relief so the
  // near ground (uOct 6) reads as textured rather than glassy-smooth.
  float detail = 0.5;
  if (land && haveBasis) {
    if (uAmp > 0.0) {
      vec3 grad = (r1 * dFdx(elev) + r2 * dFdy(elev)) / det;
      vec3 pert = grad * uAmp * 1.6;
      pert *= 3.0 / max(3.0, length(pert));
      N = normalize(N - pert);
    }
    if (uOct >= 6) {
      detail = fbm(p * 130.0, 4);
      vec3 mg = (r1 * dFdx(detail) + r2 * dFdy(detail)) / det;
      N = normalize(N - mg * 0.5);
    }
  }

  // slope relative to the local radial up: rock on steep faces + broad grain.
  float slope = clamp(1.0 - dot(N, p), 0.0, 1.0);
  if (land) {
    vec3 rock = mix(uColMid, vec3(0.24, 0.22, 0.20), 0.65);
    col = mix(col, rock, smoothstep(0.18, 0.5, slope));
    col *= 0.9 + 0.2 * detail;
  }

  col = mix(col, vec3(0.90, 0.94, 1.0),
            smoothstep(uIceLat, uIceLat + 0.21, lat + (elev - 0.5) * 0.15));

  vec3 S = normalize(uSun), V = normalize(vViewDir);
  float ndl = dot(N, S);
  float day = smoothstep(-0.14, 0.30, ndl);

  // hemispheric ambient (cool sky above, warm bounce below) so relief still
  // reads on the shaded hemisphere instead of crushing flat to black.
  float up = clamp(dot(N, p) * 0.5 + 0.5, 0.0, 1.0);
  vec3 ambient = mix(vec3(0.10, 0.09, 0.09), vec3(0.20, 0.25, 0.34), up);
  float ao = 1.0 - 0.25 * (1.0 - detail); // crevice occlusion
  vec3 lit = col * (ambient + vec3(1.0, 0.97, 0.90) * day) * ao;

  // specular: gentle sheen on land, brighter on the wet shallows
  vec3 H = normalize(S + V);
  float shin = land ? 24.0 : 70.0;
  float specAmt = land ? 0.10 : 0.5;
  lit += vec3(1.0, 0.97, 0.88) * pow(max(dot(N, H), 0.0), shin) * day * specAmt;

  float rim = pow(1.0 - max(dot(normalize(vWorldNormal), V), 0.0), 3.0) * day;
  lit += vec3(0.35, 0.45, 0.7) * rim * 0.30;

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
uniform float uTime;

// animated ripple field: crossed traveling sine waves in the surface tangent
float ripple(vec3 p) {
  float a = sin(p.x * 120.0 + uTime * 1.3) * 0.5 + 0.5;
  float b = sin(p.z * 138.0 - uTime * 1.1) * 0.5 + 0.5;
  float c = sin((p.x + p.z) * 90.0 + uTime * 0.7) * 0.5 + 0.5;
  return (a + b + c) / 3.0;
}

void main() {
  vec3 p = normalize(vObjPos);
  vec3 N = normalize(vWorldNormal), S = normalize(uSun), V = normalize(vViewDir);

  // perturb the normal by the ripple gradient (screen-space) for live shimmer
  vec3 dpx = dFdx(vObjPos), dpy = dFdy(vObjPos);
  vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
  float det = dot(dpx, r1);
  float rip = ripple(p);
  if (abs(det) > 1e-10) {
    vec3 g = (r1 * dFdx(rip) + r2 * dFdy(rip)) / det;
    N = normalize(N - g * 0.12);
  }

  float day = smoothstep(-0.12, 0.28, dot(N, S));
  vec3 col = uWaterColor * (0.05 + 0.95 * day);
  col *= 0.92 + 0.16 * rip; // faint moving light on the surface

  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  col += vec3(0.30, 0.46, 0.66) * fres * 0.7 * day * uGloss;

  vec3 H = normalize(S + V);
  col += vec3(1.0, 0.95, 0.8) * pow(max(dot(N, H), 0.0), 120.0) * day * uGloss * 1.3;

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
