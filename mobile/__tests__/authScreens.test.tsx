import React from 'react';
import { Alert } from 'react-native';
import ReactTestRenderer, { type ReactTestInstance } from 'react-test-renderer';
import { LoginPage } from '../src/screens/LoginPage';
import { SignupPage } from '../src/screens/SignupPage';
import { GoogleSignInButton } from '../src/components/GoogleSignInButton';
import * as AuthService from '../src/services/AuthService';

const mockSignIn = jest.fn();
jest.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ login: mockSignIn }) }));
jest.mock('../src/services/AuthService', () => ({
  login: jest.fn(),
  register: jest.fn(),
  loginWithGoogle: jest.fn(),
}));

const service = AuthService as jest.Mocked<typeof AuthService>;
const session = { token: 'app-jwt', user: { id: 'u1', email: 'a@gmail.com', name: 'Alex' } };

let renderer: ReactTestRenderer.ReactTestRenderer;
const navigation = { navigate: jest.fn() };

function render(element: React.ReactElement) {
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(element);
  });
  return renderer.root;
}

/** The host TextInput / button with this testID (not the wrapper components that share the prop). */
function byTestId(root: ReactTestInstance, testID: string) {
  return root.find(node => node.props.testID === testID && typeof node.type === 'string');
}
function pressable(root: ReactTestInstance, testID: string) {
  return root.find(node => node.props.testID === testID && typeof node.props.onPress === 'function');
}

const type = (root: ReactTestInstance, testID: string, value: string) =>
  ReactTestRenderer.act(() => {
    byTestId(root, testID).props.onChangeText(value);
  });
const press = (node: ReactTestInstance) =>
  ReactTestRenderer.act(async () => {
    await node.props.onPress();
  });
const screenText = () => JSON.stringify(renderer.toJSON());

const axiosFailure = (status: number, message: string) =>
  Object.assign(new Error('x'), { isAxiosError: true, response: { status, data: { message } } });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('LoginPage', () => {
  it('offers Sign in with Google alongside the email form', () => {
    render(<LoginPage navigation={navigation} />);
    expect(screenText()).toContain('Sign in with Google');
    expect(screenText()).toContain('Sign In');
  });

  it('rejects a non-Gmail address with "Invalid Gmail format" and sends nothing', async () => {
    const root = render(<LoginPage navigation={navigation} />);
    type(root, 'login-email', 'alex@yahoo.com');
    type(root, 'login-password', 'longenough1');
    await press(pressable(root, 'login-submit'));

    expect(screenText()).toContain('Invalid Gmail format');
    expect(service.login).not.toHaveBeenCalled();
  });

  it('asks for a password when it is empty', async () => {
    const root = render(<LoginPage navigation={navigation} />);
    type(root, 'login-email', 'alex@gmail.com');
    await press(pressable(root, 'login-submit'));

    expect(screenText()).toContain('Enter your password');
    expect(service.login).not.toHaveBeenCalled();
  });

  it('clears a field error as soon as the rider starts fixing it', async () => {
    const root = render(<LoginPage navigation={navigation} />);
    type(root, 'login-email', 'alex@yahoo.com');
    await press(pressable(root, 'login-submit'));
    expect(screenText()).toContain('Invalid Gmail format');

    type(root, 'login-email', 'alex@gmail.co');
    expect(screenText()).not.toContain('Invalid Gmail format');
  });

  it('signs in, stores the session, and moves on to the ride screen', async () => {
    service.login.mockResolvedValue(session);
    const root = render(<LoginPage navigation={navigation} />);
    type(root, 'login-email', 'alex@gmail.com');
    type(root, 'login-password', 'longenough1');
    await press(pressable(root, 'login-submit'));

    expect(service.login).toHaveBeenCalledWith('alex@gmail.com', 'longenough1');
    expect(mockSignIn).toHaveBeenCalledWith(session.token, session.user);
    expect(navigation.navigate).toHaveBeenCalledWith('JoinScreen');
  });

  it("shows the server's reason when sign-in is refused, and stays on the screen", async () => {
    service.login.mockRejectedValue(axiosFailure(401, 'Invalid credentials.'));
    const root = render(<LoginPage navigation={navigation} />);
    type(root, 'login-email', 'alex@gmail.com');
    type(root, 'login-password', 'wrong password');
    await press(pressable(root, 'login-submit'));

    expect(screenText()).toContain('Invalid credentials.');
    expect(mockSignIn).not.toHaveBeenCalled();
    expect(navigation.navigate).not.toHaveBeenCalled();
  });
});

describe('SignupPage', () => {
  const fill = (root: ReactTestInstance, over: Partial<Record<'name' | 'email' | 'password' | 'confirm', string>> = {}) => {
    type(root, 'signup-name', over.name ?? 'Alex');
    type(root, 'signup-email', over.email ?? 'alex@gmail.com');
    type(root, 'signup-password', over.password ?? 'longenough1');
    type(root, 'signup-confirm', over.confirm ?? over.password ?? 'longenough1');
  };

  it('offers Sign up with Google alongside the email form', () => {
    render(<SignupPage navigation={navigation} />);
    expect(screenText()).toContain('Sign up with Google');
    expect(screenText()).toContain('Create Account');
  });

  it('shows the field-level messages and sends nothing for an invalid form', async () => {
    const root = render(<SignupPage navigation={navigation} />);
    fill(root, { name: 'A', email: 'alex@yahoo.com', password: 'short' });
    await press(pressable(root, 'signup-submit'));

    expect(screenText()).toContain('Invalid Gmail format');
    expect(screenText()).toContain('Password must be at least 8 characters');
    expect(screenText()).toContain('2-24 characters');
    expect(service.register).not.toHaveBeenCalled();
  });

  it('flags a confirmation that does not match', async () => {
    const root = render(<SignupPage navigation={navigation} />);
    fill(root, { password: 'longenough1', confirm: 'different1' });
    await press(pressable(root, 'signup-submit'));

    expect(screenText()).toContain('Passwords do not match');
    expect(service.register).not.toHaveBeenCalled();
  });

  it('creates the account, signs the rider straight in, and moves on to the ride screen', async () => {
    service.register.mockResolvedValue(session);
    const root = render(<SignupPage navigation={navigation} />);
    fill(root);
    await press(pressable(root, 'signup-submit'));

    expect(service.register).toHaveBeenCalledWith('Alex', 'alex@gmail.com', 'longenough1');
    expect(mockSignIn).toHaveBeenCalledWith(session.token, session.user);
    expect(navigation.navigate).toHaveBeenCalledWith('JoinScreen');
  });

  it('tells the rider when the address is already taken', async () => {
    service.register.mockRejectedValue(axiosFailure(409, 'An account with this email already exists.'));
    const root = render(<SignupPage navigation={navigation} />);
    fill(root);
    await press(pressable(root, 'signup-submit'));

    expect(screenText()).toContain('An account with this email already exists.');
    expect(mockSignIn).not.toHaveBeenCalled();
  });
});

describe('GoogleSignInButton', () => {
  const button = (root: ReactTestInstance, label: string) =>
    root.find(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function');

  it('labels itself for what it does', () => {
    const login = render(<GoogleSignInButton mode="login" navigation={navigation} />);
    expect(button(login, 'Sign in with Google')).toBeTruthy();
    const signup = render(<GoogleSignInButton mode="signup" navigation={navigation} />);
    expect(button(signup, 'Sign up with Google')).toBeTruthy();
  });

  it('asks the server to sign in (login) or to create (signup), matching its own mode', async () => {
    service.loginWithGoogle.mockResolvedValue(session);

    const login = render(<GoogleSignInButton mode="login" navigation={navigation} />);
    await press(button(login, 'Sign in with Google'));
    expect(service.loginWithGoogle).toHaveBeenLastCalledWith('login');

    const signup = render(<GoogleSignInButton mode="signup" navigation={navigation} />);
    await press(button(signup, 'Sign up with Google'));
    expect(service.loginWithGoogle).toHaveBeenLastCalledWith('signup');
  });

  it('signs in with the Google result and moves on to the ride screen', async () => {
    service.loginWithGoogle.mockResolvedValue(session);
    const root = render(<GoogleSignInButton mode="login" navigation={navigation} />);
    await press(button(root, 'Sign in with Google'));

    expect(mockSignIn).toHaveBeenCalledWith(session.token, session.user);
    expect(navigation.navigate).toHaveBeenCalledWith('JoinScreen');
  });

  it('does nothing, and shows no error, when the rider backs out of the account picker', async () => {
    service.loginWithGoogle.mockResolvedValue(null);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const root = render(<GoogleSignInButton mode="login" navigation={navigation} />);
    await press(button(root, 'Sign in with Google'));

    expect(mockSignIn).not.toHaveBeenCalled();
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it("reports the server's reason when Google sign-in is refused", async () => {
    service.loginWithGoogle.mockRejectedValue(axiosFailure(403, 'Only Gmail accounts are supported.'));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const root = render(<GoogleSignInButton mode="login" navigation={navigation} />);
    await press(button(root, 'Sign in with Google'));

    expect(alert).toHaveBeenCalledWith('Google Sign-In Failed', 'Only Gmail accounts are supported.');
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  describe('when the Google account has never registered', () => {
    const notFound = () => {
      const failure = axiosFailure(404, 'No account found for this Google account. Create an account first.');
      (failure as any).response.data.code = 'ACCOUNT_NOT_FOUND';
      return failure;
    };

    it('login explains, and offers a Create account shortcut that opens the sign-up screen', async () => {
      service.loginWithGoogle.mockRejectedValue(notFound());
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = render(<GoogleSignInButton mode="login" navigation={navigation} />);
      await press(button(root, 'Sign in with Google'));

      expect(mockSignIn).not.toHaveBeenCalled();
      expect(navigation.navigate).not.toHaveBeenCalled();
      expect(alert).toHaveBeenCalledTimes(1);
      const [title, message, actions] = alert.mock.calls[0] as unknown as [
        string,
        string,
        { text: string; onPress?: () => void }[],
      ];
      expect(title).toBe('No account found');
      expect(message).toMatch(/Create an account first/);

      actions.find(a => a.text === 'Create account')!.onPress!();
      expect(navigation.navigate).toHaveBeenCalledWith('SignupPage');
    });

    it('does not offer that shortcut from the sign-up screen, where it would make no sense', async () => {
      service.loginWithGoogle.mockRejectedValue(notFound());
      const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
      const root = render(<GoogleSignInButton mode="signup" navigation={navigation} />);
      await press(button(root, 'Sign up with Google'));

      expect(alert).toHaveBeenCalledWith('Google Sign-In Failed', expect.any(String));
    });
  });

  it('ignores a second tap while a sign-in is already running', async () => {
    let finish: (value: typeof session) => void = () => {};
    service.loginWithGoogle.mockReturnValue(new Promise(resolve => (finish = resolve)));
    const root = render(<GoogleSignInButton mode="login" navigation={navigation} />);

    ReactTestRenderer.act(() => {
      button(root, 'Sign in with Google').props.onPress();
    });
    ReactTestRenderer.act(() => {
      button(root, 'Sign in with Google').props.onPress();
    });
    expect(service.loginWithGoogle).toHaveBeenCalledTimes(1);

    await ReactTestRenderer.act(async () => {
      finish(session);
    });
  });

  it('is inert while its form is busy', async () => {
    const root = render(<GoogleSignInButton mode="login" navigation={navigation} disabled />);
    await press(button(root, 'Sign in with Google'));
    expect(service.loginWithGoogle).not.toHaveBeenCalled();
  });
});
