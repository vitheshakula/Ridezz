import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer, { type ReactTestInstance } from 'react-test-renderer';
import JoinScreen from '../src/screens/JoinScreen';
import { api, fetchProfile } from '../src/services/AuthService';
import { geocodeDestination, searchDestinations } from '../src/services/destinationService';

const mockLogout = jest.fn();
const mockUpdateUser = jest.fn();
let mockAuth: {
  user: { id: string; name: string; roomCode?: string } | null;
  token: string | null;
  logout: jest.Mock;
  updateUser: jest.Mock;
};

jest.mock('../src/context/AuthContext', () => ({ useAuth: () => mockAuth }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../src/services/AuthService', () => ({
  api: { post: jest.fn() },
  fetchProfile: jest.fn(),
}));
jest.mock('../src/services/destinationService', () => ({
  geocodeDestination: jest.fn(),
  searchDestinations: jest.fn(async () => []),
  MIN_SUGGESTION_QUERY_LENGTH: 3,
}));

const post = api.post as jest.Mock;
const profile = fetchProfile as jest.Mock;
const geocode = geocodeDestination as jest.Mock;
const search = searchDestinations as jest.Mock;

const onJoined = jest.fn();
const navigation = { navigate: jest.fn() };

const roomReply = (over: Record<string, unknown> = {}) => ({
  data: {
    roomCode: '54321',
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

function pressableLabelled(root: ReactTestInstance, label: string) {
  const text = root
    .findAllByType(Text)
    .filter(t => t.props.children === label)
    .pop();
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
  search.mockResolvedValue([]);
  mockAuth = {
    user: { id: 'u1', name: 'Alex', roomCode: '54321' },
    token: 'app-jwt',
    logout: mockLogout,
    updateUser: mockUpdateUser,
  };
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
        roomReply({
          destinationName: fort.name,
          destinationLat: fort.latitude,
          destinationLng: fort.longitude,
        }),
      );
      const root = render();
      type(root, 'e.g. 54321', '54321');
      await press(root, 'JOIN RIDE');

      expect(post).toHaveBeenCalledWith(
        '/rooms/join',
        { roomCode: '54321', riderName: 'Alex' },
        { timeout: 8000 },
      );
      expect(onJoined).toHaveBeenCalledWith({
        serverUrl: 'wss://livekit.test',
        token: 'livekit-token',
        riderName: 'Alex',
        roomCode: '54321',
        isHost: false,
        destination: fort,
      });
    });

    it('starts with no destination when the room has none', async () => {
      post.mockResolvedValue(roomReply());
      const root = render();
      type(root, 'e.g. 54321', '54321');
      await press(root, 'JOIN RIDE');

      expect(onJoined.mock.calls[0][0].destination).toBeNull();
    });

    it('asks for a code before contacting the server', async () => {
      const root = render();
      await press(root, 'JOIN RIDE');

      expect(screenText()).toContain('Please enter the 5-digit room code.');
      expect(post).not.toHaveBeenCalled();
    });

    it('shows the servers reason when the room is not found, and does not start a ride', async () => {
      post.mockRejectedValue(
        Object.assign(new Error('x'), {
          isAxiosError: true,
          response: {
            status: 404,
            data: { message: 'Ride room not found. Check the 5-digit code.' },
          },
        }),
      );
      const root = render();
      type(root, 'e.g. 54321', '99999');
      await press(root, 'JOIN RIDE');

      expect(screenText()).toContain('Ride room not found. Check the 5-digit code.');
      expect(onJoined).not.toHaveBeenCalled();
      expect(mockLogout).not.toHaveBeenCalled();
    });
  });

  describe('creating a room', () => {
    const openCreateTab = (root: ReactTestInstance) =>
      ReactTestRenderer.act(() => {
        pressableLabelled(root, 'CREATE RIDE').props.onPress();
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
      await press(root, 'CREATE RIDE');

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
      expect(onJoined).toHaveBeenCalledWith(
        expect.objectContaining({ isHost: true, destination: fort }),
      );
    });

    it('creates a room without a destination when none is typed, and never calls the geocoder', async () => {
      post.mockResolvedValue(roomReply({ isHost: true }));
      const root = render();
      openCreateTab(root);
      await press(root, 'CREATE RIDE');

      expect(geocode).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledWith(
        '/rooms/create',
        {
          riderName: 'Alex',
          destinationName: undefined,
          destinationLat: undefined,
          destinationLng: undefined,
        },
        { timeout: 8000 },
      );
      expect(onJoined).toHaveBeenCalledWith(
        expect.objectContaining({ isHost: true, destination: null }),
      );
    });

    it('stops and explains when the destination cannot be found, without creating a room', async () => {
      geocode.mockResolvedValue(null);
      const root = render();
      openCreateTab(root);
      type(root, 'e.g. Golconda Fort, Hyderabad', 'asdfghjkl');
      await press(root, 'CREATE RIDE');

      expect(screenText()).toContain('Couldn');
      expect(screenText()).toContain('asdfghjkl');
      expect(post).not.toHaveBeenCalled();
      expect(onJoined).not.toHaveBeenCalled();
    });

    it('offers suggestions while typing, and a picked one is sent exactly, without geocoding again', async () => {
      const bhel = {
        name: 'BHEL Township, Ramachandrapuram mandal, Telangana, India',
        latitude: 17.4911,
        longitude: 78.3056,
      };
      search.mockResolvedValue([bhel]);
      post.mockResolvedValue(roomReply({ isHost: true }));
      const root = render();
      openCreateTab(root);
      type(root, 'e.g. Golconda Fort, Hyderabad', 'bhel');
      await ReactTestRenderer.act(async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 600));
      });

      expect(search).toHaveBeenCalledWith('bhel');
      const suggestion = root.find(node => node.props.accessibilityLabel === `Use ${bhel.name}`);
      await ReactTestRenderer.act(async () => {
        suggestion.props.onPress();
      });
      expect(input(root, 'e.g. Golconda Fort, Hyderabad').props.value).toBe(bhel.name);

      await press(root, 'CREATE RIDE');
      expect(geocode).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledWith(
        '/rooms/create',
        {
          riderName: 'Alex',
          destinationName: bhel.name,
          destinationLat: bhel.latitude,
          destinationLng: bhel.longitude,
        },
        { timeout: 8000 },
      );
    });
  });

  describe('an expired or rejected sign-in', () => {
    it('signs the rider out and sends them to the sign-in screen, instead of showing an error', async () => {
      post.mockRejectedValue(
        Object.assign(new Error('x'), {
          isAxiosError: true,
          response: { status: 401, data: { message: 'Authentication required.' } },
        }),
      );
      const root = render();
      type(root, 'e.g. 54321', '54321');
      await press(root, 'JOIN RIDE');

      expect(mockLogout).toHaveBeenCalledTimes(1);
      expect(navigation.navigate).toHaveBeenCalledWith('LoginPage');
      expect(onJoined).not.toHaveBeenCalled();
      expect(screenText()).not.toContain('Authentication required.');
    });

    it('does not even try when there is no saved token', async () => {
      mockAuth.token = null;
      const root = render();
      type(root, 'e.g. 54321', '54321');
      await press(root, 'JOIN RIDE');

      expect(screenText()).toContain('Your session has expired. Please sign in again.');
      expect(post).not.toHaveBeenCalled();
    });

    it('does not treat an ordinary server error as a lost sign-in', async () => {
      post.mockRejectedValue(
        Object.assign(new Error('x'), { isAxiosError: true, response: { status: 500, data: {} } }),
      );
      const root = render();
      type(root, 'e.g. 54321', '54321');
      await press(root, 'JOIN RIDE');

      expect(mockLogout).not.toHaveBeenCalled();
      expect(navigation.navigate).not.toHaveBeenCalled();
      expect(screenText()).toContain('The server had a problem');
    });
  });

  describe('the room code input', () => {
    it('opens the number pad and allows at most five characters', () => {
      const props = input(render(), 'e.g. 54321').props;
      expect(props.keyboardType).toBe('number-pad');
      expect(props.maxLength).toBe(5);
    });

    it('keeps only digits, even if letters are pasted in, and never more than five', () => {
      const root = render();
      type(root, 'e.g. 54321', '5a4-3 2x1');
      expect(input(root, 'e.g. 54321').props.value).toBe('54321');

      type(root, 'e.g. 54321', '987654321');
      expect(input(root, 'e.g. 54321').props.value).toBe('98765');
    });

    it('does not contact the server for a code that is too short or starts with zero', async () => {
      for (const bad of ['1234', '01234', '']) {
        const root = render();
        type(root, 'e.g. 54321', bad);
        await press(root, 'JOIN RIDE');
        expect(screenText()).toContain('Please enter the 5-digit room code.');
      }
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe("the rider's own room code on the Create tab", () => {
    const openCreateTab = (root: ReactTestInstance) =>
      ReactTestRenderer.act(() => {
        pressableLabelled(root, 'CREATE RIDE').props.onPress();
      });

    it('shows the code saved on the account, only on the Create tab', () => {
      const root = render();
      expect(screenText()).not.toContain('YOUR ROOM CODE');

      openCreateTab(root);
      expect(screenText()).toContain('YOUR ROOM CODE');
      expect(screenText()).toContain('54321');
    });

    it('never sends a code of its own; the server makes the rider code the room, and the ride uses what it answers', async () => {
      post.mockResolvedValue(roomReply({ isHost: true, roomCode: '54321' }));
      const root = render();
      openCreateTab(root);
      await press(root, 'CREATE RIDE');

      expect(post.mock.calls[0][1]).not.toHaveProperty('roomCode');
      expect(onJoined).toHaveBeenCalledWith(
        expect.objectContaining({ roomCode: '54321', isHost: true }),
      );
    });

    it('does not ask the server for a code the account already has', async () => {
      render();
      await ReactTestRenderer.act(async () => {});
      expect(profile).not.toHaveBeenCalled();
    });

    it('fetches and saves the code for an account saved before room codes existed', async () => {
      mockAuth.user = { id: 'u1', name: 'Alex' };
      profile.mockResolvedValue({
        id: 'u1',
        email: 'a@gmail.com',
        name: 'Alex',
        roomCode: '27182',
      });
      render();
      await ReactTestRenderer.act(async () => {});

      expect(profile).toHaveBeenCalledTimes(1);
      expect(mockUpdateUser).toHaveBeenCalledWith({ id: 'u1', name: 'Alex', roomCode: '27182' });
    });

    it('still lets the rider create a ride when the code could not be fetched', async () => {
      mockAuth.user = { id: 'u1', name: 'Alex' };
      profile.mockRejectedValue(new Error('offline'));
      post.mockResolvedValue(roomReply({ isHost: true, roomCode: '27182' }));
      const root = render();
      await ReactTestRenderer.act(async () => {});
      openCreateTab(root);

      expect(screenText()).toContain('assigned when you start your first ride');
      await press(root, 'CREATE RIDE');
      expect(onJoined).toHaveBeenCalledWith(expect.objectContaining({ roomCode: '27182' }));
    });
  });

  it('logs out from the top bar and returns to the sign-in screen', async () => {
    const root = render();
    await press(root, 'Log Out');

    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).toHaveBeenCalledWith('LoginPage');
  });
});
