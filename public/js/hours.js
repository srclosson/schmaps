/**
 * Schmaps opening-hours evaluator — the pragmatic subset of OSM's
 * `opening_hours` grammar that real-world values actually use.
 *
 * Supported: "24/7"; day lists and ranges ("Mo-Fr", "Mo,We,Fr",
 * "Sa-Su" — circular ranges included); multiple time ranges
 * ("08:00-12:00,13:00-17:00"); overnight ranges ("20:00-02:00");
 * per-rule "off"/"closed"; rules separated by ";". Everything more
 * exotic (sunrise/sunset, public holidays "PH", seasonal rules) is
 * skipped rather than misparsed — an honest "unknown" beats a wrong
 * "open".
 *
 * openingStatus(spec, now) classifies a place RIGHT NOW:
 *   open          inside a range, more than CLOSING_SOON_MIN from its end
 *   closing-soon  inside a range that ends within the hour (the warning)
 *   opens-later   closed now, but a range starts later today
 *   closed-today  rules exist for today but none apply now or later
 *                 (including an explicit "off" rule — it wins, matching
 *                 OSM's "later rule overrides" convention)
 *   unknown       no parseable rule for today — neutral grey pin
 */

const DAY_IDX = { su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 };
const DAY_TOKEN = '(?:mo|tu|we|th|fr|sa|su)';
const DAY_LIST_RE = new RegExp(`^${DAY_TOKEN}(?:[\\s,-]+${DAY_TOKEN})*$`, 'i');
const DAY_RANGE_RE = new RegExp(`^(${DAY_TOKEN})-(${DAY_TOKEN})$`, 'i');
const TIME_RANGE_RE = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;
// Rules that are outside the subset (holidays, seasons, school weeks).
const EXOTIC_RE =
  /\b(?:ph|sh|easter|christmas|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|week\s?\d+|school)\b/;

/** How close to closing time still counts as "closing soon". */
export const CLOSING_SOON_MIN = 60;

/** A gap up to this long between windows is a break (lunch), not a
 *  closing — the place reopens right after, so no warning fires. */
const REOPEN_GAP_MAX_MIN = 180;

/** Expand "mo-fr", "mo,we", "sa-mo" (wraps the week) into a day set. */
function parseDayToken(tok) {
  const days = new Set();
  for (const part of tok.split(/[,\s]+/)) {
    if (!part) continue;
    const range = part.match(DAY_RANGE_RE);
    if (range) {
      let d = DAY_IDX[range[1].toLowerCase()];
      const end = DAY_IDX[range[2].toLowerCase()];
      do {
        days.add(d);
        d = (d + 1) % 7;
      } while (d !== (end + 1) % 7 && days.size < 7);
      continue;
    }
    const single = DAY_IDX[part.toLowerCase()];
    if (single !== undefined) days.add(single);
  }
  return days;
}

/**
 * Evaluate an `opening_hours` value at `now`.
 *
 * @param {string|null} spec the OSM opening_hours tag
 * @param {Date} [now]
 * @returns {{state:'open'|'closing-soon'|'opens-later'|'closed-today'|'unknown',
 *            closesAtMin?:number, opensAtMin?:number, allDay?:boolean}}
 *   minute-of-day values (0..1440+, overnight ends may exceed 1440)
 */
export function openingStatus(spec, now = new Date()) {
  if (typeof spec !== 'string' || !spec.trim()) return { state: 'unknown' };
  const s = spec.trim().toLowerCase();

  // The exact simple forms we can trust outright.
  if (s === '24/7' || s === '24/7; ph off' || s === '24/7;ph off') {
    return { state: 'open', allDay: true, closesAtMin: 1440 };
  }

  const today = now.getDay();
  const yesterday = (today + 6) % 7;
  const nowMin = now.getHours() * 60 + now.getMinutes();

  let sawRuleForToday = false;
  let offToday = false;
  const intervals = []; // today's windows { start, end } minutes, end ≤ 1440
  const carryover = []; // overnight tails from YESTERDAY: [0, end-1440)

  for (const rawRule of s.split(';')) {
    const rule = rawRule.trim();
    if (!rule || EXOTIC_RE.test(rule)) continue;

    if (rule === '24/7' || rule === '24/7 open') {
      sawRuleForToday = true;
      intervals.push({ start: 0, end: 1440 });
      continue;
    }

    // Leading day selector, if any: "mo-fr 08:00-17:00", "sa 09:00-13:00".
    const tokens = rule.split(/\s+/);
    let i = 0;
    let days = null; // null → applies every day
    while (i < tokens.length && DAY_LIST_RE.test(tokens[i])) {
      days = new Set([...(days ?? []), ...parseDayToken(tokens[i])]);
      i++;
    }
    const appliesToday = !days || days.has(today);
    const appliesYesterday = !days || days.has(yesterday);
    if (!appliesToday && !appliesYesterday) continue;
    const timePart = tokens.slice(i).join(' ').trim();
    if (!timePart) continue; // day names with no times teach us nothing

    if (timePart === 'off' || timePart === 'closed') {
      if (appliesToday) {
        sawRuleForToday = true;
        offToday = true; // an "off" rule for today wins over earlier hours
      }
      continue;
    }

    let anyToday = false;
    let pushedCarryover = false;
    for (const piece of timePart.split(',')) {
      const m = piece.trim().match(TIME_RANGE_RE);
      if (!m) continue; // exotic piece (sunrise…) — keep the parseable ones
      const start = Number(m[1]) * 60 + Number(m[2]);
      let end = Number(m[3]) * 60 + Number(m[4]);
      if (end <= start) end += 1440; // overnight range
      if (appliesToday) {
        // Kept unclamped: a window that runs past midnight keeps its
        // true end, so "closing soon" is measured against the real
        // close (02:00), not against midnight.
        intervals.push({ start, end });
        anyToday = true;
      }
      // A range that started YESTERDAY and runs past midnight lends its
      // early-morning tail to today — the only honest way "sa-su
      // 20:00-02:00" is open at 01:00 on Monday.
      if (appliesYesterday && end > 1440) {
        carryover.push({ start: 0, end: end - 1440 });
        pushedCarryover = true;
      }
    }
    if (anyToday || pushedCarryover) sawRuleForToday = true;
  }

  // An explicit "off" rule for today overrides everything else.
  if (offToday) return { state: 'closed-today' };

  // Open now? Today's windows (pre-midnight part) and yesterday's
  // overnight tail both count; a matched window keeps its TRUE end.
  let openEnd = null;
  for (const iv of carryover) {
    if (nowMin < iv.end && openEnd === null) openEnd = iv.end;
  }
  for (const iv of intervals) {
    if (nowMin >= iv.start && nowMin < Math.min(iv.end, 1440)) {
      openEnd = Math.max(openEnd ?? 0, iv.end);
    }
  }
  if (openEnd !== null) {
    // "Closing soon" only when this window really is the last of the
    // day: a lunch break isn't closing (the place reopens within the
    // gap), and an overnight window closes at 02:00, not midnight.
    const nextStarts = intervals
      .filter((iv) => iv.start > nowMin)
      .map((iv) => iv.start)
      .sort((a, b) => a - b);
    const reopensSoon =
      nextStarts.length > 0 && nextStarts[0] - openEnd <= REOPEN_GAP_MAX_MIN;
    if (!reopensSoon && openEnd - nowMin <= CLOSING_SOON_MIN) {
      return { state: 'closing-soon', closesAtMin: openEnd };
    }
    return { state: 'open', closesAtMin: openEnd };
  }

  // Closed now — does anything open later today?
  let nextStart = null;
  for (const iv of intervals) {
    if (iv.start > nowMin && (nextStart === null || iv.start < nextStart)) nextStart = iv.start;
  }
  if (nextStart !== null) return { state: 'opens-later', opensAtMin: nextStart };

  return sawRuleForToday ? { state: 'closed-today' } : { state: 'unknown' };
}
