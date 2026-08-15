// Private match flow, driven through the real UI in two browsers.
//
// The reported bug was "create private rooms not working". Creating the room
// worked fine — but it drops the host straight into the arena, and the code was
// only rendered on the menu, which is hidden by then. An invite code you can
// never read is the same as no invite code.
//
//   npm run dev  (server + client)
//   node client/test/private.mjs

import { chromium } from 'playwright';

const URL = process.env.UI_URL || 'http://localhost:5173';
const failures = [];
const pageErrors = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const openClient = async (name) => {
  const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
  page.on('pageerror', (e) => pageErrors.push(`[${name}] ${e.message}`));
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.fill('#name-input', name);
  return page;
};

// --- host creates a private match ---------------------------------------
console.log('\n--- host ---');
const host = await openClient('Host');
await host.click('#friends-box summary');
await host.waitForTimeout(200);
await host.click('#create-private');
await host.waitForTimeout(6000);

const hostState = await host.evaluate(() => ({
  inGame: !!window.__cluckdown?.game,
  chipText: document.getElementById('room-chip').textContent,
  chipHidden: document.getElementById('room-chip').classList.contains('hidden'),
  menuHidden: document.getElementById('menu').classList.contains('hidden'),
  roomId: window.__cluckdown?.session?.room?.roomId ?? null,
}));
console.log('  ', JSON.stringify(hostState));

const code = (hostState.chipText.match(/([A-Z0-9]{4})/) ?? [])[1];
console.log('  code on screen:', code);

check('host lands in a match', hostState.inGame);
check('the menu is gone (this is why the chip is needed)', hostState.menuHidden);
check('the invite code is visible in-game', !hostState.chipHidden && !!code, hostState.chipText);

// --- a friend joins with that code ---------------------------------------
console.log('\n--- friend ---');
const friend = await openClient('Friend');
await friend.click('#friends-box summary');
await friend.waitForTimeout(200);
await friend.fill('#join-code', code.toLowerCase()); // lowercase on purpose
await friend.click('#join-code-btn');
await friend.waitForTimeout(6000);

const friendState = await friend.evaluate(() => ({
  inGame: !!window.__cluckdown?.game,
  chipText: document.getElementById('room-chip').textContent,
  roomId: window.__cluckdown?.session?.room?.roomId ?? null,
  status: document.getElementById('menu-status').textContent,
  players: (window.__cluckdown?.session?.players ?? []).map((p) => p.name),
}));
console.log('  ', JSON.stringify(friendState));

check('friend joins a match', friendState.inGame, friendState.status || 'no error shown');
check('friend lands in the HOST\'s room', friendState.roomId && friendState.roomId === hostState.roomId,
  `${friendState.roomId} vs ${hostState.roomId}`);
check('lowercase code still worked', friendState.chipText.includes(code), friendState.chipText);

// Both should see each other once state syncs.
await host.waitForTimeout(2500);
const roster = await host.evaluate(() => (window.__cluckdown?.session?.players ?? [])
  .filter((p) => !p.isBot).map((p) => p.name).sort());
console.log('  human roster in host match:', JSON.stringify(roster));
check('both humans are in the same match', roster.includes('Host') && roster.includes('Friend'),
  JSON.stringify(roster));

// --- a stranger queuing publicly must NOT land in it ---------------------
console.log('\n--- stranger ---');
const stranger = await openClient('Stranger');
await stranger.click('#play-btn');
await stranger.waitForTimeout(6000);
const strangerRoom = await stranger.evaluate(() => window.__cluckdown?.session?.room?.roomId ?? null);
console.log('  stranger room:', strangerRoom, 'private room:', hostState.roomId);
check('a public queue never reaches the private match',
  strangerRoom && strangerRoom !== hostState.roomId, `${strangerRoom} vs ${hostState.roomId}`);

check('no exceptions', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || 'none');

console.log(failures.length ? `\n✗ ${failures.length} check(s) failed\n` : '\n✓ all checks passed\n');
await browser.close();
process.exit(failures.length ? 1 : 0);
