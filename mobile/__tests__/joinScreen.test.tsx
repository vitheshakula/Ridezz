import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer, { type ReactTestInstance } from 'react-test-renderer';
import JoinScreen from '../src/screens/JoinScreen';
import { api } from '../src/services/AuthService';
import { geocodeDestination } from '../src/services/destinationService';

/**
 * JoinScreen is where two features meet: the destination / host handling, and the signed-in API
 * client. These tests pin down both, and how they interact.
 */
const mockLogout = jest.fn();
let mockAuth: { user: { id: string; name: string } | null; token: string | null; logout: jest.Mock };

jest.mock('../src/context/AuthContext', () => ({ useAuth: () => mockAuth }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../src/services/AuthService', () => ({ api: { post: jest.fn() } }));
jest.mock('../src/services/destinationService', () => ({ geocodeDestination: jest.fn() }));

const post = api.post as jest.Mock;
const geocode = geocodeDestination as jest.Mock;

const onJoined = jest.fn();
const navigation = { navigate: jest.fn() };

const roomReply = (over: Record<string, unknown> = {}) => ({
  data: {
    roomCode: 'ABC234',
    roomId: 'r1',
    isHost: false,
    token: 'livekit-token',
    serverUrl: 'wss://livekit.test',
    destinationName: null,
    destinationLat: null,
    destinationLng: null,
    ...over,
  },
});

const fort = { name: 'Golconda Fort, Hyderabad', latitude: 17.3833, longitude: 78.4011 };

let renderer: ReactTestRenderer.ReactTestRenderer;
function render() {
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<JoinScreen onJoined={onJoined} navigation={navigation} />);
  });
  return renderer.root;
}

const input = (root: ReactTestInstance, placeholder: string) =>
  root.find(node => node.props.placeholder === placeholder && typeof node.type === 'string');

const type = (root: ReactTestInstance, placeholder: string, value: string) =>
  ReactTestRenderer.act(() => {
    input(root, placeholder).props.onChangeText(value);
  });

/** The pressable wrapping the Text with this exact label. */
function pressableLabelled(root: ReactTestInstance, label: string) {
  const text = root.findAllByType(Text).find(t => t.props.children === label);
  if (!text) {
    throw new Error(`no text "${label}"`);
  }
  let node: ReactTestInstance | null = text;
  while (node && typeof node.props.onPress !== 'function') {
    node = node.parent;
  }
  if (!node) {
    throw new Error(`nothing pressable around "${label}"`);
  }
  return node;
}

const press = (root: ReactTestInstance, label: string) =>
  ReactTestRenderer.act(async () => {
    await pressableLabelled(root, label).props.onPress();
  });

const screenText = () => JSON.stringify(renderer.toJSON());

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = { user: { id: 'u1', name: 'Alex' }, token: 'app-jwt', logout: mockLogout };
});

describe('JoinScreen', () => {
  describe('the rider', () => {
    it("shows the account's name and pre-fills it as the rider name", () => {
      const root = render();
      expect(screenText()).toContain('Alex');
      expect(input(root, 'e.g. Alex').props.value).toBe('Alex');
    });
  });

  describe('joining a room', () => {
    it('sends the code and rider name through the signed-in client, and starts the ride as a guest', async () => {
      post.mockResolvedValue(
        roomReply({ destinationName: fort.name, destinationLat: fort.latitude, destinationLng: fort.longitude }),
      );
      const root = render();
      type(root, 'e.g. 8K2M9X', 'abc234');
      await press(root, 'Join Ride');

      // No hand-built Authorization header: the shared client adds the bearer token itself.
      expect(post).toHaveBeenCalledWith('/rooms/join', { roomCode: 'ABC234', riderName: 'Alex' }, { timeout: 8000 });
      expect(onJoined).toHaveBeenCalledWith({
        serverUrl: 'wss://livekit.test',
        token: 'livekit-token',
        riderName: 'Alex',
        roomCode: 'ABC234',
        isHost: false,
        destination: fort,
      });
    });

    it('starts with no destination when the room has none', async () => {
      post.mockResolvedValue(roomReply());
      const root = render();
      type(root, 'e.g. 8K2M9X', 'ABC234');
      await press(root, 'Join Ride');

      expect(onJoined.mock.calls[0][0].destination).toBeNull();
    });

    it('asks for a code before contacting the server', async () => {
      const root = render();
      await press(root, 'Join Ride');

      expect(screenText()).toContain('Please enter the 6-character room code.');
      expect(post).not.toHaveBeenCalled();
    });

    it('shows the servers reason when the room is not found, and does not start a ride', async () => {
      post.mockRejectedValue(
        Object.assign(new Error('x'), {
          isAxiosError: true,
          response: { status: 404, data: { message: 'Ride room not found. Check the 6-character code.' } },
        }),
      );
      const root = render();
      type(root, 'e.g. 8K2M9X', 'ZZZZZZ');
      await press(root, 'Join Ride');

      expect(screenText()).toContain('Ride room not found. Check the 6-character code.');
      expect(onJoined).not.toHaveBeenCalled();
      expect(mockLogout).not.toHaveBeenCalled();
    });
  });

  describe('creating a room', () => {
    const openCreateTab = (root: ReactTestInstance) =>
      ReactTestRenderer.act(() => {
        pressableLabelled(root, 'CREATE ROOM').props.onPress();
      });

    it('looks the destination up, sends it with the rider name, and starts the ride as host', async () => {
      geocode.mockResolvedValue(fort);
      post.mockResolvedValue(
        roomReply({
          isHost: true,
          destinationName: fort.name,
          destinationLat: fort.latitude,
          destinationLng: fort.longitude,
        }),
      );
      const root = render();
      openCreateTab(root);
      type(root, 'e.g. Golconda Fort, Hyderabad', 'Golconda Fort');
      await press(root, 'Create & Start Ride');

      expect(geocode).toHaveBeenCalledWith('Golconda Fort');
      expect(post).toHaveBeenCalledWith(
        '/rooms/create',
        {
          riderName: 'Alex',
          destinationName: fort.name,
          destinationLat: fort.latitude,
          destinationLng: fort.longitude,
        },
        { timeout: 8000 },
      );
      expect(onJoined).toHaveBeenCalledWith(expect.objectContaining({ isHost: true, destination: fort }));
    });

    it('creates a room without a destination when none is typed, and never calls the geocoder', async () => {
      post.mockResolvedValue(roomReply({ isHost: true }));
      const root = render();
      openCreateTab(root);
      await press(root, 'Create & Start Ride');

      expect(geocode).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledWith(
        '/rooms/create',
        { riderName: 'Alex', destinationName: undefined, destinationLat: undefined, destinationLng: undefined },
        { timeout: 8000 },
      );
      expect(onJoined).toHaveBeenCalledWith(expect.objectContaining({ isHost: true, destination: null }));
    });

    it('stops and explains when the destination cannot be found, without creating a room', async () => {
      geocode.mockResolvedValue(null);
      const root = render();
      openCreateTab(root);
      type(root, 'e.g. Golconda Fort, Hyderabad', 'asdfghjkl');
      await press(root, 'Create & Start Ride');

      expect(screenText()).toContain('Couldn');
      expect(screenText()).toContain('asdfghjkl');
      expect(post).not.toHaveBeenCalled();
      expect(onJoined).not.toHaveBeenCalled();
    });
  });

  describe('an expired or rejected sign-in', () => {
    it('signs the rider out and sends them to the sign-in screen, instead of showing an error', async () => {
      post.mockRejectedValue(
        Object.assign(new Error('x'), { isAxiosError: true, response: { status: 401, data: { message: 'Authentication required.' } } }),
      );
      const root = render();
      type(root, 'e.g. 8K2M9X', 'ABC234');
      await press(root, 'Join Ride');

      expect(mockLogout).toHaveBeenCalledTimes(1);
      expect(navigation.navigate).toHaveBeenCalledWith('LoginPage');
      expect(onJoined).not.toHaveBeenCalled();
      expect(screenText()).not.toContain('Authentication required.');
    });

    it('does not even try when there is no saved token', async () => {
      mockAuth.token = null;
      const root = render();
      type(root, 'e.g. 8K2M9X', 'ABC234');
      await press(root, 'Join Ride');

      expect(screenText()).toContain('Your session has expired. Please sign in again.');
      expect(post).not.toHaveBeenCalled();
    });

    it('does not treat an ordinary server error as a lost sign-in', async () => {
      post.mockRejectedValue(
        Object.assign(new Error('x'), { isAxiosError: true, response: { status: 500, data: {} } }),
      );
      const root = render();
      type(root, 'e.g. 8K2M9X', 'ABC234');
      await press(root, 'Join Ride');

      expect(mockLogout).not.toHaveBeenCalled();
      expect(navigation.navigate).not.toHaveBeenCalled();
      expect(screenText()).toContain('The server had a problem');
    });
  });

  it('logs out from the top bar and returns to the sign-in screen', async () => {
    const root = render();
    await press(root, 'Log Out');

    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).toHaveBeenCalledWith('LoginPage');
  });
});
