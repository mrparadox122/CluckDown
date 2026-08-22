// The career. What survives when the match ends and the tab closes.
//
// *** THIS IS THE RETENTION GAP, WRITTEN DOWN. ***
//
// Everything Cluckdown rewards you with used to die at the whistle. The pecking
// order resets every match by design — it is a four-minute arc and it should —
// and `rating` sits invisibly in localStorage where nobody has ever looked at
// it. So the state of a player who has just finished a match is: nothing they
// did still exists, and nothing is waiting for them. That is the whole distance
// between this and CoD Mobile, whose retention is almost entirely a bar that
// was not full when you put the phone down.
//
// So: three tracks, and each answers a different question.
//
//   ROOST LEVEL     "am I getting anywhere?"   One number, never falls, no cap.
//   ROLE MASTERY    "was that worth playing?"  Six bars instead of one.
//   MILESTONES      "what is next?"            A named thing at a known level.
//
// COSMETIC OR LATERAL, WITHOUT EXCEPTION. Nothing in this file touches a stat,
// and nothing in it is reachable from the simulation — a milestone hands out a
// crest or a title and that is the entire list of what it can give. A
// persistent track that made you stronger would mean the player who queued
// yesterday beats the player who queued today on arithmetic, which is how a
// competitive game with no accounts loses the argument for having no accounts.
//
// ROLE MASTERY IS WHAT MAKES ROTATION A REWARD. Roles rotate every round now
// (see ROTATION), and a forced swap is a tax if the only thing you were
// building was inside the role you just lost. Six bars turns the same swap into
// the other thing: the round you spend as a Medic is the only round that moves
// the Medic bar, and the player who never picked one has five bars at zero
// staring at them. Variety stops being something the game does to you.
//
// Dependency-free like the rest of shared/, and PURE — no storage, no dates, no
// randomness. It is a tuning table with a scorer under it; client/src/profile.js
// owns the localStorage half. That split is what makes the curve testable.

import { ROLE_LIST } from './roles.js';
import { clamp } from './math.js';

export const PROGRESS = {
  /**
   * What a match is worth.
   *
   * PLAYING is the biggest single line, and that is deliberate. A track that
   * paid out on kills alone would pay the player who least needs encouraging
   * and stiff the one who just went 2-11, and the 2-11 player is the entire
   * population this feature exists for. Finishing a match is the behaviour
   * being reinforced; doing well in one is a bonus on top.
   */
  xp: {
    match: 120,
    kill: 25,
    per100Damage: 8,
    /** Healing pays like damage, or the Medic's whole match is worth nothing. */
    per100Heal: 8,
    contract: 45,
    win: 160,
    /** Second and third still get something. Only the tail gets nothing. */
    podium: [0, 60, 30],
  },

  /**
   * The Roost Level curve.
   *
   * NO CAP, and the reason is the one sentence this whole file is built on:
   * the bar must never be empty when they close the app. A cap is a bar that
   * is permanently full, which is the same failure with better framing.
   *
   * `need(n) = base + (n - 1) * step`, flattened at `cap`. A decent match is
   * roughly 350-550 XP, so the first few levels land about one a match, the
   * middle settles near three, and it never goes past `cap` — a curve that
   * keeps steepening eventually asks for a week per level, and a reward that
   * far away is not a reward.
   */
  level: { base: 320, step: 85, cap: 1400 },

  /**
   * Role mastery: five tiers, per role, cumulative XP thresholds.
   *
   * Deliberately reachable. Six roles times five tiers is thirty things to
   * finish, and thirty milestones nobody ever reaches is worse than five they
   * do — the point of the second track is that there is always one bar close
   * to filling, whichever role the rotation just handed you.
   */
  mastery: {
    tiers: [0, 250, 800, 1800, 3600],
    names: ['Rookie', 'Regular', 'Veteran', 'Elite', 'Legend'],
    /** The tier a role has to reach to unlock its crest. */
    crestAt: 4,

    /**
     * How role XP is earned, and why TIME is the biggest line.
     *
     * Mastery is a measure of having played the thing, not of having been good
     * at it — the account track already pays for kills, and paying twice would
     * make the Sniper the only bar anyone ever fills. A Medic that spends four
     * minutes healing and finishes on one kill has mastered a Medic, and this
     * is the only track in the game that can say so.
     *
     * Seconds ALIVE, not seconds in the match: standing on a respawn screen is
     * not practice, and counting it would pay the player who dies most.
     */
    perSecond: 1.5,
    perKill: 25,
    perContract: 40,
  },

  /**
   * Milestones, by Roost Level. Cosmetic, both kinds.
   *
   * `crest` is a glyph shown beside your name on the menu and the results
   * table; `title` is a line under it. Front-loaded on purpose — the first one
   * lands inside two matches, because a track whose first reward is an hour
   * away is a track nobody finds out is there.
   */
  milestones: [
    { level: 2, kind: 'title', id: 'fledgling', name: 'Fledgling' },
    { level: 3, kind: 'crest', id: 'spark', name: 'Spark', glyph: '✦' },
    { level: 5, kind: 'title', id: 'regular', name: 'Coop Regular' },
    { level: 7, kind: 'crest', id: 'shard', name: 'Shard', glyph: '❖' },
    { level: 10, kind: 'title', id: 'scrapper', name: 'Yard Scrapper' },
    { level: 13, kind: 'crest', id: 'bloom', name: 'Bloom', glyph: '✵' },
    { level: 16, kind: 'title', id: 'boss', name: 'Yard Boss' },
    { level: 20, kind: 'crest', id: 'skull', name: 'Bonepecker', glyph: '☠' },
    { level: 25, kind: 'title', id: 'apex', name: 'Apex Poultry' },
    { level: 30, kind: 'crest', id: 'crown', name: 'Crown', glyph: '♛' },
    { level: 40, kind: 'title', id: 'immortal', name: 'The Undying Cluck' },
  ],
};

/** A blank career. The shape everything else in here reads. */
export const emptyCareer = () => ({
  xp: 0,
  roleXp: Object.fromEntries(ROLE_LIST.map((id) => [id, 0])),
});

/** XP to get from `level` to the next one. Flat once it reaches the cap. */
export function levelNeed(level) {
  const { base, step, cap } = PROGRESS.level;
  return Math.min(cap, base + (Math.max(1, level | 0) - 1) * step);
}

/**
 * Total XP -> where the bar sits.
 *
 * Walked rather than solved, because the curve flattens at `cap` and a closed
 * form for a piecewise curve is a thing that goes quietly wrong the first time
 * anybody moves `step`. It is a few dozen iterations at any realistic total.
 */
export function accountLevel(totalXp) {
  let level = 1;
  let left = Math.max(0, Math.floor(totalXp || 0));
  let need = levelNeed(level);
  while (left >= need) {
    left -= need;
    level++;
    need = levelNeed(level);
  }
  return { level, into: left, need, pct: clamp(left / need, 0, 1) };
}

/** Role XP -> which mastery tier, and how far into the next. */
export function masteryTier(roleXp) {
  const { tiers, names } = PROGRESS.mastery;
  const xp = Math.max(0, Math.floor(roleXp || 0));
  let tier = 1;
  for (let i = 0; i < tiers.length; i++) if (xp >= tiers[i]) tier = i + 1;
  const at = tiers[tier - 1];
  const next = tiers[tier] ?? null;
  return {
    tier,
    name: names[tier - 1],
    max: tier >= tiers.length,
    into: xp - at,
    need: next === null ? 0 : next - at,
    pct: next === null ? 1 : clamp((xp - at) / (next - at), 0, 1),
  };
}

/**
 * What a finished match is worth, itemised.
 *
 * ITEMISED, not totalled, and that is the point of returning lines at all. "+412
 * XP" is a number; "MATCH 120 / 6 KILLS 150 / WON 160" is a sentence about what
 * they did, and the second one is what makes the next match's plan feel like
 * theirs. It also quietly teaches the scoring — a Medic reading a HEALING line
 * learns that the track can see them.
 *
 * @param row the player's own row from the match ranking
 */
export function matchXp(row, { won = false, contracts = 0 } = {}) {
  const x = PROGRESS.xp;
  const lines = [{ label: 'Match played', xp: x.match }];

  const kills = Math.max(0, row?.kills ?? 0);
  if (kills) lines.push({ label: `${kills} kill${kills === 1 ? '' : 's'}`, xp: kills * x.kill });

  const dmg = Math.floor(Math.max(0, row?.damage ?? 0) / 100) * x.per100Damage;
  if (dmg) lines.push({ label: 'Damage dealt', xp: dmg });

  const heal = Math.floor(Math.max(0, row?.healed ?? 0) / 100) * x.per100Heal;
  if (heal) lines.push({ label: 'Roost healed', xp: heal });

  const done = Math.max(0, contracts | 0);
  if (done) lines.push({ label: `${done} contract${done === 1 ? '' : 's'}`, xp: done * x.contract });

  if (won) lines.push({ label: 'Victory', xp: x.win });
  const place = row?.place ?? 0;
  const podium = x.podium[place - 1] ?? 0;
  if (podium) lines.push({ label: `#${place} finish`, xp: podium });

  return { lines, total: lines.reduce((a, l) => a + l.xp, 0) };
}

/**
 * Milestones crossed by going from one level to another.
 *
 * A RANGE, never a lookup. A single match can carry someone two levels, and a
 * banner that only ever announced the level they landed on would silently eat
 * the reward in between — which is the one moment the whole track exists to
 * produce.
 */
export function newMilestones(fromLevel, toLevel) {
  return PROGRESS.milestones.filter((m) => m.level > fromLevel && m.level <= toLevel);
}

/** Everything a level has earned so far. */
export const milestonesUpTo = (level) => PROGRESS.milestones.filter((m) => m.level <= level);

/**
 * The crest and title on show.
 *
 * Highest wins, and nothing is selectable. A cosmetic locker is a screen, and
 * a screen is a thing to build, maintain and explain for a reward that already
 * works as a trophy shelf — the newest one is the one worth wearing.
 */
export function shownCrest(level) {
  const earned = milestonesUpTo(level).filter((m) => m.kind === 'crest');
  return earned.length ? earned[earned.length - 1] : null;
}

export function shownTitle(level) {
  const earned = milestonesUpTo(level).filter((m) => m.kind === 'title');
  return earned.length ? earned[earned.length - 1] : null;
}

/** The next thing to chase, whatever it is. Never null below the last one. */
export const nextMilestone = (level) => PROGRESS.milestones.find((m) => m.level > level) ?? null;
