import { MAX_JSON_VALUE_DEPTH, isJsonValue } from '../src/connectivity/protocol/jsonValue';

function nested(depth: number): unknown {
  let value: unknown = 'leaf';
  for (let i = 0; i < depth; i++) {
    value = i % 2 ? [value] : { child: value };
  }
  return value;
}

class Point {
  x = 1;
}

describe('isJsonValue', () => {
  test.each<unknown>([
    null,
    true,
    false,
    0,
    -1.5,
    '',
    'text',
    [],
    {},
    [1, 'a', null, { b: [true] }],
    Object.create(null),
  ])('accepts %p', value => {
    expect(isJsonValue(value)).toBe(true);
  });

  test.each<[string, unknown]>([
    ['undefined', undefined],
    ['function', () => 1],
    ['symbol', Symbol('s')],
    ['bigint', BigInt(1)],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['Date', new Date(0)],
    ['Map', new Map()],
    ['class instance', new Point()],
    ['sparse array', [1, , 3]], // eslint-disable-line no-sparse-arrays -- the sparse array is the input under test
    ['array holding undefined', [undefined]],
    ['object holding a function', { f: () => 1 }],
  ])('rejects %s', (_label, value) => {
    expect(isJsonValue(value)).toBe(false);
  });

  test('accepts exactly MAX_JSON_VALUE_DEPTH containers and rejects one more', () => {
    expect(isJsonValue(nested(MAX_JSON_VALUE_DEPTH))).toBe(true);
    expect(isJsonValue(nested(MAX_JSON_VALUE_DEPTH + 1))).toBe(false);
  });

  test('terminates on cycles', () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(isJsonValue(cyclic)).toBe(false);
  });
});
