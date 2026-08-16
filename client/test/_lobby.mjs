// Shared helper: get through the map-vote lobby and into the match.
//
// Every browser test used to click Play and be in the arena a moment later.
// Matches now open with a vote, so each test has to pass through it first —
// this votes immediately (which closes the lobby at its minimum duration rather
// than the full timeout) and waits for the renderer to exist.

export async function passLobby(page, { timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      inGame: !!window.__cluckdown?.game,
      lobbyUp: !document.getElementById('lobby')?.classList.contains('hidden'),
      voted: !!document.querySelector('.map-choice[aria-pressed="true"]'),
    }));

    if (state.inGame) return true;

    // Vote once, and only once — re-clicking would keep changing our pick.
    if (state.lobbyUp && !state.voted) {
      await page.evaluate(() => document.querySelector('.map-choice')?.click());
    }
    await page.waitForTimeout(250);
  }
  return false;
}

/** Clicks a start button and comes back once the match is actually running. */
export async function startMatch(page, selector, opts) {
  await page.click(selector);
  return passLobby(page, opts);
}
