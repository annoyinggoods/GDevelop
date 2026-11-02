// @flow

/**
 * Phase 15.3 tools, driven the way the phase demands: a REAL libGD project
 * (the established pattern, see ByokExtensionTools.spec.js), a REAL
 * temporary directory through the SAME store singleton the production tools
 * use, and injected deps only for the environment cases (the non-desktop
 * store, the reload availability).
 */

import {
  findByNameokExtraTool,
  type ByokExtraToolCollaborators,
} from '../ByokExtraTools';
import { getByokDispatchableToolNames } from '../ByokToolSchema';
import {
  getByokGameCodeTools,
  type ByokGameCodeToolDeps,
} from './ByokGameCodeTools';
import { makeByokGameCodeStore } from './ByokGameCodeStore';
import {
  BYOK_GAME_CODE_CARRIER_EXTENSION_NAME,
  BYOK_GAME_CODE_MAX_FILE_BYTES,
  getByokGameCodeFolderName,
  getByokGameCodeResourceName,
} from './ByokGameCodeCore';

// $FlowFixMe[cannot-resolve-module] - a Node builtin, used by this spec only.
const os = require('os');
// $FlowFixMe[cannot-resolve-module] - a Node builtin, used by this spec only.
const nodeFs = require('fs');
// $FlowFixMe[cannot-resolve-module] - a Node builtin, used by this spec only.
const nodePath = require('path');

const gd: libGDevelop = global.gd;

const FOLDER_NAME = getByokGameCodeFolderName('MyGame');

let temporaryFolder: string;
let projectFile: string;
let project: any;
let collaborators: ByokExtraToolCollaborators;

beforeEach(() => {
  temporaryFolder = nodeFs.mkdtempSync(
    nodePath.join(os.tmpdir(), 'byok-game-code-tools-')
  );
  projectFile = nodePath.join(temporaryFolder, 'MyGame.json');
  nodeFs.writeFileSync(projectFile, '{}', 'utf8');
  project = gd.ProjectHelper.createNewGDJSProject();
  // The folder name derives from the PROJECT name (not the file name):
  // <GameName>Code with the sanitized project name.
  project.setName('MyGame');
  project.setProjectFile(projectFile);
  collaborators = makeCollaborators(project);
});

afterEach(() => {
  project.delete();
  nodeFs.rmSync(temporaryFolder, { recursive: true, force: true });
});

const makeCollaborators = (target: any): ByokExtraToolCollaborators => ({
  getProject: () => target,
  onSceneEventsModifiedOutsideEditor: () => {},
});

const getTool = (
  name: string,
  overrides?: Partial<ByokGameCodeToolDeps>
): any => {
  const tool = getByokGameCodeTools(overrides).find(
    candidate => candidate.name === name
  );
  if (!tool) throw new Error(`Tool ${name} not found.`);
  return tool;
};

/** The game-code folder next to the project file. */
const gameCodeFolderPath = () => nodePath.join(temporaryFolder, FOLDER_NAME);

const absoluteInFolder = (relativePath: string) =>
  nodePath.join(gameCodeFolderPath(), ...relativePath.split('/'));

const nonDesktopDeps = (): Partial<ByokGameCodeToolDeps> => ({
  store: makeByokGameCodeStore({
    fs: null,
    pathLib: null,
    ipcRenderer: null,
  }),
  reloadGameCode: null,
});

const GAME_CODE_TOOL_NAMES = [
  'list_game_code_files',
  'read_game_code_file',
  'write_game_code_file',
  'delete_game_code_file',
  'reload_game_code',
];

describe('the game code tools in the registry', () => {
  it('registers all five tools with the right modifiesProject flags', () => {
    const expectedFlags: { [string]: boolean } = {
      list_game_code_files: false,
      read_game_code_file: false,
      write_game_code_file: true,
      delete_game_code_file: true,
      reload_game_code: false,
    };
    for (const name of GAME_CODE_TOOL_NAMES) {
      const tool = findByNameokExtraTool(name);
      expect(tool).not.toBeNull();
      if (tool) {
        expect(tool.modifiesProject).toBe(expectedFlags[name]);
        expect(typeof tool.run).toBe('function');
      }
    }
  });

  it('resolves every name in getByokDispatchableToolNames()', () => {
    const dispatchable = getByokDispatchableToolNames();
    for (const name of GAME_CODE_TOOL_NAMES) {
      expect(dispatchable).toContain(name);
    }
  });
});

describe('list_game_code_files', () => {
  it('answers success on the empty starting folder', async () => {
    const result = await getTool('list_game_code_files').run({}, collaborators);
    expect(result.output.success).toBe(true);
    expect(result.output.files).toEqual([]);
    expect(result.output.game_code_folder).toBe(FOLDER_NAME);
    expect(result.didModifyProject).toBe(false);
  });

  it('lists the files in D15-3a order with sizes and namespaces', async () => {
    nodeFs.mkdirSync(absoluteInFolder('enemy'), { recursive: true });
    nodeFs.mkdirSync(absoluteInFolder('core'), { recursive: true });
    nodeFs.writeFileSync(absoluteInFolder('enemy/spawn.js'), 'spawn!');
    nodeFs.writeFileSync(absoluteInFolder('main.js'), 'main');
    nodeFs.writeFileSync(absoluteInFolder('core/boot.js'), 'boot');

    const result = await getTool('list_game_code_files').run({}, collaborators);
    expect(result.output.success).toBe(true);
    expect(result.output.files).toEqual([
      {
        relativePath: 'core/boot.js',
        size_bytes: 4,
        // core/ marks the boot order, it is NOT a namespace level.
        namespace: 'GameCode.boot',
      },
      { relativePath: 'main.js', size_bytes: 4, namespace: 'GameCode.main' },
      {
        relativePath: 'enemy/spawn.js',
        size_bytes: 6,
        namespace: 'GameCode.enemy.spawn',
      },
    ]);
  });

  it('answers with a refusal when no project is open', async () => {
    const result = await getTool('list_game_code_files').run(
      {},
      makeCollaborators(null)
    );
    expect(result.output.success).toBe(false);
    expect(result.didModifyProject).toBe(false);
  });
});

describe('read_game_code_file', () => {
  it('returns the content and the namespace of an existing file', async () => {
    nodeFs.mkdirSync(absoluteInFolder('character'), { recursive: true });
    nodeFs.writeFileSync(
      absoluteInFolder('character/spawn.js'),
      'GameCode.character.spawn = {};'
    );

    const result = await getTool('read_game_code_file').run(
      { path: 'character/spawn.js' },
      collaborators
    );
    expect(result.output.success).toBe(true);
    expect(result.output.content).toBe('GameCode.character.spawn = {};');
    expect(result.output.namespace).toBe('GameCode.character.spawn');
    expect(result.output.message).toContain('GameCode.character.spawn');
    expect(result.didModifyProject).toBe(false);
  });

  it('answers with a failure for a missing file', async () => {
    const result = await getTool('read_game_code_file').run(
      { path: 'ghost.js' },
      collaborators
    );
    expect(result.output.success).toBe(false);
    expect(result.output.message).toContain('ghost.js');
  });

  it('refuses a path outside the folder', async () => {
    const result = await getTool('read_game_code_file').run(
      { path: '../outside.js' },
      collaborators
    );
    expect(result.output.success).toBe(false);
    expect(result.output.message).toContain('Refused');
  });
});

describe('write_game_code_file', () => {
  it('writes the file, calls the carrier and answers didModifyProject', async () => {
    const result = await getTool('write_game_code_file').run(
      { path: 'main.js', content: 'GameCode.main = {};\n' },
      collaborators
    );
    expect(result.output.success).toBe(true);
    expect(result.didModifyProject).toBe(true);
    expect(nodeFs.readFileSync(absoluteInFolder('main.js'), 'utf8')).toBe(
      'GameCode.main = {};\n'
    );

    // The carrier ran: the extension exists, the resource is registered and
    // the source file is declared.
    expect(
      project.hasEventsFunctionsExtensionNamed(
        BYOK_GAME_CODE_CARRIER_EXTENSION_NAME
      )
    ).toBe(true);
    const resourceName = getByokGameCodeResourceName('main.js', FOLDER_NAME);
    expect(project.getResourcesManager().hasResource(resourceName)).toBe(true);
    const extension = project.getEventsFunctionsExtension(
      BYOK_GAME_CODE_CARRIER_EXTENSION_NAME
    );
    expect(extension.getAllSourceFiles().size()).toBe(1);

    // The message teaches the namespace and its prologue.
    expect(result.output.message).toContain('GameCode.main');
    expect(result.output.message).toContain(
      'GameCode = window.GameCode || {};'
    );
    expect(result.output.created).toBe(true);
  });

  it('overwrites an existing file and keeps the carrier in sync', async () => {
    await getTool('write_game_code_file').run(
      { path: 'main.js', content: 'a' },
      collaborators
    );
    const second = await getTool('write_game_code_file').run(
      { path: 'main.js', content: 'b' },
      collaborators
    );
    expect(second.output.created).toBe(false);
    expect(nodeFs.readFileSync(absoluteInFolder('main.js'), 'utf8')).toBe('b');
    const extension = project.getEventsFunctionsExtension(
      BYOK_GAME_CODE_CARRIER_EXTENSION_NAME
    );
    expect(extension.getAllSourceFiles().size()).toBe(1);
  });

  it('normalizes backslash paths into folder groupings', async () => {
    const result = await getTool('write_game_code_file').run(
      { path: 'character\\spawn.js', content: 'x' },
      collaborators
    );
    expect(result.output.success).toBe(true);
    expect(nodeFs.existsSync(absoluteInFolder('character/spawn.js'))).toBe(
      true
    );
    expect(result.output.namespace).toBe('GameCode.character.spawn');
  });

  it('refuses every escape and invalid shape, leaving no file behind', async () => {
    const refusedCalls = [
      { path: '../outside.js', content: 'x' },
      { path: '../../outside.js', content: 'x' },
      { path: '/etc/passwd.js', content: 'x' },
      { path: 'C:/Windows/system32.js', content: 'x' },
      { path: 'main.txt', content: 'x' },
      { path: 'a' + String.fromCharCode(0) + '.js', content: 'x' },
      { path: '', content: 'x' },
      { path: 'main.js' }, // no content at all
    ];
    for (const call of refusedCalls) {
      const result = await getTool('write_game_code_file').run(
        call,
        collaborators
      );
      expect([call.path, result.output.success]).toEqual([call.path, false]);
      expect(result.didModifyProject).toBe(false);
    }
    // Nothing was written anywhere: the folder itself was never created.
    expect(nodeFs.existsSync(gameCodeFolderPath())).toBe(false);
  });

  it('refuses a file over the size cap, leaving no file behind', async () => {
    const tooBig = 'a'.repeat(BYOK_GAME_CODE_MAX_FILE_BYTES + 1);
    const result = await getTool('write_game_code_file').run(
      { path: 'main.js', content: tooBig },
      collaborators
    );
    expect(result.output.success).toBe(false);
    expect(result.output.message).toContain('capped at');
    expect(result.didModifyProject).toBe(false);
    expect(nodeFs.existsSync(absoluteInFolder('main.js'))).toBe(false);
  });

  it('answers with a refusal when no project is open', async () => {
    const result = await getTool('write_game_code_file').run(
      { path: 'main.js', content: 'x' },
      makeCollaborators(null)
    );
    expect(result.output.success).toBe(false);
    expect(result.didModifyProject).toBe(false);
  });
});

describe('delete_game_code_file', () => {
  it('deletes the file and drops the carrier entries', async () => {
    await getTool('write_game_code_file').run(
      { path: 'main.js', content: 'a' },
      collaborators
    );
    const resourceName = getByokGameCodeResourceName('main.js', FOLDER_NAME);
    expect(project.getResourcesManager().hasResource(resourceName)).toBe(true);

    const result = await getTool('delete_game_code_file').run(
      { path: 'main.js' },
      collaborators
    );
    expect(result.output.success).toBe(true);
    expect(result.didModifyProject).toBe(true);
    expect(nodeFs.existsSync(absoluteInFolder('main.js'))).toBe(false);
    expect(project.getResourcesManager().hasResource(resourceName)).toBe(false);
    const extension = project.getEventsFunctionsExtension(
      BYOK_GAME_CODE_CARRIER_EXTENSION_NAME
    );
    expect(extension.getAllSourceFiles().size()).toBe(0);
    // D15-13: a deletion needs a reload of a running preview.
    expect(result.output.message).toContain('reload');
  });

  it('keeps the other files declared when one of two is deleted', async () => {
    await getTool('write_game_code_file').run(
      { path: 'main.js', content: 'a' },
      collaborators
    );
    await getTool('write_game_code_file').run(
      { path: 'enemy/spawn.js', content: 'b' },
      collaborators
    );
    await getTool('delete_game_code_file').run(
      { path: 'main.js' },
      collaborators
    );
    const extension = project.getEventsFunctionsExtension(
      BYOK_GAME_CODE_CARRIER_EXTENSION_NAME
    );
    expect(extension.getAllSourceFiles().size()).toBe(1);
    expect(
      project
        .getResourcesManager()
        .hasResource(getByokGameCodeResourceName('enemy/spawn.js', FOLDER_NAME))
    ).toBe(true);
  });

  it('refuses an escaping path without touching anything', async () => {
    const result = await getTool('delete_game_code_file').run(
      { path: '../secret.js' },
      collaborators
    );
    expect(result.output.success).toBe(false);
    expect(result.didModifyProject).toBe(false);
    expect(nodeFs.existsSync(nodePath.join(temporaryFolder, 'secret.js'))).toBe(
      false
    );
  });

  it('answers with a failure for a missing file', async () => {
    const result = await getTool('delete_game_code_file').run(
      { path: 'ghost.js' },
      collaborators
    );
    expect(result.output.success).toBe(false);
    expect(result.didModifyProject).toBe(false);
  });
});

describe('reload_game_code', () => {
  it('degrades honestly when the reload routing is absent', async () => {
    const result = await getTool('reload_game_code', {
      reloadGameCode: null,
    }).run({}, collaborators);
    expect(result.output.success).toBe(false);
    expect(result.output.message).toBe(
      'Reloading the game code is not available yet.'
    );
    expect(result.didModifyProject).toBe(false);
  });

  it('routes to the real Phase 15.4 reload by default (no preview: its refusal)', async () => {
    // The default deps call the real reloadByokGameCode: with a project but
    // no preview session, its own actionable refusal must come back.
    const result = await getTool('reload_game_code').run({}, collaborators);
    expect(result.output.success).toBe(false);
    expect(result.output.message).toContain('No preview is running');
    expect(result.didModifyProject).toBe(false);
  });

  it('routes to the injected reload and passes its answer through', async () => {
    const reloadGameCode = ((jest.fn(): any): any);
    reloadGameCode.mockResolvedValue({
      success: true,
      message: 'Reloaded 2 file(s).',
    });
    const result = await getTool('reload_game_code', { reloadGameCode }).run(
      {},
      collaborators
    );
    expect(reloadGameCode).toHaveBeenCalledWith({ project });
    expect(result.output.success).toBe(true);
    expect(result.output.message).toBe('Reloaded 2 file(s).');
  });

  it('passes a refused reload through as a failure', async () => {
    const reloadGameCode = ((jest.fn(): any): any);
    reloadGameCode.mockResolvedValue({
      success: false,
      message: 'No preview is running.',
    });
    const result = await getTool('reload_game_code', { reloadGameCode }).run(
      {},
      collaborators
    );
    expect(result.output.success).toBe(false);
    expect(result.output.message).toBe('No preview is running.');
  });

  it('answers without throwing when the reload throws', async () => {
    const reloadGameCode = ((jest.fn(): any): any);
    reloadGameCode.mockRejectedValue(new Error('debugger gone'));
    const result = await getTool('reload_game_code', { reloadGameCode }).run(
      {},
      collaborators
    );
    expect(result.output.success).toBe(false);
    expect(result.output.message).toContain('debugger gone');
  });
});

describe('every tool answers without throwing', () => {
  it('when no project is open', async () => {
    const noProjectCollaborators = makeCollaborators(null);
    for (const name of GAME_CODE_TOOL_NAMES) {
      const result = await getTool(name).run({}, noProjectCollaborators);
      expect([name, result.output.success]).toEqual([name, false]);
      expect(result.didModifyProject).toBe(false);
    }
  });

  it('when the environment is not desktop', async () => {
    const overrides = nonDesktopDeps();
    for (const name of GAME_CODE_TOOL_NAMES) {
      const result = await getTool(name, overrides).run({}, collaborators);
      expect([name, result.output.success]).toEqual([name, false]);
      expect(result.didModifyProject).toBe(false);
    }
    // The store-backed tools surface the desktop-only explanation.
    for (const name of [
      'list_game_code_files',
      'read_game_code_file',
      'write_game_code_file',
      'delete_game_code_file',
    ]) {
      const result = await getTool(name, nonDesktopDeps()).run(
        { path: 'main.js', content: 'x' },
        collaborators
      );
      expect(result.output.message).toMatch(/desktop app/);
    }
  });
});
