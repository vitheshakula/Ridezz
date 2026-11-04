module.exports = {
  root: true,
  extends: '@react-native',
  ignorePatterns: ['coverage/', 'android/', 'ios/'],
  rules: {
    'no-console': 'error',
  },
  overrides: [
    {
      files: ['src/utils/logger.ts', '__tests__/**', '__mocks__/**', 'scripts/**', '*.js'],
      rules: { 'no-console': 'off' },
    },
  ],
};
