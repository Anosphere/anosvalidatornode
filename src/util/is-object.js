/**
 * True for a plain JSON object: not null, not an array. Used by shape checks.
 * A copy of anossoftware's src/util/is-object.js.
 */
export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
