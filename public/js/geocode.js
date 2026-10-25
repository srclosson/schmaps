/**
 * Schmaps geocoding — Nominatim (OpenStreetMap), via the server proxy.
 *
 * The workhorse forward geocoder for non-address-shaped queries
 * (business and place names the typeahead chain can't pin down) and
 * for errands stop fragments. Thin wrapper over the OSM adapter that
 * keeps the throw-on-no-match contract callers (app.js, errands.js)
 * have always had — geocode() resolves null on a miss, this throws.
 */

import { geocode } from './osm.js';

/**
 * Forward-geocode a Canadian query.
 * @param {string} query free-form address or place, e.g. "101 Wellington St, Ottawa, ON"
 * @returns {Promise<{lat:number, lon:number, label:string, confidence:number, source:string}>}
 * @throws when Nominatim has no Canadian match
 */
export async function geocodeAddress(query) {
  const r = await geocode(query);
  if (!r) {
    throw new Error('Could not resolve that place in Canada. Try adding the city and province.');
  }
  return r;
}
