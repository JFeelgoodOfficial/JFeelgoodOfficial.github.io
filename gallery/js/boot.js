// Title screen. This is the only module the page loads up front, and it
// deliberately imports nothing: three.js and the nineteen gallery modules are
// about 230 KB over the wire, and a visitor who came to read, or who takes the
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
    for (const href of ['../vendor/three.module.min.js', './main.js']) {
      const l = document.createElement('link');
      l.rel = 'modulepreload';
      l.href = new URL(href, import.meta.url).href;
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
      .catch((e) => {
        console.error('gallery failed to load', e);
        if (statusEl) statusEl.textContent = 'something went wrong — the classic site has everything';
      });
    return loading;
  }

  if (enterWorldBtn) {
    enterWorldBtn.addEventListener('click', enter);
    enterWorldBtn.addEventListener('pointerenter', warm, { once: true });
    enterWorldBtn.addEventListener('focus', warm, { once: true });
    enterWorldBtn.addEventListener('touchstart', warm, { once: true, passive: true });
  }
  // the headless checks and ?debug expect the world without pressing anything
  if (DEBUG) enter();
}
