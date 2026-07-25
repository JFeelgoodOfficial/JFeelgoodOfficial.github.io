// biomeCivs.js — the settlements layer. The planet no longer grows and destroys
// transient colonies; instead it holds a PERMANENT population:
//
//   * one permanent city, Bloomhaven, on the forest / mainland biome — people
//     living purposefully around a light economy (farming, gardens, market,
//     bakery, perfumery, a town hall) with tall residential towers you ride up
//     by elevator (city/town.js + economy.js);
//   * a small science outpost in each far biome (desert / alpine / plains),
//     a handful of scientists studying the terrain (city/outpost.js).
//
// Everything is built once at startup and persists. This module keeps the same
// public surface world.js already consumes: initBiomeCivs() ->
// { update, dispose, talkTarget, compassEntries }.

import * as THREE from 'three';
import { LANDING_DIR, SUN } from './config.js';
import { biomeAt } from './biomes.js';
import { createTown } from './city/town.js';
import { createOutpost } from './city/outpost.js';
import { createCrowd } from './city/aliens.js';
import { createEconomy, SCHEMA } from './economy.js';
import { addStructureResolver, removeStructureResolver, addCollider } from './walk.js';
import { addInteractable } from './interact.js';
import { showCard } from './hud.js';

const CITY_NAME = 'Bloomhaven';
const CROWD_UPDATE_DIST = 420; // only tick a settlement's crowd when the player is this near

function hashDir(d) {
  return (Math.imul((d.x * 9973) | 0, 0x9e3779b1) ^
          Math.imul((d.y * 8161) | 0, 0x85ebca77) ^
          Math.imul((d.z * 7027) | 0, 0xc2b2ae35)) >>> 0;
}

function surfaceDist(planet, aDir, bDir) {
  const dot = Math.min(Math.max(aDir.dot(bDir), -1), 1);
  return Math.acos(dot) * planet.radius;
}

// Pick one walkable site per biome (dry land, off the poles, in a reachable band
// clear of the spawn content disc). The forest site hosts the permanent city;
// desert/alpine/plains host outposts. Alpine falls back to the highest ground.
function scanSites(planet) {
  const spawn = LANDING_DIR.clone().normalize();
  const N = 6000;
  const weighted = ['forest', 'desert', 'plains'];
  const best = {};
  let highest = null;
  const ga = Math.PI * (3 - Math.sqrt(5));
  const d = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = ga * i;
    d.set(Math.cos(th) * r, y, Math.sin(th) * r);
    if (Math.abs(d.y) > 0.7) continue;
    const g = planet.groundAtLocal(d);
    if (g < 4) continue;
    const dot = Math.min(Math.max(d.dot(spawn), -1), 1);
    const dist = Math.acos(dot) * planet.radius;
    if (dist < 250 || dist > 900) continue;
    const b = biomeAt(d);
    for (const biome of weighted) {
      const w = b[biome];
      if (w < 0.45) continue;
      const score = w * 400 - dist;
      if (!best[biome] || score > best[biome].score) best[biome] = { dir: d.clone(), w, dist, score };
    }
    if (!highest || g - dist * 0.004 > highest.g - highest.dist * 0.004) highest = { dir: d.clone(), g, dist };
  }
  const sites = [];
  for (const biome of weighted) {
    const b = best[biome];
    if (!b) continue;
    sites.push({ biome, dir: b.dir, seed: hashDir(b.dir) });
  }
  if (highest) sites.push({ biome: 'alpine', dir: highest.dir, seed: hashDir(highest.dir) });
  return sites;
}

// Roster of roles for the city crowd, sized to the economy's worker demand and
// padded with residents. Deterministic given the seed.
function assignRoles(counts, population, seed) {
  const demand = [];
  const roleOf = { farm_plot: 'farmer', garden_plot: 'gardener', bakery: 'artisan', perfumery: 'artisan', market_stall: 'merchant', town_hall: 'caretaker' };
  for (const [b, n] of Object.entries(counts)) for (let k = 0; k < n; k++) demand.push(roleOf[b]);
  const roles = [];
  for (let i = 0; i < population; i++) roles.push(demand[i] || 'resident');
  // deterministic shuffle so workers aren't all the first rigs
  let a = seed >>> 0;
  for (let i = population - 1; i > 0; i--) {
    a = (Math.imul(a ^ (a >>> 15), 1 | a) + 0x6D2B79F5) | 0;
    const j = (a >>> 0) % (i + 1);
    const t = roles[i]; roles[i] = roles[j]; roles[j] = t;
  }
  return roles;
}

export function initBiomeCivs(planet, opts = {}) {
  const notify = opts.notify || (() => {});
  const sites = scanSites(planet);

  // shared adapter: town/outpost generators read planet.body.groundAtLocal + planet.water.r
  const cityPlanet = {
    surface: planet.surface,
    radius: planet.radius,
    body: { groundAtLocal: planet.groundAtLocal, groundAt: planet.groundAtLocal },
    water: { r: planet.seaR },
  };

  const settlements = [];
  let citySettlement = null;

  const _lp = new THREE.Vector3();
  const _sp = new THREE.Vector3();

  function makeSettlement(gen, kind, biome, seed, cfg) {
    const invQuat = gen.quaternion.clone().invert();
    const worldToLocal = (worldPos) => _lp.copy(worldPos).sub(gen.position).applyQuaternion(invQuat);
    const sunDot = SUN.clone().normalize().dot(gen.center ? gen.center.clone().normalize() : new THREE.Vector3(0, 1, 0));

    // crowd
    const crowd = createCrowd(
      { cityId: kind + ':' + biome, groundHeightAt: gen.groundLocalYAt, plazaCenters: gen.plazaCenters, colliders: gen.collidersLocal },
      { cityId: kind + ':' + biome, seed, population: cfg.population, maxRigs: cfg.maxRigs, questChance: 0, culture: cfg.culture },
    );
    gen.group.add(crowd.group);
    planet.surface.add(gen.group);

    // player-solid colliders (convert local -> world once)
    for (const c of gen.colliders) {
      const world = gen.localToWorld(new THREE.Vector3(c.x, 0, c.z));
      addCollider(world, c.radius);
    }

    // role map (city only) + life object for dialogue
    const roles = kind === 'city'
      ? assignRoles(cfg.economy.counts, cfg.population, seed)
      : null;
    const roleMap = new Map();
    if (roles) crowd.citizens.forEach((c, i) => roleMap.set(c, roles[i]));
    const life = {
      kind, biome, name: cfg.name || biome,
      economy: cfg.economy || null,
      roleOf: (c) => (roleMap.get(c) || (kind === 'outpost' ? 'scientist' : 'resident')),
    };

    // interaction points
    for (const ip of gen.infoPoints) registerInfoPoint(gen, ip, life);

    const st = { gen, kind, biome, crowd, economy: cfg.economy || null, worldToLocal, sunDot, life };
    settlements.push(st);
    if (kind === 'city') citySettlement = st;
    return st;
  }

  function registerInfoPoint(gen, ip, life) {
    const pos = gen.localToWorld(ip.local.clone());
    let prompt = ip.prompt;
    let action;
    if (ip.kind === 'elevator-up') { action = () => ip.lift.callTop(); prompt = 'Ride the elevator up'; }
    else if (ip.kind === 'elevator-down') { action = () => ip.lift.callBottom(); prompt = 'Ride the elevator down'; }
    else action = () => showCard(infoCard(ip.kind, life));
    addInteractable({ pos, radius: ip.radius, prompt: `${prompt} &nbsp; <b>E</b>`, action });
  }

  // Live info cards drawn from the economy for the city's civic buildings.
  function infoCard(kind, life) {
    const e = life.economy;
    if (kind === 'townhall' && e) {
      return {
        kicker: `${CITY_NAME} · town hall`,
        title: 'A settled, purposeful town',
        meta: `${e.season} · happiness ${e.happinessPct}%`,
        body: `The people of ${CITY_NAME} live here on purpose — farming the river terraces, tending the flower gardens, baking and blending perfume, and trading it all at the market. Treasury: ${e.currency} coin · civic tax pool: ${e.taxPool}. Land value rises with every garden in bloom (${e.bloomPoints} bloom).`,
      };
    }
    if (kind === 'market' && e) {
      return {
        kicker: `${CITY_NAME} · market`,
        title: 'The trading heart',
        meta: `${e.season}`,
        body: `Stalls turn produce and goods into coin: bread ${e.stockpile('bread')}, perfume ${e.stockpile('perfume')}, crop ${e.stockpile('crop')}, flower ${e.stockpile('flower')} in stock. Right now, ${e.activity()}.`,
      };
    }
    if (kind === 'gardens' && e) {
      return {
        kicker: `${CITY_NAME} · gardens`,
        title: 'Beautiful gardens',
        meta: `${e.bloomPoints} bloom points`,
        body: `Rows of flowers feed the perfumery and lift the whole town's spirits. Seasonal yield now: flowers ×${(SCHEMA.seasonalModifiers[e.season]?.flower ?? 1)}.`,
      };
    }
    return {
      kicker: CITY_NAME,
      title: kind === 'bakery' ? 'The bakery' : kind === 'perfumery' ? 'The perfumery' : 'Research station',
      meta: e ? e.season : life.biome,
      body: kind === 'bakery'
        ? 'Crop from the farms becomes bread here, sold on at the market.'
        : kind === 'perfumery'
          ? 'Flowers and dye are blended into perfume — the town\'s finest export.'
          : `A small science outpost in the ${life.biome}. A few researchers study the terrain and weather far from the mainland.`,
    };
  }

  // ---- build everything once ----------------------------------------------
  for (const site of sites) {
    if (site.biome === 'forest') {
      const town = createTown(cityPlanet, site.dir, { seed: site.seed, radius: 150 });
      const economy = createEconomy({ seed: site.seed });
      makeSettlement(town, 'city', 'forest', site.seed, {
        name: CITY_NAME, population: 44, maxRigs: 16, economy, culture: null,
      });
      // one structure resolver, bound to the town (only settlement with interiors)
      installTownResolver(citySettlement);
      notify(`${CITY_NAME} lies out in the forest — a permanent town of farmers, gardeners and traders. Follow the compass.`);
    } else {
      const outpost = createOutpost(cityPlanet, site.dir, { seed: site.seed, biome: site.biome });
      makeSettlement(outpost, 'outpost', site.biome, site.seed, {
        population: 3, maxRigs: 3, culture: 'scholarly',
      });
    }
  }

  function installTownResolver(st) {
    const gen = st.gen;
    const resolver = {
      wall(playerWorld) {
        if (!gen.structures.length) return;
        const lp = st.worldToLocal(playerWorld).clone();
        let moved = false;
        for (const s of gen.structures) if (s.resolveWalls && s.resolveWalls(lp, 0.4)) moved = true;
        if (moved) playerWorld.copy(gen.localToWorld(lp));
      },
      floor(playerWorld) {
        if (!gen.structures.length) return -Infinity;
        const lp = st.worldToLocal(playerWorld).clone();
        let bestY = null;
        for (const s of gen.structures) {
          const y = s.surfaceYAt(lp.x, lp.z, lp.y);
          if (y !== null && (bestY === null || y > bestY)) bestY = y;
        }
        if (bestY === null) return -Infinity;
        _sp.set(lp.x, bestY, lp.z);
        return gen.localToWorld(_sp.clone()).length();
      },
    };
    st._resolver = resolver;
    addStructureResolver(resolver);
  }

  // ---- per-frame -----------------------------------------------------------
  const _pdir = new THREE.Vector3();
  const _pp = { x: 0, z: 0 };
  let elapsed = 0;
  function update(dt, t, playerWorldPos) {
    elapsed += dt;
    _pdir.copy(playerWorldPos).normalize();
    for (const st of settlements) {
      if (st.economy) st.economy.step(dt);   // cheap: keep the town's clock/seasons turning everywhere
      st.gen.update(dt, elapsed);             // waterwheel, elevators, beacons
      const near = surfaceDist(planet, _pdir, st.gen.center ? st.gen.center.clone().normalize() : _pdir) < CROWD_UPDATE_DIST
        || playerWorldPos.distanceTo(st.gen.position) < CROWD_UPDATE_DIST;
      if (near) {
        const lp = st.worldToLocal(playerWorldPos);
        _pp.x = lp.x; _pp.z = lp.z;
        st.crowd.update(dt, _pp, st.sunDot);
      }
    }
  }

  // Nearest talkable citizen across whichever settlement the player is in.
  function talkTarget(playerWorldPos) {
    for (const st of settlements) {
      if (playerWorldPos.distanceTo(st.gen.position) > CROWD_UPDATE_DIST) continue;
      const lp = st.worldToLocal(playerWorldPos);
      const c = st.crowd.nearestInteractable({ x: lp.x, z: lp.z }, 3.4);
      if (c) return { citizen: c, life: st.life };
    }
    return null;
  }

  function compassEntries() {
    const label = { forest: CITY_NAME, desert: 'Desert outpost', alpine: 'Peak outpost', plains: 'Plains outpost' };
    return sites.map((s) => {
      const g = planet.groundAtLocal(s.dir);
      const pos = s.dir.clone().multiplyScalar(planet.radius + g + 8);
      return { name: label[s.biome] || s.biome, pos };
    });
  }

  function dispose() {
    for (const st of settlements) {
      if (st._resolver) removeStructureResolver(st._resolver);
      st.crowd.dispose(); st.gen.dispose();
      if (st.gen.group.parent) st.gen.group.parent.remove(st.gen.group);
    }
    settlements.length = 0;
  }

  const controller = {
    sites, update, dispose, talkTarget, compassEntries,
    debugCity: () => citySettlement,
  };

  if (typeof window !== 'undefined') {
    window.__biomeCivs = {
      sites: () => sites.map((s) => ({ biome: s.biome, dist: surfaceDist(planet, LANDING_DIR.clone().normalize(), s.dir) })),
      siteDir: (biome) => { const s = sites.find((x) => x.biome === biome); return s ? s.dir.toArray() : null; },
      settlements: () => settlements.map((s) => ({ kind: s.kind, biome: s.biome, pop: s.crowd.count })),
      city: () => citySettlement,
      economy: () => (citySettlement ? {
        season: citySettlement.economy.season,
        currency: citySettlement.economy.currency,
        bloom: citySettlement.economy.bloomPoints,
        happiness: citySettlement.economy.happinessPct,
        crop: citySettlement.economy.stockpile('crop'),
        bread: citySettlement.economy.stockpile('bread'),
        perfume: citySettlement.economy.stockpile('perfume'),
      } : null),
    };
  }

  return controller;
}
