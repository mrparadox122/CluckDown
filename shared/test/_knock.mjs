import {
  createWorld, addPlayer, stepWorld, beginMatch, damagePlayer,
  TICK_DT, PLAYER, BULLET, MODIFIERS, modValue,
} from '../src/index.js';

// Can you walk INTO the shots, or does knockback own you?
for (const mod of ['none', 'lowGravity']) {
  const kb = BULLET.knockback * modValue(mod, 'knockbackMul');
  const decay = PLAYER.knockbackDecay * modValue(mod, 'knockbackDecayMul');
  console.log(`\n--- ${mod} --- impulse ${kb.toFixed(1)} u/s vs top speed ${PLAYER.speed} | decay ${decay.toFixed(2)}/s`);

  const w = createWorld({ mode: 'casual', seed: 3, modifier: mod });
  const p = addPlayer(w, { id: 'a', name: 'A', seat: 0 });
  addPlayer(w, { id: 'b', name: 'B', seat: 1 });
  beginMatch(w, 'coop');
  for (let t = 0; t < 2 / TICK_DT; t++) stepWorld(w, TICK_DT);

  p.x = 0; p.z = 0; p.kx = 0; p.kz = 0;
  p.invulnUntil = 0;
  // Three hits from the right, as a burst would land.
  for (let i = 0; i < 3; i++) { p.kx -= kb; p.hp = PLAYER.maxHp; }
  const kx0 = p.kx;

  let worst = 0;
  for (let t = 0; t < 1.5 / TICK_DT; t++) {
    const before = p.x;
    p.hp = PLAYER.maxHp;
    p.input = { mx: 1, mz: 0, ax: 0, az: 0, shoot: false, seq: 0 }; // running RIGHT, full tilt
    stepWorld(w, TICK_DT);
    worst = Math.min(worst, (p.x - before) / TICK_DT);
  }
  console.log(`  after a 3-shot burst (kx ${kx0.toFixed(1)}), holding RIGHT for 1.5s:`);
  console.log(`  ended at x=${p.x.toFixed(2)} — worst velocity while pushing right: ${worst.toFixed(2)} u/s`);
  console.log(`  >>> ${worst < -0.05 ? 'PUSHED BACKWARDS while running forwards' : 'player keeps control'}`);
}
