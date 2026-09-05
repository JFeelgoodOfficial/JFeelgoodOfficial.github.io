# jfeelgood.com — working notes

Static GitHub Pages site, no build step. Three pages: `index.html` (title screen → walkable 3D gallery), `classic.html` (one section per thing being made, with big "thought" copy between sections), `archives.html` (186-work wall). Read `README` first for the page/asset map; this file is the conventions and how-tos.

## Commands

There is nothing to install for the site itself. To run it locally:

```
python3 -m http.server 8123          # then open http://localhost:8123/
```

Headless checks (Playwright + the pre-installed Chromium at `/opt/pw-browsers/…/chrome`, launched with `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist` so WebGL2 works):

- Gallery: load `index.html?debug=at:court` (or `terrace|west|east|deck`), wait for `window.__debug.ready`, call `window.__debug.frame()` a few times (rAF is throttled headless), screenshot, and read `window.__hung` — `archive` must equal `ARCHIVES.length` (186). Also try `?q=low` and `?touch&debug`.
- Gallery, brightness: at every place and every tier, the mean luminance of the top 72% of the frame (below that is the touch HUD) must clear ~110 on the lit places (terrace, west, east, court) and ~25 on the star deck, which sits under a space sky that fills half the frame — measure the band from 45% to 72% down the frame there (geometry, not sky) and expect ~75. `window.__debug.shaderErrors()` must be empty and `lighting().rung` must read `full`. A lit program that fails to link takes every `MeshStandardMaterial` with it and the building renders as nothing at all, which no other check notices: the paintings are unlit, so `__hung` still reports 186 hung works over a black screen.
- Gallery, the fallback ladder: `?lit=noenv|nopoint|lambert|basic` forces a rung; every rung must still draw a lit room (terrace ≥ 100, west ≥ 60 on the same band). `?probefail` makes every self-test reading come back black, which must walk the ladder to `basic` and still leave the wing well lit.
- Classic: full-page screenshots at 1440 and 390 wide; every nav `#anchor` must exist; every `<script type="application/ld+json">` must `JSON.parse`.

Do not commit screenshots or scratch scripts into the repo.

## Gallery conventions (`gallery/js/`)

- **Units and axes.** Metres, +y up, the building runs along +x (west → east). Zone x-ranges live in `config.js` `PLAN`; if you move a wall, move the matching range and the `PLACES` jump points.
- **One sky, driven by position.** `skyStateAt(x)` returns 0 (sunrise) … 1 (sunset) … 2 (space). The blend ranges must stay inside the *windowless* wings, well clear of both doorways, so the visitor never watches the sky change. Keep the wings windowless for the same reason (the clerestory "glow" bands are emissive strips, not openings).
- **Sky is analytic.** `SKY_GLSL` in `sky.js` is pasted into the dome and the water shaders and shares the `skyUniforms` object by reference. Change the sky in one place; never fork the function.
- **Environment maps** are PMREM'd once per preset at load (`bakeEnvironments`) and swapped by the dominant weight in `world.js` — the swap happens indoors where it can't be seen.
- **Colour fidelity of paintings is non-negotiable.** The renderer uses `NeutralToneMapping`; `art.js` applies the exact inverse curve in the painting shader and writes alpha 0 so the bloom bright pass (which multiplies by alpha) ignores them. Don't tone-map, light, or bloom the canvases, and don't switch the tone-mapping operator without updating `INV_NEUTRAL`.
- **Render targets are linear.** In r165 tone mapping and the sRGB transfer are applied only when drawing to the canvas; every RT (bloom, reflection) holds scene-linear half-float. `post.js` does tone mapping + sRGB in its composite.
- **Reflection pass.** `reflector.js` renders the scene a second time from a mirrored camera; floors are excluded from that pass and `renderer.shadowMap.autoUpdate` is off so shadows are rendered once per frame and shared. Disabled on the `low` tier.
- **The lighting is verified, not assumed.** A phone can lose the building three ways: the lit program refuses to link (three.js reports it), it links and then draws nothing (nothing reports it), or the PMREM environment comes back black and drags every PBR surface down with it. All three end in a black room with the unlit paintings floating in it. So `verifyLighting()` in `world.js` renders the inside of the west wing into a 64×36 target before the visitor is let in, reads the pixels back, and takes a rung off the lighting until the room reads: `full → noenv → nopoint → lambert → basic`. Each rung raises the ambient and hemisphere fills to pay for what it removed. Add a rung by extending `RUNGS` and `applyRung`; anything that changes how a room is lit has to keep every rung above the brightness floor, because a rung that draws dark is a rung that fails on the phone it exists for.
- **Indoors is filled, not just spotted.** The wings are windowless, and the fixture pool alone left the far end of a corridor dark on the tier that has the fewest lights. `LIT` in `world.js` holds the ambient, hemisphere and environment floors indoors and out; the ladder raises them as it removes light sources. The fixtures still shape the room, but they are no longer the only thing lighting it.
- **Lights are a shader budget, not a scene graph.** three.js unrolls `#pragma unroll_loop_start` on the JS side, so every light in the scene pastes another full GGX evaluation into every lit fragment shader; past roughly a dozen, mobile drivers stop linking the program and the whole building draws nothing. So `building.js` emits fixtures as *data* (`fixture(x, y, z, intensity, color, range)`) and `lights.js` keeps a fixed pool of real `PointLight`s aimed at the ones nearest the visitor. Add a light by adding a fixture; never add a `THREE.PointLight` to the scene. `C.LIGHT_POOL` is the cap per tier and `C.WING_LIGHT_*` the corridor spacing — the pool must be big enough to hold every fixture whose falloff still matters where the visitor can stand, or lights visibly swap in and out. Changing the pool size recompiles every lit program, so it only ever changes on the failure ladder in `degradeLighting()`.
- **Collision.** Walls register boxes through `walker.addBox`; walkable zones through `walker.addArea` and must overlap by ~1.2 m across every doorway or the player can't cross.
- **Textures stream.** Every painting registers with `textures.js` (load/keep distances per kind). Don't preload the archive.
- **Touch.** `touch.js` writes into the same `input` singleton as the keyboard; `hud.js` rewrites key glyphs in prompts for touch. Nothing else should know touch exists.
- Keep the three quality tiers (`applyQuality` in `main.js`) working: `low` must load on a phone with no bloom, shadows or reflection.
- **`?diag`** puts the GPU string, the tier, the uniform limits, the light pool and any driver shader log on screen. It is the only way to tell "dim" from "the lit shader never compiled" on a phone, where there is no console.

### Adding a painting

1. Put the optimized image in `assets/images/opt/` (featured / Self Work, 1200px WebP) or `assets/images/archives/thumbs/` + the original in `assets/images/archives/` (archive, 700px WebP thumb).
2. Add it to `gallery/js/content.js` (`FEATURED`, `SELF_WORK`, or the `ARCHIVE_NAMED` list / count). The archive hangs in list order along the walls; if `window.__hung.archive` comes back short, lower `C.SLOT_STEP` (≥ 2.9) or lengthen the wings in `PLAN`.
3. Mirror it on `classic.html` and `archives.html`, and in `llms.txt` if it's a featured or priced work.

### Adding a place or zone

Add its x-range to `PLAN`, a `PLACES` entry (used by `?debug=at:` and the compass), geometry + areas in `building.js`, and check `skyStateAt` still blends only indoors.

## Classic site conventions (`classic.html`)

- Structure is `<p class="thought">` + `<section id="…">` pairs. The thought is copy (a provocation about the coming section), not a heading; the section's small uppercase `h2` is the real heading. Don't turn thoughts into `h*` elements.
- Sections in order: hero, featured, gallery, archives-promo, selfwork, books, collect, iexploreart, prototown, driftbound, nova7, story, about. New project = one thought + one section using the shared `.project-grid` layout and an image in `assets/images/projects/` (1400px WebP, descriptive alt).
- Never touch the commerce plumbing without checking the minicuration repo: Stripe hrefs, `data-buy-slug`, `data-stock-slug`, and the stock fetch script.
- Carousel data (featured, story, selfwork) is duplicated in `classic.html` and `gallery/js/content.js`; keep the two in sync.

## SEO / AEO — keep in sync on every content change

- `llms.txt` describes the gallery, the projects, the paintings, series, books and cards. Update it whenever any of those change.
- JSON-LD `@graph` in `index.html` and `classic.html`: Person (with `sameAs` for every project site), WebSite, the product `ItemList`, the project `VideoGame`/`WebSite` nodes, `Book` ×2, and the classic page's `CollectionPage` with `hasPart` anchors. Validate with `JSON.parse`.
- Canonicals are per page (`/`, `/classic.html`, `/archives.html`). `sitemap.xml` `lastmod` gets today's date for any page you touch. `robots.txt` stays fully open, AI crawlers explicitly allowed.
- Every `<img>` has a descriptive `alt`; below-the-fold images use `loading="lazy" decoding="async"`.

## House rules

- No model or assistant names anywhere in the repository (code, comments, commits).
- Prefer editing `content.js` / `config.js` over hard-coding values in modules.
- Commit messages describe the visitor-facing change first.
