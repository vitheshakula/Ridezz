export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const MAX_JSON_VALUE_DEPTH = 16;

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

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
