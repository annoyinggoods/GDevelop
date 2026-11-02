/**
 * @jest-environment jsdom
 */
// @flow
import * as React from 'react';
import { act } from 'react-dom/test-utils';
import TestRenderer from 'react-test-renderer';
import { I18nProvider } from '@lingui/react';
import { setupI18n } from '@lingui/core';
import optionalRequire from '../../Utils/OptionalRequire';
import type { ForkSpriteSheetDialogDeps } from './ForkSpriteSheetDialog';
import type { ForkSpriteSheetToolDeps } from './ForkSpriteSheetToolHandler';
import type { ForkSpriteSheetSliceRequest } from './ForkSpriteSheetPort';

const path = (optionalRequire('path'): any);

const gd: libGDevelop = global.gd;

const PROJECT_FILE = path.resolve('/projects/game/game.json');
const ASSETS_FOLDER = path.join(path.dirname(PROJECT_FILE), 'MyGameAssets');
const SOURCE_IMAGE = path.resolve('/sheets/player.png');

// jsdom does not implement matchMedia — and the module chain of UI/Dialog
// (→ PreferencesContext) reads it AT LOAD TIME, so the polyfill must run
// BEFORE those modules are required (imports hoist, hence the requires
// below — the ByokPromptGuard.spec.js convention).
if (!(window: any).matchMedia) {
  (window: any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// MUI's Dialog mounts through a Portal react-test-renderer cannot drive
// (`parentInstance.children.indexOf is not a function`). The spec is about
// the dialog's CONTENT and interactions, so the Dialog primitive is
// replaced by a passthrough that renders its title, actions and children —
// every string and button the user sees is still real (the
// ForkAssetReportDialog.spec.js convention).
jest.mock('../../UI/Dialog', () => {
  const react: any = require('react');
  return {
    __esModule: true,
    default: (props: any) =>
      react.createElement(
        'div',
        null,
        props.title,
        props.subtitle,
        props.children,
        props.actions
      ),
  };
});

const FlatButton = require('../../UI/FlatButton').default;
const RaisedButton = require('../../UI/RaisedButton').default;
const SemiControlledTextField = require('../../UI/SemiControlledTextField')
  .default;
const ForkSpriteSheetDialog = require('./ForkSpriteSheetDialog').default;

// The UI primitives read the app's i18n context; an empty catalog renders
// the English source messages (the ByokSettingsTab spec convention).
const i18n = setupI18n({ language: 'en', catalogs: {} });

const collectText = (node: any): string => {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join(' ');
  if (node.children) return collectText(node.children);
  return '';
};

/** The visible label of a React ELEMENT (a <Trans> carries its text). */
const elementText = (element: any): string => {
  if (element === null || element === undefined) return '';
  if (typeof element === 'string' || typeof element === 'number') {
    return String(element);
  }
  if (Array.isArray(element)) return element.map(elementText).join(' ');
  if (React.isValidElement(element)) {
    const props: any = element.props;
    return [props.id, elementText(props.children)].filter(Boolean).join(' ');
  }
  return '';
};

/** The in-memory "disk" discipline of the handler spec: writing = adding. */
const makeImportDeps = (): {|
  deps: ForkSpriteSheetToolDeps,
  invokeSlice: any,
|} => {
  const writtenFiles: Set<string> = new Set();
  const invokeSlice = (jest.fn(): any).mockImplementation(
    async (request: ForkSpriteSheetSliceRequest) => {
      const writtenAbsolutePaths = request.frameFileNames.map(fileName =>
        path.join(request.assetsFolderAbsolutePath, fileName)
      );
      for (const writtenPath of writtenAbsolutePaths) {
        writtenFiles.add(writtenPath);
      }
      return { ok: true, writtenAbsolutePaths };
    }
  );
  const deps: ForkSpriteSheetToolDeps = {
    pathLib: path,
    portDeps: {
      readImageSize: (jest.fn(): any).mockResolvedValue({
        width: 512,
        height: 512,
      }),
      invokeSlice,
    },
    assembleDeps: {
      fs: {
        existsSync: (filePath: string) => writtenFiles.has(filePath),
        copyFile: async () => {
          throw new Error('copyFile must not be called for sliced frames');
        },
      },
      pathLib: path,
      downloadFile: async () => {
        throw new Error('downloads are not part of sprite-sheet import');
      },
    },
  };
  return { deps, invokeSlice };
};

const makeDialogDeps = (
  importDeps: ?ForkSpriteSheetToolDeps,
  pickFileOverride?: any
): ForkSpriteSheetDialogDeps => ({
  importDeps,
  pickFile:
    pickFileOverride || (jest.fn(): any).mockResolvedValue(SOURCE_IMAGE),
});

const makeProject = () => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  project.setName('MyGame');
  project.setProjectFile(PROJECT_FILE);
  const layout = project.insertNewLayout('TestScene', 0);
  layout.getObjects().insertNewObject(project, 'Sprite', 'Player', 0);
  return project;
};

const renderDialog = async (options: {|
  project: any,
  deps: ForkSpriteSheetDialogDeps,
  onClose: (didImport: boolean) => void,
|}) => {
  let renderer: any = null;
  await act(async () => {
    renderer = TestRenderer.create(
      <I18nProvider i18n={i18n} language="en">
        <ForkSpriteSheetDialog
          project={options.project}
          objectName="Player"
          onClose={options.onClose}
          deps={options.deps}
        />
      </I18nProvider>
    );
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  return renderer;
};

const findFlatButton = (renderer: Object, labelPart: string) => {
  const button = renderer.root
    .findAllByType(FlatButton)
    .find(node => elementText(node.props.label).includes(labelPart));
  if (!button) throw new Error(`No FlatButton labelled "${labelPart}".`);
  return button;
};

const findRaisedButton = (renderer: Object, labelPart: string) => {
  const button = renderer.root
    .findAllByType(RaisedButton)
    .find(node => elementText(node.props.label).includes(labelPart));
  if (!button) throw new Error(`No RaisedButton labelled "${labelPart}".`);
  return button;
};

const findTextField = (renderer: Object, labelPart: string) => {
  const field = renderer.root
    .findAllByType(SemiControlledTextField)
    .find(node =>
      elementText(node.props.floatingLabelText).includes(labelPart)
    );
  if (!field) throw new Error(`No field labelled "${labelPart}".`);
  return field;
};

/** Pick the source image through the injected picker, then let the size read settle. */
const chooseImage = async (renderer: Object) => {
  await act(async () => {
    await findFlatButton(renderer, 'Choose image').props.onClick();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

describe('ForkSpriteSheetDialog', () => {
  let project: any;

  beforeEach(() => {
    project = makeProject();
  });

  afterEach(() => {
    project.delete();
  });

  it('shows the desktop-only notice without the desktop deps', async () => {
    const onClose = (jest.fn(): any);
    const renderer = await renderDialog({
      project,
      deps: makeDialogDeps(null),
      onClose,
    });

    const text = collectText(renderer.toJSON());
    expect(text).toContain('only available in the desktop app');
    expect(findRaisedButton(renderer, 'Import').props.disabled).toBe(true);
    expect(findFlatButton(renderer, 'Choose image').props.disabled).toBe(true);
  });

  it('shows the plan error and disables Import for a non-dividing grid', async () => {
    const { deps, invokeSlice } = makeImportDeps();
    const renderer = await renderDialog({
      project,
      deps: makeDialogDeps(deps),
      onClose: (jest.fn(): any),
    });
    await chooseImage(renderer);
    await act(async () => {
      findTextField(renderer, 'Rows').props.onChange('3');
    });

    const text = collectText(renderer.toJSON());
    expect(text).toContain('does not divide');
    const importButton = findRaisedButton(renderer, 'Import');
    expect(importButton.props.disabled).toBe(true);
    // A refused plan writes nothing: the slicer fake is untouched.
    expect(invokeSlice).not.toHaveBeenCalled();
  });

  it('shows the frame count for a dividing grid', async () => {
    const { deps } = makeImportDeps();
    const renderer = await renderDialog({
      project,
      deps: makeDialogDeps(deps),
      onClose: (jest.fn(): any),
    });
    await chooseImage(renderer);

    const text = collectText(renderer.toJSON());
    expect(text).toContain('16');
    expect(findRaisedButton(renderer, 'Import').props.disabled).toBe(false);
  });

  it('imports through the port + assembly and closes with the refresh signal', async () => {
    const { deps, invokeSlice } = makeImportDeps();
    const onClose = (jest.fn(): any);
    const renderer = await renderDialog({
      project,
      deps: makeDialogDeps(deps),
      onClose,
    });
    await chooseImage(renderer);

    await act(async () => {
      await findRaisedButton(renderer, 'Import').props.onClick();
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    // The slicer ran once, with the 16 planned frames of a 4×4 grid.
    expect(invokeSlice).toHaveBeenCalledTimes(1);
    expect(invokeSlice.mock.calls[0][0].frames).toHaveLength(16);
    expect(invokeSlice.mock.calls[0][0].assetsFolderAbsolutePath).toBe(
      ASSETS_FOLDER
    );
    // The real assembly ran: the animation exists on the object.
    const object = project
      .getLayout('TestScene')
      .getObjects()
      .getObject('Player');
    const animations = gd
      .asSpriteConfiguration(object.getConfiguration())
      .getAnimations();
    expect(animations.getAnimationsCount()).toBe(1);
    expect(animations.getAnimation(0).getName()).toBe('Imported');
    expect(
      animations
        .getAnimation(0)
        .getDirection(0)
        .getSpritesCount()
    ).toBe(16);
    // The success summary is shown.
    const text = collectText(renderer.toJSON());
    expect(text).toContain('16 frame(s)');
    // Closing after a success carries the should-refresh signal.
    await act(async () => {
      findFlatButton(renderer, 'Close').props.onClick();
    });
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('closes without the refresh signal when nothing was imported', async () => {
    const { deps } = makeImportDeps();
    const onClose = (jest.fn(): any);
    const renderer = await renderDialog({
      project,
      deps: makeDialogDeps(deps),
      onClose,
    });

    await act(async () => {
      findFlatButton(renderer, 'Close').props.onClick();
    });
    expect(onClose).toHaveBeenCalledWith(false);
  });
});
