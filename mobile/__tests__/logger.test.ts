import { createLogger } from '../src/utils/logger';

const FIXED_TIME = new Date('2026-01-02T03:04:05.000Z');

describe('createLogger', () => {
  const spies = {
    debug: jest.spyOn(console, 'debug').mockImplementation(() => undefined),
    info: jest.spyOn(console, 'info').mockImplementation(() => undefined),
    warn: jest.spyOn(console, 'warn').mockImplementation(() => undefined),
    error: jest.spyOn(console, 'error').mockImplementation(() => undefined),
  };

  beforeEach(() => Object.values(spies).forEach(spy => spy.mockClear()));
  afterAll(() => Object.values(spies).forEach(spy => spy.mockRestore()));

  it('prefixes each line with timestamp, level and scope and passes details through', () => {
    const error = new Error('boom');
    createLogger('Auth', 'debug', () => FIXED_TIME).error('restore failed', error);
    expect(spies.error).toHaveBeenCalledWith(
      '2026-01-02T03:04:05.000Z ERROR [Auth] restore failed',
      error,
    );
  });

  it('drops messages below the minimum level', () => {
    const log = createLogger('RideLoc', 'warn', () => FIXED_TIME);
    log.debug('position 12.34,56.78');
    log.info('joined');
    log.warn('decode failed');
    log.error('publish failed');
    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.info).not.toHaveBeenCalled();
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.error).toHaveBeenCalledTimes(1);
  });
});
