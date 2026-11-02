// @flow
import {
  resetByokMutationLockForTests,
  runExclusiveByokProjectMutation,
} from './ByokMutationLock';

const makeDeferred = (): {|
  promise: Promise<void>,
  resolve: () => void,
|} => {
  let resolveFn = () => {};
  const promise: Promise<void> = new Promise(resolve => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
};

describe('runExclusiveByokProjectMutation (audit100226 UP-11)', () => {
  beforeEach(() => {
    resetByokMutationLockForTests();
  });

  it('never lets two mutations overlap', async () => {
    const events: Array<string> = [];
    const firstGate = makeDeferred();

    const first = runExclusiveByokProjectMutation(async () => {
      events.push('first:start');
      await firstGate.promise;
      events.push('first:end');
      return 'first';
    });
    const second = runExclusiveByokProjectMutation(async () => {
      events.push('second:start');
      events.push('second:end');
      return 'second';
    });

    // The second task must not have started while the first holds the lock.
    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    firstGate.resolve();
    expect(await first).toBe('first');
    expect(await second).toBe('second');
    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
  });

  it('runs queued tasks in call order (FIFO)', async () => {
    const order: Array<number> = [];
    await Promise.all([
      runExclusiveByokProjectMutation(async () => {
        order.push(1);
      }),
      runExclusiveByokProjectMutation(async () => {
        order.push(2);
      }),
      runExclusiveByokProjectMutation(async () => {
        order.push(3);
      }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('releases the lock when a task throws (the next one still runs)', async () => {
    const events: Array<string> = [];
    const failing = runExclusiveByokProjectMutation(
      async (): Promise<void> => {
        events.push('failing:start');
        throw new Error('the editor rejected the change');
      }
    );
    const following = runExclusiveByokProjectMutation(async () => {
      events.push('following');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('the editor rejected the change');
    expect(await following).toBe('ok');
    expect(events).toEqual(['failing:start', 'following']);
  });
});
