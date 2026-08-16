# 🐔 Cluckdown

A top-down multiplayer chicken arena shooter that runs in the browser. Everything
is cubes, the lighting is dark, the bullets glow red, and a black chicken with a
five-second fuse is always waddling toward somebody.

No login, no accounts. Type a name, pick a mode, play.

---

## Quick start

```bash
npm install
npm run dev
```

- Client → http://localhost:5173
- Server → ws://localhost:2567 (dashboard at http://localhost:2567/colyseus)

`npm run dev` runs both. You can also run them separately with `npm run dev:client`
and `npm run dev:server`.

**Practice offline vs bots** on the menu needs no server at all — handy while
working on game feel.

### Controls

First person is the default view. Settings has a Camera dropdown if you'd
rather play top-down, and the in-game camera button cycles all four.

**First person**

| | Touch | Desktop |
|---|---|---|
| Move | Left joystick | `WASD` / arrows |
| Look | Swipe the right half of the screen | Mouse (click to capture, `Esc` to release) |
| Shoot | The FIRE button — draggable, see Settings | Hold left mouse / `Space` |
| Chat | Quick-chat buttons | `T`, or the quick-chat buttons |

**Top-down**

| | Touch | Desktop |
|---|---|---|
| Move | Left joystick | `WASD` / arrows |
| Aim | Right joystick | Mouse |
| Shoot | Hold right joystick | Hold left mouse / `Space` |
| Chat | Quick-chat buttons | `T`, or the quick-chat buttons |

---

## Layout

```
shared/    Headless game simulation — no Babylon, no Colyseus, no DOM
server/    Colyseus rooms; runs shared/ as the authority
client/    Babylon.js renderer, HUD, menu
```

**`shared/` is the important bit.** The simulation is written once as pure
functions over plain data, and *both* sides run it:

- the **server** runs it as the authority and broadcasts the result
- the **client** runs it to predict its own chicken between server snapshots,
  and to drive offline practice mode against bots

Bots emit the same `{ mx, mz, ax, az, shoot }` struct a joystick does, so the
simulation cannot tell a bot from a human, and neither can the renderer.

### Networking shape

State sync carries players, pickups, the bomber, and the match clock. Bullets
are deliberately **not** synced: a bullet is a straight line at a fixed speed
with a known origin, so the server sends one small `shot` event (with an id) and
a matching `bulletEnd` when it lands, and every client draws the identical path
locally. Hit detection stays fully server-side.

Hits use a swept segment test — at 20Hz a bullet moves 1.5 units per tick, so a
naive point test would tunnel straight through a 0.6-radius chicken.

---

## Modes

| Mode | Players | Rules |
|---|---|---|
| **Casual** | 4 | Free-for-all, 4 min, bots fill empty seats |
| **Egg Heist** | 4 | Four eggs per nest. Steal theirs, bank yours, most eggs at the whistle wins |
| **Plant & Defuse** | 4 | Carry the bomb into a rival nest, hold to plant, then survive the fuse |
| **2v2 Teams** | 4 | Blue vs Red, friendly fire off, first team to 20 kills |
| **King of the Coop** | 4 | Hold the zone for 25 uncontested seconds — and it moves every 18 |
| **Last Chicken** | 4 | One life each, and the arena closes in around you |
| **Ranked** | 4 | Free-for-all, Elo on the line, humans only |
| **Deathmatch** | 4 | Endless respawns, first to 15 kills |
| **1v1** | 2 | Tight arena, first to 10, humans only |

Modes are data in `shared/src/constants.js` — `teams`, `hill`, `shrink`,
`respawn` and `killLimit` are flags the simulation reads. Adding a variant is an
entry in `MODES`, not a new system.

**2v2 Teams** puts seats 0 and 3 on the west corners and 1 and 2 on the east, so
a team spawns down one side rather than diagonally across the map. Bullets pass
*through* team-mates rather than being absorbed, so a partner can't body-block you.

**Egg Heist** is decided by what is sitting in your nest at the final whistle,
not by score — so a raid in the closing seconds can take the whole match. Eggs
are stolen one at a time on a cooldown, so a nest can actually be defended;
carrying slows you down, so hoarding is punished; and dying scatters your load
on the floor rather than sending it home, so shooting the carrier is worth it.
Abandoned eggs walk themselves back after 15 seconds so a stalemate can't strand
them.

**Plant & Defuse** was reported as flatly unlearnable, and the reason is
structural: both of its actions are *holding still on a spot*, which is the one
input nobody discovers by experimenting — standing still is what you do when you
have run out of ideas. So the game says it out loud. A running prompt above the
contract strip tracks exactly what to do next ("CARRY THE BOMB TO A RIVAL NEST"
→ "STOP MOVING TO PLANT" → "PLANTING…" with a hold meter), the nest you should
be running at pulses and spins, and the mode announces its goal at the whistle.
The prompt is computed entirely client-side from state that was already synced,
so it costs no extra traffic and works offline.

Under the hood, **Plant & Defuse** has one bomb. Both planting and defusing mean standing still
and holding, which turns it into a fight over a place rather than a race to
touch a thing. Only the nest's owner can defuse, and only nests belonging to a
present player can be planted in — otherwise an empty corner would be a free,
undefusable win.

**King of the Coop** only scores while one side is alone in the zone. Two players
from different sides cancel out, so the point has to be cleared, not just reached.
The zone relocates every 18 seconds with a 4-second warning. That has to be well
under the 25-second win target or the mechanic never fires at all — at 30 seconds
a solo holder wins before the zone ever moves.

**Last Chicken** shrinks the safe area from half-extent 20 down to 7, starting 8
seconds in. Players are clamped to the boundary, so it physically herds everyone
together. The boundary rides in synced state rather than being broadcast — it
moves every tick, and an event per tick would be 60 messages a second for one
number.

Rating is placement-based Elo: finishing above someone counts as beating them,
scaled so a 4-player match moves your rating about as much as one duel would.
It lives in `localStorage` and is sent to the server on join.

## Revenge

Whoever killed you last is marked for 45 seconds: a magenta ring in the world,
a callout on the minimap, and a bonus for taking them back down. It is the
cheapest social mechanic in the genre and the most reliable — it manufactures a
personal story inside a four-minute match between strangers whose names you will
never remember, which is exactly what a session game with no accounts otherwise
lacks.

Dying also brings up a **killed-by panel**: who, with what, from how far, and
how much health they had left. That last number is the point. Perceived fairness
in a shooter is driven almost entirely by whether you understand why you died,
and "Nugget, 12 HP left" turns "this game is rigged" into "I nearly had them" —
the difference between closing the tab and queueing again.

## The between-match loop

Three things live here, all for the same reason: the results screen used to make
*doing nothing* the default action, and doing nothing means leaving.

- **Auto-requeue.** An 8-second countdown on the Play again button, so the
  default outcome is another match. Any pointer, key, scroll or touch cancels
  it — someone reading their rating has not decided to leave, and yanking them
  into a match mid-read is worse than letting them choose.
- **Near-miss framing.** Not "2nd place" but "40 points behind Nugget. So
  close." Same data; the second one is a rematch rather than a verdict.
- **Instant matches.** A public queue now waits 1.5 seconds for other humans
  before filling with bots, down from 8. A human arriving later evicts a bot and
  drops straight into the running match with spawn protection, so nobody is
  stranded and nobody joins to find an empty arena. Private rooms keep a 30
  second wait, because friends gathering actually do want to wait for each
  other.

An empty server is the failure mode that kills small multiplayer games — not a
missing feature. This is the part that addresses it.

## Contracts

Every player carries a rotating personal side-task, shown as a strip along the
bottom of the screen: 45 seconds to finish it, a 4-second gap, then a new one.
They run in every mode, so there is always something to chase even when you are
losing the actual match.

| | Goal |
|---|---|
| **Clean 2 chickens** | 2 kills |
| **Defuse the bomber** | Take the bomber down |
| **Scavenger** | Grab 3 pickups |
| **Arsonist** | Set 2 chickens alight |
| **Trick shot** | Land a hit after a ricochet |
| **Regicide** | Kill the marked chicken |
| **Survive 25 seconds** | Stay alive — dying resets it |
| **Hold the middle for 8s** | Stand in the centre |

The system is deliberately a pure counting layer: `stepContracts` runs last in
the tick and reads the events that tick already produced, so adding a contract
is an entry in `CONTRACTS` rather than a hook threaded through combat. Each one
defines *either* `onEvent(e, p)` or `onTick(p, world, dt)` — never both. An
`onTick` returning `-Infinity` is the "streak broken" signal, which is how
"survive 25 seconds" resets when you die instead of accumulating across a dozen
lives.

You never get the same contract twice in a row.

## Match modifiers

Casual, Teams, Hill, Last Chicken and Deathmatch roll a random twist per match,
announced at the start and shown as a badge under the clock:

| | Effect |
|---|---|
| **LIGHTS OUT** | Ambient light drops to near zero — tracers and pickups are the only light |
| **LOW GRAVITY** | Knockback barely decays, so hits send chickens skating |
| **DOUBLE DAMAGE** | Every shot hurts twice as much |
| **SUDDEN DEATH** | One hit. That's the whole rule |
| **TRIGGER HAPPY** | Fire rate roughly tripled |
| **BOMBER FRENZY** | Bombers arrive early and keep coming |

`none` sits in the pool twice, so a plain match still turns up about a quarter of
the time — otherwise the twists stop feeling like an event. **Ranked and 1v1
never roll one**: a rating only means something if everyone played the same game.

Each modifier is a set of multipliers over existing tuning constants
(`MODIFIERS`), so the simulation applies them in a handful of places and nothing
else knows they exist. The roll comes from the seeded RNG, so a given seed always
reproduces the same match.

> "Low gravity" is a slight lie — there's no jumping in a top-down game, so it's
> implemented as momentum: knockback that barely decays. It reads as floaty in play.

## Aim assist

Aiming with a thumb on a 375px-tall screen is genuinely hard, and that was the
loudest piece of player feedback. `AIM_ASSIST` in `shared/src/constants.js` is
one block of tunables; **`strength` is the whole feel of it**:

```
0     off
0.35  a gentle nudge, you still do the aiming
0.6   comfortable on a phone (default)
1     hard lock, feels like the game plays for you
```

It works as a soft lock with two cones: a tight `cone` to *acquire* a target and
a wider `stickyCone` to *keep* one, so thumb wobble doesn't shake you off but
deliberately turning away still drops the lock. Shots are led slightly ahead of
a moving target.

Two details that are load-bearing:

- Cone checks are measured against the **raw stick angle**, never the assisted
  one. Testing the assisted angle would compare the lock against itself — the
  offset would always be ~0 and a target could never be shaken off.
- The assist is applied to a persistent `p.aim` while the stick writes to
  `p.aimRaw`. An earlier version wrote both to the same field, so every tick
  reset the aim to the raw stick angle and the pull never accumulated — it
  closed 0.028 of a 0.25 radian gap and stayed there.

Humans only. Bots already aim with deliberate error, and handing them assist on
top would just make them snipers.

## Ammo types

Alongside health and rapid-fire, three pickups change what your rounds do. One
ammo slot per player — a new type replaces the old rather than stacking, which
keeps the balance surface finite. Each has its own tracer colour, so you can
read what someone is shooting at a glance.

| Pickup | Effect |
|---|---|
| **Tracking** | Rounds steer toward a target ahead of them, at a capped turn rate so they can still be dodged sideways |
| **Bouncy** | Rounds ricochet off walls twice. The walls are axis-aligned, so a bounce is just negating one velocity component |
| **Fire** | Hits set the target alight — damage keeps ticking for 3s after the shot, credited to the shooter |

Burn damage is applied in half-second chunks rather than every tick. At 60Hz,
per-tick damage would emit sixty hit events a second and bury the kill feed in
damage numbers.

Weights live in `PICKUP_WEIGHTS`. Health stays the most common because it's the
one every player always wants.

## Playing with friends

**Private matches.** "Create a private match" generates a four-character code.
The alphabet excludes `I`, `O`, `0` and `1` because they're indistinguishable
read aloud or squinted at, which is the entire use case.

Rooms are matched on **mode *and* code** (public matches carry an empty code),
and the room verifies the code in `onAuth` before admitting anyone. That second
part is load-bearing: a matchmaking filter is only a routing hint, and a client
that omits the field sends `undefined`, which matches any room. Without the
`onAuth` gate, a public queue could drop a stranger into a friends-only match.

Creating a private match drops you straight into the arena, so the code is shown
as a **chip in the HUD for the whole match** (tap it to copy), not just on the
menu. That was a real bug: the menu is hidden by the time you want to read the
code out, which made a private room impossible to invite anyone to.

**Server browser.** Open public matches are listed on the menu with mode and
player count, one tap to join. Coded rooms never appear there.

## Sound

Every sound is synthesised at runtime with the Web Audio API — oscillators,
filtered noise, gain envelopes. No audio files, no loading, no licensing, 0 KB.
Shots, hits, deaths, explosions, pickups, UI, an accelerating bomber fuse, and
musical stingers that climb a tier per multi-kill.

Browsers refuse to start audio before a user gesture, so the context is unlocked
on the first tap or keypress. Volume and mute live on the menu (`M` toggles it
in-game) and persist to `localStorage`.

## Mobile

Everything here came from player reports, and every report so far has been from
a phone held sideways.

- **Pinch-zoom is suppressed.** `user-scalable=no` in the viewport meta is not
  enough — iOS Safari has ignored it since iOS 10, which is exactly where the
  accidental-zoom reports came from. `client/src/mobile.js` cancels Safari's
  `gesture*` events, any two-finger `touchmove`, and double-tap zoom, all with
  non-passive listeners because `preventDefault()` is ignored on passive ones.
  Single-finger touches pass through untouched — those are the joysticks.
- **Fullscreen button** in the HUD, which also attempts a landscape orientation
  lock (Android Chrome only allows the lock from fullscreen). iPhone Safari has
  no element fullscreen at all, so the button hides itself there rather than
  offering something that silently fails.
- **Rotate prompt.** Orientation lock is unavailable on iOS, so portrait during
  a match shows a "turn your phone sideways" overlay. It never appears on the
  menu, which reads fine upright.
- **Camera framing toggle** — Close / Mid / Full map, cycled from the HUD and
  remembered between sessions. Full map fits the whole arena and stops following
  the player.

### The landscape breakpoint

HUD text used to be sized by a single `max-width: 620px` rule. **An iPhone SE in
landscape is 667×375** — wider than 620, so none of it ever applied and phone
players got desktop-sized text eating the play area. The mobile rules are now
keyed on `max-height`, because on a landscape phone height is the scarce
dimension. `npm run test:mobile` runs the whole suite at 667×375 for this reason.

## First person

**First person is the default view.** The camera button cycles
**First person → Close → Mid → Full map**, and Settings has a Camera dropdown,
so the top-down game is still one tap away for anyone who prefers it.

This is cheaper than it sounds, because the simulation is already 2D: a position
and a single aim angle, which is exactly what a first-person camera needs. The
sim never learns that first person exists. Everything below is client-side.

| | Top-down | First person |
|---|---|---|
| Camera | 22 units up, fixed dimetric tilt | at the chicken's eye height, 1.15 |
| Field of view | 0.8 rad | 1.15 rad |
| Look | — | yaw **and pitch**, clamped to -0.95..+0.42 rad |
| Movement | world-space, W is north | facing-relative, W forward and A/D strafe |
| Aim (desktop) | mouse position on the ground | mouse look under pointer lock |
| Aim (touch) | right stick, absolute | **swipe anywhere on the right half** |
| Fire (touch) | holding the right stick | a dedicated, **repositionable** button |
| Aim assist | on | **off** |
| Extras | none | crosshair, minimap, recoil kick |

### Why the touch scheme changed

The report was "FPS controls are harder on mobile", and the cause was structural
rather than a sensitivity number. The first version used the right stick to
look, as a rate control: hold right, keep turning right. Hitting a *specific*
angle therefore meant holding a direction for exactly the right number of
milliseconds — not something a thumb can do under pressure.

Every shipped mobile shooter (Call of Duty Mobile, PUBG Mobile, Standoff) uses a
bare **swipe surface** instead: a positional mapping where you move your thumb by
the amount you want to turn. Twice the swipe is twice the turn, every time, so
muscle memory has something stable to learn. `test:fps-touch` asserts exactly
that proportionality, because it is the whole point of the change.

Three consequences follow from it:

- **Fire moved to its own button.** The look surface is a drag target now, so it
  cannot double as a fire trigger. The button sits above the look surface in
  z-order and both are tracked by `pointerId`, so holding fire with one thumb
  while swiping to look with the other works — which is how the game is
  actually played.
- **The fire button can be dragged.** Thumb reach varies enormously by hand and
  phone size. Settings, *Move the fire button* enables drag mode; the position is
  stored as viewport fractions so it survives rotation and a change of device.
  Editing sits behind an explicit toggle rather than a long-press, because a
  long-press on a fire button is just... firing.
- **Vertical look exists.** Previously the view only turned left and right,
  which is what "we only move left and right" meant. Pitch is damped relative to
  yaw (`FP_PITCH_RATIO`), because everything worth shooting stands on the ground
  — pitch is for looking, not aiming, and a twitchy vertical axis only makes the
  horizon seasick.

### The crosshair tells the truth

Shots travel along the yaw at chest height; pitch does not tilt them, because
the simulation is flat. A reticle nailed to the centre of the screen would
therefore start lying the moment the view tilted.

Instead the crosshair is drawn at the **projected world position** of the aim
point, 16 units down the firing line. Level, it sits near the centre; tilted, it
moves to wherever the shot will actually be. With aim assist deliberately off in
first person, that honesty is the entire contract with the player.

### Other first-person notes

**Aim assist is off.** The camera renders your *local* yaw so looking around is
instant rather than a network round-trip, while assist would be quietly steering
the server's aim somewhere else. `p.input.fp` carries this to the simulation.

**Your own effects are suppressed.** Your gun goes off roughly where your
eyeballs are, so the muzzle flash (a 0.9-unit glowing sphere) and the tracer (a
3.2-unit stretched box) both rendered *inside* the camera — a full-screen white
flash on every shot. The flash is now skipped for your own shots, your tracer
starts 3.2 units ahead, and a small recoil kick replaces them. It reads as
"I fired" better than the flash did anyway.

**The minimap is not decoration.** Losing the overview is the real cost of first
person in a four-player arena — you can no longer see who is behind you, or
which corner the bomber came from — so it draws players, the bomber, pickups,
nests, the hill zone and the bomb, rotated so your facing is always up.

**Dying** lifts the camera 6 units and tilts it down, because there is nothing
to look through once you are dead.

**On desktop, pointer lock hides the cursor**, which makes every HUD button
unclickable until Esc gives it back. That is correct FPS behaviour and totally
baffling unannounced, so the game says "ESC TO FREE THE CURSOR" the first time
it captures the pointer.

## Graphics settings

Under **Graphics** on the menu, aimed at older phones:

- **Resolution** — Full down to 50%. The biggest single win; the engine
  otherwise renders at up to 1.5× device pixel ratio.
- **Glow effects** — a wide blur on a separate render target every frame,
  routinely 30–50% of frame time on budget GPUs.
- **Antialiasing** — MSAA, meaningful cost on mobile.

These apply to your next match, because the renderer is built at match start.

Some optimisations are unconditional: each chicken is merged into a **single
mesh** with part colours baked into vertex colours (four players plus the bomber
went from ~50 draw calls to 5), debris uses **thin instances** rather than scene
nodes, arena world matrices and materials are **frozen**, and materials are
shared through a per-scene cache.

## Netcode

| | Rate |
|---|---|
| Server simulation | 60 Hz |
| Client input | 60 Hz |
| State broadcast | 40 Hz |

Simulation rate and broadcast rate are deliberately separate: simulating often
makes the game responsive, while broadcasting often mostly makes clients decode
more, and interpolation already covers the gaps.

**The simulation runs on a fixed-step accumulator, not on the timer.** Windows
timer granularity is ~15.6ms, so a 16.67ms `setInterval` really fires at ~26ms.
Advancing the world by a fixed 1/60s per callback ran matches at ~60% speed —
bots arriving late, match clock drifting, everything subtly in slow motion. The
server now accumulates real elapsed time and spends it in fixed-size steps, so
the simulation stays deterministic while the match runs on wall-clock time.
`npm run smoke` asserts the match clock tracks real time, because that failure is
completely silent.

An in-game readout (tap it, or press `N`) shows ping, jitter, FPS and patch rate.
The menu shows server status, live player count and a rough HTTP ping.

### Bots and lobby filling

Casual and Deathmatch keep the arena **full at all times, humans preferred**:
join alone and you get 3 bots, and each human who joins evicts one, so it goes
3 bots → 2 bots → 1 bot → none as the lobby fills. You never wait on an empty
arena, and you never lose your slot to a bot. Bots are marked 🤖 on the
scoreboard.

Ranked and 1v1 never spawn bots — those modes wait for real opponents, because
a rating staked against a bot is worthless. `MODES[...].fillWithBots` in
`shared/src/constants.js` is the switch if you want a different rule.

## The bomber

Spawns in the centre, then: **search** (wander) → **chase** (nearest living
player) → **arm** (5s fuse, slows to 62% speed so you can outrun it) → **boom**
(AOE with distance falloff and knockback).

Shoot it down before the fuse ends and you get 50 points plus a health pack
where it died — a real risk/reward call, since shooting it means standing near it.

---

## Testing

Everything here drives the real thing — a real socket, a real browser, the real
simulation. There are no mocks.

```bash
npm run test:sim       # simulation only: modes + modifiers. No server, ~5s
npm run test:server    # needs `npm run dev:server`
npm run test:browser   # needs `npm run dev` + Playwright chromium
npm test               # all three, in order
```

First time, for the browser suites:

```bash
npm install -D playwright && npx playwright install chromium
```

| Suite | Covers |
|---|---|
| `test:sim` | Mode win conditions, friendly fire, hill scoring and contest, the shrinking zone, every modifier's effect, aim assist, all three ammo types, and every objective system — contracts, Egg Heist, Plant & Defuse, the rotating hill, Hot Potato |
| `smoke` | Two real clients: state sync, input acks, chat rate-limiting, **match clock drift** |
| `test:seats` | Seat allocation and bot eviction when a human joins |
| `test:rooms` | Room-code isolation — a stranger must not reach a private match |
| `test:mobile` | iPhone SE landscape: zoom suppression, HUD sizing, camera views, rotate prompt, results scrolling |
| `test:private` | Two real browsers: host creates a code, friend joins with it, stranger cannot |
| `test:touch` | Emulated phone in landscape, both joysticks dragged with real touch events |
| `test:camera` | Alive / dead / respawn framing, and centring at dpr 1.5 |
| `test:nameplates` | HUD-to-mesh alignment, measured in pixels |
| `test:audio` | Context unlock, cue routing, fuse cadence, mute and volume persistence |
| `test:perf` | Draw-call and material counts, thin instances, graphics settings |
| `test:stats` | Server status panel and the in-game network readout |
| `test:tasks` | Both new modes end-to-end in a browser: nests and eggs render, the bomb is pickable, the contract strip names and counts its task, the zone marker follows a relocation |
| `test:control` | **Knockback can never take the wheel** — see below — plus movement symmetry on every map and in every mode |
| `test:fps` | First person on desktop: camera at eye level and on the player, own body hidden, facing-relative movement, mouse look in both axes, crosshair, minimap, and everything restored on the way out |
| `test:fps-touch` | First person on an emulated phone: swipe-to-look **proportionality**, pitch and its clamp, the fire button, firing and looking with two thumbs at once, and dragging the fire button to a new home |
| `test:retention` | Killed-by panel, the nemesis ring, the auto-requeue countdown and its cancellation |

### The knockback bug, and why `test:control` exists

Players reported "in some maps I slide left easily but can't go right", which
sounded like a map or a control bug and was neither. Knockback is *added* to
movement velocity and was uncapped, so it stacked:

| | impulse | vs top speed (7.2) |
|---|---|---|
| one bullet | 3.5 | recoverable |
| one bullet, LOW GRAVITY | 8.4 | already more than you can walk |
| three-shot burst, LOW GRAVITY | 25.2 | 3.5x top speed, decaying over ~2s |

Sprinting *into* that burst, you moved backwards at up to 18 u/s and ended two
seconds later 5.8 units behind where you started. "Some maps" was really "some
matches" — the ones that rolled LOW GRAVITY, whose badge nobody reads. And
because client prediction ignored knockback entirely, your screen showed you
walking forward while the server dragged you back, which is why it read as
broken controls rather than as being shot.

Two fixes: `PLAYER.maxKnockback` caps the accumulated shove at 1.5x top speed
(a blast still throws you; sustained fire can no longer steer you), and the
client now predicts knockback, carry-slow and warmup speed exactly as the
server applies them. `test:control` pins both, and also proves movement is
symmetric on every map and in every mode — because the original report was
directional and "I checked, it's fine" is not evidence.

Two of the browser objective checks drive the *local player* onto the bomb and
the potato rather than waiting for a bot to blunder into a 1.5-unit radius. That
is deliberate: bots use global `Math.random`, so waiting on one is a coin flip
inside a test window, and the path worth proving in a browser is the player's
own — touch it, and the HUD has to say so. The rules themselves are covered
deterministically in `shared/test/tasks.mjs`.

`test:touch` is not optional cover. Every other browser test drives WASD and the
mouse, which never touches nipplejs — a change in its listener signature once
broke both joysticks completely while the whole suite stayed green.

Two things worth knowing before adding tests here, both learned the hard way:

- **Bot matches are not deterministic.** Bots use global `Math.random()` for aim
  jitter and strafing, so outcomes vary run to run. Anything that must be exact
  (does holding the hill win? does the zone shrink?) is driven directly rather
  than hoped for out of a bot match.
- **Measure on a condition, not a timer.** Under software rendering the browser
  runs at a few frames per second, so a fixed `waitForTimeout` routinely measures
  a half-finished camera pan or an unconverged lerp.

`PLAY_MODE=online npm run test:ui -w @cluckdown/client` runs the UI test against
the real server instead of offline practice.

In dev builds `window.__cluckdown` exposes the live session, game and audio — e.g.
`__cluckdown.session.world.clock = 2` jumps to the results screen — and
`window.__forceMod` pins a match modifier before starting a practice match.

---

## Deploying (free tiers) — step by step

Total cost: **$0**. Total time: about 20 minutes.

### First, the mental model

You are putting **two separate things** on the internet:

| Piece | What it is | Where it goes |
|---|---|---|
| **The server** | Runs the match, decides who got shot | Render (always-on computer) |
| **The client** | The web page players open | Netlify (just files) |

They are deployed separately, to two different websites, and get **two different
URLs**. The last step is telling the client where the server lives. That final
step is the one people forget, so don't skip it.

Do the server first — you need its URL before the client is any use.

---

### Step 0 — Put your code on GitHub

Both hosts read your code from GitHub, so it has to be there first.

1. Make a free account at [github.com](https://github.com).
2. Click the **+** in the top right → **New repository**.
3. Name it `cluckdown`. Leave everything else alone. Click **Create repository**.
4. In your terminal, inside the project folder, run these one at a time —
   replacing `YOUR-USERNAME` with your actual GitHub username:

```bash
git init
git add .
git commit -m "Cluckdown"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/cluckdown.git
git push -u origin main
```

Refresh the GitHub page. If you see your files, you're done here.

> `node_modules` will not upload, and that is correct — it's ~200MB of packages
> the hosts rebuild themselves. `.gitignore` already excludes it.

---

### Step 1 — Put the server on Render

1. Make a free account at [render.com](https://render.com) — sign in with GitHub,
   it's less setup.
2. Click **New +** (top right) → **Web Service**.
3. Find `cluckdown` in the repo list → click **Connect**.
   (First time only: click **Configure account** and give Render permission.)
4. Fill the form in exactly like this:

   | Field | Value |
   |---|---|
   | Name | `cluckdown-server` |
   | Region | pick the one nearest you |
   | Branch | `main` |
   | Root Directory | **leave empty** |
   | Runtime | `Node` |
   | Build Command | `npm install --omit=dev` |
   | Start Command | `npm start` |
   | Instance Type | **Free** |

5. Click **Create Web Service**.
6. Wait. You'll see a black log window scrolling. This takes 2–5 minutes.
   You're waiting for a line like:

   ```
   🐔 Cluckdown server listening on port 10000
   ```

   The number will not be 2567, and that's fine — Render picks its own port and
   tells the server which one to use. You never type this number anywhere.

7. At the top of the page is your URL, something like
   `https://cluckdown-server.onrender.com`. **Copy it somewhere.**

**Check it actually works:** open `https://cluckdown-server.onrender.com/health`
in a browser tab. You should see:

```json
{"ok":true,"uptime":12.34}
```

If you see that, your server is live. If you get an error, jump to
[When it doesn't work](#when-it-doesnt-work).

---

### Step 2 — Turn that URL into a socket URL

This trips up almost everyone, so slowly:

Render gave you an `https://` address. The game talks over WebSockets, which use
`wss://` instead. **Change the front, change nothing else:**

```
https://cluckdown-server.onrender.com     ← what Render shows you
wss://cluckdown-server.onrender.com       ← what you give the client
```

Two rules:

- ✅ `wss://` — not `https://`, not `ws://`. A secure page can only open a secure
  socket, so plain `ws://` gets blocked by the browser.
- ✅ **No `:2567` on the end.** That port number is only for your own computer.
  Render puts it on the normal web port for you. Adding `:2567` will not connect.

Keep this `wss://...` line handy. It's the whole of the next step.

---

### Step 3 — Put the client on Netlify

1. Make a free account at [netlify.com](https://netlify.com) — again, sign in
   with GitHub.
2. Click **Add new site** → **Import an existing project**.
3. Choose **GitHub**, then pick `cluckdown`.
4. Netlify reads `netlify.toml` from the repo, so the build settings should
   already be filled in. Confirm they say:

   - Build command: `npm install && npm run build`
   - Publish directory: `client/dist`

5. **Before clicking deploy** — expand **Add environment variables** and add one:

   | Key | Value |
   |---|---|
   | `VITE_SERVER_URL` | `wss://cluckdown-server.onrender.com` |

   (Use *your* address from Step 2, not this example one.)

6. Click **Deploy**. Wait 2–3 minutes.
7. You get a URL like `https://random-words-123.netlify.app`. That's your game.

---

### Step 4 — Play it

Open your Netlify URL on your phone and your laptop at the same time. Type
different names, both pick **Casual**, both press **PLAY**. You should land in
the same arena and see each other move.

**The first load after a quiet period takes ~30 seconds.** Render's free tier
puts the server to sleep when nobody's playing, and it has to wake up. The menu
pings the server the moment it loads, so the waking-up happens while you're
typing your name. It's only slow the first time.

---

### If you change the code later

Push to GitHub and **both hosts rebuild by themselves**:

```bash
git add .
git commit -m "what you changed"
git push
```

That's the whole deploy process from now on.

---

### When it doesn't work

| What you see | What's wrong | Fix |
|---|---|---|
| Menu says *"Server asleep or offline"* and PLAY does nothing | `VITE_SERVER_URL` is missing or wrong | Netlify → **Site settings → Environment variables**. Fix it, then **Deploys → Trigger deploy → Clear cache and deploy site**. It must be rebuilt, see below. |
| Console: *"insecure WebSocket"* or *"mixed content"* | You used `ws://` | Change it to `wss://` and redeploy |
| Connection just times out | You left `:2567` on the URL | Delete the `:2567`, redeploy |
| `/health` doesn't load at all | Server failed to boot | Render → **Logs** tab, read the red text |
| First game of the day takes 30s | Free tier was asleep | Nothing to fix, that's the free plan |
| Everything works but you're alone | Ranked and 1v1 wait for real humans | Use Casual — it fills with bots |

**The one that catches everybody:** changing `VITE_SERVER_URL` in Netlify does
**not** update your live site on its own. The address gets baked into the
JavaScript files when the site is *built*, so you must trigger a fresh deploy
after changing it. Set the variable → redeploy → then test.

---

### Prefer Vercel over Netlify?

`vercel.json` is included and works the same way. Import the repo at
[vercel.com](https://vercel.com), and add `VITE_SERVER_URL` under
**Settings → Environment Variables**. Same rule: redeploy after adding it.

### Prefer Railway over Render?

Also fine. Import the repo, and Railway reads `PORT` and runs `npm start` on its
own. Use its generated domain in Step 2 exactly the same way.

> **Safety net:** even with the server completely dead, **Practice offline vs
> bots** on the menu still works — it runs the whole game inside the browser. So
> a broken deploy never leaves you with a blank page.

---

## Notes on the dependency pins

Three pins in this repo are load-bearing, all working around upstream packaging
bugs. Don't "clean them up" without checking:

- **`colyseus` is pinned to `0.16.1`, `@colyseus/core` to `0.16.24`.** The 0.17
  line encodes state with `@colyseus/schema` v4, but the newest published browser
  client (`colyseus.js@0.16.22`) still decodes with v3 — mismatched wire formats.
  `@colyseus/core@0.16.25` separately shipped a `"workspace:^"` dependency that
  npm cannot install, and `colyseus@0.16.2`+ have the same problem, so 0.16.24 is
  the newest installable pair. `@colyseus/schema` is a *peer* dependency, which
  is why it's declared explicitly and hoisted to the repo root.
- **`@colyseus/ws-transport` is loaded via `createRequire`, not `import`.**
  `colyseus` ships no `exports` map so Node loads its CommonJS build, while
  ws-transport *does* have one and would resolve to ESM — giving you two separate
  copies of `@colyseus/core` and therefore two `matchMaker` singletons. Seats get
  reserved on one and looked up on the other, and every join fails with
  "seat reservation expired".
- **`@colyseus/monitor` is also `require`d.** Its ESM build references `__dirname`
  and throws on import. The dashboard is optional; failure to load is caught.

## Known rough edges

- **Rating is client-supplied** (`localStorage`), so it's trivially forgeable.
  Fine for a hobby game; it needs a real identity store to mean anything.
  "Ranked" also doesn't match by skill yet — it only filters by mode.
- **Remote players are smoothed exponentially, not interpolated from a snapshot
  buffer.** On a jittery connection that shows as rubber-banding, and at low
  framerates the factor clamps to 1 and it snaps. Proper snapshot interpolation
  (buffer two states, render ~100ms behind) is the fix and costs nothing on the GPU.
- First person gives up a lot of what makes the top-down view work: you cannot
  see the bomber creeping up behind you, and reading a four-way fight is much
  harder. The minimap covers some of that, not all of it. It is offered as a
  choice for players who want it, and the top-down view remains the default.
- Under a very slow renderer the offline practice sim runs slower than real time,
  because per-frame delta is clamped. That's the right trade — better than
  fast-forwarding the match — and online play is unaffected; the server owns the clock.
- Bots are good at killing the bomber. In a 4-bot match it usually gets shot down
  before it detonates; `BOMBER.maxHp` is the knob if you want it scarier.
- Bots don't path around anything, because there is nothing to path around. Adding
  cover to the arena means giving them obstacle avoidance in the same change.
- Last Chicken rounds are short with four players — one life each resolves fast.
  Best-of-N rounds would be the proper fix.
- Performance work is verified by draw-call and material counts, not by profiling
  on real low-end hardware. The counts are real; the frame-time win is inferred.
- **Egg Heist and Plant & Defuse have not been played by humans yet.** The rules
  are covered by tests and the bots exercise them, but the tuning numbers
  (`HEIST`, `BOMB` in `constants.js`) are first guesses. Plant and defuse times
  in particular are the kind of thing only real matches settle.
- Both new modes give every seat a nest, including corners nobody occupies. In
  Egg Heist an empty corner is a free four-egg pile for whoever walks over first;
  in Plant & Defuse it is skipped as a plant target, but it still gets drawn.

## Roadmap

Ordered roughly by value per unit of work:

- **Bomber Horde** — a co-op wave mode. Needs `world.bomber` (a single object) to
  become a list, which is also what unlocks bomber variants below.
- **Powerups** — bounce bullets, shotgun spread, shield, decoy chicken. Wants a
  small registry first so each one is a data entry rather than a special case.
- **Signature mechanics** — streak evolution (your chicken visibly grows), bomber
  variants (fast / heavy / splitter), egg-laying mines.
- **Arena obstacles** — destructible cover and a few layouts. The biggest
  gameplay change available, and the biggest job: bots need avoidance too.

## Contributing

The architecture is built for this: the simulation is pure functions over plain
data in `shared/`, with no renderer or network types anywhere near it. In
practice that means a new mode is an entry in `MODES` plus a rule check in the
step function, and a new modifier is a set of multipliers.

If you change simulation behaviour, `npm run test:sim` runs in about five seconds
and needs nothing else installed — please add a case to it.
