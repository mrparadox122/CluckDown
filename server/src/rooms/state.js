import { Schema, MapSchema, defineTypes } from '@colyseus/schema';

// NOTE ON BULLETS: they are deliberately *not* part of synced state.
// A bullet is a straight line at a fixed speed with a known origin, direction
// and lifetime — fully deterministic. So the server broadcasts a one-off "shot"
// event and every client simulates the visual locally. At 4 players spamming
// ~5 shots/sec that's the difference between syncing ~60 moving entities every
// tick and sending a handful of tiny events. Hit detection still happens
// server-side and arrives as authoritative `hit`/`kill` events.

export class PlayerState extends Schema {}
defineTypes(PlayerState, {
  name: 'string',
  seat: 'uint8',
  x: 'float32',
  z: 'float32',
  aim: 'float32',
  hp: 'uint8',
  alive: 'boolean',
  invuln: 'boolean',
  rapid: 'boolean',
  kills: 'uint16',
  deaths: 'uint16',
  score: 'int32',
  respawnIn: 'float32',
  ack: 'uint32', // last input seq the server consumed, for client reconciliation
  bot: 'boolean',
});

export class PickupState extends Schema {}
defineTypes(PickupState, {
  x: 'float32',
  z: 'float32',
  kind: 'string',
});

export class BomberState extends Schema {}
defineTypes(BomberState, {
  active: 'boolean',
  x: 'float32',
  z: 'float32',
  aim: 'float32',
  hp: 'uint8',
  phase: 'string', // 'search' | 'chase' | 'arm'
  fuse: 'float32',
});

export class ArenaState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.pickups = new MapSchema();
    this.bomber = new BomberState();
  }
}
defineTypes(ArenaState, {
  mode: 'string',
  phase: 'string',
  clock: 'float32',
  arenaSize: 'float32',
  killLimit: 'uint16',
  players: { map: PlayerState },
  pickups: { map: PickupState },
  bomber: BomberState,
});
