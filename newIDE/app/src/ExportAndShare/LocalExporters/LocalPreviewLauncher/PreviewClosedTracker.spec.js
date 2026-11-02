// @flow
import { createPreviewClosedTracker } from './PreviewClosedTracker';
import type { CaptureOptions } from '../../PreviewLauncher.flow';

const makeCaptureOptions = (signedUrl: string): CaptureOptions => ({
  screenshots: [
    {
      signedUrl,
      delayTimeInSeconds: 2,
      publicUrl: `${signedUrl}/public`,
    },
  ],
});

describe('PreviewClosedTracker', () => {
  it('fires the capture handling of the launch owning the closed window, and only of that launch', async () => {
    const onCaptureFinished = jest.fn<[CaptureOptions], Promise<void>>(() =>
      Promise.resolve()
    );
    const tracker = createPreviewClosedTracker(onCaptureFinished);
    const firstLaunchCaptureOptions = makeCaptureOptions('first-launch');
    const secondLaunchCaptureOptions = makeCaptureOptions('second-launch');

    tracker.own([1], firstLaunchCaptureOptions);
    tracker.own([2], secondLaunchCaptureOptions);

    await tracker.handleClosed(1);

    expect(onCaptureFinished).toHaveBeenCalledTimes(1);
    expect(onCaptureFinished).toHaveBeenCalledWith(firstLaunchCaptureOptions);
    expect(onCaptureFinished).not.toHaveBeenCalledWith(
      secondLaunchCaptureOptions
    );

    await tracker.handleClosed(2);

    expect(onCaptureFinished).toHaveBeenCalledTimes(2);
    expect(onCaptureFinished).toHaveBeenLastCalledWith(
      secondLaunchCaptureOptions
    );
  });

  it('fires the capture handling only once for a window, even if its closing is reported twice', async () => {
    const onCaptureFinished = jest.fn<[CaptureOptions], Promise<void>>(() =>
      Promise.resolve()
    );
    const tracker = createPreviewClosedTracker(onCaptureFinished);

    tracker.own([1], makeCaptureOptions('launch'));
    await tracker.handleClosed(1);
    await tracker.handleClosed(1);

    expect(onCaptureFinished).toHaveBeenCalledTimes(1);
  });

  it('does nothing for the closing of a window that no launch owns', async () => {
    const onCaptureFinished = jest.fn<[CaptureOptions], Promise<void>>(() =>
      Promise.resolve()
    );
    const tracker = createPreviewClosedTracker(onCaptureFinished);

    tracker.own([1], makeCaptureOptions('launch'));
    await tracker.handleClosed(42);

    expect(onCaptureFinished).not.toHaveBeenCalled();
  });

  it('replaces the ownership of a window id when it is launched again', async () => {
    const onCaptureFinished = jest.fn<[CaptureOptions], Promise<void>>(() =>
      Promise.resolve()
    );
    const tracker = createPreviewClosedTracker(onCaptureFinished);
    const firstLaunchCaptureOptions = makeCaptureOptions('first-launch');
    const secondLaunchCaptureOptions = makeCaptureOptions('second-launch');

    tracker.own([1], firstLaunchCaptureOptions);
    tracker.own([1], secondLaunchCaptureOptions);
    await tracker.handleClosed(1);

    expect(onCaptureFinished).toHaveBeenCalledTimes(1);
    expect(onCaptureFinished).toHaveBeenCalledWith(secondLaunchCaptureOptions);
  });

  it('handles a launch owning multiple windows', async () => {
    const onCaptureFinished = jest.fn<[CaptureOptions], Promise<void>>(() =>
      Promise.resolve()
    );
    const tracker = createPreviewClosedTracker(onCaptureFinished);
    const captureOptions = makeCaptureOptions('multi-window-launch');

    tracker.own([3, 4], captureOptions);
    await tracker.handleClosed(3);
    await tracker.handleClosed(4);

    expect(onCaptureFinished).toHaveBeenCalledTimes(2);
    expect(onCaptureFinished).toHaveBeenNthCalledWith(1, captureOptions);
    expect(onCaptureFinished).toHaveBeenNthCalledWith(2, captureOptions);
  });

  it('forgets every owned window on releaseAll, without firing the capture handling', async () => {
    const onCaptureFinished = jest.fn<[CaptureOptions], Promise<void>>(() =>
      Promise.resolve()
    );
    const tracker = createPreviewClosedTracker(onCaptureFinished);

    tracker.own([1], makeCaptureOptions('launch'));
    tracker.releaseAll();
    await tracker.handleClosed(1);

    expect(onCaptureFinished).not.toHaveBeenCalled();
  });

  it('ELEC-21: a failing capture handling does NOT reject', async () => {
    // The caller fires this from an IPC listener with `void`, so a rejection
    // was an unhandled rejection in the renderer — and a capture upload that
    // fails (offline, revoked URL) is an ordinary outcome, not a crash.
    // The implementation is installed here, inside the test: the repo's jest
    // config resets mocks before each test, which strips an implementation
    // given to the factory (and would make this test vacuous).
    const onCaptureFinished: JestMockFn<
      [CaptureOptions],
      Promise<void>
    > = jest.fn();
    onCaptureFinished.mockImplementation(() =>
      Promise.reject(new Error('the capture upload failed'))
    );
    const tracker = createPreviewClosedTracker(onCaptureFinished);
    // The messages are collected in a plain array: restoring a console spy
    // also clears its recorded calls.
    const reportedErrors: Array<string> = [];
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation((...args) => {
        reportedErrors.push(String(args[0]));
      });

    tracker.own([1], makeCaptureOptions('launch'));
    let rejected = false;
    try {
      await tracker.handleClosed(1);
    } catch (error) {
      rejected = true;
    } finally {
      consoleError.mockRestore();
    }

    expect(onCaptureFinished).toHaveBeenCalledTimes(1);
    expect(rejected).toBe(false);
    // Reported, not swallowed silently.
    expect(reportedErrors.length).toBe(1);
  });

  it('ELEC-21: the window is still forgotten when the handling fails', async () => {
    const onCaptureFinished: JestMockFn<
      [CaptureOptions],
      Promise<void>
    > = jest.fn();
    onCaptureFinished.mockImplementation(() =>
      Promise.reject(new Error('nope'))
    );
    const tracker = createPreviewClosedTracker(onCaptureFinished);
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    tracker.own([1], makeCaptureOptions('launch'));
    await tracker.handleClosed(1);
    await tracker.handleClosed(1);
    consoleError.mockRestore();

    expect(onCaptureFinished).toHaveBeenCalledTimes(1);
  });
});
