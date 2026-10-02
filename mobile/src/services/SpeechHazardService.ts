import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import {
  HAZARD_PACKET_MAX_AGE_MS,
  createHazardPacket,
  type HazardPacket,
  type HazardType,
} from '../protocol/hazardProtocol';

export {
  HAZARD_PACKET_MAX_AGE_MS,
  HAZARD_PACKET_MAX_FUTURE_MS,
  HAZARD_PROTOCOL_VERSION,
  HAZARD_TYPE_IDS,
  createHazardPacket,
  encodeHazardPacket,
  parseHazardPacket,
  serializeHazardPacket,
} from '../protocol/hazardProtocol';
export type { HazardPacket, HazardType } from '../protocol/hazardProtocol';

/** Spoken phrases that raise a hazard alert, grouped by what they mean. Matching is on whole
 * words / whole phrases ("stop" does not match "stopping"). */
export const HAZARD_RULES = [
  {
    id: 'missed_turn',
    label: 'Missed turn',
    phrases: [
      'missed turn', 'missed the turn', 'wrong way', 'wrong turn', 'wrong exit',
      // Spoken variants listed in scripts/vosk-grammar/phrases.py (the recognizer's phrase list).
      'route changed', 'turn back', 'wrong direction', 'wrong road', 'wrong route', 'miss the done',
      'miss the turn', 'missed the done', 'missed the dun', 'route is wrong', 'you missed our turn',
    ],
  },
  {
    id: 'fuel',
    label: 'Low fuel',
    phrases: [
      'fuel', 'low fuel', 'petrol low', 'need petrol', 'fuel empty', 'need gas', 'gas station', 'petrol pump',
      // Spoken variants listed in scripts/vosk-grammar/phrases.py (the recognizer's phrase list).
      'get petrol', 'petrol is low',
    ],
  },
  {
    id: 'pothole',
    label: 'Pothole',
    phrases: [
      'pothole', 'rough road', 'bad road', 'bump',
      // Spoken variants listed in scripts/vosk-grammar/phrases.py (the recognizer's phrase list).
      'broken road', 'bumpy road', 'damaged road', 'rough patch', 'speed breaker', 'uneven road',
      'bad patch ahead', 'road is bad', 'road is bumpy', 'road is rough', 'road surface is bad',
    ],
  },
  {
    id: 'gravel',
    label: 'Gravel',
    phrases: [
      'gravel', 'sand',
      // Spoken variants listed in scripts/vosk-grammar/phrases.py (the recognizer's phrase list).
      'loose rocks', 'loose stones', 'stones on the road',
    ],
  },
  {
    id: 'roadkill',
    label: 'Roadkill',
    phrases: [
      'roadkill',
      // Spoken variants listed in scripts/vosk-grammar/phrases.py (the recognizer's phrase list).
      'animal ahead', 'animal crossing', 'cow ahead', 'dead animal', 'dog ahead', 'road kill',
      'animal in front', 'watch for animals', 'watch the animal', 'animal in the road', 'animal on the left',
      'animal on the right', 'animal on the road', 'cow on the road', 'dog on the road',
    ],
  },
  {
    id: 'obstacle',
    label: 'Obstacle ahead',
    phrases: [
      'hazard', 'obstacle', 'blocked', 'road block', 'roadblock', 'debris', 'rocks',
      // Spoken variants listed in scripts/vosk-grammar/phrases.py (the recognizer's phrase list).
      'construction ahead', 'construction vehicle', 'construction zone', 'dead end', 'fallen branch',
      'fallen tree', 'no entry', 'object ahead', 'railroad crossing', 'railway crossing', 'road closed',
      'road construction', 'road work', 'tracks ahead', 'train ahead', 'train crossing', 'tree ahead',
      'work zone', 'workers ahead', 'railway track ahead', 'road is closed', 'tree blocking road',
      'branch on the road', 'branches on the road', 'construction on the road', 'object on the road',
      'something blocking the road', 'something in the road', 'something on the road',
      'tree blocking the road', 'tree on the road',
          'blocking the road', 'blocking road', 'road blocking',
    ],
  },
  {
    id: 'police',
    label: 'Police',
    phrases: [
      'police', 'cop', 'checkpoint', 'speed trap',
      // Spoken variants listed in scripts/vosk-grammar/phrases.py (the recognizer's phrase list).
      'speed camera',
    ],
  },
  {
    id: 'accident',
    label: 'Accident',
    phrases: [
      'crash', 'accident', 'rider down', 'fallen',
      // Spoken variants listed in scripts/vosk-grammar/phrases.py (the recognizer's phrase list).
      'collision', 'help me', 'need help', 'rider crashed', 'someone crashed', 'rider needs assistance',
      'rider needs help', 'someone is down', 'someone needs help', 'stop and help', 'we have an emergency',
    ],
  },
  {
    id: 'slippery',
    label: 'Slippery road',
    phrases: [
      'oil', 'slippery', 'wet road', 'water logging',
      // Spoken variants listed in scripts/vosk-grammar/phrases.py (the recognizer's phrase list).
      'deep water', 'flood ahead', 'flooded road', 'flooding ahead', 'heavy rain', 'rain ahead', 'rain coming',
      'water ahead', 'waterlogged road', 'road is flooded', 'road is wet', 'water on road',
      'water across the road', 'water on the road',
    ],
  },
  {
    id: 'slow',
    label: 'Slow down',
    phrases: [
      'slow', 'slow down', 'reduce speed', 'drive slow', 'caution', 'brake',
      // Spoken variants listed in scripts/vosk-grammar/phrases.py (the recognizer's phrase list).
      'pedestrian', 'be careful', 'careful ahead', 'cars ahead', 'congested road', 'drive slower',
      'dust ahead', 'dust cloud', 'fog ahead', 'go slower', 'heavy fog', 'heavy traffic', 'people crossing',
      'person ahead', 'person crossing', 'poor visibility', 'ride slower', 'smoke ahead', 'someone crossing',
      'traffic ahead', 'traffic coming', 'traffic jam', 'lots of cars', 'lower your speed',
      'reduce your speed', 'traffic is heavy', 'visibility is low', 'watch for pedestrians',
      'watch your speed', 'can t see ahead', 'people on the road', 'person on the road',
    ],
  },
  // "emergency stop" used to raise this generic Stop; it now means a stopped vehicle (below).
  {
    id: 'stop',
    label: 'Stop',
    phrases: [
      'stop', 'pull over', 'wait for me',
      // Spoken variants listed in scripts/vosk-grammar/phrases.py (the recognizer's phrase list).
      'red light', 'red signal', 'signal ahead', 'traffic light', 'traffic signal', 'wait here',
      'signal is red',
    ],
  },
  {
    id: 'vehicle_stopped',
    label: 'Vehicle stopped',
    phrases: [
      'vehicle stopped', 'puncture', 'bike stopped', 'breakdown', 'emergency stop', 'stopped',
      // Spoken variants listed in scripts/vosk-grammar/phrases.py (the recognizer's phrase list).
      'emergency', 'bike problem', 'engine problem', 'flat tire', 'flat tyre', 'losing air',
      'mechanical problem', 'bike broke down', 'bike has broken down', 'bike is not working',
      'bike will not start', 'bike won t start', 'cannot start the bike', 'front tire is flat',
      'front tyre is flat', 'my tire is flat', 'my tyre is flat', 'rear tire is flat', 'rear tyre is flat',
      'can t start the bike',
    ],
  },
  {
    id: 'sharp_turn',
    label: 'Sharp turn',
    phrases: [
      'sharp turn', 'blind curve', 'hairpin bend', 'curve ahead',
      // Spoken variants listed in scripts/vosk-grammar/phrases.py (the recognizer's phrase list).
      'blind turn', 'corner ahead', 'dangerous curve', 'dangerous turn', 'hairpin ahead', 'hairpin turn',
      'sharp corner', 'sharp curve', 'tight corner', 'tight turn',
    ],
  },
] as const;

/**
 * The four hazards added for group-ride safety, under their named constants. LOW_FUEL and
 * SLOW_DOWN are the app's existing `fuel` and `slow` hazards -- extended with more trigger phrases
 * and their own readout, not duplicated: a second type would raise two alerts for one "low fuel",
 * and renaming the wire id would make older phones drop these packets.
 */
export const HAZARD_TYPES = {
  LOW_FUEL: 'fuel',
  SLOW_DOWN: 'slow',
  VEHICLE_STOPPED: 'vehicle_stopped',
  SHARP_TURN: 'sharp_turn',
} as const satisfies Record<string, HazardType>;

/** Readouts that replace the default "<name> reported <hazard>." for a hazard, word for word. */
const CUSTOM_ANNOUNCEMENTS: Partial<Record<HazardType, string>> = {
  [HAZARD_TYPES.LOW_FUEL]: 'Rider reported low fuel. Fuel stop needed.',
  [HAZARD_TYPES.SLOW_DOWN]: 'Caution. Slow down ahead.',
  [HAZARD_TYPES.VEHICLE_STOPPED]: "Alert: A group member's vehicle has stopped.",
  [HAZARD_TYPES.SHARP_TURN]: 'Warning: Sharp turn ahead.',
};

export const HAZARD_LABELS = Object.fromEntries(
  HAZARD_RULES.map(rule => [rule.id, rule.label]),
) as Record<HazardType, string>;

/** LiveKit data-channel topic for hazard packets (reliable: they're rare and must arrive). */
export const HAZARD_TOPIC = 'ridezz.hazard';

/** Same hazard type is only raised once per this window (the same call-out is often heard twice). */
export const HAZARD_THROTTLE_MS = 4000;

/** True when a hazard of this type was already recorded in `recent` within HAZARD_THROTTLE_MS.
 * A read-only peek -- see claimHazardWindow for the version that also records. */
export function isWithinHazardWindow(
  recent: Map<HazardType, number>,
  hazard: HazardType,
  now: number = Date.now(),
): boolean {
  const last = recent.get(hazard);
  return last !== undefined && now - last < HAZARD_THROTTLE_MS;
}

/** Records that a hazard of this type was just raised or shown, and reports whether it is new.
 * Returns false when the same type already happened within HAZARD_THROTTLE_MS -- by anyone. This
 * stops one real hazard from being reported several times when riders hear each other (phone
 * speakers, phones side by side) or when one rider's alert arrives over both transports. */
export function claimHazardWindow(
  recent: Map<HazardType, number>,
  hazard: HazardType,
  now: number = Date.now(),
): boolean {
  if (isWithinHazardWindow(recent, hazard, now)) {
    return false;
  }
  recent.set(hazard, now);
  return true;
}

/** How long after an announcement finishes playing the recognizer is still treated as possibly
 * hearing it. Vosk only emits its result for an utterance once it detects the trailing silence,
 * so the text of an announcement can arrive a moment after the audio has stopped. */
export const TTS_ECHO_TAIL_MS = 2500;

export interface EchoGuard {
  /** An announcement has started playing. */
  begin(): void;
  /** An announcement has finished (or failed) -- starts the tail window. */
  end(now?: number): void;
  /** True while an announcement is playing, or within the tail after the last one finished. */
  isEchoLikely(now?: number): boolean;
}

/**
 * Tracks whether this phone's own speaker is (or just was) talking, so the always-on recognizer
 * can ignore what it hears then. Without this, the hazard readout for a received alert
 * ("Alex reported Low fuel") is picked up by this phone's own mic and recognised as this rider
 * raising that hazard themselves -- which then gets broadcast straight back, gets read out on the
 * other phone, and starts the whole thing over.
 *
 * Counts overlapping announcements (they queue), so the guard only releases after the last one.
 */
export function createEchoGuard(tailMs: number = TTS_ECHO_TAIL_MS): EchoGuard {
  let playing = 0;
  let quietAt = 0;
  return {
    begin() {
      playing += 1;
    },
    end(now: number = Date.now()) {
      playing = Math.max(0, playing - 1);
      quietAt = now + tailMs;
    },
    isEchoLikely(now: number = Date.now()) {
      return playing > 0 || now < quietAt;
    },
  };
}

/** Wording that only this app's own readouts use, beyond the "reported" of the default one. The
 * custom readouts (CUSTOM_ANNOUNCEMENTS) hold trigger words themselves -- "Caution. Slow down
 * ahead." is a slow-down trigger -- so a phone hearing one from a neighbour's speaker must
 * recognise it as an announcement, not a rider. Phrases are long enough that a rider calling out
 * just "slow down" or "sharp turn" never matches. */
const ANNOUNCEMENT_PHRASES = [
  'fuel stop needed',
  'caution slow down ahead',
  'vehicle has stopped',
  'group member',
  'warning sharp turn',
];

/**
 * True when recognised speech contains this app's own announcement wording -- the default readout
 * is "<name> reported <hazard>" and the custom ones use the phrases above -- while riders raise
 * hazards with a bare "pothole" / "low fuel" / "sharp turn", never those. Catches announcements
 * heard from ANOTHER phone's speaker too (phones side by side), which the local playback guard
 * can't know about.
 */
export function isAnnouncementEcho(text: string): boolean {
  const padded = ` ${(text.toLowerCase().match(/[a-z]+/g) ?? []).join(' ')} `;
  return padded.includes(' reported ') || ANNOUNCEMENT_PHRASES.some(phrase => padded.includes(` ${phrase} `));
}

/**
 * Records that a specific packet id has now been handled, and reports whether this is the first
 * time. Bounds the memory by age (pruning anything older than HAZARD_PACKET_MAX_AGE_MS) rather
 * than by count.
 *
 * This matters on a mesh that relays: every device forwards every hazard it sees to all its
 * connected peers, so the same packet id keeps bouncing back and forth between directly-connected
 * riders for as long as it stays within its 30s validity window. A fixed-size cache that evicts
 * its oldest entry under that traffic can forget a still-circulating id -- at which point a
 * device that already showed the banner and read it aloud sees the very same packet again and
 * treats it as brand new, repeating both indefinitely for as long as the mesh keeps bouncing it.
 * Pruning by age instead of count can never forget an id while the packet it names is still
 * something any device could legitimately relay or report -- past that age every device's
 * parseHazardPacket already rejects the packet outright, so there's nothing left to dedup.
 */
export function rememberHazardOnce(
  remembered: Map<string, number>,
  id: string,
  now: number = Date.now(),
): boolean {
  for (const [seenId, seenAt] of remembered) {
    if (now - seenAt > HAZARD_PACKET_MAX_AGE_MS) {
      remembered.delete(seenId);
    }
  }
  if (remembered.has(id)) {
    return false;
  }
  remembered.set(id, now);
  return true;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Hazard types whose phrases appear in `text`, in the order first spoken, without repeats. */
export function extractHazards(text: string): HazardType[] {
  const padded = ` ${(text.toLowerCase().match(/[a-z]+/g) ?? []).join(' ')} `;

  // Every place any phrase occurs, with the span it covers (including its surrounding spaces).
  const hits: { id: HazardType; start: number; end: number }[] = [];
  for (const rule of HAZARD_RULES) {
    for (const phrase of rule.phrases) {
      const needle = ` ${phrase} `;
      for (let at = padded.indexOf(needle); at >= 0; at = padded.indexOf(needle, at + 1)) {
        hits.push({ id: rule.id, start: at, end: at + needle.length });
      }
    }
  }

  // A hit that sits inside a longer hit for a DIFFERENT hazard is just a word of that longer
  // phrase, not a second report: "emergency stop" is a stopped vehicle, not also a plain "stop".
  // (A standalone "stop" elsewhere in the same sentence is not inside anything, so it still counts.)
  const firstAt = new Map<HazardType, number>();
  for (const hit of hits) {
    const swallowed = hits.some(
      other =>
        other.id !== hit.id &&
        other.start <= hit.start &&
        other.end >= hit.end &&
        other.end - other.start > hit.end - hit.start,
    );
    if (!swallowed && (firstAt.get(hit.id) ?? Infinity) > hit.start) {
      firstAt.set(hit.id, hit.start);
    }
  }
  return [...firstAt].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

/** One recognised word from a Vosk result (`setWords(true)`), with Vosk's confidence for it (0..1). */
export interface SpokenWord {
  word: string;
  conf: number;
}

/**
 * Like extractHazards, for the recognizer that is restricted to hazard phrases. That one always
 * prefers a hazard word over an unfamiliar ordinary word, so a phrase only counts when EVERY one of
 * its words was recognised with confidence >= minConf. A longer phrase of another hazard still
 * swallows a shorter one even when it was too uncertain to count itself. Phrases in `distrusted` never
 * raise a hazard here (they still swallow shorter phrases).
 */
export function extractHazardsFromWords(
  words: readonly SpokenWord[],
  minConf: number,
  distrusted: ReadonlySet<string> = new Set(),
): HazardType[] {
  const tokens: string[] = [];
  const confs: number[] = [];
  for (const { word, conf } of words) {
    for (const token of word.toLowerCase().match(/[a-z]+/g) ?? []) {
      tokens.push(token);
      confs.push(conf);
    }
  }

  const hits: { id: HazardType; phrase: string; start: number; end: number; conf: number }[] = [];
  for (const rule of HAZARD_RULES) {
    for (const phrase of rule.phrases) {
      const want = phrase.split(' ');
      for (let at = 0; at + want.length <= tokens.length; at++) {
        if (want.every((w, k) => tokens[at + k] === w)) {
          hits.push({
            id: rule.id,
            phrase,
            start: at,
            end: at + want.length,
            conf: Math.min(...confs.slice(at, at + want.length)),
          });
        }
      }
    }
  }

  const firstAt = new Map<HazardType, number>();
  for (const hit of hits) {
    const swallowed = hits.some(
      other =>
        other.id !== hit.id &&
        other.start <= hit.start &&
        other.end >= hit.end &&
        other.end - other.start > hit.end - hit.start,
    );
    if (
      !swallowed &&
      hit.conf >= minConf &&
      !distrusted.has(hit.phrase) &&
      (firstAt.get(hit.id) ?? Infinity) > hit.start
    ) {
      firstAt.set(hit.id, hit.start);
    }
  }
  return [...firstAt].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

/** A hazard from the restricted recognizer only counts above this per-word confidence. In testing
 * it cut that recognizer's false alerts by more than half for about 2 points of recall. */
export const GRAMMAR_MIN_CONFIDENCE = 0.85;

/**
 * Single words the restricted recognizer must NOT be trusted with: it hears them in place of very
 * common ordinary words and is just as confident about the wrong one ("please" -> "police",
 * "pump" -> "bump", "bridge" -> "debris"). The full-vocabulary recognizer still raises them, and the
 * restricted one still raises longer phrases ("police checkpoint").
 */
export const GRAMMAR_DISTRUSTED_PHRASES: ReadonlySet<string> = new Set(['police', 'bump', 'debris', 'stopped']);

/** A finished utterance from VoiceHazardModule: which of its two recognizers heard it, the text,
 * and (when Vosk provided them) the words with their confidences. */
export interface SpeechPayload {
  /** 'free' = the full-vocabulary recognizer (also the legacy, untagged payload);
   * 'grammar' = the one restricted to hazard phrases + ordinary words. */
  source: 'free' | 'grammar';
  text: string;
  words: SpokenWord[];
}

export function parseSpeechPayload(raw: unknown): SpeechPayload {
  const empty: SpeechPayload = { source: 'free', text: '', words: [] };
  if (typeof raw !== 'string') {
    return empty;
  }
  try {
    const parsed = JSON.parse(raw) as { text?: unknown; source?: unknown; result?: unknown };
    const words = Array.isArray(parsed.result)
      ? parsed.result.flatMap((w: { word?: unknown; conf?: unknown }) =>
          typeof w?.word === 'string' && typeof w?.conf === 'number' ? [{ word: w.word, conf: w.conf }] : [],
        )
      : [];
    return {
      source: parsed.source === 'grammar' ? 'grammar' : 'free',
      text: typeof parsed.text === 'string' ? parsed.text : '',
      words,
    };
  } catch {
    return empty;
  }
}

/** Vosk emits `{"text": "..."}` (final) or `{"partial": "..."}`; returns the text or ''. */
export function parseSpeechText(raw: unknown): string {
  if (typeof raw !== 'string') {
    return '';
  }
  try {
    const parsed = JSON.parse(raw) as { text?: unknown; partial?: unknown };
    const text = parsed.text ?? parsed.partial;
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Voice -> hazard detection (VoiceHazardModule / Vosk)
// ---------------------------------------------------------------------------

interface VoiceHazardNative {
  startListening(): Promise<void>;
  stopListening(): Promise<void>;
}

const voiceModule: VoiceHazardNative | undefined = NativeModules.VoiceHazardModule;

export interface SpeechHazardOptions {
  senderId: string;
  senderName: string;
  /** Called once per detected hazard (after throttling) -- the caller picks the transport. */
  onHazard: (packet: HazardPacket) => void;
  /** Called with each finished utterance Vosk recognised, hazard or not -- lets the UI show that
   * offline recognition is alive. */
  onHeard?: (text: string) => void;
  /** Asked before raising any hazard: return true while this phone's own speaker is (or just was)
   * playing an announcement, so the recognizer doesn't mistake its own readout for a rider
   * speaking. See createEchoGuard. */
  isEchoLikely?: () => boolean;
  onError?: (message: string) => void;
}

/** Starts always-on offline speech recognition and raises a HazardPacket for each hazard type
 * heard, throttled to one per type per HAZARD_THROTTLE_MS. Returns a stop function. */
export function startSpeechHazardDetection(options: SpeechHazardOptions): () => void {
  const { senderId, senderName, onHazard, onHeard, isEchoLikely, onError } = options;

  if (Platform.OS !== 'android' || !voiceModule) {
    onError?.('Voice hazard detection is not available on this platform');
    return () => {};
  }

  const lastRaisedAt = new Map<HazardType, number>();

  const handleSpeech = (raw: unknown, isFinal: boolean) => {
    // Only finished utterances raise hazards. Vosk's partial hypotheses keep changing words while
    // it is still listening, and acting on them raised false alerts on about 1 in 10 ordinary
    // sentences in testing (about 1 in 140 when only the final result is used).
    if (!isFinal) {
      return;
    }
    const { source, text, words } = parseSpeechPayload(raw);
    if (source === 'free' && text) {
      // Still reported even when it is our own announcement -- the diagnostics line should show
      // what the mic really hears, it just must not be acted on below. Only the full-vocabulary
      // recognizer reads ordinary speech properly, so only it feeds this line.
      onHeard?.(text);
    }
    // Never raise a hazard from this app's own voice: either our speaker is playing right now (or
    // just stopped), or the words are our announcement wording (possibly from another phone).
    // Returning here also leaves the throttle untouched, so a genuine command spoken right after
    // is not swallowed.
    if (isEchoLikely?.() || isAnnouncementEcho(text)) {
      return;
    }
    const now = Date.now();
    // Two recognizers hear the same speech: the full-vocabulary one misses hazard words it mixes up
    // with ordinary ones ("pothole" -> "boy told"); the restricted one catches those but invents
    // hazards in unfamiliar sentences, so it must be confident. Either one can raise a hazard; the
    // throttle below keeps the same call-out from being raised twice.
    const found =
      source === 'grammar'
        ? extractHazardsFromWords(words, GRAMMAR_MIN_CONFIDENCE, GRAMMAR_DISTRUSTED_PHRASES)
        : extractHazards(text);
    for (const hazard of found) {
      const last = lastRaisedAt.get(hazard);
      if (last !== undefined && now - last < HAZARD_THROTTLE_MS) {
        continue;
      }
      lastRaisedAt.set(hazard, now);
      onHazard(createHazardPacket(hazard, senderId, senderName, now));
    }
  };

  const subscriptions = [
    DeviceEventEmitter.addListener('onSpeechResult', (raw: unknown) => handleSpeech(raw, true)),
    DeviceEventEmitter.addListener('onSpeechPartial', (raw: unknown) => handleSpeech(raw, false)),
    DeviceEventEmitter.addListener('onSpeechError', (message: unknown) =>
      onError?.(String(message)),
    ),
  ];

  voiceModule.startListening().catch((e: { message?: string }) => {
    onError?.(e?.message ?? 'Could not start voice hazard detection');
  });

  let stopped = false;
  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    subscriptions.forEach(s => s.remove());
    voiceModule.stopListening().catch(() => {});
  };
}

// ---------------------------------------------------------------------------
// Audio readout (RidezzTtsModule / Android text-to-speech)
// ---------------------------------------------------------------------------

interface RidezzTtsNative {
  speak(text: string): Promise<void>;
}

const ttsModule: RidezzTtsNative | undefined = NativeModules.RidezzTtsModule;

/** The sentence read aloud for a received hazard: "Alex reported Pothole." for most, and the fixed
 * wording in CUSTOM_ANNOUNCEMENTS for low fuel, slow down, a stopped vehicle and a sharp turn. */
export function buildHazardAnnouncement(packet: HazardPacket): string {
  return CUSTOM_ANNOUNCEMENTS[packet.hazard] ?? `${packet.senderName} reported ${HAZARD_LABELS[packet.hazard]}.`;
}

/**
 * Reads an incoming hazard aloud through whatever audio route the ride is already using (helmet
 * Bluetooth, wired, or phone speaker) via Android's built-in text-to-speech engine, so a rider
 * doesn't have to look at the screen to hear it.
 *
 * Callers must only invoke this for a hazard received from someone else -- never for a rider's
 * own detected hazard, which gets a silent (visual-only) "HAZARD SENT" confirmation instead; they
 * already know what they said and don't need it read back to them (see RideScreen's
 * handleIncomingHazard vs. broadcastHazard).
 *
 * Never rejects -- a missing engine or a failed announcement resolves the same as a successful
 * one, since the on-screen banner already carries the alert either way. The returned promise
 * settles once speech actually finishes (or immediately, if there's nothing to speak), so callers
 * can wrap it to duck and restore other audio for exactly the duration of the announcement (see
 * RideScreen's duckRemoteAudio).
 */
export function speakHazardAudio(packet: HazardPacket): Promise<void> {
  if (Platform.OS !== 'android' || !ttsModule) {
    return Promise.resolve();
  }
  return ttsModule.speak(buildHazardAnnouncement(packet)).catch(() => {});
}

/** Reads arbitrary text aloud through the same engine as speakHazardAudio -- for alerts that
 * aren't a hazard report (e.g. "You are off route"). Same never-rejects contract. */
export function speakText(text: string): Promise<void> {
  if (Platform.OS !== 'android' || !ttsModule) {
    return Promise.resolve();
  }
  return ttsModule.speak(text).catch(() => {});
}
