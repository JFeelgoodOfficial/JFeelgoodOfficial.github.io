// citizenRoles.js — the fixed roster of town citizens and their branching
// dialogue trees, transcribed from citizen_dialogue_trees.md. The town crowd is
// capped to exactly these roles (see mainlandTown.js), one citizen per
// role, so every person you meet is one of these ten and speaks their tree.
//
// Tree shape:
//   { role, greeting, choices: [ { label, say, then?: [ { label, say } ], end? } ] }
// A `then` array turns a choice into a sub-branch (the file's "→" follow-ups);
// `end: true` (the "Say goodbye" line) closes the conversation.
//
// {{variables}} in the text are filled per-citizen by makeContext()/fillVars()
// from the citizen's deterministic seed (the planet has no crop economy, so the
// values are stable flavour rather than live game state).

export const CITY_ROLES = [
  {
    role: 'Farmer',
    greeting: "Another day, another row to plow. The soil's been kind to us this {{season}}.",
    choices: [
      {
        label: 'Ask about crops',
        say: "We've got {{cropCount}} plots growing right now. {{crop}} is coming in strong, but the {{lowCrop}} needs more water.",
        then: [
          { label: 'Offer to help with irrigation', say: "Bless you! Bring me {{water}} units and I'll owe you a favor." },
          { label: 'Ask what sells best', say: "Bread flour crops always move fast at market. Perfume flowers pay more, but that's the gardener's game." },
        ],
      },
      { label: 'Ask about the season', say: "Winter's rough on us — yields drop to near nothing. Spring and summer are when we make our living." },
      { label: 'Ask about life in the city', say: "Low pay, but honest work. Without us, nobody eats — not even the merchants who think they run this place." },
      { label: 'Say goodbye', say: "Mind the fences on your way out. Come back when the harvest's in.", end: true },
    ],
  },
  {
    role: 'Gardener',
    greeting: "Careful where you step — those lavender buds are almost ready to bloom.",
    choices: [
      {
        label: 'Ask about the gardens',
        say: "Every bloom point we earn raises the whole district's land value. People pay good coin just to stroll through here.",
        then: [
          { label: 'Ask about bloom points', say: "Plant, water, prune, repeat. It's slow work, but nothing brings people joy like a garden in full color." },
          { label: 'Offer seeds or tools', say: "For me? You're a friend of the flowers now. Here — take some rare seed stock in return." },
        ],
      },
      { label: 'Ask about happiness', say: "Farmers feed bodies. I feed spirits. Don't let anyone tell you gardens are just decoration." },
      { label: 'Ask about the town', say: "Have you seen the hillside gardens at golden hour? That's when the whole city feels worth living in." },
      { label: 'Say goodbye', say: "Go gently. Try not to trample the borders.", end: true },
    ],
  },
  {
    role: 'Artisan',
    greeting: "Flour on my hands, dye under my nails — business is good.",
    choices: [
      {
        label: 'Ask about goods',
        say: "I turn the farmer's crop into bread, and the gardener's flowers into dye and perfume. Nothing goes to waste in my shop.",
        then: [
          { label: 'Ask about perfume', say: "Perfume's the real prize — three flowers and a vial of dye gets you two bottles of pure profit." },
          { label: 'Ask about bread', say: "Bread keeps the workers fed. Not glamorous, but steady coin." },
        ],
      },
      { label: 'Ask about supply shortages', say: "If the farms or gardens have a bad season, my shelves go empty fast. We're all connected here." },
      { label: 'Ask for a trade', say: "Bring me raw crop or flower, and I'll cut you in on the finished goods. Fair trade, always." },
      { label: 'Say goodbye', say: "Come back when you've got something worth processing.", end: true },
    ],
  },
  {
    role: 'Merchant',
    greeting: "Buying, selling, haggling — welcome to the only honest chaos in this city.",
    choices: [
      {
        label: 'Ask about the market',
        say: "Bread, perfume, raw crop, flowers — I move it all. Prices shift with the seasons, so buy low, sell high.",
        then: [
          { label: 'Ask about prices', say: "Right now, perfume's fetching a premium. Everyone wants a little luxury in their home." },
          { label: 'Ask about trade routes', say: "I deal with the town hall on tax, and with travelers passing through. Keeps the coin flowing both ways." },
        ],
      },
      { label: 'Ask about currency', say: "Coin's the lifeblood of this place. No currency, no expansion, no new buildings. Simple as that." },
      { label: 'Offer to sell goods', say: "Let's see what you've got. I'll give you a fair price — better than fair, for a friendly face." },
      { label: 'Say goodbye', say: "Pleasure doing business. Come back when your stock's full.", end: true },
    ],
  },
  {
    role: 'Caretaker',
    greeting: "The roads, the wells, the town hall roof — someone's got to keep it all standing.",
    choices: [
      {
        label: 'Ask about taxes',
        say: "A tenth of what the merchants earn goes toward keeping this city running. Fair trade for clean water and safe streets.",
        then: [
          { label: 'Ask where tax money goes', say: "Repairs, public gardens, new roads. Every bloom point nearby raises land value, which raises what we can collect." },
        ],
      },
      { label: "Ask about the city's condition", say: "We're doing well, all things considered. Happiness is up since the new garden terraces went in." },
      { label: 'Ask for civic help', say: "If you want to help the city directly, bring materials for repairs, or just keep the peace between the farmers and merchants." },
      { label: 'Say goodbye', say: "Stay safe out there. The city thanks you, even if it doesn't say so often.", end: true },
    ],
  },
  {
    role: 'Scholar',
    greeting: "Ah, a visitor. Perfect — I could use a second opinion on this crop rotation theory.",
    choices: [
      {
        label: 'Ask about research',
        say: "I study ways to improve yield, resist bad seasons, and unlock new plant varieties. Slow work, but it pays off for everyone.",
        then: [
          { label: 'Ask about new crops', say: "Give me time and resources, and I could develop a hardier winter crop. Interested in funding that?" },
        ],
      },
      { label: 'Ask about innovation points', say: "Every discovery I make gets banked as innovation points. Enough of those, and the whole city benefits." },
      { label: 'Offer resources for research', say: "Excellent. With this, I can accelerate my next breakthrough significantly." },
      { label: 'Say goodbye', say: "Go on, then. I've got theories to test.", end: true },
    ],
  },
  {
    role: 'Tourist Guide',
    greeting: "First time seeing our gardens? Trust me, words don't do them justice.",
    choices: [
      {
        label: 'Ask about tourism',
        say: "Once our bloom points cross a certain threshold, visitors start flooding in — and their coin flows straight into the city.",
        then: [
          { label: 'Ask about tours', say: "I lead groups through the hillside gardens every bloom season. Best job in the city, if you ask me." },
        ],
      },
      { label: 'Ask about visitor income', say: "Every tourist that walks through spends on food, crafts, and lodging. It's a whole secondary economy built on beauty alone." },
      { label: 'Ask for a tour', say: "Follow me — I'll show you why people travel days just to see our flowers." },
      { label: 'Say goodbye', say: "Tell your friends. We could always use more visitors.", end: true },
    ],
  },
  {
    role: 'Apprentice',
    greeting: "I'm still learning the ropes — but ask me anything, I'll try to help!",
    choices: [
      { label: 'Ask about their training', say: "I'm deciding whether to become a farmer, a gardener, or an artisan. Everyone says something different." },
      { label: 'Ask for advice on which path is best', say: "Farmers are steady, gardeners are joyful, artisans are clever. Merchants get rich, but they work hard for it." },
      { label: 'Offer encouragement', say: "Really? Thanks — that means a lot. Maybe I'll try the gardens first." },
      { label: 'Say goodbye', say: "See you around! I've got a lot to learn still.", end: true },
    ],
  },
  {
    role: 'Patron',
    greeting: "You've built quite the city here. I'm always looking for a good investment.",
    choices: [
      {
        label: 'Ask about investment',
        say: "Show me a thriving garden district or a well-run market, and I'll gladly fund your next expansion.",
        then: [
          { label: 'Pitch a project', say: "Interesting. Bring me a proposal with real numbers, and we'll talk terms." },
        ],
      },
      { label: 'Ask about their wealth', say: "Currency finds its way to those who use it wisely. I simply choose where it flows next." },
      { label: 'Ask for a loan or grant', say: "For the right project, certainly. Don't disappoint me." },
      { label: 'Say goodbye', say: "Until our paths cross again. Do keep this city beautiful.", end: true },
    ],
  },
  {
    role: 'Entertainer',
    greeting: "Life's too short for long faces! Care for a song, a story, or a laugh?",
    choices: [
      { label: 'Ask for entertainment', say: "For you? A little tune about the founding of this very city." },
      { label: 'Ask about their role', say: "I don't grow crops or sell goods — I keep spirits high. Happy citizens work harder and stay longer." },
      { label: 'Ask about happiness mechanics', say: "Food fills the belly, beauty fills the eyes, but laughter fills the heart. All three matter." },
      { label: 'Say goodbye', say: "Go on now, smile a little. It's contagious.", end: true },
    ],
  },
];

const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
const CROPS = ['wheat', 'barley', 'maize', 'rye', 'sunflower', 'clover'];

// Deterministic flavour values for the {{variables}}, seeded per citizen so a
// given person always says the same thing.
export function makeContext(seed) {
  const s = (seed >>> 0) || 1;
  const cropA = s % CROPS.length;
  let cropB = (s >>> 3) % CROPS.length;
  if (cropB === cropA) cropB = (cropB + 1) % CROPS.length;
  return {
    season: SEASONS[(s >>> 5) % SEASONS.length],
    cropCount: 3 + (s % 6),
    crop: CROPS[cropA],
    lowCrop: CROPS[cropB],
    water: 5 + ((s >>> 2) % 11),
  };
}

export function fillVars(text, ctx) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (_, k) => (ctx && ctx[k] != null ? ctx[k] : '…'));
}

export function roleForIndex(i) {
  return CITY_ROLES[((i % CITY_ROLES.length) + CITY_ROLES.length) % CITY_ROLES.length];
}
