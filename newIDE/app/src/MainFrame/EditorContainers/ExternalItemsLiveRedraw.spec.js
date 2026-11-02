// @flow
/**
 * @jest-environment jsdom
 */
import { ExternalLayoutEditorContainer } from './ExternalLayoutEditorContainer';
import { ExternalEventsEditorContainer } from './ExternalEventsEditorContainer';

// The containers pull the full SceneEditor/EventsSheet stacks (pixi, three,
// spine — ESM packages jest cannot parse) plus the resource-watcher and
// storage dialogs. The ref methods under test never render or touch these:
// mock them away. Jest hoists these mocks above the imports.
jest.mock('../../SceneEditor', () => ({}));
jest.mock('../../EventsSheet', () => ({}));
jest.mock('../ResourcesWatcher', () => ({
  registerOnResourceExternallyChangedCallback: () => null,
  unregisterOnResourceExternallyChangedCallback: () => {},
}));
jest.mock('../../EmbeddedGame/EmbeddedGameFrame', () => ({
  switchToSceneEdition: () => {},
  setEditorHotReloadNeeded: () => {},
  switchInGameEditorIfNoHotReloadIsNeeded: () => {},
}));
jest.mock('./ExternalPropertiesDialog', () => ({}));

// The containers demand the full editor props in their constructor: the
// tests only exercise the ref methods, so bypass the check.
const AnyExternalLayoutEditorContainer: any = (ExternalLayoutEditorContainer: any);
const AnyExternalEventsEditorContainer: any = (ExternalEventsEditorContainer: any);

const gd: libGDevelop = global.gd;

const makeProject = () => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  const scene = project.insertNewLayout('TestScene', 0);
  scene.getObjects().insertNewObject(project, 'Sprite', 'Player', 0);
  project.insertNewExternalEvents('UiSheet', 0);
  project.getExternalEvents('UiSheet').setAssociatedLayout('TestScene');
  const spawn = project.insertNewExternalLayout('SpawnPoint', 0);
  spawn.setAssociatedLayout('TestScene');
  return project;
};

describe('ExternalItemsLiveRedraw (the outside-editor fan-out)', () => {
  it('refreshes the editor of the edited external layout only', () => {
    const project = makeProject();
    // Direct instantiation: only the ref methods under test run (no render).
    const container: any = new AnyExternalLayoutEditorContainer({
      project,
      projectItemName: 'SpawnPoint',
    });
    const refresh = (jest.fn(): any);
    container.editor = { onInstancesModifiedOutsideEditor: refresh };

    container.onExternalLayoutModifiedOutsideEditor({
      externalLayoutName: 'SpawnPoint',
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    // Another external layout: ignored.
    container.onExternalLayoutModifiedOutsideEditor({
      externalLayoutName: 'OtherLayout',
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    project.delete();
  });

  it('does nothing for an external layout without a mounted editor', () => {
    const project = makeProject();
    const container: any = new AnyExternalLayoutEditorContainer({
      project,
      projectItemName: 'SpawnPoint',
    });
    container.editor = null;

    expect(() =>
      container.onExternalLayoutModifiedOutsideEditor({
        externalLayoutName: 'SpawnPoint',
      })
    ).not.toThrow();
    project.delete();
  });

  it('refreshes the editor of the edited external events only', () => {
    const project = makeProject();
    const container: any = new AnyExternalEventsEditorContainer({
      project,
      projectItemName: 'UiSheet',
    });
    const eventIds = new Set(['event-1']);
    const refresh = (jest.fn(): any);
    container.editor = { onEventsModifiedOutsideEditor: refresh };

    container.onExternalEventsModifiedOutsideEditor({
      externalEventsName: 'UiSheet',
      newOrChangedAiGeneratedEventIds: eventIds,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({
      newOrChangedAiGeneratedEventIds: eventIds,
    });

    // Another external events sheet: ignored.
    container.onExternalEventsModifiedOutsideEditor({
      externalEventsName: 'OtherSheet',
      newOrChangedAiGeneratedEventIds: new Set(),
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    project.delete();
  });

  it('does nothing for an external events sheet without a mounted editor', () => {
    const project = makeProject();
    const container: any = new AnyExternalEventsEditorContainer({
      project,
      projectItemName: 'UiSheet',
    });
    container.editor = null;

    expect(() =>
      container.onExternalEventsModifiedOutsideEditor({
        externalEventsName: 'UiSheet',
        newOrChangedAiGeneratedEventIds: new Set(),
      })
    ).not.toThrow();
    project.delete();
  });
});
