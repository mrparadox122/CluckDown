# 🐔 Cluckdown

A multiplayer chicken arena shooter that runs in the browser.
Everything is cubes, the lighting is dark, the bullets glow red, and a black
chicken with a five-second fuse is always waddling toward somebody.

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

First or third person, on one toggle. Both aim identically — same crosshair,
same shot — so switching is a matter of what you would rather look at.

| | Touch | Desktop |
|---|---|---|
| Move | Left joystick | `WASD` / arrows |
| Look | Swipe the right half of the screen | Mouse (click to capture, `Esc` to release) |
| Shoot | The FIRE button — hold, and drag to aim | Hold left mouse, or `F` |
| Jump | The JUMP button | `Space` |
| View | The **1P / 3P** button, beside fullscreen | `V` |
| Chat | Quick-chat buttons | `T`, or the quick-chat buttons |
| Ping | Hold the PING button, drag to pick, release | Hold `Z`, aim with the mouse, release |

On touch, **hold FIRE and slide the same thumb to aim.** The press sticks to the
finger rather than to the circle, so the gun keeps firing wherever that thumb
goes and the drag turns the view exactly as a swipe on the look surface does.
Press, track, keep shooting — one gesture, no lifting off. A quick tap fires a
single shot. Both buttons can be dragged to wherever your hands are (Settings →
*Move the touch buttons*), and **Look sensitivity** in the same panel scales
turning for both touch and mouse.

`Space` is jump rather than fire. It used to be the desktop fire key, and one of
the two had to move when jumping arrived: `Space` is the jump key in every
shooter anyone has played, and fire already had a better home on the mouse. `F`
is there for anyone who would rather not hold a mouse button down.

---

## Layout

```
shared/    Headless game simulation — no Babylon, no Colyseus, no DOM
server/    Colyseus rooms; runs shared/ as the authority
client/    Babylon.js renderer, HUD, menu
```

A handful of files are worth knowing by name:

| | |
|---|---|
| `shared/src/sim.js` | the whole simulation, as pure functions over plain data |
| `shared/src/constants.js` | every tunable, with the reasoning beside it — the file you edit to change how the game feels |
| `shared/src/aim.js` | aim assist. Game tuning, so it lives here; it runs on the client |
| `shared/src/accuracy.js` | recoil and the movement cone. Same reason, opposite split: the client applies the recoil, the server rolls the spread |
| `shared/src/roles.js` | the six roles and their six-tier ladders. A tuning table with helpers under it — the numbers at the top are the ones to move |
| `client/src/game/look.js` | where you are looking. **One** number for the camera and the shot |
| `shared/src/sim.js` → `spawnPoints` / `feederFor` | team lines and the shared rally pad — the geometry 4v4 turns on |
| `client/src/game/view.js` | the third-person boom, and the geometry that keeps its crosshair honest |

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
| **Casual** | 4v4 | 4 min, bots fill empty seats |
| **Egg Heist** | 4v4 | Eight eggs per nest. Raid theirs, bank yours, most eggs at the whistle wins |
| **Plant & Defuse** | 4v4 | Carry the bomb into their nest, hold to plant, then survive the fuse |
| **2v2 Teams** | 2v2 | Blue vs Red on a tighter arena, first team to 20 kills |
| **King of the Coop** | 4v4 | Hold the zone for 25 uncontested seconds — and it moves every 18 |
| **Last Chicken** | 4v4 | One life each, last roost standing, and the arena closes in |
| **Ranked** | 4v4 | Elo on the line, humans only |
| **Deathmatch** | 4v4 | Endless respawns, first roost to 40 kills |
| **1v1** | 1v1 | Tight arena, first to 10, humans only |

**Everything is four a side except the two modes that are about being
outnumbered by nobody.** 2v2 Teams stays 2v2 and 1v1 stays 1v1; every other
mode is eight players split down the middle, with friendly fire off. That is
the answer to the report that started this — *"it feels like 1v4"* — and it is
a bigger change than the player count suggests: it also halves the space each
player has, which is the density the game was short of. See
**[Four a side](#four-a-side)**.

Modes are data in `shared/src/constants.js` — `teams`, `hill`, `shrink`,
`respawn` and `killLimit` are flags the simulation reads. Adding a variant is an
entry in `MODES`, not a new system.

**Seats decide sides.** `teamForSeat` snakes over each group of four — seats
0, 3, 4 and 7 west, 1, 2, 5 and 6 east — so eight seats split four and four and
the old 2v2 mapping is untouched. Bullets pass *through* team-mates rather than
being absorbed, so a partner can't body-block you.

**Egg Heist** is decided by what is sitting in your ROOST's nest at the final
whistle, not by score — so a raid in the closing seconds can take the whole
match. There are two nests now, one per team, not one per seat: four private
corners in a 4v4 would mean nobody ever defends anything together, and the
whole point of a nest is that it is a place worth holding. Eggs
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
touch a thing. Only the nest's own side can defuse — *any* of them, which is
what makes a retake a thing four players can do — and only a nest with somebody
alive on that side can be planted in, or an empty side would be a free,
undefusable win.

**King of the Coop** only scores while one side is alone in the zone. Two players
from different sides cancel out, so the point has to be cleared, not just reached.
The hold belongs to the TEAM rather than to a player: four team-mates rotating
through the zone are one hold, and keyed per seat they would each have banked a
quarter of it and nobody would ever have finished.
The zone relocates every 18 seconds with a 4-second warning. That has to be well
under the 25-second win target or the mechanic never fires at all — at 30 seconds
a solo holder wins before the zone ever moves.

**Last Chicken** is FFA-with-no-respawn by definition, so four-a-side reads it
as last ROOST standing: the round ends when one side is wiped out, not when one
body is left. Being dead is also a shorter wait than it sounds, because your
team is still playing the round you are watching. It shrinks the safe area
starting 8 seconds in. Players are clamped to the boundary, so it physically herds everyone
together. The boundary rides in synced state rather than being broadcast — it
moves every tick, and an event per tick would be 60 messages a second for one
number.

Rating is placement-based Elo: finishing above someone counts as beating them,
scaled so a 4-player match moves your rating about as much as one duel would.
It lives in `localStorage` and is sent to the server on join.

> **Flagged, not fixed:** Ranked is a team mode now, and its rating is still
> individual placement. That is defensible — you are rated on how you did, not
> on which side the coin landed — but it is not obviously the right answer for
> a 4v4, and it is the one thing four-a-side changed the meaning of without
> changing the code. Worth a decision before anyone takes the ladder seriously.

---

## Four a side

The report this answers is *"it feels like 1v4"*, and the fix is not better
bots. It is a team.

Every mode except 2v2 Teams and 1v1 is now eight players, four a side, with
friendly fire off. Four things had to move with the player count, and every one
of them was quietly hardcoded to four seats:

**Who is on which team.** `teamForSeat` was `seat === 1 || seat === 2`. At eight
seats that is a 2v6, and nothing anywhere throws — so it snakes over each group
of four instead (0, 3, 4, 7 west; 1, 2, 5, 6 east), which splits 4/4 at eight
seats and leaves the documented 2v2 mapping exactly as it was.

**Where you spawn.** Four corners put both teams diagonally across from each
other, which is a scramble, not a fight. Each team now lines up along its own
wall in four lanes nine units apart, so first contact happens somewhere in the
middle and both sides know which way forward is. Respawns are drawn from your
OWN line: the old rule was "whichever corner is furthest from the nearest
enemy", which on a map with team lines means *behind theirs*.

**Where you refill.** One feeder per team, at the middle of that team's line,
instead of one per seat. That is a deliberate choice rather than a saving: a
shared pad is somewhere four players end up standing next to each other, which
is the cheapest rally point a team game can have. It is also the nest in Egg
Heist and Plant & Defuse, so both of those became two-sided rather than
four-cornered.

**Who you can tell apart.** Eight bodies need two answers at a glance: *whose
side*, and *which of you is that*. The silhouette stays team-coloured, because
"shoot them?" has to be answered in a tenth of a second. A per-player shade of
the same hue rides on the scoreboard dot and the results table for the slower
question. The scoreboard splits into two lists with yours on top — eight names
in score order is a wall you have to read, and in a team game the question is
"how is my side doing", not "what place am I".

### Who you get seated with

Seat index decides your team, so seat *allocation* decides who you play with —
and "first free seat" is the wrong answer to that in both directions. At eight
seats it would have put the first two arrivals on opposite sides, which for two
friends who just typed the same code is precisely the opposite of what they
came for.

`seatOrder` gives two orders, and the room picks by whether it has a code:

- **public queue** — strictly alternating, so the count is balanced at every
  prefix and not merely at the end. The second human to arrive must not be the
  only real player on their side.
- **private room** — team-major, so the first four arrivals are one roost and
  the next four are the other. Friends land together; a group of eight still
  splits into a real match.

Both are permutations of the seat list, so no seat becomes unreachable and the
room still fills. Bot eviction walks the same order — a private room already
full of bots has to drop the *right* one, or the friend who just joined ends up
opposite the person who invited them.

### Map sizes: measured, not assumed

Doubling the roster halves the space per player, and that halving IS the fix —
this game's problem was never that the arena felt cramped. So the maps grew
about 12%, enough for eight bodies and their spawn lanes, and no more. Scaling
by the player-count ratio would have handed the entire density gain straight
back.

`shared/test/density.mjs` is the measurement, and it asserts nothing on
purpose — there is no correct kills-per-minute, only a number you should know
before touching these sizes again. Ten 180-second bot matches per row:

| | | u²/player | kills/min | per player |
|---|---|---|---|---|
| **The Coop** before | 4p FFA, 48u | 576 | 9.5 | 2.37 |
| roster only | 8p 4v4, 48u | 288 | 24.8 | 3.10 |
| **after** | 8p 4v4, 54u | **365** | **23.0** | **2.87** |
| **The Big Yard** before | 4p FFA, 64u | 1024 | 8.1 | 2.02 |
| roster only | 8p 4v4, 64u | 512 | 20.3 | 2.54 |
| **after** | 8p 4v4, 72u | **648** | **17.3** | **2.17** |
| **Tight Squeeze** before | 4p FFA, 34u | 289 | 14.5 | 3.62 |
| **after** | 8p 4v4, 38u | **181** | **37.2** | **4.65** |

The middle row of each block is the point: the roster alone more than doubles
the kill rate, and the 12% of map growth costs about a tenth of that back. Space
per player still falls 37%.

The per-player column is the one that answers the original complaint, and it
went UP — 2.37 to 2.87 kills a minute on The Coop — *despite* friendly fire
meaning half the roster is no longer shootable. A match is denser per person
even though each person has fewer legal targets.

Sizes moved as `MAPS[*].size`, which is the one number cover, lamps, spawns and
the safe zone all derive from. **Nothing about the chicken changed**, and that
is deliberate: shrinking the player would cascade through `PLAYER.radius`,
`hitHeight`, `eyeHeight`, `maxJumpHeight`, `COVER.minHeight`, both third-person
boom offsets and the beak viewmodel — roughly fifteen coupled constants, each
needing retuning, to get the same ratio one number already gives you.

2v2 Teams and 1v1 carry an `arenaScale` that undoes the growth (0.89 and 0.60),
so neither plays a metre differently than it did.

---

## Talking to your roost

A **ping**, not voice. This is a mobile game: a ping is one tap, it is
language-independent, and it carries a position — which is the only thing worth
saying in a firefight anyway. It is what CoD Mobile and Apex use, for exactly
those reasons.

Five intents, and the smallness is the design:

| | |
|---|---|
| ⚠ | Enemy here |
| ◉ | Watch out |
| ➕ | Need help |
| ➤ | On my way |
| ⚔ | Attacking |

A wheel you have to read is a wheel nobody uses under pressure. Five fits one
thumb sweep and covers what a player actually needs to say.

**Picking is by direction, not by position.** Any drag past a 26-pixel deadzone
counts, so the gesture is "flick towards the one I want" rather than "land on a
small target" — the difference between a wheel that works with a thumb while
being shot at and one that does not. Releasing inside the deadzone sends the
first intent, which makes a plain tap the fastest thing on the wheel, and
"enemy here" is what a plain tap should mean. The rule is `pingWedge` in
`constants.js` rather than in the HUD, so it can be tested without a browser.

**The marker is latched when the wheel opens**, at whatever the crosshair had
resolved onto — the same ray `view.js` converges a shot along, so a ping lands
on the thing you were looking at, cover and chickens included. On desktop the
mouse is borrowed to aim the wheel and look is suspended while it is up;
without that, choosing an intent would drag the marker off the thing you were
about to call out.

Markers ride the off-screen world-marker system the bomber and the objectives
already use, so one behind you is pinned to the edge of the screen pointing at
it. They fade over their last second rather than vanishing.

**Pings are never synced state.** Colyseus state goes to every client, and a
team marker an opponent can read is worse than no marker at all — so the server
sends each one only to clients whose chicken is on the pinger's side. Quick
chat and typed chat are scoped the same way, and tagged `[TEAM]` so nobody
types a callout expecting the enemy to read it.

Rate limiting lives in the simulation rather than in the transport: 1.1 seconds
between pings and two live markers per player, oldest dropped. The failure mode
of a ping system is not that nobody uses it — it is one player painting the map
and their team learning to ignore the markers entirely.

## Revenge

Whoever killed you last is marked for 45 seconds: a magenta ring in the world
and a bonus for taking them back down. It is the
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

> "Low gravity" used to be a slight lie — there was no jumping, so it was
> implemented purely as momentum: knockback that barely decays. It halves real
> gravity now as well, so you hang at the top of a jump. The apex does *not*
> change: `PLAYER.maxJumpHeight` clamps position outright, so low gravity buys
> hang time rather than altitude and nobody floats over the walls.

## Grain, and why fire is finite

Fire used to be unlimited, gated only by a cooldown. That is not a balance
problem, it is a design one: with no resource the player never makes a decision
about shooting, so every second of a match is identical to every other second
and nobody is ever vulnerable for a reason they caused.

**The crop is the magazine.** 16 shots against a 5-shot kill — about three
kills' worth if you place every round, one kill and eleven misses if you don't.
Two ways to refill:

| | Where | Cost | Gives |
|---|---|---|---|
| **Peck** | anywhere | stand still ~1.5s, head down, visible to everyone | grain |
| **Feeder** | your own spawn pad | the walk, and being somewhere predictable | grain instantly, plus health |

**A flag, not a change.** The magazine grew from 14 to 16 when the fire rate
nearly doubled, which holds *kills per magazine* steady — but it does not hold
the duty cycle steady. Sixteen rounds at 0.10s is 1.6 seconds of held trigger
against a 1.8-second peck, so a player who empties a crop spends roughly half
their time reloading, and pecking now costs them twice over: standing still is
also the only way to be accurate (see the movement cone below), so a peck is
both the reload and the moment you cannot take. That interaction is worth a
decision rather than a quiet tweak, and the obvious shape is a faster reload
with pecking kept as the *ran-dry* penalty rather than the ordinary one. Nothing
here has changed on that front; it is measured and flagged.

**The reload is a stance, not a button.** You stop, your chicken puts its head
in the dirt, and *everyone can see you doing it*. That readability is the whole
point — a reload only the reloading player knows about creates tension for one
person; a reload the room can read turns "they stopped moving" into information
worth acting on. It is also just what a chicken does, which is the strongest
kind of game feel: the fiction and the mechanic are the same gesture.

**The feeder is an option, not a punishment.** The original pitch was "walk to
spawn when you run out". That fails in a specific way: it is a hard interrupt
that hits whoever just *lost* a fight, and across a 48–64 unit arena it is six
to nine seconds of walking — the least engaging state a shooter has. Offering a
walk that refills *and heals* is the same map traffic with the opposite
feeling. You go because it is worth going, not because you have been sent.

Four rules exist purely to stop the resource becoming a grievance, and every one
of them is a mistake this genre has already made:

- **Pecking refills progressively.** An interrupted reload is never wasted. A
  wasted reload is the single most resented moment in the genre.
- **It starts by itself.** No key to find, nothing to learn.
- **Firing on empty still pecks.** The most panicked player in the match must
  never be the one who cannot recover.
- **A kill refunds 3 grain.** Winning a fight should not immediately cost you
  the next one.

### Bots and the crop

Bots enter a **refilling** state on going dry and leave it at 60% — two
different thresholds, deliberately. While refilling they back away from a nearby
foe for up to ~1.1s (bounded, so it always ends in a peck) and then stand and
eat. They never shoot while refilling, however much grain they have.

Every part of that sentence is a bug that shipped:

- **Entering on `crop <= 0` instead of `dry`.** Firing is gated on `dry`, which
  stays true until `CROP.recoverTo` grain are back. A bot pecked exactly one
  grain, saw a player nearby, resumed strafing — and was then stuck forever,
  unable to shoot because it was still dry and unable to peck because it was
  moving. Reported as *"they just move back and forth in front of me"*, which is
  what being unable to act looks like from outside. One word.
- **Leaving the refill state as soon as firing was legal.** No gap between the
  thresholds means the bot instantly spends the four grain it just earned, goes
  dry, and starts over — a permanent four-round stutter that reads as panic.
  Hysteresis is the fix, and it is why entering and leaving use different
  numbers.
- **Letting a partly-filled bot defend itself.** Sounds humane, undoes the
  mechanism entirely: it fires each grain as it pecks it, and holding the
  trigger stops pecking, so the crop never climbs. Refilling is a commitment or
  it is nothing.

Fixing the first of these roughly doubled bot shot output and took the average
match from 7 kills to 13, because a bot that can reload is a bot that can fight.
`test:crop` asserts the invariant rather than the outcome: a bot is never
stranded — dry, moving, not pecking — for longer than the retreat allows.

### Two things this got wrong first, and what they taught

**Nursing a crop at zero.** Holding the trigger on empty pecked one grain and
instantly fired it, forever — the anti-deadlock rule worked, and the player
spent the recovery before it could add up. `CROP.recoverTo` fixes it: once you
hit zero, nothing fires until 4 grain are back. Running dry is now a
commitment of about half a second rather than a stutter, and that window *is*
the mechanic. A resource you can nurse at zero is not a resource.

**Healing through a fight.** The feeder sits on your spawn corner — which in Egg
Heist and Plant & Defuse is also your **nest**. Defending the objective meant
standing in permanent regeneration, and a bomb detonating under a player left
them at full health. `CROP.feeder.combatDelay` gates *health* (never grain)
behind three seconds without damage. The general rule is worth more than the bug:
you recover from a fight, never through one.

## The pecking order

Power is **earned, not found**. Every shooting pickup — tracking, bouncy and
fire rounds, and rapid fire — was deleted and replaced by a ladder you climb by
killing. That swap is a design argument, not a balance one:

> A pickup is luck. You walk over a thing, become stronger for ten seconds, and
> none of it is attributable to you. It generates no story, teaches nothing, and
> the player who lost the fight lost it to a spawn table.

A ladder is the opposite on every count — legible, yours, and **public**. Every
chicken's rung rides above its health bar, which turns a number into a social
object: it marks the threat in the room, makes a high rung something to defend,
and makes taking one down worth bragging about. Status visible to others is a
far stronger motivator than private power, and it costs one line of HUD.

| Rung | | Unlocks | What it buys |
|---|---|---|---|
| 1 | Chick | — | where everyone starts |
| 2 | Scratcher | **Quick Crop** | peck back to full in half the time |
| 3 | Runner | **Long Legs** | noticeably quicker on your feet |
| 4 | Brawler | **Rapid Peck** | shots come out a third faster |
| 5 | Ironfeather | **Second Wind** | drop below 30% and bolt, once per life |
| 6 | Cock of the Walk | **Feeding Frenzy** | a kill refills you and sets you loose |

Perks accumulate, so rung 6 still has Long Legs.

**They escalate in KIND, not in size** — tempo, then mobility, then power, then
safety, then spectacle. Five different feelings beats one feeling five times,
and it keeps the top of the ladder from being "the same but more", which is
where a progression stops producing anything. Note how little of it is raw
damage: the leader is already the biggest prize in the room, and handing them
lethality on top is how a match ends at minute two. Most of the ladder buys
**time** — faster recovery, faster legs, an escape — which is felt instantly and
still leaves them killable.

Every unlock also has to be felt within *seconds*. "+5% movement" is invisible
and therefore worthless as a reward however good it looks on a spreadsheet.
Second Wind is the clearest case: it *fires*, with a sound and a colour, at the
worst moment of a fight. A perk you notice happening is worth several you
merely have.

### The rung you kill decides the climb

| | XP |
|---|---|
| Beat an equal | 60 (over half a rung) |
| Beat someone **one rung up** | 100 — a whole rung, in one fight |
| Beat someone three rungs up | 180 |
| Beat someone one rung down | 20 |
| Die to an equal or better | −30 |
| Die to someone one rung down | −60 |
| Die to someone three rungs down | −120 |

The leader is simultaneously the biggest threat and the fastest route up, so the
ladder rubber-bands itself instead of running away with whoever got the first
kill. Dying is the mirror: losing to someone above you is nearly free, because
being outmatched is not a mistake — being *upset* is.

`test:levels` measures both ends of that: nine kills against equals reaches the
top, while forty kills on a rung-1 punching bag stalls at rung 3. What each rung
BUYS you now depends on your role — see **Roles** below, and `test:roles`.

### Three guards against the death spiral

Loss aversion runs about twice as strong as the pleasure of an equivalent gain,
so a ladder that takes as freely as it gives is one people stop climbing.

1. **You never fall below rung 1.** There is always a rung to stand on.
2. **You never fall more than one rung per death**, whatever the arithmetic
   says. A rung 5 killed by a rung 1 loses 120 XP — three rungs — and drops
   exactly one. The player who has just lost a fight is the last one who should
   be handed a second punishment on top.
3. **Losing to someone above you is nearly free**, so being new is not taxed.

### One ordering bug worth remembering

`punchedUp` on the kill event — the flag the killfeed and the `giantSlayer`
contract read — was computed when the event was built, which is *after* the XP
was awarded. Beating someone one rung up promotes you level with them, so the
flag came out false: the single kill most worth celebrating was the one that
stopped reporting itself. It is captured before any XP moves now.

## Roles

Four a side is what made roles worth having, and roles are what make four a side
mean something. **Six roles, four slots** — so the last player to pick still has
three left to choose between. Fewer than five and the fourth pick is not a
decision, it is an allocation.

**Unique per team.** One Medic, one Sniper. That single rule is what turns a
pick into a *composition* instead of four people all choosing the strongest
thing.

| Role | What you're for | HP | Speed | Damage | Signature |
|---|---|---|---|---|---|
| **Runner** `»` | gets there first | 75 | ×1.30 | ×0.70, ×1.4 fire rate | **Dash** |
| **Scout** `◈` | says where they are | 80 | ×1.05 | normal | **Sweep** — reveals through walls |
| **Bruiser** `▲` | takes the ground | 180 | ×0.75 | normal close, ×0.35 far | **Bulwark** |
| **Medic** `✚` | keeps them alive | 100 | ×0.85 | ×0.70 | **Pulse** — heals the roost |
| **Sniper** `◎` | deletes one chicken | 60 | ×0.95 | ×3.25, 1.3s re-chamber | the rifle itself |
| **Engineer** `⬢` | holds the ground | 100 | ×1.00 | normal | **Field Feeder** |

Medic and Scout are **not offered in 1v1**: there is no roost to heal or to tell
anything, so both would be nothing but a stat penalty wearing a job title.

### Time to kill, measured

Against an ordinary 100 HP chicken, stationary, point blank — first round that
lands to the one that kills. `test:roles` prints this table every run.

| Role | Damage | Shots | Body | Head |
|---|---|---|---|---|
| Runner | 15.4 | 7 | **500ms** | 250ms |
| Scout | 22 | 5 | **467ms** | 233ms |
| Bruiser | 22 | 5 | **467ms** | 233ms |
| Engineer | 22 | 5 | **467ms** | 233ms |
| Medic | 15.4 | 7 | **700ms** | 350ms |
| Sniper | 71.5 | 2 | **1317ms** | **0ms** |

Three roles sit on the baseline gun Phase 1 tuned. The Medic is deliberately
outside it — 700ms is what "low personal power" costs, and it is the price of
being the chicken that keeps three others upright. The Sniper is outside it in
the other direction, and the whole point of it is the 0ms.

The Runner shipped at ×0.70 rather than the ×0.60 it was sketched with. At 0.60
the arithmetic came out at eight shots and a damage-per-*second* **below** the
ordinary gun (1.4 × 0.6 = 0.84) — so a role called Runner would have had the
slowest kill in the game bar the Sniper, while also being the second softest.
That is not a trade, it is just worse. At 0.70 its DPS lands on the baseline:
seven quick rounds instead of five ordinary ones.

### The Sniper, and why 1.2 had to come first

> A hitscan one-shot-kill with no travel time and no accuracy cost would win an
> eight-player match on its own. There is nothing to dodge, nothing to hear
> coming, and no window in which the target gets a decision.

Three things make it fair, and all three have to stay:

1. **Full accuracy only while stationary.** `spreadMul` 3.4 puts a moving
   Sniper's cone at ~17°, which is a wall-hitting device. This *is* the balance,
   and it is why the movement cone had to exist before the role could.
   `SPREAD.still` is exactly zero, so 3.4 × 0 is still zero — a *stopped* Sniper
   is pinpoint, not nearly pinpoint.
2. **The re-chamber.** 1.3s is thirteen ordinary shots. Miss, and the fight is
   theirs.
3. **60 HP.** Three ordinary body shots — 200ms — and the Sniper is gone.

A headshot does 130 and kills every role outright **except the Bruiser**, who
survives one. That exception is not an accident: it is what makes the Bruiser
the answer to a Sniper, and it is most of why 180 HP is worth having.

### The picker is not a toll gate

Respawn is three seconds, and time-to-action was already a known problem here.
So the picker runs *inside* the wait it was going to cost:

* the countdown never stops
* your last role is already selected, and it is remembered across matches
* **doing nothing respawns you on time, in what you were already playing**
* it is only ever a decision when a team-mate took your role — and that is the
  one case that says so

Picking while **alive** is a request, not a swap: changing your max health in the
middle of a fight that is already happening is not something to do to somebody.
It queues and lands on the next respawn, at the new role's full health.

On desktop the cards are also **1-6**, and that is not a nicety. A locked pointer
cannot click a HUD button, so a mouse player would otherwise have to press Esc,
click, and re-enter the game — three actions inside a three-second respawn.

### The ladder runs through the role now

`LEVELS` still owns the XP curve, the climb/fall asymmetry and all three
death-spiral guards. **None of that changed.** What changed is where a rung's
perk comes from.

Everyone used to unlock the same five — Quick Crop, Long Legs, Rapid Peck, Second
Wind, Feeding Frenzy — which meant a Medic and a Sniper climbed an identical
ladder and the pick stopped mattering the moment the match started. Each role
has its own `tiers[1..6]` now, and all five classics survive on whichever ladder
they fit: Quick Crop went to the Medic (the role standing still most), Long Legs
to the Scout, Rapid Peck to the Engineer, Second Wind to the Runner, Feeding
Frenzy to the Bruiser.

**One player level, applied to whichever role you currently hold.** Levels are
deliberately *not* per-role — a four-minute match would never reach an
interesting tier on any of them.

The rungs kept their names and colours, because that half of the ladder was
never about power: it rides above every chicken's health bar and marks the
threat in the room. The level-up banner now reads `RUNNER · DOUBLE DASH`, so the
perk says which ladder it came off.

### Abilities, and which ones have a button

Two of six do. Time-to-action is a known problem and a phone HUD has room for
about one more thumb target, so **everything that could be passive is passive**:

| | Button | When |
|---|---|---|
| Runner **Dash** | yes | charges, not a flat cooldown — Double Dash is only different from a shorter cooldown if the second charge can be *held* |
| Engineer **Feeder** | yes | where the fight is |
| Medic **Pulse** | no | on a rhythm. A heal you have to remember is dead time in a fight |
| Scout **Sweep** | no | on a cooldown, but it will not *spend* itself on an empty corridor |
| Bruiser **Bulwark** | no | fires once per life at the threshold, like Second Wind |
| Sniper | no | the rifle is the ability |

**The dash never steers you.** `PLAYER.maxKnockback` exists because knockback
that moved a player against their input was a real, reported bug, and a dash is
the single most obvious place to reintroduce it. So the dash is a *multiplier on
the player's own movement vector*, and it refuses to fire without one: hold a
direction, or nothing happens. There is no scripted lunge anywhere in it, and
`test:roles` asserts both halves — a standstill dash is refused, and a dash with
a heading moves you 6 units forward and 0.000 units sideways.

**The Medic cannot heal itself**, and that one rule is the whole balance of the
role. A self-healing Medic is simply the most survivable duellist in the match;
this one is the weakest chicken on the field standing behind the strongest.
There is no out-of-combat gate on the pulse, unlike the feeder — healing under
fire is exactly what a Medic is *for*, and the counterplay is that they are slow,
soft, and standing next to people you are already shooting at.

**A sweep is asked from the viewer's side, never stored on the target.** A
`revealed` flag on the enemy would have to ride in synced state, and synced state
goes to everyone — which would hand the revealed player the news that they had
been spotted. The whole value of the information is that they do not know.

### What roles rewrote underneath

Two things the simulation was previously allowed to assume, and both are silent
when they break:

* **`PLAYER.maxHp` was everybody's health.** It is a role stat now, so every
  place that clamped, healed or thresholded against the constant is a place a
  Bruiser quietly caps at 100. Health bars — yours *and* every nameplate — are
  drawn against `maxHp`, which is why `role` is synced for every player and not
  just your own side: a client cannot draw an enemy health bar without it.
* **`LEVELS.rungs` handed out the perks.** A tier that names nothing is a
  level-up that gives nothing, and the banner would still fire saying "LEVEL 4"
  and no more. `test:roles` walks all six ladders and fails on any silent tier.

Max health is `uint8` on the wire. The top Bruiser tier is 215; 256 would arrive
as 0, which is a chicken that is permanently dead and a bug nobody would think
to look for in a tier table. That is asserted too.

### Bots pick roles, and play them

Bots draw a **random** free role rather than the first one — `addPlayer` resolves
an unspecified role to the first untaken, so four bots filling a side would
otherwise be Runner, Scout, Bruiser, Medic in that order every single match.

They play them through a filter over the plan they already had, rather than six
copies of the AI. `range` does most of the work on its own: a Sniper bot holding
24 units and a Bruiser bot holding 5 look like completely different opponents
running the same three hundred lines.

* a **Sniper** bot stops before it fires — otherwise it sprays a 17° cone all
  match and reads as broken rather than as outgunned
* a **Medic** bot leaves the fight to stand inside its own pulse radius of
  whichever team-mate is worst off
* a **Runner** bot dashes when it is committing to a distance — chasing someone
  down, or peeling out of a fight it is losing
* an **Engineer** bot drops its pad where its team already is

## Aim assist

Aiming with a thumb on a 375px-tall screen is genuinely hard, and that was the
loudest piece of player feedback. `AIM_ASSIST` in `shared/src/constants.js` is
one block of tunables; **`strength` is the whole feel of it**:

**It is off by default on a mouse, and that is the point of the setting having
three states rather than two.** Assist exists for thumbs. On a pointer — which
is already exact — a soft lock pulling at the angle you just set is the game
arguing with your hand, and it is the direct cause of "the shots don't feel like
mine". Same feature, same number, two opposite verdicts, decided entirely by
what you are holding. So the stored value is `'auto' | 'on' | 'off'`: auto asks
`matchMedia('(pointer: fine)')` and gets both devices right, while an explicit
choice always outranks the guess. An old stored `true` migrates to `'auto'`
rather than `'on'` — it was the shipped default, so almost nobody carrying one
ever chose it, and treating it as a preference would preserve the exact problem
the change exists to fix. A stored `false` migrates to `'off'`, because nobody
ever got that by accident.

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
- The assist accumulates in its own angle (`assistYaw` / `assistPitch` on the
  client) while the raw look angle stays untouched. An earlier version wrote
  both to the same field, so every tick reset the aim to the raw stick angle and
  the pull never accumulated — it closed 0.028 of a 0.25 radian gap and stayed
  there.
- **This is the one place the crosshair and the bullet legitimately part
  company**, and it is worth saying out loud next to the recoil bug, which is
  the same divergence arrived at by accident. Assist steers the *shot* without
  steering the view, so with it on the reticle and the round point at slightly
  different things — up to 25 degrees when a target sits right at the edge of
  the acquisition cone. That is the feature working: it is what lets a thumb
  land body shots. `test:aim` measures it and holds it to the sticky cone, so it
  can never bend a round at somebody you were not roughly pointing at, and on a
  mouse the whole question is now moot because assist defaults off there.
- **It runs on the client, not the server.** In first person the camera renders
  your local yaw, so a server quietly steering the aim somewhere else would
  leave the crosshair pointing at one thing and the bullet going to another.
  Shaping the input before it is sent keeps camera, crosshair and simulation in
  exact agreement. `shared/src/aim.js` is the whole of it, and it lives in
  `shared/` because it is game tuning rather than rendering.
- **Both axes.** `pullAim` turns you toward a target; `pullPitch` tilts you onto
  it. The vertical half arrived with 3D shots — leaving it out would have
  recreated the original complaint one axis over.

Humans only. Bots already aim with deliberate error, and handing them assist on
top would just make them snipers.

## Shooting: hitscan, headshots, tagging

A player who came from CS and Valorant said shooting felt unsatisfying and could
not say why. Raising the projectile speed — twice, 30 to 52 — did not fix it,
because it was never a tuning problem. It was three physical models being the
wrong ones.

### 1. Shots are hitscan

`traceShot` resolves the whole shot on the tick it is fired. There are no
projectiles in the simulation at all any more, and `world.bullets` is gone.

The reason is **lead**. CS and Valorant are hitscan, so a player trained on them
never leads a target — they put the dot on it and click. Here a round still took
a couple of tenths of a second to arrive, so every shot they fired landed behind
where they were looking and the game felt like it was arguing with them. No
amount of extra speed closes that, because any flight time at all is a different
model.

It also *simplified* things. The old per-tick stepper did four jobs in sequence —
clip to the floor, clip to the walls, clip to cover, then look for something
alive in what was left — forty times per shot. It now does them once. The
`bulletEnd` event is gone too: the `shot` event carries both ends of the line,
because both were decided in the same instant.

The tracer is still there and still travels, at `BULLET.tracerSpeed`. It is
decoration animating toward an endpoint that has already been decided, which is
exactly how a hitscan game draws one — and it means the streak can be as fast as
it likes without touching the outcome.

Aim assist and the bots both **stopped leading**, in the same change. Leading was
correct for a projectile and is precisely wrong for a trace: it aims at the floor
next to a moving chicken.

### 2. Headshots, and the time to kill

`BULLET.headDamage` is 40 against a body's 22 — three clean headshots kill in
200ms, versus five body shots in 400ms. Aiming carefully and aiming vaguely used
to pay identically, which was the other half of "shooting feels flat"; in CS,
where you put the dot is the whole game.

**Both numbers moved, and the pair is the point.** The gun used to do 19 damage
on a 0.18s cooldown, so a body kill was six rounds and *900 milliseconds* — long
enough for the loser of a duel to simply walk out of it — while a headshot
deleted someone in 180ms. Five to one, with no middle: you either erased a
player or plinked at one, and neither is a fight. That gap was argued for as
skill expression and was not one. A payoff that large stops being a decision and
becomes a coin flip about where the crosshair happened to be when the trigger
came down.

| | before | now |
|---|---|---|
| body | 19 x 6 = **900ms** | 22 x 5 = **400ms** |
| head | 52 x 2 = **180ms** | 40 x 3 = **200ms** |
| gap | 5.0x | **2.0x** |
| fire rate | 333 rpm | **600 rpm** |

400ms is where CoD Mobile's assault rifles and Valorant's Vandal both sit, and
they sit there for a reason: it is about human reaction time, so both players
get exactly one decision each and the better aim wins it. A head is now worth
about 1.8 bodies — two heads and a body kill — which is large enough to aim for
and small enough to be punished for missing.

Everything is tuned from `PLAYER.fireCooldown` and `BULLET.damage` together, and
the number to hold in your head is `(shots to kill - 1) x cooldown`. `test:combat`
asserts the band rather than the constants, so the two can be moved without
rewriting the test — and `PLAYER.minCooldown` moved with them, because it is a
ratio wearing an absolute number and leaving it behind would have quietly capped
TRIGGER HAPPY, Rapid Peck and Feeding Frenzy all at once.

**The line has to sit above eye height, and the first attempt got that backwards.**
`headFrom` started at 1.05 — the underside of the head box the renderer builds,
which looks obviously right. Two chickens stand at the same height, so a shot
fired dead level leaves one eye at 1.15 and arrives at the other at 1.15, inside
the head. Every flat shot was a free headshot, time-to-kill collapsed to two
rounds, and aim assist — which pulls to 0.99, *below* the line — was quietly
making your shots worse. A test caught it, because DOUBLE DAMAGE started
reporting 100 damage a hit.

At **1.28** a level shot lands in the neck and body, and the head has to be aimed
at: about 0.6 of a degree at duelling range, a few pixels of crosshair placement.
That is the skill, and assist deliberately cannot reach it.

### 3. Recoil that moves the bullets

**This was a bug, and it is probably the one the player could feel and could not
name.** The camera rig held its own kick and rendered `pitch + this.recoil`,
while the input struct went out along the un-kicked `pitch`. The crosshair is
nailed to screen centre, so it rode the climbing camera and the rounds did not.
Under sustained fire the reticle sat up to 0.12 radians — 6.9 degrees, or **1.45
units at twelve units of range, a whole chicken** — above where shots landed.
Every element on screen agreed with every other element on screen, which is
exactly why it was invisible: there was nothing to compare the lie against.

Recoil is real now. The kick goes into the look angle itself, which is the one
number the camera renders and the one number the shot is fired along, so they
cannot drift apart — there is no second angle left to drift. `client/src/game/
look.js` owns it, and it is deliberately free of Babylon, the DOM and nipplejs
so that `test:aim` can drive the whole thing headlessly. That test asserts the
camera direction and the fired direction are the same vector to within 1e-12,
at rest across the full look range and through a magazine held down. A future
kick, sway or hit-flinch that touches only the view fails it.

The shape (`RECOIL` in `constants.js`) is deterministic on purpose — a spray is
a pattern you learn and pull against, never a dice roll:

| | |
|---|---|
| `kick` 0.014 | 0.8 degrees per shot, so a 5-round kill burst costs 3.2 degrees |
| `max` 0.20 | 11.5 degrees; a full magazine would otherwise walk off any target |
| `delay` 0.12 | just longer than one shot interval, so nothing recovers *inside* a burst |
| `recover` 0.6 | one shot's kick back in 25ms, a maxed spray in a third of a second |

Two details are load-bearing. **Pulling down spends the bank**: if the player
compensates for the climb themselves, that must remove the climb, or the
automatic recovery lands on top of their correction and drags the view below the
target — a shooter that punishes correct recoil control is worse than one with
no recoil at all. And **the pitch clamp cannot bank a kick it swallowed**: firing
at the sky with the view already at `pitchMax` must not owe recovery for climb
that never happened.

### 4. The movement cone

There was no spread of any kind. Every round landed exactly on the crosshair,
forever, at a full sprint and mid-jump alike — so there was no such thing as a
good position, a good moment, or a wrong one, and shooting had no mastery curve
at all. "Stop moving to shoot" is the first thing a player learns in CS, in
Valorant and in CoD Mobile, and it was the one skill this game did not have.

`SPREAD` is a cone the round is drawn from, sized **by movement and nothing
else**. Firing does not widen it: that job belongs to recoil, which is
deterministic and visible, and keeping the two separate is what lets a
stationary player spray a learnable pattern rather than a random one.

| state | cone | what it costs at 12 units | rounds landed |
|---|---|---|---|
| standing still | **exactly 0** | nothing | **100%** |
| moving, full speed | 5.2 deg | +/- 1.08u against a 0.76u chicken | 48% |
| mid-air | 9.2 deg | +/- 1.94u | 8% |

Zero is not "a small number". First-shot accuracy is the contract the whole
system rests on: if a stopped player's round can miss a target their crosshair
covers, every other rule here reads as the game cheating rather than as a cost
they chose. It also makes the recoil invariant above exactly testable.

Because a cone is an *angle*, range decides what it costs. Moving fire lands
100% of its rounds at 4 units and 13% at 24 — so running and gunning still wins
a point-blank scramble and reliably loses a duel, which is the shape every game
the player named uses. Stopping pays back over `settle` (250ms), which is the
number that makes counter-strafing a skill; landing takes 450ms, because the
airborne cone is wider and settles at the same rate, and being in the air is the
one state you cannot steer out of.

**The roll happens on the authority.** Spread is applied inside `fire()` from
the world's seeded RNG, using a movement state the server derived itself — there
is nothing in the input struct a client could set to decline being inaccurate.
That is the opposite of aim assist, which has to be on the client. The two are
different because one shapes what you asked for and the other decides what
actually happened.

**And the crosshair draws it at true size.** The arms are the cone converted
from radians to pixels through the camera's own field of view, not a stylised
wobble — an inaccuracy the player cannot see is an unfair one. `test:aim` checks
that the number the reticle draws and the number the simulation rolls against
never disagree.

### 5. Tagging, not knockback

Bullets used to shove you across the floor. That is a projectile-game idea, and
to anyone from a hitscan shooter it reads as the game taking the controls off
you — the exact failure `PLAYER.maxKnockback` was added to bound. Being shot now
**tags** you: a brief slow (`tagSlow`, `tagDuration`). The hit lands, you are
meaningfully worse off, and you never stop steering.

Explosions still throw you. Being thrown by a bomb is correct; being nudged
around by rifle fire is not. `test:control` now proves the stronger version of
its original claim — sustained gunfire moves a standing player *zero* units.

## Pickups

**Health, and nothing else.** There used to be four more — tracking, bouncy and
fire rounds, plus rapid fire — and all of them are gone, replaced by the pecking
order above. See that section for why: a pickup is luck, and luck makes a poor
reward.

`PICKUP_WEIGHTS` survives as a one-row table rather than collapsing to a
constant, because the shape is the useful part. Adding a non-combat pickup later
is one line there and nothing anywhere else.

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

**There is one camera.** The top-down view, the camera cycle and the Settings
dropdown that switched between them are gone.

| | Now |
|---|---|
| Camera | the chicken's eyes, or a boom over its shoulder — one toggle, same aim |
| Field of view | 1.15 rad |
| Look | yaw **and pitch**, clamped to `PLAYER.pitchMin`..`pitchMax` |
| Movement | facing-relative: W forward, A/D strafe |
| Aim (desktop) | mouse look under pointer lock |
| Aim (touch) | swipe anywhere on the right half of the screen |
| Fire (touch) | a dedicated, **repositionable** button |
| Jump (touch) | a second one, next to it |
| Aim assist | auto: on for touch, off for a mouse — client-side either way |
| Extras | centre crosshair that shows the spread, hitmarkers, world markers |

### Third person

The camera moves onto a boom behind and to the right; everything else is
untouched. Same stick, same swipe, same buttons, same crosshair, same shot —
which is the whole design goal. Switching views must not be switching games.

**Your chicken sits down and to the LEFT of centre.** That is what `TPP.side`
and `TPP.rise` buy: dead centre would park a whole bird on top of the reticle
and you would be aiming through your own tail.

Think in ratios, not raw units. The boom is a triangle, so lengthening it moves
your chicken back toward the middle of the frame at the same time as it shrinks
it — growing `dist` without growing the offsets quietly undoes the whole point.
At `side/dist ≈ 0.26` and `rise/dist ≈ 0.15` the head sits about 23% of a
half-width left of centre and 24% of a half-height below it, and the bird fills
roughly 22% of the frame height. The first pass used a 4.2 boom with a 0.75
shoulder, which put it 15% off centre at nearly 40% of frame height — crowding
the reticle it exists to keep clear.

**The crosshair problem, and why `view.js` exists.** In first person the camera
sits at the muzzle, so "along the camera" and "out of the gun" are the same line
and a centre reticle is true by construction. A boom breaks that: the crosshair
is now the middle of a camera standing somewhere else, and a shot fired along
the camera's own angles drifts off it — by *more* the closer the target is.

So the shot is bent to pass through the crosshair. `convergeAim` asks the camera
ray what it is pointing at — a chicken the reticle covers, a wall, the floor —
and aims the chicken's gun at that exact point. Nothing reaches the simulation:
it receives the same ordinary `{yaw, pitch}` a first-person player sends, and the
server neither knows nor cares which view produced it. `client/test/view.mjs`
proves the line of fire meets the camera ray to within 1e-12 across 3,780
headings, and that a chicken under the crosshair is hit dead centre at any
range.

Three details that are load-bearing:

- **The ray hangs off the shoulder, not the camera.** Retracting the boom slides
  the camera *along* that ray, so backing into a wall changes what you can see
  and not where you shoot. Aim that shifted when you touched a wall would be the
  worst kind of bug: intermittent, positional, and invisible to any test
  standing in open ground.
- **The shoulder offset is clamped into the arena.** A player is only stopped
  `PLAYER.radius` from a wall, so turning while against one swings a 1.6-unit
  offset clean through it and the camera ends up inside the wall mesh, looking
  at culled back faces — a hole in the world. Squeezing the offset slides the
  camera to directly behind you instead. Camera and aim are squeezed by the same
  amount, which is the only reason the crosshair survives it.
- **Convergence is not a second aim assist.** It only fires when the crosshair
  genuinely covers someone, using the same radius the simulation's hit test
  uses. A generous version would bend shots onto targets the player never aimed
  at, and assist already exists and can be turned off.

The one thing it cannot fix is parallax at a range with nothing in it. With the
shoulder this far out, no single fallback distance keeps a shot inside a
chicken's width across the bullet's whole range — the near and far requirements
contradict each other. That is fine precisely because the fallback is
unreachable while a shot is still in play: inside the arena the ray always meets
a chicken, a wall or the floor. `test:view` proves that rather than assuming it,
by checking that every ray which falls back genuinely exits over the parapet.

### The simulation has a Y axis

It did not, for a long time. Players were 2D circles, bullets travelled flat at
chest height, and `p.aim` was one yaw angle. Pitch existed only as a camera
effect, which is exactly why two separate player reports — *"the crosshair only
moves left and right, I want to shoot anywhere"* and *"ability to jump"* — were
the same underlying change.

What the simulation gained:

| | |
|---|---|
| `p.y`, `p.vy` | height and vertical velocity, on every player |
| `p.pitch` | vertical look, sanitised in `applyInput` like every other field |
| `input.jump` | level-triggered: holding it hops again on landing, never mid-air |
| Bullets | `y` and `vy`; they stop at the floor, and clear the walls if fired steeply enough |
| Hit detection | `segHitsCapsule` — the swept segment against a capsule the size of the chicken |

The two numbers that hold it together, both in `shared/src/constants.js`:

- **`PLAYER.maxJumpHeight` (1.25)** is a hard clamp on position, not a tuned
  impulse. The walls are 2.6 tall and eye height is 1.15, so anything much above
  1.4 lets you see over the top into the void the arena floats above. Clamping
  the position means LOW GRAVITY, a blast, or some future launcher pad cannot
  quietly reintroduce that. A normal jump apexes at 1.11 and never touches it.
- **`PLAYER.hitHeight` (1.8)** makes the hitbox the chicken you can see instead
  of a pillar reaching to the ceiling. `radius` still does all the horizontal
  work, so a duel on flat ground plays exactly as it did — but a shot that
  visibly sails over someone now misses, and one aimed down at a target below
  you lands.

**Knockback stays flat.** A hit may shove you across the floor — that is what it
is for — but nothing except your own jump lifts you, because being airborne is
the one state you cannot steer your way out of. It is the same principle as
`PLAYER.maxKnockback` below: a hit can move you, it must never take the wheel.
`test:control` checks it for every modifier.

**Objective proximity stays 2D on purpose.** Nests, loose eggs, the hill zone,
the potato pass radius and bomb planting all still use `dist2` on the ground
plane. Failing to bank an egg because you happened to be mid-jump would be
maddening, and it is not what anybody asked for.

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

- **Fire moved to its own button — sitting on top of the look surface.** Both
  are tracked by `pointerId`, so holding fire with one thumb while swiping to
  look with the other works. More importantly, a press belongs to the *finger*,
  not to the circle: once you are down on FIRE you keep firing wherever that
  thumb travels, and dragging it calls the same `applyLook` the look surface
  does. Press, keep shooting, track a moving target, never lift.

  This was a player report in its own right. The first version released the
  trigger the moment the thumb crossed the button's visual edge, so following
  someone meant lift, swipe, press again — three actions against a target that
  had already moved, and it read as the gun jamming rather than as a UI
  boundary. `test:fps-touch` drags 150px off a 70px button and asserts both that
  it never stops firing and that it turns at *exactly* the look surface's rate
  per pixel, because "almost the same" is a different control wearing a
  disguise.

  Move and release are listened for on `window`, filtered by `pointerId`, rather
  than relying on `setPointerCapture` — capture throws on a pointer the browser
  has already cancelled, and whether you keep firing must not depend on whether
  a best-effort optimisation happened to work.
- **Both buttons can be dragged.** Thumb reach varies enormously by hand and
  phone size. Settings, *Move the touch buttons* enables drag mode; positions are
  stored as viewport fractions so they survive rotation and a change of device.
  Editing sits behind an explicit toggle rather than a long-press, because a
  long-press on a fire button is just... firing. FIRE and JUMP share one
  `HoldButton` class — two near-identical buttons is how two buttons quietly
  stop behaving the same.
- **Vertical look is a real axis.** It was damped to 0.65 of the horizontal on
  the grounds that pitch was for looking rather than aiming. That stopped being
  true when pitch reached the simulation: damping it now is damping your aim, so
  `FP_PITCH_RATIO` is 0.9. Not 1.0 — a screen is wider than it is tall, so a
  thumb has less vertical travel to spend.

### The crosshair tells the truth

It is nailed to the middle of the screen, and that got *simpler* rather than
harder when aim went 3D.

It used to be projected to the world position 16 units down the firing line,
specifically because shots travelled flat at chest height whatever the view was
doing — a reticle at screen centre would have been pointing at one thing while
the bullet went to another. `fire()` now builds the bullet from the same yaw and
pitch the camera looks down, so screen centre **is** the aim point by
construction, and the projection had nothing left to correct for. Deleted rather
than extended.

**Four arms, a centre gap and a dot.** It used to be two bars crossing straight
*through* the aim pixel, which is the one thing a competitive reticle never
does: the pixel you are aiming at is the pixel you most need to see, and a
chicken at range is a couple of dozen pixels tall. The dot is the aim point; the
arms are the movement cone, and they open and close with it in real pixels.

**Hit confirmation**, which the game simply did not have. The only way to learn
a shot had landed was to watch a health bar you were not looking at. At a 400ms
time-to-kill a duel is four decisions long and "did that land" is the input to
every one of them, so there is now a mark at the crosshair on every hit: white
for a body, gold and larger for a head, red for a kill. It restarts by hand
rather than by retriggering a class, because three hits inside one animation is
normal at this fire rate and the second and third would otherwise do nothing.
The headshot *sound* was already the most distinctive in the game; two channels
saying the same thing is redundancy, not clutter — a phone on silent is a phone
that cannot hear an audio-only hitmarker.

### Other first-person notes

**Aim assist runs on this side of the wire.** The camera renders your *local*
yaw so looking around is instant rather than a network round-trip; a server
applying assist to the angle it received would steer the shot somewhere the
crosshair is not. The client shapes its own input before sending, and the server
adds nothing of its own — `test:combat` asserts that the angle fired is exactly
the angle sent.

**Your own effects are suppressed.** Your gun goes off roughly where your
eyeballs are, so the muzzle flash (a 0.9-unit glowing sphere) and the tracer
both rendered *inside* the camera — a full-screen white flash on every shot. The
flash is now skipped for your own shots, your tracer starts 3.2 units ahead, and
the recoil kick replaces them. It reads as "I fired" better than the flash did
anyway — and it is a real kick now, one that moves the shot as well as the view.
See *Recoil that moves the bullets* above for the version that only moved the
view, and what that cost.

**The tracer's size and the bullet's size are different numbers.**
`BULLET.radius` (0.22) is the collision radius, added to the chicken's own in
the swept hit test; `BULLET.tracerRadius` (0.12) is what you see. They used to
be the same value, which meant the only way to answer "the bullets look too fat"
was to make every shot in the game harder to land. Restyle the streak with
`tracerRadius` and `tracerLength`; change how forgiving the game is with
`radius`.

**Dying** lifts the camera into a slow orbit above where you fell, framing your
killer if they are still up. With no top-down view left in the game, this is the
only overhead anyone gets, so it does real work rather than just parking the
camera.

**On desktop, pointer lock hides the cursor**, which makes every HUD button
unclickable until Esc gives it back. That is correct FPS behaviour and totally
baffling unannounced, so the game says "ESC TO FREE THE CURSOR" the first time
it captures the pointer.

## Settings

The menu panel is called **Settings**, not Graphics — it holds feel controls as
well, and nobody looking for a sensitivity slider opens a menu called
"Graphics". The module, the storage key and the element ids are all still `gfx`
on purpose: renaming them would silently reset the saved settings of everyone
who already has some.

Performance, aimed at older phones. These apply to your **next match**, because
the renderer is built at match start:

- **Resolution** — Full down to 50%. The biggest single win; the engine
  otherwise renders at up to 1.5× device pixel ratio.
- **Glow effects** — a wide blur on a separate render target every frame,
  routinely 30–50% of frame time on budget GPUs.
- **Antialiasing** — MSAA, meaningful cost on mobile.

- **Brightness** — 0.6× to 1.6× over the tuned lighting, and live. The variable
  this exists for is the *screen*: usable contrast varies by more than a factor
  of two between phone panels, and by far more between a dark room and a bus
  window. "Too dark" is often a device statement that no single constant can
  answer.

Feel, all of which apply **immediately** — the only way to judge any of them is
to play with them running:

- **View** — first or third person, on the HUD button rather than in here,
  because the reason to switch is usually "right now". The choice is still
  remembered between matches.
- **Look sensitivity** — 0.25× to 2×, over the tuned base rates in
  `controls.js`. One multiplier for both mouse and touch: they already sit at
  different base rates for good reasons, and what a player is adjusting is
  "faster or slower than this game's normal", not the relationship between the
  two devices. Every look delta in the game goes through one `applyLook` call,
  so the setting cannot apply to some inputs and not others. It updates on
  `input` (so dragging the slider turns the view as you drag) and saves on
  `change` (one settled value in storage, not forty).
- **Aim assist** — `Auto | Always on | Always off`, not a checkbox. See above.
- **Move the touch buttons** — drag mode for FIRE and JUMP.

Some optimisations are unconditional: each chicken is merged into a **single
mesh** with part colours baked into vertex colours (four players plus the bomber
went from ~50 draw calls to 5), debris uses **thin instances** rather than scene
nodes, arena world matrices and materials are **frozen**, and materials are
shared through a per-scene cache.

## Lighting, and the first-person beak

### "Too dark" is a contrast problem, not a brightness one

Players liked the night and could not read it, which is a specific complaint:
the mood was right, the *structure* was missing. Two causes, one of them mine —
the arenas grew from 40 to 64 units and the single key light is a point light,
so the corners went from ~36 units away to ~50 and fell off a cliff.

The fix deliberately is **not** "raise ambient until everything is visible".
That flattens the scene, washes out the glow layer the whole look is built on,
and throws away the night people said they liked. Instead:

- **The fill light was raised and the ground bounce lifted hard** (0.05 → 0.14).
  Not being able to read the floor plane is most of what "too dark" feels like
  in first person — without it you cannot judge distance at all.
- **Fog density halved.** It was tuned against a 40-unit arena and was eating
  the far half of a 64-unit one. Haze reads as darkness.
- **Lamps, and none of them are lights.** Six more `PointLight`s would have been
  the obvious fix and the wrong one — `StandardMaterial` handles four before the
  shader has to grow, and this game targets phones. The lamp posts are emissive
  boxes and the pools beneath them are flat emissive discs: a painted lighting
  rig, thin-instanced into three draw calls, costing nothing per pixel.

What that buys is not brightness, it is **structure**. Pools of light with dark
lanes between them give the floor a scale to judge distance against, give cover
a background to be a silhouette against — and make standing in the light a
decision, because lit ground is where you are seen. Each map gets its own lamp
colour, so the lighting carries map identity rather than being one wash on all
five. LIGHTS OUT builds no lamps at all; dimming them would leave a rig you
could still navigate by.

### The beak

Shots appeared to come out of the middle of the crosshair, and that reading was
correct: in first person the camera sits at the chicken's eye, so the tracer
spawned dead centre and looked like it was leaving the player's own eyeballs.
Every shooter solves this the same way — a weapon model held to one side, with
rounds leaving its muzzle rather than the camera. The absence of one is also why
a first-person view feels disembodied: nothing on screen belongs to your body.

Chickens do not hold guns, so the viewmodel is **your own beak**, low and to the
right, and grain leaves the end of it. The tracer is then aimed at a point
`BEAK.converge` units down the real bullet path, so the drawn streak and the
authoritative round are one line long before anything is close enough to hit —
the same parallax trick as the third-person boom, an order of magnitude smaller.
The muzzle flash comes back with it — and this is where the third mistake was.
The world flash is a 0.9-unit glowing sphere on the glow layer, which is correct
at five metres and, at the 0.8 units your own beak sits from the camera, is
**87% of the frame height**. Reusing it at the beak reproduced exactly the
full-screen white blowout the original code had suppressed it to avoid.

Anything drawn near the camera has to be sized for the distance it is seen from,
because apparent size goes as the inverse of it. So the beak has its own flash —
`BEAK.flash`, 0.05 units, about 5% of the frame, and deliberately **not** on the
glow layer, whose blur radius is tuned for world-space effects and does not
scale down with the thing it is blooming. The tracer needed the same treatment
for the same reason: drawn at the beak it is a glowing streak covering a quarter
of the screen, so it starts `BEAK.tracerGap` past it — about one frame of
travel, invisible as a gap, and the difference between a muzzle flash and a
white-out.

It earns its screen space four more times over, because a viewmodel is the
cheapest feedback surface a first-person game has — always visible, never in the
way, read without being looked at. It recoils when you fire, dips when you peck,
sways when you walk, and shivers when you are dry. Three of those are states the
HUD also reports, and the redundancy is the point: peripheral motion registers
when a meter in the corner does not.

Two things a picture caught that reasoning did not: the first beak was **four
times too big**, filling a quarter of the frame, and the second sat on top of the
health readout. `client/test/_look.mjs` exists for exactly that — it is a
screenshot tool rather than a test, because "is it too dark" and "is that the
right size" have no assertion.

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
npm run test:sim       # simulation, aim and feel. No server or browser, seconds
npm run test:server    # needs `npm run dev:server`
npm run test:browser   # needs `npm run dev` + Playwright chromium
npm test               # all three, in order
```

`shared/test/density.mjs` sits beside these and is deliberately **not** in
`test:sim`: it measures kills per minute at different roster and map sizes and
asserts nothing. Run it with `npm run measure:density -w @cluckdown/shared`
before changing `MAPS[*].size`, and put the numbers in the table above.

First time, for the browser suites:

```bash
npm install -D playwright && npx playwright install chromium
```

| Suite | Covers |
|---|---|
| `test:teams` | Four a side: the seat-to-team snake at 4 and 8 seats, per-player shades, spawn lines that mirror and do not overlap, the shared feeder, respawning on your own half with the enemy standing on it, every mode carrying the right roster — and pings: that a team-mate sees one, the other roost never does, the cooldown and the cap hold, out-of-range and out-of-arena markers are refused, they expire, and the wheel picks the wedge you flicked at |
| `test:sim` | Mode win conditions, friendly fire, hill scoring and contest, the shrinking zone, every modifier's effect, aim assist, the pecking order, and every objective system — contracts, Egg Heist, Plant & Defuse, the rotating hill, Hot Potato |
| `smoke` | Two real clients: state sync, input acks, chat rate-limiting, **match clock drift** |
| `test:seats` | Seat allocation and bot eviction when a human joins |
| `test:rooms` | Room-code isolation — a stranger must not reach a private match |
| `test:mobile` | iPhone SE landscape: zoom suppression, HUD sizing, rotate prompt, results scrolling |
| `test:private` | Two real browsers: host creates a code, friend joins with it, stranger cannot |
| `test:nameplates` | HUD-to-mesh alignment, measured in pixels |
| `test:audio` | Context unlock, cue routing, fuse cadence, mute and volume persistence |
| `test:perf` | Draw-call and material counts, thin instances, graphics settings |
| `test:stats` | Server status panel and the in-game network readout |
| `test:tasks` | Both new modes end-to-end in a browser: nests and eggs render, the bomb is pickable, the contract strip names and counts its task, the zone marker follows a relocation |
| `test:cover` | Map cover: every layout is mirror-symmetric with clear cardinal lanes and nothing landable, bodies and bullets are stopped by it, nothing spawns inside it, and bots steer around it rather than grinding into it |
| `test:levels` | The pecking order: the XP asymmetry both ways, the top being reachable but not farmable, the three death-spiral guards, and that a rung is now identity only — the perks are `test:roles`' problem |
| `test:roles` | Roles: six for four slots and unique per team, every tier naming something, the picker never costing a respawn, time-to-kill per role (printed, not just asserted), **a Sniper that can only shoot standing still**, a Medic that cannot heal itself, **a dash that refuses to fire without a heading**, Bruiser falloff and Bulwark, sweeps that never reach the side being revealed, Engineer pads, and bots picking and playing roles |
| `test:crop` | Grain: the crop empties, pecking refills progressively, the feeder heals only out of combat, and none of the anti-frustration rules can be regressed |
| `test:view` | Third-person framing, headless and instant: the shot line meets the camera ray, a target under the crosshair is hit dead centre, the boom retracts off walls, and the camera never escapes the arena |
| `test:aim` | **The camera and the bullet are the same line** — see below — plus recoil: that it is deterministic, that a tap resets to pixel-exact, that a spray climbs and caps, that compensating by hand is not punished afterwards, and that the reticle's cone and the simulation's cone never disagree |
| `test:spread` | Movement inaccuracy: a standing shot never misses, moving costs about half your rounds at duelling range and none at four units, jumping is the worst way to shoot in the game, stopping pays back in 250ms, and a client claiming to stand still is given the cone anyway |
| `test:tts` | The announcer, headless: the voice ranking (a neural voice beats a local one), a saved voice that has vanished falling back rather than going mute, voices arriving late, and every rule about what it refuses to say |
| `test:control` | **Knockback can never take the wheel** — see below — plus movement symmetry on every map and in every mode, and the vertical axis: jump arcs, the height ceiling, air control, and that nothing but your own jump can lift you |
| `test:combat` | Aim assist in both axes, **that hits land on the same tick as the shot**, headshots (the head line sitting above eye height, and the time-to-kill band in both directions), tagging instead of knockback, the stacked fire-rate floor, and shooting in 3D — over a target, onto a jumping one, down out of a jump, into the floor, over a wall |
| `test:controls` | Desktop: camera at eye level and on the player, own body hidden, facing-relative movement, mouse look in both axes, `Space` jumps and `F` fires, the centre crosshair, the 1P/3P toggle, the sensitivity slider, world markers and the spectator orbit |
| `test:fps-touch` | First person on an emulated phone: swipe-to-look **proportionality**, pitch and its clamp, FIRE and JUMP, jumping and firing and looking with three thumbs at once, and dragging both buttons to new homes |
| `test:retention` | Killed-by panel, the nemesis ring, the auto-requeue countdown and its cancellation |

### The recoil bug, and why `test:aim` exists

The camera rig rendered `pitch + this.recoil`; the input struct went out along
`pitch`. Two numbers for one idea, and the crosshair — nailed to screen centre —
followed the wrong one. Under sustained fire the reticle sat 6.9 degrees above
where rounds landed, which is 1.45 units at duelling range: a whole chicken.

It survived because it was *self-consistent*. The camera, the crosshair and the
viewmodel all agreed with each other; only the bullets disagreed, and bullets
are invisible. A player can feel that and cannot name it, and no test that
checks any one of those things against any other one would ever catch it.

So `test:aim` does not check recoil. It checks the **invariant**: build the
direction the camera looks down and the direction the simulation fires along,
from the same look state, by two independent constructions — and demand they are
the same vector to within 1e-12. At rest across the whole look range, and
through a full magazine held down. That is why `look.js` has no Babylon, no DOM
and no nipplejs in it: the browser is where this bug hid, so the thing that
proves it gone has to run without one.

(It measures the gap as a straight-line distance between two unit vectors rather
than as `Math.acos` of their dot product. Near a dot of 1, `acos` amplifies
floating-point noise by about 1e8 — two identical vectors came back 2e-8 radians
apart, and a test that has to allow 2e-8 cannot tell "identical" from "very
slightly wrong".)

### Two harnesses that had to learn about the cone

Movement spread broke `test:combat` and `test:cover` the day it landed, and both
for the same honest reason: several of their checks fire from the top of a jump,
which is now the widest cone in the game, and they were asking a question about
**geometry** — does a line drawn from here reach there. The answer they started
getting was about randomness instead.

Both fix it with `world.rng = () => 0`. That is an ordinary value of the RNG
rather than a hole punched in the simulation: the deviation is `cone *
sqrt(roll)`, so a roll of zero is dead centre of the cone. The cone itself is
measured in `test:spread`, where it is the subject rather than the weather.

`test:levels` broke too, and that one was a latent bug rather than a
consequence. Its anti-farming check was passing partly because the farmer kept
getting blown up by a bomber that wandered into a run which happened to take 36
seconds — halve the time-to-kill and the same 40 kills take 19, the bomber does
less, and the check fails. It now keeps the bomber out entirely and measures the
clamp as a *ratio* (9 kills to the top against equals, 36 against a rung-1
punching bag) rather than as an absolute number of kills that quietly depended
on how long they took.

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

`test:fps-touch` is not optional cover. Every other browser test drives WASD and
the mouse, which never touches nipplejs — a change in its listener signature once
broke the movement stick completely while the whole suite stayed green. It is
also the only test that dispatches real multi-touch, which is the one thing the
FIRE and JUMP buttons genuinely depend on.

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
- First person gives up a lot of what the old top-down view did for free: you
  cannot see the bomber creeping up behind you, and reading a four-way fight is
  much harder. The off-screen world markers cover some of that, not all of it,
  and there is no top-down view to fall back to any more. A rotating minimap
  covered more of it still and was removed anyway — a permanent 150px canvas
  redrawn every frame is a real cost on the phones this game targets, and it was
  bought with the corner of a screen that is already short of room.
- Jumping is movement, not tactics. There is nothing to jump *onto* — the arenas
  are flat — so it dodges, it looks alive, and that is all. Cover would change
  that, and cover needs bot obstacle avoidance in the same change.
- Under a very slow renderer the offline practice sim runs slower than real time,
  because per-frame delta is clamped. That's the right trade — better than
  fast-forwarding the match — and online play is unaffected; the server owns the clock.
- Bots are good at killing the bomber. In a 4-bot match it usually gets shot down
  before it detonates; `BOMBER.maxHp` is the knob if you want it scarier.
- Bot navigation is one whisker cast down the heading, not pathfinding. It is
  enough for a handful of convex boxes in an open square and would not survive a
  concave map. Tuned by measurement rather than feel: over 40 matches, four bots
  average ~10.1 kills a minute at 12.3% accuracy, dry about a quarter of the
  time. **Bots were never given a compensating accuracy buff when the movement
  cone landed**, and it shows in the right place: their hit rate fell from 16.6%
  to 12.3% because they run and gun constantly, which is exactly the archetype
  the cone is there to tax. Their kill rate is unchanged (10.3 to 10.1 a minute,
  inside the noise) because the faster gun paid for the worse aim. If they ever
  need it back, `DIFFICULTY[*].aimError` in `bots.js` is the knob. A bot that
  learns to stop before firing was the better answer, and roles delivered
  exactly one of them: a Sniper bot now stops before it shoots, because it has
  to. Extending that to every role is the obvious next step. The first pass at
  "make them dumber" landed at 1–4 kills, which is not dumb, it is absent — dumb
  has to mean *bad decisions*, not *cannot shoot*.
- Last Chicken rounds are short — one life each resolves fast, and four-a-side
  only partly helps (a round now ends when a whole side is down, which is later
  than the first death but earlier than seven of them). Best-of-N rounds would
  be the proper fix.
- Performance work is verified by draw-call and material counts, not by profiling
  on real low-end hardware. The counts are real; the frame-time win is inferred.
- **Egg Heist and Plant & Defuse have not been played by humans yet.** The rules
  are covered by tests and the bots exercise them, but the tuning numbers
  (`HEIST`, `BOMB` in `constants.js`) are first guesses. Plant and defuse times
  in particular are the kind of thing only real matches settle.
- Bots do not ping. They play four-a-side correctly — same team assignment,
  same shared feeder, and friendly fire is off so they cannot shoot each other —
  and they now pick and play roles, but the marker system is still human-only,
  so a lobby of bots is a silent one. A Scout bot that pinged what its own sweep
  found would be the single best version of this.
- **Roles have not been played by humans either.** Every rule is under test and
  the time-to-kill table is measured, but the numbers that decide whether a role
  is *fun* — pulse radius, dash distance, sweep cadence — are first guesses.
  Three of them are the ones to watch: the Bruiser at 180 HP takes 800ms to kill
  with the ordinary gun, which is twice anything else and may simply be too long
  to fight; the Medic at 700ms may be too weak to enjoy holding; and a level-6
  Sniper re-chambers in 0.7s, which is two guaranteed kills in a second and a
  half if it is left alone. All three live in `shared/src/roles.js`.
- Ranked is a team mode with an individual placement rating. See the note under
  Modes: defensible, but undecided.
- `HEIST.eggsPerNest` went 4 → 8 when four nests became two. That keeps the
  total on the map identical, which is the safe move and probably not the right
  one — eight players raiding two nests is a different game from four raiding
  four, and nobody has played it yet.

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
- **Persistent progression** — the pecking order resets every match and `rating`
  sits invisibly in localStorage, so nothing pulls a player into match 2. A
  visible account level, role mastery and unlock milestones. Cosmetic or
  lateral only: it must never affect match balance.
- **Reload, honestly** — pecking is a 1.5s stand-still, and standing still is
  now also what accuracy costs, so a dry player pays twice for the same second.
  Worse for a Sniper, who has to stand still to shoot as well. A faster reload
  with pecking kept as the ran-dry penalty is the shape; see CROP.capacity.

## Contributing

The architecture is built for this: the simulation is pure functions over plain
data in `shared/`, with no renderer or network types anywhere near it. In
practice that means a new mode is an entry in `MODES` plus a rule check in the
step function, and a new modifier is a set of multipliers.

If you change simulation behaviour, `npm run test:sim` runs in about five seconds
and needs nothing else installed — please add a case to it.
