// citydialogue.js — turns a crowd citizen + its colony sim into a few spoken
// lines for the shared info card (hud.showCard). What a native says is drawn
// from the living simulation the player is watching: their own generation and
// bloodline, the settlement's current age and size, and — as the colony nears
// ascension — their growing hope for the ark, or their unease in the lean
// early years. Talking to people is how the evolution becomes legible.

const OPENERS = {
  tender: 'They meet your eyes and smile.',
  wanderer: 'They pause on the road, restless as ever.',
  builder: 'They set down a load to speak, hands still dusty.',
  seeker: 'They study you a moment before speaking.',
  keeper: 'They dip their head in quiet greeting.',
  kindler: 'They grin, warm as a hearth.',
};

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function buildCitizenCard(citizen, life) {
  const sim = life.sim;
  const idx = life.crowd.citizens ? life.crowd.citizens.indexOf(citizen) : -1;
  const native = idx >= 0 && sim.natives[idx] ? sim.natives[idx] : null;

  const gen = native ? native.generation : 1;
  const personality = native ? native.personality : 'wanderer';
  const bloodline = (native && native.bloodline) || sim.dominantBloodline();
  const dev = sim.development;
  const pop = sim.population;
  const age = sim.ageName;

  const body = [];
  body.push(OPENERS[personality] || OPENERS.wanderer);

  // who they are, out of the genetics
  if (bloodline) {
    body.push(`"I am ${citizen.name}, ${ordinal(gen)} generation of the ${bloodline} line. We are ${pop} now, where once there were only a handful."`);
  } else {
    body.push(`"I am ${citizen.name}. We are ${pop} souls here, and more with each season."`);
  }

  // where the civilisation stands, out of the age progression
  if (dev >= 0.9) {
    body.push(`"You feel it too? The whole ${age} hums. The sky-yards are lit — if the maker of this world stays with us a little longer, the ark will fly, and we will carry everyone to a new sky."`);
  } else if (dev >= 0.6) {
    body.push(`"Every day the towers climb higher. From this a ${age} — who could have dreamed it? The elders speak now of ships that leave the ground."`);
  } else if (dev >= 0.3) {
    body.push(`"We were nothing but a ${age} of mud and hope. Now there are roofs, and children who will not know hunger. Stay — see what we become."`);
  } else {
    body.push(`"It is a hard, hopeful beginning. If you keep watch over us, I believe we will grow into something worth remembering."`);
  }

  const meta = bloodline
    ? `${age} · pop ${pop} · ${bloodline} bloodline, gen ${gen}`
    : `${age} · pop ${pop} · generation ${gen}`;

  return {
    kicker: `A native of the ${citizenBiomeWord(life)}`,
    title: citizen.name,
    meta,
    body,
  };
}

// The crowd's cityId is 'civ-<biome>'; surface a friendly word for the card.
function citizenBiomeWord(life) {
  const id = life.crowd && life.crowd.group ? life.crowd.group.name : '';
  const m = /crowd:civ-(\w+)/.exec(id || '');
  return m ? m[1] : 'settlement';
}
