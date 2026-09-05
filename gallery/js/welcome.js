// The word WELCOME, floating in the air in front of the visitor for the first
// fifteen seconds of a visit, then gone. One small unlit plane per letter, so
// the letters drift independently and never depend on the lighting ladder
// (world.js) — a MeshBasicMaterial compiles on anything that has WebGL2.
//
// Placement is relative to wherever the visitor actually starts and faces, not
// to the spawn point in config.js, so a ?debug=at: jump still gets its welcome.

import * as THREE from 'three';

const TEXT = 'WELCOME';
const LIFE = 15;        // seconds on screen, fade-out included
const FADE_IN = 1.2;
const FADE_OUT = 2.5;
const STAGGER = 0.12;   // each letter fades in this much later than the last
const DIST = 5.5;       // metres ahead of the visitor
const RISE = 0.9;       // metres above eye level
const GAP = 0.62;       // letter pitch across the view
const SIZE = 0.7;       // letter plane height (m)
const FONT = '300 176px "Cormorant Garamond", Georgia, serif';

function drawLetter(cv, ch) {
  const c = cv.getContext('2d');
  c.clearRect(0, 0, cv.width, cv.height);
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.font = FONT;
  // a soft dark halo so pale gold still reads against a pale sunrise sky
  c.shadowColor = 'rgba(0, 0, 0, 0.6)';
  c.shadowBlur = 22;
  c.shadowOffsetY = 5;
  c.fillStyle = '#f5e1b8';
  c.fillText(ch, cv.width / 2, cv.height / 2 + 10);
}

// opts: { pos: Vector3 (eye position), heading: yaw as walker.js defines it }
export function createWelcome(scene, opts) {
  const group = new THREE.Group();
  group.name = 'welcome';
  const heading = opts.heading;
  const fwd = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
  group.position.copy(opts.pos).addScaledVector(fwd, DIST);
  group.position.y = opts.pos.y + RISE;

  const geo = new THREE.PlaneGeometry(SIZE, SIZE);
  const letters = [];
  const chars = [...TEXT];
  const half = (chars.length - 1) / 2;
  for (let i = 0; i < chars.length; i++) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    drawLetter(cv, chars[i]);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, opacity: 0, side: THREE.DoubleSide,
      // a touch over white: blooms lightly where there is bloom, simply reads bright where there isn't
      color: new THREE.Color(1.35, 1.35, 1.35),
    });
    const mesh = new THREE.Mesh(geo, mat);
    // lookAt() turns the group's +z toward the camera, so local +x runs left to
    // right across the view and the letters read in order
    const x0 = (i - half) * GAP;
    mesh.position.set(x0, 0, 0);
    mesh.renderOrder = 5;
    group.add(mesh);
    letters.push({ mesh, mat, tex, cv, ch: chars[i], x0, phase: i * 0.8 });
  }
  scene.add(group);

  // the web font may still be arriving on a cold cache; redraw once it has
  if (document.fonts && !document.fonts.check(FONT)) {
    document.fonts.ready.then(() => {
      if (done) return;
      for (const l of letters) { drawLetter(l.cv, l.ch); l.tex.needsUpdate = true; }
    }).catch(() => {});
  }

  const WORD_W = (chars.length - 1) * GAP + SIZE;
  let age = 0, done = false;
  const _target = new THREE.Vector3();

  function update(dt, camera) {
    if (done) return true;
    age += dt;
    if (age >= LIFE) { dispose(); return true; }
    // stay upright, face the visitor wherever they wander
    _target.set(camera.position.x, group.position.y, camera.position.z);
    group.lookAt(_target);
    // A phone in portrait sees barely a third of the horizontal angle a desktop
    // does, so a word sized for one runs off the other. Shrink to fit whatever
    // is actually visible at this distance — the FOV is vertical, so the
    // horizontal half-angle has to come back through the aspect ratio.
    const dist = Math.max(1, camera.position.distanceTo(group.position));
    const hHalf = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect);
    group.scale.setScalar(Math.min(1, (2 * dist * Math.tan(hHalf) * 0.82) / WORD_W));
    const out = Math.min(1, (LIFE - age) / FADE_OUT);
    for (let i = 0; i < letters.length; i++) {
      const l = letters[i];
      const t = age - i * STAGGER;
      const inn = Math.max(0, Math.min(1, t / FADE_IN));
      const o = inn * inn * (3 - 2 * inn) * out;
      l.mat.opacity = o;
      l.mesh.visible = o > 0.001;
      l.mesh.position.y = 0.06 * Math.sin(1.3 * age + l.phase) + 0.25 * (1 - inn); // rises into place
      l.mesh.position.x = l.x0 + 0.02 * Math.sin(0.7 * age + l.phase * 1.7);
      l.mesh.rotation.z = 0.03 * Math.sin(0.9 * age + l.phase);
    }
    return false;
  }

  function dispose() {
    if (done) return;
    done = true;
    scene.remove(group);
    for (const l of letters) { l.tex.dispose(); l.mat.dispose(); }
    geo.dispose();
  }

  return { update, dispose, group, get done() { return done; } };
}
