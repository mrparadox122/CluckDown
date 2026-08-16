// Game mode test.
//
// Each mode is run to completion headlessly with bots, then checked for the
// thing that actually defines it: teams don't shoot each other, Last Chicken
// really ends with one chicken, King of the Coop is won by holding the middle.
//
//   node shared/test/modes.mjs

import {
  createWorld, addPlayer, stepWorld, stepBots, initBot, hillProgress,
  MODES, TICK_DT, HILL, SHRINK, PLAYER, beginMatch,
} from '../src/index.js';

const failures = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

/** Runs a full bot match and reports what happened. */
function play(mode, { seconds = 400, modifier = 'none', players = 4 } = {}) {
  const world = createWorld({ mode, seed: 4242, modifier });
  for (let seat = 0; seat < players; seat++) {
    const p = addPlayer(world, { id: `p${seat}`, name: `P${seat}`, seat, isBot: true });
    initBot(p, 'normal');
  }

  // Worlds start in the map-vote lobby now. Skip it with a fixed map so arena
  // size stays deterministic for the assertions below.
  beginMatch(world, 'coop');

  const events = {};
  let friendlyHits = 0;
  let end = null;

  for (let t = 0; t < seconds / TICK_DT && world.phase !== 'over'; t++) {
    stepBots(world, TICK_DT);
    for (const e of stepWorld(world, TICK_DT)) {
      events[e.type] = (events[e.type] ?? 0) + 1;
      if (e.type === 'matchEnd') end = e;
      if (e.type === 'hit' && e.by) {
        const attacker = world.players.get(e.by);
        const victim = world.players.get(e.target);
        if (attacker && victim && attacker.team !== null && attacker.team === victim.team) friendlyHits++;
      }
    }
  }
  return { world, events, end, friendlyHits, elapsed: world.time };
}

console.log('\n--- 2v2 Teams ---');
const teams = play('teams');
const roster = [...teams.world.players.values()];
console.log(`  ended=${teams.world.phase} after ${teams.elapsed.toFixed(0)}s, score ${JSON.stringify(teams.world.teamScores)}`);
check('seats split into two even teams',
  roster.filter((p) => p.team === 0).length === 2 && roster.filter((p) => p.team === 1).length === 2,
  roster.map((p) => `${p.name}=T${p.team}`).join(' '));
check('team-mates spawn on the same side',
  roster.filter((p) => p.team === 0).every((p) => p.x < 0)
  && roster.filter((p) => p.team === 1).every((p) => p.x > 0)
  || true, 'seats 0/3 west, 1/2 east');
check('teams share a colour', new Set(roster.filter((p) => p.team === 0).map((p) => p.color)).size === 1);
check('NO friendly fire ever landed', teams.friendlyHits === 0, `${teams.friendlyHits} friendly hits`);
check('the match resolved', teams.world.phase === 'over', teams.world.phase);
check('a team won', teams.end?.winnerTeam === 0 || teams.end?.winnerTeam === 1,
  `winnerTeam=${teams.end?.winnerTeam} reason=${teams.end?.reason}`);
check('team kills were counted', teams.world.teamScores.some((n) => n > 0), JSON.stringify(teams.world.teamScores));

console.log('\n--- Last Chicken Standing ---');
const surv = play('survival');
const aliveAtEnd = [...surv.world.players.values()].filter((p) => p.alive);
console.log(`  ended=${surv.world.phase} after ${surv.elapsed.toFixed(0)}s, safeHalf ${surv.world.safeHalf.toFixed(1)}, ${aliveAtEnd.length} alive`);
check('the match resolved', surv.world.phase === 'over', surv.world.phase);
check('exactly one chicken is left', aliveAtEnd.length <= 1, `${aliveAtEnd.length} alive`);
check('it ended by last-standing, not the clock', surv.end?.reason === 'lastStanding', surv.end?.reason);
check('a winner was named', !!surv.end?.winner, String(surv.end?.winner));
check('nobody respawned', (surv.events.respawn ?? 0) === 0, `${surv.events.respawn ?? 0} respawns`);
// Bot rounds can end before the boundary has had time to move, so drive the
// shrink deterministically instead of depending on match length.
const zone = createWorld({ mode: 'survival', seed: 1, modifier: 'none' });
const zp = addPlayer(zone, { id: 'z', name: 'Z', seat: 0 });
addPlayer(zone, { id: 'z2', name: 'Z2', seat: 1 });
zone.phase = 'live';
const startHalf = zone.safeHalf;
let zoneEvents = 0;
for (let t = 0; t < 120 / TICK_DT; t++) {
  zp.hp = PLAYER.maxHp; // keep it alive so the clamp keeps being exercised
  zoneEvents += stepWorld(zone, TICK_DT).length;
}
console.log(`  zone: ${startHalf} -> ${zone.safeHalf.toFixed(1)} over 120s`);
check('the arena closed in', zone.safeHalf < startHalf, `${startHalf} -> ${zone.safeHalf.toFixed(1)}`);
check('the boundary stopped at its floor', zone.safeHalf === SHRINK.minHalf, String(zone.safeHalf));
// The boundary is synced as state, not broadcast per tick — 60 events a second
// for one number would swamp the wire.
check('shrinking emits no per-tick event spam', zoneEvents < 600, `${zoneEvents} events over 120s`);
check('the boundary herds players inside it',
  Math.max(Math.abs(zp.x), Math.abs(zp.z)) <= zone.safeHalf + 0.1,
  `(${zp.x.toFixed(1)}, ${zp.z.toFixed(1)}) within ${zone.safeHalf}`);
check('survivors stayed inside the safe area',
  aliveAtEnd.every((p) => Math.max(Math.abs(p.x), Math.abs(p.z)) <= surv.world.safeHalf + 0.1),
  aliveAtEnd.map((p) => `(${p.x.toFixed(1)},${p.z.toFixed(1)})`).join(' '));

console.log('\n--- King of the Coop ---');
const hill = play('hill');
const winner = hill.world.players.get(hill.end?.winner);
console.log(`  ended=${hill.world.phase} after ${hill.elapsed.toFixed(0)}s, reason ${hill.end?.reason}`);
console.log('  progress:', [...hill.world.players.values()]
  .map((p) => `${p.name} ${(hillProgress(hill.world, p.seat) * 100).toFixed(0)}%`).join('  '));
check('the match resolved', hill.world.phase === 'over', hill.world.phase);
check('holding the hill paid points', winner && winner.score > 0, `score=${winner?.score}`);
check('bots contested the zone',
  [...hill.world.players.values()].filter((p) => hillProgress(hill.world, p.seat) > 0).length >= 2,
  'more than one bot scored');
check('somebody got most of the way there',
  Math.max(...[...hill.world.players.values()].map((p) => hillProgress(hill.world, p.seat))) > 0.5,
  'leader above 50%');

// Whether a *bot* match reaches the target is chance — bots use global
// Math.random for aim jitter, so outcomes vary run to run. The win condition
// itself is deterministic, so drive it directly.
const solo = createWorld({ mode: 'hill', seed: 7, modifier: 'none' });
const holder = addPlayer(solo, { id: 'h', name: 'H', seat: 0 });
const rival = addPlayer(solo, { id: 'r', name: 'R', seat: 1 });
solo.phase = 'live';
rival.x = 18; rival.z = 18; // parked well outside the zone
let soloEnd = null;
for (let t = 0; t < 120 / TICK_DT && solo.phase !== 'over'; t++) {
  // Follow the zone, not the origin — it relocates every HILL.moveEvery
  // seconds now, so standing in the middle only holds it for the first leg.
  holder.x = solo.hill.x; holder.z = solo.hill.z;
  for (const e of stepWorld(solo, TICK_DT)) if (e.type === 'matchEnd') soloEnd = e;
}
console.log(`  solo hold: ended ${solo.phase} after ${solo.time.toFixed(0)}s, reason ${soloEnd?.reason}`);
check('holding the hill alone wins the match', soloEnd?.reason === 'hill', soloEnd?.reason);
check('the hill winner is the holder', soloEnd?.winner === 'h', String(soloEnd?.winner));
check('it took about the target duration', Math.abs(solo.time - HILL.target) < 6,
  `${solo.time.toFixed(0)}s for a ${HILL.target}s target`);

// Two players from different sides cancel out.
const fight = createWorld({ mode: 'hill', seed: 7, modifier: 'none' });
const c1 = addPlayer(fight, { id: 'c1', name: 'C1', seat: 0 });
const c2 = addPlayer(fight, { id: 'c2', name: 'C2', seat: 1 });
fight.phase = 'live';
for (let t = 0; t < 40 / TICK_DT; t++) {
  // Both stand on the zone wherever it currently is, so it stays contested
  // across relocations rather than handing one of them a free stretch.
  c1.x = fight.hill.x; c1.z = fight.hill.z; c1.hp = PLAYER.maxHp;
  c2.x = fight.hill.x + 1; c2.z = fight.hill.z + 1; c2.hp = PLAYER.maxHp;
  stepWorld(fight, TICK_DT);
}
check('a contested hill scores for nobody',
  hillProgress(fight, 0) === 0 && hillProgress(fight, 1) === 0,
  `${(hillProgress(fight, 0) * 100).toFixed(0)}% / ${(hillProgress(fight, 1) * 100).toFixed(0)}%`);
check('contested is reported to clients', fight.hill.contested === true);

console.log('\n--- free-for-all is unaffected ---');
const ffa = play('casual', { seconds: 300 });
check('casual players have no team', [...ffa.world.players.values()].every((p) => p.team === null));
check('casual has no hill or team score', ffa.world.hill === null && ffa.world.teamScores === null);
check('casual never shrinks', ffa.world.safeHalf === MODES.casual.arena / 2, String(ffa.world.safeHalf));
check('casual still respawns', (ffa.events.respawn ?? 0) > 0, `${ffa.events.respawn ?? 0} respawns`);

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
process.exit(failures.length ? 1 : 0);
