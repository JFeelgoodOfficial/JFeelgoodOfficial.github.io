/**
 * town.js — the permanent city: a warm, purposeful market town draped over the
 * planet's forest/mainland biome. Modeled on the concept art (a medieval market
 * town with canals, a waterwheel, market stalls, farms and flower gardens) and
 * ringed by genuinely TALL residential towers whose vertical travel is by
 * working ELEVATOR, not stairs.
 *
 * Every building here is a real room you can walk into: four walls with a
 * doorway, a walkable interior floor, furniture, and a roof. Walls are solid
 * for the player (via walk.js's structure resolver) so you enter through the
 * door and cannot pass through a wall; the townsfolk steer around buildings so
 * they never clip a wall either. Buildings are placed with a footprint reserver
 * so none overlap. Characters stand on the same analytic ground the player and
 * terrain use, so their feet stay planted.
 *
 * Coordinate model matches city.js: the returned `group` is parented to
 * planet.surface (unrotated object space); we build in a flat local X/Z frame
 * with +Y = radial up at the landing dir, orient the group so that flat grid
 * bends onto the tangent plane, and drape every element onto the real terrain.
 */

import * as THREE from 'three';
import { makeStructure } from './city.js';

const YAXIS = new THREE.Vector3(0, 1, 0);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WALL_T = 0.4;    // wall thickness
const DOOR_W = 2.6;    // doorway opening width (> 2*player radius so you fit)
const FOUND = 2.5;     // foundation skirt depth (hides slope gaps under a room)
const ELEV_SPEED = 7.0;

// shared unit geometries (scaled per instance so geometry count stays low)
const UBOX = new THREE.BoxGeometry(1, 1, 1);
const UCYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
const UCONE = new THREE.ConeGeometry(0.5, 1, 4);
const USPH = new THREE.SphereGeometry(0.5, 8, 6);

function warmWindowTexture(rng, warm = '#ffd98a') {
  const cols = 6, rows = 16, cell = 12, pad = 6;
  const w = cols * cell + pad * 2, h = rows * cell + pad * 2;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#161016'; ctx.fillRect(0, 0, w, h);
  for (let r = 0; r < rows; r++) for (let x = 0; x < cols; x++) {
    const lit = rng() < 0.55;
    ctx.fillStyle = lit ? warm : '#241c22';
    ctx.fillRect(pad + x * cell + 1.5, pad + r * cell + 1.5, cell - 3, cell - 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export function createTown(planet, worldUp, opts = {}) {
  const seed = opts.seed ?? 1;
  const rng = mulberry32(seed >>> 0);

  const group = new THREE.Group();
  group.name = 'PermanentTown';
  group.add(new THREE.HemisphereLight(0xcfe0ff, 0x4a3a2c, 1.0));

  // ---- orient + place on the surface ----
  const dirSeeded = worldUp.clone().normalize();
  const rotY = planet.surface?.rotation?.y ?? 0;
  const dirLocal = dirSeeded.clone().applyAxisAngle(YAXIS, -rotY);
  const quat = new THREE.Quaternion().setFromUnitVectors(YAXIS, dirLocal);
  group.quaternion.copy(quat);
  const groundBase = planet.body?.groundAtLocal ? planet.body.groundAtLocal(dirLocal) : 0;
  let baseRadius = (planet.radius ?? 800) + groundBase + 0.05;
  if (planet.water?.r && baseRadius < planet.water.r + 0.4) baseRadius = planet.water.r + 0.4;
  group.position.copy(dirLocal.clone().multiplyScalar(baseRadius));

  const _wp = new THREE.Vector3(), _dir = new THREE.Vector3();
  // Analytic ground height in the town-local frame — the SAME surface the
  // player (walk.floorRadius) and the terrain-detail patch use, so buildings
  // and characters all sit on the visible ground (no sink, no float).
  function groundY(lx, lz) {
    _wp.set(lx, 0, lz).applyQuaternion(quat).add(group.position);
    _dir.copy(_wp).normalize();
    const h = planet.body?.groundAtLocal ? planet.body.groundAtLocal(_dir) : 0;
    const planetR = planet.radius ?? 800;
    let rr = planetR + h;
    if (planet.water?.r) rr = Math.max(rr, planet.water.r + 0.4);
    const d2 = lx * lx + lz * lz;
    return Math.sqrt(Math.max(rr * rr - d2, 0)) - baseRadius;
  }

  const _q = group.quaternion.clone(), _pos = group.position.clone();
  function localToWorld(v) { return v.clone().applyQuaternion(_q).add(_pos); }

  // ---- collectors ----
  const colliders = [];       // player push-out cylinders — ONLY solid props (no buildings, so rooms stay enterable)
  const collidersLocal = [];  // crowd avoidance — building + prop footprints
  const waypoints = [];       // crowd wander targets
  const structures = [];      // walk.js floor/wall contracts (rooms, decks, elevators)
  const elevators = [];
  const infoPoints = [];
  const roleAnchors = {};
  const updaters = [];

  // ---- footprint reserver so no two buildings overlap ----
  const placed = [];
  function fits(x, z, r) {
    for (const p of placed) if (Math.hypot(x - p.x, z - p.z) < r + p.r + 2.2) return false;
    return true;
  }
  function reserve(x, z, r) { placed.push({ x, z, r }); }
  function findSpot(r0, r1, rad) {
    for (let i = 0; i < 60; i++) {
      const a = rng() * Math.PI * 2;
      const rr = THREE.MathUtils.lerp(r0, r1, rng());
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      if (fits(x, z, rad)) { reserve(x, z, rad); return { x, z, a }; }
    }
    return null;
  }

  // ---- shared materials ----
  const M = {
    stone: new THREE.MeshStandardMaterial({ color: 0xb8a488, roughness: 0.9 }),
    plaster: new THREE.MeshStandardMaterial({ color: 0xe6dcc4, roughness: 0.9 }),
    timber: new THREE.MeshStandardMaterial({ color: 0x6e4a2e, roughness: 0.85 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x8a5a34, roughness: 0.8 }),
    woodL: new THREE.MeshStandardMaterial({ color: 0xac8a5a, roughness: 0.8 }),
    roof: new THREE.MeshStandardMaterial({ color: 0x9c3b26, roughness: 0.7 }),
    floor: new THREE.MeshStandardMaterial({ color: 0x7a5c3a, roughness: 0.9 }),
    water: new THREE.MeshStandardMaterial({ color: 0x2f6f8f, roughness: 0.2, metalness: 0.1, transparent: true, opacity: 0.82 }),
    white: new THREE.MeshStandardMaterial({ color: 0xeeeae0, roughness: 0.8 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x8a8a92, roughness: 0.5, metalness: 0.6 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.7, metalness: 0.3 }),
    red: new THREE.MeshStandardMaterial({ color: 0xb84a4a, roughness: 0.8 }),
    blue: new THREE.MeshStandardMaterial({ color: 0x4a6ab8, roughness: 0.8 }),
    green: new THREE.MeshStandardMaterial({ color: 0x4a8a4a, roughness: 0.8 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xffdf9a, emissive: 0xffcf7a, emissiveIntensity: 1.3 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xf5b642, emissive: 0xf5b642, emissiveIntensity: 0.3, roughness: 0.6 }),
    oven: new THREE.MeshStandardMaterial({ color: 0x3a3030, roughness: 0.9 }),
    ember: new THREE.MeshStandardMaterial({ color: 0xff7a3a, emissive: 0xff5a1a, emissiveIntensity: 1.2 }),
    bread: new THREE.MeshStandardMaterial({ color: 0xc98a4a, roughness: 0.8 }),
  };

  function mk(geo, mat, sx, sy, sz, px, py, pz, ry = 0) {
    const m = new THREE.Mesh(geo, mat);
    m.scale.set(sx, sy, sz); m.position.set(px, py, pz); m.rotation.y = ry;
    group.add(m); return m;
  }

  // -------------------------------------------------------------------------
  // Generic enterable building: 4 walls + a doorway, interior floor, foundation,
  // roof (or a tall tower body), furniture, and a solid-wall structure contract.
  // -------------------------------------------------------------------------
  function addBuilding(o) {
    const baseY = groundY(o.cx, o.cz);
    const hw = o.hw, hd = o.hd, H = o.wallH, T = WALL_T, dW = o.doorW || DOOR_W;
    const wallMat = o.wallMat || M.plaster;
    const walls = [];
    const g0 = -dW / 2, g1 = dW / 2;
    const door = o.doorSide || 'south';

    function seg(x0, x1, z0, z1) {
      walls.push({ x0, x1, z0, z1, y0: 0, y1: H });
      mk(UBOX, wallMat, (x1 - x0), H, (z1 - z0), o.cx + (x0 + x1) / 2, baseY + H / 2, o.cz + (z0 + z1) / 2);
    }
    // south / north / west / east, splitting the door side around the gap
    if (door === 'south') { seg(-hw, g0, -hd, -hd + T); seg(g1, hw, -hd, -hd + T); } else seg(-hw, hw, -hd, -hd + T);
    if (door === 'north') { seg(-hw, g0, hd - T, hd); seg(g1, hw, hd - T, hd); } else seg(-hw, hw, hd - T, hd);
    if (door === 'west') { seg(-hw, -hw + T, -hd, g0); seg(-hw, -hw + T, g1, hd); } else seg(-hw, -hw + T, -hd, hd);
    if (door === 'east') { seg(hw - T, hw, -hd, g0); seg(hw - T, hw, g1, hd); } else seg(hw - T, hw, -hd, hd);
    // lintel above the doorway
    const lz = door === 'south' ? -hd + T / 2 : door === 'north' ? hd - T / 2 : 0;
    const lx = door === 'west' ? -hw + T / 2 : door === 'east' ? hw - T / 2 : 0;
    if (door === 'south' || door === 'north') mk(UBOX, wallMat, dW, H - 2.1, T, o.cx, baseY + 2.1 + (H - 2.1) / 2, o.cz + lz);
    else mk(UBOX, wallMat, T, H - 2.1, dW, o.cx + lx, baseY + 2.1 + (H - 2.1) / 2, o.cz);

    // interior floor + foundation
    mk(UBOX, M.floor, hw * 2 - T, 0.2, hd * 2 - T, o.cx, baseY + 0.05, o.cz);
    mk(UBOX, M.stone, hw * 2 + 0.4, FOUND, hd * 2 + 0.4, o.cx, baseY - FOUND / 2 + 0.1, o.cz);

    // roof or tower body
    if (o.tower) {
      const bodyMat = o.tower.mat;
      mk(UBOX, bodyMat, hw * 2, o.tower.h, hd * 2, o.cx, baseY + H + o.tower.h / 2, o.cz);
      mk(UBOX, M.roof, hw * 2 + 1.2, 1.6, hd * 2 + 1.2, o.cx, baseY + H + o.tower.h, o.cz);
    } else {
      mk(UCONE, M.roof, Math.max(hw, hd) * 2.5, o.roofH || 3.2, Math.max(hw, hd) * 2.5, o.cx, baseY + H + (o.roofH || 3.2) / 2, o.cz, Math.PI / 4);
    }

    // walkable interior (floor slab) + solid walls
    const surfaces = [{ x0: -hw + T, x1: hw - T, z0: -hd + T, z1: hd - T, y: 0.16 }];
    structures.push(makeStructure(o.cx, o.cz, baseY, surfaces, walls, Math.max(hw, hd) + T));
    // townsfolk steer around the footprint so they never clip a wall
    collidersLocal.push({ x: o.cx, z: o.cz, radius: Math.max(hw, hd) + 0.6 });

    // a warm interior lamp so the room isn't a dark box
    mk(USPH, M.lamp, 0.5, 0.5, 0.5, o.cx, baseY + H - 0.8, o.cz);

    // furniture
    if (o.furnish) {
      const api = {
        box: (w, h, d, mat, x, y, z, ry = 0) => mk(UBOX, mat, w, h, d, o.cx + x, baseY + y, o.cz + z, ry),
        cyl: (r, h, mat, x, y, z) => mk(UCYL, mat, r * 2, h, r * 2, o.cx + x, baseY + y, o.cz + z),
        cone: (r, h, mat, x, y, z, ry = 0) => mk(UCONE, mat, r * 2, h, r * 2, o.cx + x, baseY + y, o.cz + z, ry),
        sph: (r, mat, x, y, z) => mk(USPH, mat, r * 2, r * 2, r * 2, o.cx + x, baseY + y, o.cz + z),
        M,
      };
      o.furnish(api, hw, hd);
    }
    return { baseY };
  }

  // ---- furniture sets -----------------------------------------------------
  function furnishHouse(a, hw, hd) {
    // bed
    a.box(2.0, 0.5, 1.0, a.M.wood, -hw + 1.3, 0.35, hd - 1.0);
    a.box(1.8, 0.25, 0.9, a.M.white, -hw + 1.3, 0.7, hd - 1.0);
    a.box(0.5, 0.25, 0.9, a.M.red, -hw + 0.5, 0.75, hd - 1.0);
    // table + stools
    a.box(1.4, 0.12, 1.0, a.M.woodL, hw - 1.6, 0.9, -hd + 1.6);
    a.box(1.2, 0.9, 0.1, a.M.wood, hw - 1.6, 0.45, -hd + 1.6);
    a.cyl(0.3, 0.6, a.M.wood, hw - 0.6, 0.3, -hd + 1.6);
    a.cyl(0.3, 0.6, a.M.wood, hw - 2.6, 0.3, -hd + 1.6);
    // shelf on the wall + a rug
    a.box(1.8, 0.12, 0.5, a.M.woodL, 0, 1.9, hd - 0.4);
    a.box(hw, 0.04, hd, a.M.red, 0, 0.14, 0);
    // a lit candle on the table
    a.cyl(0.12, 0.4, a.M.lamp, hw - 1.6, 1.15, -hd + 1.6);
  }
  function furnishBakery(a, hw, hd) {
    a.box(2.4, 2.2, 1.6, a.M.oven, hw - 1.8, 1.1, hd - 1.2);       // oven
    a.box(1.4, 0.5, 0.9, a.M.ember, hw - 1.8, 0.7, hd - 0.5);      // oven mouth glow
    a.box(hw * 1.6, 1.0, 0.7, a.M.woodL, 0, 0.5, -hd + 1.0);       // counter
    for (let i = 0; i < 5; i++) a.box(0.5, 0.3, 0.35, a.M.bread, -hw + 1 + i * 0.7, 1.15, -hd + 1.0); // loaves
    a.box(hw * 1.4, 0.12, 0.5, a.M.woodL, 0, 2.0, -hd + 0.4);      // shelf
    a.cyl(0.5, 1.1, a.M.wood, -hw + 1.0, 0.55, hd - 1.0);          // flour sack
  }
  function furnishPerfumery(a, hw, hd) {
    a.cyl(0.7, 1.6, a.M.metal, hw - 1.4, 0.8, hd - 1.4);           // vat
    a.cyl(0.7, 1.6, a.M.metal, hw - 1.4, 0.8, hd - 3.0);
    a.box(hw * 1.6, 1.0, 0.7, a.M.woodL, 0, 0.5, -hd + 1.0);       // counter
    const tint = [a.M.red, a.M.blue, a.M.green, a.M.gold];         // bottles
    for (let i = 0; i < 6; i++) a.cyl(0.13, 0.5, tint[i % 4], -hw + 1 + i * 0.6, 2.1, -hd + 0.5);
    a.box(hw * 1.3, 0.12, 0.5, a.M.woodL, 0, 1.9, -hd + 0.35);     // shelf
  }
  function furnishHall(a, hw, hd) {
    a.box(hw * 1.2, 0.15, 1.2, a.M.woodL, 0, 1.0, 0);              // long table
    a.box(hw * 1.2, 0.9, 0.1, a.M.wood, 0, 0.5, 0);
    a.box(hw * 1.2, 0.4, 0.4, a.M.wood, 0, 0.5, 1.2);             // benches
    a.box(hw * 1.2, 0.4, 0.4, a.M.wood, 0, 0.5, -1.2);
    a.box(1.0, 1.2, 0.8, a.M.woodL, 0, 0.6, -hd + 1.2);           // lectern
    a.box(0.4, 3.0, 0.05, a.M.gold, -hw + 0.6, 2.2, hd - 0.5);    // banners
    a.box(0.4, 3.0, 0.05, a.M.gold, hw - 0.6, 2.2, hd - 0.5);
  }
  function furnishMarket(a, hw, hd) {
    for (let r = 0; r < 2; r++) {
      const zz = r === 0 ? -hd + 1.4 : hd - 1.4;
      a.box(hw * 1.5, 0.9, 0.9, a.M.woodL, 0, 0.5, zz);           // trestle
      const cols = [a.M.red, a.M.green, a.M.gold, a.M.blue];
      for (let i = 0; i < 5; i++) a.sph(0.28, cols[i % 4], -hw + 1 + i * 0.9, 1.1, zz); // produce
    }
    a.box(1.2, 1.0, 1.2, a.M.wood, hw - 1.4, 0.5, 0);             // crate stack
    a.box(1.0, 0.8, 1.0, a.M.wood, hw - 1.6, 1.3, 0);
  }
  function furnishBarn(a, hw, hd) {
    a.cyl(0.8, 1.4, a.M.woodL, -hw + 1.4, 0.7, hd - 1.4);          // hay bales
    a.cyl(0.8, 1.4, a.M.woodL, -hw + 1.4, 0.7, hd - 3.2);
    a.box(1.4, 1.2, 1.4, a.M.wood, hw - 1.6, 0.6, hd - 1.4);       // crates
    a.box(2.2, 0.3, 1.2, a.M.wood, 0, 0.5, -hd + 1.6);            // cart bed
    a.cyl(0.5, 0.2, a.M.dark, -0.9, 0.5, -hd + 1.6);             // wheels
    a.cyl(0.5, 0.2, a.M.dark, 0.9, 0.5, -hd + 1.6);
  }
  function furnishMill(a, hw, hd) {
    a.cyl(1.2, 0.5, a.M.stone, 0, 0.5, 0);                         // grindstone
    a.cyl(0.2, 1.2, a.M.wood, 0, 1.1, 0);                          // spindle
    a.cyl(0.5, 1.1, a.M.wood, hw - 1.2, 0.55, hd - 1.2);          // sacks
    a.cyl(0.5, 1.1, a.M.wood, hw - 1.2, 0.55, hd - 2.6);
  }
  function furnishLobby(a, hw, hd) {
    a.box(hw * 1.2, 1.0, 0.8, a.M.woodL, 0, 0.5, -hd + 1.2);       // reception desk
    a.box(hw, 0.4, 0.5, a.M.wood, 0, 0.4, hd - 1.0);             // waiting bench
    a.cyl(0.5, 0.6, a.M.wood, hw - 1.2, 0.3, hd - 1.2);           // planter
    a.cone(0.9, 1.6, a.M.green, hw - 1.2, 1.4, hd - 1.2);         // plant
    a.box(hw, 0.04, hd, a.M.blue, 0, 0.14, 0);                    // rug
  }

  // -------------------------------------------------------------------------
  // Plaza (flush, so characters stand on it) + central town hall
  // -------------------------------------------------------------------------
  const plazaY = groundY(0, 0);
  mk(UCYL, new THREE.MeshStandardMaterial({ color: 0xcdbfa2, roughness: 0.95 }), 40, 0.12, 40, 0, plazaY + 0.02, 0);
  waypoints.push({ x: 0, z: 0 }, { x: 10, z: 8 }, { x: -10, z: 8 }, { x: 8, z: -10 }, { x: -8, z: -8 });

  // town hall (reserve first)
  {
    const cx = 0, cz = -34; reserve(cx, cz, 13);
    addBuilding({ cx, cz, hw: 10, hd: 8, wallH: 9, doorSide: 'south', wallMat: M.stone, roofH: 5, furnish: furnishHall });
    // bell tower beside the hall
    const gy = groundY(cx, cz);
    mk(UBOX, M.stone, 5, 26, 5, cx + 6, gy + 13, cz - 3);
    mk(UCONE, M.roof, 7, 8, 7, cx + 6, gy + 30, cz - 3, Math.PI / 4);
    mk(UBOX, M.gold, 0.3, 3, 0.3, cx + 6, gy + 35, cz - 3);
    roleAnchors.caretaker = { x: cx, z: cz + 11 };
    infoPoints.push({ local: new THREE.Vector3(cx, gy + 2, cz + 11), radius: 6, prompt: 'Town Hall', kind: 'townhall' });
    waypoints.push({ x: cx, z: cz + 12 });
  }

  // market hall
  {
    const cx = 30, cz = 6; reserve(cx, cz, 10);
    const gy = groundY(cx, cz);
    addBuilding({ cx, cz, hw: 8, hd: 6, wallH: 6, doorSide: 'west', wallMat: M.plaster, roofH: 3.5, furnish: furnishMarket });
    roleAnchors.merchant = { x: cx - 9, z: cz };
    infoPoints.push({ local: new THREE.Vector3(cx - 9, gy + 2, cz), radius: 6, prompt: 'Market', kind: 'market' });
    waypoints.push({ x: cx - 9, z: cz });
  }
  // bakery + perfumery
  {
    let cx = -30, cz = 14; reserve(cx, cz, 8);
    let gy = groundY(cx, cz);
    addBuilding({ cx, cz, hw: 5, hd: 5, wallH: 5.5, doorSide: 'east', roofH: 3, furnish: furnishBakery });
    roleAnchors.artisan = { x: cx + 6, z: cz };
    infoPoints.push({ local: new THREE.Vector3(cx + 6, gy + 2, cz), radius: 5, prompt: 'Bakery', kind: 'bakery' });
    waypoints.push({ x: cx + 6, z: cz });
    cx = -30; cz = -16; reserve(cx, cz, 8); gy = groundY(cx, cz);
    addBuilding({ cx, cz, hw: 5, hd: 5, wallH: 5.5, doorSide: 'east', roofH: 3, furnish: furnishPerfumery });
    infoPoints.push({ local: new THREE.Vector3(cx + 6, gy + 2, cz), radius: 5, prompt: 'Perfumery', kind: 'perfumery' });
    waypoints.push({ x: cx + 6, z: cz });
  }

  // reserve the farm + garden districts so towers/houses avoid them
  const FARM = { x: 82, z: -34 }, GARDEN = { x: -82, z: -34 };
  reserve(FARM.x, FARM.z, 28);
  reserve(GARDEN.x, GARDEN.z, 28);

  // barn (by the farm) + mill (by the waterwheel)
  {
    const cx = 60, cz = -30; reserve(cx, cz, 9);
    addBuilding({ cx, cz, hw: 6, hd: 5, wallH: 6, doorSide: 'west', wallMat: M.timber, roofH: 4, furnish: furnishBarn });
  }

  // -------------------------------------------------------------------------
  // Warm low houses (each enterable + furnished), placed without overlap
  // -------------------------------------------------------------------------
  const doorSides = ['south', 'north', 'east', 'west'];
  for (let i = 0; i < 12; i++) {
    const spot = findSpot(24, 58, 6);
    if (!spot) continue;
    addBuilding({
      cx: spot.x, cz: spot.z, hw: 4.2, hd: 4.2, wallH: 5, roofH: 3.2,
      wallMat: rng() < 0.5 ? M.plaster : M.timber,
      doorSide: doorSides[Math.floor(rng() * 4)],
      furnish: furnishHouse,
    });
  }

  // -------------------------------------------------------------------------
  // Canal + rotating waterwheel + mill
  // -------------------------------------------------------------------------
  {
    const segs = 6;
    for (let i = 0; i < segs; i++) {
      const t = i / (segs - 1);
      const cx = THREE.MathUtils.lerp(-58, 58, t);
      const cz = Math.sin(t * Math.PI) * 20 + 40;
      const gy = groundY(cx, cz);
      mk(UBOX, M.water, 16, 0.5, 7, cx, gy - 0.3, cz, t * 0.3);
      mk(UBOX, M.stone, 17, 1.1, 1.3, cx, gy + 0.15, cz + 4.2);
      mk(UBOX, M.stone, 17, 1.1, 1.3, cx, gy + 0.15, cz - 4.2);
    }
    const wwX = -40, wwZ = 44; reserve(-46, wwZ, 6);
    const wy = groundY(wwX, wwZ);
    const wheel = new THREE.Group();
    const hub = new THREE.Mesh(new THREE.TorusGeometry(5, 0.5, 8, 20), M.timber);
    wheel.add(hub);
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      const p = new THREE.Mesh(UBOX, M.timber);
      p.scale.set(1.6, 0.3, 3.2); p.position.set(Math.cos(ang) * 4.6, Math.sin(ang) * 4.6, 0); p.rotation.z = ang;
      wheel.add(p);
    }
    wheel.position.set(wwX, wy + 4.6, wwZ); wheel.rotation.y = Math.PI / 2;
    group.add(wheel);
    updaters.push((dt) => { wheel.rotation.x += dt * 0.6; });
    // mill building next to the wheel
    addBuilding({ cx: -46, cz: wwZ, hw: 4.5, hd: 4.5, wallH: 6, doorSide: 'south', wallMat: M.plaster, roofH: 3.5, furnish: furnishMill });
  }

  // -------------------------------------------------------------------------
  // Outdoor market stalls (open awnings, near the plaza)
  // -------------------------------------------------------------------------
  const awn = [0xc94f4f, 0x4f7fc9, 0x4faf6a, 0xd9a441, 0x8a5fbf];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const rr = 22 + (i % 2) * 3;
    const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
    const gy = groundY(x, z);
    mk(UBOX, M.woodL, 4.4, 1, 1.4, x, gy + 1, z, a);
    mk(UBOX, new THREE.MeshStandardMaterial({ color: awn[i % awn.length], roughness: 0.8 }), 5, 0.2, 2.4, x, gy + 3, z, a);
    for (const sx of [-2, 2]) mk(UCYL, M.timber, 0.3, 3, 0.3, x + Math.cos(a + Math.PI / 2) * sx, gy + 1.5, z + Math.sin(a + Math.PI / 2) * sx);
    waypoints.push({ x, z });
  }

  // -------------------------------------------------------------------------
  // Farm district (tilled rows + instanced crops)
  // -------------------------------------------------------------------------
  const cropMat = new THREE.MeshStandardMaterial({ color: 0xc9b23a, roughness: 0.8 });
  {
    const fx0 = FARM.x, fz0 = FARM.z, plotW = 20, plotD = 15, plotsX = 3, plotsZ = 2, perPlot = 55;
    const cropMesh = new THREE.InstancedMesh(new THREE.ConeGeometry(0.4, 1.6, 5), cropMat, plotsX * plotsZ * perPlot);
    let ci = 0; const dm = new THREE.Object3D();
    for (let px = 0; px < plotsX; px++) for (let pz = 0; pz < plotsZ; pz++) {
      const cx = fx0 + (px - 1) * (plotW + 3), cz = fz0 + (pz - 0.5) * (plotD + 3);
      const gy = groundY(cx, cz);
      mk(UBOX, new THREE.MeshStandardMaterial({ color: 0x5a4230, roughness: 1 }), plotW, 0.4, plotD, cx, gy + 0.1, cz);
      for (let k = 0; k < perPlot; k++) {
        const rx = cx + (rng() - 0.5) * (plotW - 2), rz = cz + (rng() - 0.5) * (plotD - 2);
        dm.position.set(rx, groundY(rx, rz) + 0.8, rz); dm.scale.set(1, 0.7 + rng() * 0.6, 1);
        dm.rotation.set(0, rng() * Math.PI, 0); dm.updateMatrix(); cropMesh.setMatrixAt(ci++, dm.matrix);
      }
      waypoints.push({ x: cx, z: cz });
    }
    cropMesh.instanceMatrix.needsUpdate = true; cropMesh.frustumCulled = false;
    group.add(cropMesh);
    roleAnchors.farmer = { x: fx0, z: fz0 };
    group.userData.cropMat = cropMat;
  }

  // -------------------------------------------------------------------------
  // Garden district (instanced colorful flowers) — feeds bloom_points
  // -------------------------------------------------------------------------
  {
    const gx0 = GARDEN.x, gz0 = GARDEN.z;
    const fc = [0xe0587f, 0xe8c14a, 0x8a5fd0, 0xef7f4f, 0xffffff, 0x6ab0e0];
    const bedW = 20, bedD = 15, bedsX = 3, bedsZ = 2, perBed = 70;
    const total = bedsX * bedsZ * perBed;
    const petal = new THREE.InstancedMesh(USPH, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }), total);
    petal.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(total * 3), 3);
    const stem = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 4), M.green, total);
    let fi = 0; const dm = new THREE.Object3D(), col = new THREE.Color();
    for (let bx = 0; bx < bedsX; bx++) for (let bz = 0; bz < bedsZ; bz++) {
      const cx = gx0 + (bx - 1) * (bedW + 3), cz = gz0 + (bz - 0.5) * (bedD + 3);
      const gy = groundY(cx, cz);
      mk(UBOX, new THREE.MeshStandardMaterial({ color: 0x4a3526, roughness: 1 }), bedW, 0.5, bedD, cx, gy + 0.15, cz);
      mk(UBOX, new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.9 }), bedW + 1, 0.7, bedD + 1, cx, gy + 0.1, cz);
      for (let k = 0; k < perBed; k++) {
        const rx = cx + (rng() - 0.5) * (bedW - 2), rz = cz + (rng() - 0.5) * (bedD - 2);
        const fy = groundY(rx, rz);
        dm.position.set(rx, fy + 0.45, rz); dm.scale.set(1, 1, 1); dm.updateMatrix(); stem.setMatrixAt(fi, dm.matrix);
        dm.position.set(rx, fy + 1.0, rz); dm.scale.set(0.7, 0.7, 0.7); dm.updateMatrix(); petal.setMatrixAt(fi, dm.matrix);
        col.set(fc[Math.floor(rng() * fc.length)]); petal.setColorAt(fi, col); fi++;
      }
      waypoints.push({ x: cx, z: cz });
    }
    petal.instanceMatrix.needsUpdate = true; petal.instanceColor.needsUpdate = true; stem.instanceMatrix.needsUpdate = true;
    petal.frustumCulled = false; stem.frustumCulled = false;
    group.add(stem, petal);
    roleAnchors.gardener = { x: gx0, z: gz0 };
    infoPoints.push({ local: new THREE.Vector3(gx0, groundY(gx0, gz0) + 2, gz0 + 10), radius: 8, prompt: 'Flower Gardens', kind: 'gardens' });
  }

  // -------------------------------------------------------------------------
  // Tall residential towers — each enterable (ground-floor lobby), a few with a
  // working elevator up to an observation deck.
  // -------------------------------------------------------------------------
  const winTex = warmWindowTexture(rng);
  const towerAngles = 8;
  let towerN = 0, elevBuilt = 0;
  for (let i = 0; i < towerAngles; i++) {
    const baseA = (i / towerAngles) * Math.PI * 2 + 0.12;
    let spot = null;
    for (let tries = 0; tries < 20 && !spot; tries++) {
      const a = baseA + (rng() - 0.5) * 0.3;
      const rr = THREE.MathUtils.lerp(70, 94, rng());
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      if (fits(x, z, 8)) { reserve(x, z, 8); spot = { x, z, a }; }
    }
    if (!spot) continue;
    towerN++;
    const hgt = THREE.MathUtils.lerp(40, 74, rng());
    const bodyTex = winTex.clone(); bodyTex.needsUpdate = true;
    bodyTex.repeat.set(3, Math.max(6, Math.round(hgt / 5)));
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x8f8a7e, roughness: 0.8, map: bodyTex, emissive: 0xffca73, emissiveMap: bodyTex, emissiveIntensity: 0.5 });
    addBuilding({
      cx: spot.x, cz: spot.z, hw: 6, hd: 6, wallH: 5, doorSide: 'south',
      wallMat: M.stone, tower: { h: hgt, mat: bodyMat }, furnish: furnishLobby,
    });
    // give the first 3 towers a working elevator up the plaza-facing side
    if (elevBuilt < 3) { buildElevator(spot.x, spot.z, spot.a, 6, hgt); elevBuilt++; }
    waypoints.push({ x: spot.x, z: spot.z });
  }

  // Exterior elevator: a dynamic walkable platform on rails up the tower's
  // plaza-facing side, ending at a railed observation deck.
  function buildElevator(x, z, a, hw, hgt) {
    const inward = Math.atan2(-z, -x);
    const off = hw + 2.6;
    const ex = x + Math.cos(inward) * off, ez = z + Math.sin(inward) * off;
    const baseY = groundY(ex, ez);
    const deckY = groundY(x, z) + hgt - 4;
    const half = 2.2;
    reserve(ex, ez, half + 1);

    // guide rails
    for (const sx of [-half, half]) {
      const gx = ex + Math.cos(inward + Math.PI / 2) * sx, gz = ez + Math.sin(inward + Math.PI / 2) * sx;
      mk(UBOX, M.dark, 0.35, hgt, 0.35, gx, baseY + hgt / 2, gz);
    }

    // observation deck (static walkable slab + railings on 3 sides)
    mk(UBOX, M.stone, half * 2 + 4, 0.4, half * 2 + 4, ex, deckY, ez);
    const railWalls = [];
    const rh = 1.1, rt = 0.2, R = half + 2;
    // railings: north/east/west (leave the inward/south open for the car)
    const railSpec = [
      { x0: -R, x1: R, z0: R - rt, z1: R },      // far side
      { x0: R - rt, x1: R, z0: -R, z1: R },      // right
      { x0: -R, x1: -R + rt, z0: -R, z1: R },    // left
    ];
    for (const w of railSpec) {
      railWalls.push({ x0: w.x0, x1: w.x1, z0: w.z0, z1: w.z1, y0: 0, y1: rh });
      mk(UBOX, M.woodL, (w.x1 - w.x0), rh, (w.z1 - w.z0), ex + (w.x0 + w.x1) / 2, deckY + rh / 2, ez + (w.z0 + w.z1) / 2);
    }
    structures.push(makeStructure(ex, ez, deckY, [{ x0: -R, x1: R, z0: -R, z1: R, y: 0.2 }], railWalls, R + 0.4));

    // the car
    const carMat = new THREE.MeshStandardMaterial({ color: 0xcaa46a, roughness: 0.6, metalness: 0.2 });
    const car = new THREE.Group();
    const floor = new THREE.Mesh(UBOX, carMat); floor.scale.set(half * 2, 0.3, half * 2); car.add(floor);
    const cage = new THREE.Mesh(UBOX, new THREE.MeshStandardMaterial({ color: 0xf5b642, transparent: true, opacity: 0.16 }));
    cage.scale.set(half * 2, 3, half * 2); cage.position.y = 1.5; car.add(cage);
    car.position.set(ex, baseY, ez); group.add(car);

    let carY = baseY, targetY = baseY;
    const lift = {
      callTop() { targetY = deckY; },
      callBottom() { targetY = baseY; },
      surfaceYAt(px, pz, feetY) {
        if (Math.abs(px - ex) > half + 0.3 || Math.abs(pz - ez) > half + 0.3) return null;
        if (carY <= feetY + 0.7) return carY;
        return null;
      },
      resolveWalls() { return false; },
      update(dt) {
        const dy = targetY - carY;
        if (Math.abs(dy) > 0.001) { carY += Math.sign(dy) * Math.min(Math.abs(dy), ELEV_SPEED * dt); car.position.y = carY; }
      },
    };
    structures.push(lift); elevators.push(lift);
    infoPoints.push({ local: new THREE.Vector3(ex, baseY + 1, ez), radius: 3.4, prompt: 'Ride the elevator up', kind: 'elevator-up', lift });
    infoPoints.push({ local: new THREE.Vector3(ex, deckY + 1, ez), radius: 3.8, prompt: 'Ride the elevator down', kind: 'elevator-down', lift });
    waypoints.push({ x: ex, z: ez });
  }

  // -------------------------------------------------------------------------
  // Street lamps (thin props — small player colliders so you don't clip them)
  // -------------------------------------------------------------------------
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const x = Math.cos(a) * 21, z = Math.sin(a) * 21, gy = groundY(x, z);
    mk(UCYL, M.timber, 0.3, 5, 0.3, x, gy + 2.5, z);
    mk(USPH, M.lamp, 0.8, 0.8, 0.8, x, gy + 5.2, z);
  }

  // -------------------------------------------------------------------------
  function update(dt, t) { for (const fn of updaters) fn(dt, t); for (const el of elevators) el.update(dt); }
  function dispose() {
    group.traverse((o) => {
      if (o.geometry && o.geometry !== UBOX && o.geometry !== UCYL && o.geometry !== UCONE && o.geometry !== USPH) o.geometry.dispose();
      if (o.material) { const m = Array.isArray(o.material) ? o.material : [o.material]; m.forEach((x) => { if (x.map) x.map.dispose(); x.dispose(); }); }
      if (o.isInstancedMesh) o.dispose();
    });
    group.clear();
  }

  return {
    group, update, dispose,
    quaternion: group.quaternion, position: group.position, localToWorld,
    colliders, collidersLocal,
    plazaCenters: waypoints,
    groundLocalYAt: groundY,
    structures, elevators, infoPoints, roleAnchors,
    center: dirLocal.clone(),
  };
}
