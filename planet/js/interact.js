// Interactable registry + the per-frame "nearest thing in range" scan that
// drives the E-prompt. Each interactable is { pos:Vector3, radius, prompt,
// action }. The nearest one whose distance < radius shows its prompt; pressing
// E runs its action. Also supports a center-screen raycast mode for the
// gallery paintings (many close panels where proximity alone is ambiguous).

import * as THREE from 'three';

const items = [];
let focus = null;
const _p = new THREE.Vector3();

// Raycast targets: { mesh, action, prompt }. Checked against a ray from the
// camera center; the nearest hit within maxDist wins over proximity items.
const rayTargets = [];
const raycaster = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();

export function clearInteractables() { items.length = 0; rayTargets.length = 0; focus = null; }

export function addInteractable(it) { items.push(it); return it; }
export function addRayTarget(t) { rayTargets.push(t); return t; }
export function removeRayTargetsByTag(tag) {
  for (let i = rayTargets.length - 1; i >= 0; i--) if (rayTargets[i].tag === tag) rayTargets.splice(i, 1);
}

// Called each frame with the camera world position + look direction.
// Returns the focused interactable (or null) so the HUD can show its prompt.
export function updateInteract(camPos, lookDir, rayMaxDist = 7) {
  focus = null;
  let bestD = Infinity;

  // proximity items
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const d = _p.copy(it.pos).distanceTo(camPos);
    if (d < it.radius && d < bestD) { bestD = d; focus = it; }
  }

  // raycast items (gallery paintings) — take precedence when aimed at
  if (rayTargets.length && lookDir) {
    _origin.copy(camPos);
    _dir.copy(lookDir).normalize();
    raycaster.set(_origin, _dir);
    raycaster.far = rayMaxDist;
    const meshes = rayTargets.map((t) => t.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length) {
      const t = rayTargets.find((rt) => rt.mesh === hits[0].object);
      if (t) focus = { prompt: t.prompt, action: t.action, pos: hits[0].point, radius: rayMaxDist };
    }
  }

  return focus;
}

export function fireInteract() {
  if (focus && focus.action) focus.action();
}

export function currentFocus() { return focus; }
