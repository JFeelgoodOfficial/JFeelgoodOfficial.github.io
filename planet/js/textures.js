// Proximity texture manager. The archive gallery hangs 186 paintings; loading
// every 700px WebP at once would cost ~700 MB of VRAM, so panels load their
// texture only when the camera is near and dispose it when far, with a hard
// cap on how many stay resident. Generalizes the game's galleryTexture cache
// (stations.js). Also downscales oversized art (opt/ 1200px) to a max
// dimension via a canvas.
//
// Each panel is a { mesh, url, worldPos, loadDist, keepDist, maxDim,
// anisotropy, onSize } record. onSize(w, h) is called once the real pixel size
// is known so the caller can scale its unit plane to the true aspect ratio.

import * as THREE from 'three';

// Shared placeholder: a dark gold-flecked square shown before load / after
// eviction. Built once, never disposed.
let PLACEHOLDER = null;
function placeholder() {
  if (PLACEHOLDER) return PLACEHOLDER;
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  const g = c.getContext('2d');
  g.fillStyle = '#171019';
  g.fillRect(0, 0, 8, 8);
  PLACEHOLDER = new THREE.CanvasTexture(c);
  PLACEHOLDER.colorSpace = THREE.SRGBColorSpace;
  return PLACEHOLDER;
}

export function makeTextureManager(renderer, opts = {}) {
  const maxResident = opts.maxResident || 48;
  const intervalMs = 1000 / (opts.hz || 4);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const panels = [];
  const resident = new Set(); // panels with a live texture
  let lastScan = -1e9;
  const _p = new THREE.Vector3();

  function register(panel) {
    panel._tex = null;
    panel._loading = false;
    panel._sized = false;
    panel.mesh.material.map = placeholder();
    panel.mesh.material.needsUpdate = true;
    panels.push(panel);
    return panel;
  }

  function applyTexture(panel, tex) {
    panel._tex = tex;
    panel.mesh.material.map = tex;
    panel.mesh.material.needsUpdate = true;
    resident.add(panel);
  }

  function load(panel) {
    if (panel._loading || panel._tex) return;
    panel._loading = true;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      panel._loading = false;
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!panel._sized && panel.onSize) { panel.onSize(w, h); panel._sized = true; }
      let tex;
      const maxDim = panel.maxDim || 0;
      const big = maxDim && Math.max(w, h) > maxDim;
      if (big) {
        const s = maxDim / Math.max(w, h);
        const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
        const cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        cv.getContext('2d').drawImage(img, 0, 0, cw, ch);
        tex = new THREE.CanvasTexture(cv);
      } else {
        tex = new THREE.Texture(img);
        tex.needsUpdate = true;
      }
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(panel.anisotropy || 8, maxAniso);
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      // if the panel was evicted while loading, drop it
      applyTexture(panel, tex);
    };
    img.onerror = () => { panel._loading = false; };
    img.src = panel.url;
  }

  function evict(panel) {
    if (panel._tex) { panel._tex.dispose(); panel._tex = null; }
    panel.mesh.material.map = placeholder();
    panel.mesh.material.needsUpdate = true;
    resident.delete(panel);
  }

  // Called each frame; throttled internally. camPos is a THREE.Vector3.
  function update(camPos, now) {
    if (now - lastScan < intervalMs) return;
    lastScan = now;
    // distance for every panel
    for (let i = 0; i < panels.length; i++) {
      const pn = panels[i];
      pn._d = _p.copy(pn.worldPos).distanceTo(camPos);
    }
    // load near panels
    for (let i = 0; i < panels.length; i++) {
      const pn = panels[i];
      if (!pn._tex && !pn._loading && pn._d < pn.loadDist) load(pn);
      else if (pn._tex && pn._d > pn.keepDist) evict(pn);
    }
    // enforce the resident cap: drop the farthest over the limit
    if (resident.size > maxResident) {
      const arr = [...resident].sort((a, b) => b._d - a._d);
      for (let i = 0; i < arr.length && resident.size > maxResident; i++) evict(arr[i]);
    }
  }

  function disposeAll() {
    for (const pn of [...resident]) evict(pn);
    panels.length = 0;
    resident.clear();
  }

  return {
    register, update, disposeAll,
    get count() { return resident.size; },
  };
}
