// @flow

/**
 * The Phase 15.1 byte-moving layer, exercised against a REAL temporary
 * directory — the confinement (A15-3) and the round-trip fidelity are
 * filesystem claims, and a mock `fs` would assert the mock rather than the
 * behaviour.
 */

import {
  getByokGameCodeFolderPath,
  isByokGameCodePathInsideFolder,
  makeByokGameCodeStore,
  resolveByokGameCodeAbsolutePath,
} from './ByokGameCodeStore';
import { BYOK_GAME_CODE_MAX_FILE_BYTES } from './ByokGameCodeCore';

// $FlowFixMe[cannot-resolve-module] - a Node builtin, used by this spec only.
const os = require('os');
// $FlowFixMe[cannot-resolve-module] - a Node builtin, used by this spec only.
const nodeFs = require('fs');
// $FlowFixMe[cannot-resolve-module] - a Node builtin, used by this spec only.
const nodePath = require('path');

const FOLDER_NAME = 'MyGameCode';

let temporaryFolder: string;
let projectFile: string;

beforeEach(() => {
  temporaryFolder = nodeFs.mkdtempSync(
    nodePath.join(os.tmpdir(), 'byok-game-code-store-')
  );
  projectFile = nodePath.join(temporaryFolder, 'MyGame.json');
  nodeFs.writeFileSync(projectFile, '{}', 'utf8');
});

afterEach(() => {
  // rmSync recurses; the recursive flag keeps older Node builds happy.
  nodeFs.rmSync(temporaryFolder, { recursive: true, force: true });
});

const makeStore = () =>
  makeByokGameCodeStore({
    fs: nodeFs,
    pathLib: nodePath,
    ipcRenderer: null,
  });

const absoluteInFolder = (relativePath: string): string =>
  nodePath.join(temporaryFolder, FOLDER_NAME, ...relativePath.split('/'));

describe('isByokGameCodePathInsideFolder', () => {
  it('accepts a folder and its descendants', () => {
    expect(isByokGameCodePathInsideFolder(nodePath, '/p/game', '/p/game')).toBe(
      true
    );
    expect(
      isByokGameCodePathInsideFolder(nodePath, '/p/game', '/p/game/a/b.js')
    ).toBe(true);
  });

  it('is segment-aware: a sibling folder with a longer name is outside', () => {
    expect(
      isByokGameCodePathInsideFolder(nodePath, '/p/game', '/p/game2/x.js')
    ).toBe(false);
    expect(isByokGameCodePathInsideFolder(nodePath, '/p/game', '/p/x.js')).toBe(
      false
    );
  });
});

describe('resolveByokGameCodeAbsolutePath', () => {
  it('resolves a nested path inside the game code folder', () => {
    const result = resolveByokGameCodeAbsolutePath(
      nodePath,
      projectFile,
      FOLDER_NAME,
      'character/spawn.js'
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.data).toBe(absoluteInFolder('character/spawn.js'));
  });

  it('refuses every escape from the folder', () => {
    for (const escape of [
      '../outside.js',
      '../../outside.js',
      'character/../../outside.js',
      '/etc/passwd.js',
      'C:/Windows/system32.js',
      '..\\outside.js',
    ]) {
      const result = resolveByokGameCodeAbsolutePath(
        nodePath,
        projectFile,
        FOLDER_NAME,
        escape
      );
      expect([escape, result.ok]).toEqual([escape, false]);
    }
  });

  it('places the folder next to the project file, not inside it', () => {
    expect(getByokGameCodeFolderPath(nodePath, projectFile, FOLDER_NAME)).toBe(
      nodePath.join(temporaryFolder, FOLDER_NAME)
    );
  });
});

describe('the fs transport', () => {
  it('round-trips LF content byte for byte', async () => {
    const store = makeStore();
    const content = 'GameCode = window.GameCode || {};\nGameCode.a = 1;\n';
    const written = await store.writeFile(
      projectFile,
      FOLDER_NAME,
      'main.js',
      content
    );
    expect(written.ok).toBe(true);
    const read = await store.readFile(projectFile, FOLDER_NAME, 'main.js');
    expect(read).toEqual({ ok: true, data: content });
  });

  it('round-trips CRLF content byte for byte', async () => {
    // A Windows editor must not see its CRLFs rewritten: the file on disk
    // is the source of truth, and a silent newline rewrite would show up as
    // a phantom change in the watcher (and therefore a spurious reload).
    const store = makeStore();
    const content = 'GameCode = window.GameCode || {};\r\nGameCode.a = 1;\r\n';
    await store.writeFile(projectFile, FOLDER_NAME, 'main.js', content);
    const read = await store.readFile(projectFile, FOLDER_NAME, 'main.js');
    expect(read).toEqual({ ok: true, data: content });
  });

  it('round-trips non-ASCII content unchanged', async () => {
    const store = makeStore();
    const content = '// Grüße — 日本語 — 😀\nGameCode.emoji = "🎮";\n';
    await store.writeFile(projectFile, FOLDER_NAME, 'core/boot.js', content);
    const read = await store.readFile(projectFile, FOLDER_NAME, 'core/boot.js');
    expect(read).toEqual({ ok: true, data: content });
  });

  it('creates the grouping folders it needs', async () => {
    const store = makeStore();
    await store.writeFile(
      projectFile,
      FOLDER_NAME,
      'character/hero/attack.js',
      'x'
    );
    expect(
      nodeFs.existsSync(absoluteInFolder('character/hero/attack.js'))
    ).toBe(true);
  });

  it('lists files in D15-3a order and ignores the manifest', async () => {
    const store = makeStore();
    nodeFs.mkdirSync(nodePath.join(temporaryFolder, FOLDER_NAME, 'enemy'), {
      recursive: true,
    });
    nodeFs.mkdirSync(nodePath.join(temporaryFolder, FOLDER_NAME, 'core'), {
      recursive: true,
    });
    nodeFs.writeFileSync(absoluteInFolder('enemy/spawn.js'), 'a');
    nodeFs.writeFileSync(absoluteInFolder('main.js'), 'a');
    nodeFs.writeFileSync(absoluteInFolder('core/boot.js'), 'a');
    nodeFs.writeFileSync(absoluteInFolder('gamecode.json'), '{}');
    nodeFs.writeFileSync(absoluteInFolder('notes.txt'), 'a');

    const listed = await store.listFiles(projectFile, FOLDER_NAME);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.data.map(file => file.relativePath)).toEqual([
        'core/boot.js',
        'main.js',
        'enemy/spawn.js',
      ]);
    }
  });

  it('lists an absent folder as empty rather than failing', async () => {
    const listed = await makeStore().listFiles(projectFile, FOLDER_NAME);
    expect(listed).toEqual({ ok: true, data: [] });
  });

  it('reports the real size of each file', async () => {
    const store = makeStore();
    await store.writeFile(projectFile, FOLDER_NAME, 'main.js', 'abcde');
    const listed = await store.listFiles(projectFile, FOLDER_NAME);
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.data[0].sizeBytes).toBe(5);
  });

  it('says whether a write created or overwrote a file', async () => {
    const store = makeStore();
    const first = await store.writeFile(
      projectFile,
      FOLDER_NAME,
      'main.js',
      'a'
    );
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.data.created).toBe(true);
    const second = await store.writeFile(
      projectFile,
      FOLDER_NAME,
      'main.js',
      'b'
    );
    if (second.ok) expect(second.data.created).toBe(false);
  });

  it('leaves no temp file behind after a write', async () => {
    const store = makeStore();
    await store.writeFile(projectFile, FOLDER_NAME, 'main.js', 'a');
    const entries = nodeFs.readdirSync(
      nodePath.join(temporaryFolder, FOLDER_NAME)
    );
    expect(entries).toEqual(['main.js']);
  });

  it('refuses a file over the size cap', async () => {
    const store = makeStore();
    const tooBig = 'a'.repeat(BYOK_GAME_CODE_MAX_FILE_BYTES + 1);
    const result = await store.writeFile(
      projectFile,
      FOLDER_NAME,
      'main.js',
      tooBig
    );
    expect(result.ok).toBe(false);
    expect(nodeFs.existsSync(absoluteInFolder('main.js'))).toBe(false);
  });

  it('refuses to read, write, delete or rename outside the folder', async () => {
    const store = makeStore();
    const secret = nodePath.join(temporaryFolder, 'secret.js');
    nodeFs.writeFileSync(secret, 'top secret', 'utf8');

    expect(
      await store.readFile(projectFile, FOLDER_NAME, '../secret.js')
    ).toMatchObject({ ok: false });
    expect(
      await store.writeFile(projectFile, FOLDER_NAME, '../secret.js', 'x')
    ).toMatchObject({ ok: false });
    expect(
      await store.deleteFile(projectFile, FOLDER_NAME, '../secret.js')
    ).toMatchObject({ ok: false });
    expect(
      await store.renameFile(
        projectFile,
        FOLDER_NAME,
        '../secret.js',
        'main.js'
      )
    ).toMatchObject({ ok: false });

    // And the file outside the folder is untouched.
    expect(nodeFs.readFileSync(secret, 'utf8')).toBe('top secret');
  });

  it('refuses to rename a file OUT of the folder', async () => {
    const store = makeStore();
    await store.writeFile(projectFile, FOLDER_NAME, 'main.js', 'a');
    const result = await store.renameFile(
      projectFile,
      FOLDER_NAME,
      'main.js',
      '../escaped.js'
    );
    expect(result.ok).toBe(false);
    expect(
      nodeFs.existsSync(nodePath.join(temporaryFolder, 'escaped.js'))
    ).toBe(false);
    expect(nodeFs.existsSync(absoluteInFolder('main.js'))).toBe(true);
  });

  it('renames inside the folder, moving groups included', async () => {
    const store = makeStore();
    await store.writeFile(projectFile, FOLDER_NAME, 'main.js', 'a');
    const renamed = await store.renameFile(
      projectFile,
      FOLDER_NAME,
      'main.js',
      'core/boot.js'
    );
    expect(renamed).toEqual({
      ok: true,
      data: { relativePath: 'core/boot.js' },
    });
    expect(nodeFs.readFileSync(absoluteInFolder('core/boot.js'), 'utf8')).toBe(
      'a'
    );
    expect(nodeFs.existsSync(absoluteInFolder('main.js'))).toBe(false);
  });

  it('answers, never throws, when a file is missing', async () => {
    const store = makeStore();
    expect(
      await store.readFile(projectFile, FOLDER_NAME, 'ghost.js')
    ).toMatchObject({ ok: false });
    expect(
      await store.deleteFile(projectFile, FOLDER_NAME, 'ghost.js')
    ).toMatchObject({ ok: false });
    expect(
      await store.renameFile(projectFile, FOLDER_NAME, 'ghost.js', 'other.js')
    ).toMatchObject({ ok: false });
  });

  it('answers, never throws, when a write fails', async () => {
    const store = makeStore();
    // A directory where a file should go makes writeFileSync throw.
    nodeFs.mkdirSync(absoluteInFolder('main.js'), { recursive: true });
    expect(
      await store.writeFile(projectFile, FOLDER_NAME, 'main.js', 'a')
    ).toMatchObject({ ok: false });
  });
});

describe('the IPC transport', () => {
  const makeIpcStore = (handler: (channel: string, args: Array<any>) => any) =>
    makeByokGameCodeStore({
      fs: null,
      pathLib: null,
      ipcRenderer: {
        invoke: (channel: string, ...args: Array<any>) =>
          handler(channel, args),
      },
    });

  it('lists through the byok-game-code-list channel', async () => {
    const seen = [];
    const store = makeIpcStore((channel, args) => {
      seen.push(channel);
      return {
        ok: true,
        data: [{ relativePath: 'main.js', sizeBytes: 3 }],
      };
    });
    const listed = await store.listFiles(projectFile, FOLDER_NAME);
    expect(seen).toEqual(['byok-game-code-list']);
    expect(listed).toEqual({
      ok: true,
      data: [{ relativePath: 'main.js', sizeBytes: 3 }],
    });
  });

  it('refuses an escaping path BEFORE it reaches the main process', async () => {
    // The main process derives the folder from the project file, but the
    // renderer must not be the one relying on that.
    let called = false;
    const store = makeIpcStore(() => {
      called = true;
      return { ok: true, data: null };
    });
    expect(
      await store.readFile(projectFile, FOLDER_NAME, '../secret.js')
    ).toMatchObject({ ok: false });
    expect(called).toBe(false);
  });

  it('normalizes the path it sends over IPC', async () => {
    const seen = [];
    const store = makeIpcStore((channel, args) => {
      seen.push(args);
      return { ok: true, data: 'content' };
    });
    await store.readFile(projectFile, FOLDER_NAME, 'character\\spawn.js');
    expect(seen[0][2]).toBe('character/spawn.js');
  });

  it('folds a rejected channel into the same failure shape', async () => {
    const store = makeIpcStore(() => {
      throw new Error('channel exploded');
    });
    expect(await store.listFiles(projectFile, FOLDER_NAME)).toEqual({
      ok: false,
      error: 'channel exploded',
    });
  });

  it('folds a malformed channel answer into a failure', async () => {
    const store = makeIpcStore(() => 'not a result');
    expect(await store.listFiles(projectFile, FOLDER_NAME)).toMatchObject({
      ok: false,
    });
  });

  it('cleans and re-orders a listing that arrives malformed', async () => {
    const store = makeIpcStore(() => ({
      ok: true,
      data: [
        { relativePath: 'enemy/spawn.js', sizeBytes: 1 },
        { relativePath: 'main.js', sizeBytes: 'huge' },
        { relativePath: 'gamecode.json', sizeBytes: 1 },
        null,
        'nonsense',
      ],
    }));
    const listed = await store.listFiles(projectFile, FOLDER_NAME);
    expect(listed).toEqual({
      ok: true,
      data: [
        { relativePath: 'main.js', sizeBytes: 0 },
        { relativePath: 'enemy/spawn.js', sizeBytes: 1 },
      ],
    });
  });

  it('routes every verb to its own channel', async () => {
    const seen = [];
    const store = makeIpcStore((channel, args) => {
      seen.push(channel);
      return { ok: true, data: channel.endsWith('read') ? 'x' : null };
    });
    await store.listFiles(projectFile, FOLDER_NAME);
    await store.readFile(projectFile, FOLDER_NAME, 'main.js');
    await store.writeFile(projectFile, FOLDER_NAME, 'main.js', 'x');
    await store.deleteFile(projectFile, FOLDER_NAME, 'main.js');
    await store.renameFile(projectFile, FOLDER_NAME, 'a.js', 'b.js');
    expect(seen).toEqual([
      'byok-game-code-list',
      'byok-game-code-read',
      'byok-game-code-write',
      'byok-game-code-delete',
      'byok-game-code-rename',
    ]);
  });
});

describe('no transport at all', () => {
  it('answers with an actionable refusal in the browser build', async () => {
    const store = makeByokGameCodeStore({
      fs: null,
      pathLib: null,
      ipcRenderer: null,
    });
    for (const result of [
      await store.listFiles(projectFile, FOLDER_NAME),
      await store.readFile(projectFile, FOLDER_NAME, 'main.js'),
      await store.writeFile(projectFile, FOLDER_NAME, 'main.js', 'x'),
      await store.deleteFile(projectFile, FOLDER_NAME, 'main.js'),
      await store.renameFile(projectFile, FOLDER_NAME, 'a.js', 'b.js'),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/desktop app/);
    }
  });
});
