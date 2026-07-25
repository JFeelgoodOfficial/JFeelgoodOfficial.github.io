// citydialogue.js — turns a citizen into a few spoken lines for the shared info
// card (hud.showCard). The world no longer races through generations, so people
// speak to a settled, purposeful life: city folk talk about the work they do —
// farming the river terraces, tending the flower gardens, baking, blending
// perfume, trading at the market — and how the season is treating the town.
// Out in the far biomes, the scientists of the research outposts talk about the
// terrain and weather they've come to study.
//
// `life` (from biomeCivs.js) carries: { kind:'city'|'outpost', biome, name,
// economy, roleOf(citizen) }.

import { CITY_ROLES, makeContext, fillVars } from './city/citizenRoles.js';

const CITY_OPENERS = [
  'They set down their work to greet you.',
  'They meet your eyes with an easy, settled smile.',
  'They dip their head, unhurried.',
  'They wave you over from the roadside.',
];

const OUTPOST_OPENERS = [
  'They look up from a readout, surprised to see anyone out here.',
  'They lower a sensor wand and nod.',
  'They wave, glad of the company this far from the mainland.',
];

// Role-flavoured lines for the permanent city. {season} filled at runtime.
const ROLE_LINES = {
  farmer: (e) => `"I work the river terraces. ${e.season === 'winter' ? 'The fields rest under frost now, so we live from the granary.' : e.season === 'spring' ? 'Spring is on us — the crop is coming in fast.' : 'Steady rows, steady bread.'} We keep ${e.stockpile('crop')} of crop in store."`,
  gardener: (e) => `"The flower gardens are mine to keep. ${e.bloomPoints} beds in bloom right now — they feed the perfumery and lift the whole town's spirits. There's no coin in beauty, and yet it's everything."`,
  artisan: (e) => `"I bake, and I blend. Crop becomes bread, flowers become dye and perfume. ${e.stockpile('bread')} loaves and ${e.stockpile('perfume')} phials ready for the stalls."`,
  merchant: (e) => `"I trade at the market — bread and perfume for coin, and coin for whatever the town needs. The treasury sits at ${e.currency} just now. ${cap(e.activity())}."`,
  caretaker: (e) => `"Someone has to keep the town hall's books. Happiness is ${e.happinessPct}% and the tax pool at ${e.taxPool} — enough to keep the lamps lit and the bridges sound."`,
  resident: (e) => `"I just live here — and gladly. There's bread, there are gardens, and the towers give us room to grow up instead of out. Take the elevator up one; the view over the terraces is something."`,
};

const OUTPOST_LINES = {
  desert: 'the dune fields and how the heat bends the horizon',
  alpine: 'the ice and how the peaks were pushed up out of the crust',
  plains: 'the grasslands and the weather that rolls across them',
  forest: 'the woodland soils and the river that feeds the mainland',
};

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function pick(arr, seed) { return arr[Math.abs(seed | 0) % arr.length]; }

export function buildCitizenCard(citizen, life) {
  const nameSeed = hashName(citizen.name || 'stranger');
  const body = [];

  if (life.kind === 'outpost') {
    body.push(pick(OUTPOST_OPENERS, nameSeed));
    const subject = OUTPOST_LINES[life.biome] || 'this strange, quiet biome';
    body.push(`"I'm ${citizen.name}, one of a few researchers stationed out here. We study ${subject}. No city will ever rise in this place — that's rather the point. It's ours to understand, not to build over."`);
    return {
      kicker: `Scientist · ${life.biome} outpost`,
      title: citizen.name,
      meta: `${cap(life.biome)} research station`,
      body,
    };
  }

  // city
  const e = life.economy;
  const role = life.roleOf(citizen);
  body.push(pick(CITY_OPENERS, nameSeed));
  const roleLine = ROLE_LINES[role] || ROLE_LINES.resident;
  body.push(`"I am ${citizen.name}." ` + roleLine(e));

  return {
    kicker: `${life.name} · ${cap(role)}`,
    title: citizen.name,
    meta: e ? `${cap(e.season)} · town happiness ${e.happinessPct}%` : life.name,
    body,
  };
}

function hashName(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Branching dialogue for the permanent town's citizens
// ---------------------------------------------------------------------------
// The town already assigns each citizen a role (farmer, gardener, artisan,
// merchant, caretaker, resident). Each role speaks a full dialogue TREE —
// greeting, player choices, responses and follow-ups — instead of a single
// card. The trees live in city/citizenRoles.js; their {{variables}} are filled
// from the live economy where it has a matching figure, so a farmer quotes the
// real season and the real crop in store.

// town role -> tree role name in citizenRoles.js
const ROLE_TREE = {
  farmer: 'Farmer',
  gardener: 'Gardener',
  artisan: 'Artisan',
  merchant: 'Merchant',
  caretaker: 'Caretaker',
};
// Residents get one of the remaining trees, picked deterministically by name so
// the town has scholars, guides, apprentices, patrons and entertainers in it.
const RESIDENT_TREES = ['Scholar', 'Tourist Guide', 'Apprentice', 'Patron', 'Entertainer'];

export function buildCitizenDialogue(citizen, life) {
  const seed = hashName(citizen.name || 'stranger');
  const role = life && life.roleOf ? life.roleOf(citizen) : 'resident';
  const treeName = ROLE_TREE[role] || RESIDENT_TREES[seed % RESIDENT_TREES.length];
  const tree = CITY_ROLES.find((r) => r.role === treeName) || CITY_ROLES[0];

  // Deterministic flavour, overridden by real economy figures where they exist.
  const ctx = makeContext(seed);
  const e = life && life.economy;
  if (e) {
    if (e.season) ctx.season = e.season;
    if (typeof e.stockpile === 'function') {
      const crop = e.stockpile('crop');
      if (crop != null) ctx.cropCount = crop;
    }
  }

  const choices = tree.choices.map((c) => ({
    label: fillVars(c.label, ctx),
    say: fillVars(c.say, ctx),
    end: !!c.end,
    then: (c.then || []).map((f) => ({ label: fillVars(f.label, ctx), say: fillVars(f.say, ctx) })),
  }));

  return {
    kicker: `${tree.role} · ${life && life.name ? life.name : 'the town'}`,
    title: citizen.name,
    greeting: fillVars(tree.greeting, ctx),
    choices,
  };
}
