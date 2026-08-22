// Everything about "who you are" lives in localStorage. No login, no account,
// no server-side identity — you type a name and you're playing.
//
// THE CAREER LIVES HERE TOO, and that is a deliberate choice rather than a
// shortcut. The persistent track (shared/src/progress.js) is cosmetic by rule,
// so there is nothing in it worth defending with a server — and putting it
// anywhere else would mean the game that needs no login suddenly needs one.
// The same trade the rating already makes: yours, on your device, and gone if
// you clear it.

import { emptyCareer, accountLevel, matchXp, ROLE_LIST } from '@cluckdown/shared';

const KEY = 'cluckdown.profile.v1';

const DEFAULTS = {
  name: '',
  rating: 1000,
  mode: 'casual',
  // Last role played. The picker defaults to it, which is what lets a player
  // respawn on time by doing nothing at all.
  role: 'runner',
  matches: 0,
  kills: 0,
  deaths: 0,
  wins: 0,
  bestStreak: 0,
  // The persistent track. One account XP total, one bar per role.
  career: null,
};

export function loadProfile() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return withCareer({ ...DEFAULTS, ...raw });
  } catch {
    return withCareer({ ...DEFAULTS });
  }
}

/**
 * Repairs a career read off disk.
 *
 * Every profile that already exists predates this file having one, and a role
 * added later would leave a hole in `roleXp` that renders as NaN in a progress
 * bar — the one class of bug that looks like a rendering fault and is really a
 * migration. Rebuilt from the live ROLE_LIST every load, which costs nothing
 * and cannot drift.
 */
function withCareer(profile) {
  const blank = emptyCareer();
  const saved = profile.career ?? {};
  const roleXp = { ...blank.roleXp };
  for (const id of ROLE_LIST) roleXp[id] = Math.max(0, Math.floor(Number(saved.roleXp?.[id]) || 0));
  return { ...profile, career: { xp: Math.max(0, Math.floor(Number(saved.xp) || 0)), roleXp } };
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

/**
 * Folds a finished match into the stored career stats AND the persistent track.
 *
 * Returns the earned XP alongside the new profile rather than only the profile:
 * the results screen has to show the bar moving FROM somewhere, and the level
 * it started on is gone the moment this returns.
 *
 * @param roleXp seconds-weighted XP per role played this match, from the
 *               client's own tally — roles rotate, so a single match can move
 *               three bars and "what role did you finish as" is not the
 *               question mastery is asking.
 */
export function applyResult(profile, {
  ranking, deltas, selfId, ranked, winnerTeam, contracts = 0, roleXp = {},
}) {
  const me = ranking?.find((r) => r.id === selfId);
  if (!me) return { profile, earned: null };

  const next = { ...profile };
  next.matches += 1;
  next.kills += me.kills;
  next.deaths += me.deaths;
  if (me.place === 1) next.wins += 1;
  if (ranked && deltas && typeof deltas[selfId] === 'number') {
    next.rating = Math.max(0, next.rating + deltas[selfId]);
  }

  // A win is the TEAM's result where there is one, and placement where there
  // is not. Paying the account track on placement in a 4v4 would tell a player
  // who topped the table on the losing side that they won.
  const won = winnerTeam === 0 || winnerTeam === 1
    ? me.team === winnerTeam
    : me.place === 1;

  const before = accountLevel(profile.career.xp);
  const earned = matchXp(me, { won, contracts });
  const career = {
    xp: profile.career.xp + earned.total,
    roleXp: { ...profile.career.roleXp },
  };
  for (const [role, xp] of Object.entries(roleXp)) {
    if (career.roleXp[role] === undefined || !(xp > 0)) continue;
    career.roleXp[role] += Math.round(xp);
  }
  next.career = career;

  return {
    profile: next,
    earned: { ...earned, won, before, after: accountLevel(career.xp), roleXp },
  };
}
