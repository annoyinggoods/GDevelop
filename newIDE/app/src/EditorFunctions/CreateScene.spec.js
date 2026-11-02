// @flow
import {
  editorFunctions,
  isValidSceneBackgroundColor,
  type EditorFunctionGenericOutput,
} from './index';
import { makeFakeLaunchFunctionOptionsWithProject } from './TestHelpers';

const gd: libGDevelop = global.gd;

describe('create_scene', () => {
  let project: gdProject;

  beforeEach(() => {
    // $FlowFixMe[invalid-constructor]
    project = new gd.ProjectHelper.createNewGDJSProject();
  });

  afterEach(() => {
    project.delete();
  });

  it('creates a new scene', async () => {
    const result: EditorFunctionGenericOutput = await editorFunctions.create_scene.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: { scene_name: 'Level1' },
      }
    );

    expect(result.success).toBe(true);
    expect(result.message).toBe('Created scene "Level1".');
    expect(result.meta).toEqual({ newSceneNames: ['Level1'] });
    expect(project.hasLayoutNamed('Level1')).toBe(true);
    // Only the base layer is created.
    expect(project.getLayout('Level1').getLayersCount()).toBe(1);
  });

  it('creates a new scene with a UI layer', async () => {
    const result: EditorFunctionGenericOutput = await editorFunctions.create_scene.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: { scene_name: 'Level1', include_ui_layer: true },
      }
    );

    expect(result.success).toBe(true);
    expect(result.message).toBe(
      'Created scene "Level1" with base layer + "UI" layer.'
    );
    expect(project.getLayout('Level1').hasLayerNamed('UI')).toBe(true);
  });

  it('creates a new scene with a background color', async () => {
    const result: EditorFunctionGenericOutput = await editorFunctions.create_scene.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: { scene_name: 'Level1', background_color: '#ff0080' },
      }
    );

    expect(result.success).toBe(true);
    const scene = project.getLayout('Level1');
    expect(scene.getBackgroundColorRed()).toBe(255);
    expect(scene.getBackgroundColorGreen()).toBe(0);
    expect(scene.getBackgroundColorBlue()).toBe(128);
  });

  it('creates a new scene with an "r;g;b" background color', async () => {
    const result: EditorFunctionGenericOutput = await editorFunctions.create_scene.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: { scene_name: 'Level1', background_color: '10;20;30' },
      }
    );

    expect(result.success).toBe(true);
    const scene = project.getLayout('Level1');
    expect(scene.getBackgroundColorRed()).toBe(10);
    expect(scene.getBackgroundColorGreen()).toBe(20);
    expect(scene.getBackgroundColorBlue()).toBe(30);
  });

  it('UP-16: refuses a color it cannot parse, and creates nothing', async () => {
    const layoutsBefore = project.getLayoutsCount();

    // "red" parsed to NaN, which hexNumberToRGBArray turned into 0,0,0: the
    // scene was persisted BLACK while the tool reported success.
    const result: EditorFunctionGenericOutput = await editorFunctions.create_scene.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: { scene_name: 'Level1', background_color: 'red' },
      }
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid background_color');
    // Nothing half-created: a refusal must not leave an empty scene behind.
    expect(project.getLayoutsCount()).toBe(layoutsBefore);
    expect(project.hasLayoutNamed('Level1')).toBe(false);
  });

  it('creates a new scene set as the first (startup) scene', async () => {
    project.insertNewLayout('ExistingScene', 0);

    const result: EditorFunctionGenericOutput = await editorFunctions.create_scene.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: { scene_name: 'Level1', is_first_scene: true },
      }
    );

    expect(result.success).toBe(true);
    expect(result.message).toBe(
      'Created scene "Level1". Also set as the first (startup) scene.'
    );
    expect(project.getFirstLayout()).toBe('Level1');
  });

  it('does not create a duplicate when the scene already exists', async () => {
    project.insertNewLayout('Level1', 0);

    const result: EditorFunctionGenericOutput = await editorFunctions.create_scene.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: { scene_name: 'Level1' },
      }
    );

    expect(result.success).toBe(true);
    expect(result.message).toBe('Scene "Level1" already exists.');
    expect(project.getLayoutsCount()).toBe(1);
  });

  it('adds the UI layer to an already existing scene', async () => {
    project.insertNewLayout('Level1', 0);

    const result: EditorFunctionGenericOutput = await editorFunctions.create_scene.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: { scene_name: 'Level1', include_ui_layer: true },
      }
    );

    expect(result.success).toBe(true);
    expect(result.message).toBe(
      'Scene "Level1" already exists; added "UI" layer.'
    );
    expect(project.getLayout('Level1').hasLayerNamed('UI')).toBe(true);
  });

  it('sets an already existing scene as the first (startup) scene', async () => {
    project.insertNewLayout('SceneA', 0);
    project.insertNewLayout('SceneB', 1);

    const result: EditorFunctionGenericOutput = await editorFunctions.create_scene.launchFunction(
      {
        ...makeFakeLaunchFunctionOptionsWithProject(project),
        args: { scene_name: 'SceneB', is_first_scene: true },
      }
    );

    expect(result.success).toBe(true);
    expect(result.message).toBe(
      'Scene "SceneB" already exists. Also set as the first (startup) scene.'
    );
    expect(project.getFirstLayout()).toBe('SceneB');
  });
});

describe('isValidSceneBackgroundColor (audit100226 UP-16)', () => {
  it('accepts the two forms rgbOrHexToHexNumber understands', () => {
    expect(isValidSceneBackgroundColor('#ff0080')).toBe(true);
    expect(isValidSceneBackgroundColor('ff0080')).toBe(true);
    expect(isValidSceneBackgroundColor('#FFFFFF')).toBe(true);
    expect(isValidSceneBackgroundColor('10;20;30')).toBe(true);
    expect(isValidSceneBackgroundColor(' 10 ; 20 ; 30 ')).toBe(true);
    expect(isValidSceneBackgroundColor('0;0;0')).toBe(true);
    expect(isValidSceneBackgroundColor('255;255;255')).toBe(true);
  });

  it('rejects anything that would parse to NaN', () => {
    expect(isValidSceneBackgroundColor('red')).toBe(false);
    expect(isValidSceneBackgroundColor('#fff')).toBe(false);
    expect(isValidSceneBackgroundColor('#gggggg')).toBe(false);
    expect(isValidSceneBackgroundColor('')).toBe(false);
    expect(isValidSceneBackgroundColor('10;20')).toBe(false);
    expect(isValidSceneBackgroundColor('10;20;30;40')).toBe(false);
    expect(isValidSceneBackgroundColor('300;0;0')).toBe(false);
    expect(isValidSceneBackgroundColor('-1;0;0')).toBe(false);
    expect(isValidSceneBackgroundColor('10;20;30.5')).toBe(false);
  });
});
