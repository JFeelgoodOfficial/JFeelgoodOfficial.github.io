// Keyboard + mouse + pointer lock, trimmed from the game's input.js to just
// the on-foot controls: WASD move, Shift run, Space jump, E interact, mouse
// look. Pointer lock is driven by main.js (locks on ENTER / canvas click).

export const input = {
  forward: false, reverse: false, left: false, right: false,
  boost: false, // Shift = run
  jump: false, // Space
  interact: false, // E — edge-consumed by the interaction loop
  mouseX: 0, mouseY: 0, // accumulated delta since last consumed
  locked: false,
};

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

export function lockPointer(canvas) {
  if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
}
