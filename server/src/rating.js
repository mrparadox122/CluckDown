// Free-for-all Elo: treat the final table as a round-robin where finishing
// above someone counts as beating them. Each pairwise result is a normal Elo
// exchange, scaled by 1/(n-1) so a 4-player match moves ratings about as much
// as a single 1v1 would.

const K = 32;

export function ratingDeltas(ranking, getRating) {
  const out = {};
  const n = ranking.length;
  if (n < 2) {
    for (const r of ranking) out[r.id] = 0;
    return out;
  }

  const scale = K / (n - 1);

  for (const a of ranking) {
    const ra = getRating(a.id);
    let delta = 0;

    for (const b of ranking) {
      if (a.id === b.id) continue;
      const rb = getRating(b.id);
      const expected = 1 / (1 + 10 ** ((rb - ra) / 400));
      // Same placement (a tie on score) scores half a point.
      const actual = a.place < b.place ? 1 : a.place > b.place ? 0 : 0.5;
      delta += scale * (actual - expected);
    }

    out[a.id] = Math.round(delta);
  }

  return out;
}

export function rankLabel(rating) {
  if (rating < 900) return 'Chick';
  if (rating < 1050) return 'Pullet';
  if (rating < 1200) return 'Hen';
  if (rating < 1400) return 'Rooster';
  if (rating < 1650) return 'Cluck Lord';
  return 'GOAT (Greatest Of All Traumatised)';
}
