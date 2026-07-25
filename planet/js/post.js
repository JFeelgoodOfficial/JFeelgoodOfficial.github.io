// post.js — self-contained additive-bloom post pipeline (core Three.js only, no
// addons, so it works with the project's minimal vendored importmap).
//
// Design goal: LOOK-PRESERVING. The base image is captured 1:1 and the bloom is
// added ON TOP, so the artist's tuned dark/gold palette is never washed out or
// re-graded — the neon simply glows the way `NEON_BLOOM_INTENSITY` (city.js)
// always intended but was never wired to do. The scene render target is an
// 8-bit sRGB buffer, so rendering into it produces the same pixels the canvas
// showed before; the composite writes those pixels back unchanged plus a blurred
// bright-pass. No float textures, no tone-map re-grade, integrated-GPU friendly.
//
// Works for any (scene, camera) pair, so the planet scene and the gallery
// interior scene both route through the same instance.

import * as THREE from 'three';

const QUALITY = {
  high:   { scale: 1.0, blurPasses: 3, half: true },
  medium: { scale: 1.0, blurPasses: 2, half: true },
  low:    { scale: 1.0, blurPasses: 1, half: true },
};

const fullscreenVert = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Bright pass: soft-knee threshold on perceptual luminance, keeps only the
// glowing highlights (neon, windows, engine plumes, lightning).
const brightFrag = /* glsl */`
precision highp float;
uniform sampler2D uScene;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(uScene, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // soft knee so highlights ramp in instead of hard-clipping
  float soft = clamp((l - uThreshold + uKnee) / (2.0 * uKnee), 0.0, 1.0);
  float w = max(soft * soft, step(uThreshold, l));
  gl_FragColor = vec4(c * w, 1.0);
}
`;

// Separable 9-tap Gaussian; uDirection carries the texel step (x or y).
const blurFrag = /* glsl */`
precision highp float;
uniform sampler2D uTex;
uniform vec2 uDirection;
varying vec2 vUv;
void main() {
  vec2 d = uDirection;
  vec3 sum = texture2D(uTex, vUv).rgb * 0.227027;
  sum += texture2D(uTex, vUv + d * 1.3846).rgb * 0.316216;
  sum += texture2D(uTex, vUv - d * 1.3846).rgb * 0.316216;
  sum += texture2D(uTex, vUv + d * 3.2308).rgb * 0.070270;
  sum += texture2D(uTex, vUv - d * 3.2308).rgb * 0.070270;
  gl_FragColor = vec4(sum, 1.0);
}
`;

// Composite: base scene + additive bloom. A whisper of highlight softening on
// the SUM only (not the base) rolls off the very brightest cores so heavy bloom
// blooms cleanly instead of forming hard white discs.
const compositeFrag = /* glsl */`
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uStrength;
varying vec2 vUv;
void main() {
  vec3 base = texture2D(uScene, vUv).rgb;
  vec3 bloom = texture2D(uBloom, vUv).rgb * uStrength;
  vec3 col = base + bloom;
  // gentle highlight rolloff (Reinhard-ish) only where the sum exceeds 1
  col = mix(col, col / (1.0 + max(col - 1.0, 0.0)), 0.35);
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createPost(renderer, opts = {}) {
  const strength = opts.strength ?? 0.9;
  const threshold = opts.threshold ?? 0.62;
  const knee = opts.knee ?? 0.18;

  let tier = QUALITY[opts.quality] || QUALITY.high;
  let enabled = true;

  const rtOpts = {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
  };
  // sceneRT holds final sRGB pixels (same as the canvas would show), so the
  // composite can pass them through untouched. Multisampled (WebGL2) so bloom
  // doesn't cost us the anti-aliasing the direct-to-canvas path had.
  const sceneRT = new THREE.WebGLRenderTarget(2, 2, { ...rtOpts, samples: 4 });
  sceneRT.texture.colorSpace = THREE.SRGBColorSpace;
  // Bloom ping-pong targets (no depth).
  const rtA = new THREE.WebGLRenderTarget(2, 2, { ...rtOpts, depthBuffer: false });
  const rtB = new THREE.WebGLRenderTarget(2, 2, { ...rtOpts, depthBuffer: false });

  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadScene = new THREE.Scene();
  const quad = new THREE.Mesh(quadGeo, null);
  quad.frustumCulled = false;
  quadScene.add(quad);

  const brightMat = new THREE.ShaderMaterial({
    vertexShader: fullscreenVert, fragmentShader: brightFrag,
    uniforms: {
      uScene: { value: sceneRT.texture },
      uThreshold: { value: threshold },
      uKnee: { value: knee },
    },
    depthTest: false, depthWrite: false,
  });
  const blurMat = new THREE.ShaderMaterial({
    vertexShader: fullscreenVert, fragmentShader: blurFrag,
    uniforms: { uTex: { value: null }, uDirection: { value: new THREE.Vector2() } },
    depthTest: false, depthWrite: false,
  });
  const compositeMat = new THREE.ShaderMaterial({
    vertexShader: fullscreenVert, fragmentShader: compositeFrag,
    uniforms: {
      uScene: { value: sceneRT.texture },
      uBloom: { value: rtA.texture },
      uStrength: { value: strength },
    },
    depthTest: false, depthWrite: false,
  });

  const _size = new THREE.Vector2();
  let fullW = 2, fullH = 2, halfW = 1, halfH = 1;

  function setSize() {
    renderer.getDrawingBufferSize(_size);
    fullW = Math.max(2, _size.x | 0);
    fullH = Math.max(2, _size.y | 0);
    halfW = Math.max(1, (fullW * 0.5) | 0);
    halfH = Math.max(1, (fullH * 0.5) | 0);
    sceneRT.setSize(fullW, fullH);
    rtA.setSize(halfW, halfH);
    rtB.setSize(halfW, halfH);
  }
  setSize();

  function drawQuad(mat, target) {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, cam);
  }

  function render(scene, camera) {
    if (!enabled) {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;

    // 1) scene -> sceneRT (identical pixels to a direct canvas render)
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);

    // 2) bright pass -> rtA (half res)
    drawQuad(brightMat, rtA);

    // 3) separable blur, ping-ponging rtA <-> rtB
    const stepX = 1 / halfW, stepY = 1 / halfH;
    for (let i = 0; i < tier.blurPasses; i++) {
      blurMat.uniforms.uTex.value = rtA.texture;
      blurMat.uniforms.uDirection.value.set(stepX, 0);
      drawQuad(blurMat, rtB);
      blurMat.uniforms.uTex.value = rtB.texture;
      blurMat.uniforms.uDirection.value.set(0, stepY);
      drawQuad(blurMat, rtA);
    }

    // 4) composite base + bloom -> canvas
    compositeMat.uniforms.uBloom.value = rtA.texture;
    renderer.setRenderTarget(null);
    quad.material = compositeMat;
    renderer.render(quadScene, cam);

    renderer.autoClear = prevAutoClear;
  }

  function setQuality(name) {
    tier = QUALITY[name] || QUALITY.high;
  }
  function setEnabled(v) { enabled = !!v; }
  function setStrength(v) { compositeMat.uniforms.uStrength.value = v; }

  function dispose() {
    sceneRT.dispose(); rtA.dispose(); rtB.dispose();
    quadGeo.dispose();
    brightMat.dispose(); blurMat.dispose(); compositeMat.dispose();
  }

  return {
    render, setSize, setQuality, setEnabled, setStrength, dispose,
    get enabled() { return enabled; },
  };
}
