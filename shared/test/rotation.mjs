// Role rotation.
//
// Six roles, four slots, unique per team. Left alone that settles into the same
// three people taking Sniper, Medic and Bruiser every match and everybody else
// playing the leftovers — which is a picker with one real option, and a team
// composition nobody chose.
//
// So a role is a LEASE. Every round you are moved to a different free one
// unless you say otherwise. What is checked here is the set of properties that
// make that a feature rather than the game taking the controls away:
//
//   * the roll happens at DEATH, so the picker can OFFER it. Rolling it at
//     respawn is the same feature with the player finding out afterwards.
//   * a tap always wins. Any pick, including picking what you already have,
//     cancels the rotation outright.
//   * it never lands where it started, and never ping-pongs between two.
//   * it never breaks uniqueness, and never hands out a team-only role in a
//     mode that has no team.
//
//   node shared/test/rotation.mjs

import {
  createWorld, addPlayer, beginMatch, stepWorld, damagePlayer, setRole,
  rollRotation, freeRoles, ROLES, ROLE_LIST, ROTATION, PLAYER, TICK_DT,
} from '@cluckdown/shared';

const failures = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

const RESPAWN_TICKS = Math.ceil((PLAYER.respawnDelay + 0.5) / TICK_DT);

function arena(mode = 'casual', seed = 11) {
  const w = createWorld({ mode, seed });
  const n = w.cfg.maxPlayers;
  for (let i = 0; i < n; i++) addPlayer(w, { id: `p${i}`, name: `c${i}`, seat: i });
  beginMatch(w, 'coop');
  for (let i = 0; i < 120; i++) stepWorld(w, TICK_DT);
  return w;
}

/** Kills a player outright and runs the clock past their respawn. */
function cycle(w, p, killerId = null) {
  p.invulnUntil = 0; // spawn protection is not what this test is about
  damagePlayer(w, p, 9999, killerId, 'bullet');
  const offered = p.rotateTo;
  for (let i = 0; i < RESPAWN_TICKS; i++) stepWorld(w, TICK_DT);
  return offered;
}

console.log('--- a role is a lease ---');
{
  const w = arena();
  const me = w.players.get('p0');
  const mates = [...w.players.values()].filter((o) => o.team === me.team && o !== me);
  console.log(`  your roost: ${me.role} (you) + ${mates.map((o) => o.role).join(', ')}`);

  const seen = [me.role];
  const offers = [];
  for (let round = 0; round < 6; round++) {
    offers.push(cycle(w, me, 'p1'));
    seen.push(me.role);
  }
  console.log(`  ${seen.join(' -> ')}`);

  check('every round offered a rotation', offers.every((o) => !!o), offers.join(', '));
  check('the offer is what you came back as',
    offers.every((o, i) => o === seen[i + 1]));
  check('doing nothing changes your role every round',
    seen.every((r, i) => i === 0 || r !== seen[i - 1]),
    seen.join(' -> '));
  check('you are not ping-ponged between two roles',
    new Set(seen).size >= 3, `${new Set(seen).size} different roles in 6 rounds`);
  check('it never hands you a role a team-mate holds',
    seen.every((r) => !mates.some((o) => o.role === r)));
}

console.log('\n--- a tap always wins ---');
{
  const w = arena();
  const me = w.players.get('p0');

  // Die, get an offer, refuse it.
  me.invulnUntil = 0;
  damagePlayer(w, me, 9999, 'p1', 'bullet');
  const offered = me.rotateTo;
  const free = freeRoles(w, me.team, me.id).filter((r) => r !== offered);
  const wanted = free[0];
  check('the game offered something while you were down', !!offered, String(offered));

  setRole(w, me.id, wanted);
  check('picking clears the offer outright, not just outranks it',
    me.rotateTo === null, `rotateTo=${me.rotateTo}`);
  for (let i = 0; i < RESPAWN_TICKS; i++) stepWorld(w, TICK_DT);
  check('you respawn in what you picked, not what was offered',
    me.role === wanted, `${me.role} (offered ${offered})`);
}
{
  // The important case: picking what you ALREADY HAVE is a valid answer, and
  // it has to mean "leave me alone" rather than doing nothing at all.
  const w = arena();
  const me = w.players.get('p0');
  const keeping = me.role;
  me.invulnUntil = 0;
  damagePlayer(w, me, 9999, 'p1', 'bullet');
  setRole(w, me.id, keeping);
  for (let i = 0; i < RESPAWN_TICKS; i++) stepWorld(w, TICK_DT);
  check('re-picking the role you already have keeps it', me.role === keeping, me.role);
}

console.log('\n--- the roll itself ---');
{
  const w = arena();
  const me = w.players.get('p0');

  // Ten thousand rolls against a fixed team, to catch the tail cases a handful
  // of rounds never would.
  const counts = new Map();
  let sameAsCurrent = 0;
  let taken = 0;
  for (let i = 0; i < 10000; i++) {
    const got = rollRotation(w, me, w.rng);
    if (!got) continue;
    counts.set(got, (counts.get(got) ?? 0) + 1);
    if (got === me.role) sameAsCurrent++;
    if (!freeRoles(w, me.team, me.id).includes(got)) taken++;
  }
  const spread = [...counts.entries()].map(([r, n]) => `${r} ${(n / 100).toFixed(0)}%`).join('  ');
  console.log(`  10000 rolls: ${spread}`);
  check('a roll is never the role you are already playing', sameAsCurrent === 0);
  check('a roll is never one a team-mate holds', taken === 0);
  check('the distribution is not one role over and over', counts.size >= 2, `${counts.size} outcomes`);

  // The previous-role guard, which is what stops Runner/Scout/Runner/Scout.
  const before = { ...me, role: 'runner', lastRole: 'sniper' };
  let hitPrevious = 0;
  for (let i = 0; i < 4000; i++) if (rollRotation(w, before, w.rng) === 'sniper') hitPrevious++;
  check('the role before last is avoided while there is anything else',
    hitPrevious === 0 || !ROTATION.avoidPrevious, `${hitPrevious} hits`);
}
{
  // A FULL pool is the case rotation is for, and it is also the case where
  // both filters can empty. Dropping them beats returning null.
  const w = arena();
  const me = w.players.get('p0');
  const free = freeRoles(w, me.team, me.id);
  const other = free.find((r) => r !== me.role);
  const cornered = { ...me, lastRole: other };
  let nulls = 0;
  for (let i = 0; i < 2000; i++) if (!rollRotation(w, cornered, w.rng)) nulls++;
  console.log(`  ${free.length} roles free; avoiding both current and previous`);
  check('a nearly-exhausted pool still produces a roll rather than giving up',
    nulls === 0 || free.length <= 2, `${nulls} refusals`);
}

console.log('\n--- modes with no roost ---');
{
  // 1v1 has no team, so Medic and Scout are not offered at all — they would be
  // a stat penalty wearing a job title. Rotation must not smuggle one in.
  const w = arena('duel', 3);
  const me = w.players.get('p0');
  const teamOnly = ROLE_LIST.filter((id) => ROLES[id].teamOnly);
  let smuggled = 0;
  for (let i = 0; i < 3000; i++) {
    const got = rollRotation(w, me, w.rng);
    if (got && teamOnly.includes(got)) smuggled++;
  }
  check('a 1v1 rotation never lands on a team-only role', smuggled === 0,
    `${teamOnly.join('/')} blocked`);
}
{
  // Last Chicken has one life, so there is no round boundary inside a match and
  // nothing should ever rotate mid-round. Verified by there being no respawn.
  const w = arena('survival', 5);
  check('a no-respawn mode has no round boundary to rotate on',
    w.cfg.respawn === false, `respawn=${w.cfg.respawn}`);
}

console.log('\n--- the cadence knob ---');
{
  check('everyLives is a real cadence, not a flag',
    Number.isInteger(ROTATION.everyLives) && ROTATION.everyLives >= 1,
    `every ${ROTATION.everyLives} live(s)`);
  const w = arena();
  const me = w.players.get('p0');
  me.livesSinceRotate = 5; // as if the knob had been turned up
  cycle(w, me, 'p1');
  check('the cadence counter resets when a rotation lands',
    me.livesSinceRotate === 0, `5 -> ${me.livesSinceRotate}`);

  // Turned up, it must actually skip rounds rather than rotating anyway.
  const was = ROTATION.everyLives;
  ROTATION.everyLives = 3;
  const w2 = arena('casual', 21);
  const other = w2.players.get('p0');
  const offers = [];
  for (let i = 0; i < 6; i++) offers.push(cycle(w2, other, 'p1') ? 'ROTATE' : 'keep');
  ROTATION.everyLives = was;
  console.log(`  at everyLives=3, six rounds go: ${offers.join(' ')}`);
  check('a higher cadence really does skip rounds',
    offers.filter((o) => o === 'ROTATE').length === 2, offers.join(' '));
}

console.log(failures.length ? `\nX ${failures.length} check(s) failed\n` : '\nAll checks passed\n');
process.exit(failures.length ? 1 : 0);
