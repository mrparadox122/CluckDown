// Kills per minute, before and after four-a-side. A MEASUREMENT, not a test.
//
// It is here rather than in test:sim because it asserts nothing: there is no
// correct kills-per-minute, only a number you should know before you change
// the map sizes again. It exits 0 whatever it finds.
//
// The question it answers is the one that decides how big a 4v4 map should be.
// Doubling the roster halves the space per player, which is the density this
// game was short of — so scaling the maps by the player-count ratio would hand
// the whole gain straight back. The middle row of each block separates the two
// changes: the roster on its own, then the roster with the map growth on top.
//
// Bots roll global Math.random, so one match is chance rather than evidence.
// Every row is the mean of N matches.
//
//   node shared/test/density.mjs [runs]

import {
  createWorld, addPlayer, stepWorld, stepBots, initBot, beginMatch,
  MAPS, TICK_DT,
} from '../src/index.js';

const RUNS = Number(process.argv[2] ?? 10);
const SECONDS = 180;

/**
 * One bot match at an arbitrary roster size and arena size.
 *
 * The arena is set by scaling the map, which is exactly what a mode does with
 * `arenaScale` — so "the old 48-unit Coop" is reproducible from the current
 * constants rather than needing the old ones checked out.
 */
function play({ players, teams, mapId, size, seed }) {
  const world = createWorld({ mode: 'casual', seed, modifier: 'none' });
  world.cfg = { ...world.cfg, teams, arenaScale: size / MAPS[mapId].size };
  world.teamScores = teams ? [0, 0] : null;

  for (let seat = 0; seat < players; seat++) {
    const p = addPlayer(world, { id: `p${seat}`, name: `P${seat}`, seat, isBot: true });
    initBot(p, 'normal');
  }
  beginMatch(world, mapId);

  let kills = 0;
  let live = 0;
  for (let t = 0; t < (SECONDS + 20) / TICK_DT && world.phase !== 'over'; t++) {
    stepBots(world, TICK_DT);
    for (const e of stepWorld(world, TICK_DT)) if (e.type === 'kill') kills++;
    if (world.phase === 'live') live += TICK_DT;
    if (live >= SECONDS) break;
  }
  return { kills, minutes: live / 60 };
}

function row(label, cfg) {
  let kills = 0;
  let minutes = 0;
  for (let i = 0; i < RUNS; i++) {
    const r = play({ ...cfg, seed: 1000 + i * 37 });
    kills += r.kills;
    minutes += r.minutes;
  }
  const kpm = kills / minutes;
  const area = (cfg.size * cfg.size) / cfg.players;
  console.log(
    `${label.padEnd(32)} ${String(cfg.players).padStart(2)}p ${String(cfg.size).padStart(3)}u  `
    + `${area.toFixed(0).padStart(4)} u2/player   ${kpm.toFixed(1).padStart(5)} kills/min   `
    + `${(kpm / cfg.players).toFixed(2)} per player`,
  );
}

console.log(`\n${RUNS} matches of ${SECONDS}s each, per row.\n`);

console.log('--- The Coop ---');
row('BEFORE  4p FFA', { players: 4, teams: false, mapId: 'coop', size: 48 });
row('roster only  8p 4v4, old size', { players: 8, teams: true, mapId: 'coop', size: 48 });
row('AFTER   8p 4v4', { players: 8, teams: true, mapId: 'coop', size: 54 });

console.log('\n--- The Big Yard ---');
row('BEFORE  4p FFA', { players: 4, teams: false, mapId: 'yard', size: 64 });
row('roster only  8p 4v4, old size', { players: 8, teams: true, mapId: 'yard', size: 64 });
row('AFTER   8p 4v4', { players: 8, teams: true, mapId: 'yard', size: 72 });

console.log('\n--- Tight Squeeze ---');
row('BEFORE  4p FFA', { players: 4, teams: false, mapId: 'squeeze', size: 34 });
row('AFTER   8p 4v4', { players: 8, teams: true, mapId: 'squeeze', size: 38 });

console.log('');
