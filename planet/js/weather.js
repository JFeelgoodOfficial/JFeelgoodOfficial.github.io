// weather.js — a Morrowind-style dynamic weather system for the planet.
//
// The sky is never static: it drifts between clear, cloudy, overcast, fog, rain
// and thunderstorm, and the far biomes get their own tempers — sandstorms on the
// desert, snowfall on the peaks. Each state is a set of targets (cloud cover,
// sun/ambient strength, fog range + colour, a sky tint, and a precipitation
// type) that the system eases toward, so weather rolls in and clears off rather
// than snapping. The state that comes next is biased by the biome the player is
// standing in, exactly like Morrowind's regional weather. Rain and snow fall as
// particles around the camera, and storms flash with lightning.
//
// It drives things already in the scene: THREE.Fog, the planet's cloud-cover
// uniform, the sun DirectionalLight + HemisphereLight the town/foliage are lit
// by, and the skydome gradient. (The planet surface uses its own shader, so its
// albedo doesn't darken — the fog, clouds, particles and light do the work.)

import * as THREE from 'three';
import { biomeAt } from './biomes.js';
import { showHint } from './hud.js';

const STATES = {
  clear: { cloud: 0.20, sun: 2.2, hemi: 0.50, fogNear: 320, fogFar: 1650, fog: 0x171021, sky: 0x000000, skyMix: 0.0, precip: 'none', hint: 'The skies are clear.' },
  cloudy: { cloud: 0.50, sun: 1.75, hemi: 0.50, fogNear: 230, fogFar: 1300, fog: 0x1b1b26, sky: 0x8a8f9a, skyMix: 0.18, precip: 'none', hint: 'Clouds are gathering.' },
  overcast: { cloud: 0.86, sun: 1.10, hemi: 0.44, fogNear: 160, fogFar: 980, fog: 0x2b2d35, sky: 0x6a6e78, skyMix: 0.45, precip: 'none', hint: 'The sky greys over.' },
  foggy: { cloud: 0.62, sun: 1.25, hemi: 0.52, fogNear: 26, fogFar: 330, fog: 0x9aa0a8, sky: 0xb4bcc6, skyMix: 0.5, precip: 'none', hint: 'A thick fog rolls in.' },
  rain: { cloud: 0.92, sun: 0.85, hemi: 0.44, fogNear: 120, fogFar: 760, fog: 0x30343c, sky: 0x565a63, skyMix: 0.5, precip: 'rain', precipI: 0.7, hint: 'Rain begins to fall.' },
  storm: { cloud: 1.00, sun: 0.55, hemi: 0.38, fogNear: 90, fogFar: 540, fog: 0x22242c, sky: 0x3a3d45, skyMix: 0.62, precip: 'rain', precipI: 1.0, lightning: true, hint: 'A thunderstorm breaks overhead.' },
  sandstorm: { cloud: 0.55, sun: 1.05, hemi: 0.62, fogNear: 18, fogFar: 220, fog: 0xc9a878, sky: 0xcaa06a, skyMix: 0.7, precip: 'dust', precipI: 1.0, hint: 'A sandstorm sweeps across the dunes.' },
  snow: { cloud: 0.85, sun: 1.50, hemi: 0.62, fogNear: 80, fogFar: 600, fog: 0xcdd6e0, sky: 0xbcc6d2, skyMix: 0.55, precip: 'snow', precipI: 0.85, hint: 'Snow drifts down over the heights.' },
};

// biome -> pool of plausible next states (weighted by repetition)
const POOLS = {
  desert: ['clear', 'clear', 'cloudy', 'sandstorm', 'overcast', 'sandstorm'],
  alpine: ['clear', 'cloudy', 'overcast', 'snow', 'snow', 'foggy'],
  forest: ['clear', 'clear', 'cloudy', 'overcast', 'rain', 'storm', 'foggy'],
  plains: ['clear', 'clear', 'cloudy', 'overcast', 'rain', 'storm', 'foggy'],
};

const N = 1000;         // particle count
const BOX = 90;         // half-size of the particle box around the camera

function buildPrecip(scene) {
  // rain / dust as line streaks; snow as points
  const linePos = new Float32Array(N * 2 * 3);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
  const lineMat = new THREE.LineBasicMaterial({ color: 0x9fb0c8, transparent: true, opacity: 0.5, depthWrite: false });
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  lines.frustumCulled = false; lines.renderOrder = 3; lines.visible = false;

  const ptPos = new Float32Array(N * 3);
  const ptGeo = new THREE.BufferGeometry();
  ptGeo.setAttribute('position', new THREE.BufferAttribute(ptPos, 3));
  const ptMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.7, sizeAttenuation: true, transparent: true, opacity: 0.85, depthWrite: false });
  const points = new THREE.Points(ptGeo, ptMat);
  points.frustumCulled = false; points.renderOrder = 3; points.visible = false;

  scene.add(lines); scene.add(points);

  // per-particle offsets within the box (relative to the camera)
  const off = [];
  for (let i = 0; i < N; i++) off.push(new THREE.Vector3((Math.random() * 2 - 1) * BOX, (Math.random() * 2 - 1) * BOX, (Math.random() * 2 - 1) * BOX));

  const _down = new THREE.Vector3(), _wind = new THREE.Vector3(), _ref = new THREE.Vector3(), _w = new THREE.Vector3();
  let mode = 'none', intensity = 0;

  function set(m, inten) {
    mode = m; intensity = inten || 0;
    lines.visible = (m === 'rain' || m === 'dust') && intensity > 0.02;
    points.visible = m === 'snow' && intensity > 0.02;
    if (m === 'rain') { lineMat.color.setHex(0x9fb0c8); lineMat.opacity = 0.5; }
    else if (m === 'dust') { lineMat.color.setHex(0xcaa878); lineMat.opacity = 0.42; }
  }

  function update(dt, camPos, up) {
    if (mode === 'none' || intensity < 0.02) return;
    _down.copy(up).multiplyScalar(-1);
    // a stable tangent wind direction
    _ref.set(0, 1, 0); if (Math.abs(up.y) > 0.9) _ref.set(1, 0, 0);
    _wind.crossVectors(up, _ref).normalize();
    const fall = mode === 'rain' ? 60 : mode === 'snow' ? 6 : 3;
    const windSpd = mode === 'dust' ? 55 : mode === 'snow' ? 3 : 8;
    const streak = mode === 'rain' ? 2.2 : 3.0;
    const count = Math.max(1, Math.floor(N * intensity));

    const lp = lines.geometry.attributes.position.array;
    const pp = points.geometry.attributes.position.array;
    for (let i = 0; i < count; i++) {
      const o = off[i];
      o.addScaledVector(_down, fall * dt);
      o.addScaledVector(_wind, windSpd * dt);
      // wrap back into the box (relative to the moving camera)
      if (o.x > BOX) o.x -= 2 * BOX; else if (o.x < -BOX) o.x += 2 * BOX;
      if (o.y > BOX) o.y -= 2 * BOX; else if (o.y < -BOX) o.y += 2 * BOX;
      if (o.z > BOX) o.z -= 2 * BOX; else if (o.z < -BOX) o.z += 2 * BOX;
      const wx = camPos.x + o.x, wy = camPos.y + o.y, wz = camPos.z + o.z;
      if (mode === 'snow') {
        pp[i * 3] = wx; pp[i * 3 + 1] = wy; pp[i * 3 + 2] = wz;
      } else {
        // streak trailing opposite the fall (+ wind for dust)
        _w.copy(mode === 'dust' ? _wind : _down).multiplyScalar(-streak);
        const b = i * 6;
        lp[b] = wx; lp[b + 1] = wy; lp[b + 2] = wz;
        lp[b + 3] = wx + _w.x; lp[b + 4] = wy + _w.y; lp[b + 5] = wz + _w.z;
      }
    }
    if (mode === 'snow') { points.geometry.setDrawRange(0, count); points.geometry.attributes.position.needsUpdate = true; }
    else { lines.geometry.setDrawRange(0, count * 2); lines.geometry.attributes.position.needsUpdate = true; }
  }

  function dispose() { lineGeo.dispose(); lineMat.dispose(); ptGeo.dispose(); ptMat.dispose(); scene.remove(lines); scene.remove(points); }
  return { set, update, dispose };
}

export function createWeather({ scene, planet, sun, hemi, camera }) {
  const precip = buildPrecip(scene);

  // base values to blend against
  const baseFog = scene.fog ? scene.fog.color.clone() : new THREE.Color(0x171021);
  const baseHorizon = planet.sky.material.uniforms.uHorizon.value.clone();
  const baseZenith = planet.sky.material.uniforms.uZenith.value.clone();
  const baseSun = sun.intensity, baseHemi = hemi.intensity;

  // current (eased) + target parameters
  function paramsOf(s) {
    return { cloud: s.cloud, sun: s.sun, hemi: s.hemi, fogNear: s.fogNear, fogFar: s.fogFar,
      fog: new THREE.Color(s.fog), sky: new THREE.Color(s.sky), skyMix: s.skyMix,
      precip: s.precip, precipI: s.precipI || 0, lightning: !!s.lightning };
  }
  let cur = paramsOf(STATES.clear);
  let target = cur;
  let stateName = 'clear';
  let timer = 18 + Math.random() * 30; // seconds until the next change
  let flash = 0, flashCooldown = 0;
  let started = false;

  const _cam = new THREE.Vector3(), _up = new THREE.Vector3();
  const _fogTmp = new THREE.Color(), _hTmp = new THREE.Color(), _zTmp = new THREE.Color();

  function pickNext() {
    camera.getWorldPosition(_cam);
    _up.copy(_cam).normalize();
    let pool = POOLS.forest;
    try {
      const b = biomeAt(_up);
      // dominant biome by weight
      let best = 'forest', bw = -1;
      for (const k of ['forest', 'desert', 'plains', 'alpine']) if ((b[k] || 0) > bw) { bw = b[k] || 0; best = k; }
      pool = POOLS[best] || POOLS.forest;
    } catch (e) { /* keep default */ }
    let next = pool[Math.floor(Math.random() * pool.length)];
    if (next === stateName) next = pool[Math.floor(Math.random() * pool.length)]; // avoid immediate repeat
    stateName = next;
    target = paramsOf(STATES[next]);
    timer = 24 + Math.random() * 46;
    if (started) showHint(STATES[next].hint);
  }

  function update(dt, t) {
    started = true;
    timer -= dt;
    if (timer <= 0) pickNext();

    // ease current toward target
    const k = Math.min(1, dt * 0.35);
    cur.cloud += (target.cloud - cur.cloud) * k;
    cur.sun += (target.sun - cur.sun) * k;
    cur.hemi += (target.hemi - cur.hemi) * k;
    cur.fogNear += (target.fogNear - cur.fogNear) * k;
    cur.fogFar += (target.fogFar - cur.fogFar) * k;
    cur.skyMix += (target.skyMix - cur.skyMix) * k;
    cur.precipI += ((target.precip === cur.precip ? target.precipI : 0) - cur.precipI) * k;
    cur.fog.lerp(target.fog, k);
    cur.sky.lerp(target.sky, k);
    // switch precip type once the old one has faded out
    if (cur.precip !== target.precip && cur.precipI < 0.03) { cur.precip = target.precip; cur.precipI = 0; }

    // lightning during storms
    let lightBoost = 0;
    if (target.lightning && cur.cloud > 0.85) {
      flashCooldown -= dt;
      if (flashCooldown <= 0 && Math.random() < dt * 0.5) { flash = 1; flashCooldown = 2 + Math.random() * 6; }
    }
    if (flash > 0) { lightBoost = flash; flash = Math.max(0, flash - dt * 4); }

    // apply fog
    if (scene.fog) {
      scene.fog.near = cur.fogNear;
      scene.fog.far = cur.fogFar;
      _fogTmp.copy(cur.fog); if (lightBoost > 0) _fogTmp.lerp(new THREE.Color(0xffffff), lightBoost * 0.4);
      scene.fog.color.copy(_fogTmp);
    }
    // clouds
    if (planet.clouds?.material?.uniforms?.uCover) planet.clouds.material.uniforms.uCover.value = cur.cloud;
    // lights (town/foliage/vehicles are lit by these)
    sun.intensity = (baseSun / 2.2) * cur.sun;
    hemi.intensity = (baseHemi / 0.5) * cur.hemi + lightBoost * 1.6;
    // sky tint
    _hTmp.copy(baseHorizon).lerp(cur.sky, Math.min(1, cur.skyMix * 0.7));
    _zTmp.copy(baseZenith).lerp(cur.sky, Math.min(1, cur.skyMix * 0.8));
    if (lightBoost > 0) { _hTmp.lerp(new THREE.Color(0xffffff), lightBoost * 0.5); _zTmp.lerp(new THREE.Color(0xffffff), lightBoost * 0.4); }
    planet.sky.material.uniforms.uHorizon.value.copy(_hTmp);
    planet.sky.material.uniforms.uZenith.value.copy(_zTmp);

    // precipitation particles around the camera
    camera.getWorldPosition(_cam); _up.copy(_cam).normalize();
    precip.set(cur.precip, cur.precipI);
    precip.update(dt, _cam, _up);
  }

  const api = {
    update,
    dispose() { precip.dispose(); },
    get state() { return stateName; },
    // debug / manual control
    force(name) { if (STATES[name]) { stateName = name; target = paramsOf(STATES[name]); timer = 30; showHint(STATES[name].hint); } },
  };
  if (typeof window !== 'undefined' && window.__debug) window.__debug.weather = api;
  return api;
}
