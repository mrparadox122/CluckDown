// The persistent track.
//
// This is the retention feature, so most of what is checked here is not "does
// the number go up". It is the set of properties that make a persistent track
// work at all, and every one of them is a way the feature fails silently:
//
//   * the bar is NEVER empty and NEVER full — no cap, and no level that sits
//     at 100% forever. A finished track is a track nobody opens again.
//   * the worst match in the game still pays. A player who went 0-12 has to
//     leave with something, because they are the population this exists for.
//   * nothing in it touches a stat. Cosmetic or lateral, without exception —
//     a persistent track that made you stronger would mean yesterday's player
//     beats today's on arithmetic.
//   * there is ALWAYS a named next thing, until the very last one.
//
// The last is the one worth guarding hardest: "312 XP to level 9" is a number,
// and "Yard Boss at level 16" is a reason to queue.
//
//   node shared/test/progress.mjs

import {
  PROGRESS, ROLE_LIST, ROLES,
  emptyCareer, levelNeed, accountLevel, masteryTier, matchXp,
  newMilestones, milestonesUpTo, shownCrest, shownTitle, nextMilestone,
} from '@cluckdown/shared';

const failures = [];
const check = (l, c, d = '') => {
  console.log(`${c ? '  ok  ' : ' FAIL '} ${l}${d ? ` — ${d}` : ''}`);
  if (!c) failures.push(l);
};

// A typical match, for scale. Numbers taken off a real four-minute casual:
// mid-table finish, five kills, a bit over a thousand damage, one contract.
const TYPICAL = { place: 4, kills: 5, deaths: 6, damage: 1150, healed: 0 };
const BAD = { place: 8, kills: 0, deaths: 12, damage: 180, healed: 0 };
const GREAT = { place: 1, kills: 14, deaths: 3, damage: 3200, healed: 0 };
const MEDIC = { place: 6, kills: 2, deaths: 5, damage: 420, healed: 1900 };

console.log('--- what a match pays ---');
{
  const typical = matchXp(TYPICAL, { won: false, contracts: 1 });
  const bad = matchXp(BAD, { won: false, contracts: 0 });
  const great = matchXp(GREAT, { won: true, contracts: 3 });
  const medic = matchXp(MEDIC, { won: true, contracts: 1 });

  for (const [name, r] of [['bad', bad], ['typical', typical], ['medic', medic], ['great', great]]) {
    console.log(`  ${name.padEnd(8)} ${String(r.total).padStart(4)} XP   ${r.lines.map((l) => `${l.label} +${l.xp}`).join(' / ')}`);
  }

  check('the worst match in the game still pays', bad.total >= PROGRESS.xp.match,
    `${bad.total} XP for 0 kills and 12 deaths`);
  check('a good match pays more than a bad one', great.total > typical.total * 2,
    `${great.total} vs ${typical.total}`);
  check('a Medic that healed and barely killed is paid like a player',
    medic.total > typical.total, `${medic.total} vs ${typical.total} on 2 kills`);
  check('playing is the single biggest guaranteed line',
    PROGRESS.xp.match >= PROGRESS.xp.kill * 4,
    `${PROGRESS.xp.match} for turning up vs ${PROGRESS.xp.kill} a kill`);
  check('every line is itemised, never a lump', typical.lines.length >= 3,
    `${typical.lines.length} lines`);
  check('the total is the lines', typical.total === typical.lines.reduce((a, l) => a + l.xp, 0));
}

console.log('\n--- the curve ---');
{
  // How many typical matches to each level. This is the whole tuning question:
  // early levels have to land inside a session or nobody finds out the track
  // exists, and late ones must not ask for a week.
  const per = matchXp(TYPICAL, { won: false, contracts: 1 }).total;
  let xp = 0;
  const at = [];
  for (let m = 1; m <= 120; m++) {
    xp += per;
    at.push(accountLevel(xp).level);
  }
  const firstAt = (lvl) => at.indexOf(lvl) + 1;
  console.log(`  a typical match is ${per} XP`);
  for (const lvl of [2, 3, 5, 10, 16, 20, 30]) {
    console.log(`    level ${String(lvl).padStart(2)} at match ${firstAt(lvl) || '>120'}`);
  }

  check('level 2 lands inside the first session', firstAt(2) > 0 && firstAt(2) <= 3,
    `match ${firstAt(2)}`);
  check('the first COSMETIC lands inside a few matches', firstAt(3) > 0 && firstAt(3) <= 6,
    `crest at match ${firstAt(3)}`);
  check('the curve never asks for more than the cap',
    levelNeed(999) === PROGRESS.level.cap, `${levelNeed(999)} XP at level 999`);
  check('...and the cap is reachable in a sitting',
    PROGRESS.level.cap <= per * 5, `${PROGRESS.level.cap} XP is ~${Math.ceil(PROGRESS.level.cap / per)} matches`);

  // The bar is never full. Every level, at every point, has somewhere to go.
  let worst = 0;
  for (let n = 0; n < 400; n++) {
    const a = accountLevel(n * 137);
    worst = Math.max(worst, a.pct);
    if (a.pct >= 1) break;
  }
  check('the bar is never full — there is no cap to sit at', worst < 1,
    `peak fill ${(worst * 100).toFixed(2)}%`);
  check('a brand new career starts at level 1, not level 0',
    accountLevel(0).level === 1 && accountLevel(0).into === 0);
  check('XP exactly on a boundary levels up',
    accountLevel(levelNeed(1)).level === 2 && accountLevel(levelNeed(1)).into === 0);
  check('a corrupt total does not produce NaN',
    accountLevel(undefined).level === 1 && accountLevel(-5).level === 1
    && Number.isFinite(accountLevel(NaN).pct));
}

console.log('\n--- role mastery ---');
{
  const blank = emptyCareer();
  check('a blank career has a bar for every role',
    ROLE_LIST.every((id) => blank.roleXp[id] === 0), ROLE_LIST.join(', '));

  const t1 = masteryTier(0);
  const top = masteryTier(PROGRESS.mastery.tiers.at(-1) + 9999);
  check('an untouched role reads as tier 1 with somewhere to go',
    t1.tier === 1 && t1.need > 0, `${t1.name} 0/${t1.need}`);
  check('a mastered role reports itself mastered', top.max && top.pct === 1, top.name);
  check('every tier has a name', PROGRESS.mastery.tiers.length === PROGRESS.mastery.names.length);
  check('the tiers rise', PROGRESS.mastery.tiers.every((v, i, a) => i === 0 || v > a[i - 1]));

  // The rotation feeds it, so a role's bar has to move on time served rather
  // than only on kills — a Medic that never fires still mastered a Medic.
  const aliveSeconds = 150; // roughly half a four-minute match on your feet
  const passive = aliveSeconds * PROGRESS.mastery.perSecond;
  console.log(`  ${aliveSeconds}s alive in a role is ${passive} mastery XP with no kills at all`);
  check('time served alone reaches tier 2 in a couple of matches',
    passive * 2 >= PROGRESS.mastery.tiers[1],
    `${passive * 2} vs ${PROGRESS.mastery.tiers[1]}`);
  check('...but the top tier is a real commitment',
    PROGRESS.mastery.tiers.at(-1) > passive * 8,
    `${PROGRESS.mastery.tiers.at(-1)} XP`);

  const t3 = masteryTier(PROGRESS.mastery.tiers[2]);
  check('a tier boundary reads as the new tier, not the old one', t3.tier === 3, t3.name);
}

console.log('\n--- milestones ---');
{
  check('the milestone list is sorted by level',
    PROGRESS.milestones.every((m, i, a) => i === 0 || m.level > a[i - 1].level));
  check('every crest has a glyph to draw',
    PROGRESS.milestones.filter((m) => m.kind === 'crest').every((m) => !!m.glyph));
  check('every milestone has a name to announce',
    PROGRESS.milestones.every((m) => !!m.name && !!m.id));

  // COSMETIC OR LATERAL. The only two kinds there are, and neither is a stat.
  const kinds = new Set(PROGRESS.milestones.map((m) => m.kind));
  check('nothing but crests and titles is ever handed out',
    [...kinds].every((k) => k === 'crest' || k === 'title'), [...kinds].join(', '));
  const statKeys = ['hp', 'damageMul', 'speedMul', 'fireCooldownMul', 'spreadMul', 'falloff', 'perk'];
  check('no milestone carries anything the simulation would read',
    PROGRESS.milestones.every((m) => statKeys.every((k) => m[k] === undefined)),
    statKeys.join('/'));
  // ...and nothing in here can accidentally name a role tier, which is the one
  // table in the game that DOES change stats.
  const roleKeys = new Set(Object.values(ROLES).flatMap((r) => r.tiers.map((t) => t.perk)));
  check('no milestone reuses a role perk name',
    PROGRESS.milestones.every((m) => !roleKeys.has(m.name)));

  // Always something named next, and a multi-level jump loses nothing.
  let missing = 0;
  const last = PROGRESS.milestones.at(-1).level;
  for (let lvl = 1; lvl < last; lvl++) if (!nextMilestone(lvl)) missing++;
  check('there is always a named next thing until the last one', missing === 0,
    `${last} levels of runway`);

  const jumped = newMilestones(1, 5);
  console.log(`  levelling 1 -> 5 in one match hands over: ${jumped.map((m) => m.name).join(', ')}`);
  check('a two-level jump does not silently eat a milestone', jumped.length >= 2);
  check('nothing is handed over twice', newMilestones(5, 5).length === 0);

  check('the crest shown is the newest earned',
    shownCrest(999)?.id === PROGRESS.milestones.filter((m) => m.kind === 'crest').at(-1).id);
  check('the title shown is the newest earned',
    shownTitle(999)?.id === PROGRESS.milestones.filter((m) => m.kind === 'title').at(-1).id);
  check('a level 1 chicken has neither', !shownCrest(1) && !shownTitle(1));
  check('everything earned stays earned',
    milestonesUpTo(999).length === PROGRESS.milestones.length);
}

console.log(failures.length ? `\nX ${failures.length} check(s) failed\n` : '\nAll checks passed\n');
process.exit(failures.length ? 1 : 0);
