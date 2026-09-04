// A small, fixed pool of point lights that follows the visitor.
//
// Why this exists: three.js expands `#pragma unroll_loop_start` on the JS
// side, so every point light in the scene becomes another literal copy of the
// GGX evaluation inside every lit fragment shader. The gallery has dozens of
// ceiling fixtures; putting them all in the scene compiled a ~2100-line
// fragment shader with 23 unrolled RE_Direct calls, which mobile drivers
// refuse to link — and a failed program means every MeshStandardMaterial in
// the building silently draws nothing. The room went black while the paintings
// (unlit MeshBasicMaterial) kept showing.
//
// So the fixtures are plain data. The scene holds POOL lights and no more, and
// each frame the pool is pointed at the fixtures that actually reach the
// visitor. NUM_POINT_LIGHTS never changes, so the lit shaders compile once,
// stay small, and never recompile mid-walk.
//
// Ranking is by the same windowed inverse-square falloff the shader uses, so
// the fixtures the pool drops are always the faintest ones reaching the
// visitor — in a wing, the pair two rows further off, worth under a thousandth
// of the light in the room. A fixture past its own range contributes exactly
// nothing and its slot is re-aimed on the spot; one still in range but
// outranked fades out first, so a swap can't pop.

import * as THREE from 'three';

const FADE = 9;         // intensity lerp rate, per second
const SWAP_EPS = 0.06;  // a slot may take a new fixture once this dim

// three.js' own windowed inverse-square falloff, so the ranking agrees with
// what the shader will actually compute.
function contribution(fx, dsq) {
  const d = Math.sqrt(dsq);
  if (d >= fx.range) return 0;
  const t = (d / fx.range) * (d / fx.range);
  const w = 1 - t * t;
  return (fx.intensity * w * w) / Math.max(dsq, 0.25);
}

export function createLightPool(scene, fixtures, opts = {}) {
  const slots = [];
  const ranked = fixtures.map((fx) => ({ fx, score: 0 }));
  const desired = [];
  let size = 0;

  function setSize(n) {
    n = Math.max(0, Math.min(n, fixtures.length));
    while (slots.length < n) {
      const light = new THREE.PointLight(0xffffff, 0, 1, 2);
      light.castShadow = false;
      light.visible = false;
      scene.add(light);
      slots.push({ light, fx: null, intensity: 0 });
    }
    // Shrinking hides the extra slots rather than removing them: an invisible
    // light is out of the lights state, which is what shrinks the shader.
    for (let i = 0; i < slots.length; i++) {
      if (i >= n) { slots[i].fx = null; slots[i].intensity = 0; slots[i].light.intensity = 0; }
      slots[i].light.visible = i < n;
    }
    size = n;
  }
  setSize(opts.size ?? 4);

  function aim(slot, fx) {
    slot.fx = fx;
    slot.light.position.set(fx.x, fx.y, fx.z);
    slot.light.color.set(fx.color);
    slot.light.distance = fx.range;
    slot.light.decay = 2;
  }

  function update(pos, dt) {
    if (!size) return;
    for (const r of ranked) {
      const dx = r.fx.x - pos.x, dy = r.fx.y - pos.y, dz = r.fx.z - pos.z;
      // the score is parked on the fixture too, so the swap test below can read
      // it without building a lookup every frame
      r.fx._score = r.score = contribution(r.fx, dx * dx + dy * dy + dz * dz);
    }
    ranked.sort((a, b) => b.score - a.score);

    desired.length = 0;
    for (let i = 0; i < size && ranked[i].score > 0; i++) desired.push(ranked[i].fx);

    // A slot keeps the fixture it already holds for as long as that fixture is
    // still wanted, so walking a corridor moves one slot at a time.
    const held = new Set();
    for (const s of slots) if (s.fx && desired.includes(s.fx)) held.add(s.fx);
    let take = 0;
    const free = desired.filter((fx) => !held.has(fx));

    const k = Math.min(size, slots.length);
    for (let i = 0; i < k; i++) {
      const s = slots[i];
      let target;
      if (s.fx && held.has(s.fx)) {
        target = s.fx.intensity;
      // A fixture that has left its own range is contributing nothing on screen
      // whatever this slot's intensity says, so that slot can be re-aimed on the
      // spot. Waiting out the fade there would leave the light coming up ahead
      // of the visitor unlit for the best part of a second. A fixture still in
      // range but outranked has to fade first, or it pops out.
      } else if ((s.intensity <= SWAP_EPS || !s.fx || s.fx._score === 0) && take < free.length) {
        aim(s, free[take++]);
        target = s.fx.intensity;
      } else {
        target = 0; // fade out, then this slot is free to be re-aimed
      }
      s.intensity = THREE.MathUtils.damp(s.intensity, target, FADE, dt);
      if (s.intensity < 1e-3) { s.intensity = 0; if (target === 0) s.fx = null; }
      s.light.intensity = s.intensity;
    }
  }

  // Emergency ladder: if a lit program fails to compile on this device, drop
  // the pool (6 → 3 → 1 → 0). Fewer lights means a smaller shader, and at 0 the
  // caller lifts the ambient so the rooms still read.
  function degrade() {
    const next = size > 3 ? 3 : size > 1 ? 1 : 0;
    setSize(next);
    return next;
  }

  return { update, degrade, setSize, get size() { return size; }, slots };
}
