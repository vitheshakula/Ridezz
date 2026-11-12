module.exports = {
  preset: '@react-native/jest-preset',
  // @noble/* ship ES modules only; let Babel compile them like the React Native packages.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@noble)/)',
  ],
};
