// End-to-end wire smoke test. Boots two real clients against a running server,
// drives input for ~16s and asserts that state sync, FX events, kill feed and
// chat all survive the round trip.
//
//   npm run dev:server        (in one terminal)
//   npm run smoke -w @cluckdown/server
//
// Exits non-zero on failure so it can gate a deploy.

import { Client } from 'colyseus.js';

const ENDPOINT = process.env.SMOKE_ENDPOINT || 'ws://localhost:2567';
const DURATION = Number(process.env.SMOKE_SECONDS || 16);

const failures = [];
const check = (label, cond, detail = '') => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(label);
};

async function main() {
  console.log(`→ connecting to ${ENDPOINT}\n`);

  const r1 = await new Client(ENDPOINT).joinOrCreate('arena', { mode: 'casual', name: 'Alice', rating: 1000 });

  const fx = {};
  const feed = [];
  const chats = [];
  let stateChanges = 0;
  let matchEnd = null;
  let resolvedShots = 0;

  // Attach listeners before the second client joins, otherwise Bob's join
  // broadcast lands before there's anything listening for it.
  r1.onMessage('fx', (evs) => {
    for (const e of evs) {
      fx[e.type] = (fx[e.type] || 0) + 1;
      // Shooting is hitscan: the server resolves the whole shot on the tick it
      // is fired and puts the impact point in the event, and the client draws a
      // tracer between the two. So "the round went somewhere" is a property of
      // the shot event itself rather than a later message.
      if (e.type === 'shot' && Number.isFinite(e.hx) && Number.isFinite(e.hz)) resolvedShots++;
    }
  });
  r1.onMessage('feed', (f) => feed.push(f.kind));
  r1.onMessage('chat', (m) => chats.push(`${m.name}: ${m.text}`));
  r1.onMessage('matchEnd', (m) => { matchEnd = m; });
  r1.onStateChange(() => stateChanges++);

  const r2 = await new Client(ENDPOINT).joinOrCreate('arena', { mode: 'casual', name: 'Bob', rating: 1000 });
  r2.onMessage('fx', () => {});
  r2.onMessage('feed', () => {});
  r2.onMessage('chat', () => {});
  r2.onMessage('matchEnd', () => {});
  r1.onMessage('mapChosen', () => {});
  r2.onMessage('mapChosen', () => {});

  // Matches now open in a map-vote lobby. Vote straight away and wait for play
  // to actually start, or the whole test window is spent in the waiting room.
  const firstMap = [...(r1.state.mapChoices ?? [])][0]?.id;
  if (firstMap) { r1.send('vote', firstMap); r2.send('vote', firstMap); }
  for (let i = 0; i < 200 && r1.state.phase === 'lobby'; i++) {
    await new Promise((res) => setTimeout(res, 100));
  }
  console.log(`  lobby resolved -> ${r1.state.phase} on ${r1.state.map}`);

  check('two clients matched into the same room', r1.roomId === r2.roomId, `${r1.roomId} / ${r2.roomId}`);

  // Baseline for the drift check, taken once the match is genuinely running.
  for (let i = 0; i < 100 && r1.state.phase !== 'live'; i++) {
    await new Promise((res) => setTimeout(res, 100));
  }
  const clockAtStart = r1.state.clock;
  const measuredFrom = Date.now();

  // Peak height and pitch seen for our own chicken over the whole run. Both are
  // new fields on the schema, and a field that is defined but never actually
  // populated looks exactly like a field that works — right up until a jump is
  // invisible to everyone but the person doing it.
  let peakY = 0;
  let peakPitch = 0;

  let seq = 0;
  const drive = setInterval(() => {
    seq++;
    const t = seq / 20;
    const mine = r1.state.players?.get(r1.sessionId);
    if (mine) {
      peakY = Math.max(peakY, mine.y ?? 0);
      peakPitch = Math.max(peakPitch, mine.pitch ?? 0);
    }
    // Jump and look up as well as run and shoot: this is the round trip for the
    // vertical axis, from an input message through the sim to a synced field.
    r1.send('input', { mx: Math.cos(t), mz: Math.sin(t), ax: 1, az: 0, pitch: 0.4, jump: true, shoot: true, seq });
    r2.send('input', { mx: -Math.cos(t), mz: -Math.sin(t), ax: -1, az: 0, shoot: true, seq });
  }, 50);

  // Spaced beyond the server's 900ms per-player chat cooldown.
  setTimeout(() => r1.send('chat', { preset: 0 }), 1500);
  setTimeout(() => r1.send('chat', { text: '  hello   from   the   wire  ' }), 3000);
  // Flood check: the rate limiter should swallow most of these.
  setTimeout(() => { for (let i = 0; i < 10; i++) r2.send('chat', { text: `spam ${i}` }); }, 4500);

  await new Promise((res) => setTimeout(res, DURATION * 1000));
  clearInterval(drive);

  const s = r1.state;
  const me = s.players.get(r1.sessionId);
  const players = [...s.players.values()];

  console.log('\n--- observed state ---');
  console.log('mode:', s.mode, '| phase:', s.phase, '| clock:', s.clock?.toFixed(1), '| arena:', s.arenaSize);
  for (const p of players) {
    console.log(`  ${p.name}${p.bot ? ' (bot)' : ''} seat${p.seat} pos(${p.x.toFixed(1)}, ${p.z.toFixed(1)}) hp${p.hp} k${p.kills} d${p.deaths} score${p.score} ack${p.ack}`);
  }
  console.log('  pickups:', s.pickups.size, '| bomber:', s.bomber?.active ? `${s.bomber.phase} hp${s.bomber.hp} fuse${s.bomber.fuse.toFixed(1)}` : 'inactive');
  console.log('  fx:', JSON.stringify(fx));
  console.log('  feed:', JSON.stringify(feed));
  console.log('  chat:', JSON.stringify(chats));

  // The match clock must track wall-clock time. This guards against a fixed-dt
  // simulation loop drifting when the OS timer can't hit its target interval —
  // at 60Hz on Windows that silently ran matches at ~60% speed.
  // Measured from when the clock actually started ticking, not from join —
  // the lobby and the 1.5s warmup both sit in front of it.
  const elapsedSim = clockAtStart - s.clock;
  const elapsedReal = (Date.now() - measuredFrom) / 1000;
  const drift = Math.abs(elapsedSim - elapsedReal) / elapsedReal;

  console.log('\n--- assertions ---');
  console.log(`  (match clock advanced ${elapsedSim.toFixed(1)}s over ${elapsedReal.toFixed(1)}s real)`);
  check('match clock tracks real time', drift < 0.15,
    `sim ran at ${((elapsedSim / DURATION) * 100).toFixed(0)}% of real speed`);
  check('state is streaming', stateChanges > 50, `${stateChanges} patches`);
  check('match reached live phase', s.phase === 'live' || s.phase === 'over', s.phase);
  check('bots filled the lobby to 8', players.length === 8, `${players.length} players`);
  check('own player is present and named', me?.name === 'Alice', me?.name);
  check('server acknowledged our inputs', (me?.ack ?? 0) > 100, `ack=${me?.ack}`);
  check('players actually moved', players.some((p) => Math.abs(p.x) > 0.5 || Math.abs(p.z) > 0.5));
  console.log(`  (peak height ${peakY.toFixed(2)}u, peak pitch ${peakPitch.toFixed(2)}rad)`);
  check('jumping reaches other clients as height', peakY > 0.4, `${peakY.toFixed(2)}u`);
  check('vertical aim reaches other clients as pitch', peakPitch > 0.3, `${peakPitch.toFixed(2)}rad`);
  check('shots were fired', (fx.shot ?? 0) > 0, `${fx.shot ?? 0} shots`);
  // Was `fx.bulletEnd > 0`, which had been failing quietly since shooting became
  // hitscan: there are no travelling bullets left to end, so that event stopped
  // being emitted and the check could never pass again. What it was really
  // guarding is that a shot resolves to a point, and that is now in the shot.
  check('shots resolve to an impact point', resolvedShots > 0,
    `${resolvedShots} of ${fx.shot ?? 0}`);
  check('damage was dealt', (fx.hit ?? 0) > 0, `${fx.hit ?? 0} hits`);
  check('pickups spawned', (fx.pickupSpawn ?? 0) > 0, `${fx.pickupSpawn ?? 0}`);
  check('bomber spawned', (fx.bomberSpawn ?? 0) > 0, `${fx.bomberSpawn ?? 0}`);
  check('join events reached the feed', feed.includes('join'));
  check('quick-chat preset delivered', chats.some((c) => c.startsWith('Alice: GG')), chats[0]);
  check('free text was whitespace-normalised', chats.some((c) => c === 'Alice: hello from the wire'));
  check('chat flood was rate limited', chats.filter((c) => c.startsWith('Bob:')).length <= 2,
    `${chats.filter((c) => c.startsWith('Bob:')).length} of 10 got through`);

  await r1.leave();
  await r2.leave();

  console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
