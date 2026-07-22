// civsim.js — population + genetics + civilisation-age simulation for one
// biome colony. Extracted from Anselm (Anselm-v3_7_0-1.html): the genetics
// core (randomTraits / countTraitMatches / canMate / createOffspring, 15%
// mutation, generations, bloodlines), the DNA-diversity metric, and the
// DNA-driven civ-age XP formula — but decoupled from Anselm's 5-realm globals
// into a single self-contained instance, and run on a compressed clock so a
// colony climbs from its founding to a spaceport launch in ~2 minutes of
// continuous play.
//
// The sim is pure demographics + progression: no rendering, no spatial state.
// citylife.js maps `development` (0..1) onto the city's physical growth and
// binds visible crowd members to these native records for dialogue.

const TRAIT_KEYS = [
  'agility', 'work', 'social', 'faith', 'resilience', 'curiosity',
  'hairColor', 'skinColor', 'gender',
];
const BINARY_KEYS = ['agility', 'work', 'social', 'faith', 'resilience', 'curiosity'];

const NATIVE_FIRST = [
  'Aeryn', 'Bract', 'Cael', 'Doune', 'Eshe', 'Faro', 'Gwyn', 'Hale', 'Iri',
  'Joss', 'Kite', 'Lune', 'Mira', 'Nael', 'Oro', 'Pell', 'Quill', 'Rhen',
  'Sable', 'Tovi', 'Umbra', 'Vesh', 'Wren', 'Xael', 'Yarrow', 'Zinn',
];
const NATIVE_PERSONALITY = ['tender', 'wanderer', 'builder', 'seeker', 'keeper', 'kindler'];
const BLOODLINE_NAMES = [
  'Vaelor', 'Ansem', 'Corliss', 'Duenna', 'Ehrmark', 'Fenwick', 'Galewind',
  'Hearthborn', 'Ilmaren', 'Jorunn', 'Kesselheim', 'Lowen',
];

// The ages a colony climbs through. `tier` is only for flavour; `xp` is the
// cumulative XP needed to ENTER that age. The final age is the launch age.
export const CIV_AGES = [
  { name: 'Founding', xp: 0 },
  { name: 'Settlement', xp: 500 },
  { name: 'Township', xp: 1500 },
  { name: 'City', xp: 3200 },
  { name: 'Metropolis', xp: 5200 },
  { name: 'Ascendant', xp: 7700 }, // spaceport rises; the ark launches
];
const FINAL_XP = CIV_AGES[CIV_AGES.length - 1].xp;

// --- tunables (retuned during verification for the ~2-minute arc) ---
const POP_START = 6;
const POP_CAP = 60;
const BIRTH_RATE = 0.055;   // logistic births/sec coefficient (fills cap ~70s)
const BASE_XP = 100;        // civ XP scale

function makeRNG(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTraits(rng) {
  return {
    agility: Math.floor(rng() * 2),
    work: Math.floor(rng() * 2),
    social: Math.floor(rng() * 2),
    faith: Math.floor(rng() * 2),
    resilience: Math.floor(rng() * 2),
    curiosity: Math.floor(rng() * 2),
    hairColor: Math.floor(rng() * 6),
    skinColor: Math.floor(rng() * 4),
    gender: Math.floor(rng() * 2), // 0 / 1
  };
}

function countTraitMatches(a, b) {
  let m = 0;
  for (const k of TRAIT_KEYS) if (a.traits[k] === b.traits[k]) m++;
  return m;
}

// Anselm's rule: opposite gender, not sharing a parent (inbreeding block),
// and at least two matching traits (assortative mating threshold).
function canMate(a, b) {
  if (a.traits.gender === b.traits.gender) return false;
  if (a.parents && b.parents) {
    for (const p of a.parents) if (b.parents.includes(p)) return false;
    if (a.parents.includes(b.id) || b.parents.includes(a.id)) return false;
  }
  return countTraitMatches(a, b) >= 2;
}

export function createCivSim(opts = {}) {
  const rng = makeRNG((opts.seed ?? 1) >>> 0);
  let uid = 0;
  const onEvent = opts.onEvent || (() => {});

  function makeFounder() {
    return {
      id: ++uid,
      name: NATIVE_FIRST[Math.floor(rng() * NATIVE_FIRST.length)],
      personality: NATIVE_PERSONALITY[Math.floor(rng() * NATIVE_PERSONALITY.length)],
      traits: randomTraits(rng),
      generation: 1,
      parents: [],
      bloodline: null,
    };
  }

  function createOffspring(a, b) {
    const childTraits = {};
    for (const k of TRAIT_KEYS) childTraits[k] = rng() < 0.5 ? a.traits[k] : b.traits[k];
    // 15% chance: flip/reroll one trait (mutation)
    if (rng() < 0.15) {
      const k = TRAIT_KEYS[Math.floor(rng() * TRAIT_KEYS.length)];
      if (k === 'hairColor') childTraits[k] = Math.floor(rng() * 6);
      else if (k === 'skinColor') childTraits[k] = Math.floor(rng() * 4);
      else childTraits[k] = childTraits[k] === 0 ? 1 : 0;
    }
    const gen = Math.max(a.generation, b.generation) + 1;
    let bloodline = a.bloodline || b.bloodline || null;
    if (!bloodline && gen >= 5) {
      bloodline = BLOODLINE_NAMES[uid % BLOODLINE_NAMES.length];
      onEvent({ type: 'bloodline', bloodline, generation: gen });
    }
    return {
      id: ++uid,
      name: NATIVE_FIRST[Math.floor(rng() * NATIVE_FIRST.length)],
      personality: NATIVE_PERSONALITY[Math.floor(rng() * NATIVE_PERSONALITY.length)],
      traits: childTraits,
      generation: gen,
      parents: [a.id, b.id],
      bloodline,
    };
  }

  // DNA diversity 0..1 — max when each binary trait is a 50/50 split.
  function dnaScore() {
    if (!natives.length) return 0;
    let sum = 0;
    for (const k of BINARY_KEYS) {
      const ones = natives.reduce((c, n) => c + n.traits[k], 0);
      const ratio = ones / natives.length;
      sum += 1 - Math.abs(ratio - 0.5) * 2;
    }
    return sum / BINARY_KEYS.length;
  }

  function attemptBirth() {
    if (natives.length >= POP_CAP) {
      // at carrying capacity, generational turnover: a new child replaces the
      // lowest-generation elder (Anselm's cap-replacement rule).
      const pair = pickMatablePair();
      if (!pair) return;
      const child = createOffspring(pair[0], pair[1]);
      let lowIdx = 0;
      for (let i = 1; i < natives.length; i++) {
        if (natives[i].generation < natives[lowIdx].generation) lowIdx = i;
      }
      natives[lowIdx] = child;
      return;
    }
    const pair = pickMatablePair();
    if (!pair) return;
    natives.push(createOffspring(pair[0], pair[1]));
  }

  function pickMatablePair() {
    // a few random tries for a compatible couple
    for (let attempt = 0; attempt < 12; attempt++) {
      const a = natives[Math.floor(rng() * natives.length)];
      const b = natives[Math.floor(rng() * natives.length)];
      if (a !== b && canMate(a, b)) return [a, b];
    }
    return null;
  }

  // --- state ---
  const natives = [];
  for (let i = 0; i < POP_START; i++) natives.push(makeFounder());

  let elapsed = 0;
  let xp = 0;
  let birthAccum = 0;
  let ageIdx = 0;
  let topAgeReached = false;

  function avgGeneration() {
    if (!natives.length) return 1;
    return natives.reduce((s, n) => s + n.generation, 0) / natives.length;
  }

  function step(dt) {
    if (dt <= 0) return;
    elapsed += dt;
    const pop = natives.length;
    const popFactor = pop / POP_CAP;

    // logistic births: fastest at mid-population, tapering toward the cap
    birthAccum += dt * BIRTH_RATE * pop * (1 - popFactor);
    while (birthAccum >= 1) { attemptBirth(); birthAccum -= 1; }

    // DNA-driven civ XP: more people + more genetic diversity + deeper
    // generations advance the civilisation faster (Anselm's formula, distilled).
    const dna = dnaScore();
    const genMult = Math.min(avgGeneration() / 8, 1);
    const rate = BASE_XP * (0.32 + 0.68 * popFactor) * (0.7 + 0.6 * dna) * (0.75 + 0.5 * genMult);
    xp += rate * dt;

    // age transitions
    let ai = 0;
    for (let i = 0; i < CIV_AGES.length; i++) if (xp >= CIV_AGES[i].xp) ai = i;
    if (ai !== ageIdx) {
      ageIdx = ai;
      onEvent({ type: 'age', index: ageIdx, name: CIV_AGES[ageIdx].name });
    }
    if (!topAgeReached && xp >= FINAL_XP) {
      topAgeReached = true;
      onEvent({ type: 'ascend', name: CIV_AGES[CIV_AGES.length - 1].name });
    }
  }

  function dominantBloodline() {
    const counts = new Map();
    for (const n of natives) if (n.bloodline) counts.set(n.bloodline, (counts.get(n.bloodline) || 0) + 1);
    let best = null, bestC = 0;
    for (const [bl, c] of counts) if (c > bestC) { best = bl; bestC = c; }
    return best;
  }

  return {
    natives,
    step,
    get development() { return Math.min(xp / FINAL_XP, 1); },
    get population() { return natives.length; },
    get age() { return ageIdx; },
    get ageName() { return CIV_AGES[ageIdx].name; },
    get avgGeneration() { return avgGeneration(); },
    get dnaScore() { return dnaScore(); },
    get topAgeReached() { return topAgeReached; },
    get elapsed() { return elapsed; },
    dominantBloodline,
  };
}
