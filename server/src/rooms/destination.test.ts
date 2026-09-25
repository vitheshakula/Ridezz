import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanDestinationName, parseDestination } from './destination';

describe('cleanDestinationName', () => {
  it('trims and keeps a real name', () => {
    assert.equal(cleanDestinationName('  Golconda Fort  '), 'Golconda Fort');
  });

  it('drops anything that is not a non-blank string', () => {
    for (const bad of [undefined, null, '', '   ', 5, {}, ['x'], true]) {
      assert.equal(cleanDestinationName(bad), null, String(bad));
    }
  });

  it('cuts an oversized name rather than storing unbounded text', () => {
    assert.equal(cleanDestinationName('x'.repeat(500))?.length, 200);
  });
});

describe('parseDestination', () => {
  it('reads a valid destination', () => {
    assert.deepEqual(parseDestination({ destinationName: 'Fort', destinationLat: 17.38, destinationLng: 78.4 }), {
      name: 'Fort',
      lat: 17.38,
      lng: 78.4,
    });
  });

  it('allows a destination with no name', () => {
    assert.deepEqual(parseDestination({ destinationLat: 0, destinationLng: 0 }), { name: null, lat: 0, lng: 0 });
  });

  it('accepts the edges of the valid range', () => {
    assert.ok(parseDestination({ destinationLat: 90, destinationLng: 180 }));
    assert.ok(parseDestination({ destinationLat: -90, destinationLng: -180 }));
  });

  const bad: Array<[string, unknown]> = [
    ['no body', undefined],
    ['null body', null],
    ['missing coordinates', { destinationName: 'x' }],
    ['latitude only', { destinationLat: 10 }],
    ['longitude only', { destinationLng: 10 }],
    ['string coordinates', { destinationLat: '17.3', destinationLng: '78.4' }],
    ['NaN', { destinationLat: NaN, destinationLng: 10 }],
    ['Infinity', { destinationLat: 10, destinationLng: Infinity }],
    ['latitude too high', { destinationLat: 90.0001, destinationLng: 0 }],
    ['latitude too low', { destinationLat: -91, destinationLng: 0 }],
    ['longitude too high', { destinationLat: 0, destinationLng: 180.5 }],
    ['longitude too low', { destinationLat: 0, destinationLng: -181 }],
    ['null coordinates', { destinationLat: null, destinationLng: null }],
  ];
  for (const [label, body] of bad) {
    it(`rejects ${label}`, () => assert.equal(parseDestination(body), null));
  }
});
