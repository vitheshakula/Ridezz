import { DeviceEventEmitter } from 'react-native';
import { isAnnouncementEcho, parseSpeechPayload } from './SpeechHazardService';

const WAKE_PHRASE = 'send message';

export const JARVIS_DICTATION_TIMEOUT_MS = 6000;

export const JARVIS_MAX_MESSAGE_LENGTH = 200;

export function matchWakePhrase(text: string): { matched: boolean; remainder: string } {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const padded = ` ${words.join(' ')} `;
  const needle = ` ${WAKE_PHRASE} `;
  const at = padded.indexOf(needle);
  if (at < 0) {
    return { matched: false, remainder: '' };
  }
  return { matched: true, remainder: padded.slice(at + needle.length).trim() };
}

export function sanitizeVoiceMessage(text: string): string {
  return text.trim().slice(0, JARVIS_MAX_MESSAGE_LENGTH);
}

export interface JarvisVoiceOptions {
  onMessage: (message: string) => void;
  announce: (text: string) => Promise<void> | void;
  isEchoLikely: () => boolean;
  dictationTimeoutMs?: number;
}

export function startJarvisVoice(options: JarvisVoiceOptions): () => void {
  const {
    onMessage,
    announce,
    isEchoLikely,
    dictationTimeoutMs = JARVIS_DICTATION_TIMEOUT_MS,
  } = options;

  console.log('[Jarvis] listener started');
  type Phase = 'idle' | 'awaiting_dictation';
  let phase: Phase = 'idle';
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function clearTimer(): void {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
  }

  function beginDictation(): void {
    console.log('[Jarvis] wake phrase matched -> prompting for dictation');
    phase = 'awaiting_dictation';
    clearTimer();
    Promise.resolve(announce('What message should I send?'))
      .catch(() => {})
      .then(() => {
        if (stopped || phase !== 'awaiting_dictation') {
          return;
        }
        timeoutTimer = setTimeout(() => {
          console.log('[Jarvis] dictation timed out with nothing heard -> back to idle');
          phase = 'idle';
          Promise.resolve(announce('Cancelled')).catch(() => {});
        }, dictationTimeoutMs);
      });
  }

  function finishDictation(text: string): void {
    clearTimer();
    phase = 'idle';
    const message = sanitizeVoiceMessage(text);
    console.log(`[Jarvis] dictation finished: "${message}"`);
    if (message) {
      onMessage(message);
    }
  }

  const subscription = DeviceEventEmitter.addListener('onSpeechResult', (raw: unknown) => {
    const { source, text } = parseSpeechPayload(raw);
    if (source !== 'free' || !text) {
      return;
    }
    console.log(`[Jarvis] heard (phase=${phase}): "${text}"`);
    if (isEchoLikely() || isAnnouncementEcho(text)) {
      console.log('[Jarvis] ignored -- echo guard or own announcement wording');
      return;
    }
    if (phase === 'idle') {
      const { matched, remainder } = matchWakePhrase(text);
      if (!matched) {
        return;
      }
      if (remainder) {
        finishDictation(remainder);
      } else {
        beginDictation();
      }
      return;
    }
    finishDictation(text);
  });

  return () => {
    stopped = true;
    clearTimer();
    subscription.remove();
  };
}
