// @flow
import {
  notifyForkAssetPreviewsShouldReload,
  registerForkAssetPreviewReloader,
} from './ForkAssetPreviewReload';

describe('the fork asset preview reload seam', () => {
  it('notifies every registered reloader', () => {
    const firstReloader = (jest.fn(): any);
    const secondReloader = (jest.fn(): any);
    const unregisterFirst = registerForkAssetPreviewReloader(firstReloader);
    const unregisterSecond = registerForkAssetPreviewReloader(secondReloader);
    try {
      notifyForkAssetPreviewsShouldReload();
      expect(firstReloader).toHaveBeenCalledTimes(1);
      expect(secondReloader).toHaveBeenCalledTimes(1);
    } finally {
      unregisterFirst();
      unregisterSecond();
    }
  });

  it('stops notifying after the unregister function runs', () => {
    const reloader = (jest.fn(): any);
    const unregister = registerForkAssetPreviewReloader(reloader);
    unregister();
    notifyForkAssetPreviewsShouldReload();
    expect(reloader).not.toHaveBeenCalled();
  });

  it('never throws when no reloader is registered', () => {
    expect(() => notifyForkAssetPreviewsShouldReload()).not.toThrow();
  });

  it('contains a throwing reloader so the other reloaders still run', () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const throwingReloader = () => {
      throw new Error('preview launcher exploded');
    };
    const healthyReloader = (jest.fn(): any);
    const unregisterThrowing = registerForkAssetPreviewReloader(
      throwingReloader
    );
    const unregisterHealthy = registerForkAssetPreviewReloader(healthyReloader);
    try {
      expect(() => notifyForkAssetPreviewsShouldReload()).not.toThrow();
      expect(healthyReloader).toHaveBeenCalledTimes(1);
    } finally {
      unregisterThrowing();
      unregisterHealthy();
      consoleError.mockRestore();
    }
  });
});
