/**
 * Schmaps category vocabulary — "what I need" words → OSM tag selectors.
 *
 * One source of truth for browse mode: typing a bare category ("oil
 * change", "coffee", "gas") pins EVERY nearby match on the map, colored
 * by open / closing-soon / opens-later / closed-today (js/hours.js
 * classifies, Overpass supplies the opening_hours tags). The `search`
 * field is the phrase the Nominatim fallback understands when Overpass
 * can't be reached — same UI, "hours unknown" pins.
 *
 * The words mirror errands.js's TASK_WORDS so every mode speaks the
 * same language:
 *   • bare category        → browse (this module)
 *   • "errands: …" multi   → planning (errands.js)
 *   • "take me to coffee"  → straight to the nearest match (app.js
 *     skips browse when travel words are present)
 */

export const CATEGORIES = {
  // Car care
  'oil change': { icon: '🛠️', label: 'oil changes', search: 'car repair', selectors: [['shop', 'car_repair']] },
  gas: { icon: '⛽', label: 'gas stations', search: 'gas station', selectors: [['amenity', 'fuel']] },
  fuel: { icon: '⛽', label: 'gas stations', search: 'gas station', selectors: [['amenity', 'fuel']] },

  // Food & drink
  groceries: { icon: '🛒', label: 'groceries', search: 'supermarket', selectors: [['shop', 'supermarket'], ['shop', 'convenience']] },
  grocery: { icon: '🛒', label: 'groceries', search: 'supermarket', selectors: [['shop', 'supermarket'], ['shop', 'convenience']] },
  'grocery store': { icon: '🛒', label: 'groceries', search: 'supermarket', selectors: [['shop', 'supermarket'], ['shop', 'convenience']] },
  supermarket: { icon: '🛒', label: 'groceries', search: 'supermarket', selectors: [['shop', 'supermarket'], ['shop', 'convenience']] },
  coffee: { icon: '☕', label: 'coffee', search: 'cafe', selectors: [['amenity', 'cafe']] },
  cafe: { icon: '☕', label: 'coffee', search: 'cafe', selectors: [['amenity', 'cafe']] },
  breakfast: { icon: '🍽️', label: 'restaurants', search: 'restaurant', selectors: [['amenity', 'restaurant']] },
  lunch: { icon: '🍽️', label: 'restaurants', search: 'restaurant', selectors: [['amenity', 'restaurant']] },
  dinner: { icon: '🍽️', label: 'restaurants', search: 'restaurant', selectors: [['amenity', 'restaurant']] },
  restaurant: { icon: '🍽️', label: 'restaurants', search: 'restaurant', selectors: [['amenity', 'restaurant']] },
  beer: { icon: '🍺', label: 'beer & liquor stores', search: 'beer store', selectors: [['shop', 'alcohol']] },
  liquor: { icon: '🍺', label: 'beer & liquor stores', search: 'beer store', selectors: [['shop', 'alcohol']] },
  'beer store': { icon: '🍺', label: 'beer & liquor stores', search: 'beer store', selectors: [['shop', 'alcohol']] },
  'liquor store': { icon: '🍺', label: 'beer & liquor stores', search: 'beer store', selectors: [['shop', 'alcohol']] },

  // Errands
  pharmacy: { icon: '💊', label: 'pharmacies', search: 'pharmacy', selectors: [['amenity', 'pharmacy']] },
  drugstore: { icon: '💊', label: 'pharmacies', search: 'pharmacy', selectors: [['amenity', 'pharmacy']] },
  prescription: { icon: '💊', label: 'pharmacies', search: 'pharmacy', selectors: [['amenity', 'pharmacy']] },
  'hair cut': { icon: '💇', label: 'hair salons', search: 'hair salon', selectors: [['shop', 'hairdresser']] },
  haircut: { icon: '💇', label: 'hair salons', search: 'hair salon', selectors: [['shop', 'hairdresser']] },
  'hair salon': { icon: '💇', label: 'hair salons', search: 'hair salon', selectors: [['shop', 'hairdresser']] },
  bank: { icon: '🏦', label: 'banks', search: 'bank', selectors: [['amenity', 'bank']] },
  atm: { icon: '🏦', label: 'banks', search: 'bank', selectors: [['amenity', 'bank']] },
  'dry cleaning': { icon: '🧺', label: 'dry cleaners', search: 'dry cleaner', selectors: [['shop', 'dry_cleaning']] },
  'dry cleaner': { icon: '🧺', label: 'dry cleaners', search: 'dry cleaner', selectors: [['shop', 'dry_cleaning']] },
};

const NEAR_TAIL_RE = /\s+(?:near me|nearby|near here|around me|close by)$/i;

/**
 * Whole-string category lookup: "oil change" → its entry, "Oil Change
 * near me." → its entry, "oil change, groceries" → null (that's an
 * errands-style request, not a browse). Returns null for anything that
 * isn't exactly one category phrase.
 *
 * @param {string} query already travel-word-stripped
 * @returns {null | {key:string, icon:string, label:string, search:string, selectors:Array<[string,string]>}}
 */
export function categoryFor(query) {
  if (typeof query !== 'string') return null;
  const q = query.trim().toLowerCase().replace(/[.!?]+$/, '').replace(NEAR_TAIL_RE, '').trim();
  const def = CATEGORIES[q];
  return def ? { key: q, ...def } : null;
}
