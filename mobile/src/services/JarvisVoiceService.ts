import { DeviceEventEmitter } from 'react-native';
import { isAnnouncementEcho, parseSpeechPayload } from './SpeechHazardService';

/**
 * "Jarvis": a hands-free voice note. A rider says the wake phrase, speaks a short message, and
 * it's dispatched to the group over the mesh (see meshSyncManager's raiseVoiceInfo/VOICE_INFO).
 *
 * WAKE_PHRASE is deliberately plain, common English ("send message"), not a proper noun -- "hello
 * jarvis" was tried first and failed in on-device testing: the bundled small Vosk model has no
 * reliable way to recognise "jarvis" (not a word in its effective vocabulary) and consistently
 * substituted a phonetically similar common word instead ("hello journalists", "hello database").
 * No code-level fix can correct a model mishearing a specific word -- the fix is a phrase built
 * from ordinary words the model already transcribes cleanly.
 *
 * Deliberately simple otherwise: no wake-word speaker verification (this project has no
 * speaker-ID capability -- Vosk only transcribes words, it doesn't know whose voice it heard), so
 * the phrase activates for whoever says it. No custom silence/VAD timer either -- Vosk already
 * finalizes an utterance on its own built-in endpointing, exactly the same finished-utterance
 * event hazard detection already relies on (see SpeechHazardService); the next finished utterance
 * after the wake phrase IS the dictated message.
 *
 * This module never starts or stops the microphone itself -- startSpeechHazardDetection already
 * keeps it running for the whole ride. It only adds its own listener on the same onSpeechResult
 * stream, the same way a second DeviceEventEmitter subscriber always can.
 */

const WAKE_PHRASE = 'send message';

/** How long to wait, after the prompt finishes playing, for the rider to actually say something --
 * gives up and returns to idle rather than waiting forever for an utterance that was never coming.
 * Generous relative to TTS_ECHO_TAIL_MS (2.5s): that guard window still has to pass, inside this
 * one, before anything the rider says can be heard at all. */
export const JARVIS_DICTATION_TIMEOUT_MS = 6000;

/** A dictated note is capped to this length before being sent -- keeps one voice note from
 * ballooning the mesh payload the way an unbounded transcript could. */
export const JARVIS_MAX_MESSAGE_LENGTH = 200;

/**
 * Finds WAKE_PHRASE as a whole phrase (word-boundary, case-insensitive) in `text`, returning
 * whatever follows it in the SAME utterance. Handles a rider saying it all in one breath ("send
 * message taking a fuel break") without waiting for a separate dictation turn; an empty remainder
 * means nothing followed yet, so the normal prompt-and-wait flow applies.
 */
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

/** Trims and length-caps a dictated message before it's sent. */
export function sanitizeVoiceMessage(text: string): string {
  return text.trim().slice(0, JARVIS_MAX_MESSAGE_LENGTH);
}

export interface JarvisVoiceOptions {
  /** Called once a message has been dictated -- the caller dispatches it (see
   * meshSyncManager.raiseVoiceInfo). Never called with an empty message. */
  onMessage: (message: string) => void;
  /** Speaks a line through the app's own TTS/echo-guard path -- same contract as
   * useCrashDetection's `announce`: the caller wraps it with the echo guard and audio ducking. */
  announce: (text: string) => Promise<void> | void;
  /** True while this phone's own speaker is (or just was) playing, so Jarvis never reacts to its
   * own prompt or to a received voice note's readout. */
  isEchoLikely: () => boolean;
  dictationTimeoutMs?: number;
}

/** Starts the wake-word + dictation listener. Returns a stop function. */
export function startJarvisVoice(options: JarvisVoiceOptions): () => void {
  const { onMessage, announce, isEchoLikely, dictationTimeoutMs = JARVIS_DICTATION_TIMEOUT_MS } = options;

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
    // The "say something now" clock starts only once the prompt has actually finished playing --
    // starting it immediately (as this used to) burns most of the window on the prompt's own TTS
    // playback (it takes real seconds to speak a sentence) plus the shared echo guard's tail
    // afterward, leaving almost no time for the rider to actually reply before it gives up.
    Promise.resolve(announce('What message should I send?'))
      .catch(() => {})
      .then(() => {
        if (stopped || phase !== 'awaiting_dictation') {
          return; // stopped, or dictation already finished, while the prompt was still playing
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
    // Only the full-vocabulary recognizer reads ordinary speech properly -- same reasoning as
    // SpeechHazardService's onHeard line; the grammar recognizer is tuned for hazard phrases.
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
    // phase === 'awaiting_dictation': this finished utterance IS the dictated message.
    finishDictation(text);
  });

  return () => {
    stopped = true;
    clearTimer();
    subscription.remove();
  };
}
