/** A value that survives a JSON round-trip unchanged. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Maximum container nesting: `{}` and `[]` are depth 1, scalars depth 0. Bounds recursion here
 * and in any payload consumer, and terminates on cyclic input. */
export const MAX_JSON_VALUE_DEPTH = 16;

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * True when `value` is exactly representable as JSON: null, booleans, finite numbers, strings,
 * dense arrays and plain objects of the same, nested at most `maxDepth` containers deep.
 *
 * Rejects everything JSON.stringify would silently alter or drop (undefined, functions, NaN,
 * Infinity, Dates, Maps, class instances, array holes) and everything it throws on (BigInt,
 * cycles), so what is sent is exactly what the receiver parses.
 */
export function isJsonValue(value: unknown, maxDepth: number = MAX_JSON_VALUE_DEPTH): boolean {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      break;
    default:
      return false;
  }
  if (value === null) {
    return true;
  }
  if (maxDepth <= 0) {
    return false;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!(i in value) || !isJsonValue(value[i], maxDepth - 1)) {
        return false;
      }
    }
    return true;
  }
  if (!isPlainObject(value)) {
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!isJsonValue((value as Record<string, unknown>)[key], maxDepth - 1)) {
      return false;
    }
  }
  return true;
}
