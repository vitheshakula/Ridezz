import { ConnectionState } from 'livekit-client';
import { classifyConnectionTransition } from '../src/utils/connectionCues';

describe('classifyConnectionTransition', () => {
  it('returns null for the initial Connecting -> Connected (a join, not a restore)', () => {
    expect(
      classifyConnectionTransition(ConnectionState.Connecting, ConnectionState.Connected),
    ).toBeNull();
  });

  it('returns "lost" when a healthy connection drops into Reconnecting', () => {
    expect(
      classifyConnectionTransition(ConnectionState.Connected, ConnectionState.Reconnecting),
    ).toBe('lost');
  });

  it('returns "lost" when a healthy connection drops into SignalReconnecting', () => {
    expect(
      classifyConnectionTransition(ConnectionState.Connected, ConnectionState.SignalReconnecting),
    ).toBe('lost');
  });

  it('returns "restored" when Reconnecting recovers to Connected', () => {
    expect(
      classifyConnectionTransition(ConnectionState.Reconnecting, ConnectionState.Connected),
    ).toBe('restored');
  });

  it('returns "restored" when SignalReconnecting recovers to Connected', () => {
    expect(
      classifyConnectionTransition(ConnectionState.SignalReconnecting, ConnectionState.Connected),
    ).toBe('restored');
  });

  it('returns null for repeated Reconnecting states (no duplicate cue for the same drop)', () => {
    expect(
      classifyConnectionTransition(ConnectionState.Reconnecting, ConnectionState.SignalReconnecting),
    ).toBeNull();
  });

  it('returns null for repeated Connected states', () => {
    expect(
      classifyConnectionTransition(ConnectionState.Connected, ConnectionState.Connected),
    ).toBeNull();
  });

  it('returns null when disconnecting from Connected (not a reconnect cue)', () => {
    expect(
      classifyConnectionTransition(ConnectionState.Connected, ConnectionState.Disconnected),
    ).toBeNull();
  });
});
