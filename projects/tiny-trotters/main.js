// ============================================
// Tiny Trotters - First Technical Prototype
// ============================================
// Core simulation only: terrain, creatures,
// gravity, walking, falling, wall collision,
// death by fall, and exit detection.
// ============================================

// --- World Constants ---
const LOGICAL_W = 320;            // internal resolution width
const LOGICAL_H = 180;            // internal resolution height
const SCALE = 3;                  // visual scale factor (320 -> 960)

const GRAVITY = 400;              // pixels per second^2
const MAX_FALL_SPEED = 300;       // terminal fall velocity
const MAX_FALL_DISTANCE = 80;     // fall farther than this and the creature dies
const CREATURE_SIZE = 6;          // each creature is a 6x6 square
const CREATURE_SPEED = 20;        // pixels per second

const SPAWN_X = 45;
const SPAWN_Y_BASE = 40;          // base spawn height; first creature is here (dies from fall)
const SPAWN_Y_STEP = 15;          // each next creature spawns lower (survives)

// --- Canvas ---
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false; // keep pixel art crisp

// --- UI Elements ---
const aliveEl = document.getElementById('alive-count');
const savedEl = document.getElementById('saved-count');
const deadEl  = document.getElementById('dead-count');

// --- World State ---
let terrain = [];                  // 2D array: 0 = empty, 1 = solid
let exitZone = { x: 0, y: 0, w: 0, h: 0 };
let creatures = [];
let lastTime = 0;


// ============================================
// Terrain
// ============================================

function createTerrain() {
  // Start with an empty grid.
  terrain = [];
  for (let y = 0; y < LOGICAL_H; y++) {
    terrain.push(new Array(LOGICAL_W).fill(0));
  }

  // Main floor across the bottom with a narrow gap that creatures can cross.
  fillRect(0, 170, 145, 10);       // left half of floor (0..145)
  fillRect(150, 170, 170, 10);     // right half of floor (150..320), 5px gap at 145-150

  // Floating platform with a gap. Creatures spawn above this and walk across it.
  fillRect(40, 130, 15, 4);        // left part of platform (40..55)
  fillRect(60, 130, 30, 4);        // right part of platform (60..90), 5px gap at 55-60

  // Small wall on the right platform. Creatures walk into it after crossing the gap,
  // turn around, fall off the left side of the platform, then walk back to the exit.
  fillRect(75, 115, 5, 15);        // wall at x=75..80, y=115..130

  // Small wall on the far left of the floor. After turning around at the platform
  // wall, creatures walk left across the floor and hit this wall before falling off.
  fillRect(5, 150, 10, 20);        // wall at x=5..15, y=150..170

  // Decorative slope + peak on the far right (after the exit zone).
  // Creatures are saved before reaching it, so it is purely visual for now.
  fillSlope(310, 170, 316, 160);
  fillRect(316, 160, 4, 20);

  // Exit zone on the right side of the level.
  exitZone = { x: 280, y: 140, w: 30, h: 40 };
}

function fillRect(x, y, w, h) {
  // Fill a rectangular region of the terrain mask with solid pixels.
  for (let py = y; py < y + h && py < LOGICAL_H; py++) {
    for (let px = x; px < x + w && px < LOGICAL_W; px++) {
      if (px >= 0 && py >= 0) {
        terrain[py][px] = 1;
      }
    }
  }
}

function fillSlope(x1, y1, x2, y2) {
  // Draw a diagonal slope from (x1, y1) to (x2, y2).
  // For each x along the slope, fill a column from the slope's top down to the bottom.
  const length = Math.abs(x2 - x1);
  const step = x2 > x1 ? 1 : -1;
  for (let dx = 0; dx <= length; dx++) {
    const x = x1 + dx * step;
    const t = dx / length;
    const topY = Math.round(y1 + (y2 - y1) * t);
    fillRect(x, topY, 1, LOGICAL_H - topY);
  }
}

function isSolid(x, y) {
  // Out-of-bounds pixels count as empty so creatures can fall off the world.
  if (x < 0 || x >= LOGICAL_W || y < 0 || y >= LOGICAL_H) {
    return false;
  }
  return terrain[y][x] === 1;
}

function setSolid(x, y, value) {
  // Helper for future editor / skill systems.
  if (x < 0 || x >= LOGICAL_W || y < 0 || y >= LOGICAL_H) return;
  terrain[y][x] = value ? 1 : 0;
}

function drawTerrain() {
  // Draw solid terrain pixels.
  for (let y = 0; y < LOGICAL_H; y++) {
    for (let x = 0; x < LOGICAL_W; x++) {
      if (terrain[y][x] === 1) {
        ctx.fillStyle = '#7a4a2a'; // earthy brown
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  // Subtle lighter top edge for a tiny bit of visual depth.
  for (let x = 0; x < LOGICAL_W; x++) {
    if (isSolid(x, 170) && !isSolid(x, 169)) {
      ctx.fillStyle = '#9c6b3c';
      ctx.fillRect(x, 169, 1, 1);
    }
  }

  // Exit zone - green rectangle on the right.
  ctx.fillStyle = '#2ecc71';
  for (let y = exitZone.y; y < exitZone.y + exitZone.h; y++) {
    for (let x = exitZone.x; x < exitZone.x + exitZone.w; x++) {
      ctx.fillRect(x, y, 1, 1);
    }
  }
}


// ============================================
// Creatures
// ============================================

function createCreatures() {
  creatures = [];
  for (let i = 0; i < 5; i++) {
    creatures.push({
      x: SPAWN_X + i * 2,             // space them out across the spawn platform
      y: SPAWN_Y_BASE + i * SPAWN_Y_STEP, // varying heights so one dies on landing
      vx: CREATURE_SPEED,             // initial horizontal velocity (walking right)
      vy: 0,
      direction: 1,                   // 1 = right, -1 = left
      state: 'walking',               // 'walking' | 'falling' | 'dead' | 'saved'
      alive: true,
      saved: false,
      fallDistance: 0,
      grounded: false
    });
  }
}

function updateCreature(c, dt) {
  // Inactive creatures do nothing.
  if (!c.alive || c.saved) return;

  // --- Gravity ---
  c.vy += GRAVITY * dt;
  if (c.vy > MAX_FALL_SPEED) c.vy = MAX_FALL_SPEED;

  // --- Vertical movement with ground collision ---
  const newY = c.y + c.vy * dt;
  const feetLeftX  = Math.floor(c.x);
  const feetRightX = Math.floor(c.x + CREATURE_SIZE - 1);
  // feetY is the pixel just BELOW the creature's bottom edge, where we look for ground.
  const feetY      = Math.floor(newY + CREATURE_SIZE);

  if (isSolid(feetLeftX, feetY) || isSolid(feetRightX, feetY)) {
    // Feet hit solid ground: snap to sit on top of the surface and stop falling.
    // Use whichever foot is on solid ground to find the terrain surface.
    const solidFootX = isSolid(feetLeftX, feetY) ? feetLeftX : feetRightX;
    // Walk up the solid column to find the top.
    let groundY = feetY;
    while (groundY > 0 && isSolid(solidFootX, groundY)) {
      groundY--;
    }
    // groundY is now the empty pixel just above the solid column.
    // Place the creature so its bottom edge sits one pixel above the solid.
    c.y = groundY + 1 - CREATURE_SIZE;
    c.vy = 0;
    c.grounded = true;

    // A fall that ended here - check whether it was fatal.
    if (c.state === 'falling' && c.fallDistance > MAX_FALL_DISTANCE) {
      killCreature(c);
      return;
    }

    // Otherwise, reset and resume walking.
    c.fallDistance = 0;
    c.state = 'walking';
  } else {
    // Nothing under feet: keep falling.
    c.y = newY;
    if (c.state === 'walking') {
      c.state = 'falling';
      c.fallDistance = 0;
    } else if (c.state === 'falling') {
      c.fallDistance += c.vy * dt;
    }
    c.grounded = false;
  }

  // Fell off the bottom of the world: dead.
  if (c.y > LOGICAL_H) {
    killCreature(c);
    return;
  }

  // --- Horizontal movement (only when grounded) ---
  if (c.grounded && c.state === 'walking') {
    const newX = c.x + c.vx * dt;

    // Probe a pixel ahead at body height to detect a wall.
    const probeTopY    = Math.floor(c.y + 1);
    const probeBottomY = Math.floor(c.y + CREATURE_SIZE - 2);
    const probeX = c.direction === 1
      ? Math.floor(newX + CREATURE_SIZE)   // just past the right edge
      : Math.floor(newX - 1);              // just past the left edge

    if (isSolid(probeX, probeTopY) || isSolid(probeX, probeBottomY)) {
      // Wall in front: turn around, do not advance this frame.
      c.direction *= -1;
      c.vx = CREATURE_SPEED * c.direction;
    } else {
      c.x = newX;
    }
  }

  // --- Exit detection ---
  if (isInExit(c)) {
    saveCreature(c);
  }
}

function isInExit(c) {
  return (
    c.x + CREATURE_SIZE > exitZone.x &&
    c.x               < exitZone.x + exitZone.w &&
    c.y + CREATURE_SIZE > exitZone.y &&
    c.y               < exitZone.y + exitZone.h
  );
}

function killCreature(c) {
  c.alive = false;
  c.state = 'dead';
  c.vx = 0;
  c.vy = 0;
}

function saveCreature(c) {
  c.saved = true;
  c.alive = false;
  c.state = 'saved';
  c.vx = 0;
  c.vy = 0;
}

function drawCreature(c) {
  // Saved creatures vanish from view.
  if (c.saved) return;

  const cx = Math.floor(c.x);
  const cy = Math.floor(c.y);

  if (c.state === 'dead') {
    // Draw as a dim red square.
    ctx.fillStyle = '#8b2a1f';
    ctx.fillRect(cx, cy, CREATURE_SIZE, CREATURE_SIZE);
    return;
  }

  // Color depends on whether the creature is walking or falling.
  if (c.state === 'falling') {
    ctx.fillStyle = '#f39c12'; // orange while falling
  } else {
    ctx.fillStyle = '#f0e36a'; // yellow while walking
  }
  ctx.fillRect(cx, cy, CREATURE_SIZE, CREATURE_SIZE);

  // A single dark pixel as an eye, facing the direction of motion.
  ctx.fillStyle = '#222';
  const eyeX = c.direction === 1 ? cx + CREATURE_SIZE - 2 : cx + 1;
  ctx.fillRect(eyeX, cy + 1, 1, 1);
}


// ============================================
// Game Loop
// ============================================

function update(dt) {
  for (const c of creatures) {
    updateCreature(c, dt);
  }
}

function draw() {
  // Sky background.
  ctx.fillStyle = '#0d1b2a';
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  drawTerrain();

  for (const c of creatures) {
    drawCreature(c);
  }
}

function updateHUD() {
  let alive = 0, saved = 0, dead = 0;
  for (const c of creatures) {
    if (c.saved) saved++;
    else if (!c.alive) dead++;
    else alive++;
  }
  aliveEl.textContent = alive;
  savedEl.textContent = saved;
  deadEl.textContent  = dead;
}

function loop(now) {
  // Cap dt so a paused tab doesn't teleport creatures through walls.
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  update(dt);
  draw();
  updateHUD();

  requestAnimationFrame(loop);
}

function init() {
  createTerrain();
  createCreatures();
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

// Kick off the game.
init();
