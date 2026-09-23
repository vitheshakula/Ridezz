import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import {
  HAZARD_LABELS,
  HAZARD_RULES,
  HAZARD_THROTTLE_MS,
  claimHazardWindow,
  createHazardPacket,
  encodeHazardPacket,
  extractHazards,
  parseHazardPacket,
  parseSpeechText,
  serializeHazardPacket,
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

describe('nearbyMesh', () => {
  const originalOS = Platform.OS;
  let mesh: typeof import('../src/services/SpeechHazardService').nearbyMesh;
  let broadcastHazard: jest.Mock;
  let resolvers: Array<() => void>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    resolvers = [];
    broadcastHazard = jest.fn(() => new Promise<void>(resolve => resolvers.push(resolve)));
    (Platform as { OS: string }).OS = 'android';
    (NativeModules as Record<string, unknown>).NearbyMeshModule = {
      startMeshSession: jest.fn(() => Promise.resolve()),
      stopMeshSession: jest.fn(() => Promise.resolve()),
      broadcastHazard,
    };
    jest.isolateModules(() => {
      mesh = require('../src/services/SpeechHazardService').nearbyMesh;
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    (Platform as { OS: string }).OS = originalOS;
    delete (NativeModules as Record<string, unknown>).NearbyMeshModule;
  });

  const packet = createHazardPacket('pothole', 'me', 'Alex', NOW);

  it('sends broadcasts strictly one at a time, in order', async () => {
    const second = createHazardPacket('gravel', 'me', 'Alex', NOW + 1);
    const first$ = mesh.broadcast(packet);
    const second$ = mesh.broadcast(second);

    await Promise.resolve();
    await Promise.resolve();
    expect(broadcastHazard).toHaveBeenCalledTimes(1);
    expect(JSON.parse(broadcastHazard.mock.calls[0][0]).hazard).toBe('pothole');

    resolvers[0]();
    await first$;
    await Promise.resolve();
    await Promise.resolve();
    expect(broadcastHazard).toHaveBeenCalledTimes(2);
    expect(JSON.parse(broadcastHazard.mock.calls[1][0]).hazard).toBe('gravel');

    resolvers[1]();
    await second$;
  });

  it('keeps sending after one broadcast fails', async () => {
    broadcastHazard.mockImplementationOnce(() => Promise.reject(new Error('busy')));
    broadcastHazard.mockImplementationOnce(() => Promise.resolve());

    await expect(mesh.broadcast(packet)).rejects.toThrow('busy');
    await expect(mesh.broadcast(packet)).resolves.toBeUndefined();
  });

  it('rejects when the native module is missing', async () => {
    delete (NativeModules as Record<string, unknown>).NearbyMeshModule;
    jest.isolateModules(() => {
      mesh = require('../src/services/SpeechHazardService').nearbyMesh;
    });
    await expect(mesh.broadcast(packet)).rejects.toThrow('not available');
    await expect(mesh.start('ABC123', 'Alex')).rejects.toThrow('not available');
    await expect(mesh.stop()).resolves.toBeUndefined();
  });

  it('delivers valid received hazards and drops invalid or stale ones', () => {
    const onHazard = jest.fn();
    const unsubscribe = mesh.onHazardReceived(onHazard);

    DeviceEventEmitter.emit('onHazardReceived', serializeHazardPacket(packet));
    DeviceEventEmitter.emit('onHazardReceived', 'garbage');
    DeviceEventEmitter.emit('onHazardReceived', 42);
    DeviceEventEmitter.emit(
      'onHazardReceived',
      serializeHazardPacket({ ...packet, timestamp: NOW - 60_000 }),
    );

    expect(onHazard).toHaveBeenCalledTimes(1);
    expect(onHazard).toHaveBeenCalledWith(packet);

    unsubscribe();
    DeviceEventEmitter.emit('onHazardReceived', serializeHazardPacket(packet));
    expect(onHazard).toHaveBeenCalledTimes(1);
  });

  it('parses mesh status pushes and ignores malformed ones', () => {
    const onStatus = jest.fn();
    const unsubscribe = mesh.onStatus(onStatus);

    DeviceEventEmitter.emit('onMeshStatus', JSON.stringify({ active: true, peers: 2 }));
    DeviceEventEmitter.emit(
      'onMeshStatus',
      JSON.stringify({ active: false, peers: 0, error: 'Wi-Fi Direct busy' }),
    );
    DeviceEventEmitter.emit('onMeshStatus', 'not json');
    DeviceEventEmitter.emit('onMeshStatus', JSON.stringify({}));

    expect(onStatus.mock.calls.map(c => c[0])).toEqual([
      { active: true, peers: 2, error: null },
      { active: false, peers: 0, error: 'Wi-Fi Direct busy' },
      { active: false, peers: 0, error: null },
    ]);
    unsubscribe();
  });
});
