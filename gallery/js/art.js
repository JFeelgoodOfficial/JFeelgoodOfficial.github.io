// Hanging the paintings. Each work is an unlit plane (so it reads at the
// artist's true colours) in a floater frame; all frames share one
// InstancedMesh. Textures stream by proximity through textures.js, and the
// frame instance is re-fitted to the true aspect ratio the moment the image
// size is known.
//
// Colour fidelity: the picture is tone-mapped with the Khronos "neutral"
// curve, which is identity below 0.76 and compresses above. Paintings must not
// be compressed, so their shader applies the inverse of that curve before
// output — after tone mapping they land back on the original pixel values. The
// inversion is unconditional: with bloom on, the scene is drawn into a linear
// render target (where three.js compiles tone mapping out) and post.js applies
// the same curve at composite time, so both paths need it.
// The paintings also write alpha 0 into the HDR buffer, which the bloom's
// bright pass reads as "never glow" (post.js), so a white canvas stays white.

import * as THREE from 'three';
import { C } from './config.js';
import { makeTextureManager } from './textures.js';
import { addRayTarget } from './interact.js';
import { showViewer, showCard } from './hud.js';

const INV_NEUTRAL = /* glsl */`
// inverse of three.js NeutralToneMapping (exposure folded in by the caller)
vec3 invNeutral(vec3 c) {
  const float startCompression = 0.76;
  const float d = 0.24;
  float peak = max(c.r, max(c.g, c.b));
  vec3 y = c;
  if (peak > startCompression) {
    float t = min(peak, 0.992);
    float p = d * d / (1.0 - t) - d + startCompression;
    y = c * (p / max(peak, 1e-4));
  }
  float m = min(y.r, min(y.g, y.b));
  float offset = m < 0.04 ? (0.4 * sqrt(max(m, 0.0)) - m) : 0.04;
  return y + offset;
}
`;

export function createArt(scene, mats, renderer, opts = {}) {
  const quality = opts.quality || 'high';
  // shared by every painting shader: the exposure the final tone map will use
  const artExposure = { value: renderer.toneMappingExposure };
  const tm = makeTextureManager(renderer, { maxResident: quality === 'low' ? 28 : 64, hz: 4 });

  const MAX = 260;
  const frameGeo = new THREE.BoxGeometry(1, 1, 1);
  const frames = new THREE.InstancedMesh(frameGeo, mats.frame, MAX);
  frames.count = 0;
  frames.castShadow = false;
  frames.receiveShadow = true;
  frames.frustumCulled = false;
  scene.add(frames);

  const artGeo = new THREE.PlaneGeometry(1, 1);
  const entries = [];
  const _m = new THREE.Matrix4(), _s = new THREE.Vector3();

  function makeArtMaterial() {
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uArtExposure = artExposure;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uArtExposure;\n' + INV_NEUTRAL)
        .replace('#include <opaque_fragment>', /* glsl */`
          outgoingLight = invNeutral(outgoingLight) / uArtExposure;
          #include <opaque_fragment>
          gl_FragColor.a = 0.0; // bloom mask: paintings never glow`);
    };
    return m;
  }

  // slot: { x, y, z, yaw }  yaw: normal = (sin yaw, 0, cos yaw)
  // work: { title, thumb|img, full, meta, body, kicker, actions }
  function hang(slot, work, o = {}) {
    if (frames.count >= MAX) return null;
    const maxDim = o.maxDim || C.ART_MAX;
    const border = o.border ?? 0.05;
    const depth = o.depth ?? 0.07;
    const n = new THREE.Vector3(Math.sin(slot.yaw), 0, Math.cos(slot.yaw));
    const pos = new THREE.Vector3(slot.x, slot.y ?? C.HANG_Y, slot.z).addScaledVector(n, depth / 2);

    const group = new THREE.Group();
    group.position.copy(pos);
    group.rotation.y = slot.yaw;
    const art = new THREE.Mesh(artGeo, makeArtMaterial());
    art.position.z = depth / 2 + 0.002;
    group.add(art);
    scene.add(group);

    const idx = frames.count++;
    const e = { group, art, work, pos, n, idx, maxDim, border, depth, w: maxDim * 0.75, h: maxDim * 0.75 };
    const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, slot.yaw, 0));

    function layout(w, h) {
      e.w = w; e.h = h;
      art.scale.set(w, h, 1);
      _s.set(w + border * 2, h + border * 2, depth);
      _m.compose(pos, rot, _s);
      frames.setMatrixAt(idx, _m);
      frames.instanceMatrix.needsUpdate = true;
      if (e.plaque) e.plaque.position.set(w / 2 + 0.35, -(h / 2) + 0.2, 0.01);
    }
    layout(e.w, e.h);

    tm.register({
      mesh: art, url: work.thumb || work.img, worldPos: pos,
      loadDist: o.loadDist || 34, keepDist: o.keepDist || 50, maxDim: 0, anisotropy: 8,
      onSize: (pw, ph) => {
        const aspect = pw / ph;
        let w, h;
        if (aspect >= 1) { w = maxDim; h = maxDim / aspect; } else { h = maxDim; w = maxDim * aspect; }
        if (o.maxH && h > o.maxH) { const k = o.maxH / h; h *= k; w *= k; }
        layout(w, h);
      },
    });

    addRayTarget({
      mesh: art, tag: o.tag || 'art',
      prompt: `<b>E</b> — ${work.title}`,
      action: () => {
        if (o.card) {
          showCard({
            kicker: work.kicker || o.kicker, title: work.title, meta: work.meta, body: work.body,
            img: work.img || work.full, alt: work.alt,
            actions: work.actions || (work.buyUrl ? [{ label: work.buyLabel || 'Own it as a card — $23', href: work.buyUrl }] : []),
          });
        } else {
          showViewer({ full: work.full || work.img, title: work.title, href: work.full || work.img });
        }
      },
    });

    if (o.plaque) {
      const pl = makePlaque(work.title, work.meta || '', mats);
      pl.position.set(e.w / 2 + 0.35, -(e.h / 2) + 0.2, 0.01);
      group.add(pl);
      e.plaque = pl;
    }
    entries.push(e);
    return e;
  }

  return {
    hang, entries, frames,
    setExposure: (v) => { artExposure.value = v; },
    update: (camPos, now) => tm.update(camPos, now),
  };
}

// A small wall label: title in serif, one line of meta below.
export function makePlaque(title, meta, mats) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 160;
  const c = cv.getContext('2d');
  c.fillStyle = '#f4f1ea';
  c.fillRect(0, 0, 512, 160);
  c.fillStyle = '#1a1614';
  c.font = '500 40px "Cormorant Garamond", Georgia, serif';
  c.textBaseline = 'top';
  c.fillText(fit(c, title, 470), 24, 30);
  c.fillStyle = '#6a625a';
  c.font = '300 22px "DM Sans", system-ui, sans-serif';
  c.fillText(fit(c, meta, 470), 24, 92);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.13), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75 }));
  return m;
}

function fit(ctx, text, maxW) {
  let t = String(text);
  while (t.length > 3 && ctx.measureText(t).width > maxW) t = t.slice(0, -2);
  return t.length < String(text).length ? t.replace(/\s+$/, '') + '…' : t;
}

// Large wall lettering, transparent background, for room names and signage.
export function makeLettering(text, opts = {}) {
  const size = opts.size || 1.0; // world height of the text block
  const cv = document.createElement('canvas');
  cv.width = 2048; cv.height = 256;
  const c = cv.getContext('2d');
  c.clearRect(0, 0, cv.width, cv.height);
  c.fillStyle = opts.color || '#1a1614';
  c.font = `${opts.weight || 300} ${opts.px || 150}px ${opts.font || '"Cormorant Garamond", Georgia, serif'}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  if (opts.tracking) {
    // manual letter-spacing
    const chars = [...text];
    const widths = chars.map((ch) => c.measureText(ch).width);
    const total = widths.reduce((a, b) => a + b, 0) + opts.tracking * (chars.length - 1);
    let x = 1024 - total / 2;
    for (let i = 0; i < chars.length; i++) { c.textAlign = 'left'; c.fillText(chars[i], x, 128); x += widths[i] + opts.tracking; }
  } else {
    c.fillText(text, 1024, 128);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.6, alphaTest: 0.02 });
  if (opts.emissive) { mat.emissive = new THREE.Color(opts.emissive); mat.emissiveMap = tex; mat.emissiveIntensity = opts.emissiveIntensity || 1; }
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size * 8, size), mat);
  return mesh;
}
