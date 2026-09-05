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
import { createLightPool } from './lights.js';
import { createArt } from './art.js';
import { createReflector } from './reflector.js';
import { walker, spawn, lookDir } from './walker.js';
import { addInteractable, updateInteract, currentFocus } from './interact.js';
import { initHud, showPrompt, hidePrompt, showCard, showHint, updateCompass, initCompassScratch, isOverlayOpen } from './hud.js';
import { FEATURED, SELF_WORK, ARCHIVES, BOOKS, CARDS, LINKS } from './content.js';
import { createWelcome } from './welcome.js';

let art = null, reflector = null, building = null, sun = null, hemi = null, ambient = null, envs = null;
let pool = null, flattened = false;
let scene = null, renderer = null;

// How much light the rooms get. The indoor numbers used to be damped almost to
// nothing so the ceiling fixtures would read as the thing doing the lighting;
// they are now a real fill, because a wing that is visibly lit everywhere
// matters more than the fixtures getting the credit — and because on a device
// that loses its point lights the fill is all there is.
const LIT = {
  ambientOut: 0.36,   // ambient outdoors
  ambientIn: 0.28,    // ambient once fully inside a wing
  hemiIn: 0.3,        // hemisphere floor indoors (outdoors follows the sky preset)
  envIn: 0.35,        // sky-environment floor indoors
  hemiBoost: 1,       // raised by the fallback ladder when lights or env are lost
};

// The fallback ladder (see applyRung). 0 is the full lighting.
const RUNGS = ['full', 'noenv', 'nopoint', 'lambert', 'basic'];
let rung = 0;
const probes = [];  // [{ rung, lum }] — every reading the self-test took
let welcome = null;
let ladderNotice = '';  // shown once the visitor is actually inside, not mid-load
const probeHide = [];   // sky, water and the unlit paintings: hidden while probing
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
  // The PMREM bake needs a float or half-float colour buffer. Where the driver
  // has neither, the bake silently yields a black or NaN environment and every
  // PBR surface in the building goes dark — so skip it and start one rung down.
  const gl = renderer.getContext();
  const canBake = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
  if (canBake) {
    envs = bakeEnvironments(renderer, dome);
    scene.environment = envs.sunrise;
    scene.environmentIntensity = 0.9;
  } else {
    envs = null;
    rung = 1;
    console.warn('gallery: no float colour buffer — running without a baked environment');
  }
  await tick();

  progress(0.3, 'pouring the concrete…');
  const mats = createMaterials(quality);
  await tick();

  progress(0.45, 'building the wings…');
  building = buildBuilding(scene, mats);
  await tick();

  // sea + court pool
  const sea = createSea(C.SEA_Y);
  const poolWater = createPool(PLAN.court.x1 - PLAN.court.x0 - 16, 5, (PLAN.court.x0 + PLAN.court.x1) / 2, -0.05, -10.5);
  scene.add(sea);
  scene.add(poolWater);
  // everything the lighting self-test hides, so it only measures lit geometry
  probeHide.length = 0;
  probeHide.push(dome, sea, poolWater);

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
  // A flat neutral fill standing in for bounced light, so the sealed wings are
  // lit everywhere rather than only under a fixture. It, the hemisphere and the
  // sky environment all ease toward their indoor floors (LIT) as the visitor
  // crosses a threshold — see indoorFactor() — and the ladder raises all three
  // when it has to take a light source away.
  ambient = new THREE.AmbientLight(0xa6acb4, LIT.ambientOut);
  scene.add(ambient);

  // The building's ceiling fixtures are data; this pool is the handful of real
  // lights in the scene, aimed at whichever fixtures reach the visitor
  // (lights.js explains why the count is capped).
  pool = createLightPool(scene, building.fixtures, { size: C.LIGHT_POOL[quality] ?? 4 });

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
  // the paintings are unlit, so they would pass the self-test over a black room
  probeHide.push(art.frames);
  for (const e of art.entries) probeHide.push(e.group);
  await tick();

  progress(0.8, 'lighting the cases…');
  setupCases();
  setupCompass();
  initCompassScratch(THREE);
  initHud({ relock: ctx.relock || (() => {}), onClose: () => {} });

  spawn(SPAWN.x, SPAWN.z, SPAWN.heading, 0.02);

  progress(0.92, 'checking the light…');
  if (ctx.forceRung) {
    const n = RUNGS.indexOf(ctx.forceRung);
    if (n > 0) for (let i = rung; i < n; i++) applyRung(i + 1);
  }
  verifyLighting();
  await tick();
  progress(1, 'ready');
}

// let the loader repaint between heavy synchronous steps
function tick() { return new Promise((r) => setTimeout(r, 16)); }

// art.hang() returns null both when a category runs out of wall slots and
// when the shared frame InstancedMesh hits its own cap (art.js) — either way
// a hang didn't happen, so window.__hung has to count real successes, not
// just how far a loop got, or a shortfall anywhere can go unreported.
function hangCategory(name, works, slotsFor, hangOne) {
  let n = 0;
  for (let i = 0; i < works.length; i++) {
    const s = slotsFor[i];
    if (!s) break;
    if (hangOne(s, works[i])) n++;
  }
  if (n < works.length) console.warn(`gallery: ${works.length - n} ${name} work(s) did not get hung (wall slots or the shared frame limit ran out)`);
  return n;
}

function hangEverything() {
  const { slots } = building;
  const featured = hangCategory('featured', FEATURED, slots.featured, (s, w) =>
    art.hang({ ...s, y: 2.0 }, { ...w, thumb: w.img, full: w.img, kicker: 'Featured work' },
      { maxDim: C.ART_MAX_FEATURED, maxH: 3.0, border: 0.06, depth: 0.09, plaque: true, card: true, loadDist: 140, keepDist: 170, tag: 'featured' }));
  const selfwork = hangCategory('self-work', SELF_WORK, slots.selfwork, (s, w) =>
    art.hang({ ...s, y: 1.9 }, { ...w, thumb: w.img, full: w.img, kicker: 'Self Work series · 2021' },
      { maxDim: C.ART_MAX_SELFWORK, border: 0.06, depth: 0.09, plaque: true, card: true, loadDist: 70, keepDist: 90, tag: 'selfwork' }));
  const archive = hangCategory('archive', ARCHIVES, slots.archive, (s, w) =>
    art.hang(s, w, { maxDim: C.ART_MAX, border: 0.045, depth: 0.07, loadDist: 32, keepDist: 46, tag: 'archive' }));
  window.__hung = { featured, selfwork, archive, slots: slots.archive.length };
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

// 0 outside every wing, ramping to 1 over `margin` metres once past a
// doorway. The wings are windowless, so nothing here should still be reading
// the sky's ambient once the visitor is a few strides past the threshold —
// the room's own fixtures need to be doing the actual lighting by then.
function wingIndoor(x, x0, x1, margin) {
  if (x <= x0 || x >= x1) return 0;
  return Math.min(1, Math.min(x - x0, x1 - x) / margin);
}
function indoorFactor(x) {
  return Math.max(
    wingIndoor(x, PLAN.west.x0, PLAN.west.x1, 3),
    wingIndoor(x, PLAN.east.x0, PLAN.east.x1, 3)
  );
}

// Everything about the lighting that follows the visitor's position: the sky
// state, the sun, the fills, the environment map and the light pool. The
// self-test calls it too, for the position it is about to render from, so what
// it measures is what a visitor standing there would see.
const _sunPos = new THREE.Vector3();
function applyLightingAt(pos, dt) {
  const cur = setSkyState(skyStateAt(pos.x));
  const indoors = indoorFactor(pos.x);

  // sun + hemisphere follow the blended preset; the shadow frustum rides on the visitor
  sun.color.copy(cur.sunColor);
  sun.intensity = cur.sunIntensity;
  _sunPos.copy(pos).addScaledVector(cur.sunDir, 220);
  sun.position.copy(_sunPos);
  sun.target.position.copy(pos);
  sun.target.updateMatrixWorld();
  hemi.color.copy(cur.hemiSky);
  hemi.groundColor.copy(cur.hemiGround);
  // the hemisphere light isn't shadow-mapped — walls don't block it — so it
  // has to be damped by hand rather than relying on occlusion like the sun
  hemi.intensity = THREE.MathUtils.lerp(cur.hemiIntensity, LIT.hemiIn, indoors) * LIT.hemiBoost;
  ambient.intensity = THREE.MathUtils.lerp(LIT.ambientOut, LIT.ambientIn, indoors);

  // aim the light pool at the fixtures nearest the visitor
  pool.update(pos, dt);

  // environment map: pick the dominant preset (swaps happen deep inside the wings)
  const w = cur.w;
  const name = w[0] >= w[1] && w[0] >= w[2] ? 'sunrise' : (w[1] >= w[2] ? 'sunset' : 'space');
  if (envs && name !== lastEnv) { scene.environment = envs[name]; lastEnv = name; }
  scene.environmentIntensity = THREE.MathUtils.lerp(cur.envIntensity, LIT.envIn, indoors);

  // clerestory bands take a washed-out version of the sky outside: a hint of
  // daylight at the top of a windowless wall, not a neon strip
  for (const g of building.glow) {
    // the last rung of the fallback ladder replaces these with unlit materials,
    // which carry the band's colour on `color` and have no emissive at all
    const target = g.material.emissive || g.material.color;
    target.copy(cur.horizon).lerp(cur.zenith, 0.65);
    if (g.material.emissive) g.material.emissiveIntensity = 0.35 + 0.35 * (1 - cur.space);
  }
  return cur;
}

export function updateWorld(dt, t, camera) {
  skyUniforms.uTime.value = t;
  applyLightingAt(walker.pos, dt);

  if (welcome && welcome.update(dt, camera)) {
    welcome = null;
    // the controls hint lands where the letters were, so it waits for them
    showHint('W A S D to walk · MOUSE to look · Shift run · E to view a painting');
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
}

// The visitor has stepped inside: float WELCOME in front of wherever they are
// actually standing and facing. It clears itself after fifteen seconds and the
// controls hint follows it.
export function startWelcome() {
  if (welcome || hintShown) return;
  hintShown = true;
  welcome = createWelcome(scene, { pos: walker.pos, heading: walker.heading });
  if (ladderNotice) { showHint(ladderNotice); ladderNotice = ''; }
}

// --- the lighting fallback ladder -------------------------------------------
//
// A phone can lose the building in more ways than a failed link. The lit
// program may refuse to compile (three.js reports that, and main.js hooks it);
// it may link and then draw nothing, which nothing reports; or the baked
// environment may come back black or NaN and drag every PBR surface down with
// it. All three end the same way — a black room with the unlit paintings
// floating in it, which is exactly what phones were showing.
//
// So the gallery does not trust that its lighting works. Before the visitor is
// let in it renders the inside of a wing into a small buffer and reads the
// pixels back. If the room is dark, it takes a rung off the lighting and looks
// again, down to a version that a device with any WebGL2 at all can draw:
//
//   0 full     everything
//   1 noenv    no baked sky environment (the fills come up to compensate)
//   2 nopoint  no point lights at all — ambient and hemisphere carry the rooms
//   3 lambert  PBR swapped for Lambert: a fraction of the shader
//   4 basic    unlit — albedo straight to the screen. Flat, but a gallery you
//              can see.
const PROBE_MIN = 20;   // mean luminance (0-255) an interior view has to clear
let probeRT = null, probeCam = null;
// ?probefail makes every reading come back dark, so the whole ladder can be
// walked on a device where the lighting is in fact fine
let probeFail = false;
export function setProbeFail(v) { probeFail = !!v; }

// Render the inside of the west wing — enclosed on all sides, and the case
// that fails on the devices this exists for — and average the pixels.
export function probeLighting() {
  if (!renderer || !building) return -1;
  const p = PLACES.west;
  if (!probeRT) {
    probeRT = new THREE.WebGLRenderTarget(64, 36, { depthBuffer: true, stencilBuffer: false });
    probeCam = new THREE.PerspectiveCamera(C.FOV, 64 / 36, 0.1, 400);
  }
  probeCam.position.set(p.x, C.EYE, p.z);
  probeCam.lookAt(p.x + Math.sin(p.heading) * 10, C.EYE, p.z + Math.cos(p.heading) * 10);

  // light the wing as if the visitor were standing there; a long dt snaps the
  // pool to full intensity instead of fading in over the next second
  const probePos = probeCam.position;
  for (let i = 0; i < 3; i++) applyLightingAt(probePos, 1);

  const wasHidden = probeHide.map((o) => o.visible);
  for (const o of probeHide) o.visible = false;
  const prevTarget = renderer.getRenderTarget();
  const prevShadow = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = false;
  renderer.setRenderTarget(probeRT);
  renderer.clear();
  renderer.render(scene, probeCam);
  const px = new Uint8Array(64 * 36 * 4);
  renderer.readRenderTargetPixels(probeRT, 0, 0, 64, 36, px);
  renderer.setRenderTarget(prevTarget);
  renderer.shadowMap.enabled = prevShadow;
  for (let i = 0; i < probeHide.length; i++) probeHide[i].visible = wasHidden[i];

  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  const lum = probeFail ? 0 : sum / (px.length / 4);
  // restore the lighting for wherever the visitor actually is
  applyLightingAt(walker.pos, 1);
  return Number.isFinite(lum) ? lum : 0;
}

// Probe, and keep taking rungs off until the room reads or the ladder runs out.
export function verifyLighting() {
  for (let guard = 0; guard < RUNGS.length; guard++) {
    const lum = probeLighting();
    probes.push({ rung: RUNGS[rung], lum: Math.round(lum * 10) / 10 });
    if (lum >= PROBE_MIN || rung >= RUNGS.length - 1) break;
    console.warn(`gallery: the rooms rendered at ${lum.toFixed(1)} — dropping to a simpler lighting model`);
    applyRung(rung + 1);
  }
  // the HUD is still behind the loader here, and a hint times itself out, so
  // the notice waits for the visitor to step inside
  if (rung >= 2) ladderNotice = 'This device could not run the full lighting — showing a simpler version.';
  return { rung: RUNGS[rung], probes: probes.slice() };
}

// Take one rung off. Each is cumulative: rung 3 still has no environment and no
// point lights.
function applyRung(n) {
  rung = Math.max(rung, Math.min(n, RUNGS.length - 1));
  if (rung >= 1 && scene.environment) {
    // the sky environment is a large part of the indoor light; losing it has to
    // be paid for somewhere, or the fix for a black room is a dim one
    scene.environment = null;
    envs = null;
    LIT.hemiBoost = 1.6;
    LIT.ambientOut = 0.46;
    LIT.ambientIn = 0.4;
  }
  if (rung >= 2 && pool.size > 0) {
    pool.setSize(0);
    LIT.hemiBoost = 2.0;
    LIT.ambientOut = 0.6;
    LIT.ambientIn = 0.72;
  }
  if (rung >= 3 && !flattened) flattenMaterials('lambert');
  if (rung >= 4) flattenMaterials('basic');
  console.warn(`gallery: lighting fell back to "${RUNGS[rung]}"`);
  return rung;
}

// main.js calls this when the driver reports a shader that would not link.
export function degradeLighting() {
  if (!pool) return -1;
  // a reported link failure is about shader size, so skip the environment rung
  return applyRung(rung < 2 ? 2 : rung + 1);
}

// Every PBR material in the scene becomes a Lambert one — or, one rung further
// down, an unlit Basic one — carrying the same colour, texture and emissive.
// Substitutions are cached per source material, so the whole building still
// shares a handful of programs. The floor's planar reflection is injected into
// the material it replaces and does not survive, which is the right trade when
// the alternative is a black room.
function flattenMaterials(kind) {
  flattened = true;
  const swap = new Map();
  scene.traverse((o) => {
    const m = o.material;
    if (!o.isMesh || !m) return;
    if (!(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial || (kind === 'basic' && m.isMeshLambertMaterial))) return;
    let repl = swap.get(m);
    if (!repl) {
      const common = {
        color: m.color, map: m.map, transparent: m.transparent, opacity: m.opacity,
        side: m.side, depthWrite: m.depthWrite, alphaTest: m.alphaTest,
      };
      if (kind === 'basic') {
        repl = new THREE.MeshBasicMaterial(common);
        // unlit albedo is brighter than the lit surface it replaces; and an
        // emissive strip has to keep glowing, since nothing else lights it now
        if (m.emissive && m.emissiveIntensity > 0 && m.emissive.getHex() !== 0) repl.color.copy(m.emissive);
        else repl.color.multiplyScalar(0.85);
      } else {
        repl = new THREE.MeshLambertMaterial({ ...common, emissive: m.emissive, emissiveIntensity: m.emissiveIntensity });
      }
      swap.set(m, repl);
    }
    o.material = repl;
  });
}

export function lightingReport() {
  return {
    rung: RUNGS[rung],
    probes: probes.slice(),
    pool: pool ? pool.size : 0,
    fixtures: building ? building.fixtures.length : 0,
    ambient: LIT.ambientOut,
    env: !!scene && !!scene.environment,
    flattened,
  };
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
