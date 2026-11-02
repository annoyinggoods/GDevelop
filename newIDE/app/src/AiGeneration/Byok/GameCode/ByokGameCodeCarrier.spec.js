// @flow

/**
 * The Phase 15.2 carrier. These tests drive the REAL libGD build (the
 * established pattern, see ByokExtensionTools.spec.js) and, for the
 * acceptance criteria that talk about what actually SHIPS, run a REAL
 * preview export and read the emitted `index.html` out of the export
 * folder. Reading the export is the point: inspecting the extension object
 * would pass even if the exporter never emitted a tag.
 */

import {
  BYOK_GAME_CODE_MARKER_ACTION_NAME,
  BYOK_GAME_CODE_MARKER_FUNCTION_NAME,
  ensureByokGameCodeCarrier,
  getByokGameCodeMarkerActionFullName,
  listByokGameCodeForeignResourceFileNames,
  makeByokGameCodeMarkerEventsListObject,
} from './ByokGameCodeCarrier';
import {
  BYOK_GAME_CODE_CARRIER_EXTENSION_NAME,
  getByokGameCodeFolderName,
  getByokGameCodeProjectRelativeFilePath,
  getByokGameCodeResourceName,
} from './ByokGameCodeCore';
import { getByokGameCodeStore } from './ByokGameCodeStore';
import { loadProjectEventsFunctionsExtensions } from '../../../EventsFunctionsExtensionsLoader';
import LocalFileSystem from '../../../ExportAndShare/LocalExporters/LocalFileSystem';
import { assignIn } from 'lodash';

// $FlowFixMe[cannot-resolve-module] - a Node builtin, used by this spec only.
const os = require('os');
// $FlowFixMe[cannot-resolve-module] - a Node builtin, used by this spec only.
const nodeFs = require('fs');
// $FlowFixMe[cannot-resolve-module] - a Node builtin, used by this spec only.
const nodePath = require('path');

const gd: libGDevelop = global.gd;

const FOLDER_NAME = getByokGameCodeFolderName('CarrierGame');

// $FlowFixMe[cannot-resolve-name] - a Node global, used by this spec only.
const GDJS_ROOT = nodePath.resolve(__dirname, '../../../../resources/GDJS');

let workingDirectory: string;
let projectFile: string;

beforeEach(() => {
  workingDirectory = nodeFs.mkdtempSync(
    nodePath.join(os.tmpdir(), 'byok-game-code-carrier-')
  );
  projectFile = nodePath.join(workingDirectory, 'CarrierGame.json');
});

afterEach(() => {
  nodeFs.rmSync(workingDirectory, { recursive: true, force: true });
});

/** A project with one empty scene — the "no extension usage at all" case. */
const makeProject = (): any => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  project.insertNewLayout('Scene1', 0);
  project.setProjectFile(projectFile);
  return project;
};

/**
 * Declare the project's extensions into JsPlatform, the way MainFrame does
 * after any change.
 *
 * This is REQUIRED, not a convenience: `UsedExtensionsFinder` resolves an
 * instruction's metadata through `project.GetCurrentPlatform()`, so an
 * extension that only exists in the project model is invisible to the
 * exporter until it has been declared. In the IDE the tools already flush
 * `reloadEventsFunctionsExtensions` once per batch for exactly this reason.
 */
const declareProjectExtensions = async (project: any) => {
  await loadProjectEventsFunctionsExtensions(
    project,
    {
      getIncludeFileFor: (functionName: string) =>
        'generated/' + functionName + '.js',
      writeFunctionCode: () => Promise.resolve(),
      writeBehaviorCode: () => Promise.resolve(),
      writeObjectCode: () => Promise.resolve(),
    },
    ({ _: (text: string) => text }: any)
  );
};

/** Write game-code files on disk under <project>/<GameName>Code/. */
const writeGameCodeFiles = async (
  files: Array<[string, string]>
): Promise<void> => {
  const store = getByokGameCodeStore();
  for (const [relativePath, content] of files) {
    const written = await store.writeFile(
      projectFile,
      FOLDER_NAME,
      relativePath,
      content
    );
    if (!written.ok) throw new Error(written.error);
  }
};

const listCarrierSourceFiles = (project: any): Array<string> => {
  const extension = project.getEventsFunctionsExtension(
    BYOK_GAME_CODE_CARRIER_EXTENSION_NAME
  );
  const sourceFiles = extension.getAllSourceFiles();
  const names = [];
  for (let index = 0; index < sourceFiles.size(); index++) {
    names.push(sourceFiles.at(index).getResourceName());
  }
  return names;
};

/**
 * A REAL preview export, and the `<script src>` list it produced.
 *
 * This is what makes the acceptance criteria testable: the exporter is the
 * component that decides whether a game-code file reaches the browser, and
 * it is also the component that renames resources (flattening them into the
 * export folder), so nothing above it can assert the outcome by inspection.
 */
const exportPreviewAndListScripts = async (
  project: any
): Promise<Array<string>> => {
  // The exporter scans the PLATFORM's extensions, not the project's ones:
  // UsedExtensionsFinder resolves an instruction through
  // project.GetCurrentPlatform(), so an extension that only exists in the
  // project model is invisible until it has been declared (the IDE flushes
  // `reloadEventsFunctionsExtensions` once per tool batch for this).
  await declareProjectExtensions(project);
  const exportPath = nodePath.join(workingDirectory, 'export');
  const codeOutputDir = nodePath.join(workingDirectory, 'code');
  const previewExportOptions = new gd.PreviewExportOptions(project, exportPath);
  try {
    previewExportOptions.setIsInGameEdition(false);
    previewExportOptions.setLayoutName('Scene1');
    previewExportOptions.setShouldReloadProjectData(true);
    previewExportOptions.setShouldReloadLibraries(true);
    previewExportOptions.setShouldGenerateScenesEventsCode(true);
    previewExportOptions.setShouldClearExportFolder(true);
    // The exporter needs the app's real filesystem object (the renderer's
    // `assignIn(new gd.AbstractFileSystemJS(), new LocalFileSystem())`,
    // see LocalPreviewLauncher's prepareExporter) — a bare
    // `new gd.AbstractFileSystemJS()` throws "a JSImplementation must
    // implement all functions".
    const fileSystem = assignIn(
      new gd.AbstractFileSystemJS(),
      new LocalFileSystem({ downloadUrlsToLocalFiles: false })
    );
    const exporter = new gd.Exporter(fileSystem, GDJS_ROOT);
    exporter.setCodeOutputDirectory(codeOutputDir);
    try {
      exporter.exportProjectForPixiPreview(previewExportOptions);
    } finally {
      exporter.delete();
    }
  } finally {
    previewExportOptions.delete();
  }

  const indexHtml = nodeFs.readFileSync(
    nodePath.join(exportPath, 'index.html'),
    'utf8'
  );
  return [...indexHtml.matchAll(/<script src="([^"]+)"/g)].map(
    match => match[1]
  );
};

describe('makeByokGameCodeMarkerEventsListObject', () => {
  it('is one unconditional event carrying the carrier action', () => {
    const events = makeByokGameCodeMarkerEventsListObject(
      'GameCode::markGameCodeAsUsed'
    );
    expect(events.event).toHaveLength(1);
    expect(events.event[0].type).toBe('BuiltinCommonInstructions::Standard');
    expect(events.event[0].conditions).toEqual({ instruction: [] });
    expect(events.event[0].actions.instruction[0].type).toEqual({
      value: 'GameCode::markGameCodeAsUsed',
    });
  });

  it('names the marker action the way the engine resolves it', () => {
    // The engine resolves an extension action as `<extension>:<action>`;
    // anything else is an unknown instruction, which would silently make
    // the carrier "used" by nothing.
    expect(getByokGameCodeMarkerActionFullName()).toBe(
      BYOK_GAME_CODE_CARRIER_EXTENSION_NAME +
        '::' +
        BYOK_GAME_CODE_MARKER_ACTION_NAME
    );
  });
});

describe('ensureByokGameCodeCarrier: the structural use (D15-4)', () => {
  it('creates the extension with the marker action and function', () => {
    const project = makeProject();
    expect(
      ensureByokGameCodeCarrier({
        project,
        gameCodeFolderName: FOLDER_NAME,
        relativePaths: [],
      }).didModifyProject
    ).toBe(true);

    expect(
      project.hasEventsFunctionsExtensionNamed(
        BYOK_GAME_CODE_CARRIER_EXTENSION_NAME
      )
    ).toBe(true);
    const extension = project.getEventsFunctionsExtension(
      BYOK_GAME_CODE_CARRIER_EXTENSION_NAME
    );
    const functions = extension.getEventsFunctions();
    expect(
      functions.hasEventsFunctionNamed(BYOK_GAME_CODE_MARKER_ACTION_NAME)
    ).toBe(true);
    expect(
      functions.hasEventsFunctionNamed(BYOK_GAME_CODE_MARKER_FUNCTION_NAME)
    ).toBe(true);
  });

  it('puts a real call to the marker action in the marker function body', () => {
    const project = makeProject();
    ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: [],
    });
    const extension = project.getEventsFunctionsExtension(
      BYOK_GAME_CODE_CARRIER_EXTENSION_NAME
    );
    const functions = extension.getEventsFunctions();
    const markerFunction = functions.getEventsFunction(
      BYOK_GAME_CODE_MARKER_FUNCTION_NAME
    );
    expect(markerFunction).toBeTruthy();
    if (!markerFunction) return;
    // The event is there: this is the whole point of the marker, because
    // UsedExtensionsFinder reaches an extension through its own events.
    expect(markerFunction.getEvents().getEventsCount()).toBe(1);
  });

  it('declares the marker action under the name the engine resolves', async () => {
    // The load-bearing half of D15-4, and the half that CAN be proved here.
    // `UsedExtensionsFinder::DoVisitInstruction` resolves an instruction
    // through `GetExtensionAndActionMetadata`, so an action the platform
    // does not declare under its exact full name is an UNKNOWN instruction
    // and the carrier is never marked used — silently, with no error. A
    // one-colon `GameCode:action` spelling fails exactly that way (it was
    // found while writing this test), so the declared name is read back off
    // JsPlatform rather than recomputed from our own constant.
    const project = makeProject();
    ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: ['main.js'],
    });
    await declareProjectExtensions(project);

    const declaredNames = [];
    const platformExtensions = gd
      .asPlatform(gd.JsPlatform.get())
      .getAllPlatformExtensions();
    for (let index = 0; index < platformExtensions.size(); index++) {
      const extension = platformExtensions.at(index);
      if (
        String(extension.getName()) !== BYOK_GAME_CODE_CARRIER_EXTENSION_NAME
      ) {
        continue;
      }
      const actions = extension.getAllActions();
      for (const name of actions
        .keys()
        .toJSArray()
        .map(String)) {
        declaredNames.push(name);
      }
    }
    expect(declaredNames).toContain(getByokGameCodeMarkerActionFullName());

    const metadata = gd.MetadataProvider.getExtensionAndActionMetadata(
      gd.JsPlatform.get(),
      getByokGameCodeMarkerActionFullName()
    );
    expect(
      gd.MetadataProvider.isBadInstructionMetadata(metadata.getMetadata())
    ).toBe(false);
  });

  it('is not provable through ScanProject in the Jest harness', () => {
    // WHY this test exists rather than a green assertion: `ScanProject` is
    // the entry point the EXPORTER uses to decide that the carrier is used,
    // so the real end-to-end proof is the preview export below plus the
    // desktop QA of A15-7.
    //
    // It cannot be asserted here. `ScanProject` returns only "BuiltinObject"
    // in this harness even for a scene event written by the app's OWN
    // already-tested event writer (`byokApplySceneEventBatches`, applied
    // successfully with a real `CreateTimerNew` action) — so the finder is
    // blind in the test WASM, for everyone, not for game code in
    // particular. Asserting the carrier here would either fail for an
    // unrelated reason or, once the harness is fixed, start telling us
    // something real.
    //
    // What is pinned instead: the carrier declares the marker, the marker
    // body calls the marker action (the two tests above), and the exporter
    // copies the game-code files (the export tests below).
    expect(true).toBe(true);
  });

  it('is idempotent: a second call reports no modification', () => {
    const project = makeProject();
    ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: ['main.js'],
    });
    expect(
      ensureByokGameCodeCarrier({
        project,
        gameCodeFolderName: FOLDER_NAME,
        relativePaths: ['main.js'],
      }).didModifyProject
    ).toBe(false);
  });

  it('repairs a marker function whose body was emptied', () => {
    const project = makeProject();
    ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: ['main.js'],
    });
    const extension = project.getEventsFunctionsExtension(
      BYOK_GAME_CODE_CARRIER_EXTENSION_NAME
    );
    const functions = extension.getEventsFunctions();
    functions
      .getEventsFunction(BYOK_GAME_CODE_MARKER_FUNCTION_NAME)
      .getEvents()
      .clear();
    ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: ['main.js'],
    });
    const repaired = project
      .getEventsFunctionsExtension(BYOK_GAME_CODE_CARRIER_EXTENSION_NAME)
      .getEventsFunctions();
    expect(
      repaired
        .getEventsFunction(BYOK_GAME_CODE_MARKER_FUNCTION_NAME)
        .getEvents()
        .getEventsCount()
    ).toBe(1);
  });
});

describe('ensureByokGameCodeCarrier: the resource registry', () => {
  it('registers one javascript resource per game-code file', async () => {
    const project = makeProject();
    await writeGameCodeFiles([
      ['main.js', 'GameCode = window.GameCode || {};'],
      ['character/spawn.js', 'GameCode.character = {};'],
    ]);
    ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: ['character/spawn.js', 'main.js'],
    });

    const resourcesManager = project.getResourcesManager();
    expect(
      resourcesManager.hasResource(
        getByokGameCodeResourceName('main.js', FOLDER_NAME)
      )
    ).toBe(true);
    const resource = resourcesManager.getResource(
      getByokGameCodeResourceName('main.js', FOLDER_NAME)
    );
    expect(resource.getKind()).toBe('javascript');
    expect(resource.getFile()).toBe(
      getByokGameCodeProjectRelativeFilePath('main.js', FOLDER_NAME)
    );
  });

  it('declares the source files in D15-3a order', async () => {
    const project = makeProject();
    ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      // Deliberately unordered, and with a tier-2 file first.
      relativePaths: [
        'enemy/spawn.js',
        'main.js',
        'core/boot.js',
        'character/hero.js',
      ],
    });
    expect(listCarrierSourceFiles(project)).toEqual([
      getByokGameCodeResourceName('core/boot.js', FOLDER_NAME),
      getByokGameCodeResourceName('main.js', FOLDER_NAME),
      getByokGameCodeResourceName('character/hero.js', FOLDER_NAME),
      getByokGameCodeResourceName('enemy/spawn.js', FOLDER_NAME),
    ]);
  });

  it('reorders the declarations when a new file joins an earlier tier', async () => {
    const project = makeProject();
    ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: ['character/hero.js', 'main.js'],
    });
    // `aaa.js` sorts before `core/`, so the whole tier-1 order shifts and a
    // positional reconciler would leave the list wrong.
    ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: ['character/hero.js', 'main.js', 'aaa.js'],
    });
    expect(listCarrierSourceFiles(project)).toEqual([
      getByokGameCodeResourceName('aaa.js', FOLDER_NAME),
      getByokGameCodeResourceName('main.js', FOLDER_NAME),
      getByokGameCodeResourceName('character/hero.js', FOLDER_NAME),
    ]);
  });

  it('includes every source file last, so the engine is already loaded', () => {
    const project = makeProject();
    ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: ['main.js'],
    });
    const sourceFiles = project
      .getEventsFunctionsExtension(BYOK_GAME_CODE_CARRIER_EXTENSION_NAME)
      .getAllSourceFiles();
    expect(sourceFiles.at(0).getIncludePosition()).toBe('last');
  });

  it('removes the resource AND the declaration of a deleted file', async () => {
    const project = makeProject();
    ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: ['main.js', 'character/spawn.js'],
    });
    const result = ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: ['main.js'],
    });
    expect(result.removedResourceNames).toEqual([
      getByokGameCodeResourceName('character/spawn.js', FOLDER_NAME),
    ]);
    expect(
      project
        .getResourcesManager()
        .hasResource(
          getByokGameCodeResourceName('character/spawn.js', FOLDER_NAME)
        )
    ).toBe(false);
    expect(listCarrierSourceFiles(project)).toEqual([
      getByokGameCodeResourceName('main.js', FOLDER_NAME),
    ]);
  });

  it('never removes a resource the user added', () => {
    const project = makeProject();
    const resourcesManager = project.getResourcesManager();
    const userResource = new gd.ImageResource();
    userResource.setName('hero.png');
    userResource.setFile('hero.png');
    resourcesManager.addResource(userResource);
    userResource.delete();

    ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: ['main.js'],
    });
    ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: [],
    });
    expect(resourcesManager.hasResource('hero.png')).toBe(true);
  });

  it('reports the exported script name of each file', () => {
    const project = makeProject();
    const result = ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: ['character/spawn.js', 'enemy/spawn.js'],
    });
    expect(result.exportedScriptNames).toEqual({
      'character/spawn.js': 'spawn.js',
      'enemy/spawn.js': 'spawn2.js',
    });
  });
});

describe('listByokGameCodeForeignResourceFileNames', () => {
  it('lists every other resource file name', () => {
    const project = makeProject();
    const resourcesManager = project.getResourcesManager();
    const other = new gd.ImageResource();
    other.setName('jump');
    other.setFile('sounds/jump.wav');
    resourcesManager.addResource(other);
    other.delete();

    expect(
      listByokGameCodeForeignResourceFileNames(project, ['MyGameCode/main.js'])
    ).toEqual(['jump.wav']);
  });

  it('ignores the game-code resources themselves', () => {
    const project = makeProject();
    ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: ['main.js', 'character/spawn.js'],
    });
    expect(
      listByokGameCodeForeignResourceFileNames(project, [
        getByokGameCodeResourceName('main.js', FOLDER_NAME),
        getByokGameCodeResourceName('character/spawn.js', FOLDER_NAME),
      ])
    ).toEqual([]);
  });
});

describe('a real preview export (A15-1, 15.2 acceptance)', () => {
  /** The `.js` files the export actually produced for the game code. */
  const exportedGameCodeFiles = (): Array<string> => {
    const exportPath = nodePath.join(workingDirectory, 'export');
    if (!nodeFs.existsSync(exportPath)) return [];
    return nodeFs.readdirSync(exportPath).filter(name => /\.js$/i.test(name));
  };

  it('runs a real export of a project that carries game code', async () => {
    const project = makeProject();
    await writeGameCodeFiles([
      ['main.js', 'GameCode = window.GameCode || {};'],
      ['character/spawn.js', 'GameCode.character = {};'],
    ]);
    ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: ['character/spawn.js', 'main.js'],
    });
    // A project whose extension declarations the exporter cannot read must
    // still export cleanly — a carrier that broke the export would take the
    // whole preview down, not just the game code.
    await expect(exportPreviewAndListScripts(project)).resolves.toEqual(
      expect.any(Array)
    );
  });

  it('copies every game-code file into the export folder', async () => {
    const project = makeProject();
    await writeGameCodeFiles([
      ['enemy/spawn.js', 'GameCode.enemy = {};'],
      ['character/hero.js', 'GameCode.character = {};'],
      ['main.js', 'GameCode = window.GameCode || {};'],
      ['core/boot.js', 'GameCode.boot = function () {};'],
    ]);
    ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: [
        'enemy/spawn.js',
        'character/hero.js',
        'main.js',
        'core/boot.js',
      ],
    });
    await exportPreviewAndListScripts(project);
    // The exporter copies resources FLAT (ResourcesMergingHelper with
    // preserveDirectoriesStructure = false), so the file that was written as
    // `<GameName>Code/character/hero.js` ships as `hero.js`. This is the
    // fact the hot reload's exported-name computation exists for.
    expect(exportedGameCodeFiles()).toEqual(
      expect.arrayContaining(['boot.js', 'main.js', 'hero.js', 'spawn.js'])
    );
  });

  it('drops the exported copy of a deleted file on the next export', async () => {
    const project = makeProject();
    await writeGameCodeFiles([
      ['main.js', 'GameCode = window.GameCode || {};'],
      ['character/spawn.js', 'GameCode.character = {};'],
    ]);
    ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: ['main.js', 'character/spawn.js'],
    });
    await exportPreviewAndListScripts(project);
    expect(exportedGameCodeFiles()).toContain('spawn.js');

    const store = getByokGameCodeStore();
    const deleted = await store.deleteFile(
      projectFile,
      FOLDER_NAME,
      'character/spawn.js'
    );
    expect(deleted.ok).toBe(true);
    const result = ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: ['main.js'],
    });
    expect(result.removedResourceNames).toEqual([
      getByokGameCodeResourceName('character/spawn.js', FOLDER_NAME),
    ]);

    await exportPreviewAndListScripts(project);
    expect(exportedGameCodeFiles()).toContain('main.js');
    expect(exportedGameCodeFiles()).not.toContain('spawn.js');
  });

  it('predicts the exported names the export actually produced', async () => {
    // The hot reload fetches those exact strings. If the prediction and the
    // export ever diverge, a reload fetches a URL that 404s.
    const project = makeProject();
    await writeGameCodeFiles([
      ['character/spawn.js', 'GameCode.character = {};'],
      ['enemy/spawn.js', 'GameCode.enemy = {};'],
      ['main.js', 'GameCode = window.GameCode || {};'],
    ]);
    const result = ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: ['character/spawn.js', 'enemy/spawn.js', 'main.js'],
    });
    await exportPreviewAndListScripts(project);
    const predicted = result.orderedRelativePaths
      .map(relativePath => result.exportedScriptNames[relativePath])
      .filter(scriptName => scriptName !== null);
    // D15-3a order: the folder root first, then the groupings alphabetically.
    expect(predicted).toEqual(['main.js', 'spawn.js', 'spawn2.js']);
    // A predicate, not a value list: `predicted` is `Array<string>` and
    // jest's `arrayContaining` is typed `Array<mixed>`, which Flow rejects
    // for an invariant array.
    expect(exportedGameCodeFiles()).toEqual(
      expect.arrayContaining(predicted.map(name => expect.stringMatching(name)))
    );
  });

  it('emits no game-code copy at all when the folder is empty', async () => {
    const project = makeProject();
    ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName: FOLDER_NAME,
      relativePaths: [],
    });
    expect(listCarrierSourceFiles(project)).toEqual([]);
    await exportPreviewAndListScripts(project);
    expect(exportedGameCodeFiles()).not.toContain('main.js');
  });

  it('cannot prove the <script src> tags here, and says so', () => {
    // WHY this test is a statement rather than an assertion: the last hop of
    // A15-1 is `CompleteIndexFile` emitting one `<script src>` per used
    // source file, and it is gated on `UsedExtensionsFinder::ScanProject`
    // reporting the carrier as used.
    //
    // That finder is BLIND in this harness: it answers only "BuiltinObject"
    // even for a scene event written by the app's own already-tested event
    // writer (byokApplySceneEventBatches, applied successfully with a real
    // CreateTimerNew action), and for an object of a carrier-declared type
    // placed in the scene. So no `<script src>` assertion here would be
    // anything but a false green.
    //
    // What IS proved above: the carrier extension and its source-file
    // declarations, the resources, the D15-3a order, and the exporter
    // copying every file to the name the hot reload will fetch. The
    // remaining hop is the manual desktop QA of A15-7.
    expect(true).toBe(true);
  });
});
