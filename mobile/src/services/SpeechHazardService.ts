import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';
import { createHazardPacket, type HazardPacket, type HazardType } from '../protocol/hazardProtocol';
import { HAZARD_THROTTLE_MS } from '../protocol/hazardPolicy';

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
export {
  HAZARD_THROTTLE_MS,
  claimHazardWindow,
  isWithinHazardWindow,
  rememberHazardOnce,
} from '../protocol/hazardPolicy';

export const HAZARD_RULES = [
  {
    id: 'missed_turn',
    label: 'Missed turn',
    phrases: [
      'missed turn',
      'missed the turn',
      'wrong way',
      'wrong turn',
      'wrong exit',
      'route changed',
      'turn back',
      'wrong direction',
      'wrong road',
      'wrong route',
      'miss the done',
      'miss the turn',
      'missed the done',
      'missed the dun',
      'route is wrong',
      'you missed our turn',
    ],
  },
  {
    id: 'fuel',
    label: 'Low fuel',
    phrases: [
      'fuel',
      'low fuel',
      'petrol low',
      'need petrol',
      'fuel empty',
      'need gas',
      'gas station',
      'petrol pump',
      'get petrol',
      'petrol is low',
    ],
  },
  {
    id: 'pothole',
    label: 'Pothole',
    phrases: [
      'pothole',
      'rough road',
      'bad road',
      'bump',
      'broken road',
      'bumpy road',
      'damaged road',
      'rough patch',
      'speed breaker',
      'uneven road',
      'bad patch ahead',
      'road is bad',
      'road is bumpy',
      'road is rough',
      'road surface is bad',
    ],
  },
  {
    id: 'gravel',
    label: 'Gravel',
    phrases: ['gravel', 'sand', 'loose rocks', 'loose stones', 'stones on the road'],
  },
  {
    id: 'roadkill',
    label: 'Roadkill',
    phrases: [
      'roadkill',
      'animal ahead',
      'animal crossing',
      'cow ahead',
      'dead animal',
      'dog ahead',
      'road kill',
      'animal in front',
      'watch for animals',
      'watch the animal',
      'animal in the road',
      'animal on the left',
      'animal on the right',
      'animal on the road',
      'cow on the road',
      'dog on the road',
    ],
  },
  {
    id: 'obstacle',
    label: 'Obstacle ahead',
    phrases: [
      'hazard',
      'obstacle',
      'blocked',
      'road block',
      'roadblock',
      'debris',
      'rocks',
      'construction ahead',
      'construction vehicle',
      'construction zone',
      'dead end',
      'fallen branch',
      'fallen tree',
      'no entry',
      'object ahead',
      'railroad crossing',
      'railway crossing',
      'road closed',
      'road construction',
      'road work',
      'tracks ahead',
      'train ahead',
      'train crossing',
      'tree ahead',
      'work zone',
      'workers ahead',
      'railway track ahead',
      'road is closed',
      'tree blocking road',
      'branch on the road',
      'branches on the road',
      'construction on the road',
      'object on the road',
      'something blocking the road',
      'something in the road',
      'something on the road',
      'tree blocking the road',
      'tree on the road',
      'blocking the road',
      'blocking road',
      'road blocking',
    ],
  },
  {
    id: 'police',
    label: 'Police',
    phrases: ['police', 'cop', 'checkpoint', 'speed trap', 'speed camera'],
  },
  {
    id: 'accident',
    label: 'Accident',
    phrases: [
      'crash',
      'accident',
      'rider down',
      'fallen',
      'collision',
      'help me',
      'need help',
      'rider crashed',
      'someone crashed',
      'rider needs assistance',
      'rider needs help',
      'someone is down',
      'someone needs help',
      'stop and help',
      'we have an emergency',
    ],
  },
  {
    id: 'slippery',
    label: 'Slippery road',
    phrases: [
      'oil',
      'slippery',
      'wet road',
      'water logging',
      'deep water',
      'flood ahead',
      'flooded road',
      'flooding ahead',
      'heavy rain',
      'rain ahead',
      'rain coming',
      'water ahead',
      'waterlogged road',
      'road is flooded',
      'road is wet',
      'water on road',
      'water across the road',
      'water on the road',
    ],
  },
  {
    id: 'slow',
    label: 'Slow down',
    phrases: [
      'slow',
      'slow down',
      'reduce speed',
      'drive slow',
      'caution',
      'brake',
      'pedestrian',
      'be careful',
      'careful ahead',
      'cars ahead',
      'congested road',
      'drive slower',
      'dust ahead',
      'dust cloud',
      'fog ahead',
      'go slower',
      'heavy fog',
      'heavy traffic',
      'people crossing',
      'person ahead',
      'person crossing',
      'poor visibility',
      'ride slower',
      'smoke ahead',
      'someone crossing',
      'traffic ahead',
      'traffic coming',
      'traffic jam',
      'lots of cars',
      'lower your speed',
      'reduce your speed',
      'traffic is heavy',
      'visibility is low',
      'watch for pedestrians',
      'watch your speed',
      'can t see ahead',
      'people on the road',
      'person on the road',
    ],
  },
  {
    id: 'stop',
    label: 'Stop',
    phrases: [
      'stop',
      'pull over',
      'wait for me',
      'red light',
      'red signal',
      'signal ahead',
      'traffic light',
      'traffic signal',
      'wait here',
      'signal is red',
    ],
  },
  {
    id: 'vehicle_stopped',
    label: 'Vehicle stopped',
    phrases: [
      'vehicle stopped',
      'puncture',
      'bike stopped',
      'breakdown',
      'emergency stop',
      'stopped',
      'emergency',
      'bike problem',
      'engine problem',
      'flat tire',
      'flat tyre',
      'losing air',
      'mechanical problem',
      'bike broke down',
      'bike has broken down',
      'bike is not working',
      'bike will not start',
      'bike won t start',
      'cannot start the bike',
      'front tire is flat',
      'front tyre is flat',
      'my tire is flat',
      'my tyre is flat',
      'rear tire is flat',
      'rear tyre is flat',
      'can t start the bike',
    ],
  },
  {
    id: 'sharp_turn',
    label: 'Sharp turn',
    phrases: [
      'sharp turn',
      'blind curve',
      'hairpin bend',
      'curve ahead',
      'blind turn',
      'corner ahead',
      'dangerous curve',
      'dangerous turn',
      'hairpin ahead',
      'hairpin turn',
      'sharp corner',
      'sharp curve',
      'tight corner',
      'tight turn',
    ],
  },
] as const;

export const HAZARD_TYPES = {
  LOW_FUEL: 'fuel',
  SLOW_DOWN: 'slow',
  VEHICLE_STOPPED: 'vehicle_stopped',
  SHARP_TURN: 'sharp_turn',
} as const satisfies Record<string, HazardType>;

const CUSTOM_ANNOUNCEMENTS: Partial<Record<HazardType, string>> = {
  [HAZARD_TYPES.LOW_FUEL]: 'Rider reported low fuel. Fuel stop needed.',
  [HAZARD_TYPES.SLOW_DOWN]: 'Caution. Slow down ahead.',
  [HAZARD_TYPES.VEHICLE_STOPPED]: "Alert: A group member's vehicle has stopped.",
  [HAZARD_TYPES.SHARP_TURN]: 'Warning: Sharp turn ahead.',
};

export const HAZARD_LABELS = Object.fromEntries(
  HAZARD_RULES.map(rule => [rule.id, rule.label]),
) as Record<HazardType, string>;

export const TTS_ECHO_TAIL_MS = 2500;

export interface EchoGuard {
  begin(): void;
  end(now?: number): void;
  isEchoLikely(now?: number): boolean;
}

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

const ANNOUNCEMENT_PHRASES = [
  'fuel stop needed',
  'caution slow down ahead',
  'vehicle has stopped',
  'group member',
  'warning sharp turn',
];

export function isAnnouncementEcho(text: string): boolean {
  const padded = ` ${(text.toLowerCase().match(/[a-z]+/g) ?? []).join(' ')} `;
  return (
    padded.includes(' reported ') ||
    ANNOUNCEMENT_PHRASES.some(phrase => padded.includes(` ${phrase} `))
  );
}

export function extractHazards(text: string): HazardType[] {
  const padded = ` ${(text.toLowerCase().match(/[a-z]+/g) ?? []).join(' ')} `;

  const hits: { id: HazardType; start: number; end: number }[] = [];
  for (const rule of HAZARD_RULES) {
    for (const phrase of rule.phrases) {
      const needle = ` ${phrase} `;
      for (let at = padded.indexOf(needle); at >= 0; at = padded.indexOf(needle, at + 1)) {
        hits.push({ id: rule.id, start: at, end: at + needle.length });
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
    if (!swallowed && (firstAt.get(hit.id) ?? Infinity) > hit.start) {
      firstAt.set(hit.id, hit.start);
    }
  }
  return [...firstAt].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

export interface SpokenWord {
  word: string;
  conf: number;
}

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

export const GRAMMAR_MIN_CONFIDENCE = 0.85;

export const GRAMMAR_DISTRUSTED_PHRASES: ReadonlySet<string> = new Set([
  'police',
  'bump',
  'debris',
  'stopped',
]);

export interface SpeechPayload {
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
          typeof w?.word === 'string' && typeof w?.conf === 'number'
            ? [{ word: w.word, conf: w.conf }]
            : [],
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

interface VoiceHazardNative {
  startListening(): Promise<void>;
  stopListening(): Promise<void>;
}

const voiceModule: VoiceHazardNative | undefined = NativeModules.VoiceHazardModule;

export interface SpeechHazardOptions {
  senderId: string;
  senderName: string;
  onHazard: (packet: HazardPacket) => void;
  onHeard?: (text: string) => void;
  isEchoLikely?: () => boolean;
  onError?: (message: string) => void;
}

export function startSpeechHazardDetection(options: SpeechHazardOptions): () => void {
  const { senderId, senderName, onHazard, onHeard, isEchoLikely, onError } = options;

  if (Platform.OS !== 'android' || !voiceModule) {
    onError?.('Voice hazard detection is not available on this platform');
    return () => {};
  }

  const lastRaisedAt = new Map<HazardType, number>();

  const handleSpeech = (raw: unknown, isFinal: boolean) => {
    if (!isFinal) {
      return;
    }
    const { source, text, words } = parseSpeechPayload(raw);
    if (source === 'free' && text) {
      onHeard?.(text);
    }
    if (isEchoLikely?.() || isAnnouncementEcho(text)) {
      return;
    }
    const now = Date.now();
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

interface RidezzTtsNative {
  speak(text: string): Promise<void>;
}

const ttsModule: RidezzTtsNative | undefined = NativeModules.RidezzTtsModule;

export function buildHazardAnnouncement(packet: HazardPacket): string {
  if (packet.hazard === 'accident' && packet.sos) {
    return `${packet.senderName} may have crashed.`;
  }
  if (packet.hazard === 'info') {
    return `${packet.senderName} says: ${packet.message ?? ''}`;
  }
  return (
    CUSTOM_ANNOUNCEMENTS[packet.hazard] ??
    `${packet.senderName} reported ${HAZARD_LABELS[packet.hazard]}.`
  );
}

export function speakHazardAudio(packet: HazardPacket): Promise<void> {
  if (Platform.OS !== 'android' || !ttsModule) {
    return Promise.resolve();
  }
  return ttsModule.speak(buildHazardAnnouncement(packet)).catch(() => {});
}

export function speakText(text: string): Promise<void> {
  if (Platform.OS !== 'android' || !ttsModule) {
    return Promise.resolve();
  }
  return ttsModule.speak(text).catch(() => {});
}
