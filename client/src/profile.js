// Everything about "who you are" lives in localStorage. No login, no account,
// no server-side identity — you type a name and you're playing.

const KEY = 'cluckdown.profile.v1';

const DEFAULTS = {
  name: '',
  rating: 1000,
  mode: 'casual',
  matches: 0,
  kills: 0,
  deaths: 0,
  wins: 0,
  bestStreak: 0,
};

export function loadProfile() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveProfile(profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(profile));
  } catch {
    // Private browsing or a full quota — the game still works, it just forgets.
  }
}

export function rankLabel(rating) {
  if (rating < 900) return 'Chick';
  if (rating < 1050) return 'Pullet';
  if (rating < 1200) return 'Hen';
  if (rating < 1400) return 'Rooster';
  if (rating < 1650) return 'Cluck Lord';
  return 'GOAT';
}

/** Folds a finished match into the stored career stats. */
export function applyResult(profile, { ranking, deltas, selfId, ranked }) {
  const me = ranking?.find((r) => r.id === selfId);
  if (!me) return profile;

  const next = { ...profile };
  next.matches += 1;
  next.kills += me.kills;
  next.deaths += me.deaths;
  if (me.place === 1) next.wins += 1;
  if (ranked && deltas && typeof deltas[selfId] === 'number') {
    next.rating = Math.max(0, next.rating + deltas[selfId]);
  }
  return next;
}
