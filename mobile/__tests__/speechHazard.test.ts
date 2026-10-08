import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import {
  HAZARD_LABELS,
  HAZARD_PACKET_MAX_AGE_MS,
  HAZARD_RULES,
  HAZARD_THROTTLE_MS,
  HAZARD_TYPES,
  TTS_ECHO_TAIL_MS,
  claimHazardWindow,
  createEchoGuard,
  createHazardPacket,
  encodeHazardPacket,
  extractHazards,
  extractHazardsFromWords,
  GRAMMAR_DISTRUSTED_PHRASES,
  GRAMMAR_MIN_CONFIDENCE,
  parseSpeechPayload,
  isAnnouncementEcho,
  isWithinHazardWindow,
  parseHazardPacket,
  parseSpeechText,
  rememberHazardOnce,
  serializeHazardPacket,
  buildHazardAnnouncement,
  type HazardPacket,
} from '../src/services/SpeechHazardService';

const NOW = 1_800_000_000_000;

describe('extractHazards', () => {
  it('finds each hazard keyword', () => {
    for (const word of ['pothole', 'gravel', 'police', 'slow', 'stop', 'roadkill']) {
      expect(extractHazards(`careful ${word} ahead`)).toEqual([word]);
    }
  });

  it('is case-insensitive and ignores punctuation', () => {
    expect(extractHazards('POTHOLE! Gravel, then police.')).toEqual(['pothole', 'gravel', 'police']);
  });

  it('matches whole words only', () => {
    expect(extractHazards('stopping slowly potholes')).toEqual([]);
    expect(extractHazards('non-stop')).toEqual(['stop']); // "-" is a word boundary
  });

  it('returns each keyword once, in spoken order', () => {
    expect(extractHazards('stop stop slow stop')).toEqual(['stop', 'slow']);
  });

  it('returns nothing for unrelated or empty text', () => {
    expect(extractHazards('nice weather today')).toEqual([]);
    expect(extractHazards('')).toEqual([]);
  });

  it('matches multi-word phrases and maps synonyms to one hazard type', () => {
    expect(extractHazards('rough road ahead')).toEqual(['pothole']);
    expect(extractHazards('rider down')).toEqual(['accident']);
    expect(extractHazards('please wait for me')).toEqual(['stop']);
    expect(extractHazards('we took the wrong way')).toEqual(['missed_turn']);
    expect(extractHazards('need petrol soon')).toEqual(['fuel']);
    expect(extractHazards('speed trap ahead')).toEqual(['police']);
    expect(extractHazards('wet road and debris')).toEqual(['slippery', 'obstacle']);
  });

  it('matches the bare keywords called out for low fuel and gravel/sand', () => {
    expect(extractHazards('fuel')).toEqual(['fuel']);
    expect(extractHazards('watch the sand on this bend')).toEqual(['gravel']);
  });

  it('does not match a phrase from a partial word or split words', () => {
    expect(extractHazards('rider')).toEqual([]);
    expect(extractHazards('wait for you')).toEqual([]);
    expect(extractHazards('oily')).toEqual([]);
  });

  it('gives every rule a unique id, a label and at least one phrase', () => {
    const ids = HAZARD_RULES.map(rule => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of HAZARD_RULES) {
      expect(HAZARD_LABELS[rule.id]).toBe(rule.label);
      expect(rule.phrases.length).toBeGreaterThan(0);
    }
  });
});

describe('buildHazardAnnouncement', () => {
  it('reads as "[rider] reported [hazard]"', () => {
    const packet = createHazardPacket('pothole', 'abc', 'Alex', NOW);
    expect(buildHazardAnnouncement(packet)).toBe('Alex reported Pothole.');
  });

  it('holds for every hazard type that has no wording of its own', () => {
    const custom = new Set<string>(Object.values(HAZARD_TYPES));
    for (const rule of HAZARD_RULES) {
      if (custom.has(rule.id)) {
        continue;
      }
      const packet = createHazardPacket(rule.id, 'abc', 'Alex', NOW);
      expect(buildHazardAnnouncement(packet)).toBe(`Alex reported ${rule.label}.`);
    }
  });
});

describe('speakHazardAudio', () => {
  const originalOS = Platform.OS;
  let speakHazard: typeof import('../src/services/SpeechHazardService').speakHazardAudio;
  let speak: jest.Mock;

  beforeEach(() => {
    (Platform as { OS: string }).OS = 'android';
    speak = jest.fn(() => Promise.resolve());
    (NativeModules as Record<string, unknown>).RidezzTtsModule = { speak };
    jest.isolateModules(() => {
      speakHazard = require('../src/services/SpeechHazardService').speakHazardAudio;
    });
  });

  afterEach(() => {
    (Platform as { OS: string }).OS = originalOS;
    delete (NativeModules as Record<string, unknown>).RidezzTtsModule;
  });

  it('speaks the built announcement through the native TTS module', () => {
    const packet = createHazardPacket('stop', 'abc', 'Alex', NOW);
    speakHazard(packet);
    expect(speak).toHaveBeenCalledWith('Alex reported Stop.');
  });

  it('resolves only once the native promise settles (so callers can duck-then-restore around it)', async () => {
    let resolveSpeak: () => void = () => {};
    speak.mockImplementationOnce(() => new Promise<void>(resolve => (resolveSpeak = resolve)));

    let settled = false;
    speakHazard(createHazardPacket('pothole', 'abc', 'Alex', NOW)).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false); // still "speaking"

    resolveSpeak();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  it('does nothing when the native module is unavailable, without throwing', () => {
    delete (NativeModules as Record<string, unknown>).RidezzTtsModule;
    jest.isolateModules(() => {
      speakHazard = require('../src/services/SpeechHazardService').speakHazardAudio;
    });
    expect(() => speakHazard(createHazardPacket('pothole', 'abc', 'Alex', NOW))).not.toThrow();
  });

  it('resolves (never rejects) when the native speak call fails', async () => {
    speak.mockImplementationOnce(() => Promise.reject(new Error('no tts engine')));
    await expect(speakHazard(createHazardPacket('pothole', 'abc', 'Alex', NOW))).resolves.toBeUndefined();
  });
});

describe('createEchoGuard', () => {
  it('is quiet until an announcement starts', () => {
    expect(createEchoGuard().isEchoLikely(NOW)).toBe(false);
  });

  it('is active for the whole announcement, however long it runs', () => {
    const guard = createEchoGuard();
    guard.begin();
    expect(guard.isEchoLikely(NOW)).toBe(true);
    expect(guard.isEchoLikely(NOW + 60_000)).toBe(true);
  });

  it('stays active for a tail after the announcement ends, then releases', () => {
    const guard = createEchoGuard();
    guard.begin();
    guard.end(NOW);
    expect(guard.isEchoLikely(NOW)).toBe(true);
    expect(guard.isEchoLikely(NOW + TTS_ECHO_TAIL_MS - 1)).toBe(true);
    expect(guard.isEchoLikely(NOW + TTS_ECHO_TAIL_MS)).toBe(false);
  });

  it('only releases after the LAST of several queued announcements', () => {
    const guard = createEchoGuard();
    guard.begin();
    guard.begin();
    guard.end(NOW); // first one done, second still playing
    expect(guard.isEchoLikely(NOW + TTS_ECHO_TAIL_MS + 5000)).toBe(true);
    guard.end(NOW + 6000);
    expect(guard.isEchoLikely(NOW + 6000 + TTS_ECHO_TAIL_MS - 1)).toBe(true);
    expect(guard.isEchoLikely(NOW + 6000 + TTS_ECHO_TAIL_MS)).toBe(false);
  });

  it('cannot go negative or stick on if end() is called without a begin()', () => {
    const guard = createEchoGuard();
    guard.end(NOW);
    guard.begin();
    expect(guard.isEchoLikely(NOW + TTS_ECHO_TAIL_MS + 1)).toBe(true); // playing
    guard.end(NOW + TTS_ECHO_TAIL_MS + 1);
    expect(guard.isEchoLikely(NOW + 2 * TTS_ECHO_TAIL_MS + 2)).toBe(false);
  });
});

describe('isAnnouncementEcho', () => {
  it('recognises the own-readout wording', () => {
    expect(isAnnouncementEcho('alex reported low fuel')).toBe(true);
    expect(isAnnouncementEcho('Alex Reported Pothole')).toBe(true);
    expect(isAnnouncementEcho('reported')).toBe(true);
  });

  it('does not flag a rider raising a hazard the normal way', () => {
    expect(isAnnouncementEcho('low fuel')).toBe(false);
    expect(isAnnouncementEcho('pothole')).toBe(false);
    expect(isAnnouncementEcho('police ahead slow down')).toBe(false);
    expect(isAnnouncementEcho('')).toBe(false);
  });

  it('matches the whole word only', () => {
    expect(isAnnouncementEcho('unreported')).toBe(false);
    expect(isAnnouncementEcho('report it')).toBe(false);
  });

  it('matches what buildHazardAnnouncement actually produces, for every hazard', () => {
    for (const rule of HAZARD_RULES) {
      expect(isAnnouncementEcho(buildHazardAnnouncement(createHazardPacket(rule.id, 'x', 'Alex', NOW)))).toBe(true);
    }
  });
});

describe('isWithinHazardWindow', () => {
  it('peeks without recording anything', () => {
    const recent = new Map();
    expect(isWithinHazardWindow(recent, 'fuel', NOW)).toBe(false);
    expect(recent.size).toBe(0);
    expect(claimHazardWindow(recent, 'fuel', NOW)).toBe(true); // still free to claim
  });

  it('is true inside the window and false at its edge', () => {
    const recent = new Map();
    claimHazardWindow(recent, 'fuel', NOW);
    expect(isWithinHazardWindow(recent, 'fuel', NOW + HAZARD_THROTTLE_MS - 1)).toBe(true);
    expect(isWithinHazardWindow(recent, 'fuel', NOW + HAZARD_THROTTLE_MS)).toBe(false);
    expect(isWithinHazardWindow(recent, 'police', NOW)).toBe(false); // other types unaffected
  });
});

describe('rememberHazardOnce', () => {
  it('returns true the first time an id is seen and false on every repeat', () => {
    const remembered = new Map<string, number>();
    expect(rememberHazardOnce(remembered, 'a-1', NOW)).toBe(true);
    expect(rememberHazardOnce(remembered, 'a-1', NOW + 1)).toBe(false);
    expect(rememberHazardOnce(remembered, 'a-1', NOW + HAZARD_PACKET_MAX_AGE_MS - 1)).toBe(false);
  });

  it('tracks each id independently', () => {
    const remembered = new Map<string, number>();
    expect(rememberHazardOnce(remembered, 'a-1', NOW)).toBe(true);
    expect(rememberHazardOnce(remembered, 'a-2', NOW)).toBe(true);
    expect(rememberHazardOnce(remembered, 'a-1', NOW + 1)).toBe(false);
  });

  it('forgets an id once it is older than a packet could still validly be', () => {
    const remembered = new Map<string, number>();
    rememberHazardOnce(remembered, 'a-1', NOW);
    expect(rememberHazardOnce(remembered, 'a-1', NOW + HAZARD_PACKET_MAX_AGE_MS + 1)).toBe(true);
  });

  it('never evicts a still-valid id no matter how many other ids pile up -- the bug this replaces', () => {
    // The old fixed-size (50 slot) cache would evict id "hot" here well before slot 200, making
    // a still-circulating packet look brand new again -- the observed "loop" of repeated
    // banners/TTS. Age-based pruning must not reproduce that.
    const remembered = new Map<string, number>();
    rememberHazardOnce(remembered, 'hot', NOW);
    for (let i = 0; i < 200; i++) {
      rememberHazardOnce(remembered, `other-${i}`, NOW + i);
    }
    expect(rememberHazardOnce(remembered, 'hot', NOW + 200)).toBe(false);
  });

  it('prunes stale entries so memory does not grow without bound over a long ride', () => {
    const remembered = new Map<string, number>();
    for (let i = 0; i < 50; i++) {
      rememberHazardOnce(remembered, `old-${i}`, NOW + i);
    }
    rememberHazardOnce(remembered, 'fresh', NOW + HAZARD_PACKET_MAX_AGE_MS + 1000);
    expect(remembered.size).toBe(1);
    expect(remembered.has('fresh')).toBe(true);
  });
});

describe('claimHazardWindow', () => {
  it('lets the first report through and blocks the same type inside the window', () => {
    const recent = new Map();
    expect(claimHazardWindow(recent, 'pothole', NOW)).toBe(true);
    expect(claimHazardWindow(recent, 'pothole', NOW + HAZARD_THROTTLE_MS - 1)).toBe(false);
    expect(claimHazardWindow(recent, 'pothole', NOW + HAZARD_THROTTLE_MS)).toBe(true);
  });

  it('tracks each hazard type separately', () => {
    const recent = new Map();
    expect(claimHazardWindow(recent, 'pothole', NOW)).toBe(true);
    expect(claimHazardWindow(recent, 'police', NOW + 1)).toBe(true);
    expect(claimHazardWindow(recent, 'pothole', NOW + 2)).toBe(false);
  });

  it('does not extend the window when a duplicate is blocked', () => {
    const recent = new Map();
    claimHazardWindow(recent, 'stop', NOW);
    claimHazardWindow(recent, 'stop', NOW + 3000); // blocked, must not restart the clock
    expect(claimHazardWindow(recent, 'stop', NOW + HAZARD_THROTTLE_MS)).toBe(true);
  });
});

describe('parseSpeechText', () => {
  it('reads final and partial Vosk payloads', () => {
    expect(parseSpeechText('{"text": "big pothole"}')).toBe('big pothole');
    expect(parseSpeechText('{"partial": "big poth"}')).toBe('big poth');
  });

  it('returns empty string for malformed or non-string input', () => {
    expect(parseSpeechText('not json')).toBe('');
    expect(parseSpeechText('{"text": 5}')).toBe('');
    expect(parseSpeechText('{}')).toBe('');
    expect(parseSpeechText(undefined)).toBe('');
    expect(parseSpeechText({ text: 'pothole' })).toBe('');
  });
});

describe('createHazardPacket', () => {
  it('builds a versioned packet with a unique id', () => {
    const a = createHazardPacket('pothole', 'abc', 'Alex', NOW);
    const b = createHazardPacket('gravel', 'abc', 'Alex', NOW);
    expect(a).toEqual({
      v: 1,
      id: `abc-${NOW}-pothole`,
      hazard: 'pothole',
      senderId: 'abc',
      senderName: 'Alex',
      timestamp: NOW,
    });
    expect(a.id).not.toBe(b.id);
  });

  it('shortens long rider names so the mesh TXT record stays small', () => {
    const packet = createHazardPacket('stop', 'abc', 'x'.repeat(100), NOW);
    expect(packet.senderName).toHaveLength(24);
    expect(new TextEncoder().encode(serializeHazardPacket(packet)).length).toBeLessThan(240);
  });
});

describe('parseHazardPacket', () => {
  const packet = createHazardPacket('police', 'abc', 'Alex', NOW);

  it('round-trips through both transports', () => {
    expect(parseHazardPacket(serializeHazardPacket(packet), NOW)).toEqual(packet);
    expect(parseHazardPacket(encodeHazardPacket(packet), NOW)).toEqual(packet);
  });

  it('rejects malformed input', () => {
    expect(parseHazardPacket('nope', NOW)).toBeNull();
    expect(parseHazardPacket('null', NOW)).toBeNull();
    expect(parseHazardPacket('[]', NOW)).toBeNull();
    expect(parseHazardPacket(new Uint8Array([1, 2, 3]), NOW)).toBeNull();
  });

  it('rejects unknown hazards, wrong versions and missing or mistyped fields', () => {
    const bad = (patch: Record<string, unknown>) =>
      parseHazardPacket(JSON.stringify({ ...packet, ...patch }), NOW);

    expect(bad({ hazard: 'meteor' })).toBeNull();
    expect(bad({ v: 2 })).toBeNull();
    expect(bad({ id: 7 })).toBeNull();
    expect(bad({ senderId: undefined })).toBeNull();
    expect(bad({ senderName: null })).toBeNull();
    expect(bad({ timestamp: '123' })).toBeNull();
    expect(bad({ timestamp: null })).toBeNull();
  });

  it('rejects stale and far-future packets', () => {
    const at = (timestamp: number) => parseHazardPacket(JSON.stringify({ ...packet, timestamp }), NOW);

    expect(at(NOW - 29_000)).not.toBeNull();
    expect(at(NOW - 31_000)).toBeNull();
    expect(at(NOW + 29_000)).not.toBeNull();
    expect(at(NOW + 31_000)).toBeNull();
  });

  it('clamps oversized string fields from untrusted peers', () => {
    const parsed = parseHazardPacket(
      JSON.stringify({ ...packet, id: 'i'.repeat(500), senderId: 's'.repeat(500), senderName: 'n'.repeat(500) }),
      NOW,
    ) as HazardPacket;
    expect(parsed.id).toHaveLength(96);
    expect(parsed.senderId).toHaveLength(32);
    expect(parsed.senderName).toHaveLength(24);
  });
});

describe('startSpeechHazardDetection', () => {
  const startListening = jest.fn(() => Promise.resolve());
  const stopListening = jest.fn(() => Promise.resolve());
  let start: typeof import('../src/services/SpeechHazardService').startSpeechHazardDetection;
  const originalOS = Platform.OS;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    startListening.mockClear();
    stopListening.mockClear();
    (Platform as { OS: string }).OS = 'android';
    (NativeModules as Record<string, unknown>).VoiceHazardModule = { startListening, stopListening };
    // The service captures the native module at import time, so load it fresh.
    jest.isolateModules(() => {
      start = require('../src/services/SpeechHazardService').startSpeechHazardDetection;
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    (Platform as { OS: string }).OS = originalOS;
    delete (NativeModules as Record<string, unknown>).VoiceHazardModule;
  });

  const speak = (text: string, kind: 'onSpeechResult' | 'onSpeechPartial' = 'onSpeechResult') =>
    DeviceEventEmitter.emit(kind, JSON.stringify(kind === 'onSpeechResult' ? { text } : { partial: text }));

  it('starts native listening and raises a packet for a hazard word', () => {
    const onHazard = jest.fn();
    const stop = start({ senderId: 'me', senderName: 'Alex', onHazard });

    expect(startListening).toHaveBeenCalledTimes(1);
    speak('watch out pothole');

    expect(onHazard).toHaveBeenCalledTimes(1);
    expect(onHazard.mock.calls[0][0]).toMatchObject({
      hazard: 'pothole',
      senderId: 'me',
      senderName: 'Alex',
      timestamp: NOW,
    });
    stop();
  });

  it('ignores speech without hazard words', () => {
    const onHazard = jest.fn();
    const stop = start({ senderId: 'me', senderName: 'Alex', onHazard });
    speak('lovely day for a ride');
    expect(onHazard).not.toHaveBeenCalled();
    stop();
  });

  it('never raises a hazard from a partial result, only from a finished utterance', () => {
    const onHazard = jest.fn();
    const stop = start({ senderId: 'me', senderName: 'Alex', onHazard });

    // Partial hypotheses change word while Vosk is still listening and gave false alerts.
    speak('gravel', 'onSpeechPartial');
    speak('police', 'onSpeechPartial');
    expect(onHazard).not.toHaveBeenCalled();

    speak('gravel', 'onSpeechResult');
    expect(onHazard).toHaveBeenCalledTimes(1);
    stop();
  });

  describe('two recognizers (full vocabulary + hazard-restricted)', () => {
    const grammarResult = (...words: [string, number][]) =>
      DeviceEventEmitter.emit(
        'onSpeechResult',
        JSON.stringify({
          source: 'grammar',
          text: words.map(([w]) => w).join(' '),
          result: words.map(([word, conf]) => ({ word, conf, start: 0, end: 1 })),
        }),
      );

    it('raises a hazard the restricted recognizer is confident about', () => {
      const onHazard = jest.fn();
      const stop = start({ senderId: 'me', senderName: 'Alex', onHazard });
      grammarResult(['there', 1], ['is', 1], ['a', 1], ['pothole', 1], ['ahead', 1]);
      expect(onHazard).toHaveBeenCalledTimes(1);
      expect(onHazard.mock.calls[0][0].hazard).toBe('pothole');
      stop();
    });

    it('ignores a hazard word the restricted recognizer was unsure of', () => {
      const onHazard = jest.fn();
      const stop = start({ senderId: 'me', senderName: 'Alex', onHazard });
      grammarResult(['my', 1], ['phone', 1], ['fallen', GRAMMAR_MIN_CONFIDENCE - 0.01], ['battery', 1]);
      expect(onHazard).not.toHaveBeenCalled();
      stop();
    });

    it('does not show the restricted recognizer text as "Heard" (it garbles ordinary speech)', () => {
      const onHeard = jest.fn();
      const stop = start({ senderId: 'me', senderName: 'Alex', onHazard: jest.fn(), onHeard });
      grammarResult(['the', 1], ['dead', 0.4], ['end', 0.4]);
      expect(onHeard).not.toHaveBeenCalled();
      speak('how is the weather today');
      expect(onHeard).toHaveBeenCalledWith('how is the weather today');
      stop();
    });

    it('does not trust the restricted recognizer with the single words it mixes up with common ones', () => {
      const onHazard = jest.fn();
      const stop = start({ senderId: 'me', senderName: 'Alex', onHazard });
      grammarResult(['stop', 1], ['here', 1], ['police', 1]); // really "stop here please"
      expect(onHazard.mock.calls.map(c => c[0].hazard)).toEqual(['stop']);
      grammarResult(['a', 1], ['petrol', 1], ['bump', 1]); // really "a petrol pump"
      expect(onHazard).toHaveBeenCalledTimes(1);
      stop();
    });

    it('still takes longer police phrases from the restricted recognizer', () => {
      const onHazard = jest.fn();
      const stop = start({ senderId: 'me', senderName: 'Alex', onHazard });
      grammarResult(['police', 1], ['checkpoint', 1], ['ahead', 1]);
      expect(onHazard.mock.calls.map(c => c[0].hazard)).toEqual(['police']);
      stop();
    });

    it('raises a call-out heard by both recognizers only once', () => {
      const onHazard = jest.fn();
      const stop = start({ senderId: 'me', senderName: 'Alex', onHazard });
      speak('there is a pothole ahead');
      grammarResult(['there', 1], ['is', 1], ['a', 1], ['pothole', 1], ['ahead', 1]);
      expect(onHazard).toHaveBeenCalledTimes(1);
      stop();
    });

    it('lets whichever recognizer caught it raise it when the other missed', () => {
      const onHazard = jest.fn();
      const stop = start({ senderId: 'me', senderName: 'Alex', onHazard });
      speak('there is a boy told ahead'); // full vocabulary mixed it up
      grammarResult(['there', 1], ['is', 1], ['a', 1], ['pothole', 1], ['ahead', 1]);
      expect(onHazard.mock.calls.map(c => c[0].hazard)).toEqual(['pothole']);
      stop();
    });

    it('still blocks announcement echoes from either recognizer', () => {
      const onHazard = jest.fn();
      const stop = start({ senderId: 'me', senderName: 'Alex', onHazard });
      grammarResult(['bob', 1], ['reported', 1], ['pothole', 1]);
      expect(onHazard).not.toHaveBeenCalled();
      stop();
    });
  });

  it('throttles the same word across repeated results', () => {
    const onHazard = jest.fn();
    const stop = start({ senderId: 'me', senderName: 'Alex', onHazard });

    speak('gravel');
    speak('gravel');
    expect(onHazard).toHaveBeenCalledTimes(1);

    jest.setSystemTime(NOW + HAZARD_THROTTLE_MS - 1);
    speak('gravel');
    expect(onHazard).toHaveBeenCalledTimes(1);

    jest.setSystemTime(NOW + HAZARD_THROTTLE_MS);
    speak('gravel');
    expect(onHazard).toHaveBeenCalledTimes(2);
    stop();
  });

  it('throttles each hazard word independently', () => {
    const onHazard = jest.fn();
    const stop = start({ senderId: 'me', senderName: 'Alex', onHazard });

    speak('stop');
    speak('police stop');
    expect(onHazard.mock.calls.map(c => c[0].hazard)).toEqual(['stop', 'police']);
    stop();
  });

  it('reports finished utterances via onHeard, hazard or not, but not partials', () => {
    const onHeard = jest.fn();
    const stop = start({ senderId: 'me', senderName: 'Alex', onHazard: jest.fn(), onHeard });

    speak('lovely day', 'onSpeechPartial');
    expect(onHeard).not.toHaveBeenCalled();

    speak('lovely day for a ride');
    speak('');
    expect(onHeard).toHaveBeenCalledTimes(1);
    expect(onHeard).toHaveBeenCalledWith('lovely day for a ride');
    stop();
  });

  describe('acoustic echo of its own announcements', () => {
    it('raises nothing while the echo guard says the speaker is playing', () => {
      const onHazard = jest.fn();
      const stop = start({ senderId: 'me', senderName: 'Alex', onHazard, isEchoLikely: () => true });

      speak('low fuel');
      speak('fuel');
      expect(onHazard).not.toHaveBeenCalled();
      stop();
    });

    it('raises normally once the guard releases', () => {
      let echo = true;
      const onHazard = jest.fn();
      const stop = start({ senderId: 'me', senderName: 'Alex', onHazard, isEchoLikely: () => echo });

      speak('low fuel');
      expect(onHazard).not.toHaveBeenCalled();

      echo = false;
      speak('low fuel');
      expect(onHazard).toHaveBeenCalledTimes(1);
      stop();
    });

    it('ignores the announcement wording even when this phone is not the one speaking', () => {
      const onHazard = jest.fn();
      const stop = start({ senderId: 'me', senderName: 'Alex', onHazard, isEchoLikely: () => false });

      speak('bob reported low fuel'); // another phone's speaker, heard through the air
      speak('bob reported low');
      expect(onHazard).not.toHaveBeenCalled();
      stop();
    });

    it('does not burn the throttle, so a genuine command right after is not swallowed', () => {
      let echo = true;
      const onHazard = jest.fn();
      const stop = start({ senderId: 'me', senderName: 'Alex', onHazard, isEchoLikely: () => echo });

      speak('low fuel'); // echo, ignored
      echo = false;
      jest.setSystemTime(NOW + 100); // well inside the 4s throttle window
      speak('low fuel'); // the rider really says it
      expect(onHazard).toHaveBeenCalledTimes(1);
      stop();
    });

    it('still reports what the mic heard, echo or not, for the diagnostics line', () => {
      const onHeard = jest.fn();
      const stop = start({
        senderId: 'me',
        senderName: 'Alex',
        onHazard: jest.fn(),
        onHeard,
        isEchoLikely: () => true,
      });

      speak('bob reported low fuel');
      expect(onHeard).toHaveBeenCalledWith('bob reported low fuel');
      stop();
    });

    it('behaves exactly as before when no echo guard is supplied', () => {
      const onHazard = jest.fn();
      const stop = start({ senderId: 'me', senderName: 'Alex', onHazard });
      speak('low fuel');
      expect(onHazard).toHaveBeenCalledTimes(1);
      stop();
    });
  });

  it('stops listening and unsubscribes on stop, only once', () => {
    const onHazard = jest.fn();
    const stop = start({ senderId: 'me', senderName: 'Alex', onHazard });

    stop();
    stop();
    expect(stopListening).toHaveBeenCalledTimes(1);

    speak('pothole');
    expect(onHazard).not.toHaveBeenCalled();
  });

  it('reports native start failures and speech errors through onError', async () => {
    startListening.mockImplementationOnce(() =>
      Promise.reject({ message: 'Could not load Vosk model' }),
    );
    const onError = jest.fn();
    const stop = start({ senderId: 'me', senderName: 'Alex', onHazard: jest.fn(), onError });

    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith('Could not load Vosk model');

    DeviceEventEmitter.emit('onSpeechError', 'mic busy');
    expect(onError).toHaveBeenCalledWith('mic busy');
    stop();
  });

  it('reports unavailability and no-ops when the native module is missing', () => {
    delete (NativeModules as Record<string, unknown>).VoiceHazardModule;
    jest.isolateModules(() => {
      start = require('../src/services/SpeechHazardService').startSpeechHazardDetection;
    });
    const onError = jest.fn();
    const stop = start({ senderId: 'me', senderName: 'Alex', onHazard: jest.fn(), onError });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(() => stop()).not.toThrow();
  });
});

describe('group-ride hazards: low fuel, slow down, vehicle stopped, sharp turn', () => {
  describe('named constants', () => {
    it('map onto real hazard types, reusing the existing fuel and slow ones', () => {
      expect(HAZARD_TYPES).toEqual({
        LOW_FUEL: 'fuel',
        SLOW_DOWN: 'slow',
        VEHICLE_STOPPED: 'vehicle_stopped',
        SHARP_TURN: 'sharp_turn',
      });
      for (const id of Object.values(HAZARD_TYPES)) {
        expect(HAZARD_RULES.some(rule => rule.id === id)).toBe(true);
      }
    });

    it('do not create a second low-fuel or slow-down type', () => {
      expect(HAZARD_RULES.filter(rule => rule.id === 'fuel' || rule.id === 'slow')).toHaveLength(2);
      expect(HAZARD_RULES.map(rule => rule.id)).not.toContain('LOW_FUEL');
    });
  });

  describe('voice triggers', () => {
    it.each([
      ['LOW_FUEL', ['low fuel', 'petrol low', 'need petrol', 'fuel empty', 'fuel'], 'fuel'],
      ['SLOW_DOWN', ['slow down', 'reduce speed', 'drive slow', 'caution', 'brake'], 'slow'],
      [
        'VEHICLE_STOPPED',
        ['vehicle stopped', 'puncture', 'bike stopped', 'breakdown', 'emergency stop', 'stopped'],
        'vehicle_stopped',
      ],
      ['SHARP_TURN', ['sharp turn', 'blind curve', 'hairpin bend', 'curve ahead'], 'sharp_turn'],
    ])('%s is raised by every phrase asked for', (_name, phrases, hazard) => {
      for (const phrase of phrases as string[]) {
        expect({ phrase, hazards: extractHazards(`careful ${phrase} ahead`) }).toEqual({
          phrase,
          hazards: [hazard],
        });
        expect({ phrase, hazards: extractHazards(phrase.toUpperCase()) }).toEqual({ phrase, hazards: [hazard] });
      }
    });

    it('needs the whole phrase: half of one does not raise it', () => {
      for (const partial of ['sharp', 'turn', 'curve', 'blind', 'hairpin', 'vehicle', 'reduce', 'puncturing', 'brakes']) {
        expect({ partial, hazards: extractHazards(partial) }).toEqual({ partial, hazards: [] });
      }
    });

    it('treats "emergency stop" as a stopped vehicle only, not also a plain Stop', () => {
      expect(extractHazards('emergency stop')).toEqual(['vehicle_stopped']);
    });

    it('still counts a genuine "stop" said elsewhere in the same sentence', () => {
      expect(extractHazards('emergency stop then everybody stop')).toEqual(['vehicle_stopped', 'stop']);
    });

    it('keeps plain "stop" and its other phrases as the generic Stop hazard', () => {
      expect(extractHazards('stop')).toEqual(['stop']);
      expect(extractHazards('pull over')).toEqual(['stop']);
      expect(extractHazards('wait for me')).toEqual(['stop']);
    });

    it('tells "stopped" (a vehicle) from "stop" (a command)', () => {
      expect(extractHazards('the bike stopped')).toEqual(['vehicle_stopped']);
      expect(extractHazards('please stop')).toEqual(['stop']);
    });

    it('reports several new hazards in the order they were spoken', () => {
      expect(extractHazards('slow down there is a sharp turn ahead')).toEqual(['slow', 'sharp_turn']);
      expect(extractHazards('puncture and fuel empty')).toEqual(['vehicle_stopped', 'fuel']);
    });

    it('does not disturb the older hazards', () => {
      expect(extractHazards('missed turn')).toEqual(['missed_turn']);
      expect(extractHazards('wrong turn')).toEqual(['missed_turn']);
      expect(extractHazards('pothole and police')).toEqual(['pothole', 'police']);
    });

    it('raises exactly its own hazard for every phrase in the whole table', () => {
      for (const rule of HAZARD_RULES) {
        for (const phrase of rule.phrases) {
          expect({ phrase, hazards: extractHazards(phrase) }).toEqual({ phrase, hazards: [rule.id] });
        }
      }
    });
  });

  describe('spoken alerts', () => {
    const packetFor = (hazard: HazardPacket['hazard']) => createHazardPacket(hazard, 'abc', 'Alex', NOW);

    it.each([
      ['fuel', 'Rider reported low fuel. Fuel stop needed.'],
      ['slow', 'Caution. Slow down ahead.'],
      ['vehicle_stopped', "Alert: A group member's vehicle has stopped."],
      ['sharp_turn', 'Warning: Sharp turn ahead.'],
    ] as const)('%s is announced as: %s', (hazard, wording) => {
      expect(buildHazardAnnouncement(packetFor(hazard))).toBe(wording);
    });

    it('does not put the sender name into these fixed announcements', () => {
      for (const hazard of Object.values(HAZARD_TYPES)) {
        expect(buildHazardAnnouncement(createHazardPacket(hazard, 'abc', 'Zorro', NOW))).not.toContain('Zorro');
      }
    });

    it('leaves every other hazard on the default wording', () => {
      expect(buildHazardAnnouncement(packetFor('pothole'))).toBe('Alex reported Pothole.');
      expect(buildHazardAnnouncement(packetFor('police'))).toBe('Alex reported Police.');
    });
  });

  describe('echo protection', () => {
    it('recognises each new announcement as this app talking, so a neighbouring phone does not re-raise it', () => {
      for (const hazard of Object.values(HAZARD_TYPES)) {
        const spoken = buildHazardAnnouncement(createHazardPacket(hazard, 'abc', 'Alex', NOW));
        expect({ hazard, echo: isAnnouncementEcho(spoken) }).toEqual({ hazard, echo: true });
      }
    });

    it('does not mistake a rider calling the hazard out for an announcement', () => {
      for (const said of ['slow down', 'caution', 'sharp turn', 'sharp turn ahead', 'curve ahead', 'puncture', 'low fuel', 'fuel empty']) {
        expect({ said, echo: isAnnouncementEcho(said) }).toEqual({ said, echo: false });
      }
    });

    it('still ignores the announcements when the mic hears them (they contain trigger words)', () => {
      // Sanity: without the echo check these WOULD raise a hazard.
      expect(extractHazards('caution slow down ahead')).toEqual(['slow']);
      expect(isAnnouncementEcho('caution slow down ahead')).toBe(true);
    });
  });

  describe('broadcast packet', () => {
    it.each(['fuel', 'slow', 'vehicle_stopped', 'sharp_turn'] as const)('carries %s across the room and mesh unchanged', hazard => {
      const packet = createHazardPacket(hazard, 'abc', 'Alex', NOW);
      expect(parseHazardPacket(serializeHazardPacket(packet), NOW)).toEqual(packet);
      expect(parseHazardPacket(encodeHazardPacket(packet), NOW)).toEqual(packet);
    });

    it('still refuses a hazard type nobody knows', () => {
      const bogus = JSON.stringify({ ...createHazardPacket('fuel', 'abc', 'Alex', NOW), hazard: 'LOW_FUEL' });
      expect(parseHazardPacket(bogus, NOW)).toBeNull();
    });
  });

  describe('labels', () => {
    it('gives the two new types readable names', () => {
      expect(HAZARD_LABELS.vehicle_stopped).toBe('Vehicle stopped');
      expect(HAZARD_LABELS.sharp_turn).toBe('Sharp turn');
    });
  });
});


describe('extractHazardsFromWords', () => {
  const said = (...words: [string, number][]) => words.map(([word, conf]) => ({ word, conf }));

  it('finds a phrase whose words are all confident enough', () => {
    expect(extractHazardsFromWords(said(['low', 1], ['fuel', 0.97]), 0.95)).toEqual(['fuel']);
  });

  it('needs every word of the phrase to clear the bar, not just the average', () => {
    expect(extractHazardsFromWords(said(['missed', 1], ['the', 1], ['turn', 0.6]), 0.95)).toEqual([]);
  });

  it('keeps a longer phrase of another hazard swallowing a shorter one, even when it was unsure', () => {
    // "emergency stop" is a stopped vehicle, never also a plain "stop" -- the same as extractHazards
    expect(extractHazardsFromWords(said(['emergency', 0.5], ['stop', 1]), 0.95)).toEqual([]);
    expect(extractHazardsFromWords(said(['emergency', 1], ['stop', 1]), 0.95)).toEqual(['vehicle_stopped']);
  });

  it('splits Vosk words with apostrophes the way the text matcher does, and orders by first spoken', () => {
    expect(extractHazardsFromWords(said(['police', 1], ['ahead', 1], ['stop', 1]), 0.95)).toEqual(['police', 'stop']);
    expect(extractHazardsFromWords(said(["i'm", 1], ['low', 1], ['on', 1], ['fuel', 1]), 0.95)).toEqual(['fuel']);
  });

  it('never raises a distrusted phrase, but a plain one is unaffected', () => {
    expect(extractHazardsFromWords(said(['police', 1]), 0.95, GRAMMAR_DISTRUSTED_PHRASES)).toEqual([]);
    expect(extractHazardsFromWords(said(['police', 1]), 0.95)).toEqual(['police']);
  });

  it('agrees with extractHazards when everything is certain', () => {
    for (const talk of ['there is a pothole ahead', 'slippery road ahead', 'we missed the turn', 'nice weather today']) {
      const words = talk.split(' ').map(word => ({ word, conf: 1 }));
      expect(extractHazardsFromWords(words, 0.95)).toEqual(extractHazards(talk));
    }
  });
});

describe('parseSpeechPayload', () => {
  it('reads the source, text and per-word confidences', () => {
    const raw = JSON.stringify({ source: 'grammar', text: 'slow down', result: [{ word: 'slow', conf: 1 }, { word: 'down', conf: 0.9 }] });
    expect(parseSpeechPayload(raw)).toEqual({
      source: 'grammar',
      text: 'slow down',
      words: [{ word: 'slow', conf: 1 }, { word: 'down', conf: 0.9 }],
    });
  });

  it('treats an untagged payload as the full-vocabulary recognizer', () => {
    expect(parseSpeechPayload('{"text":"hello"}')).toEqual({ source: 'free', text: 'hello', words: [] });
  });

  it('never throws on garbage', () => {
    for (const bad of [undefined, null, 5, '', 'not json', '{"result":[null,{"word":3}]}']) {
      expect(parseSpeechPayload(bad).words).toEqual([]);
    }
  });
});
