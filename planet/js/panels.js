// Shared builder for a framed art panel — used by billboards, the self-work
// monoliths, story easels, book lecterns, the collect stand, and the gallery
// walls. Returns a group with the artwork plane (unlit so paintings read at an
// even brightness), a thin emissive gold frame, and a dark backing. onSize(w,h)
// rescales everything to the artwork's true aspect ratio once the texture's
// pixel size is known (called by the texture manager).

import * as THREE from 'three';

const _frameMat = new THREE.MeshBasicMaterial({ color: 0xf5b642 });
const _backMat = new THREE.MeshBasicMaterial({ color: 0x0b0b12, side: THREE.DoubleSide });

// opts: { maxW, maxH, frameW (border thickness, world units), double }
export function makeArtPanel(opts = {}) {
  const maxW = opts.maxW || 6;
  const maxH = opts.maxH || 6;
  const frameW = opts.frameW ?? 0.18;

  const group = new THREE.Group();

  const artMat = new THREE.MeshBasicMaterial({
    color: 0xe8e8e8, // slight knock-down so bright paintings never clip
    side: opts.double ? THREE.DoubleSide : THREE.FrontSide,
    toneMapped: false,
  });
  const art = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), artMat);
  art.position.z = 0.03;

  const frame = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), _frameMat);
  frame.position.z = 0.01;

  const back = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), _backMat);
  back.position.z = 0;

  group.add(back, frame, art);

  // Default to a square so the panel is visible before the texture arrives.
  let curAspect = 1;
  function layout(aspect) {
    curAspect = aspect;
    let w, h;
    if (maxW / maxH > aspect) { h = maxH; w = maxH * aspect; }
    else { w = maxW; h = maxW / aspect; }
    art.scale.set(w, h, 1);
    frame.scale.set(w + frameW * 2, h + frameW * 2, 1);
    back.scale.set(w + frameW * 2.4, h + frameW * 2.4, 1);
    group.userData.artW = w;
    group.userData.artH = h;
  }
  layout(1);

  return {
    group, art, frame,
    onSize: (w, h) => layout(w / h),
    get width() { return group.userData.artW; },
    get height() { return group.userData.artH; },
  };
}

// A simple emissive beacon column — a landmark visible over the terrain,
// tinted gold. Built cheaply from a cylinder; the tip glows.
export function makeBeacon(height = 26, color = 0xf5b642) {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, toneMapped: false });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, height, 8, 1, true), mat);
  shaft.position.y = height / 2;
  group.add(shaft);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(1.6, 12, 8),
    new THREE.MeshBasicMaterial({ color, toneMapped: false }));
  tip.position.y = height;
  group.add(tip);
  return group;
}
