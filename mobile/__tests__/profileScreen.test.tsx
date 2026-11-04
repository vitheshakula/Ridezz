import React from 'react';
import ReactTestRenderer, { type ReactTestInstance } from 'react-test-renderer';
import Clipboard from '@react-native-clipboard/clipboard';
import ProfileScreen from '../src/screens/ProfileScreen';
import { COPIED_FEEDBACK_MS } from '../src/components/RoomCodeCard';
import { fetchProfile } from '../src/services/AuthService';

const mockUpdateUser = jest.fn();
const mockLogout = jest.fn();
let mockAuth: {
  user: { id: string; email: string; name: string; roomCode?: string } | null;
  token: string | null;
  logout: jest.Mock;
  updateUser: jest.Mock;
};

jest.mock('../src/context/AuthContext', () => ({ useAuth: () => mockAuth }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../src/services/AuthService', () => ({ fetchProfile: jest.fn() }));

const profile = fetchProfile as jest.Mock;
const setString = Clipboard.setString as jest.Mock;

let renderer: ReactTestRenderer.ReactTestRenderer;
async function render() {
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(<ProfileScreen navigation={{ navigate: jest.fn() }} />);
  });
  return renderer.root;
}

const screenText = () => JSON.stringify(renderer.toJSON());

const card = (root: ReactTestInstance, label: string) =>
  root.findAll(
    node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function',
  )[0];

const tap = (node: ReactTestInstance) =>
  ReactTestRenderer.act(() => {
    node.props.onPress();
  });

const withCode = { id: 'u1', email: 'alex@gmail.com', name: 'Alex', roomCode: '54321' };

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = { user: withCode, token: 'app-jwt', logout: mockLogout, updateUser: mockUpdateUser };
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ProfileScreen room code', () => {
  it('shows the rider\'s permanent code prominently as "Room Code: 54321"', async () => {
    const root = await render();

    expect(screenText()).toContain('Room Code: ');
    expect(screenText()).toContain('54321');
    expect(card(root, 'Room Code: 54321. Tap to copy')).toBeDefined();
  });

  it('does not ask the server for a code the account already has', async () => {
    await render();
    expect(profile).not.toHaveBeenCalled();
  });

  it('copies the code to the clipboard when tapped, and says so', async () => {
    const root = await render();
    expect(screenText()).not.toContain('Copied to clipboard');

    tap(card(root, 'Room Code: 54321. Tap to copy'));

    expect(setString).toHaveBeenCalledTimes(1);
    expect(setString).toHaveBeenCalledWith('54321');
    expect(screenText()).toContain('Copied to clipboard');
  });

  it('puts the hint back once the confirmation has been up for a moment', async () => {
    jest.useFakeTimers();
    const root = await render();
    tap(card(root, 'Room Code: 54321. Tap to copy'));
    expect(screenText()).toContain('Copied to clipboard');

    ReactTestRenderer.act(() => {
      jest.advanceTimersByTime(COPIED_FEEDBACK_MS);
    });
    expect(screenText()).not.toContain('Copied to clipboard');
    expect(screenText()).toContain('Tap to copy');
  });

  it('copies the digits only, never the label', async () => {
    const root = await render();
    tap(card(root, 'Room Code: 54321. Tap to copy'));
    expect(setString.mock.calls[0][0]).toBe('54321');
  });

  it('still shows the account details around it', async () => {
    await render();
    expect(screenText()).toContain('Alex');
    expect(screenText()).toContain('alex@gmail.com');
  });

  describe('for an account saved before room codes existed', () => {
    beforeEach(() => {
      mockAuth.user = { id: 'u1', email: 'alex@gmail.com', name: 'Alex' };
    });

    it('fetches the code once and saves it on the account', async () => {
      profile.mockResolvedValue({
        id: 'u1',
        email: 'alex@gmail.com',
        name: 'Alex',
        roomCode: '27182',
      });
      await render();

      expect(profile).toHaveBeenCalledTimes(1);
      expect(mockUpdateUser).toHaveBeenCalledWith({
        id: 'u1',
        email: 'alex@gmail.com',
        name: 'Alex',
        roomCode: '27182',
      });
    });

    it('shows that it is loading, and copies nothing, until the code arrives', async () => {
      profile.mockReturnValue(new Promise(() => {}));
      const root = await render();

      expect(screenText()).toContain('Getting your room code');
      tap(card(root, 'Loading your room code'));
      expect(setString).not.toHaveBeenCalled();
    });

    it('offers a retry when the fetch fails, and never copies anything', async () => {
      profile.mockRejectedValueOnce(new Error('offline'));
      const root = await render();
      expect(screenText()).toContain("Couldn't load your room code");

      profile.mockResolvedValue({
        id: 'u1',
        email: 'alex@gmail.com',
        name: 'Alex',
        roomCode: '27182',
      });
      await ReactTestRenderer.act(async () => {
        card(root, 'Could not load your room code. Tap to retry').props.onPress();
      });

      expect(profile).toHaveBeenCalledTimes(2);
      expect(mockUpdateUser).toHaveBeenCalledWith(expect.objectContaining({ roomCode: '27182' }));
      expect(setString).not.toHaveBeenCalled();
    });

    it('treats a reply without a valid code as a failure', async () => {
      profile.mockResolvedValue({
        id: 'u1',
        email: 'alex@gmail.com',
        name: 'Alex',
        roomCode: null,
      });
      await render();

      expect(mockUpdateUser).not.toHaveBeenCalled();
      expect(screenText()).toContain("Couldn't load your room code");
    });
  });
});
