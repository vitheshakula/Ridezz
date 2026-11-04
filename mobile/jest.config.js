module.exports = {
  preset: '@react-native/jest-preset',
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.d.ts'],
  coverageReporters: ['text-summary', 'lcov'],
  coverageThreshold: {
    global: { statements: 70, branches: 64, functions: 63, lines: 70 },
  },
};
