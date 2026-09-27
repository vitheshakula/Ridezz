import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { CRITICAL_HAZARDS, HazardGlyph } from '../src/components/HazardIcons';
import { HAZARD_RULES, HAZARD_TYPES } from '../src/services/SpeechHazardService';

describe('hazard icons', () => {
  it('draw something for every hazard type, including the new ones', () => {
    for (const rule of HAZARD_RULES) {
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      ReactTestRenderer.act(() => {
        renderer = ReactTestRenderer.create(<HazardGlyph type={rule.id} color="#fff" />);
      });
      const tree = JSON.stringify(renderer.toJSON());
      expect({ hazard: rule.id, drawn: tree.length > 40 }).toEqual({ hazard: rule.id, drawn: true });
    }
  });

  it('marks a stopped vehicle as critical (red) and a sharp turn as a caution (amber)', () => {
    expect(CRITICAL_HAZARDS.has(HAZARD_TYPES.VEHICLE_STOPPED)).toBe(true);
    expect(CRITICAL_HAZARDS.has(HAZARD_TYPES.SHARP_TURN)).toBe(false);
  });

  it('keeps low fuel and slow down as cautions', () => {
    expect(CRITICAL_HAZARDS.has(HAZARD_TYPES.LOW_FUEL)).toBe(false);
    expect(CRITICAL_HAZARDS.has(HAZARD_TYPES.SLOW_DOWN)).toBe(false);
  });

  it('keeps the existing critical hazards critical', () => {
    for (const hazard of ['accident', 'stop', 'obstacle'] as const) {
      expect(CRITICAL_HAZARDS.has(hazard)).toBe(true);
    }
  });
});
