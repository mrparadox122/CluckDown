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
| Casual | 4 | FFA, 4 min, bots fill empty slots |
| Ranked | 4 | FFA, 4 min, Elo on the line, humans only |
| Deathmatch | 4 | First to 15 kills or 5 min |
| 1v1 | 2 | Smaller arena, first to 10, bomber shows up rarely |

Rating is placement-based Elo: finishing above someone counts as beating them,
scaled so a 4-player match moves your rating about as much as one duel would.
It lives in `localStorage` and is sent to the server on join.

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

The server and client both have end-to-end tests that drive the real thing.

```bash
# Server tests — need `npm run dev:server` running:
npm run smoke                               # 15 assertions over the live socket
npm run test:seats -w @cluckdown/server     # seat allocation + bot eviction

# Browser tests (Playwright + Chromium) — need `npm run dev` running:
npm install -D playwright && npx playwright install chromium
npm run test:ui -w @cluckdown/client         # menu → match → HUD, screenshots
npm run test:results -w @cluckdown/client    # forces a match to end, checks podium
npm run test:nameplates -w @cluckdown/client # measures HUD-to-mesh alignment in px
npm run test:touch -w @cluckdown/client      # emulates a phone, drags both sticks
```

`test:touch` is not optional cover. The other browser tests drive WASD + mouse,
which never touches nipplejs — a change in its listener signature once broke
both joysticks completely while every other test stayed green.

`PLAY_MODE=online npm run test:ui -w @cluckdown/client` runs the browser test
against the real server instead of offline practice.

In dev builds, `window.__cluckdown` exposes the live session — e.g.
`__cluckdown.session.world.clock = 2` to jump to the results screen.

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

- Rating is client-supplied (`localStorage`), so it's trivially forgeable. Fine
  for a hobby game; it needs a real identity store to mean anything.
- Under a very slow renderer the offline practice sim runs slower than real time,
  because per-frame delta is clamped. That's the right trade (better than
  fast-forwarding the match), and online play is unaffected — the server owns the clock.
- Bots are good at killing the bomber. In a 4-bot match it usually gets shot down
  before it detonates; `BOMBER.maxHp` is the knob if you want it scarier.
