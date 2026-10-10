import { DeviceEventEmitter } from 'react-native';
import {
  JARVIS_DICTATION_TIMEOUT_MS,
  JARVIS_MAX_MESSAGE_LENGTH,
  matchWakePhrase,
  sanitizeVoiceMessage,
  startJarvisVoice,
} from '../src/services/JarvisVoiceService';

describe('matchWakePhrase', () => {
  it('matches the wake phrase on its own, with no remainder', () => {
    expect(matchWakePhrase('send message')).toEqual({ matched: true, remainder: '' });
  });

  it('is case-insensitive and ignores punctuation', () => {
    expect(matchWakePhrase('Send, message!')).toEqual({ matched: true, remainder: '' });
  });

  it('captures whatever follows in the same utterance', () => {
    expect(matchWakePhrase('send message taking a fuel break')).toEqual({
      matched: true,
      remainder: 'taking a fuel break',
    });
  });

  it('does not match when the phrase is absent', () => {
    expect(matchWakePhrase('lovely day for a ride')).toEqual({ matched: false, remainder: '' });
  });

  it('does not match a partial phrase', () => {
    expect(matchWakePhrase('send it over')).toEqual({ matched: false, remainder: '' });
    expect(matchWakePhrase('message received')).toEqual({ matched: false, remainder: '' });
  });
});

describe('sanitizeVoiceMessage', () => {
  it('trims surrounding whitespace', () => {
    expect(sanitizeVoiceMessage('  taking a fuel break  ')).toBe('taking a fuel break');
  });

  it('caps length at JARVIS_MAX_MESSAGE_LENGTH', () => {
    const long = 'a'.repeat(JARVIS_MAX_MESSAGE_LENGTH + 50);
    expect(sanitizeVoiceMessage(long)).toHaveLength(JARVIS_MAX_MESSAGE_LENGTH);
  });
});

describe('startJarvisVoice', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const speak = (text: string) => DeviceEventEmitter.emit('onSpeechResult', JSON.stringify({ text }));

  // The announce() -> .catch() -> .then() chain that starts the dictation timeout is a few
  // microtask hops deep; flush several ticks so fake-timer tests land after it's actually run,
  // the same way it would have settled for real between the prompt finishing and the clock starting.
  const flushMicrotasks = async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  };

  function harness(overrides: { isEchoLikely?: () => boolean } = {}) {
    const onMessage = jest.fn();
    const announce = jest.fn(() => Promise.resolve());
    const stop = startJarvisVoice({
      onMessage,
      announce,
      isEchoLikely: overrides.isEchoLikely ?? (() => false),
    });
    return { onMessage, announce, stop };
  }

  it('ignores ordinary speech with no wake phrase', () => {
    const { onMessage, announce, stop } = harness();
    speak('lovely day for a ride');
    expect(announce).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    stop();
  });

  it('prompts after the wake phrase, then dispatches the next utterance as the message', () => {
    const { onMessage, announce, stop } = harness();
    speak('send message');
    expect(announce).toHaveBeenCalledWith('What message should I send?');

    speak('taking a fuel break');
    expect(onMessage).toHaveBeenCalledWith('taking a fuel break');
    stop();
  });

  it('dispatches immediately when the message is said in the same breath as the wake phrase', () => {
    const { onMessage, announce, stop } = harness();
    speak('send message taking a fuel break');
    expect(onMessage).toHaveBeenCalledWith('taking a fuel break');
    expect(announce).not.toHaveBeenCalled(); // no prompt needed -- nothing to wait for
    stop();
  });

  it('gives up and announces "Cancelled" if nothing is said within the dictation timeout', async () => {
    const { onMessage, announce, stop } = harness();
    speak('send message');
    await flushMicrotasks();
    jest.advanceTimersByTime(JARVIS_DICTATION_TIMEOUT_MS);
    expect(announce).toHaveBeenCalledWith('Cancelled');
    expect(onMessage).not.toHaveBeenCalled();

    // Back to idle: a later utterance needs the wake phrase again, not treated as dictation.
    speak('taking a fuel break');
    expect(onMessage).not.toHaveBeenCalled();
    stop();
  });

  it('never reacts while this phone\'s own speaker is playing (echo guard)', () => {
    const { onMessage, announce, stop } = harness({ isEchoLikely: () => true });
    speak('send message');
    expect(announce).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    stop();
  });

  it('ignores an empty finished utterance', () => {
    const { onMessage, announce, stop } = harness();
    speak('');
    expect(announce).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    stop();
  });

  it('stop() removes the listener and clears a pending timeout', async () => {
    const { onMessage, announce, stop } = harness();
    speak('send message');
    await flushMicrotasks();
    stop();
    jest.advanceTimersByTime(JARVIS_DICTATION_TIMEOUT_MS);
    expect(announce).toHaveBeenCalledTimes(1); // only the prompt -- no "Cancelled" after stop()
    speak('taking a fuel break');
    expect(onMessage).not.toHaveBeenCalled(); // no longer listening at all
  });

  it('a pending timeout started just before stop() is still suppressed', async () => {
    const { announce, stop } = harness();
    speak('send message');
    stop(); // stops before the announce() microtask (and its .then()) has even run
    await flushMicrotasks();
    jest.advanceTimersByTime(JARVIS_DICTATION_TIMEOUT_MS);
    expect(announce).toHaveBeenCalledTimes(1); // only the prompt -- stopped flag blocked the timer
  });
});
