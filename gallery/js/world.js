// Assembles the gallery — sky, sea, building, the hung works, lights, the
// display cases — and runs the per-frame update: sky state from the visitor's
// position, light/env blending, texture streaming, interaction prompts, the
// compass.

import * as THREE from 'three';
import { C, PLAN, PLACES, skyStateAt, SPAWN } from './config.js';
import { createSkyDome, setSkyState, bakeEnvironments, skyUniforms, currentSky } from './sky.js';
import { createSea, createPool } from './water.js';
import { createMaterials } from './materials.js';
import { buildBuilding } from './building.js';
import { createArt } from './art.js';
import { createReflector } from './reflector.js';
import { walker, spawn, lookDir } from './walker.js';
import { addInteractable, updateInteract, currentFocus } from './interact.js';
import { initHud, showPrompt, hidePrompt, showCard, showHint, updateCompass, initCompassScratch, isOverlayOpen } from './hud.js';
import { FEATURED, SELF_WORK, ARCHIVES, BOOKS, CARDS, LINKS } from './content.js';

let art = null, reflector = null, building = null, sun = null, hemi = null, envs = null;
let scene = null, renderer = null;
const compassEntries = [];
const _fwd = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _p = new THREE.Vector3();
let lastEnv = '';
let hintShown = false;

export async function buildWorld(ctx) {
  scene = ctx.scene; renderer = ctx.renderer;
  const quality = ctx.quality;
  const progress = ctx.progress || (() => {});

  progress(0.05, 'raising the sky…');
  const dome = createSkyDome(4200);
  scene.add(dome);
  setSkyState(0);
  await tick();

  progress(0.15, 'baking the light…');
  envs = bakeEnvironments(renderer, dome);
  scene.environment = envs.sunrise;
  scene.environmentIntensity = 0.9;
  await tick();

  progress(0.3, 'pouring the concrete…');
  const mats = createMaterials(quality);
  await tick();

  progress(0.45, 'building the wings…');
  building = buildBuilding(scene, mats, { quality });
  await tick();

  // sea + court pool
  scene.add(createSea(C.SEA_Y));
  scene.add(createPool(PLAN.court.x1 - PLAN.court.x0 - 16, 5, (PLAN.court.x0 + PLAN.court.x1) / 2, -0.05, -10.5));

  // lights
  sun = new THREE.DirectionalLight(0xffffff, 2.5);
  sun.castShadow = quality !== 'low';
  const shadowRes = quality === 'high' ? 2048 : 1024;
  sun.shadow.mapSize.set(shadowRes, shadowRes);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 420;
  sun.shadow.camera.left = -70; sun.shadow.camera.right = 70;
  sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.05;
  scene.add(sun); scene.add(sun.target);
  hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
  scene.add(hemi);
  // a flat neutral fill standing in for bounced light: it keeps the sealed
  // wings from going dim once the sky environment is turned down on them, and
  // outdoors it is swamped by the sun
  scene.add(new THREE.AmbientLight(0xa6acb4, 0.28));

  // floor reflection (skipped on the low tier)
  reflector = createReflector(renderer, scene, { y: 0, scale: quality === 'high' ? 0.5 : 0.35 });
  if (quality === 'low') reflector.setEnabled(false);
  reflector.attach(mats.concreteFloor, 0.55);
  reflector.attach(mats.stone, 0.4);
  // the reflective floors are the only things hidden from the mirrored pass —
  // the sky dome and the sea have to stay in it, or the wet stone outdoors
  // reflects nothing.
  for (const f of building.floors) reflector.exclude(f);

  progress(0.6, 'hanging the paintings…');
  art = createArt(scene, mats, renderer, { quality });
  hangEverything();
  await tick();

  progress(0.8, 'lighting the cases…');
  setupCases();
  setupCompass();
  initCompassScratch(THREE);
  initHud({ relock: ctx.relock || (() => {}), onClose: () => {} });

  spawn(SPAWN.x, SPAWN.z, SPAWN.heading, 0.02);
  progress(1, 'ready');
}

// let the loader repaint between heavy synchronous steps
function tick() { return new Promise((r) => setTimeout(r, 16)); }

function hangEverything() {
  const { slots } = building;
  FEATURED.forEach((w, i) => {
    const s = slots.featured[i];
    if (!s) return;
    art.hang({ ...s, y: 2.0 }, { ...w, thumb: w.img, full: w.img, kicker: 'Featured work' },
      { maxDim: C.ART_MAX_FEATURED, maxH: 3.0, border: 0.06, depth: 0.09, plaque: true, card: true, loadDist: 140, keepDist: 170, tag: 'featured' });
  });
  SELF_WORK.forEach((w, i) => {
    const s = slots.selfwork[i];
    if (!s) return;
    art.hang({ ...s, y: 1.9 }, { ...w, thumb: w.img, full: w.img, kicker: 'Self Work series · 2021' },
      { maxDim: C.ART_MAX_SELFWORK, border: 0.06, depth: 0.09, plaque: true, card: true, loadDist: 70, keepDist: 90, tag: 'selfwork' });
  });
  let n = 0;
  for (let i = 0; i < ARCHIVES.length; i++) {
    const s = slots.archive[i];
    if (!s) break;
    art.hang(s, ARCHIVES[i], { maxDim: C.ART_MAX, border: 0.045, depth: 0.07, loadDist: 32, keepDist: 46, tag: 'archive' });
    n++;
  }
  if (n < ARCHIVES.length) console.warn(`gallery: ${ARCHIVES.length - n} archive works did not get a wall slot`);
  window.__hung = { featured: Math.min(FEATURED.length, slots.featured.length), selfwork: Math.min(SELF_WORK.length, slots.selfwork.length), archive: n, slots: slots.archive.length };
}

function setupCases() {
  for (const c of building.cases) {
    const pos = new THREE.Vector3(c.x, c.y, c.z);
    if (c.label === 'books') {
      addInteractable({
        pos, radius: 3.2, prompt: '<b>E</b> — the books',
        action: () => showCard({
          kicker: 'Books', title: 'Thought Entropy · The Book of Shadow Work',
          meta: 'Two volumes, twenty years',
          body: [BOOKS[0].body[0], BOOKS[1].body[0]],
          img: BOOKS[1].img, alt: BOOKS[1].alt,
          actions: [
            { label: 'Thought Entropy — Amazon', href: BOOKS[0].buyUrl },
            { label: 'The Book of Shadow Work — Amazon', href: BOOKS[1].buyUrl },
            { label: 'thebookofshadowwork.com', href: LINKS.shadowWork, ghost: true },
          ],
        }),
      });
    } else if (c.label === 'collect') {
      addInteractable({
        pos, radius: 3.2, prompt: '<b>E</b> — limited-edition cards',
        action: () => showCard({
          kicker: 'Collect', title: 'Limited-edition art cards',
          meta: '2.5″ × 3.5″ · magnetic acrylic case · editions of 50 · $23',
          body: ['Six paintings, reproduced as museum-quality art cards and sealed in a magnetic acrylic display case with easel. Strictly numbered editions of fifty per design, no reprints. Fulfilled by minicuration.'],
          img: CARDS[0].img, alt: 'Dreamfall limited edition art card',
          actions: CARDS.map((k) => ({ label: k.title, href: k.buyUrl })).concat([{ label: 'minicuration.com', href: LINKS.minicuration, ghost: true }]),
        }),
      });
    } else {
      addInteractable({
        pos, radius: 3.2, prompt: '<b>E</b> — other worlds I’m building',
        action: () => showCard({
          kicker: 'In progress', title: 'Other worlds',
          meta: 'Galleries, games, and places to walk into',
          body: [
            'iExploreArt — walkable virtual galleries for contemporary artists, each with a curator and a hall of their own.',
            'Prototown — a browser 4X strategy game: found cities, research, out-think rival tribes, solo or with a friend.',
            'Driftbound — a top-down survival adventure. Six shards. One shore. No way back.',
            'NOVA 7 — a classic arcade shooter about one thing: the high score.',
          ],
          actions: [
            { label: 'iexploreart.com', href: 'https://iexploreart.com' },
            { label: 'Prototown', href: 'https://prototown.vercel.app' },
            { label: 'Driftbound', href: 'https://driftbound.vercel.app' },
            { label: 'NOVA 7', href: LINKS.nova7 },
            { label: 'Everything, on the classic site', href: LINKS.classic, ghost: true },
          ],
        }),
      });
    }
  }
}

function setupCompass() {
  compassEntries.length = 0;
  for (const k of Object.keys(PLACES)) {
    const p = PLACES[k];
    compassEntries.push({ name: p.label, pos: new THREE.Vector3(p.x, 1.6, p.z) });
  }
}

export function resolvePlace(name) { return PLACES[name] || null; }

const _sunPos = new THREE.Vector3();
export function updateWorld(dt, t, camera) {
  skyUniforms.uTime.value = t;
  const x = walker.pos.x;
  const cur = setSkyState(skyStateAt(x));

  // sun + hemisphere follow the blended preset; the shadow frustum rides on the visitor
  sun.color.copy(cur.sunColor);
  sun.intensity = cur.sunIntensity;
  _sunPos.copy(walker.pos).addScaledVector(cur.sunDir, 220);
  sun.position.copy(_sunPos);
  sun.target.position.copy(walker.pos);
  sun.target.updateMatrixWorld();
  hemi.color.copy(cur.hemiSky);
  hemi.groundColor.copy(cur.hemiGround);
  hemi.intensity = cur.hemiIntensity;

  // environment map: pick the dominant preset (swaps happen deep inside the wings)
  const w = cur.w;
  const name = w[0] >= w[1] && w[0] >= w[2] ? 'sunrise' : (w[1] >= w[2] ? 'sunset' : 'space');
  if (name !== lastEnv) { scene.environment = envs[name]; lastEnv = name; }
  scene.environmentIntensity = cur.envIntensity;

  // clerestory bands take a washed-out version of the sky outside: a hint of
  // daylight at the top of a windowless wall, not a neon strip
  for (const g of building.glow) {
    g.material.emissive.copy(cur.horizon).lerp(cur.zenith, 0.65);
    g.material.emissiveIntensity = 0.35 + 0.35 * (1 - cur.space);
  }

  // textures + interaction
  art.update(walker.pos, performance.now());
  lookDir(_fwd);
  const focus = updateInteract(walker.pos, _fwd, 9);
  if (!isOverlayOpen()) {
    if (focus) showPrompt(focus.prompt); else hidePrompt();
  } else hidePrompt();
  walker.frozen = isOverlayOpen();

  updateCompass(compassEntries, walker.pos, _fwd, _up, THREE);

  if (!hintShown && t > 2) {
    hintShown = true;
    showHint('W A S D to walk · MOUSE to look · Shift run · E to view a painting');
  }
}

export function renderReflection(camera) { if (reflector) reflector.update(camera); }
export function setReflectionEnabled(v) { if (reflector) reflector.setEnabled(v); }
export function resizeReflection() { if (reflector && reflector.enabled) reflector.setSize(); }

export function handleInteract() {
  if (isOverlayOpen()) return false;
  const f = currentFocus();
  if (f && f.action) { f.action(); return true; }
  return false;
}

export function currentSkyState() { return currentSky(); }
