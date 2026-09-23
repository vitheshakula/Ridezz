import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';

/** Spoken phrases that raise a hazard alert, grouped by what they mean. Matching is on whole
 * words / whole phrases ("stop" does not match "stopping"). */
export const HAZARD_RULES = [
  { id: 'missed_turn', label: 'Missed turn', phrases: ['missed turn', 'missed the turn', 'wrong way', 'wrong turn', 'wrong exit'] },
  { id: 'fuel', label: 'Low fuel', phrases: ['low fuel', 'need petrol', 'need gas', 'gas station', 'petrol pump'] },
  { id: 'pothole', label: 'Pothole', phrases: ['pothole', 'rough road', 'bad road', 'bump'] },
  { id: 'gravel', label: 'Gravel', phrases: ['gravel'] },
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

/** Records that a hazard of this type was just raised or shown, and reports whether it is new.
 * Returns false when the same type already happened within HAZARD_THROTTLE_MS -- by anyone. This
 * stops one real hazard from being reported several times when riders hear each other (phone
 * speakers, phones side by side) or when one rider's alert arrives over both transports. */
export function claimHazardWindow(
  recent: Map<HazardType, number>,
  hazard: HazardType,
  now: number = Date.now(),
): boolean {
  const last = recent.get(hazard);
  if (last !== undefined && now - last < HAZARD_THROTTLE_MS) {
    return false;
  }
  recent.set(hazard, now);
  return true;
}

const HAZARD_MAX_AGE_MS = 30_000;
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
  if (now - p.timestamp > HAZARD_MAX_AGE_MS || p.timestamp - now > HAZARD_MAX_FUTURE_MS) {
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
  onError?: (message: string) => void;
}

/** Starts always-on offline speech recognition and raises a HazardPacket for each hazard type
 * heard, throttled to one per type per HAZARD_THROTTLE_MS. Returns a stop function. */
export function startSpeechHazardDetection(options: SpeechHazardOptions): () => void {
  const { senderId, senderName, onHazard, onHeard, onError } = options;

  if (Platform.OS !== 'android' || !voiceModule) {
    onError?.('Voice hazard detection is not available on this platform');
    return () => {};
  }

  const lastRaisedAt = new Map<HazardType, number>();

  const handleSpeech = (raw: unknown, isFinal: boolean) => {
    const text = parseSpeechText(raw);
    if (isFinal && text) {
      onHeard?.(text);
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
// Offline transport (NearbyMeshModule / Google Nearby Connections)
// ---------------------------------------------------------------------------

interface NearbyMeshNative {
  startMeshSession(roomCode: string, riderName: string): Promise<void>;
  stopMeshSession(): Promise<void>;
  broadcastHazard(payloadJson: string): Promise<void>;
}

const meshModule: NearbyMeshNative | undefined = NativeModules.NearbyMeshModule;

const MESH_UNAVAILABLE = new Error('Nearby mesh is not available on this platform');

/** Live state of the local mesh session, pushed from native. */
export interface MeshStatus {
  active: boolean;
  /** Riders in the same room currently connected over the mesh. */
  peers: number;
  error: string | null;
}

// Keep sends ordered and one at a time so a burst of hazards can't interleave or overtake each other.
let broadcastChain: Promise<unknown> = Promise.resolve();

export const nearbyMesh = {
  start(roomCode: string, riderName: string): Promise<void> {
    return Platform.OS === 'android' && meshModule
      ? meshModule.startMeshSession(roomCode, riderName)
      : Promise.reject(MESH_UNAVAILABLE);
  },
  stop(): Promise<void> {
    return Platform.OS === 'android' && meshModule ? meshModule.stopMeshSession() : Promise.resolve();
  },
  broadcast(packet: HazardPacket): Promise<void> {
    if (Platform.OS !== 'android' || !meshModule) {
      return Promise.reject(MESH_UNAVAILABLE);
    }
    const module = meshModule;
    const run = broadcastChain.then(() => module.broadcastHazard(serializeHazardPacket(packet)));
    broadcastChain = run.catch(() => {});
    return run;
  },
  /** Subscribes to hazards heard over the mesh; invalid/stale packets are dropped. */
  onHazardReceived(callback: (packet: HazardPacket) => void): () => void {
    const subscription = DeviceEventEmitter.addListener('onHazardReceived', (raw: unknown) => {
      const packet = typeof raw === 'string' ? parseHazardPacket(raw) : null;
      if (packet) {
        callback(packet);
      }
    });
    return () => subscription.remove();
  },
  onStatus(callback: (status: MeshStatus) => void): () => void {
    const subscription = DeviceEventEmitter.addListener('onMeshStatus', (raw: unknown) => {
      try {
        const parsed = JSON.parse(String(raw)) as Partial<MeshStatus>;
        callback({
          active: parsed.active === true,
          peers: typeof parsed.peers === 'number' ? parsed.peers : 0,
          error: typeof parsed.error === 'string' ? parsed.error : null,
        });
      } catch {
        // ignore a malformed status push
      }
    });
    return () => subscription.remove();
  },
};
