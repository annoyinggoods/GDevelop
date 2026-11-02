// @flow
import { buildByokStallNoticeText, createByokWatchdog } from './ByokWatchdog';

describe('ByokWatchdog', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fires no notice when activity keeps arriving', () => {
    const onStall = (jest.fn(): any);
    const watchdog = createByokWatchdog({ windowMs: 1000, onStall });
    watchdog.arm();

    // Activity every 500 ms, for 10 seconds: never a full silent window.
    for (let time = 0; time < 20; time++) {
      jest.advanceTimersByTime(500);
      watchdog.notifyActivity('tool-output-posted');
    }

    expect(onStall).not.toHaveBeenCalled();
    watchdog.dispose();
  });

  it('fires exactly one notice per silent window', () => {
    const onStall = (jest.fn(): any);
    const watchdog = createByokWatchdog({ windowMs: 1000, onStall });
    watchdog.arm();

    jest.advanceTimersByTime(1000);
    expect(onStall).toHaveBeenCalledTimes(1);
    // A still-silent turn is reminded once per window — no spam in between.
    jest.advanceTimersByTime(999);
    expect(onStall).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledTimes(2);

    watchdog.dispose();
  });

  it('resets the timer on activity', () => {
    const onStall = (jest.fn(): any);
    const watchdog = createByokWatchdog({ windowMs: 1000, onStall });
    watchdog.arm();

    jest.advanceTimersByTime(900);
    watchdog.notifyActivity('response-arrived');
    jest.advanceTimersByTime(900);
    expect(onStall).not.toHaveBeenCalled();
    jest.advanceTimersByTime(100);
    expect(onStall).toHaveBeenCalledTimes(1);

    watchdog.dispose();
  });

  it('never fires while paused (a model call in flight)', () => {
    const onStall = (jest.fn(): any);
    const watchdog = createByokWatchdog({ windowMs: 1000, onStall });
    watchdog.arm();

    watchdog.pause();
    jest.advanceTimersByTime(60000);
    expect(onStall).not.toHaveBeenCalled();

    // The gap watch resumes after the call.
    watchdog.resume();
    jest.advanceTimersByTime(1000);
    expect(onStall).toHaveBeenCalledTimes(1);

    watchdog.dispose();
  });

  it('never fires while the user is deciding on an approval', () => {
    const onStall = (jest.fn(): any);
    const watchdog = createByokWatchdog({ windowMs: 1000, onStall });
    watchdog.arm();

    watchdog.holdForApproval();
    jest.advanceTimersByTime(600000);
    expect(onStall).not.toHaveBeenCalled();

    watchdog.releaseApproval();
    jest.advanceTimersByTime(1000);
    expect(onStall).toHaveBeenCalledTimes(1);

    watchdog.dispose();
  });

  it('disarms on stop/suspend/ready and stays quiet', () => {
    const onStall = (jest.fn(): any);
    const watchdog = createByokWatchdog({ windowMs: 1000, onStall });
    watchdog.arm();
    watchdog.disarm();

    jest.advanceTimersByTime(600000);
    expect(onStall).not.toHaveBeenCalled();
    expect(watchdog.isWatching()).toBe(false);
  });

  it('does not resurrect itself after dispose', () => {
    const onStall = (jest.fn(): any);
    const watchdog = createByokWatchdog({ windowMs: 1000, onStall });
    watchdog.arm();
    watchdog.dispose();

    jest.advanceTimersByTime(60000);
    watchdog.notifyActivity('tool-executing');
    jest.advanceTimersByTime(60000);
    expect(onStall).not.toHaveBeenCalled();
  });
});

describe('buildByokStallNoticeText', () => {
  it('mentions the window so the user can tell a stall from a hang', () => {
    const text = buildByokStallNoticeText(90);
    expect(text).toContain('90s');
    expect(text).toContain('stop');
  });
});
