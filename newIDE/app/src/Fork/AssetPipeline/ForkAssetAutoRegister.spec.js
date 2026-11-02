// @flow
import { makeForkAssetIgnoreMatcher } from './ForkAssetAutoRegister';
import {
  FORK_ASSET_WATCHER_ORIGIN,
  reconcileForkAssetResources,
} from './ForkAssetRegistration';
import { startForkAssetAutoRegister } from './ForkAssetAutoRegister';

const gd: libGDevelop = global.gd;

const makeProject = () => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  project.setProjectFile('C:/projects/game/game.json');
  return project;
};

const resourceNames = (project: any): Array<string> =>
  project
    .getResourcesManager()
    .getAllResourceNames()
    .toJSArray();

const addUserResource = (project: any, name: string, file: string) => {
  const resource = new gd.ImageResource();
  resource.setName(name);
  resource.setFile(file);
  project.getResourcesManager().addResource(resource);
  resource.delete();
};

/** A subscription seam that hands back a manual "fire an event" probe. */
const makeFakeSubscription = () => {
  let listener: ?(event: {|
    fileIdentifier: string,
    event: ?string,
  |}) => void = null;
  const subscribe = jest.fn(
    (
      callback: (event: {|
        fileIdentifier: string,
        event: ?string,
      |}) => void
    ) => {
      listener = callback;
      return () => {
        listener = null;
      };
    }
  );
  // An absent kind (null) is what a source that cannot tell looks like —
  // the stat fallback then classifies.
  const fire = (identifier: string, eventKind: ?string = null) => {
    if (listener) listener({ fileIdentifier: identifier, event: eventKind });
  };
  return { subscribe, fire };
};

const flushBurst = () => {
  jest.advanceTimersByTime(1000);
};

describe('makeForkAssetIgnoreMatcher', () => {
  const ignore = makeForkAssetIgnoreMatcher('C:/projects/game/game.json');

  it('ignores the project file, its autosave and the index sidecar', () => {
    expect(ignore('game.json')).toBe(true);
    expect(ignore('game.json.autosave')).toBe(true);
    expect(ignore('assets-index.json')).toBe(true);
  });

  it('ignores hidden files, partial downloads and node_modules', () => {
    expect(ignore('.DS_Store')).toBe(true);
    expect(ignore('art/.git')).toBe(true);
    expect(ignore('hero.png.tmp')).toBe(true);
    expect(ignore('hero.png.crdownload')).toBe(true);
    expect(ignore('node_modules/lib/x.png')).toBe(true);
  });

  it('keeps ordinary asset files', () => {
    expect(ignore('hero.png')).toBe(false);
    expect(ignore('art/enemy.png')).toBe(false);
  });
});

describe('startForkAssetAutoRegister', () => {
  let project: any;

  beforeEach(() => {
    jest.useFakeTimers();
    project = makeProject();
  });

  afterEach(() => {
    project.delete();
    jest.useRealTimers();
  });

  const startWithDefaults = (
    existingFiles: Set<string>,
    onProjectModified: () => void = () => {}
  ) => {
    const subscription = makeFakeSubscription();
    const stop = startForkAssetAutoRegister({
      project,
      onProjectModified,
      subscribe: subscription.subscribe,
      fileExists: relativePath => existingFiles.has(relativePath),
    });
    return { subscription, stop };
  };

  it('registers a new PNG once and flags the project modified', () => {
    const onProjectModified = (jest.fn(): any);
    const existing = new Set<string>(['hero.png']);
    const { subscription, stop } = startWithDefaults(
      existing,
      onProjectModified
    );

    subscription.fire('hero.png');
    flushBurst();

    expect(resourceNames(project)).toEqual(['hero.png']);
    expect(onProjectModified).toHaveBeenCalledTimes(1);
    stop();
  });

  it('is idempotent on a second event for the same file (no re-flag)', () => {
    const onProjectModified = (jest.fn(): any);
    const existing = new Set<string>(['hero.png']);
    const { subscription, stop } = startWithDefaults(
      existing,
      onProjectModified
    );

    subscription.fire('hero.png');
    flushBurst();
    // The watcher fires again (a change, or the add/change of one burst).
    subscription.fire('hero.png');
    flushBurst();

    expect(resourceNames(project)).toEqual(['hero.png']);
    expect(onProjectModified).toHaveBeenCalledTimes(1);
    stop();
  });

  it('collapses an add+change burst for the same file into one reconcile', () => {
    const onProjectModified = (jest.fn(): any);
    const existing = new Set<string>(['hero.png']);
    const { subscription, stop } = startWithDefaults(
      existing,
      onProjectModified
    );

    subscription.fire('hero.png');
    subscription.fire('hero.png');
    flushBurst();

    expect(resourceNames(project)).toEqual(['hero.png']);
    expect(onProjectModified).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does nothing for an ignored file or a file outside the folder', () => {
    const onProjectModified = (jest.fn(): any);
    const existing = new Set<string>(['hero.png.tmp']);
    const { subscription, stop } = startWithDefaults(
      existing,
      onProjectModified
    );

    // Ignored by the default matcher (partial name):
    subscription.fire('hero.png.tmp');
    // Unconfined path:
    subscription.fire('../outside.png');
    flushBurst();

    expect(resourceNames(project)).toEqual([]);
    expect(onProjectModified).not.toHaveBeenCalled();
    stop();
  });

  it('does nothing when the setting is off', () => {
    const onProjectModified = (jest.fn(): any);
    const existing = new Set<string>(['hero.png']);
    const subscription = makeFakeSubscription();
    const stop = startForkAssetAutoRegister({
      project,
      onProjectModified,
      subscribe: subscription.subscribe,
      fileExists: relativePath => existing.has(relativePath),
      isEnabled: () => false,
    });

    subscription.fire('hero.png');
    flushBurst();

    expect(resourceNames(project)).toEqual([]);
    stop();
  });

  it('removes a watcher-origin resource when its file disappears', () => {
    const onProjectModified = (jest.fn(): any);
    const existing = new Set<string>(['hero.png']);
    const { subscription, stop } = startWithDefaults(
      existing,
      onProjectModified
    );

    subscription.fire('hero.png');
    flushBurst();
    existing.delete('hero.png');
    subscription.fire('hero.png');
    flushBurst();

    expect(resourceNames(project)).toEqual([]);
    expect(onProjectModified).toHaveBeenCalledTimes(2);
    stop();
  });

  it('never removes a user-added resource whose file disappears', () => {
    const onProjectModified = (jest.fn(): any);
    addUserResource(project, 'user.png', 'user.png');
    const existing = new Set<string>([]);
    const { subscription, stop } = startWithDefaults(
      existing,
      onProjectModified
    );

    subscription.fire('user.png');
    flushBurst();

    expect(resourceNames(project)).toEqual(['user.png']);
    expect(onProjectModified).not.toHaveBeenCalled();
    stop();
  });

  it('stops entirely after the stop function (no late reconcile)', () => {
    const onProjectModified = (jest.fn(): any);
    const existing = new Set<string>(['hero.png']);
    const { subscription, stop } = startWithDefaults(
      existing,
      onProjectModified
    );

    subscription.fire('hero.png');
    stop();
    flushBurst();

    expect(resourceNames(project)).toEqual([]);
    expect(onProjectModified).not.toHaveBeenCalled();
  });

  it('treats a deleted-then-recreated file inside one burst as existing', () => {
    const onProjectModified = (jest.fn(): any);
    const existing = new Set<string>(['hero.png']);
    const { subscription, stop } = startWithDefaults(
      existing,
      onProjectModified
    );

    // First the file is reported gone, then it exists again before the
    // debounce fires.
    subscription.fire('hero.png');
    existing.add('hero.png');
    subscription.fire('hero.png');
    flushBurst();

    expect(resourceNames(project)).toEqual(['hero.png']);
    stop();
  });

  it('trusts the watcher event kinds over the disk state ([P17-kind-hint])', () => {
    const onProjectModified = (jest.fn(): any);
    const existing = new Set<string>(['hero.png']);
    const { subscription, stop } = startWithDefaults(
      existing,
      onProjectModified
    );

    // A deletion the stat fallback could not have seen in time (the file
    // still reads), then an addition of a file the stat no longer sees —
    // the event kinds decide.
    subscription.fire('hero.png', 'unlink');
    subscription.fire('new.png', 'add');
    flushBurst();

    expect(resourceNames(project)).toEqual(['new.png']);
    stop();
  });

  it('classifies by the existence stat when the kind is absent', () => {
    const onProjectModified = (jest.fn(): any);
    const existing = new Set<string>(['hero.png']);
    const { subscription, stop } = startWithDefaults(
      existing,
      onProjectModified
    );

    // No kind: the fallback stats the file at EVENT time (the original
    // behavior) — a file whose stat says gone before the burst flushes is
    // classified as gone.
    existing.delete('hero.png');
    subscription.fire('hero.png');
    subscription.fire('gone.png');
    flushBurst();

    expect(resourceNames(project)).toEqual([]);
    stop();
  });
});

describe('the reconcile origin marker (integration with the watcher origin)', () => {
  it('marks the auto-registered resources with the watcher origin', () => {
    const project = makeProject();
    try {
      reconcileForkAssetResources({ project, onDiskFiles: ['a.png'] });
      expect(
        project
          .getResourcesManager()
          .getResource('a.png')
          .getOriginName()
      ).toBe(FORK_ASSET_WATCHER_ORIGIN);
    } finally {
      project.delete();
    }
  });
});
