// Builds every content structure that sits ON the terrain: the spawn signpost,
// the 5 featured billboards, the Self Work stone circle, the story path, the
// books pavilion, the collect stand, and the NOVA 7 portal. Each structure
// stands on a flattened pad, registers push-out colliders + an interactable,
// and (where it shows art) an aspect-correct panel wired to the texture
// manager. The gallery rotunda is built in gallery.js.

import * as THREE from 'three';
import { C } from './config.js';
import { zoneDir, frameAt } from './layout.js';
import { addCollider, addPad } from './walk.js';
import { addInteractable } from './interact.js';
import { makeArtPanel, makeBeacon } from './panels.js';
import { showCard } from './hud.js';
import { FEATURED, SELF_WORK, STORY, BOOKS, CARDS, LINKS } from './content.js';

const _up = new THREE.Vector3();
const _north = new THREE.Vector3();
const _east = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _pos = new THREE.Vector3();

// Orient `group` upright at surface direction `dir`, facing toward `faceDir`
// (a unit direction on the sphere, usually spawn). Places it on the terrain
// and returns the ground radial height at the center.
function place(planet, group, dir, faceDir) {
  frameAt(dir, _up, _north, _east);
  const gH = planet.groundAtLocal(dir);
  const baseR = planet.radius + gH;
  _pos.copy(dir).multiplyScalar(baseR);
  group.position.copy(_pos);

  // forward = tangent direction from here toward faceDir
  _fwd.copy(faceDir).addScaledVector(_up, -faceDir.dot(_up)).normalize();
  if (_fwd.lengthSq() < 1e-5) _fwd.copy(_north);
  _right.crossVectors(_up, _fwd).normalize();
  _basis.makeBasis(_right, _up, _fwd);
  group.quaternion.setFromRotationMatrix(_basis);
  return baseR;
}

// Register a flat pad + a beacon at a structure's location.
function pad(planet, dir, radiusUnits, group, ctx, beaconH = 24) {
  const gH = planet.groundAtLocal(dir);
  addPad(dir, radiusUnits / planet.radius, planet.radius + gH, 0.25);
  if (beaconH) {
    const b = makeBeacon(beaconH);
    place(planet, b, dir, ctx.zones.spawn);
    ctx.scene.add(b);
  }
}

// Add a world-space collider at a local offset (lx along right, lz along fwd,
// up by ly) from a placed group. Uses the group's current basis.
function colliderAt(group, lx, ly, lz, radius) {
  _pos.set(lx, ly, lz).applyQuaternion(group.quaternion).add(group.position);
  addCollider(_pos, radius);
}

function darkMat(color, rough = 0.7) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.1 });
}

// ---------------------------------------------------------------------------
export function buildZones(ctx, tm) {
  const { planet, scene, zones } = ctx;
  const compass = [];
  const updaters = [];

  buildSignpost(ctx, compass);
  buildBillboards(ctx, tm, compass);
  buildSelfWork(ctx, tm, compass);
  buildStory(ctx, tm, compass);
  buildBooks(ctx, tm, compass);
  buildCollect(ctx, tm, compass, updaters);
  buildNova(ctx, compass, updaters);

  return { compass, updaters };
}

// --- spawn signpost -------------------------------------------------------
function buildSignpost(ctx, compass) {
  const { planet, scene, zones } = ctx;
  const g = new THREE.Group();
  const postMat = darkMat(0x3a2f22, 0.85);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 6, 8), postMat);
  post.position.y = 3;
  g.add(post);
  // three sign arms
  const armMat = new THREE.MeshStandardMaterial({ color: 0xf5b642, emissive: 0x3a2a06, roughness: 0.6 });
  const labels = ['ARCHIVES', 'FEATURED', 'THE STORY'];
  for (let i = 0; i < 3; i++) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(3, 0.6, 0.12), armMat);
    arm.position.set(1.3, 4.6 - i * 0.9, 0);
    arm.rotation.y = (i - 1) * 0.5;
    g.add(arm);
  }
  place(planet, g, zones.spawn, zones.gallery);
  scene.add(g);
  addCollider(g.position, 1.2);

  addInteractable({
    pos: g.position.clone(), radius: 4.5,
    prompt: '<b>E</b> — where am I?',
    action: () => showCard({
      kicker: 'welcome',
      title: 'JFeelgood — an explorable world',
      body: [
        'You are standing at the heart of an art planet. Every direction leads somewhere: giant billboards hold the featured paintings, a rotunda ahead houses the full 186-work archive, and the Self Work series, books, and collectible cards each have their own place on the terrain.',
        'Walk with W A S D, run with Shift, jump with Space, and press E near anything to look closer.',
      ],
      actions: [
        { label: 'Classic site', href: LINKS.classic, ghost: true },
        { label: 'Archives', href: LINKS.archives, ghost: true },
        { label: '@artistjfeelgood', href: LINKS.instagram, ghost: true },
        { label: 'minicuration', href: LINKS.minicuration, ghost: true },
      ],
    }),
  });
  // spawn beacon is subtle
  const b = makeBeacon(14, 0xf5e1b8);
  place(planet, b, zones.spawn, zones.gallery);
  scene.add(b);
}

// --- featured billboards --------------------------------------------------
function buildBillboards(ctx, tm, compass) {
  const { planet, scene, zones } = ctx;
  zones.billboards.forEach((dir, i) => {
    const piece = FEATURED[i];
    const g = new THREE.Group();
    const postMat = darkMat(0x241c14, 0.8);
    // two posts + top beam
    for (const sx of [-11, 11]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 24, 10), postMat);
      post.position.set(sx, 12, 0);
      g.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(24, 1.2, 1.2), postMat);
    beam.position.set(0, 23.4, 0);
    g.add(beam);

    const panel = makeArtPanel({ maxW: 20, maxH: 13, frameW: 0.4, double: false });
    // Hide the gold frame on these oversized billboards: at 20+ world units wide
    // and viewed from up to 240u away, the frame plane (z=0.01) z-fought the art
    // plane (z=0.03) and bled a gold streak across the painting. The slightly
    // larger dark backing still reads as a thin border. Push the art forward too
    // so no residual z-fighting remains. (Billboard-only — the shared gold frame
    // stays on the gallery, Self Work, easels, lecterns and collect stand.)
    panel.frame.visible = false;
    panel.art.position.z = 0.06;
    panel.group.position.set(0, 13, 0.4);
    g.add(panel.group);

    pad(planet, dir, 20, g, ctx, 26);
    place(planet, g, dir, zones.spawn);
    scene.add(g);

    // colliders on the two posts
    colliderAt(g, -11, 0, 0, 1.1);
    colliderAt(g, 11, 0, 0, 1.1);

    // texture (1200px opt image, high anisotropy, downscale to 1024)
    tm.register({
      mesh: panel.art, url: piece.img, worldPos: g.position.clone(),
      loadDist: 240, keepDist: 300, maxDim: 1024, anisotropy: 16,
      onSize: panel.onSize,
    });

    const actions = [];
    if (piece.buyUrl) actions.push({ label: 'Buy this work', href: piece.buyUrl });
    actions.push({ label: 'All originals', href: LINKS.minicuration, ghost: true });
    addInteractable({
      pos: g.position.clone(), radius: 16,
      prompt: `<b>E</b> — ${piece.title}`,
      action: () => showCard({ kicker: 'featured work', title: piece.title, meta: piece.meta, body: piece.body, img: piece.img, alt: piece.alt, actions }),
    });
    compass.push({ name: piece.title.toUpperCase(), pos: g.position.clone() });
  });
}

// --- Self Work stone circle -----------------------------------------------
function buildSelfWork(ctx, tm, compass) {
  const { planet, scene, zones } = ctx;
  const center = zones.selfwork;
  frameAt(center, _up, _north, _east);
  pad(planet, center, 24, null, ctx, 24);

  const R = 15; // circle radius in surface units
  SELF_WORK.forEach((piece, i) => {
    const a = (i / SELF_WORK.length) * Math.PI * 2;
    // offset direction around the circle center, in the center's tangent frame
    const ox = Math.cos(a) * R, oz = Math.sin(a) * R;
    const dir = new THREE.Vector3().copy(center)
      .addScaledVector(_north, ox / planet.radius)
      .addScaledVector(_east, oz / planet.radius).normalize();

    const g = new THREE.Group();
    // rough stone monolith
    const stone = new THREE.Mesh(new THREE.BoxGeometry(3.4, 7, 1.6), darkMat(0x4a4038, 0.95));
    stone.position.y = 3.5;
    stone.rotation.z = (Math.random() - 0.5) * 0.05;
    g.add(stone);
    const panel = makeArtPanel({ maxW: 2.7, maxH: 3.4, frameW: 0.14 });
    panel.group.position.set(0, 4.0, 0.85);
    g.add(panel.group);

    // face the circle center (inward), so walking the ring reveals each
    place(planet, g, dir, center);
    scene.add(g);
    addCollider(g.position, 1.6);

    tm.register({ mesh: panel.art, url: piece.img, worldPos: g.position.clone(),
      loadDist: 60, keepDist: 90, maxDim: 1024, anisotropy: 8, onSize: panel.onSize });
    addInteractable({
      pos: g.position.clone(), radius: 5,
      prompt: `<b>E</b> — ${piece.title}`,
      action: () => showCard({ kicker: 'the self work series', title: piece.title, meta: piece.meta, body: piece.body, img: piece.img, alt: piece.alt,
        actions: [{ label: 'The Book of Shadow Work', href: LINKS.shadowWork, ghost: true }] }),
    });
  });
  compass.push({ name: 'SELF WORK', pos: new THREE.Vector3().copy(center).multiplyScalar(planet.radius + planet.groundAtLocal(center)) });
}

// --- story path -----------------------------------------------------------
function buildStory(ctx, tm, compass) {
  const { planet, scene, zones } = ctx;
  STORY.forEach((slide, i) => {
    const t = i / (STORY.length - 1);
    const bearing = 140 + (0 - 140) * t;
    const dist = 95 + (160 - 95) * t;
    const dir = zoneDir(bearing, dist);

    const g = new THREE.Group();
    // simple easel: two legs + a ledge
    const legMat = darkMat(0x2e2418, 0.85);
    for (const sx of [-1.1, 1.1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 4.2, 6), legMat);
      leg.position.set(sx, 2.1, 0.2);
      leg.rotation.x = 0.12;
      g.add(leg);
    }
    const backLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 4.2, 6), legMat);
    backLeg.position.set(0, 2.1, -0.6);
    backLeg.rotation.x = -0.2;
    g.add(backLeg);
    const panel = makeArtPanel({ maxW: 2.4, maxH: 3.0, frameW: 0.12 });
    panel.group.position.set(0, 3.0, 0.28);
    panel.group.rotation.x = -0.08;
    g.add(panel.group);

    place(planet, g, dir, zones.spawn);
    scene.add(g);
    addCollider(g.position, 0.9);
    const isPadCenter = i === 0;
    if (isPadCenter) pad(planet, dir, 8, null, ctx, 18);

    tm.register({ mesh: panel.art, url: slide.img, worldPos: g.position.clone(),
      loadDist: 55, keepDist: 85, maxDim: 900, anisotropy: 8, onSize: panel.onSize });
    addInteractable({
      pos: g.position.clone(), radius: 4.5,
      prompt: `<b>E</b> — ${slide.title}`,
      action: () => showCard({ kicker: `the story · ${i + 1} of ${STORY.length}`, title: slide.title, meta: slide.meta, body: slide.body, img: slide.img, alt: slide.alt }),
    });
  });
  compass.push({ name: 'THE STORY', pos: new THREE.Vector3().copy(zoneDir(140, 95)).multiplyScalar(planet.radius + 6) });
}

// --- books pavilion -------------------------------------------------------
function buildBooks(ctx, tm, compass) {
  const { planet, scene, zones } = ctx;
  const center = zones.books;
  frameAt(center, _up, _north, _east);
  pad(planet, center, 16, null, ctx, 22);

  BOOKS.forEach((book, i) => {
    const off = (i - 0.5) * 6;
    const dir = new THREE.Vector3().copy(center).addScaledVector(_east, off / planet.radius).normalize();
    const g = new THREE.Group();
    const lectern = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.4, 1.6), darkMat(0x2a2018, 0.85));
    lectern.position.y = 0.7;
    g.add(lectern);
    const panel = makeArtPanel({ maxW: 2.2, maxH: 3.0, frameW: 0.14 });
    panel.group.position.set(0, 2.6, 0.2);
    g.add(panel.group);
    place(planet, g, dir, zones.spawn);
    scene.add(g);
    addCollider(g.position, 1.3);
    tm.register({ mesh: panel.art, url: book.img, worldPos: g.position.clone(),
      loadDist: 55, keepDist: 85, maxDim: 900, anisotropy: 8, onSize: panel.onSize });
    addInteractable({
      pos: g.position.clone(), radius: 5,
      prompt: `<b>E</b> — ${book.title}`,
      action: () => showCard({ kicker: 'books', title: book.title, meta: book.meta, body: book.body, img: book.img, alt: book.alt,
        actions: [{ label: book.buyLabel || 'Get the book', href: book.buyUrl }] }),
    });
  });
  compass.push({ name: 'BOOKS', pos: new THREE.Vector3().copy(center).multiplyScalar(planet.radius + planet.groundAtLocal(center)) });
}

// --- collect stand --------------------------------------------------------
function buildCollect(ctx, tm, compass, updaters) {
  const { planet, scene, zones } = ctx;
  const center = zones.collect;
  frameAt(center, _up, _north, _east);
  pad(planet, center, 16, null, ctx, 22);

  const g = new THREE.Group();
  // market stall: a counter + a back board holding the 6 cards
  const counter = new THREE.Mesh(new THREE.BoxGeometry(14, 1.2, 2), darkMat(0x2a2018, 0.85));
  counter.position.set(0, 0.6, 2.4);
  g.add(counter);
  const board = new THREE.Mesh(new THREE.BoxGeometry(14, 6, 0.4), darkMat(0x1a140f, 0.8));
  board.position.set(0, 3.4, 0);
  g.add(board);

  const stockEls = [];
  const cardPanels = [];
  CARDS.forEach((card, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const panel = makeArtPanel({ maxW: 3.6, maxH: 2.4, frameW: 0.1 });
    panel.group.position.set((col - 1) * 4.4, 4.6 - row * 2.6, 0.3);
    g.add(panel.group);
    cardPanels.push(panel);
    stockEls.push({ card });
  });

  place(planet, g, center, zones.spawn);
  scene.add(g);
  addCollider(g.position, 4.5);

  // register textures now that world positions are known
  cardPanels.forEach((panel, i) => {
    tm.register({ mesh: panel.art, url: CARDS[i].img,
      worldPos: g.position.clone(), loadDist: 55, keepDist: 85, maxDim: 700, anisotropy: 8, onSize: panel.onSize });
  });

  // now that the group is placed, give each card panel a world position and an
  // interactable (single stand interactable opens the collect overview)
  addInteractable({
    pos: g.position.clone(), radius: 8,
    prompt: '<b>E</b> — collectible cards',
    action: () => showCard({
      kicker: 'limited edition · $23 · edition of 50',
      title: 'Collectible Art Cards',
      body: ['Museum-quality 2.5" × 3.5" reproductions of selected paintings, sealed in a magnetic acrylic display case with easel. Strictly numbered editions of 50 per design — no reprints.'],
      img: CARDS[0].img,
      actions: CARDS.map((c) => ({ label: c.title, href: c.buyUrl, ghost: true })),
    }),
  });
  compass.push({ name: 'COLLECT', pos: g.position.clone() });

  // live stock: fetch once, tuck the numbers into the overview card if open
  fetchStock(stockEls);
}

function fetchStock(entries) {
  if (!window.fetch) return;
  fetch('https://minicuration.com/api/stock')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .then((inv) => {
      for (const e of entries) {
        const info = inv[e.card.slug];
        if (info && typeof info.stock === 'number') e.card.stock = info.stock;
      }
    })
    .catch(() => {});
}

// --- NOVA 7 portal --------------------------------------------------------
function buildNova(ctx, compass, updaters) {
  const { planet, scene, zones } = ctx;
  const dir = zones.nova;
  pad(planet, dir, 12, null, ctx, 28);
  const g = new THREE.Group();
  const archMat = new THREE.MeshStandardMaterial({ color: 0x6a3fb0, emissive: 0x3a1e6e, emissiveIntensity: 1.2, roughness: 0.4, metalness: 0.3 });
  const arch = new THREE.Mesh(new THREE.TorusGeometry(5, 0.7, 16, 40), archMat);
  arch.position.y = 6;
  g.add(arch);
  // shimmering inner disc
  const discMat = new THREE.MeshBasicMaterial({ color: 0x9a6ff0, transparent: true, opacity: 0.28, side: THREE.DoubleSide, toneMapped: false });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(4.4, 40), discMat);
  disc.position.y = 6;
  g.add(disc);
  place(planet, g, dir, zones.spawn);
  scene.add(g);
  addCollider(g.position, 5.4);
  updaters.push((dt, t) => { discMat.opacity = 0.22 + Math.sin(t * 2) * 0.1; arch.rotation.z = t * 0.15; });

  addInteractable({
    pos: g.position.clone(), radius: 8,
    prompt: '<b>E</b> — other worlds: NOVA 7',
    action: () => showCard({
      kicker: 'other worlds',
      title: 'NOVA 7',
      body: ['A video game from the same universe of work — step through the portal to play.'],
      actions: [{ label: 'Play NOVA 7', href: LINKS.nova7 }],
    }),
  });
  compass.push({ name: 'NOVA 7', pos: g.position.clone() });
}
