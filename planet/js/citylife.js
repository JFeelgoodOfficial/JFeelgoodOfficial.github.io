// citylife.js — binds one procedural city (city/city.js) to one colony sim
// (civsim.js) and makes the two move together: every frame the sim advances,
// its `development` drives the city's in-place growth (huts -> skyscrapers),
// and its `population` drives how many citizens walk the streets. When the
// colony reaches its top age a spaceport rises, ready for the triumphant ark
// launch (beginLaunch), the counterpart to the biome catastrophes.

import * as THREE from 'three';
import { createCity, CITY_STYLES } from './city/city.js';
import { createCrowd } from './city/aliens.js';
import { createCivSim } from './civsim.js';
import { SUN } from './config.js';

const CROWD_CAP = 60;   // matches civsim POP_CAP
const CROWD_RIGS = 18;  // articulated rigs near the player

export function createCityLife(planet, worldUp, opts = {}) {
  const { styleName, seed = 1, radius = 150, cityId = 'city', onEvent } = opts;
  const style = CITY_STYLES.find((s) => s.name === styleName) || null;

  // Adapter: the game's city generator reads planet.body.groundAtLocal and
  // planet.water.r; the jfeelgood planet exposes groundAtLocal and seaR.
  const cityPlanet = {
    surface: planet.surface,
    radius: planet.radius,
    body: { groundAtLocal: planet.groundAtLocal, groundAt: planet.groundAtLocal },
    water: { r: planet.seaR },
  };

  const city = createCity(cityPlanet, worldUp, { radius, seed, style, development: 0 });
  planet.surface.add(city.group);

  const sim = createCivSim({ seed, onEvent });

  // Crowd lives in the city's local (flat) frame, so it's parented to the city
  // group and fed city-local ground + waypoints.
  const crowdHost = {
    cityId,
    groundHeightAt: (x, z) => city.groundLocalYAt(x, z),
    plazaCenters: city.plazaCenters,
    colliders: city.collidersLocal,
  };
  const crowd = createCrowd(crowdHost, {
    cityId, seed, population: CROWD_CAP, maxRigs: CROWD_RIGS, questChance: 0.15,
  });
  city.group.add(crowd.group);

  // Fixed sun-vs-up dot (the planet's sun doesn't move) drives the neon
  // day/night response so the skyline reads correctly for this latitude.
  const sunDot = SUN.clone().normalize().dot(worldUp.clone().normalize());

  // World <-> city-local transform (group is rotated onto the tangent plane).
  const invQuat = city.group.quaternion.clone().invert();
  const _local = new THREE.Vector3();
  const _pp = { x: 0, z: 0 };
  function worldToLocal(worldPos) {
    return _local.copy(worldPos).sub(city.group.position).applyQuaternion(invQuat);
  }
  const _q = city.group.quaternion.clone();
  const _cpos = city.group.position.clone();
  function localToWorld(v) { return v.applyQuaternion(_q).add(_cpos); }

  // Structure collision bridge: lets the planet's on-foot walker (walk.js) push
  // out of building walls and stand on interior floors, using the city's
  // makeStructure() contract (surfaceYAt/resolveWalls) in city-local space.
  // Gated on development so only the mature, actually-built lobbies + landmark
  // are solid — huts have no interiors to enter.
  const _lp = new THREE.Vector3();
  const _sp = new THREE.Vector3();
  const structureResolver = {
    wall(playerWorld) {
      if (frozen || sim.development < 0.55 || !city.structures.length) return;
      _lp.copy(worldToLocal(playerWorld));
      let moved = false;
      for (const st of city.structures) if (st.resolveWalls(_lp, 0.4)) moved = true;
      if (moved) playerWorld.copy(localToWorld(_lp.clone()));
    },
    floor(playerWorld) {
      if (frozen || sim.development < 0.55 || !city.structures.length) return -Infinity;
      _lp.copy(worldToLocal(playerWorld));
      let bestY = null;
      for (const st of city.structures) {
        const y = st.surfaceYAt(_lp.x, _lp.z, _lp.y);
        if (y !== null && (bestY === null || y > bestY)) bestY = y;
      }
      if (bestY === null) return -Infinity;
      _sp.set(_lp.x, bestY, _lp.z);
      return localToWorld(_sp.clone()).length();
    },
  };

  // --- spaceport + ark, revealed at the top age -----------------------------
  let spaceport = null;   // { group, rocket, plume }
  let launching = false;
  let launchT = 0;
  let launchDone = false;
  let frozen = false;     // set while a catastrophe plays: sim/crowd stop, shaders keep running

  function revealSpaceport() {
    if (spaceport) return;
    const pad = worldToLocal(city.boardingPad).clone(); // city-local
    const g = new THREE.Group();
    g.position.copy(pad);

    // launch ring
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0x101018, emissive: new THREE.Color(0x66ccff), emissiveIntensity: 1.4, roughness: 0.4,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(9, 0.5, 8, 40), ringMat);
    ring.rotation.x = -Math.PI / 2;
    g.add(ring);

    // two gantry towers
    const gantryMat = new THREE.MeshStandardMaterial({ color: 0x1a1d28, roughness: 0.7, metalness: 0.4 });
    for (const sx of [-7, 7]) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(1.2, 34, 1.2), gantryMat);
      t.position.set(sx, 17, 0);
      g.add(t);
    }

    // the ark: tapered body + nose cone + fins + engine glow
    const rocket = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xdfe6f2, roughness: 0.35, metalness: 0.5,
      emissive: new THREE.Color(0x223044), emissiveIntensity: 0.4,
    });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 4.2, 26, 20), bodyMat);
    body.position.y = 15;
    rocket.add(body);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(3.2, 8, 20), bodyMat);
    nose.position.y = 32;
    rocket.add(nose);
    const finMat = new THREE.MeshStandardMaterial({ color: 0x8fa0bd, roughness: 0.4, metalness: 0.6 });
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.6, 7, 4), finMat);
      const a = (i / 4) * Math.PI * 2;
      fin.position.set(Math.cos(a) * 4, 4.5, Math.sin(a) * 4);
      fin.rotation.y = -a;
      rocket.add(fin);
    }
    const plumeMat = new THREE.MeshBasicMaterial({
      color: 0x9fd8ff, transparent: true, opacity: 0.0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const plume = new THREE.Mesh(new THREE.ConeGeometry(3.4, 14, 16, 1, true), plumeMat);
    plume.rotation.x = Math.PI; // flare downward
    plume.position.y = -5;
    rocket.add(plume);

    g.add(rocket);
    city.group.add(g);
    spaceport = { group: g, rocket, plume, plumeMat };
  }

  // Kick off the ark launch (triumphant ending). Safe to call once.
  function beginLaunch() {
    if (launchDone || launching) return;
    revealSpaceport();
    launching = true;
    launchT = 0;
    if (onEvent) onEvent({ type: 'launch-begin' });
  }

  const _elapsed = { t: 0 };
  function update(dt, playerWorldPos) {
    _elapsed.t += dt;

    if (!launching && !frozen) {
      sim.step(dt);
      city.setDevelopment(sim.development);
      crowd.setActiveCount(sim.population);
      if (!spaceport && sim.development > 0.9) revealSpaceport();
    }

    // crowd + city visuals
    const lp = worldToLocal(playerWorldPos);
    _pp.x = lp.x; _pp.z = lp.z;
    if (!frozen) crowd.update(dt, _pp, sunDot);
    city.update(_elapsed.t, sunDot);

    // ark launch animation
    if (launching && spaceport) {
      launchT += dt;
      const r = spaceport.rocket;
      // 0-1s: engines light and hold; then accelerate upward, shrinking away.
      const hold = 1.2;
      spaceport.plumeMat.opacity = Math.min(launchT / 0.4, 1) * 0.85;
      if (launchT > hold) {
        const a = launchT - hold;
        r.position.y += (6 + a * a * 22) * dt; // ease into acceleration
        const s = Math.max(1 - a * 0.12, 0.05);
        r.scale.setScalar(s);
        if (a > 6 && !launchDone) {
          launchDone = true;
          if (onEvent) onEvent({ type: 'launch-done' });
        }
      }
    }
  }

  function dispose() {
    crowd.dispose();
    city.dispose(); // disposes everything under city.group, incl. spaceport
    if (city.group.parent) city.group.parent.remove(city.group);
  }

  // Halt growth/crowd (a catastrophe is playing) while keeping shaders alive.
  function freeze() { frozen = true; crowd.setActiveCount(0); }

  return {
    city, sim, crowd,
    group: city.group,
    update, dispose, beginLaunch, freeze, worldToLocal,
    structureResolver,
    boardingPad: city.boardingPad,
    get development() { return sim.development; },
    get population() { return sim.population; },
    get ageName() { return sim.ageName; },
    get topAgeReached() { return sim.topAgeReached; },
    get launchDone() { return launchDone; },
    get launching() { return launching; },
  };
}
