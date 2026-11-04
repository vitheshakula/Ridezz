export default {
  hide: jest.fn(async () => {}),
  isVisible: jest.fn(() => false),
  useHideAnimation: jest.fn(() => ({ container: {}, logo: {}, brand: {} })),
};
