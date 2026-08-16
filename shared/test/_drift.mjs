// Is the SIMULATION symmetric? Drive one player in each of the four directions
// for the same time on every map and compare the distance covered.
import {
  createWorld, addPlayer, stepWorld, beginMatch, TICK_DT, MAPS, PLAYER, MODE_LIST, MODES,
} from '../src/index.js';

const dirs = { right: [1, 0], left: [-1, 0], fwd: [0, 1], back: [0, -1] };

function run(mode, mapId) {
  const out = {};
  for (const [name, [mx, mz]] of Object.entries(dirs)) {
    const w = createWorld({ mode, seed: 5, modifier: 'none' });
    const p = addPlayer(w, { id: 'a', name: 'A', seat: 0 });
    beginMatch(w, mapId);
    for (let t = 0; t < 2 / TICK_DT; t++) stepWorld(w, TICK_DT); // burn off warmup
    p.x = 0; p.z = 0; p.kx = 0; p.kz = 0;
    for (let t = 0; t < 1 / TICK_DT; t++) {
      p.hp = PLAYER.maxHp;
      p.input = { mx, mz, ax: 0, az: 0, shoot: false, seq: 0 };
      stepWorld(w, TICK_DT);
    }
    out[name] = Math.hypot(p.x, p.z);
  }
  return out;
}

console.log('--- one second of travel from the centre, per map ---');
for (const mapId of Object.keys(MAPS)) {
  const d = run('casual', mapId);
  const vals = Object.values(d);
  const spread = Math.max(...vals) - Math.min(...vals);
  console.log(
    `${mapId.padEnd(9)} size=${String(MAPS[mapId].size).padEnd(3)}`,
    Object.entries(d).map(([k, v]) => `${k} ${v.toFixed(3)}`).join('  '),
    `| spread ${spread.toFixed(4)}`,
  );
}

console.log('\n--- same, per mode on the default map ---');
for (const mode of MODE_LIST) {
  const d = run(mode, 'coop');
  const vals = Object.values(d);
  console.log(
    `${mode.padEnd(11)} arena=${String(MODES[mode].arena).padEnd(3)}`,
    Object.entries(d).map(([k, v]) => `${k} ${v.toFixed(3)}`).join('  '),
    `| spread ${(Math.max(...vals) - Math.min(...vals)).toFixed(4)}`,
  );
}
