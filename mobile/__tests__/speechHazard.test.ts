import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import {
  HAZARD_LABELS,
  HAZARD_PACKET_MAX_AGE_MS,
  HAZARD_RULES,
  HAZARD_THROTTLE_MS,
  TTS_ECHO_TAIL_MS,
  claimHazardWindow,
  createEchoGuard,
  createHazardPacket,
  encodeHazardPacket,
  extractHazards,
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

  it('holds for every hazard type', () => {
    for (const rule of HAZARD_RULES) {
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

  it('throttles the same word across partial and final results', () => {
    const onHazard = jest.fn();
    const stop = start({ senderId: 'me', senderName: 'Alex', onHazard });

    speak('gravel', 'onSpeechPartial');
    speak('gravel', 'onSpeechResult');
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
      speak('fuel', 'onSpeechPartial');
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
      speak('bob reported low', 'onSpeechPartial');
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

