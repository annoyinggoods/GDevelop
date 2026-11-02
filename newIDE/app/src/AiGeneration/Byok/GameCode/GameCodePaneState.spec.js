// @flow
import * as React from 'react';
import { act } from 'react-dom/test-utils';
import reactTestRenderer from 'react-test-renderer';

import {
  makeStarterGameCodeContent,
  useByokGameCodePaneState,
} from './GameCodePaneState';

const makeFakeStore = (
  initialFiles: { [relativePath: string]: string } = {}
) => {
  const contents: Map<string, string> = new Map(Object.entries(initialFiles));
  const listFiles = jest.fn(async () => ({
    ok: true,
    data: Array.from(contents.keys()).map(relativePath => ({
      relativePath,
      sizeBytes: (contents.get(relativePath) || '': string).length,
    })),
  }));
  const readFile = jest.fn(
    async (projectFile: string, folderName: string, relativePath: string) => {
      if (!contents.has(relativePath)) {
        return { ok: false, error: `"${relativePath}" does not exist.` };
      }
      return { ok: true, data: contents.get(relativePath) };
    }
  );
  const writeFile = jest.fn(
    async (
      projectFile: string,
      folderName: string,
      relativePath: string,
      content: string
    ) => {
      contents.set(relativePath, content);
      return { ok: true, data: { relativePath, created: true } };
    }
  );
  const deleteFile = jest.fn(
    async (projectFile: string, folderName: string, relativePath: string) => {
      if (!contents.has(relativePath)) {
        return { ok: false, error: `"${relativePath}" does not exist.` };
      }
      contents.delete(relativePath);
      return { ok: true, data: { relativePath, deleted: true } };
    }
  );
  const renameFile = jest.fn(
    async (
      projectFile: string,
      folderName: string,
      fromRelativePath: string,
      toRelativePath: string
    ) => {
      if (!contents.has(fromRelativePath)) {
        return { ok: false, error: `"${fromRelativePath}" does not exist.` };
      }
      const movedContent = contents.get(fromRelativePath);
      if (typeof movedContent !== 'string') {
        return { ok: false, error: `"${fromRelativePath}" does not exist.` };
      }
      contents.set(toRelativePath, movedContent);
      contents.delete(fromRelativePath);
      return { ok: true, data: { relativePath: toRelativePath } };
    }
  );
  return {
    store: { listFiles, readFile, writeFile, deleteFile, renameFile },
    contents,
  };
};

const makeProject = () => ({
  getName: () => 'MyGame',
  getProjectFile: () => 'C:/projects/mygame.json',
});

const NO_PREVIEW_MESSAGE =
  'No preview is running — launch one first (start_preview), then reload the game code.';

describe('useByokGameCodePaneState', () => {
  const renderPaneState = (deps: any) => {
    let latestState: any = null;
    const Harness = ({ harnessDeps }: {| harnessDeps: any |}) => {
      latestState = useByokGameCodePaneState(harnessDeps);
      return null;
    };
    let renderer: any = null;
    act(() => {
      renderer = reactTestRenderer.create(<Harness harnessDeps={deps} />);
    });
    const update = (nextDeps: any) => {
      act(() => {
        renderer.update(<Harness harnessDeps={nextDeps} />);
      });
    };
    return {
      getState: () => latestState,
      update,
      unmount: () => renderer.unmount(),
    };
  };

  it('lists the game-code files when the project opens', async () => {
    const { store } = makeFakeStore({ 'main.js': 'const main = 1;' });
    const handle = renderPaneState({
      project: makeProject(),
      store,
      ensureCarrier: jest.fn(() => {}),
      reloadGameCode: jest.fn(async () => ({
        success: false,
        message: NO_PREVIEW_MESSAGE,
      })),
    });
    await act(async () => {});
    const state = handle.getState();
    expect(state.gameCodeFolderName).toBe('MyGameCode');
    expect(state.files.map(file => file.relativePath)).toEqual(['main.js']);
    handle.unmount();
  });

  it('opens a file and reads its content', async () => {
    const { store } = makeFakeStore({
      'character/spawn.js': 'const spawn = 1;',
    });
    const handle = renderPaneState({
      project: makeProject(),
      store,
      ensureCarrier: jest.fn(() => {}),
    });
    await act(async () => {});
    await act(async () => {
      handle.getState().openFile('character/spawn.js');
    });
    await act(async () => {});
    expect(handle.getState().selectedRelativePath).toBe('character/spawn.js');
    expect(handle.getState().contentOnDisk).toBe('const spawn = 1;');
    handle.unmount();
  });

  it('saves through the store, then syncs the carrier and reloads', async () => {
    const { store } = makeFakeStore({ 'main.js': 'const main = 1;' });
    const ensureCarrier = jest.fn(() => {});
    const reloadGameCode = jest.fn(async () => ({
      success: true,
      message: 'ok',
    }));
    const handle = renderPaneState({
      project: makeProject(),
      store,
      ensureCarrier,
      reloadGameCode,
    });
    await act(async () => {});
    const saveResult = await act(async () =>
      handle.getState().saveFile('main.js', 'const main = 2;')
    );
    expect(saveResult).toEqual({ ok: true });
    expect(store.writeFile).toHaveBeenCalledWith(
      'C:/projects/mygame.json',
      'MyGameCode',
      'main.js',
      'const main = 2;'
    );
    // The carrier runs with the FRESH listing, not the stale one.
    expect(ensureCarrier).toHaveBeenCalledWith({
      project: expect.anything(),
      gameCodeFolderName: 'MyGameCode',
      relativePaths: ['main.js'],
    });
    expect(reloadGameCode).toHaveBeenCalledWith({
      project: expect.anything(),
      hardReload: false,
    });
    handle.unmount();
  });

  it('deletes through the store, then syncs the carrier and HARD reloads (D15-13)', async () => {
    const { store } = makeFakeStore({ 'main.js': 'const main = 1;' });
    const ensureCarrier = jest.fn(() => {});
    const reloadGameCode = jest.fn(async () => ({
      success: true,
      message: 'ok',
    }));
    const handle = renderPaneState({
      project: makeProject(),
      store,
      ensureCarrier,
      reloadGameCode,
    });
    await act(async () => {});
    await act(async () => {
      handle.getState().openFile('main.js');
    });
    await act(async () => {
      handle.getState().deleteFile('main.js');
    });
    expect(store.deleteFile).toHaveBeenCalledWith(
      'C:/projects/mygame.json',
      'MyGameCode',
      'main.js'
    );
    expect(ensureCarrier).toHaveBeenCalled();
    expect(reloadGameCode).toHaveBeenCalledWith({
      project: expect.anything(),
      hardReload: true,
    });
    // The deleted file was selected: the selection is closed.
    expect(handle.getState().selectedRelativePath).toBe(null);
    handle.unmount();
  });

  it('renames through the store AND the carrier, and hard reloads', async () => {
    const { store } = makeFakeStore({ 'main.js': 'const main = 1;' });
    const ensureCarrier = jest.fn(() => {});
    const reloadGameCode = jest.fn(async () => ({
      success: true,
      message: 'ok',
    }));
    const handle = renderPaneState({
      project: makeProject(),
      store,
      ensureCarrier,
      reloadGameCode,
    });
    await act(async () => {});
    await act(async () => {
      handle.getState().openFile('main.js');
    });
    await act(async () => {
      handle.getState().renameFile('main.js', 'boot.js');
    });
    expect(store.renameFile).toHaveBeenCalledWith(
      'C:/projects/mygame.json',
      'MyGameCode',
      'main.js',
      'boot.js'
    );
    expect(ensureCarrier).toHaveBeenCalled();
    expect(reloadGameCode).toHaveBeenCalledWith({
      project: expect.anything(),
      hardReload: true,
    });
    // The renamed file was selected: the selection follows the new name.
    expect(handle.getState().selectedRelativePath).toBe('boot.js');
    handle.unmount();
  });

  it('refuses an escaping rename BEFORE the store is called (A15-3)', async () => {
    const { store } = makeFakeStore({ 'main.js': 'const main = 1;' });
    const handle = renderPaneState({
      project: makeProject(),
      store,
      ensureCarrier: jest.fn(() => {}),
    });
    await act(async () => {});
    await act(async () => {
      handle.getState().renameFile('main.js', '../../evil.js');
    });
    expect(store.renameFile).not.toHaveBeenCalled();
    expect(handle.getState().statusMessage).toContain('escapes');
    handle.unmount();
  });

  it('creates a file with the starter content, syncs the carrier and selects it', async () => {
    const { store, contents } = makeFakeStore({});
    const ensureCarrier = jest.fn(() => {});
    const handle = renderPaneState({
      project: makeProject(),
      store,
      ensureCarrier,
    });
    await act(async () => {});
    await act(async () => {
      handle.getState().createFileInFolder('');
    });
    expect(store.writeFile).toHaveBeenCalledWith(
      'C:/projects/mygame.json',
      'MyGameCode',
      'untitled.js',
      makeStarterGameCodeContent('untitled.js')
    );
    expect(ensureCarrier).toHaveBeenCalled();
    expect(handle.getState().selectedRelativePath).toBe('untitled.js');
    expect(contents.get('untitled.js')).toContain(
      'GameCode = window.GameCode || {};'
    );
    handle.unmount();
  });

  it('tracks dirty files for the tree markers', async () => {
    const { store } = makeFakeStore({});
    const handle = renderPaneState({
      project: makeProject(),
      store,
      ensureCarrier: jest.fn(() => {}),
    });
    await act(async () => {});
    act(() => {
      handle.getState().setFileDirtyState('main.js', true);
    });
    expect(handle.getState().dirtyRelativePaths).toEqual(['main.js']);
    act(() => {
      handle.getState().setFileDirtyState('main.js', false);
    });
    expect(handle.getState().dirtyRelativePaths).toEqual([]);
    handle.unmount();
  });

  describe('auto-reload (D15-6)', () => {
    type WatcherCapture = {|
      callback: (event: {|
        fileIdentifier: string,
        event: string,
      |}) => void,
    |};
    const makeWatcher = (): {|
      setupWatcher: any,
      capture: WatcherCapture,
    |} => {
      const capture: WatcherCapture = {
        callback: (event: {| fileIdentifier: string, event: string |}) => {},
      };
      const setupWatcher = jest.fn((options: any) => {
        capture.callback = options.callback;
        return () => {};
      });
      return { setupWatcher, capture };
    };

    it('reloads and refreshes when a game-code file changes', async () => {
      const { store, contents } = makeFakeStore({ 'main.js': 'v1' });
      const { setupWatcher, capture } = makeWatcher();
      const reloadGameCode = jest.fn(async () => ({
        success: true,
        message: 'ok',
      }));
      const handle = renderPaneState({
        project: makeProject(),
        store,
        ensureCarrier: jest.fn(() => {}),
        reloadGameCode,
        setupWatcher,
        debounceDelayMs: 0,
      });
      await act(async () => {});
      contents.set('main.js', 'v2');
      await act(async () => {
        capture.callback({
          fileIdentifier: 'MyGameCode/main.js',
          event: 'change',
        });
      });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      expect(reloadGameCode).toHaveBeenCalled();
      expect(handle.getState().files.map(file => file.relativePath)).toEqual([
        'main.js',
      ]);
      handle.unmount();
    });

    it('does not reload when the setting is off', async () => {
      const { store } = makeFakeStore({ 'main.js': 'v1' });
      const { setupWatcher, capture } = makeWatcher();
      const reloadGameCode = jest.fn(async () => ({
        success: true,
        message: 'ok',
      }));
      const handle = renderPaneState({
        project: makeProject(),
        store,
        ensureCarrier: jest.fn(() => {}),
        reloadGameCode,
        setupWatcher,
        debounceDelayMs: 0,
      });
      await act(async () => {});
      act(() => {
        handle.getState().setIsAutoReloadEnabled(false);
      });
      await act(async () => {
        capture.callback({
          fileIdentifier: 'MyGameCode/main.js',
          event: 'change',
        });
      });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      expect(reloadGameCode).not.toHaveBeenCalled();
      handle.unmount();
    });
  });

  it('does not surface the "no preview" reload outcome as an error', async () => {
    const { store } = makeFakeStore({ 'main.js': 'const main = 1;' });
    const reloadGameCode = jest.fn(async () => ({
      success: false,
      message: NO_PREVIEW_MESSAGE,
    }));
    const handle = renderPaneState({
      project: makeProject(),
      store,
      ensureCarrier: jest.fn(() => {}),
      reloadGameCode,
    });
    await act(async () => {});
    await act(async () => {
      handle.getState().saveFile('main.js', 'const main = 2;');
    });
    expect(handle.getState().statusMessage).toBe(null);
    handle.unmount();
  });
});
