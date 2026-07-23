// biomeCivs.js — the living-civilisation layer. Scatters one dormant city
// "seed" through each biome, then runs a presence-driven lifecycle: when the
// player draws near a seed's biome the colony wakes and races through its
// generations (citylife.js + civsim.js), buildings rising from huts to a
// skyline. Its fate is decided by the player's patience:
//
//   * stay until the colony ascends  -> a spaceport rises and an ark launches
//     its people to a new world (citylife.beginLaunch)
//   * leave the biome first          -> the settlement is ended by a
//     biome-specific catastrophe (catastrophe.js), staged behind the player.
//
// Only the current biome's city is ever live, so the cost is one city + one
// crowd at a time. Nothing persists: re-entering a biome founds a fresh people.

import * as THREE from 'three';
import { LANDING_DIR } from './config.js';
import { biomeAt } from './biomes.js';
import { createCityLife } from './citylife.js';
import { createCatastrophe } from './catastrophe.js';
import { setStructureResolver } from './walk.js';

// biome -> city style + the disaster that ends it
const BIOME_SPEC = {
  forest: { style: 'verdantTerrace', kind: 'fire' },
  desert: { style: 'dustOutpost', kind: 'meteor' },
  alpine: { style: 'frostHaven', kind: 'avalanche' },
  plains: { style: 'neonMetropolis', kind: 'flood' },
};

const ACTIVATE_DIST = 135;   // surface units: how near the site wakes the colony
const DEACTIVATE_DIST = 260; // wandering this far also counts as leaving
const AFTER_LAUNCH_HOLD = 4; // seconds the emptied city lingers after an ark departs

function hashDir(d) {
  return (Math.imul((d.x * 9973) | 0, 0x9e3779b1) ^
          Math.imul((d.y * 8161) | 0, 0x85ebca77) ^
          Math.imul((d.z * 7027) | 0, 0xc2b2ae35)) >>> 0;
}

// Pick one walkable site per biome by scanning Fibonacci-sphere directions:
// dry land, off the poles, in a reachable band that clears the spawn content
// disc. Scoring favours a strong biome match but weights proximity heavily so
// the settlements are discoverable rather than half a world away. Alpine has no
// tall-enough peaks on this planet (biomeAt never returns it), so the coldest
// "alpine" town is founded on the highest ground found instead.
function scanSites(planet) {
  const spawn = LANDING_DIR.clone().normalize();
  const N = 6000;
  const weighted = ['forest', 'desert', 'plains'];
  const best = {}; // biome -> { dir, w, dist, score }
  let highest = null; // { dir, g, dist } — tallest ground, for the alpine town
  const ga = Math.PI * (3 - Math.sqrt(5));
  const d = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = ga * i;
    d.set(Math.cos(th) * r, y, Math.sin(th) * r);
    if (Math.abs(d.y) > 0.7) continue; // avoid polar ice
    const g = planet.groundAtLocal(d);
    if (g < 4) continue; // dry land with some relief only
    const dot = Math.min(Math.max(d.dot(spawn), -1), 1);
    const dist = Math.acos(dot) * planet.radius;
    if (dist < 250 || dist > 900) continue; // reachable, clear of the ~230u content disc
    const b = biomeAt(d);
    for (const biome of weighted) {
      const w = b[biome];
      if (w < 0.45) continue;
      const score = w * 400 - dist; // strong match, but strongly prefer nearer
      if (!best[biome] || score > best[biome].score) best[biome] = { dir: d.clone(), w, dist, score };
    }
    // tallest ground (prefer nearer among near-equal heights) for the alpine town
    if (!highest || g - dist * 0.004 > highest.g - highest.dist * 0.004) highest = { dir: d.clone(), g, dist };
  }
  const sites = [];
  for (const biome of weighted) {
    const b = best[biome];
    if (!b) continue;
    sites.push({ biome, dir: b.dir, style: BIOME_SPEC[biome].style, kind: BIOME_SPEC[biome].kind, seed: hashDir(b.dir) });
  }
  if (highest) {
    sites.push({ biome: 'alpine', dir: highest.dir, style: BIOME_SPEC.alpine.style, kind: BIOME_SPEC.alpine.kind, seed: hashDir(highest.dir) });
  }
  return sites;
}

function surfaceDist(planet, aDir, bDir) {
  const dot = Math.min(Math.max(aDir.dot(bDir), -1), 1);
  return Math.acos(dot) * planet.radius;
}

export function initBiomeCivs(planet, opts = {}) {
  const notify = opts.notify || (() => {});
  const sites = scanSites(planet);
  let active = null;    // { site, biome, life, phase, doneTimer, cata }
  let cooldown = null;  // a just-ended site: won't re-found until the player leaves and returns

  const _pdir = new THREE.Vector3();

  function activate(site) {
    const life = createCityLife(planet, site.dir, {
      styleName: site.style,
      seed: site.seed,
      radius: 150,
      cityId: 'civ-' + site.biome,
      onEvent: (e) => {
        if (!active) return;
        if (e.type === 'ascend' && active.phase === 'growing') {
          active.life.beginLaunch();
          active.phase = 'launching';
          active.doneTimer = AFTER_LAUNCH_HOLD;
          notify(`The ${site.biome} people ascend — an ark rises from the spaceport!`);
        } else if (e.type === 'age') {
          notify(`The ${site.biome} settlement grows into a ${e.name}.`);
        }
      },
    });
    active = { site, biome: site.biome, life, phase: 'growing', doneTimer: AFTER_LAUNCH_HOLD, cata: null };
    setStructureResolver(life.structureResolver); // let the walker enter its buildings
    notify(`A people stir in the ${site.biome}…`);
  }

  function startCatastrophe(st) {
    st.life.freeze();
    st.cata = createCatastrophe(st.life, st.site.kind, null);
    st.phase = 'catastrophe';
    notify(`You leave, and the ${st.biome} is lost to ${st.site.kind}.`);
  }

  function endActive() {
    if (!active) return;
    cooldown = active.site; // don't instantly re-found the same spot
    setStructureResolver(null);
    if (active.cata) active.cata.dispose();
    active.life.dispose();
    active = null;
  }

  // Nearest talkable citizen to the player (world pos), or null. Only the
  // active city's crowd speaks, and only while it's alive (not mid-catastrophe).
  const _tl = new THREE.Vector3();
  function talkTarget(playerWorldPos) {
    if (!active || active.phase === 'catastrophe') return null;
    const life = active.life;
    const lp = life.worldToLocal(playerWorldPos);
    _tl.copy(lp);
    const c = life.crowd.nearestInteractable({ x: _tl.x, z: _tl.z }, 3.4);
    return c ? { citizen: c, life } : null;
  }

  // dt seconds, t elapsed seconds, playerWorldPos THREE.Vector3
  function update(dt, t, playerWorldPos) {
    _pdir.copy(playerWorldPos).normalize();

    if (active) {
      const st = active;
      st.life.update(dt, playerWorldPos);
      if (st.phase === 'growing') {
        // Leaving the settlement's area (distance-based, so it also works for
        // the alpine peak town, which biomeAt doesn't classify as alpine).
        const d = surfaceDist(planet, _pdir, st.site.dir);
        if (d > DEACTIVATE_DIST) startCatastrophe(st);
      } else if (st.phase === 'launching') {
        if (st.life.launchDone) {
          st.doneTimer -= dt;
          if (st.doneTimer <= 0) endActive();
        }
      } else if (st.phase === 'catastrophe') {
        st.cata.update(dt);
        if (st.cata.finished) endActive();
      }
      return;
    }

    // clear the cooldown once the player has wandered away from the ruins
    if (cooldown && surfaceDist(planet, _pdir, cooldown.dir) > DEACTIVATE_DIST) cooldown = null;

    // idle: wake the nearest settlement seed the player has walked up to
    let nearest = null, nd = ACTIVATE_DIST;
    for (const s of sites) {
      if (s === cooldown) continue;
      const d = surfaceDist(planet, _pdir, s.dir);
      if (d < nd) { nd = d; nearest = s; }
    }
    if (nearest) activate(nearest);
  }

  function dispose() { endActive(); }

  // Compass markers so the player can find the settlements out in the wilds
  // (they sit beyond the content disc, so without a heading cue they're easy
  // to miss). Reuses world.js's compass strip.
  function compassEntries() {
    const label = { forest: 'Forest town', desert: 'Desert town', alpine: 'Peak town', plains: 'Plains city' };
    return sites.map((s) => {
      const g = planet.groundAtLocal(s.dir);
      const pos = s.dir.clone().multiplyScalar(planet.radius + g + 8);
      return { name: label[s.biome] || s.biome, pos };
    });
  }

  const controller = {
    sites,
    update,
    dispose,
    getActive: () => active,
    talkTarget,
    compassEntries,
  };

  // Debug hooks for headless verification.
  if (typeof window !== 'undefined') {
    window.__biomeCivs = {
      sites: () => sites.map((s) => ({ biome: s.biome, dir: s.dir.toArray(), dist: surfaceDist(planet, LANDING_DIR.clone().normalize(), s.dir) })),
      active: () => (active ? { biome: active.biome, phase: active.phase, development: active.life.development, population: active.life.population, age: active.life.ageName } : null),
      forceActivate: (biome) => { const s = sites.find((x) => x.biome === biome); if (s) { endActive(); activate(s); } return !!s; },
      siteDir: (biome) => { const s = sites.find((x) => x.biome === biome); return s ? s.dir.toArray() : null; },
    };
  }

  return controller;
}
