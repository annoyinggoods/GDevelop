// @flow
import { startForkAssetAutoReload } from './ForkAssetAutoReload';

const gd: libGDevelop = global.gd;

const makeProject = () => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  project.setProjectFile('C:/projects/game/game.json');
  return project;
};

const addResource = (project: any, name: string, file: string) => {
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
  const fire = (identifier: string, eventKind: ?string = null) => {
    if (listener) listener({ fileIdentifier: identifier, event: eventKind });
  };
  return { subscribe, fire };
};

const flushBurst = () => {
  jest.advanceTimersByTime(1000);
};

describe('startForkAssetAutoReload', () => {
  let project: any;

  beforeEach(() => {
    jest.useFakeTimers();
    project = makeProject();
  });

  afterEach(() => {
    project.delete();
    jest.useRealTimers();
  });

  const start = (
    overrides?: {|
      isEnabled?: () => boolean,
      onReloadIdentifier?: (identifier: string) => void,
      notifyPreviewReload?: () => void,
    |},
    subscription: any = makeFakeSubscription()
  ) => {
    const stop = startForkAssetAutoReload({
      project,
      subscribe: subscription.subscribe,
      onReloadIdentifier:
        (overrides && overrides.onReloadIdentifier) || jest.fn(),
      notifyPreviewReload:
        (overrides && overrides.notifyPreviewReload) || jest.fn(),
      isEnabled: overrides && overrides.isEnabled,
    });
    return { subscription, stop };
  };

  it('reloads a changed file that IS a project resource (by file)', () => {
    addResource(project, 'hero', 'art/hero.png');
    const onReloadIdentifier = (jest.fn(): any);
    const { subscription, stop } = start({ onReloadIdentifier });

    subscription.fire('art/hero.png');
    flushBurst();

    expect(onReloadIdentifier).toHaveBeenCalledTimes(1);
    expect(onReloadIdentifier).toHaveBeenCalledWith('art/hero.png');
    stop();
  });

  it('matches by resource NAME too (and normalizes backslashes)', () => {
    addResource(project, 'sfx/jump.wav', 'audio\\jump.wav');
    const onReloadIdentifier = (jest.fn(): any);
    const { subscription, stop } = start({ onReloadIdentifier });

    subscription.fire('audio/jump.wav');
    subscription.fire('sfx/jump.wav');
    flushBurst();

    expect(onReloadIdentifier).toHaveBeenCalledWith('audio/jump.wav');
    expect(onReloadIdentifier).toHaveBeenCalledWith('sfx/jump.wav');
    expect(onReloadIdentifier).toHaveBeenCalledTimes(2);
    stop();
  });

  it('ignores a changed file that is no project resource', () => {
    addResource(project, 'hero', 'art/hero.png');
    const onReloadIdentifier = (jest.fn(): any);
    const { subscription, stop } = start({ onReloadIdentifier });

    subscription.fire('notes.txt');
    flushBurst();

    expect(onReloadIdentifier).not.toHaveBeenCalled();
    stop();
  });

  it('collapses a burst for the same file into one reload', () => {
    addResource(project, 'hero', 'art/hero.png');
    const onReloadIdentifier = (jest.fn(): any);
    const { subscription, stop } = start({ onReloadIdentifier });

    subscription.fire('art/hero.png');
    subscription.fire('art/hero.png');
    flushBurst();

    expect(onReloadIdentifier).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does nothing while the setting is off', () => {
    addResource(project, 'hero', 'art/hero.png');
    const onReloadIdentifier = (jest.fn(): any);
    const { subscription, stop } = start({
      onReloadIdentifier,
      isEnabled: () => false,
    });

    subscription.fire('art/hero.png');
    flushBurst();

    expect(onReloadIdentifier).not.toHaveBeenCalled();
    stop();
  });

  it('stops entirely after the stop function (no late reload)', () => {
    addResource(project, 'hero', 'art/hero.png');
    const onReloadIdentifier = (jest.fn(): any);
    const { subscription, stop } = start({ onReloadIdentifier });

    subscription.fire('art/hero.png');
    stop();
    flushBurst();

    expect(onReloadIdentifier).not.toHaveBeenCalled();
  });

  it('sees a resource registered in the same burst (identifiers re-read at flush)', () => {
    const onReloadIdentifier = (jest.fn(): any);
    const { subscription, stop } = start({ onReloadIdentifier });

    subscription.fire('brand-new.png');
    // The auto-register adds the resource before the debounce fires.
    addResource(project, 'brand-new.png', 'brand-new.png');
    flushBurst();

    expect(onReloadIdentifier).toHaveBeenCalledWith('brand-new.png');
    stop();
  });

  it('notifies the preview reload seam once per burst that reloaded something ([P17-preview-reload])', () => {
    addResource(project, 'hero', 'art/hero.png');
    addResource(project, 'coin', 'art/coin.png');
    const notifyPreviewReload = (jest.fn(): any);
    const { subscription, stop } = start({ notifyPreviewReload });

    subscription.fire('art/hero.png');
    subscription.fire('art/coin.png');
    flushBurst();

    expect(notifyPreviewReload).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not notify the preview reload seam for a burst of unrelated files', () => {
    addResource(project, 'hero', 'art/hero.png');
    const notifyPreviewReload = (jest.fn(): any);
    const { subscription, stop } = start({ notifyPreviewReload });

    subscription.fire('notes.txt');
    flushBurst();

    expect(notifyPreviewReload).not.toHaveBeenCalled();
    stop();
  });

  it('does not notify the preview reload seam while the setting is off', () => {
    addResource(project, 'hero', 'art/hero.png');
    const notifyPreviewReload = (jest.fn(): any);
    const { subscription, stop } = start({
      notifyPreviewReload,
      isEnabled: () => false,
    });

    subscription.fire('art/hero.png');
    flushBurst();

    expect(notifyPreviewReload).not.toHaveBeenCalled();
    stop();
  });

  it('does not notify the preview reload seam after the stop function', () => {
    addResource(project, 'hero', 'art/hero.png');
    const notifyPreviewReload = (jest.fn(): any);
    const { subscription, stop } = start({ notifyPreviewReload });

    subscription.fire('art/hero.png');
    stop();
    flushBurst();

    expect(notifyPreviewReload).not.toHaveBeenCalled();
  });
});
