// Keyboard + mouse + pointer lock: W A S D (or the up/down arrows) to move,
// left/right arrows to turn, Shift run, Space jump, E interact, mouse look.
// Pointer lock is driven by main.js (locks on STEP INSIDE / canvas click).
//
// The gallery has to be walkable without a mouse, so the keyboard alone is
// enough to drive it: the arrows turn, and a movement key pressed while the
// pointer is free puts the walker in `keyboard` mode instead of waiting for a
// lock that only a click can grant.

export const input = {
  forward: false, reverse: false, left: false, right: false,
  boost: false, // Shift = run
  jump: false, // Space
  turnLeft: false, turnRight: false, // arrow keys — look without a mouse
  interact: false, // E — edge-consumed by the interaction loop
  mouseX: 0, mouseY: 0, // accumulated delta since last consumed
  locked: false, // pointer lock (desktop)
  enabled: false, // the visitor has stepped inside (main.js) — keys mean nothing on the title screen
  keyboard: false, // walking by keys alone, no pointer lock
  touch: false, // on-screen controls are live (touch.js) — iOS has no pointer lock
  // A thumbstick has a magnitude a key doesn't. While `analog` is set,
  // walker.js steers from moveX/moveY instead of the booleans.
  analog: false,
  moveX: 0, moveY: 0, // -1..1, strafe / forward
};

// "Is someone actually driving?" Pointer lock or the keyboard on desktop,
// on-screen controls on touch. The frame loop gates stepWalker on this.
export function isActive() { return input.locked || input.touch || input.keyboard; }

let interactPressed = false;

const KEY = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'reverse', ArrowDown: 'reverse',
  KeyA: 'left', KeyD: 'right',
  ArrowLeft: 'turnLeft', ArrowRight: 'turnRight',
};

// Space and the arrows already mean something to a focused button, a link or a
// scrolling card. The walker only takes them when nothing else has a claim.
function claimedElsewhere(e) {
  if (!input.enabled) return true;
  if (document.documentElement.classList.contains('overlay-open')) return true;
  const t = e.target;
  return !!(t && t.closest && t.closest('a, button, input, textarea, select, [contenteditable]'));
}

function releaseKeys() {
  input.forward = input.reverse = input.left = input.right = false;
  input.turnLeft = input.turnRight = false;
  input.boost = input.jump = false;
}

export function initInput(canvas, onInteract, onEscape, onLockFail) {
  addEventListener('keydown', (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (claimedElsewhere(e)) return;
    if (KEY[e.code]) {
      input[KEY[e.code]] = true;
      if (!input.locked && !input.touch) input.keyboard = true;
      e.preventDefault();
    }
    else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') input.boost = true;
    else if (e.code === 'Space') { input.jump = true; e.preventDefault(); }
    else if (e.code === 'KeyE') {
      if (!interactPressed && onInteract) onInteract();
      interactPressed = true;
    }
  });
  addEventListener('keyup', (e) => {
    if (KEY[e.code]) input[KEY[e.code]] = false;
    else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') input.boost = false;
    else if (e.code === 'Space') input.jump = false;
    else if (e.code === 'KeyE') interactPressed = false;
  });
  // a key held while the window loses focus never sends its keyup
  addEventListener('blur', releaseKeys);

  addEventListener('mousemove', (e) => {
    if (!input.locked) return;
    input.mouseX += e.movementX || 0;
    input.mouseY += e.movementY || 0;
  });

  document.addEventListener('pointerlockchange', () => {
    input.locked = document.pointerLockElement === canvas;
    if (input.locked) input.keyboard = false;
    else {
      // dropping lock clears held keys so nothing sticks
      releaseKeys();
      input.keyboard = false;
      if (onEscape) onEscape();
    }
  });
  // The browser refuses a lock it was not asked for by a click or a key press —
  // Esc, which closes a card, is deliberately not one. Carry on by keyboard and
  // let the caller say how to get the mouse back.
  document.addEventListener('pointerlockerror', () => {
    if (input.enabled && !document.documentElement.classList.contains('overlay-open')) input.keyboard = true;
    if (onLockFail) onLockFail();
  });
}

// One guard covers every call site (main.js on ENTER and on canvas click,
// hud.js's relock after closing an overlay): on touch there is no pointer lock
// to take, and asking for one on iOS throws.
export function lockPointer(canvas) {
  if (input.touch) return;
  if (document.pointerLockElement !== canvas) {
    try {
      // newer browsers return a promise and reject it; older ones throw or
      // fire pointerlockerror, which initInput() listens for
      const r = canvas.requestPointerLock();
      if (r && r.catch) r.catch(() => {});
    } catch (e) { /* rejected without a gesture */ }
  }
}
