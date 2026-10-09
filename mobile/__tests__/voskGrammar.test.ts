import { HAZARD_RULES, extractHazards } from '../src/services/SpeechHazardService';

// No @types/node in this project, so load fs the way the other tests load modules; jest runs from
// the mobile/ root.
const fs: { readFileSync(file: string, encoding: 'utf8'): string } = require('fs');
const GRAMMAR_FILE = 'android/app/src/main/assets/vosk-grammar.json';

const grammar: string[] = JSON.parse(fs.readFileSync(GRAMMAR_FILE, 'utf8'));
const isHazardEntry = (entry: string) => extractHazards(entry).length > 0;

describe('Vosk hazard grammar (assets/vosk-grammar.json)', () => {
  it('is a list of strings that ends with the unknown-word token', () => {
    expect(Array.isArray(grammar)).toBe(true);
    expect(grammar.every(entry => typeof entry === 'string' && entry.length > 0)).toBe(true);
    expect(grammar).toContain('[unk]');
  });

  it('carries plenty of ordinary words next to the hazard phrases', () => {
    // Without them Vosk forces ordinary sentences into hazard words (about 5% false alerts).
    const ordinary = grammar.filter(entry => entry !== '[unk]' && !isHazardEntry(entry));
    expect(ordinary.length).toBeGreaterThan(1000);
    expect(ordinary.every(entry => !entry.includes(' '))).toBe(true);
  });

  it('only lists multi-word phrases that the hazard rules turn into a hazard', () => {
    const orphans = grammar.filter(entry => entry.includes(' ') && !isHazardEntry(entry));
    expect(orphans).toEqual([]);
  });

  it('covers every hazard type with several spoken phrases', () => {
    for (const rule of HAZARD_RULES) {
      const phrases = grammar.filter(entry => extractHazards(entry).includes(rule.id));
      expect({ hazard: rule.id, enough: phrases.length >= 3 }).toEqual({ hazard: rule.id, enough: true });
    }
  });

  it('has no duplicates', () => {
    expect(new Set(grammar).size).toBe(grammar.length);
  });
});

describe('spoken variants all end up as the right hazard', () => {
  const cases: [string, string][] = [
    ['there is a pothole ahead', 'pothole'],
    ['watch out for the pothole', 'pothole'],
    ['I am low on fuel', 'fuel'],
    ['fuel is low', 'fuel'],
    ['we missed the turn', 'missed_turn'],
    ['i missed the done', 'missed_turn'],
    ['we took a wrong turn', 'missed_turn'],
    ['accident ahead', 'accident'],
    ['there is a collision ahead', 'accident'],
    ['slippery road ahead', 'slippery'],
    ['oil on the road', 'slippery'],
    ['slow down here', 'slow'],
    ['please slow down', 'slow'],
    ['stop here please', 'stop'],
    ['pull over now', 'stop'],
    ['police ahead', 'police'],
    ['police checkpoint ahead', 'police'],
    ['bike has broken down', 'vehicle_stopped'],
    ['engine stopped', 'vehicle_stopped'],
    ['I have a puncture', 'vehicle_stopped'],
    ['sharp turn ahead', 'sharp_turn'],
    ['loose gravel on the road', 'gravel'],
    ['dead animal on the road', 'roadkill'],
    ['road is blocked', 'obstacle'],
  ];
  it.each(cases)('"%s" -> %s', (spoken, hazard) => {
    expect(extractHazards(spoken)).toContain(hazard);
  });

  it('keeps ordinary riding talk quiet', () => {
    for (const talk of ["let's go", 'can you hear me', 'nice road', 'are you behind me', 'how is the weather today']) {
      expect({ talk, hazards: extractHazards(talk) }).toEqual({ talk, hazards: [] });
    }
  });
});
