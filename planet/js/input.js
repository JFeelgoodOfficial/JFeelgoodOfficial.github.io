// Keyboard + mouse + pointer lock, trimmed from the game's input.js to just
// the on-foot controls: WASD move, Shift run, Space jump, E interact, mouse
// look. Pointer lock is driven by main.js (locks on ENTER / canvas click).

export const input = {
  forward: false, reverse: false, left: false, right: false,
  boost: false, // Shift = run
  jump: false, // Space
  interact: false, // E — edge-consumed by the interaction loop
  mouseX: 0, mouseY: 0, // accumulated delta since last consumed
  locked: false, // pointer lock (desktop)
  touch: false, // on-screen controls are live (touch.js) — iOS has no pointer lock
  // A thumbstick has a magnitude a key doesn't. While `analog` is set, walk.js
  // steers from moveX/moveY instead of the booleans; the booleans are still
  // mirrored so gallery.js and vehicles.js need no idea this exists.
  analog: false,
  moveX: 0, moveY: 0, // -1..1, strafe / forward
};

// "Is someone actually driving?" Pointer lock on desktop, on-screen controls on
// touch. The frame loop gates stepWalk/stepVehicle on this.
export function isActive() { return input.locked || input.touch; }

let interactPressed = false;

const KEY = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'reverse', ArrowDown: 'reverse',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};

export function initInput(canvas, onInteract, onEscape) {
  addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (KEY[e.code]) { input[KEY[e.code]] = true; e.preventDefault(); }
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

  addEventListener('mousemove', (e) => {
    if (!input.locked) return;
    input.mouseX += e.movementX || 0;
    input.mouseY += e.movementY || 0;
  });

  document.addEventListener('pointerlockchange', () => {
    input.locked = document.pointerLockElement === canvas;
    if (!input.locked) {
      // dropping lock clears held keys so nothing sticks
      input.forward = input.reverse = input.left = input.right = false;
      input.boost = input.jump = false;
      if (onEscape) onEscape();
    }
  });
}

// One guard covers every call site (main.js on ENTER and on canvas click,
// hud.js's relock after closing an overlay): on touch there is no pointer lock
// to take, and asking for one on iOS throws.
export function lockPointer(canvas) {
  if (input.touch) return;
  if (document.pointerLockElement !== canvas) {
    try { canvas.requestPointerLock(); } catch (e) { /* rejected without a gesture */ }
  }
}
