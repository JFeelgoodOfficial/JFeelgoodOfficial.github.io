// post.js — HDR bloom pipeline in core Three.js (no addons).
//
// The scene is rendered into a half-float, linear render target; three.js
// applies neither tone mapping nor the sRGB transfer when the target is a
// texture, so the buffer holds true scene-linear radiance. A soft-knee bright
// pass, a separable Gaussian ping-pong at half resolution, then a composite
// that adds the bloom and only THEN tone-maps (the renderer's Khronos neutral
// curve and exposure, via <tonemapping_fragment>) and converts to sRGB.
// Disabled, render() draws straight to the canvas and the renderer tone-maps as
// usual, so both paths grade identically — bloom just glows on top.
//
// The bright pass multiplies its weight by the scene buffer's alpha, which is
// the paintings' opt-out: art.js writes alpha 0 so a white canvas never glows.

import * as THREE from 'three';

const QUALITY = {
  high: { blurPasses: 3 },
  medium: { blurPasses: 2 },
  low: { blurPasses: 1 },
};

const fullscreenVert = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const brightFrag = /* glsl */`
precision highp float;
uniform sampler2D uScene;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
void main() {
  vec4 src = texture2D(uScene, vUv);
  vec3 c = src.rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float soft = clamp((l - uThreshold + uKnee) / (2.0 * uKnee), 0.0, 1.0);
  float w = max(soft * soft, step(uThreshold, l));
  w *= src.a; // alpha is the bloom mask: paintings (alpha 0) never glow
  // clamp runaway values (the sun disc) so one pixel can't flood the blur
  gl_FragColor = vec4(min(c * w, vec3(40.0)), 1.0);
}
`;

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

const compositeFrag = /* glsl */`
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uStrength;
varying vec2 vUv;
void main() {
  vec3 base = texture2D(uScene, vUv).rgb;
  vec3 bloom = texture2D(uBloom, vUv).rgb * uStrength;
  gl_FragColor = vec4(base + bloom, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createPost(renderer, opts = {}) {
  const strength = opts.strength ?? 0.5;
  const threshold = opts.threshold ?? 1.0;
  const knee = opts.knee ?? 0.4;

  let tier = QUALITY[opts.quality] || QUALITY.high;
  let enabled = true;

  const linear = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType, stencilBuffer: false };
  const sceneRT = new THREE.WebGLRenderTarget(2, 2, { ...linear, depthBuffer: true, samples: 4 });
  sceneRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
  const rtA = new THREE.WebGLRenderTarget(2, 2, { ...linear, depthBuffer: false });
  const rtB = new THREE.WebGLRenderTarget(2, 2, { ...linear, depthBuffer: false });

  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadScene = new THREE.Scene();
  const quad = new THREE.Mesh(quadGeo, null);
  quad.frustumCulled = false;
  quadScene.add(quad);

  const brightMat = new THREE.ShaderMaterial({
    vertexShader: fullscreenVert, fragmentShader: brightFrag,
    uniforms: { uScene: { value: sceneRT.texture }, uThreshold: { value: threshold }, uKnee: { value: knee } },
    depthTest: false, depthWrite: false, toneMapped: false,
  });
  const blurMat = new THREE.ShaderMaterial({
    vertexShader: fullscreenVert, fragmentShader: blurFrag,
    uniforms: { uTex: { value: null }, uDirection: { value: new THREE.Vector2() } },
    depthTest: false, depthWrite: false, toneMapped: false,
  });
  const compositeMat = new THREE.ShaderMaterial({
    vertexShader: fullscreenVert, fragmentShader: compositeFrag,
    uniforms: { uScene: { value: sceneRT.texture }, uBloom: { value: rtA.texture }, uStrength: { value: strength } },
    depthTest: false, depthWrite: false, toneMapped: true,
  });

  const _size = new THREE.Vector2();
  let halfW = 1, halfH = 1;

  function setSize() {
    if (!enabled) { sceneRT.setSize(2, 2); rtA.setSize(2, 2); rtB.setSize(2, 2); halfW = halfH = 1; return; }
    renderer.getDrawingBufferSize(_size);
    const fullW = Math.max(2, _size.x | 0), fullH = Math.max(2, _size.y | 0);
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
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);

    drawQuad(brightMat, rtA);
    const stepX = 1 / halfW, stepY = 1 / halfH;
    for (let i = 0; i < tier.blurPasses; i++) {
      blurMat.uniforms.uTex.value = rtA.texture;
      blurMat.uniforms.uDirection.value.set(stepX * (1 + i * 0.6), 0);
      drawQuad(blurMat, rtB);
      blurMat.uniforms.uTex.value = rtB.texture;
      blurMat.uniforms.uDirection.value.set(0, stepY * (1 + i * 0.6));
      drawQuad(blurMat, rtA);
    }
    compositeMat.uniforms.uBloom.value = rtA.texture;
    renderer.setRenderTarget(null);
    quad.material = compositeMat;
    renderer.render(quadScene, cam);
  }

  function setQuality(name) { tier = QUALITY[name] || QUALITY.high; }
  function setEnabled(v) { const was = enabled; enabled = !!v; if (enabled !== was) setSize(); }
  function setStrength(v) { compositeMat.uniforms.uStrength.value = v; }
  function dispose() {
    sceneRT.dispose(); rtA.dispose(); rtB.dispose(); quadGeo.dispose();
    brightMat.dispose(); blurMat.dispose(); compositeMat.dispose();
  }

  return { render, setSize, setQuality, setEnabled, setStrength, dispose, get enabled() { return enabled; } };
}
