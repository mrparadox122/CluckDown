import { Schema, MapSchema, ArraySchema, defineTypes } from '@colyseus/schema';

// NOTE ON BULLETS: they are deliberately *not* part of synced state.
// A bullet is a straight line at a fixed speed with a known origin, direction
// and lifetime — fully deterministic. So the server broadcasts a one-off "shot"
// event and every client simulates the visual locally. At 4 players spamming
// ~5 shots/sec that's the difference between syncing ~60 moving entities every
// tick and sending a handful of tiny events. Hit detection still happens
// server-side and arrives as authoritative `hit`/`kill` events.
//
// NOTE ON PINGS: also not synced, for a different reason. Synced state goes to
// every client, and a team marker an opponent can read is worse than no marker
// at all — so pings are sent as messages, to team-mates only.

export class PlayerState extends Schema {}
defineTypes(PlayerState, {
  name: 'string',
  seat: 'uint8',
  team: 'int8',      // -1 in free-for-all
  hillPct: 'uint8',  // 0-100 share of the King of the Coop target
  x: 'float32',
  // Height above the floor. Everyone needs it: the renderer to draw a chicken
  // in mid-air, and every shooter's client to know that a jumping target's
  // hitbox has left the ground with them.
  y: 'float32',
  z: 'float32',
  aim: 'float32',
  // Vertical look. Synced for the same reason `aim` is — it is half of where
  // this player's shots are going, and other clients draw the tracer.
  pitch: 'float32',
  hp: 'uint8',
  alive: 'boolean',
  invuln: 'boolean',
  // The pecking order. `level` is synced for EVERYONE because it rides above
  // their health bar — it is the whole point of the ladder that it is public.
  // `xp` and `nextXp` only ever draw your own bar, but they are two small
  // numbers and a per-client channel would cost more than it saves.
  level: 'uint8',
  xp: 'uint16',
  nextXp: 'uint16',
  wind: 'boolean',    // Second Wind is running
  frenzy: 'boolean',  // Feeding Frenzy is running
  // Grain. `crop` is your own ammo counter; `pecking` and `feeding` are synced
  // for EVERYONE because they are the tell — a chicken with its head down is
  // reloading, and reading that off another player is the point of making the
  // reload a stance instead of a button.
  crop: 'uint8',
  pecking: 'boolean',
  feeding: 'boolean',
  // Ran dry and has not recovered yet. Its own field rather than derived from
  // `crop`, because "below the recovery floor" and "cannot fire" are not the
  // same thing: you may deliberately fire down to one grain and still shoot.
  dry: 'boolean',
  kills: 'uint16',
  deaths: 'uint16',
  score: 'int32',
  respawnIn: 'float32',
  // Knockback velocity. Synced because client prediction has to apply the
  // same shove the server will, otherwise every hit ends in a correction
  // and a blast reads as a rendering glitch rather than as being hit.
  //
  // There is no `vy` here on purpose. Knockback arrives from events a client
  // cannot see coming, so it has to be told; vertical velocity comes from one
  // source only — your own jump input — which the client already has. It
  // predicts its own arc and eases `y` toward the server's.
  kx: 'float32',
  kz: 'float32',
  nemesis: 'string', // sessionId of whoever killed you last, '' for nobody
  ack: 'uint32', // last input seq the server consumed, for client reconciliation
  bot: 'boolean',
  carrying: 'uint8', // eggs in hand (Egg Heist)
  // The contract is per-player and only ever read by its owner, but it rides in
  // the same record anyway: it is two small fields, and a separate per-client
  // channel would cost more than it saves.
  contract: 'string',      // '' when between contracts
  contractLabel: 'string',
  contractAt: 'float32',   // seconds left
  contractGoal: 'float32',
  contractDone: 'float32', // progress toward the goal
});

/** One team's nest: home base in Egg Heist, plant site in Plant & Defuse. */
export class NestState extends Schema {}
defineTypes(NestState, {
  team: 'uint8',
  x: 'float32',
  z: 'float32',
  eggs: 'uint8',
});

/** An egg on the floor, dropped by a carrier who died. */
export class EggState extends Schema {}
defineTypes(EggState, {
  x: 'float32',
  z: 'float32',
  team: 'uint8',       // nest it belongs to
  returnAt: 'float32', // seconds until it walks itself home
});

/** One candidate in the pre-match map vote. */
export class MapChoiceState extends Schema {}
defineTypes(MapChoiceState, {
  id: 'string',
  votes: 'uint8',
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
    this.mapChoices = new ArraySchema();
    this.nests = new ArraySchema();
    this.eggs = new MapSchema();
  }
}
defineTypes(ArenaState, {
  mode: 'string',
  modifier: 'string',
  // Last Chicken Standing boundary. Synced as state rather than broadcast,
  // because it moves every tick and clients only need the current value.
  safeHalf: 'float32',
  teamBlue: 'uint16',
  teamRed: 'uint16',
  hillHolder: 'string',
  hillContested: 'boolean',
  // The zone relocates, so clients need where it is, not just who holds it.
  hillX: 'float32',
  hillZ: 'float32',
  hillMoveAt: 'float32',
  map: 'string',
  lobbyTime: 'float32',
  mapChoices: [MapChoiceState],
  bounty: 'string',       // sessionId of the crowned chicken, '' for nobody
  potatoActive: 'boolean',
  potatoX: 'float32',
  potatoZ: 'float32',
  potatoFuse: 'float32',
  potatoHolder: 'string',
  phase: 'string',
  clock: 'float32',
  arenaSize: 'float32',
  killLimit: 'uint16',
  // Plant & Defuse. One bomb at a time, so it is flat fields rather than a
  // child schema — cheaper on the wire and simpler to read on the client.
  bombState: 'string',    // '' | loose | carried | planted
  bombX: 'float32',
  bombZ: 'float32',
  bombCarrier: 'string',
  bombTeam: 'int8',       // whose nest it is planted in, -1 when it isn't
  bombFuse: 'float32',
  bombPlant: 'float32',   // 0..1 plant progress
  bombDefuse: 'float32',  // 0..1 defuse progress
  players: { map: PlayerState },
  pickups: { map: PickupState },
  nests: [NestState],
  eggs: { map: EggState },
  bomber: BomberState,
});
