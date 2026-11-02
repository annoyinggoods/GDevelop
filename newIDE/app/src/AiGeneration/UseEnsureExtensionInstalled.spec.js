// @flow
/**
 * @jest-environment jsdom
 */
import * as React from 'react';
import reactTestRenderer from 'react-test-renderer';
import { useEnsureExtensionInstalled } from './UseEnsureExtensionInstalled';
import { ExtensionStoreContext } from '../AssetStore/ExtensionStore/ExtensionStoreContext';

jest.mock('../AssetStore/ExtensionStore/InstallExtension', () => ({
  useInstallExtension: jest.fn(() => jest.fn(async () => {})),
  checkRequiredExtensionsUpdate: jest.fn(async () => ({})),
  getRequiredExtensions: jest.fn(() => []),
  getExtensionHeader: (jest.fn(() => null): any),
  ensureExtensionsRegistryLoaded: jest.fn(async () => ({})),
}));

const makeProject = (isLoaded: boolean) => {
  const isExtensionLoaded = (jest.fn(() => isLoaded): any);
  return {
    name: 'project-under-test',
    getCurrentPlatform: () => ({ isExtensionLoaded }),
    // $FlowFixMe[unclear-type] - test fake exposing the inner mock.
    __isExtensionLoaded: (isExtensionLoaded: any),
  };
};

const extensionStoreState = {
  translatedExtensionShortHeadersByName: {},
  fetchExtensionsAndFilters: (jest.fn(): any),
};

const Probe = ({
  project,
  getProject,
  capture,
}: {|
  project: ?Object,
  getProject?: () => ?Object,
  capture: {| current: any |},
|}) => {
  capture.current = useEnsureExtensionInstalled({
    // $FlowFixMe[incompatible-exact] - test fakes standing in for a gdProject.
    project,
    getProject,
    i18n: ({ _: (descriptor: any) => String(descriptor) }: any),
  });
  return null;
};

const renderHook = (
  project: ?Object,
  getProject?: () => ?Object
): {| capture: {| current: any |}, renderer: any |} => {
  const capture: {| current: any |} = { current: null };
  const renderer = reactTestRenderer.create(
    <ExtensionStoreContext.Provider value={(extensionStoreState: any)}>
      <Probe project={project} getProject={getProject} capture={capture} />
    </ExtensionStoreContext.Provider>
  );
  return { capture, renderer };
};

describe('useEnsureExtensionInstalled (O3: project getter over render prop)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads the project through the getter when one is provided (the mid-chat creation case)', async () => {
    // The scenario of the O3 bug: the React prop is still null because the
    // project was created a moment ago (initialize_project in a BYOK chat)
    // and the editor has not re-rendered yet — the getter already sees it.
    const freshProject = makeProject(false);
    const { capture } = renderHook(null, () => freshProject);

    // The extension is not loaded on the fresh project, so the install
    // proceeds past the loaded-check (and then fails on the empty registry,
    // which is expected here).
    await expect(
      capture.current.ensureExtensionInstalled({ extensionName: 'SomeExt' })
    ).rejects.toThrow();
    expect(freshProject.__isExtensionLoaded).toHaveBeenCalledWith('SomeExt');
    expect(extensionStoreState.fetchExtensionsAndFilters).toHaveBeenCalled();
  });

  it('does not install when the fresh project already has the extension', async () => {
    const freshProject = makeProject(true);
    const { capture } = renderHook(null, () => freshProject);

    await capture.current.ensureExtensionInstalled({
      extensionName: 'SomeExt',
    });
    expect(freshProject.__isExtensionLoaded).toHaveBeenCalledWith('SomeExt');
    expect(
      extensionStoreState.fetchExtensionsAndFilters
    ).not.toHaveBeenCalled();
  });

  it('does nothing when the getter reports no project at all', async () => {
    const { capture } = renderHook(makeProject(false), () => null);

    await capture.current.ensureExtensionInstalled({
      extensionName: 'SomeExt',
    });
    expect(
      extensionStoreState.fetchExtensionsAndFilters
    ).not.toHaveBeenCalled();
  });

  it('still reads the project prop when no getter is given (the pre-existing callers)', async () => {
    const propProject = makeProject(true);
    const { capture } = renderHook(propProject);

    await capture.current.ensureExtensionInstalled({
      extensionName: 'SomeExt',
    });
    expect(propProject.__isExtensionLoaded).toHaveBeenCalledWith('SomeExt');
    expect(
      extensionStoreState.fetchExtensionsAndFilters
    ).not.toHaveBeenCalled();
  });
});
