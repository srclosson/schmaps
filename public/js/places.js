/**
 * Schmaps — Canadian place gazetteer + fuzzy "did you mean" matcher.
 *
 * Loads a compact GeoNames-derived list of ~2,800 Canadian populated
 * places and finds near-matches for mis-heard voice input using a
 * phonetic key (Soundex-style, tuned for place names) combined with
 * Damerau–Levenshtein edit distance.
 *
 * Example: "pearl ontario" → suggests "Perth, Ontario" (and Mount Pearl).
 */

let placesPromise = null;

/** Fetch + cache the gazetteer. */
export function loadPlaces() {
  if (!placesPromise) {
    placesPromise = fetch('data/ca-places.json')
      .then((res) => (res.ok ? res.json() : []))
      .catch(() => []);
  }
  return placesPromise;
}

/** Lowercase, strip accents and punctuation. */
export function normalizeName(str) {
  return str
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Phonetic key for English place names (Soundex-flavoured).
 * Keeps the first letter, maps consonants to digits, drops vowels,
 * collapses repeats. "pearl"→P640, "perth"→P630 (distance 1).
 */
export function phoneticKey(word) {
  const w = normalizeName(word).replace(/[^a-z]/g, '');
  if (!w) return '';
  const map = {
    b: 1, f: 1, p: 1, v: 1,
    c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2,
    d: 3, t: 3,
    l: 4,
    m: 5, n: 5,
    r: 6,
  };
  const first = w[0].toUpperCase();
  let prev = map[w[0]] || 0;
  let out = '';
  for (let i = 1; i < w.length; i++) {
    const code = map[w[i]] || 0;
    if (code && code !== prev) out += String(code);
    if (code) prev = code;
    else if (w[i] === 'h' || w[i] === 'w') {
      /* h/w don't reset the repeat chain */
    } else {
      prev = 0;
    }
  }
  return (first + out + '000').slice(0, 4);
}

/** Damerau–Levenshtein distance (with transpositions). */
export function editDistance(a, b) {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  const d = [];
  for (let i = 0; i <= al; i++) d[i] = [i];
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }
  return d[al][bl];
}

/** Words that are geography, not part of the place name. */
const STOP_WORDS = new Set([
  'ontario', 'quebec', 'québec', 'alberta', 'manitoba', 'saskatchewan',
  'british', 'columbia', 'nova', 'scotia', 'newfoundland', 'labrador',
  'prince', 'edward', 'island', 'northwest', 'territories', 'nunavut',
  'yukon', 'canada', 'province', 'territory', 'county', 'regional',
  'municipality', 'city', 'town', 'village', 'township', 'municipal',
  'district', 'region', 'of', 'the', 'in', 'near', 'to', 'at', 'on',
]);

/**
 * Extract candidate place-name tokens from a spoken query.
 * "pearl ontario" → ["pearl"]; "north perth ontario" → ["north","perth"].
 */
function nameTokens(query) {
  return normalizeName(query)
    .split(' ')
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

/**
 * Cost of matching one query token against one place token.
 *
 * Voice mis-hearings preserve sound, not spelling — "Perth" heard as
 * "pearl" is edit-distance 3 but phonetically adjacent (P630 vs P640).
 * So phonetic similarity is the primary signal; spelling distance is a
 * secondary ranker. Returns Infinity for unrelated tokens.
 */
function tokenCost(qt, pt) {
  if (qt === pt) return 0;
  const dist = editDistance(qt, pt);
  const phonDist = editDistance(phoneticKey(qt), phoneticKey(pt));

  // Same sound, any spelling → strong candidate.
  if (phonDist === 0) return 0.2 + dist * 0.1;
  // Adjacent sound (one phonetic digit off) and not too far in spelling.
  if (phonDist === 1 && dist <= 3) return 1.0 + dist * 0.3;
  // Close spelling even if the sound differs (typos).
  if (dist <= 1) return 1.5;
  if (dist === 2) return 2.5;
  // Otherwise unrelated.
  return Infinity;
}

/**
 * Score a place against the query tokens.
 * Every query token must match at least one place token reasonably
 * well; the place's extra tokens add a small penalty so "Perth" beats
 * "Perth-Andover" for the query "perth".
 */
function scorePlace(placeTokens, queryTokens) {
  let total = 0;
  for (const qt of queryTokens) {
    let best = Infinity;
    for (const pt of placeTokens) {
      const c = tokenCost(qt, pt);
      if (c < best) best = c;
    }
    if (best === Infinity) return Infinity;
    total += best;
  }
  // Penalise unmatched place tokens a little (specificity).
  const extra = Math.max(0, placeTokens.length - queryTokens.length);
  return total + extra * 0.5;
}

/**
 * Find the closest Canadian places to a (possibly mis-heard) query.
 *
 * @param {string} query  e.g. "pearl ontario"
 * @param {{ limit?: number }} opts
 * @returns {Promise<Array<{name:string, province:string, lat:number, lon:number, population:number, score:number}>>}
 */
export async function suggestPlaces(query, { limit = 5 } = {}) {
  const places = await loadPlaces();
  const tokens = nameTokens(query);
  if (!tokens.length || !places.length) return [];

  // With the phonetic-primary cost above, a good match scores ~0–2 per
  // token. Allow a little slack for multi-word queries.
  const threshold = 2.0 * tokens.length + 0.5;

  const scored = [];
  for (const p of places) {
    const placeTokens = normalizeName(p.n).split(' ');
    const raw = scorePlace(placeTokens, tokens);
    if (raw === Infinity || raw > threshold) continue;
    // Normalise by token count so multi-word queries compare fairly.
    const score = raw / tokens.length;
    scored.push({
      name: p.n,
      province: p.p,
      lat: p.la,
      lon: p.lo,
      population: p.pop,
      score,
    });
  }

  // Sort by match quality, then population as a tie-breaker.
  scored.sort((a, b) => a.score - b.score || b.population - a.population);

  // De-duplicate identical names in the same province.
  const seen = new Set();
  const out = [];
  for (const s of scored) {
    const key = `${s.name}|${s.province}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}
