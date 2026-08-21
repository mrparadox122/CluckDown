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

**The crop is the magazine.** 14 shots against a 10-shot kill — enough to kill
one chicken with four misses, never enough for two. Two ways to refill:

| | Where | Cost | Gives |
|---|---|---|---|
| **Peck** | anywhere | stand still ~1.5s, head down, visible to everyone | grain |
| **Feeder** | your own spawn pad | the walk, and being somewhere predictable | grain instantly, plus health |

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
top, while forty kills on a rung-1 punching bag stalls at rung 3.

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
- The assist accumulates in its own angle (`assistYaw` / `assistPitch` on the
  client) while the raw look angle stays untouched. An earlier version wrote
  both to the same field, so every tick reset the aim to the raw stick angle and
  the pull never accumulated — it closed 0.028 of a 0.25 radian gap and stayed
  there.
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

### 2. Headshots

`BULLET.headDamage` is 52 against a body's 11 — two clean headshots kill, versus
ten body shots. That five-to-one payoff is deliberately enormous, because the
other half of "shooting feels flat" was that every shot did the same damage
wherever it landed. Aiming carefully and aiming vaguely paid identically; in CS,
where you put the dot is the whole game.

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

### 3. Tagging, not knockback

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
| Aim assist | on, applied client-side to your own look angles |
| Extras | centre crosshair, world markers, recoil kick |

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

It is a dot in the middle of the screen, and that got *simpler* rather than
harder when aim went 3D.

It used to be projected to the world position 16 units down the firing line,
specifically because shots travelled flat at chest height whatever the view was
doing — a reticle at screen centre would have been pointing at one thing while
the bullet went to another. `fire()` now builds the bullet from the same yaw and
pitch the camera looks down, so screen centre **is** the aim point by
construction, and the projection had nothing left to correct for. Deleted rather
than extended.

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
a small recoil kick replaces them. It reads as "I fired" better than the flash
did anyway.

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
- **Aim assist** — see above.
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
| `test:levels` | The pecking order: the XP asymmetry both ways, every rung unlocking something named and measurable in the sim, the top being reachable but not farmable, and the three death-spiral guards |
| `test:crop` | Grain: the crop empties, pecking refills progressively, the feeder heals only out of combat, and none of the anti-frustration rules can be regressed |
| `test:view` | Third-person framing, headless and instant: the shot line meets the camera ray, a target under the crosshair is hit dead centre, the boom retracts off walls, and the camera never escapes the arena |
| `test:tts` | The announcer, headless: the voice ranking (a neural voice beats a local one), a saved voice that has vanished falling back rather than going mute, voices arriving late, and every rule about what it refuses to say |
| `test:control` | **Knockback can never take the wheel** — see below — plus movement symmetry on every map and in every mode, and the vertical axis: jump arcs, the height ceiling, air control, and that nothing but your own jump can lift you |
| `test:combat` | Aim assist in both axes, **that hits land on the same tick as the shot**, headshots (including that the head line sits above eye height), tagging instead of knockback, the stacked fire-rate floor, and shooting in 3D — over a target, onto a jumping one, down out of a jump, into the floor, over a wall |
| `test:controls` | Desktop: camera at eye level and on the player, own body hidden, facing-relative movement, mouse look in both axes, `Space` jumps and `F` fires, the centre crosshair, the 1P/3P toggle, the sensitivity slider, world markers and the spectator orbit |
| `test:fps-touch` | First person on an emulated phone: swipe-to-look **proportionality**, pitch and its clamp, FIRE and JUMP, jumping and firing and looking with three thumbs at once, and dragging both buttons to new homes |
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
  concave map. Tuned by measurement rather than feel: four bots average ~13
  kills over a 240-second match at 14–18% accuracy, dry about a quarter of the
  time. The first pass at "make them dumber" landed at 1–4 kills, which is not
  dumb, it is absent — dumb has to mean *bad decisions*, not *cannot shoot*.
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
