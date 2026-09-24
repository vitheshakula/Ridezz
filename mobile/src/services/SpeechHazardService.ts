import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';

/** Spoken phrases that raise a hazard alert, grouped by what they mean. Matching is on whole
 * words / whole phrases ("stop" does not match "stopping"). */
export const HAZARD_RULES = [
  { id: 'missed_turn', label: 'Missed turn', phrases: ['missed turn', 'missed the turn', 'wrong way', 'wrong turn', 'wrong exit'] },
  { id: 'fuel', label: 'Low fuel', phrases: ['fuel', 'low fuel', 'need petrol', 'need gas', 'gas station', 'petrol pump'] },
  { id: 'pothole', label: 'Pothole', phrases: ['pothole', 'rough road', 'bad road', 'bump'] },
  { id: 'gravel', label: 'Gravel', phrases: ['gravel', 'sand'] },
  { id: 'roadkill', label: 'Roadkill', phrases: ['roadkill'] },
  { id: 'obstacle', label: 'Obstacle ahead', phrases: ['hazard', 'obstacle', 'blocked', 'road block', 'roadblock', 'debris', 'rocks'] },
  { id: 'police', label: 'Police', phrases: ['police', 'cop', 'checkpoint', 'speed trap'] },
  { id: 'accident', label: 'Accident', phrases: ['crash', 'accident', 'rider down', 'fallen'] },
  { id: 'slippery', label: 'Slippery road', phrases: ['oil', 'slippery', 'wet road', 'water logging'] },
  { id: 'slow', label: 'Slow down', phrases: ['slow', 'slow down'] },
  { id: 'stop', label: 'Stop', phrases: ['stop', 'pull over', 'wait for me', 'emergency stop'] },
] as const;

export type HazardType = (typeof HAZARD_RULES)[number]['id'];

export const HAZARD_LABELS = Object.fromEntries(
  HAZARD_RULES.map(rule => [rule.id, rule.label]),
) as Record<HazardType, string>;

/** LiveKit data-channel topic for hazard packets (reliable: they're rare and must arrive). */
export const HAZARD_TOPIC = 'ridezz.hazard';

/** Same hazard type is only raised once per this window (Vosk repeats it across partial + final). */
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

/**
 * True when recognised speech contains this app's own announcement wording -- every readout is
 * "<name> reported <hazard>", and riders raise hazards with a bare "pothole" / "low fuel", never
 * "reported". Catches announcements heard from ANOTHER phone's speaker too (phones side by side),
 * which the local playback guard can't know about.
 */
export function isAnnouncementEcho(text: string): boolean {
  return /\breported\b/.test(text.toLowerCase());
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

/** A packet older than this is rejected by parseHazardPacket below as stale, on every device --
 * so nothing needs to remember a packet id for longer than this to dedup it correctly (see
 * rememberHazardOnce). */
export const HAZARD_PACKET_MAX_AGE_MS = 30_000;
const HAZARD_MAX_FUTURE_MS = 30_000;
const MAX_NAME_LENGTH = 24;

export interface HazardPacket {
  v: 1;
  id: string;
  hazard: HazardType;
  senderId: string;
  senderName: string;
  timestamp: number;
}

const HAZARD_IDS: ReadonlySet<string> = new Set(HAZARD_RULES.map(rule => rule.id));

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Hazard types whose phrases appear in `text`, in the order first spoken, without repeats. */
export function extractHazards(text: string): HazardType[] {
  const padded = ` ${(text.toLowerCase().match(/[a-z]+/g) ?? []).join(' ')} `;
  const found: { id: HazardType; at: number }[] = [];

  for (const rule of HAZARD_RULES) {
    const positions = rule.phrases
      .map(phrase => padded.indexOf(` ${phrase} `))
      .filter(index => index >= 0);
    if (positions.length > 0) {
      found.push({ id: rule.id, at: Math.min(...positions) });
    }
  }
  return found.sort((a, b) => a.at - b.at).map(f => f.id);
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

export function createHazardPacket(
  hazard: HazardType,
  senderId: string,
  senderName: string,
  now: number = Date.now(),
): HazardPacket {
  return {
    v: 1,
    id: `${senderId}-${now}-${hazard}`,
    hazard,
    senderId,
    // Kept short: packets travel over cellular data and short-range radio links.
    senderName: senderName.slice(0, MAX_NAME_LENGTH),
    timestamp: now,
  };
}

export function serializeHazardPacket(packet: HazardPacket): string {
  return JSON.stringify(packet);
}

export function encodeHazardPacket(packet: HazardPacket): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(serializeHazardPacket(packet));
}

/** Decodes + validates a packet from either transport. Returns null (never throws) for anything
 * malformed, unknown, or stale -- callers silently drop it. */
export function parseHazardPacket(
  input: string | Uint8Array,
  now: number = Date.now(),
): HazardPacket | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof input === 'string' ? input : new TextDecoder().decode(input));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const p = parsed as Record<string, unknown>;

  if (
    p.v !== 1 ||
    typeof p.hazard !== 'string' ||
    !HAZARD_IDS.has(p.hazard) ||
    typeof p.id !== 'string' ||
    typeof p.senderId !== 'string' ||
    typeof p.senderName !== 'string' ||
    typeof p.timestamp !== 'number' ||
    !Number.isFinite(p.timestamp)
  ) {
    return null;
  }
  if (now - p.timestamp > HAZARD_PACKET_MAX_AGE_MS || p.timestamp - now > HAZARD_MAX_FUTURE_MS) {
    return null;
  }
  return {
    v: 1,
    id: p.id.slice(0, 96),
    hazard: p.hazard as HazardType,
    senderId: p.senderId.slice(0, 32),
    senderName: p.senderName.slice(0, MAX_NAME_LENGTH),
    timestamp: p.timestamp,
  };
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
    const text = parseSpeechText(raw);
    if (isFinal && text) {
      // Still reported even when it is our own announcement -- the diagnostics line should show
      // what the mic really hears, it just must not be acted on below.
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
    for (const hazard of extractHazards(text)) {
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

/** The sentence read aloud for a received hazard, e.g. "Alex reported Pothole." */
export function buildHazardAnnouncement(packet: HazardPacket): string {
  return `${packet.senderName} reported ${HAZARD_LABELS[packet.hazard]}.`;
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
