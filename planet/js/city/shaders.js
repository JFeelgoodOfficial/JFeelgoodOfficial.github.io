// City effect shaders, inlined as strings so the module loads in a plain
// browser ES-module context (the source game bundles these via Vite's `?raw`
// import; jfeelgood serves raw modules with no build step). Sources are the
// verbatim GLSL from game/world/shaders/, kept here 1:1 for easy re-sync.

export const basicVert = `
varying vec2 vUv;
varying vec3 vLocalPos;
varying vec3 vNormal;

void main() {
  vUv = uv;
  vLocalPos = position;
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const cityWindowsVert = `
attribute float aSeed;

varying vec2 vCell;
varying float vSeed;
varying float vFace;

void main() {
  vSeed = aSeed;

  #ifdef USE_INSTANCING
    vec3 sc = vec3(
      length(instanceMatrix[0].xyz),
      length(instanceMatrix[1].xyz),
      length(instanceMatrix[2].xyz)
    );
  #else
    vec3 sc = vec3(1.0);
  #endif

  float horiz = abs(normal.x) > 0.5 ? sc.z : sc.x;
  vFace = 1.0 - step(0.5, abs(normal.y));
  vCell = vec2(uv.x * horiz / 2.4, uv.y * sc.y / 3.2);

  #ifdef USE_INSTANCING
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  #else
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #endif
}
`;

export const cityWindowsFrag = `
uniform float uTime;
uniform float uNight;
uniform vec3 uWarm;
uniform vec3 uFacade;

varying vec2 vCell;
varying float vSeed;
varying float vFace;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7)) + vSeed * 61.7) * 43758.5453);
}

void main() {
  vec2 id = floor(vCell);
  vec2 f = fract(vCell);
  float pane = step(0.15, f.x) * step(f.x, 0.85) * step(0.2, f.y) * step(f.y, 0.8);
  float n = hash(id);
  float roll = hash(id + floor(uTime * 0.25 + n * 8.0));
  float onFrac = mix(0.06, 0.62, uNight);
  float lit = step(roll, onFrac) * pane * vFace;
  float warmth = 0.75 + 0.5 * hash(id + 7.0);
  float density = max(fwidth(vCell.x), fwidth(vCell.y));
  float detail = clamp(2.0 - density * 3.0, 0.0, 1.0);
  float glow = mix(onFrac * 0.35 * vFace, lit * warmth, detail);
  vec3 col = uFacade + uWarm * glow * mix(0.35, 1.6, uNight);
  gl_FragColor = vec4(col, 1.0);
}
`;

export const pulseGlowVert = `
attribute float aPhase;
attribute vec3 aTint;

varying float vPhase;
varying vec3 vTint;

void main() {
  vPhase = aPhase;
  vTint = aTint;
  #ifdef USE_INSTANCING
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  #else
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #endif
}
`;

export const pulseGlowFrag = `
uniform float uTime;
uniform float uNight;
uniform float uBase;
uniform float uAmp;
uniform float uSpeed;
uniform float uFlicker;

varying float vPhase;
varying vec3 vTint;

float hash1(float p) { return fract(sin(p * 127.1) * 43758.5453); }

void main() {
  float pulse = 0.5 + 0.5 * sin(uTime * uSpeed + vPhase);
  float flick = 1.0 - uFlicker * uNight * step(0.92, hash1(vPhase + floor(uTime * 9.0)));
  float level = (uBase + uAmp * pulse) * flick * mix(0.18, 1.0, uNight);
  gl_FragColor = vec4(vTint * level, 1.0);
}
`;

export const cityAdsFrag = `
uniform sampler2D uMap;
uniform float uTime;
uniform float uNight;

varying vec2 vUv;

float hash1(float p) { return fract(sin(p * 127.1) * 43758.5453); }

void main() {
  vec2 uv = vUv;
  float beat = floor(uTime * 1.7);
  float tear = step(0.93, hash1(beat));
  uv.x = fract(uv.x + tear * (hash1(floor(vUv.y * 24.0) + beat) - 0.5) * 0.1);

  vec3 col = texture2D(uMap, uv).rgb;
  float band = fract(vUv.y - uTime * 0.12);
  float sweep = 1.0 + 0.8 * exp(-30.0 * (band - 0.5) * (band - 0.5));
  float scan = 0.85 + 0.15 * sin(vUv.y * 320.0 + uTime * 8.0);
  float level = mix(0.25, 1.6, uNight);
  gl_FragColor = vec4(col * sweep * scan * level, 1.0);
}
`;

export const cityHazeFrag = `
uniform vec3 uColor;
uniform float uNight;

varying vec2 vUv;

void main() {
  float v = smoothstep(0.0, 0.22, vUv.y) * (1.0 - smoothstep(0.4, 1.0, vUv.y));
  float h = 1.0 - abs(vUv.x - 0.5) * 2.0;
  h *= h;
  float a = v * h * mix(0.04, 0.2, uNight);
  gl_FragColor = vec4(uColor * a, a);
}
`;
