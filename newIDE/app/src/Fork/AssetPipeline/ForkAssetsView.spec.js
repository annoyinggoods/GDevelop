/**
 * @jest-environment jsdom
 */
// @flow

// jsdom does not implement matchMedia, which PreferencesContext (pulled in
// through ResourcesWatcher) and useResponsiveWindowSize (TreeView) read at
// module load / render time. Polyfill BEFORE any module loads — hence the
// plain requires below, the GameCodeTree.spec.js convention.
if (!(window: any).matchMedia) {
  (window: any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  });
}

const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react-dom/test-utils');
const { setupI18n } = require('@lingui/core');
const { I18nProvider } = require('@lingui/react');
const DragAndDropContextProvider = require('../../UI/DragAndDrop/DragAndDropContextProvider')
  .default;
const ForkAssetsView = require('./ForkAssetsView').default;
const {
  FORK_ASSET_FILTER_ALL,
  FORK_ASSET_FILTER_UNTAGGED,
  filterForkAssetTreeByTag,
} = require('./ForkAssetsView');
const { setForkResourceTags } = require('./ForkAssetTagStore');
const { buildForkAssetTree } = require('./ForkAssetTree');
const {
  resetForkAssetPipelineSettingsForTests,
  setForkAssetPipelineSettings,
} = require('./ForkAssetPipelineSettings');

const gd: libGDevelop = global.gd;

const i18n = setupI18n({ language: 'en', catalogs: {} });

const makeProject = () => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  project.setProjectFile('C:/projects/game/game.json');
  return project;
};

const addTaggedResource = (project: any, name: string, tags: Array<string>) => {
  const resource = new gd.ImageResource();
  resource.setName(name);
  resource.setFile(name);
  project.getResourcesManager().addResource(resource);
  resource.delete();
  // addResource stored a COPY: tag the stored resource, not the wrapper.
  setForkResourceTags({
    resource: project.getResourcesManager().getResource(name),
    tags,
  });
};

const renderView = async (props: any) => {
  const container = document.createElement('div');
  if (!document.body) throw new Error('missing document body');
  document.body.appendChild(container);
  let root: any = null;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <I18nProvider i18n={i18n} language="en">
        <DragAndDropContextProvider>
          <ForkAssetsView height={400} {...props} />
        </DragAndDropContextProvider>
      </I18nProvider>
    );
    await Promise.resolve();
  });
  return {
    container,
    root,
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
};

/** The deepest element whose text is exactly the given name. */
const findElementByText = (container: HTMLElement, text: string) => {
  const candidates = Array.from(container.querySelectorAll('*')).filter(
    element => element.textContent === text
  );
  return candidates[candidates.length - 1] || null;
};

describe("filterForkAssetTreeByTag (the view's filter predicate)", () => {
  const tree = buildForkAssetTree({
    resources: [
      { name: 'hero.png', tags: ['player', 'red'] },
      { name: 'enemy.png', tags: ['red'] },
      { name: 'lonely.png', tags: [] },
    ],
  });

  it('keeps everything on the all-filter', () => {
    expect(filterForkAssetTreeByTag(tree, FORK_ASSET_FILTER_ALL)).toEqual(tree);
  });

  it('keeps exactly the folder of a tag, and the Untagged bucket', () => {
    const redOnly = filterForkAssetTreeByTag(tree, 'red');
    expect(redOnly.map(folder => folder.name)).toEqual(['red']);
    expect(redOnly[0].children.map(child => child.name)).toEqual([
      'enemy.png',
      'hero.png',
    ]);
    const untaggedOnly = filterForkAssetTreeByTag(
      tree,
      FORK_ASSET_FILTER_UNTAGGED
    );
    expect(untaggedOnly.map(folder => folder.name)).toEqual(['Untagged']);
    expect(untaggedOnly[0].children.map(child => child.name)).toEqual([
      'lonely.png',
    ]);
  });

  it('is empty for a tag nothing carries', () => {
    expect(filterForkAssetTreeByTag(tree, 'ghost')).toEqual([]);
  });
});

describe('ForkAssetsView', () => {
  let project: any;

  beforeEach(() => {
    resetForkAssetPipelineSettingsForTests();
    project = makeProject();
  });

  afterEach(() => {
    project.delete();
  });

  it('renders the tag folders (an asset under every tag, Untagged reachable)', async () => {
    addTaggedResource(project, 'hero.png', ['player', 'red']);
    addTaggedResource(project, 'enemy.png', []);
    const { container, unmount } = await renderView({
      project,
      onSelectResource: jest.fn(),
    });

    const text = container.textContent || '';
    expect(text).toContain('player');
    expect(text).toContain('red');
    expect(text).toContain('Untagged');
    expect(text).toContain('hero.png');
    expect(text).toContain('enemy.png');
    unmount();
  });

  it('updates the tree immediately when a tag is written through the store', async () => {
    addTaggedResource(project, 'hero.png', []);
    const { container, unmount } = await renderView({
      project,
      onSelectResource: jest.fn(),
    });
    expect(container.textContent).toContain('Untagged');

    const resource = project.getResourcesManager().getResource('hero.png');
    await act(async () => {
      setForkResourceTags({ resource, tags: ['enemy'] });
      await Promise.resolve();
    });

    expect(container.textContent).toContain('enemy');
    unmount();
  });

  it('selects the resource in the host when an asset row is clicked', async () => {
    addTaggedResource(project, 'hero.png', ['player']);
    const onSelectResource = (jest.fn(): any);
    const { container, unmount } = await renderView({
      project,
      onSelectResource,
    });

    const heroRow = findElementByText(container, 'hero.png');
    if (!heroRow) throw new Error('The asset row was not rendered.');
    await act(async () => {
      heroRow.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true })
      );
      await Promise.resolve();
    });

    expect(onSelectResource).toHaveBeenCalledTimes(1);
    const selected = onSelectResource.mock.calls[0][0];
    expect(selected.getName()).toBe('hero.png');
    unmount();
  });

  it('renders the two pipeline toggles with the persisted states', async () => {
    setForkAssetPipelineSettings({ autoRegister: false, autoReload: true });
    const { container, unmount } = await renderView({
      project,
      onSelectResource: jest.fn(),
    });

    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(2);
    expect((checkboxes[0]: any).checked).toBe(false);
    expect((checkboxes[1]: any).checked).toBe(true);
    unmount();
  });
});
