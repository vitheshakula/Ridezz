This is a new [**React Native**](https://reactnative.dev) project, bootstrapped using [`@react-native-community/cli`](https://github.com/react-native-community/cli).

# Environments

The Android app has three environments, built as Gradle product flavors (`android/app/build.gradle`):

| Flavor    | Application id               | App name          | Env file        | Points at                     |
|-----------|------------------------------|-------------------|-----------------|-------------------------------|
| `dev`     | `com.rideaze.mobile.dev`     | Rideaze Dev       | `.env.dev`      | Your local server             |
| `staging` | `com.rideaze.mobile.staging` | Rideaze Staging   | `.env.staging`  | The shared hosted test server |
| `prod`    | `com.rideaze.mobile`         | Rideaze           | `.env.prod`     | Production                    |

Each flavor has its own application id, so all three can be installed on one phone side by side.
Combined with the build types this gives variants such as `devDebug`, `stagingRelease` and
`prodRelease`.

**Setup:** copy each example you need and fill it in (the real files are gitignored):

```sh
cp .env.dev.example .env.dev
cp .env.staging.example .env.staging
cp .env.prod.example .env.prod
```

The values are read by [`react-native-config`](https://github.com/react-native-config/react-native-config)
and baked into the native build, so **after changing an env file, rebuild the app** -- restarting
Metro is not enough. App code reads them only through `src/config/appConfig.ts`, which also exposes
`APP_ENV` (`'dev' | 'staging' | 'prod'`).

| Task                                   | Command                         |
|----------------------------------------|---------------------------------|
| Run dev on a device (default)          | `npm run android`               |
| Run staging / prod in debug mode       | `npm run android:staging` / `npm run android:prod` |
| Build a staging release APK            | `npm run build:android:staging` |
| Build the prod release bundle (AAB)    | `npm run build:android:prod`    |

Always name the flavor in Gradle tasks (`assembleStagingRelease`, not `assembleRelease`), and build
one flavor per Gradle run: the env file is chosen once per run from the task name, so the build
refuses flavorless or mixed-flavor task lists rather than baking in the wrong backend.

Google Sign-In needs an Android OAuth client for each application id you use (see
`server/README.md`, *Google Cloud setup*). Release builds are still signed with the debug keystore,
which is fine for testing but must be replaced before a Play Store release.

iOS has no flavors yet; an iOS build reads `.env` and reports itself as `dev`.

# Getting Started

> **Note**: Make sure you have completed the [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment) guide before proceeding.

## Step 1: Start Metro

First, you will need to run **Metro**, the JavaScript build tool for React Native.

To start the Metro dev server, run the following command from the root of your React Native project:

```sh
# Using npm
npm start

# OR using Yarn
yarn start
```

## Step 2: Build and run your app

With Metro running, open a new terminal window/pane from the root of your React Native project, and use one of the following commands to build and run your Android or iOS app:

### Android

```sh
# Using npm
npm run android 

# OR using Yarn
yarn android
```

### iOS

For iOS, remember to install CocoaPods dependencies (this only needs to be run on first clone or after updating native deps).

The first time you create a new project, run the Ruby bundler to install CocoaPods itself:

```sh
bundle install
```

Then, and every time you update your native dependencies, run:

```sh
bundle exec pod install
```

For more information, please visit [CocoaPods Getting Started guide](https://guides.cocoapods.org/using/getting-started.html).

```sh
# Using npm
npm run ios

# OR using Yarn
yarn ios
```

If everything is set up correctly, you should see your new app running in the Android Emulator, iOS Simulator, or your connected device.

This is one way to run your app — you can also build it directly from Android Studio or Xcode.

## Step 3: Modify your app

Now that you have successfully run the app, let's make changes!

Open `App.tsx` in your text editor of choice and make some changes. When you save, your app will automatically update and reflect these changes — this is powered by [Fast Refresh](https://reactnative.dev/docs/fast-refresh).

When you want to forcefully reload, for example to reset the state of your app, you can perform a full reload:

- **Android**: Press the <kbd>R</kbd> key twice or select **"Reload"** from the **Dev Menu**, accessed via <kbd>Ctrl</kbd> + <kbd>M</kbd> (Windows/Linux) or <kbd>Cmd ⌘</kbd> + <kbd>M</kbd> (macOS).
- **iOS**: Press <kbd>R</kbd> in iOS Simulator.

## Congratulations! :tada:

You've successfully run and modified your React Native App. :partying_face:

### Now what?

- If you want to add this new React Native code to an existing application, check out the [Integration guide](https://reactnative.dev/docs/integration-with-existing-apps).
- If you're curious to learn more about React Native, check out the [docs](https://reactnative.dev/docs/getting-started).

# Troubleshooting

If you're having issues getting the above steps to work, see the [Troubleshooting](https://reactnative.dev/docs/troubleshooting) page.

# Learn More

To learn more about React Native, take a look at the following resources:

- [React Native Website](https://reactnative.dev) - learn more about React Native.
- [Getting Started](https://reactnative.dev/docs/environment-setup) - an **overview** of React Native and how setup your environment.
- [Learn the Basics](https://reactnative.dev/docs/getting-started) - a **guided tour** of the React Native **basics**.
- [Blog](https://reactnative.dev/blog) - read the latest official React Native **Blog** posts.
- [`@facebook/react-native`](https://github.com/facebook/react-native) - the Open Source; GitHub **repository** for React Native.
