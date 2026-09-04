// Planar reflection for the polished floor. Each frame the scene is rendered
// once more from a camera mirrored through the floor plane (y = 0), with the
// near plane made oblique so nothing below the floor leaks in — the standard
// Reflector technique, ported onto a MeshStandardMaterial so the floor keeps
// its PBR lighting, shadows and normal-mapped grain. The reflection texture is
// blended in by Fresnel and blurred by the material's roughness through a
// mipmap LOD bias, which is what makes it read as concrete rather than a
// mirror. Half-float, linear; sampled at half resolution.

import * as THREE from 'three';

export function createReflector(renderer, scene, opts = {}) {
  const y = opts.y ?? 0;
  const scale = opts.scale ?? 0.5;
  const clipBias = 0.003;

  const rt = new THREE.WebGLRenderTarget(2, 2, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: true,
    stencilBuffer: false,
  });
  rt.texture.colorSpace = THREE.LinearSRGBColorSpace;

  const virtualCamera = new THREE.PerspectiveCamera();
  const textureMatrix = new THREE.Matrix4();
  const reflectorPlane = new THREE.Plane();
  const normal = new THREE.Vector3(0, 1, 0);
  const reflectorWorldPosition = new THREE.Vector3(0, y, 0);
  const cameraWorldPosition = new THREE.Vector3();
  const rotationMatrix = new THREE.Matrix4();
  const lookAtPosition = new THREE.Vector3();
  const clipPlane = new THREE.Vector4();
  const view = new THREE.Vector3();
  const target = new THREE.Vector3();
  const q = new THREE.Vector4();
  const _size = new THREE.Vector2();

  const hidden = []; // objects excluded from the reflection pass (the floors themselves)
  let enabled = true;

  function setSize() {
    renderer.getDrawingBufferSize(_size);
    rt.setSize(Math.max(2, (_size.x * scale) | 0), Math.max(2, (_size.y * scale) | 0));
  }
  setSize();

  function update(camera) {
    if (!enabled) return;
    camera.getWorldPosition(cameraWorldPosition);
    view.subVectors(reflectorWorldPosition, cameraWorldPosition);
    if (view.dot(normal) > 0) return; // camera under the floor: nothing to see
    view.reflect(normal).negate().add(reflectorWorldPosition);

    rotationMatrix.extractRotation(camera.matrixWorld);
    lookAtPosition.set(0, 0, -1).applyMatrix4(rotationMatrix).add(cameraWorldPosition);
    target.subVectors(reflectorWorldPosition, lookAtPosition).reflect(normal).negate().add(reflectorWorldPosition);

    virtualCamera.position.copy(view);
    virtualCamera.up.set(0, 1, 0).applyMatrix4(rotationMatrix).reflect(normal);
    virtualCamera.lookAt(target);
    virtualCamera.far = camera.far;
    virtualCamera.updateMatrixWorld();
    virtualCamera.projectionMatrix.copy(camera.projectionMatrix);

    textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    textureMatrix.multiply(virtualCamera.projectionMatrix);
    textureMatrix.multiply(virtualCamera.matrixWorldInverse);

    reflectorPlane.setFromNormalAndCoplanarPoint(normal, reflectorWorldPosition);
    reflectorPlane.applyMatrix4(virtualCamera.matrixWorldInverse);
    clipPlane.set(reflectorPlane.normal.x, reflectorPlane.normal.y, reflectorPlane.normal.z, reflectorPlane.constant);
    const p = virtualCamera.projectionMatrix;
    q.x = (Math.sign(clipPlane.x) + p.elements[8]) / p.elements[0];
    q.y = (Math.sign(clipPlane.y) + p.elements[9]) / p.elements[5];
    q.z = -1.0;
    q.w = (1.0 + p.elements[10]) / p.elements[14];
    clipPlane.multiplyScalar(2.0 / clipPlane.dot(q));
    p.elements[2] = clipPlane.x;
    p.elements[6] = clipPlane.y;
    p.elements[10] = clipPlane.z + 1.0 - clipBias;
    p.elements[14] = clipPlane.w;

    for (const o of hidden) o.visible = false;
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.state.buffers.depth.setMask(true);
    if (renderer.autoClear === false) renderer.clear();
    renderer.render(scene, virtualCamera);
    renderer.setRenderTarget(prevTarget);
    for (const o of hidden) o.visible = true;
  }

  // Inject the reflection into a MeshStandardMaterial. Call once per material.
  function attach(material, strength = 0.85) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.tReflect = { value: rt.texture };
      shader.uniforms.uReflectMatrix = { value: textureMatrix };
      shader.uniforms.uReflectStrength = { value: strength };
      shader.uniforms.uReflectOn = { value: enabled ? 1 : 0 };
      material.userData.shader = shader;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform mat4 uReflectMatrix;\nvarying vec4 vReflectUv;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n{ vec4 wp4 = modelMatrix * vec4(transformed, 1.0); vReflectUv = uReflectMatrix * wp4; }');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D tReflect;\nuniform float uReflectStrength;\nuniform float uReflectOn;\nvarying vec4 vReflectUv;')
        .replace('#include <opaque_fragment>', /* glsl */`
        if (uReflectOn > 0.5) {
          vec2 ruv = vReflectUv.xy / vReflectUv.w;
          // the surface normal (with its map) wobbles the lookup a little
          ruv += normal.xz * 0.012;
          float rough = roughnessFactor;
          float lod = rough * 7.0;
          vec3 refl = texture2D(tReflect, ruv, lod).rgb;
          vec3 V = normalize(vViewPosition);
          float NdV = max(dot(normal, V), 0.0);
          float F = 0.03 + 0.97 * pow(1.0 - NdV, 5.0);
          float k = uReflectStrength * (1.0 - rough * 0.7) * F;
          outgoingLight = mix(outgoingLight, refl, clamp(k, 0.0, 1.0));
        }
        #include <opaque_fragment>`);
    };
    material.needsUpdate = true;
  }

  function setEnabled(v) {
    enabled = !!v;
    // materials compiled earlier pick the flag up through their uniform
    for (const m of attachedMaterials) if (m.userData.shader) m.userData.shader.uniforms.uReflectOn.value = enabled ? 1 : 0;
    if (!enabled) rt.setSize(2, 2); else setSize();
  }
  const attachedMaterials = [];
  const attachTracked = (m, s) => { attachedMaterials.push(m); attach(m, s); };

  return {
    update, setSize, setEnabled,
    attach: attachTracked,
    exclude: (obj) => hidden.push(obj),
    get enabled() { return enabled; },
    texture: rt.texture,
  };
}
