import http from 'http';
import { createRequire } from 'module';
import express from 'express';
import cors from 'cors';
import { Server } from 'colyseus';
import { MODE_LIST, MODES } from '@cluckdown/shared';
import { ArenaRoom } from './rooms/ArenaRoom.js';
import { snapshot, listPublicRooms } from './stats.js';

const require = createRequire(import.meta.url);

// Both of these MUST be loaded as CommonJS.
//
// `colyseus` ships no "exports" map, so Node resolves it to its CJS build,
// which pulls in the CJS copy of @colyseus/core. But @colyseus/ws-transport
// *does* have an "exports" map, so a plain `import` would hand us its ESM
// build — which pulls in a *second*, separate copy of @colyseus/core. Two
// copies means two `matchMaker` singletons: matchmaking reserves your seat on
// one, the websocket upgrade looks for it on the other, and every single join
// dies with "seat reservation expired". Requiring it keeps one core alive.
//
// @colyseus/monitor is here for a duller reason: its ESM build references
// __dirname and throws on import. Its CJS build is fine.
const { WebSocketTransport } = require('@colyseus/ws-transport');

const PORT = Number(process.env.PORT) || 2567;

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Live server stats for the main menu. Deliberately kept tiny — the menu polls
// this every few seconds and it must stay cheap enough to ignore.
app.get('/stats', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(snapshot());
});

// Server browser. Only public, in-progress matches — coded rooms stay hidden.
app.get('/rooms', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ rooms: listPublicRooms() });
});

app.get('/modes', (_req, res) => {
  res.json(MODE_LIST.map((id) => ({
    id,
    label: MODES[id].label,
    blurb: MODES[id].blurb,
    maxPlayers: MODES[id].maxPlayers,
    ranked: MODES[id].ranked,
  })));
});

// Free hosting (Render/Railway) idles the instance out; the client pings this
// while the menu sits idle so the first match doesn't eat a 30s cold start.
app.get('/wake', (_req, res) => res.json({ awake: true }));

if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_MONITOR === '1') {
  try {
    const { monitor } = require('@colyseus/monitor');
    app.use('/colyseus', monitor());
  } catch (err) {
    console.warn('Colyseus monitor unavailable:', err.message);
  }
}

const gameServer = new Server({
  transport: new WebSocketTransport({ server: http.createServer(app) }),
});

// One room type, filtered by mode AND code, so matchmaking never drops a 1v1
// player into a 4-player deathmatch lobby — nor a stranger into a friends-only
// match. Public rooms carry an empty code, private ones carry the shared code,
// and joinOrCreate simply never matches across the two.
gameServer.define('arena', ArenaRoom).filterBy(['mode', 'code']);

gameServer.listen(PORT).then(() => {
  // Deliberately reports the port rather than a ws://localhost URL: on a host
  // like Render the port is injected and "localhost" reads as if the deploy
  // failed to go public.
  console.log(`🐔 Cluckdown server listening on port ${PORT}`);
  if (process.env.NODE_ENV !== 'production') {
    console.log(`   local client should connect to ws://localhost:${PORT}`);
  }
}).catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
