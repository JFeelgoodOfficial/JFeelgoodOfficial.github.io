// Title screen. This is the only module the page loads up front, and it
// deliberately imports nothing: three.js and the nineteen gallery modules are
// about 240 KB gzipped (200 KB brotli), and a visitor who came to read, or who takes the
// CLASSIC SITE door, should never pay for a renderer they will not use. So the
// world is a dynamic import, fetched when the visitor reaches for the handle.
//
// main.js still owns everything after that — renderer, loader stages, quality
// tiers, window.__debug.

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

const enterWorldBtn = document.getElementById('enter-world');
const loaderEl = document.getElementById('loader');
const statusEl = document.getElementById('loader-status');
const failEl = document.getElementById('loader-fail');

// Everything the world imports, so one hover fetches the lot side by side. The
// import graph is five modules deep; left to itself the browser discovers it a
// round trip at a time.
const MODULES = [
  '../vendor/three.module.min.js',
  'main', 'config', 'content', 'world', 'sky', 'water', 'materials', 'building',
  'lights', 'art', 'textures', 'reflector', 'walker', 'interact', 'hud', 'input',
  'touch', 'post', 'welcome',
];

// The loading stage hides both doors, so a failure has to bring its own way
// out: a link to the classic site and a reload.
function fail(e) {
  console.error('gallery failed to load', e);
  if (statusEl) statusEl.textContent = 'the gallery could not open on this device';
  const fill = document.getElementById('loader-fill');
  if (fill) fill.parentElement.style.visibility = 'hidden';
  const enterBtn = document.getElementById('enter-btn');
  if (enterBtn) enterBtn.hidden = true;
  if (loaderEl) { loaderEl.style.display = ''; loaderEl.classList.remove('fading'); loaderEl.classList.add('stage-failed'); }
  if (failEl) {
    failEl.hidden = false;
    const a = failEl.querySelector('a');
    if (a) a.focus({ preventScroll: true });
  }
}

// No WebGL2, no gallery: say so here rather than after downloading a renderer
// that cannot start.
if (document.documentElement.classList.contains('no-webgl')) {
  const el = document.getElementById('nogl');
  if (el) el.hidden = false;
  if (loaderEl) loaderEl.style.display = 'none';
} else {
  let warmed = false;
  let loading = null;

  // Hovering the button (or tabbing to it) is a good enough signal to start
  // pulling the world down, so the click has nothing left to wait for.
  function warm() {
    if (warmed) return;
    warmed = true;
    for (const m of MODULES) {
      const l = document.createElement('link');
      l.rel = 'modulepreload';
      l.href = new URL(m.endsWith('.js') ? m : `./${m}.js`, import.meta.url).href;
      document.head.appendChild(l);
    }
  }

  function enter() {
    if (loading) return loading;
    warm();
    // flip to the progress bar immediately — the module itself is the first
    // thing being loaded, and main.js takes the bar over when it arrives
    if (loaderEl) { loaderEl.classList.remove('stage-choice'); loaderEl.classList.add('stage-loading'); }
    loading = import('./main.js')
      .then((m) => m.startLoad())
      .catch(fail);
    return loading;
  }

  const retry = document.getElementById('loader-retry');
  if (retry) retry.addEventListener('click', () => location.reload());

  if (enterWorldBtn) {
    enterWorldBtn.addEventListener('click', enter);
    enterWorldBtn.addEventListener('pointerenter', warm, { once: true });
    enterWorldBtn.addEventListener('focus', warm, { once: true });
    enterWorldBtn.addEventListener('touchstart', warm, { once: true, passive: true });
  }
  // the headless checks and ?debug expect the world without pressing anything
  if (DEBUG) enter();
}
