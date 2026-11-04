export default {
  setString: jest.fn(),
  getString: jest.fn(async () => ''),
  hasString: jest.fn(async () => false),
};
