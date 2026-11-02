// @flow
import {
  getByokGameCodeOpenerForTests,
  openByokGameCode,
  registerByokGameCodeOpener,
  resetByokGameCodeOpenerForTests,
} from './ByokGameCodeOpenCommand';

describe('ByokGameCodeOpenCommand', () => {
  afterEach(() => {
    resetByokGameCodeOpenerForTests();
  });

  it('calls the registered opener', () => {
    const opener = jest.fn(() => {});
    registerByokGameCodeOpener(opener);

    openByokGameCode();

    expect(opener).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no opener is registered', () => {
    expect(() => openByokGameCode()).not.toThrow();
  });

  it('unregisters with the returned function', () => {
    const opener = jest.fn(() => {});
    const unregister = registerByokGameCodeOpener(opener);

    unregister();
    openByokGameCode();

    expect(opener).not.toHaveBeenCalled();
    expect(getByokGameCodeOpenerForTests()).toBe(null);
  });

  it('keeps only the latest opener when registered twice', () => {
    const firstOpener = jest.fn(() => {});
    const secondOpener = jest.fn(() => {});
    registerByokGameCodeOpener(firstOpener);
    const unregisterSecond = registerByokGameCodeOpener(secondOpener);

    // The second registration replaced the first one.
    openByokGameCode();
    unregisterSecond();

    expect(firstOpener).not.toHaveBeenCalled();
    expect(secondOpener).toHaveBeenCalledTimes(1);
    // After the second opener unregisters, the stale first one stays dead.
    expect(getByokGameCodeOpenerForTests()).toBe(null);
  });
});
