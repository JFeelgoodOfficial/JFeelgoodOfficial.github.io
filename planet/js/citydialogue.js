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
