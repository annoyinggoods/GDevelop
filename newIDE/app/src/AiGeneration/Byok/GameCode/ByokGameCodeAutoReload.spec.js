// @flow

/**
 * The auto-reload trigger, driven through an injected watcher and store: no
 * real filesystem, no Electron. What is pinned here is the 15.4 contract —
 * only game-code `.js` paths react, bursts coalesce, a reload in flight is
 * never re-entered, and the D15-6 setting is read at call time.
 */

import { startByokGameCodeAutoReload } from './ByokGameCodeAutoReload';
import { getByokGameCodeFolderName } from './ByokGameCodeCore';

const FOLDER_NAME = getByokGameCodeFolderName('My Game');

const mockFn = (fn: Function): JestMockFn<any, any> => fn;

const makeFakeProject = () => ({
  getName: () => 'My Game',
  getProjectFile: () => 'projects/my-game.json',
  getFirstLayout: () => 'Scene1',
});

const makeFakeWatcher = () => {
  let registeredCallback: ?({
    fileIdentifier: string,
    event: ?string,
  }) => void = null;
  let unsubscribeCount = 0;
  const setupWatcher = mockFn(
    jest.fn(
      (watcherOptions: {
        callback: ({ fileIdentifier: string, event: ?string }) => void,
        fileIdentifier: string,
      }) => {
        registeredCallback = watcherOptions.callback;
        return () => {
          unsubscribeCount += 1;
        };
      }
    )
  );
  return {
    setupWatcher,
    fire: (identifier: string, eventKind: ?string = null) => {
      if (!registeredCallback) throw new Error('No callback registered.');
      registeredCallback({ fileIdentifier: identifier, event: eventKind });
    },
    getUnsubscribeCount: () => unsubscribeCount,
  };
};

const makeFakeStore = (existingFiles: Array<string>) => ({
  readFile: async (
    projectFile: string,
    folderName: string,
    relativePath: string
  ) => {
    if (!existingFiles.includes(relativePath)) {
      return { ok: false, error: `"${relativePath}" does not exist.` };
    }
    return { ok: true, data: 'GameCode.main = 1;' };
  },
});

const makeAutoReload = (overrides?: Object) =>
  startByokGameCodeAutoReload({
    getProject: makeFakeProject,
    onReload: () => Promise.resolve(),
    isEnabled: () => true,
    setupWatcher: () => () => {},
    store: (makeFakeStore(['main.js']): any),
    debounceDelayMs: 100,
    ...overrides,
  });

// Settle the debounce flush and the async reload chain behind it.
const flushAsync = async () => {
  for (let flush = 0; flush < 10; flush++) {
    await Promise.resolve();
  }
};

describe('startByokGameCodeAutoReload', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('coalesces a burst of events into one reload (last path wins)', async () => {
    const watcher = makeFakeWatcher();
    const onReload = jest.fn(() => Promise.resolve());
    makeAutoReload({
      onReload,
      setupWatcher: watcher.setupWatcher,
      store: (makeFakeStore(['main.js', 'character/spawn.js']): any),
    });

    watcher.fire(`${FOLDER_NAME}/main.js`);
    watcher.fire(`${FOLDER_NAME}/character/spawn.js`);
    watcher.fire(`${FOLDER_NAME}/main.js`);
    jest.advanceTimersByTime(150);
    await flushAsync();

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledWith({
      changedRelativePath: `${FOLDER_NAME}/main.js`,
      wasDeleted: false,
    });
  });

  it('does not fire for paths outside the game code folder', async () => {
    const watcher = makeFakeWatcher();
    const onReload = jest.fn(() => Promise.resolve());
    makeAutoReload({ onReload, setupWatcher: watcher.setupWatcher });

    watcher.fire('assets/hero.png');
    watcher.fire(`${getByokGameCodeFolderName('My Game 2')}/x.js`);
    jest.advanceTimersByTime(150);
    await flushAsync();

    expect(onReload).not.toHaveBeenCalled();
  });

  it('does not fire for non-JavaScript files inside the game code folder', async () => {
    const watcher = makeFakeWatcher();
    const onReload = jest.fn(() => Promise.resolve());
    makeAutoReload({ onReload, setupWatcher: watcher.setupWatcher });

    watcher.fire(`${FOLDER_NAME}/gamecode.json`);
    watcher.fire(`${FOLDER_NAME}/notes.txt`);
    watcher.fire(`${FOLDER_NAME}/folder/`);
    jest.advanceTimersByTime(150);
    await flushAsync();

    expect(onReload).not.toHaveBeenCalled();
  });

  it('refuses re-entry while a reload is in flight, then runs the queued trigger', async () => {
    const watcher = makeFakeWatcher();
    let resolveFirstReload: ?() => void = null;
    const onReload = mockFn(
      jest.fn(
        () =>
          new Promise(resolve => {
            resolveFirstReload = resolve;
          })
      )
    );
    makeAutoReload({
      onReload,
      setupWatcher: watcher.setupWatcher,
      store: (makeFakeStore(['main.js', 'character/spawn.js']): any),
    });

    watcher.fire(`${FOLDER_NAME}/main.js`);
    jest.advanceTimersByTime(150);
    await flushAsync();
    expect(onReload).toHaveBeenCalledTimes(1);

    // A second trigger during the (still pending) reload is refused.
    watcher.fire(`${FOLDER_NAME}/character/spawn.js`);
    jest.advanceTimersByTime(150);
    await flushAsync();
    expect(onReload).toHaveBeenCalledTimes(1);

    if (!resolveFirstReload) throw new Error('Expected a pending reload.');
    resolveFirstReload();
    await flushAsync();

    // The queued trigger runs as a NEW reload, never as a re-entry.
    expect(onReload).toHaveBeenCalledTimes(2);
    expect(onReload.mock.calls[1][0]).toEqual({
      changedRelativePath: `${FOLDER_NAME}/character/spawn.js`,
      wasDeleted: false,
    });
  });

  it('does nothing while the setting is off, and re-reads it on every event', async () => {
    const watcher = makeFakeWatcher();
    const onReload = jest.fn(() => Promise.resolve());
    let isEnabled = false;
    makeAutoReload({
      onReload,
      setupWatcher: watcher.setupWatcher,
      isEnabled: () => isEnabled,
    });

    watcher.fire(`${FOLDER_NAME}/main.js`);
    jest.advanceTimersByTime(150);
    await flushAsync();
    expect(onReload).not.toHaveBeenCalled();

    // The setting is captured nowhere: flipping it on makes the NEXT event
    // fire, without resubscribing.
    isEnabled = true;
    watcher.fire(`${FOLDER_NAME}/main.js`);
    jest.advanceTimersByTime(150);
    await flushAsync();
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('detects deletion per file: a burst may mix a live file and a deleted one', async () => {
    const watcher = makeFakeWatcher();
    const onReload = jest.fn(() => Promise.resolve());
    makeAutoReload({
      onReload,
      setupWatcher: watcher.setupWatcher,
      // The store only knows main.js: spawn.js was deleted.
      store: (makeFakeStore(['main.js']): any),
    });

    // A burst ending on the live file reloads it, alive.
    watcher.fire(`${FOLDER_NAME}/character/spawn.js`);
    watcher.fire(`${FOLDER_NAME}/main.js`);
    jest.advanceTimersByTime(150);
    await flushAsync();

    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledWith({
      changedRelativePath: `${FOLDER_NAME}/main.js`,
      wasDeleted: false,
    });
  });

  it('flags the changed file as deleted when it no longer reads', async () => {
    const watcher = makeFakeWatcher();
    const onReload = jest.fn(() => Promise.resolve());
    makeAutoReload({
      onReload,
      setupWatcher: watcher.setupWatcher,
      store: (makeFakeStore(['main.js']): any),
    });

    watcher.fire(`${FOLDER_NAME}/character/spawn.js`);
    jest.advanceTimersByTime(150);
    await flushAsync();

    expect(onReload).toHaveBeenCalledWith({
      changedRelativePath: `${FOLDER_NAME}/character/spawn.js`,
      wasDeleted: true,
    });
  });

  it('flags an unlink event as deleted even when the store still reads it', async () => {
    const watcher = makeFakeWatcher();
    const onReload = jest.fn(() => Promise.resolve());
    makeAutoReload({
      onReload,
      setupWatcher: watcher.setupWatcher,
      // The store still serves the file (a stale cache): the watcher's
      // 'unlink' kind is authoritative ([P17-kind-hint]).
      store: (makeFakeStore(['main.js', 'character/spawn.js']): any),
    });

    watcher.fire(`${FOLDER_NAME}/character/spawn.js`, 'unlink');
    jest.advanceTimersByTime(150);
    await flushAsync();

    expect(onReload).toHaveBeenCalledWith({
      changedRelativePath: `${FOLDER_NAME}/character/spawn.js`,
      wasDeleted: true,
    });
  });

  it('keeps working after a failing reload', async () => {
    const watcher = makeFakeWatcher();
    const onReload = mockFn(jest.fn());
    onReload.mockImplementationOnce(() =>
      Promise.reject(new Error('the export failed'))
    );
    onReload.mockImplementationOnce(() => Promise.resolve());
    makeAutoReload({ onReload, setupWatcher: watcher.setupWatcher });

    watcher.fire(`${FOLDER_NAME}/main.js`);
    jest.advanceTimersByTime(150);
    await flushAsync();
    expect(onReload).toHaveBeenCalledTimes(1);

    watcher.fire(`${FOLDER_NAME}/main.js`);
    jest.advanceTimersByTime(150);
    await flushAsync();
    expect(onReload).toHaveBeenCalledTimes(2);
  });

  it('stops reacting after the unsubscribe', async () => {
    const watcher = makeFakeWatcher();
    const onReload = jest.fn(() => Promise.resolve());
    const unsubscribe = makeAutoReload({
      onReload,
      setupWatcher: watcher.setupWatcher,
    });

    unsubscribe();
    expect(watcher.getUnsubscribeCount()).toBe(1);

    watcher.fire(`${FOLDER_NAME}/main.js`);
    jest.advanceTimersByTime(150);
    await flushAsync();
    expect(onReload).not.toHaveBeenCalled();
  });

  it('drops an armed debounce when unsubscribed before it fires', async () => {
    const watcher = makeFakeWatcher();
    const onReload = jest.fn(() => Promise.resolve());
    const unsubscribe = makeAutoReload({
      onReload,
      setupWatcher: watcher.setupWatcher,
    });

    watcher.fire(`${FOLDER_NAME}/main.js`);
    unsubscribe();
    jest.advanceTimersByTime(150);
    await flushAsync();

    expect(onReload).not.toHaveBeenCalled();
  });

  it('subscribes to nothing and returns a safe unsubscribe without a project', () => {
    const watcher = makeFakeWatcher();
    const unsubscribe = makeAutoReload({
      getProject: () => null,
      setupWatcher: watcher.setupWatcher,
    });

    expect(watcher.setupWatcher).not.toHaveBeenCalled();
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });
});
