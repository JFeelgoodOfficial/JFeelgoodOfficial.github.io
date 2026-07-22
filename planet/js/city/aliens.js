/**
 * aliens.js — Procedurally generated humanoid citizens for explorable cities.
 *
 * Builds a deterministic crowd of alien humanoids that wander a city's streets
 * and plazas, avoid buildings and each other, steer gently around the player,
 * and can be talked to. Follows the game's procedural/deterministic/no-lights
 * conventions: primitives only, MeshStandardMaterial, mulberry32 seeding,
 * Astronaut-style nested THREE.Group rig animated procedurally (no skeletal
 * glTF animation). Units are meters; a citizen is 1.5–2.3 units tall.
 *
 * Coordinate assumptions: `host.groundHeightAt(x, z)` returns local ground
 * height at a planar (x,z) position within the city's unrotated object
 * space (same space city.js builds streets/plazas in). This module's
 * `group` should be added as a child of that same space (e.g. the city
 * group, itself a child of the planet's spinning `surface`). `playerPos`
 * passed to update()/nearestInteractable() is in that same local space.
 *
 * Interaction contract (see interaction.js): nearestInteractable() scans the
 * active rig pool ONLY (never impostors) with no per-call allocation;
 * interact(entity) returns a DialoguePayload and starts the talk pose;
 * endInteract(entity) releases it when the host closes the dialogue (safe to
 * call twice / with a stale entity). Quest.marker is a THREE.Vector3 in this
 * module's group-local space — the host parents marker visuals under the same
 * space. Host owns quest/codex state; this module never mutates global state.
 *
 * Performance: a small pool of fully articulated rigs (opts.maxRigs ?? 24)
 * is kept near the player; all other citizens in the population are cheap
 * capsule impostors drawn via a single InstancedMesh. Rigs are promoted/
 * demoted by distance each frame with no per-frame allocation (scratch
 * vectors/matrices are pre-allocated module-level).
 */

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const C = {
  population: 48,              // total citizens simulated per city (rigs + impostors)
  maxRigs: 24,                 // active articulated rigs near player (opts override)
  promoteDist: 26,              // distance inside which an impostor is promoted to a rig
  demoteDist: 32,               // distance beyond which a rig is demoted back to impostor (hysteresis)
  impostorRadius: 0.28,         // capsule impostor radius
  impostorHeight: 1.7,          // capsule impostor cylinder height (excl. caps)

  heightMin: 1.5,               // shortest citizen
  heightMax: 2.3,               // tallest citizen
  headScaleMin: 0.85,
  headScaleMax: 1.25,
  limbScaleMin: 0.85,
  limbScaleMax: 1.2,

  eyeCountWeights: [0.35, 0.35, 0.2, 0.1], // weights for 1..4 eyes
  antennaeChance: 0.35,
  crestChance: 0.3,
  tailChance: 0.25,

  gaitSpeedMin: 0.75,           // walk cycle speed multiplier
  gaitSpeedMax: 1.35,
  walkSpeed: 1.1,                // m/s base wandering speed
  turnRate: 2.2,                 // rad/s max turn rate while steering
  idleMinT: 2.5,                 // seconds min idle dwell at a waypoint
  idleMaxT: 6.0,
  waypointReachDist: 0.6,

  avoidBuildingMargin: 0.5,      // extra clearance added to building collider radius
  avoidCitizenRadius: 0.55,      // personal space between citizens
  avoidCitizenStrength: 1.4,
  playerAvoidRadius: 1.6,        // gentle steer-around radius near the player
  playerAvoidStrength: 1.8,

  talkTriggerDist: 2.4,          // nearestInteractable default search range fallback
  questChance: 0.28,             // fraction of citizens who carry a Quest

  eyeEmissiveNight: 1.1,         // emissive intensity at night
  eyeEmissiveDay: 0.15,          // emissive intensity at full day
  trimEmissiveNight: 0.95,
  trimEmissiveDay: 0.1,

  palette: [0xd4408f, 0x39e6d0, 0xf0a83c], // magenta / cyan / amber accent family
};

// ---------------------------------------------------------------------------
// Deterministic RNG
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; }
function weightedIndex(rng, weights) {
  const r = rng() * weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < weights.length; i++) { acc += weights[i]; if (r <= acc) return i; }
  return weights.length - 1;
}

// ---------------------------------------------------------------------------
// Culture profiles + dialogue fragment banks
// ---------------------------------------------------------------------------
const CULTURES = {
  hivemind: {
    pronoun: 'we',
    greetings: ['We turn many eyes toward you.', 'We have been speaking of your arrival.', 'We feel your steps before we see them.'],
    observations: ['We share one thought across many bodies.', 'The city hums; we hum with it.', 'None of us is truly alone, and so none of us is truly here.'],
    requests: ['We would have you carry a memory to the far plaza.', 'We ask only that you listen a while longer.'],
    farewells: ['We watch you go with a hundred eyes.', 'Go; we remain, as we always do.'],
    questBias: 'waypoint',
  },
  giftEconomy: {
    pronoun: 'I',
    greetings: ['Welcome, traveler — take a moment of my day.', 'Ah, a new face! Sit, share the shade.', 'You look like you could use a kindness.'],
    observations: ['Nothing here is owed; everything is given.', 'We measure wealth in what we hand away.', 'The market square gives more than it sells.'],
    requests: ['Let me give you something for the road.', 'Please, take this — it costs me nothing to share.'],
    farewells: ['Carry a piece of this city with you.', 'May the next stranger be as kind to you as I have tried to be.'],
    questBias: 'codex',
  },
  suspicious: {
    pronoun: 'I',
    greetings: ['You are not from here. I see that plainly.', 'State your business, outsider.', 'Careful. Eyes are on strangers tonight.'],
    observations: ['Things have gone missing since offworlders started landing.', 'The wonders draw the wrong kind of visitor.', 'I trust the ground more than I trust a stranger.'],
    requests: ['Stay out of the east quarter after dark.', 'Do not linger near the spire — it does not like company.'],
    farewells: ['Go. Quickly, and do not look back.', 'I will remember your face, just in case.'],
    questBias: 'choice',
  },
  scholarly: {
    pronoun: 'I',
    greetings: ['Oh — a visitor. How refreshingly rare.', 'You have the look of someone who asks questions.', 'Welcome. Mind the loose paving by the archive.'],
    observations: ['This city is older than its own records claim.', 'Every wonder here hides a smaller mystery inside it.', 'I have spent a lifetime cataloguing what the ancients left.'],
    requests: ['Bring word of anything strange you find in the wonders.', 'If you find an inscription, sketch it for me.'],
    farewells: ['Return if you learn something worth recording.', 'Safe travels — and keep your eyes open.'],
    questBias: 'codex',
  },
};
const CULTURE_KEYS = Object.keys(CULTURES);

// Role banks for building interiors — occupants draw lines that fit the room
// they're standing in (a shop, a lounge, the tower balcony) instead of the
// generic city culture. Selected via opts.culture on the interior crowds.
const ROLE_CULTURES = {
  shopkeeper: {
    pronoun: 'I',
    greetings: ["Welcome in, traveler. Everything's for trade.", 'Ah — a customer with atmosphere still on their boots.', 'Step inside, step inside. Mind the low doorway.'],
    observations: ['The good shelves restock when the second moon rises.', "Prices double during dust season. Today you're lucky.", 'Everything you see, I hauled up from the old market myself.'],
    requests: ['Take a look around — no pressure, mostly.', "Tell me if anything catches your eye."],
    farewells: ['Come back when your pockets are heavier.', 'Safe travels — and tell them who sent you.'],
    questBias: 'codex',
  },
  lounge: {
    pronoun: 'I',
    greetings: ["Pull up a seat. The neon's free.", 'You look like you walked the whole rim to get here.', 'Evening. Or morning. Hard to tell in here.'],
    observations: ['This booth has the best view of the avenue.', 'The band plays when the band feels like it.', "Half the city passes through that door eventually."],
    requests: ['Stay a while, the next round is on the house.', 'Rest your legs — the streets can wait.'],
    farewells: ["Mind the doorway — it's shorter than it looks.", 'Come back when the lights come up.'],
    questBias: 'codex',
  },
  caretaker: {
    pronoun: 'I',
    greetings: ['You made it all the way up. Not many do.', 'I keep the lights on up here. Best view on the planet.'],
    observations: ['On a clear night you can see your ship from here.', 'The wind sounds different this high off the street.'],
    requests: ['Take your time. The view is worth it.'],
    farewells: ['Watch the stairs on the way down.', 'Come back at sunset — it never disappoints.'],
    questBias: 'codex',
  },
  // Orbital Art Gallery visitors — they can't see the images, so every line
  // is about the experience of looking: reflective, funny, quietly moved.
  gallerygoer: {
    pronoun: 'I',
    greetings: ["Oh — sorry, I was somewhere else entirely. This piece does that.", "No, stay — it's better with someone else looking too.", 'Shh. No, not you. The painting. It was about to say something.', 'First visit? Start anywhere. They all lead back here.'],
    observations: ["I've circled this deck three times and it keeps changing on me.", 'Stand here, exactly here. Now it hums.', 'In this gravity the tears just sort of... hover. Very dignified.', 'I came for an hour. That was two terra-rises ago.', 'Every one of these came from a single collection. Imagine having that much to say.'],
    requests: ["Tell me which one you'd steal, if you had a bigger ship.", 'Look at it once up close and once from the rail. Two different works.', 'Find the one that looks back. Then come tell me which it was.'],
    farewells: ["I'm staying until the next terra-rise in the windows.", 'Go slowly. The art notices when you rush.', 'If you find the curator, say the third deck made me cry. Again.'],
    questBias: 'codex',
  },
  // Station maintenance crew — pride, wrenches, and a half-tone-flat spin motor.
  technician: {
    pronoun: 'I',
    greetings: ['Mind the conduit. Everything on this deck is load-bearing, including me.', "Lost? Art's that way. Work's here.", "You're standing on my access panel. No, don't move — it's nice to have company."],
    observations: ['Four decks of masterpieces and the climate control still answers to a wrench.', 'The spin motors sing a half-tone flat. Nobody notices but me.', 'Low gravity is great for the visitors, terrible for keeping bolts in pockets.', 'Every window on the promenade is my window. I cleaned them. All of them.'],
    requests: ['If a rail wobbles, tell me before you tell the curator.', 'Jump gently near the glass. For my nerves, not the glass.'],
    farewells: ['Back to the vents. The art gets the glory, the ducts get me.', 'Enjoy the gallery. It runs because somebody loves it — two somebodies, counting the owner.'],
    questBias: 'codex',
  },
  // The gallery's stationary attendant at the atrium desk.
  curator: {
    pronoun: 'I',
    greetings: ['Welcome to the Grand Hall. Thirty-two works, four decks, no ropes — just respect.', 'Ah, a docking-spine arrival. The collection is up and everywhere.'],
    observations: ['Every panel hangs at eye height. In this gravity, that took some arguing.', 'The owner sends new work when the muse allows. The empty frames are patience, not neglect.', 'Terra crosses the promenade windows every seven minutes. The art holds still. That contrast is the whole idea.'],
    requests: ['Take the ramps. The jumps are faster, but the art deserves the walk.', 'Start on the atrium floor and spiral up. The hang order means something.'],
    farewells: ['The gallery never closes. Orbit forbids it.', 'Come back with someone. Art doubles when shared.'],
    questBias: 'codex',
  },
};

function cultureForCity(cityId) {
  const rng = mulberry32(hashStr('culture:' + cityId));
  return CULTURES[pick(rng, CULTURE_KEYS)];
}

const NAME_SYLLABLES = ['va', 'ryn', 'oss', 'ith', 'mel', 'qor', 'una', 'shi', 'ent', 'axi', 'lo', 'reth'];
function generateName(rng) {
  const n = 2 + Math.floor(rng() * 2);
  let s = '';
  for (let i = 0; i < n; i++) s += pick(rng, NAME_SYLLABLES);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
const SPECIES_ROOTS = ['Vael', 'Ossyn', 'Chiron', 'Drell', 'Umbroth', 'Kessari'];
function speciesForCity(cityId) {
  const rng = mulberry32(hashStr('species:' + cityId));
  return pick(rng, SPECIES_ROOTS);
}

// ---------------------------------------------------------------------------
// Procedural rig — Astronaut-style nested joint hierarchy
// ---------------------------------------------------------------------------
export function buildRig(seed, cityId) {
  const rng = mulberry32(seed);

  const height = THREE.MathUtils.lerp(C.heightMin, C.heightMax, rng());
  const headScale = THREE.MathUtils.lerp(C.headScaleMin, C.headScaleMax, rng());
  const limbScale = THREE.MathUtils.lerp(C.limbScaleMin, C.limbScaleMax, rng());
  const buildWidth = THREE.MathUtils.lerp(0.8, 1.25, rng());

  const skinColor = new THREE.Color().setHSL(rng(), 0.35 + rng() * 0.3, 0.35 + rng() * 0.25);
  const skinMetal = rng() < 0.3;
  const accent = new THREE.Color(pick(rng, C.palette));

  const eyeCount = weightedIndex(rng, C.eyeCountWeights) + 1;
  const headShape = pick(rng, ['round', 'elongated', 'angular', 'crested']);
  const hasAntennae = rng() < C.antennaeChance;
  const hasCrest = !hasAntennae && rng() < C.crestChance;
  const hasTail = rng() < C.tailChance;

  const gaitSpeed = THREE.MathUtils.lerp(C.gaitSpeedMin, C.gaitSpeedMax, rng());
  const gaitPhase = rng() * Math.PI * 2;

  const skinMat = new THREE.MeshStandardMaterial({
    color: skinColor, roughness: skinMetal ? 0.35 : 0.75, metalness: skinMetal ? 0.6 : 0.05,
  });
  const clothMat = new THREE.MeshStandardMaterial({
    color: accent.clone().multiplyScalar(0.5), roughness: 0.6, metalness: 0.1,
    emissive: accent.clone(), emissiveIntensity: C.trimEmissiveDay,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: accent.clone(), roughness: 0.3, metalness: 0.0,
    emissive: accent.clone(), emissiveIntensity: C.eyeEmissiveDay,
  });

  const scaleY = height / 1.9;

  const root = new THREE.Group();

  const pelvis = new THREE.Group();
  pelvis.position.y = 0.95 * scaleY;
  root.add(pelvis);

  const hipW = 0.22 * buildWidth * scaleY;
  const pelvisMesh = new THREE.Mesh(new THREE.CapsuleGeometry(hipW, 0.12 * scaleY, 4, 6), skinMat);
  pelvis.add(pelvisMesh);

  const torso = new THREE.Group();
  torso.position.y = 0.18 * scaleY;
  pelvis.add(torso);
  const torsoMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.24 * buildWidth * scaleY, 0.42 * scaleY, 4, 6), clothMat
  );
  torsoMesh.position.y = 0.28 * scaleY;
  torso.add(torsoMesh);

  const shoulders = new THREE.Group();
  shoulders.position.y = 0.5 * scaleY;
  torso.add(shoulders);

  const neck = new THREE.Group();
  neck.position.y = 0.52 * scaleY;
  torso.add(neck);

  const head = new THREE.Group();
  neck.add(head);
  let headGeo;
  if (headShape === 'round') headGeo = new THREE.IcosahedronGeometry(0.16 * headScale * scaleY, 1);
  else if (headShape === 'elongated') headGeo = new THREE.CapsuleGeometry(0.11 * headScale * scaleY, 0.18 * headScale * scaleY, 3, 6);
  else if (headShape === 'angular') headGeo = new THREE.ConeGeometry(0.17 * headScale * scaleY, 0.3 * headScale * scaleY, 5);
  else headGeo = new THREE.IcosahedronGeometry(0.15 * headScale * scaleY, 0);
  const headMesh = new THREE.Mesh(headGeo, skinMat);
  headMesh.position.y = 0.14 * headScale * scaleY;
  head.add(headMesh);

  const eyeGeo = new THREE.SphereGeometry(0.025 * headScale * scaleY, 6, 6);
  const eyeR = 0.13 * headScale * scaleY;
  for (let i = 0; i < eyeCount; i++) {
    const t = eyeCount === 1 ? 0 : (i / (eyeCount - 1)) - 0.5;
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(t * eyeR * 1.6, 0.16 * headScale * scaleY + (eyeCount > 2 ? (i % 2) * 0.05 * scaleY : 0), eyeR);
    head.add(eye);
  }

  if (hasAntennae) {
    const antGeo = new THREE.CylinderGeometry(0.006 * scaleY, 0.012 * scaleY, 0.22 * scaleY, 4);
    for (const side of [-1, 1]) {
      const ant = new THREE.Mesh(antGeo, clothMat);
      ant.position.set(side * 0.08 * scaleY, 0.28 * headScale * scaleY, 0);
      ant.rotation.z = side * 0.3;
      head.add(ant);
    }
  } else if (hasCrest) {
    const crestGeo = new THREE.ConeGeometry(0.05 * scaleY, 0.2 * scaleY, 4);
    const crest = new THREE.Mesh(crestGeo, clothMat);
    crest.position.y = 0.3 * headScale * scaleY;
    crest.rotation.x = -0.3;
    head.add(crest);
  }

  function buildArm(side) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.27 * buildWidth * scaleY, 0, 0);
    shoulders.add(shoulder);
    const upperLen = 0.28 * limbScale * scaleY;
    const upperMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.045 * limbScale * scaleY, upperLen, 3, 5), skinMat);
    upperMesh.position.y = -upperLen * 0.5;
    shoulder.add(upperMesh);
    const elbow = new THREE.Group();
    elbow.position.y = -upperLen;
    shoulder.add(elbow);
    const lowerLen = 0.26 * limbScale * scaleY;
    const lowerMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.038 * limbScale * scaleY, lowerLen, 3, 5), skinMat);
    lowerMesh.position.y = -lowerLen * 0.5;
    elbow.add(lowerMesh);
    return { shoulder, elbow };
  }
  const armL = buildArm(-1);
  const armR = buildArm(1);

  function buildLeg(side) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.12 * buildWidth * scaleY, -0.06 * scaleY, 0);
    pelvis.add(hip);
    const upperLen = 0.34 * limbScale * scaleY;
    const upperMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.055 * limbScale * scaleY, upperLen, 3, 5), clothMat);
    upperMesh.position.y = -upperLen * 0.5;
    hip.add(upperMesh);
    const knee = new THREE.Group();
    knee.position.y = -upperLen;
    hip.add(knee);
    const lowerLen = 0.32 * limbScale * scaleY;
    const lowerMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.045 * limbScale * scaleY, lowerLen, 3, 5), skinMat);
    lowerMesh.position.y = -lowerLen * 0.5;
    knee.add(lowerMesh);
    return { hip, knee };
  }
  const legL = buildLeg(-1);
  const legR = buildLeg(1);

  let tail = null;
  if (hasTail) {
    tail = new THREE.Group();
    tail.position.set(0, 0.02 * scaleY, -0.2 * buildWidth * scaleY);
    pelvis.add(tail);
    const tailMesh = new THREE.Mesh(new THREE.ConeGeometry(0.04 * scaleY, 0.5 * limbScale * scaleY, 5), skinMat);
    tailMesh.rotation.x = Math.PI * 0.55;
    tailMesh.position.z = -0.2 * scaleY;
    tail.add(tailMesh);
  }

  const totalHeightApprox = 0.95 * scaleY + 0.18 * scaleY + 0.52 * scaleY + 0.3 * headScale * scaleY;
  root.position.y -= 0; // ground alignment handled by feet offset below
  const groundOffset = 0.95 * scaleY - 0.11; // approx foot clearance so pelvis sits above ground correctly

  return {
    group: root,
    joints: { pelvis, torso, head, shoulders, armL, armR, legL, legR, tail },
    materials: { skinMat, clothMat, eyeMat },
    params: { height, gaitSpeed, gaitPhase, scaleY, groundOffset },
    cityId,
  };
}

// Procedural pose driver: mode = 'idle' | 'walk' | 'talk', speed01 in [0,1]
export function poseRig(rig, dt, t, mode, speed01) {
  const { joints, params } = rig;
  const phase = t * params.gaitSpeed * 6 + params.gaitPhase;
  const lerp = (g, tx, ty, tz, rx, ry, rz, k) => {
    g.position.x = THREE.MathUtils.damp(g.position.x, tx, 8, dt);
    g.position.z = THREE.MathUtils.damp(g.position.z, tz, 8, dt);
    g.rotation.x = THREE.MathUtils.damp(g.rotation.x, rx, k, dt);
    g.rotation.y = THREE.MathUtils.damp(g.rotation.y, ry, k, dt);
    g.rotation.z = THREE.MathUtils.damp(g.rotation.z, rz, k, dt);
  };

  if (mode === 'walk') {
    const amp = 0.5 + speed01 * 0.4;
    joints.legL.hip.rotation.x = Math.sin(phase) * amp;
    joints.legR.hip.rotation.x = Math.sin(phase + Math.PI) * amp;
    joints.legL.knee.rotation.x = Math.max(0, Math.sin(phase + 0.6) * amp * 1.2);
    joints.legR.knee.rotation.x = Math.max(0, Math.sin(phase + Math.PI + 0.6) * amp * 1.2);
    joints.armL.shoulder.rotation.x = Math.sin(phase + Math.PI) * amp * 0.7;
    joints.armR.shoulder.rotation.x = Math.sin(phase) * amp * 0.7;
    joints.armL.elbow.rotation.x = 0.3 + Math.max(0, Math.sin(phase + Math.PI + 0.4)) * 0.4;
    joints.armR.elbow.rotation.x = 0.3 + Math.max(0, Math.sin(phase + 0.4)) * 0.4;
    joints.torso.rotation.y = Math.sin(phase) * 0.06;
    joints.head.rotation.y = THREE.MathUtils.damp(joints.head.rotation.y, 0, 4, dt);
  } else if (mode === 'talk') {
    const g = Math.sin(t * 3 + params.gaitPhase);
    joints.armR.shoulder.rotation.x = THREE.MathUtils.damp(joints.armR.shoulder.rotation.x, -0.9 + g * 0.15, 6, dt);
    joints.armR.elbow.rotation.x = THREE.MathUtils.damp(joints.armR.elbow.rotation.x, -1.1, 6, dt);
    joints.armL.shoulder.rotation.x = THREE.MathUtils.damp(joints.armL.shoulder.rotation.x, -0.15, 6, dt);
    joints.armL.elbow.rotation.x = THREE.MathUtils.damp(joints.armL.elbow.rotation.x, 0.2, 6, dt);
    joints.legL.hip.rotation.x = THREE.MathUtils.damp(joints.legL.hip.rotation.x, 0, 6, dt);
    joints.legR.hip.rotation.x = THREE.MathUtils.damp(joints.legR.hip.rotation.x, 0, 6, dt);
    joints.legL.knee.rotation.x = THREE.MathUtils.damp(joints.legL.knee.rotation.x, 0, 6, dt);
    joints.legR.knee.rotation.x = THREE.MathUtils.damp(joints.legR.knee.rotation.x, 0, 6, dt);
    joints.head.rotation.y = Math.sin(t * 2 + params.gaitPhase) * 0.15;
    joints.torso.rotation.y = THREE.MathUtils.damp(joints.torso.rotation.y, 0, 6, dt);
  } else {
    const breathe = Math.sin(t * 1.4 + params.gaitPhase) * 0.02;
    joints.legL.hip.rotation.x = THREE.MathUtils.damp(joints.legL.hip.rotation.x, 0, 6, dt);
    joints.legR.hip.rotation.x = THREE.MathUtils.damp(joints.legR.hip.rotation.x, 0, 6, dt);
    joints.legL.knee.rotation.x = THREE.MathUtils.damp(joints.legL.knee.rotation.x, 0, 6, dt);
    joints.legR.knee.rotation.x = THREE.MathUtils.damp(joints.legR.knee.rotation.x, 0, 6, dt);
    joints.armL.shoulder.rotation.x = THREE.MathUtils.damp(joints.armL.shoulder.rotation.x, breathe, 4, dt);
    joints.armR.shoulder.rotation.x = THREE.MathUtils.damp(joints.armR.shoulder.rotation.x, -breathe, 4, dt);
    joints.torso.position.y = THREE.MathUtils.damp(joints.torso.position.y, 0.18 * params.scaleY + breathe * 0.5, 4, dt);
    joints.head.rotation.y = THREE.MathUtils.damp(joints.head.rotation.y, Math.sin(t * 0.3 + params.gaitPhase) * 0.2, 2, dt);
  }
}

// ---------------------------------------------------------------------------
// Citizen data (logical, always exists) + rig/impostor promotion
// ---------------------------------------------------------------------------
function buildCitizenData(index, citySeed, cityId, culture, waypoints, rng, questChance) {
  const seed = (citySeed ^ Math.imul(index + 1, 2654435761)) >>> 0;
  const localRng = mulberry32(seed);
  const name = generateName(localRng);
  const species = speciesForCity(cityId);
  const hasQuest = localRng() < questChance;
  const wp = waypoints.length ? waypoints[Math.floor(localRng() * waypoints.length)] : { x: 0, z: 0 };

  const greet = pick(localRng, culture.greetings);
  const obs = pick(localRng, culture.observations);
  const req = pick(localRng, culture.requests);
  const farewell = pick(localRng, culture.farewells);
  const lines = [greet, obs];
  if (hasQuest) lines.push(req);
  lines.push(farewell);

  let offer;
  if (hasQuest) {
    if (culture.questBias === 'codex') {
      offer = { kind: 'codex', subject: `${species} customs: ${obs}` };
    } else if (culture.questBias === 'waypoint') {
      offer = {
        kind: 'waypoint',
        targetHint: `A place ${culture.pronoun} spoke of`,
        marker: { x: wp.x + (localRng() - 0.5) * 4, z: wp.z + (localRng() - 0.5) * 4 },
      };
    } else {
      offer = {
        kind: 'choice',
        prompt: req,
        options: [
          { label: 'Agree', outcomeTag: `${cityId}:${name}:agree` },
          { label: 'Decline', outcomeTag: `${cityId}:${name}:decline` },
        ],
      };
    }
  }

  return {
    id: `${cityId}:${index}`,
    seed, name, species, cityId,
    lines, offer,
    // wandering state
    pos: new THREE.Vector2(wp.x + (rng() - 0.5) * 3, wp.z + (rng() - 0.5) * 3),
    target: new THREE.Vector2(wp.x, wp.z),
    heading: rng() * Math.PI * 2,
    idleT: 0,
    mode: 'walk',
    talkT: 0,
  };
}

function pickWaypoint(rng, waypoints, from) {
  if (!waypoints.length) return { x: from.x, z: from.z };
  let best = waypoints[Math.floor(rng() * waypoints.length)];
  return { x: best.x + (rng() - 0.5) * 2, z: best.z + (rng() - 0.5) * 2 };
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------
export function createCrowd(host, opts = {}) {
  const cityId = opts.cityId ?? host.cityId ?? 'city0';
  const citySeed = hashStr('crowd:' + cityId + ':' + (opts.seed ?? 0));
  const rng = mulberry32(citySeed);
  // Interior crowds pass opts.culture (shopkeeper/lounge/caretaker) to draw
  // room-appropriate lines; street crowds use the per-city culture.
  const culture = (opts.culture && ROLE_CULTURES[opts.culture]) || cultureForCity(cityId);

  const maxRigs = opts.maxRigs ?? C.maxRigs;
  const population = opts.population ?? C.population;
  // Per-instance (was mutating the module-global C.questChance, which leaked
  // between concurrent crowds — street + interiors all share this module).
  const questChance = opts.questChance ?? C.questChance;
  // jfeelgood: how many citizens are currently "alive" and drawn. Lets the
  // crowd swell as the colony's population grows (setActiveCount below).
  let activeCount = population;

  const waypoints = (host.plazaCenters && host.plazaCenters.length)
    ? host.plazaCenters
    : (host.streetGraph && host.streetGraph.nodes) ? host.streetGraph.nodes : [{ x: 0, z: 0 }];
  const colliders = host.colliders || [];

  const group = new THREE.Group();
  group.name = `crowd:${cityId}`;

  // Logical citizen roster (always exists, deterministic)
  const citizens = [];
  for (let i = 0; i < population; i++) {
    const c = buildCitizenData(i, citySeed, cityId, culture, waypoints, rng, questChance);
    // A stationary occupant (e.g. a shopkeeper behind a counter) stays put and
    // faces the room instead of wandering.
    if (opts.stationaryFirst && i === 0) c.stationary = true;
    citizens.push(c);
  }

  // Rig pool
  const rigPool = [];
  const rigAssignments = new Map(); // citizenIndex -> pool slot index
  for (let i = 0; i < maxRigs; i++) {
    const rig = buildRig(citySeed ^ Math.imul(i + 1, 0x9e3779b1), cityId);
    rig.group.visible = false;
    group.add(rig.group);
    rigPool.push({ rig, assignedIndex: -1, t: rng() * 10 });
  }

  // Impostor instanced mesh (capsule) for all non-rig citizens
  const impostorGeo = new THREE.CapsuleGeometry(C.impostorRadius, C.impostorHeight, 3, 6);
  const impostorMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.05 });
  const impostorMesh = new THREE.InstancedMesh(impostorGeo, impostorMat, population);
  impostorMesh.frustumCulled = false;
  impostorMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(population * 3), 3);
  group.add(impostorMesh);

  const colorTmp = new THREE.Color();
  for (let i = 0; i < population; i++) {
    const localRng = mulberry32(citizens[i].seed ^ 0x1234);
    colorTmp.setHSL(localRng(), 0.4, 0.5);
    impostorMesh.setColorAt(i, colorTmp);
  }
  impostorMesh.instanceColor.needsUpdate = true;

  // Scratch (module-level within closure, no per-frame allocation)
  const _mat4 = new THREE.Matrix4();
  const _pos3 = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scale3 = new THREE.Vector3(1, 1, 1);
  const _steer = new THREE.Vector2();
  const _diff = new THREE.Vector2();
  const _up = new THREE.Vector3(0, 1, 0);

  let elapsed = 0;

  function nearestBuildingPush(x, z, out) {
    out.set(0, 0);
    for (let i = 0; i < colliders.length; i++) {
      const c = colliders[i];
      const dx = x - c.x, dz = z - c.z;
      const d = Math.hypot(dx, dz);
      const r = (c.radius || 1) + C.avoidBuildingMargin;
      if (d < r && d > 0.0001) {
        const push = (r - d) / r;
        out.x += (dx / d) * push;
        out.y += (dz / d) * push;
      }
    }
  }

  function stepCitizen(c, idx, dt, playerPos) {
    if (c.mode === 'talk') {
      // Mid-dialogue: stand still and turn toward the player. The talk gesture
      // itself plays via poseRig('talk') in the rig-drive pass.
      c.talkT += dt;
      const want = Math.atan2(playerPos.x - c.pos.x, playerPos.z - c.pos.y);
      const d = Math.atan2(Math.sin(want - c.heading), Math.cos(want - c.heading));
      c.heading += THREE.MathUtils.clamp(d, -C.turnRate * dt, C.turnRate * dt);
      return;
    }

    if (c.stationary) {
      // Planted occupant: never wanders. Turns toward the player when they're
      // close enough to talk, otherwise holds its heading.
      c.mode = 'idle';
      _diff.set(c.pos.x - playerPos.x, c.pos.y - playerPos.z);
      if (_diff.lengthSq() < 16) {
        const want = Math.atan2(playerPos.x - c.pos.x, playerPos.z - c.pos.y);
        const d = Math.atan2(Math.sin(want - c.heading), Math.cos(want - c.heading));
        c.heading += THREE.MathUtils.clamp(d, -C.turnRate * dt, C.turnRate * dt);
      }
      return;
    }

    c.idleT -= dt;
    // pos and target store (x, z) in Vector2s as (.x, .y)
    _diff.set(c.target.x - c.pos.x, c.target.y - c.pos.y);
    const dist = _diff.length();

    if (dist < C.waypointReachDist) {
      if (c.mode !== 'idle') { c.mode = 'idle'; c.idleT = THREE.MathUtils.lerp(C.idleMinT, C.idleMaxT, Math.random() * 0 + ((c.seed % 1000) / 1000)); }
      if (c.idleT <= 0) {
        const localRng = mulberry32((c.seed ^ Math.floor(elapsed * 7)) >>> 0);
        const wp = pickWaypoint(localRng, waypoints, c.pos);
        c.target.set(wp.x, wp.z);
        c.mode = 'walk';
      }
      return;
    }
    c.mode = 'walk';

    _steer.copy(_diff).normalize();

    nearestBuildingPush(c.pos.x, c.pos.y, _diff);
    _steer.x += _diff.x * 2.0;
    _steer.y += _diff.y * 2.0;

    _diff.set(c.pos.x - playerPos.x, c.pos.y - playerPos.z);
    const pd = _diff.length();
    if (pd < C.playerAvoidRadius && pd > 0.001) {
      const push = (C.playerAvoidRadius - pd) / C.playerAvoidRadius;
      _steer.x += (_diff.x / pd) * push * C.playerAvoidStrength;
      _steer.y += (_diff.y / pd) * push * C.playerAvoidStrength;
    }

    if (_steer.lengthSq() > 0.0001) _steer.normalize();
    const desiredHeading = Math.atan2(_steer.x, _steer.y);
    let headingDiff = desiredHeading - c.heading;
    headingDiff = Math.atan2(Math.sin(headingDiff), Math.cos(headingDiff));
    const maxTurn = C.turnRate * dt;
    c.heading += THREE.MathUtils.clamp(headingDiff, -maxTurn, maxTurn);

    const speed = C.walkSpeed * (0.8 + 0.4 * ((c.seed % 100) / 100));
    c.pos.x += Math.sin(c.heading) * speed * dt;
    c.pos.y += Math.cos(c.heading) * speed * dt;
  }

  function update(dt, playerPos, sunDot) {
    elapsed += dt;
    const dayFactor = THREE.MathUtils.clamp(sunDot ?? 0.5, 0, 1);
    const eyeEm = THREE.MathUtils.lerp(C.eyeEmissiveNight, C.eyeEmissiveDay, dayFactor);
    const trimEm = THREE.MathUtils.lerp(C.trimEmissiveNight, C.trimEmissiveDay, dayFactor);

    for (let i = 0; i < activeCount; i++) {
      const c = citizens[i];
      stepCitizen(c, i, dt, playerPos);
    }

    // Promotion / demotion pass (distance based, hysteresis via separate thresholds)
    for (let i = 0; i < activeCount; i++) {
      const c = citizens[i];
      if (rigAssignments.has(i)) continue;
      const dx = c.pos.x - playerPos.x, dz = c.pos.y - playerPos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < C.promoteDist * C.promoteDist) {
        const free = rigPool.find((s) => s.assignedIndex === -1);
        if (free) {
          free.assignedIndex = i;
          rigAssignments.set(i, free);
          free.rig.group.visible = true;
        }
      }
    }
    for (const [idx, slot] of rigAssignments) {
      const c = citizens[idx];
      if (c.mode === 'talk') continue; // never demote under an open dialogue
      const dx = c.pos.x - playerPos.x, dz = c.pos.y - playerPos.z;
      const d2 = dx * dx + dz * dz;
      if (idx >= activeCount || d2 > C.demoteDist * C.demoteDist) {
        slot.assignedIndex = -1;
        slot.rig.group.visible = false;
        rigAssignments.delete(idx);
      }
    }

    // Drive active rigs
    for (const [idx, slot] of rigAssignments) {
      const c = citizens[idx];
      const rig = slot.rig;
      slot.t += dt;
      const y = (host.groundHeightAt ? host.groundHeightAt(c.pos.x, c.pos.y) : 0) + rig.params.groundOffset;
      rig.group.position.set(c.pos.x, y, c.pos.y);
      rig.group.rotation.y = c.heading;
      const speed01 = c.mode === 'walk' ? 1 : 0;
      poseRig(rig, dt, slot.t, c.mode, speed01);
      rig.materials.eyeMat.emissiveIntensity = eyeEm;
      rig.materials.clothMat.emissiveIntensity = trimEm;
    }

    // Update impostors for everyone NOT currently an active rig
    for (let i = 0; i < activeCount; i++) {
      const c = citizens[i];
      if (rigAssignments.has(i)) {
        _mat4.makeScale(0, 0, 0); // hide impostor slot when rig active
        impostorMesh.setMatrixAt(i, _mat4);
        continue;
      }
      const y = (host.groundHeightAt ? host.groundHeightAt(c.pos.x, c.pos.y) : 0) + C.impostorHeight * 0.5 + C.impostorRadius;
      _pos3.set(c.pos.x, y, c.pos.y);
      _quat.setFromAxisAngle(_up, c.heading);
      _scale3.set(1, 1, 1);
      _mat4.compose(_pos3, _quat, _scale3);
      impostorMesh.setMatrixAt(i, _mat4);
    }
    impostorMesh.instanceMatrix.needsUpdate = true;
  }

  // jfeelgood: grow/shrink the visible-and-simulated crowd as the colony's
  // population changes. Impostors beyond activeCount aren't drawn.
  function setActiveCount(n) {
    activeCount = Math.max(0, Math.min(population, n | 0));
    impostorMesh.count = activeCount;
  }

  function nearestInteractable(playerPos, maxDist = C.talkTriggerDist) {
    // Active rig pool only (contract): impostors are scenery, not speakers.
    let best = null, bestD = maxDist * maxDist;
    for (const idx of rigAssignments.keys()) {
      const c = citizens[idx];
      const dx = c.pos.x - playerPos.x, dz = c.pos.y - playerPos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) { bestD = d2; best = c; }
    }
    return best;
  }

  function interact(citizen) {
    if (!citizen) return null;
    citizen.mode = 'talk';
    citizen.talkT = 0;
    // Contract: waypoint markers are Vector3s in this group's local space.
    // buildCitizenData stores a flat {x, z}; upgrade lazily here (interact may
    // allocate) with the ground height sampled from the host, and cache it.
    const offer = citizen.offer;
    if (offer && offer.kind === 'waypoint' && !offer.marker.isVector3) {
      const m = offer.marker;
      const y = host.groundHeightAt ? host.groundHeightAt(m.x, m.z) : 0;
      offer.marker = new THREE.Vector3(m.x, y, m.z);
    }
    return {
      speaker: { name: citizen.name, species: citizen.species, cityId: citizen.cityId },
      lines: citizen.lines,
      offer: citizen.offer,
    };
  }

  function endInteract(citizen) {
    // Safe to call twice or with a stale/foreign entity.
    if (citizen && citizen.mode === 'talk') {
      citizen.mode = 'walk';
      citizen.talkT = 0;
    }
  }

  function dispose() {
    for (const slot of rigPool) {
      slot.rig.group.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
    }
    impostorGeo.dispose();
    impostorMat.dispose();
    impostorMesh.dispose(); // frees the InstancedMesh instance buffers
    group.clear();
  }

  return {
    group,
    update,
    dispose,
    setActiveCount,
    citizens, // logical roster, for binding dialogue to sim natives
    count: citizens.length,
    nearestInteractable,
    interact,
    endInteract,
  };
}

// ---------------------------------------------------------------------------
// Wiring example (host = the city module's returned handle plus cityId/seed):
//
//   import { createCrowd } from './aliens.js';
//   const crowd = createCrowd(
//     { groundHeightAt: city.groundHeightAt, plazaCenters: city.plazas, colliders: city.colliders, cityId: city.id },
//     { maxRigs: 24, population: 48, questChance: 0.28, seed: city.seed }
//   );
//   city.group.add(crowd.group); // add under the same unrotated local space as streets
//   // each frame: crowd.update(dt, playerLocalPos, sunDot);
//   // on talk key: const npc = crowd.nearestInteractable(playerLocalPos, 2.5);
//   //              if (npc) ui.showDialogue(crowd.interact(npc));
//   // when the dialogue closes (any reason): crowd.endInteract(npc);
//   // on city teardown: crowd.dispose();
// ---------------------------------------------------------------------------