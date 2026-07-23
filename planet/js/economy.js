// economy.js — a lightweight, self-contained economy for the permanent city.
//
// This is the "visual + light sim" tier: it embeds the supplied game economy
// schema (resources / buildings / citizen roles / seasonal modifiers) and runs
// a small deterministic ticker so the town has a living pulse — crops and
// flowers grow, bakeries and perfumeries turn produce into goods, the market
// converts goods into currency, and the seasons wheel round changing yields.
// Citizen dialogue (citydialogue.js) reads this state so the people speak to
// what the town is actually doing right now. It intentionally does NOT model
// per-citizen needs/happiness micromanagement — happiness is a single
// town-wide scalar derived from food stock and garden bloom.
//
// No DOM, no Three.js, no external deps — pure numbers so it can tick headless.

// The schema, embedded verbatim from game_economy_schema.json so the town and
// the dialogue share one source of truth.
export const SCHEMA = {
  resources: {
    seed: { type: 'raw', category: 'farming' },
    water: { type: 'raw', category: 'utility' },
    soil_nutrient: { type: 'raw', category: 'farming' },
    wood: { type: 'raw', category: 'material' },
    stone: { type: 'raw', category: 'material' },
    crop: { type: 'produced', category: 'farming', producedFrom: ['seed', 'water', 'soil_nutrient'] },
    flower: { type: 'produced', category: 'garden', producedFrom: ['seed', 'water', 'soil_nutrient'] },
    bread: { type: 'processed', category: 'goods', producedFrom: ['crop'] },
    dye: { type: 'processed', category: 'goods', producedFrom: ['flower'] },
    perfume: { type: 'processed', category: 'goods', producedFrom: ['flower', 'dye'] },
    currency: { type: 'abstract', category: 'economy' },
    bloom_points: { type: 'abstract', category: 'beauty' },
  },
  buildings: {
    farm_plot: { inputs: { seed: 1, water: 2 }, outputs: { crop: 3 }, cycleTimeHours: 24, seasonRestricted: true, workerRole: 'farmer' },
    garden_plot: { inputs: { seed: 1, water: 2, soil_nutrient: 1 }, outputs: { flower: 2, bloom_points: 1 }, cycleTimeHours: 20, seasonRestricted: true, workerRole: 'gardener' },
    bakery: { inputs: { crop: 4 }, outputs: { bread: 3 }, cycleTimeHours: 8, workerRole: 'artisan' },
    perfumery: { inputs: { flower: 3, dye: 1 }, outputs: { perfume: 2 }, cycleTimeHours: 12, workerRole: 'artisan' },
    market_stall: { inputs: { bread: 2, perfume: 1, crop: 2, flower: 2 }, outputs: { currency: 50 }, cycleTimeHours: 6, workerRole: 'merchant' },
    town_hall: { inputs: { currency: 10 }, outputs: { tax_pool: 5 }, cycleTimeHours: 24, workerRole: 'caretaker' },
  },
  roles: {
    farmer: { assignedBuilding: 'farm_plot', incomeTier: 'low', happinessImpact: 0.1 },
    gardener: { assignedBuilding: 'garden_plot', incomeTier: 'low', happinessImpact: 0.4 },
    artisan: { assignedBuilding: ['bakery', 'perfumery'], incomeTier: 'medium', happinessImpact: 0.2 },
    merchant: { assignedBuilding: 'market_stall', incomeTier: 'medium', happinessImpact: 0.1 },
    caretaker: { assignedBuilding: 'town_hall', incomeTier: 'high', happinessImpact: 0.3 },
  },
  seasonalModifiers: {
    spring: { crop: 1.2, flower: 1.3 },
    summer: { crop: 1.0, flower: 1.1 },
    autumn: { crop: 0.8, flower: 0.7 },
    winter: { crop: 0.2, flower: 0.1 },
  },
  taxRate: 0.1,
};

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

// How fast game-time flows relative to real seconds. A 24h farm cycle then
// tops out in 24 / 3 = 8s of watching, so stockpiles visibly move without
// spinning too fast to read.
const GAME_HOURS_PER_SEC = 3;
// A full year (all four seasons) wheels round in this many real seconds, so the
// season the citizens mention drifts on a comfortable ~6.5-minute cycle.
const YEAR_SECONDS = 390;

// The dominant bloodline-free flavor names the sim hands out; purely cosmetic.
const ROLE_LABEL = {
  farmer: 'Farmer', gardener: 'Gardener', artisan: 'Artisan',
  merchant: 'Merchant', caretaker: 'Caretaker',
};

// opts: { counts: {farm_plot, garden_plot, bakery, perfumery, market_stall, town_hall}, seed }
export function createEconomy(opts = {}) {
  const counts = Object.assign(
    { farm_plot: 6, garden_plot: 5, bakery: 2, perfumery: 1, market_stall: 3, town_hall: 1 },
    opts.counts || {},
  );

  // Raw inputs are treated as replenishing (wells, seed stores, compost), so we
  // hold them at a comfortable working level rather than mining them to zero —
  // this keeps the light sim from stalling. Produced/processed goods flow.
  const RAW = new Set(['seed', 'water', 'soil_nutrient', 'wood', 'stone']);
  const RAW_LEVEL = 40;

  const stock = {};
  for (const r of Object.keys(SCHEMA.resources)) stock[r] = 0;
  for (const r of RAW) stock[r] = RAW_LEVEL;
  // seed the town with a little produce so the first market cycles have trade
  stock.crop = 12; stock.flower = 10; stock.bread = 4; stock.dye = 2; stock.perfume = 1;
  let currency = 120;
  let bloomPoints = 0;
  let taxPool = 0;

  // Per-building cycle progress (game-hours accumulated toward cycleTimeHours),
  // one accumulator per building TYPE (all instances of a type share a phase
  // but produce ×count each cycle — a light-sim simplification).
  const progress = {};
  for (const b of Object.keys(counts)) progress[b] = 0;

  let elapsed = 0;      // real seconds since start
  let gameHours = 0;    // accumulated game hours
  let happiness = 0.6;  // town-wide scalar 0..1
  const totals = { crop: 0, flower: 0, bread: 0, perfume: 0, currencyEarned: 0 };

  function seasonInfo() {
    const yearT = (elapsed % YEAR_SECONDS) / YEAR_SECONDS; // 0..1
    const idx = Math.min(SEASONS.length - 1, Math.floor(yearT * SEASONS.length));
    return { name: SEASONS[idx], t: yearT };
  }

  function tryCycle(type) {
    const spec = SCHEMA.buildings[type];
    const n = counts[type] || 0;
    if (!n || !spec) return;

    // The market sells whatever produce is on hand rather than blocking on a
    // full cart — so trade (and coin) keeps flowing even when one good is out
    // of season. Coin scales with how full the cart was.
    if (type === 'market_stall') {
      let sold = 0, slots = 0;
      for (const [res, amt] of Object.entries(spec.inputs)) {
        slots += amt * n;
        const take = Math.min(stock[res] || 0, amt * n);
        stock[res] = Math.max(0, (stock[res] || 0) - take);
        sold += take;
      }
      if (sold <= 0) return;
      const earned = (spec.outputs.currency || 0) * n * (sold / slots);
      currency += earned;
      totals.currencyEarned += earned;
      taxPool += earned * SCHEMA.taxRate;
      return;
    }

    // enough inputs for one instance's cycle? (raw are effectively infinite)
    for (const [res, amt] of Object.entries(spec.inputs)) {
      if (RAW.has(res)) continue;
      if ((stock[res] || 0) < amt * n) return; // not enough produced goods yet
    }
    // consume
    for (const [res, amt] of Object.entries(spec.inputs)) {
      if (RAW.has(res)) { stock[res] = RAW_LEVEL; continue; } // topped back up
      stock[res] = Math.max(0, (stock[res] || 0) - amt * n);
    }
    // produce, with seasonal modifiers on season-restricted yields
    const season = seasonInfo().name;
    const mod = SCHEMA.seasonalModifiers[season] || {};
    for (const [res, amt] of Object.entries(spec.outputs)) {
      let out = amt * n;
      if (spec.seasonRestricted && mod[res] != null) out *= mod[res];
      if (res === 'currency') {
        const earned = out;
        currency += earned;
        totals.currencyEarned += earned;
        taxPool += earned * SCHEMA.taxRate;
      } else if (res === 'tax_pool') {
        // town hall converts currency into civic tax pool
        if (currency >= spec.inputs.currency * n) taxPool += out;
      } else if (res === 'bloom_points') {
        bloomPoints += out;
      } else {
        stock[res] = (stock[res] || 0) + out;
        if (totals[res] != null) totals[res] += out;
      }
    }
  }

  function step(dt) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.2); // clamp long frame gaps so a tab-return doesn't dump a year in
    elapsed += dt;
    const dh = dt * GAME_HOURS_PER_SEC;
    gameHours += dh;
    for (const type of Object.keys(counts)) {
      const spec = SCHEMA.buildings[type];
      if (!spec || !counts[type]) continue;
      progress[type] += dh;
      // run as many cycles as fit (usually 0 or 1 per frame)
      let guard = 0;
      while (progress[type] >= spec.cycleTimeHours && guard < 8) {
        progress[type] -= spec.cycleTimeHours;
        tryCycle(type);
        guard++;
      }
    }
    // The schema lists dye as processed-from-flower but names no building for
    // it, so a dyer's step turns surplus flowers into dye — this keeps the
    // perfumery (flower + dye -> perfume) supplied instead of stalling forever.
    if ((stock.flower || 0) > 4 && (stock.dye || 0) < 3) { stock.flower -= 1; stock.dye = (stock.dye || 0) + 1; }
    // happiness: bright when the granary is stocked and the gardens bloom, per
    // the schema's beauty/food emphasis. Eased toward the target so it drifts.
    const foodSat = Math.min(1, (stock.crop + stock.bread) / 30);
    const beautySat = Math.min(1, bloomPoints / 60 + counts.garden_plot / 12);
    const target = 0.25 + 0.4 * foodSat + 0.35 * beautySat;
    happiness += (target - happiness) * Math.min(1, dt * 0.5);
  }

  function stockpile(res) { return Math.round(stock[res] || 0); }

  // A short human phrase describing the busiest current flow, for dialogue.
  function activity() {
    const season = seasonInfo().name;
    const mod = SCHEMA.seasonalModifiers[season] || {};
    if (season === 'winter') return 'the fields rest under frost, so we live from the granary';
    if ((mod.flower || 1) >= 1.2) return 'the gardens are throwing colour and the perfumery can barely keep up';
    if ((mod.crop || 1) >= 1.1) return 'the crop is coming in fast and the ovens run all day';
    return 'trade is steady — bread and perfume for coin at the stalls';
  }

  return {
    step,
    counts,
    get season() { return seasonInfo().name; },
    get seasonT() { return seasonInfo().t; },
    get currency() { return Math.round(currency); },
    get bloomPoints() { return Math.round(bloomPoints); },
    get taxPool() { return Math.round(taxPool); },
    get happiness() { return happiness; },
    get happinessPct() { return Math.round(happiness * 100); },
    get totals() { return totals; },
    stockpile,
    activity,
    roleLabel: (role) => ROLE_LABEL[role] || 'Townsfolk',
  };
}
