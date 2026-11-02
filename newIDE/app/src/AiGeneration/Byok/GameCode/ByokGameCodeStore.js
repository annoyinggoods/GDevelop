// @flow

/**
 * Phase 15.1 — the byte-moving layer of the game-code folder.
 *
 * D15-1 makes the file on disk the single source of truth, so this is the
 * only module that reads or writes one. It is deliberately thin: it moves
 * bytes and nothing else — the rules live in ByokGameCodeCore, and the
 * project-model side (the resources and the carrier extension) lives in
 * ByokGameCodeCarrier.
 *
 * Two transports, one behaviour:
 *
 * - The renderer reads and writes the files directly when `fs` is
 *   available (the `optionalRequire` desktop-only pattern of
 *   ByokResourceTools.js).
 * - Otherwise — and in the Electron main process, which has no test runner
 *   — the same operations go over the flat `byok-game-code-<verb>` IPC
 *   channels of `electron-app/app/ByokGameCode.js`. The main process
 *   derives the game-code folder ITSELF from the project file, so a
 *   compromised renderer cannot widen the confinement by naming a folder.
 *
 * Every operation returns a result object and never throws, and every one
 * of them resolves its path through `resolveByokGameCodeAbsolutePath` —
 * the gate that makes A15-3 hold for the tools, the tree and the agent
 * alike.
 */

import optionalRequire from '../../../Utils/OptionalRequire';
import {
  BYOK_GAME_CODE_MANIFEST_FILE_NAME,
  BYOK_GAME_CODE_MAX_FILE_BYTES,
  getByokGameCodeFolderName,
  normalizeByokGameCodeRelativePath,
  orderByokGameCodeRelativePaths,
} from './ByokGameCodeCore';

const electron = optionalRequire('electron');
const defaultIpcRenderer = electron ? electron.ipcRenderer : null;
const defaultFs = optionalRequire('fs-extra');
const defaultPathLib = optionalRequire('path');

export type ByokGameCodeFileInfo = {|
  relativePath: string,
  sizeBytes: number,
|};

export type ByokGameCodeStoreResult<T> =
  | {| ok: true, data: T |}
  | {| ok: false, error: string |};

export type ByokGameCodeStoreDeps = {|
  fs: any,
  pathLib: any,
  ipcRenderer: any,
|};

export type ByokGameCodeStore = {|
  listFiles: (
    projectFile: string,
    gameCodeFolderName: string
  ) => Promise<ByokGameCodeStoreResult<Array<ByokGameCodeFileInfo>>>,
  readFile: (
    projectFile: string,
    gameCodeFolderName: string,
    relativePath: string
  ) => Promise<ByokGameCodeStoreResult<string>>,
  writeFile: (
    projectFile: string,
    gameCodeFolderName: string,
    relativePath: string,
    content: string
  ) => Promise<
    ByokGameCodeStoreResult<{| relativePath: string, created: boolean |}>
  >,
  deleteFile: (
    projectFile: string,
    gameCodeFolderName: string,
    relativePath: string
  ) => Promise<
    ByokGameCodeStoreResult<{| relativePath: string, deleted: boolean |}>
  >,
  renameFile: (
    projectFile: string,
    gameCodeFolderName: string,
    fromRelativePath: string,
    toRelativePath: string
  ) => Promise<ByokGameCodeStoreResult<{| relativePath: string |}>>,
|};

/** Segment-aware containment: "/projects/game2" is NOT inside "/projects/game". */
export const isByokGameCodePathInsideFolder = (
  pathLib: any,
  folder: string,
  candidate: string
): boolean => {
  const relative = pathLib.relative(folder, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !pathLib.isAbsolute(relative))
  );
};

/** The absolute game-code folder for a project file. */
export const getByokGameCodeFolderPath = (
  pathLib: any,
  projectFile: string,
  gameCodeFolderName: string
): string =>
  pathLib.join(
    pathLib.dirname(pathLib.resolve(projectFile)),
    gameCodeFolderName
  );

/**
 * Resolve a caller-supplied relative path to an absolute one INSIDE the
 * game-code folder, or refuse.
 *
 * The normalization happens first (it is what rejects `..`, absolute paths,
 * NUL bytes and reserved device names) and the containment check runs
 * anyway: two independent gates, because this is the boundary A15-3 is
 * written about.
 */
export const resolveByokGameCodeAbsolutePath = (
  pathLib: any,
  projectFile: string,
  gameCodeFolderName: string,
  relativePath: string
): ByokGameCodeStoreResult<string> => {
  const check = normalizeByokGameCodeRelativePath(relativePath);
  if (!check.ok) return { ok: false, error: check.error };
  const folderPath = getByokGameCodeFolderPath(
    pathLib,
    projectFile,
    gameCodeFolderName
  );
  const absolutePath = pathLib.resolve(folderPath, check.relativePath);
  if (!isByokGameCodePathInsideFolder(pathLib, folderPath, absolutePath)) {
    return {
      ok: false,
      error: `Refused: "${relativePath}" is outside the game code folder.`,
    };
  }
  return { ok: true, data: absolutePath };
};

/**
 * Walk the game-code folder and return its `.js` files in D15-3a load order.
 * A missing folder is an empty list, not an error: a project that has never
 * been given game code is the normal starting state.
 */
const listFilesWithFs = (
  deps: ByokGameCodeStoreDeps,
  projectFile: string,
  gameCodeFolderName: string
): ByokGameCodeStoreResult<Array<ByokGameCodeFileInfo>> => {
  const { fs, pathLib } = deps;
  const folderPath = getByokGameCodeFolderPath(
    pathLib,
    projectFile,
    gameCodeFolderName
  );
  if (!fs.existsSync(folderPath)) return { ok: true, data: [] };

  const found = [];
  const walk = (directory: string, prefix: string) => {
    const entries = fs.readdirSync(directory);
    for (const entry of entries) {
      const absoluteEntry = pathLib.join(directory, entry);
      const relativeEntry = prefix ? prefix + '/' + entry : entry;
      const stat = fs.statSync(absoluteEntry);
      if (stat.isDirectory()) {
        walk(absoluteEntry, relativeEntry);
        continue;
      }
      if (!/\.js$/i.test(entry)) continue;
      found.push({ relativePath: relativeEntry, sizeBytes: stat.size });
    }
  };
  walk(folderPath, '');

  const orderedPaths = orderByokGameCodeRelativePaths(
    found.map(file => file.relativePath)
  );
  const byPath = new Map(found.map(file => [file.relativePath, file]));
  return {
    ok: true,
    data: orderedPaths.map(relativePath => {
      const file = byPath.get(relativePath);
      // Every ordered path came from `found`, so the entry always exists;
      // the guard keeps Flow (and a future refactor) honest.
      return file || { relativePath, sizeBytes: 0 };
    }),
  };
};

/**
 * Write to a temp file in the same folder then rename over the target, so a
 * crash never leaves a truncated script where a working one was (the same
 * rule as ByokAtomicWriteCore.js, which the Electron main side uses — that
 * module is plain CJS and webpack-hostile, so the renderer keeps its own).
 */
const writeFileAtomicallyWithFs = (
  deps: ByokGameCodeStoreDeps,
  absolutePath: string,
  content: string
): void => {
  const { fs } = deps;
  const temporaryPath =
    absolutePath +
    '.tmp-' +
    Math.random()
      .toString(36)
      .slice(2, 10);
  try {
    fs.writeFileSync(temporaryPath, content, 'utf8');
    fs.renameSync(temporaryPath, absolutePath);
  } catch (error) {
    // Best-effort cleanup: a leftover temp file would show up in the tree.
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      // The temp file may never have been created.
    }
    throw error;
  }
};

/**
 * The UTF-8 length of a string, without assuming `Buffer` exists (the
 * renderer bundle has no Node global).
 */
const getUtf8ByteLength = (content: string): number =>
  encodeURIComponent(content).replace(/%[0-9A-F]{2}|./g, 'x').length;

const describeFsError = (error: mixed): string =>
  error instanceof Error ? error.message : String(error);

/** Defensive re-ordering of a listing that arrived over IPC. */
const orderAndCleanList = (rawFiles: any): Array<ByokGameCodeFileInfo> => {
  if (!Array.isArray(rawFiles)) return [];
  const files = rawFiles
    .filter(file => file && typeof file.relativePath === 'string')
    .map(file => ({
      relativePath: file.relativePath,
      sizeBytes: typeof file.sizeBytes === 'number' ? file.sizeBytes : 0,
    }))
    .filter(
      file =>
        file.relativePath !== BYOK_GAME_CODE_MANIFEST_FILE_NAME &&
        file.relativePath.endsWith('.js')
    );
  const byPath = new Map(files.map(file => [file.relativePath, file]));
  const orderedPaths = orderByokGameCodeRelativePaths(
    files.map(file => file.relativePath)
  );
  return orderedPaths.map(relativePath => {
    const file = byPath.get(relativePath);
    return file || { relativePath, sizeBytes: 0 };
  });
};

export const makeByokGameCodeStore = (
  overrides?: Partial<ByokGameCodeStoreDeps>
): ByokGameCodeStore => {
  const deps: ByokGameCodeStoreDeps = {
    fs: defaultFs,
    pathLib: defaultPathLib,
    ipcRenderer: defaultIpcRenderer,
    ...overrides,
  };
  const { fs, pathLib, ipcRenderer } = deps;
  const canUseFs = () => !!(fs && pathLib);
  const canUseIpc = () => !!ipcRenderer;

  // Every IPC failure answers `{ok: false, error}`; a thrown rejection is
  // folded into the same shape so the tools never have to try/catch.
  const invokeIpc = async (
    channel: string,
    args: Array<any>
  ): Promise<ByokGameCodeStoreResult<any>> => {
    try {
      const result = await ipcRenderer.invoke(channel, ...args);
      if (!result || typeof result.ok !== 'boolean') {
        return { ok: false, error: `The "${channel}" channel misbehaved.` };
      }
      return result;
    } catch (error) {
      return { ok: false, error: describeFsError(error) };
    }
  };

  const unavailable = <T>(): ByokGameCodeStoreResult<T> => ({
    ok: false,
    error:
      'Game code files are only available in the desktop app (they need the local filesystem).',
  });

  const listFiles = async (
    projectFile: string,
    gameCodeFolderName: string
  ): Promise<ByokGameCodeStoreResult<Array<ByokGameCodeFileInfo>>> => {
    if (canUseFs()) {
      try {
        return listFilesWithFs(deps, projectFile, gameCodeFolderName);
      } catch (error) {
        return { ok: false, error: describeFsError(error) };
      }
    }
    if (canUseIpc()) {
      const result = await invokeIpc('byok-game-code-list', [
        projectFile,
        gameCodeFolderName,
      ]);
      return result.ok
        ? { ok: true, data: orderAndCleanList(result.data) }
        : result;
    }
    return unavailable();
  };

  const readFile = async (
    projectFile: string,
    gameCodeFolderName: string,
    relativePath: string
  ): Promise<ByokGameCodeStoreResult<string>> => {
    if (canUseFs()) {
      const resolved = resolveByokGameCodeAbsolutePath(
        pathLib,
        projectFile,
        gameCodeFolderName,
        relativePath
      );
      if (!resolved.ok) return resolved;
      try {
        if (!fs.existsSync(resolved.data)) {
          return { ok: false, error: `"${relativePath}" does not exist.` };
        }
        return { ok: true, data: fs.readFileSync(resolved.data, 'utf8') };
      } catch (error) {
        return { ok: false, error: describeFsError(error) };
      }
    }
    if (canUseIpc()) {
      const check = normalizeByokGameCodeRelativePath(relativePath);
      if (!check.ok) return check;
      return invokeIpc('byok-game-code-read', [
        projectFile,
        gameCodeFolderName,
        check.relativePath,
      ]);
    }
    return unavailable();
  };

  const writeFile = async (
    projectFile: string,
    gameCodeFolderName: string,
    relativePath: string,
    content: string
  ): Promise<
    ByokGameCodeStoreResult<{| relativePath: string, created: boolean |}>
  > => {
    const sizeBytes = getUtf8ByteLength(content);
    if (sizeBytes > BYOK_GAME_CODE_MAX_FILE_BYTES) {
      return {
        ok: false,
        error: `The file is ${sizeBytes} bytes; a game code file is capped at ${BYOK_GAME_CODE_MAX_FILE_BYTES} bytes.`,
      };
    }
    if (canUseFs()) {
      const resolved = resolveByokGameCodeAbsolutePath(
        pathLib,
        projectFile,
        gameCodeFolderName,
        relativePath
      );
      if (!resolved.ok) return resolved;
      const check = normalizeByokGameCodeRelativePath(relativePath);
      if (!check.ok) return check;
      try {
        const existed = fs.existsSync(resolved.data);
        fs.mkdirSync(pathLib.dirname(resolved.data), { recursive: true });
        writeFileAtomicallyWithFs(deps, resolved.data, content);
        return {
          ok: true,
          data: { relativePath: check.relativePath, created: !existed },
        };
      } catch (error) {
        return { ok: false, error: describeFsError(error) };
      }
    }
    if (canUseIpc()) {
      const check = normalizeByokGameCodeRelativePath(relativePath);
      if (!check.ok) return check;
      return invokeIpc('byok-game-code-write', [
        projectFile,
        gameCodeFolderName,
        check.relativePath,
        content,
      ]);
    }
    return unavailable();
  };

  const deleteFile = async (
    projectFile: string,
    gameCodeFolderName: string,
    relativePath: string
  ): Promise<
    ByokGameCodeStoreResult<{| relativePath: string, deleted: boolean |}>
  > => {
    if (canUseFs()) {
      const resolved = resolveByokGameCodeAbsolutePath(
        pathLib,
        projectFile,
        gameCodeFolderName,
        relativePath
      );
      if (!resolved.ok) return resolved;
      try {
        if (!fs.existsSync(resolved.data)) {
          return { ok: false, error: `"${relativePath}" does not exist.` };
        }
        fs.unlinkSync(resolved.data);
        return { ok: true, data: { relativePath, deleted: true } };
      } catch (error) {
        return { ok: false, error: describeFsError(error) };
      }
    }
    if (canUseIpc()) {
      const check = normalizeByokGameCodeRelativePath(relativePath);
      if (!check.ok) return check;
      return invokeIpc('byok-game-code-delete', [
        projectFile,
        gameCodeFolderName,
        check.relativePath,
      ]);
    }
    return unavailable();
  };

  const renameFile = async (
    projectFile: string,
    gameCodeFolderName: string,
    fromRelativePath: string,
    toRelativePath: string
  ): Promise<ByokGameCodeStoreResult<{| relativePath: string |}>> => {
    if (canUseFs()) {
      const from = resolveByokGameCodeAbsolutePath(
        pathLib,
        projectFile,
        gameCodeFolderName,
        fromRelativePath
      );
      if (!from.ok) return from;
      const to = resolveByokGameCodeAbsolutePath(
        pathLib,
        projectFile,
        gameCodeFolderName,
        toRelativePath
      );
      if (!to.ok) return to;
      try {
        if (!fs.existsSync(from.data)) {
          return { ok: false, error: `"${fromRelativePath}" does not exist.` };
        }
        fs.mkdirSync(pathLib.dirname(to.data), { recursive: true });
        fs.renameSync(from.data, to.data);
        const toCheck = normalizeByokGameCodeRelativePath(toRelativePath);
        if (!toCheck.ok) return toCheck;
        return { ok: true, data: { relativePath: toCheck.relativePath } };
      } catch (error) {
        return { ok: false, error: describeFsError(error) };
      }
    }
    if (canUseIpc()) {
      const fromCheck = normalizeByokGameCodeRelativePath(fromRelativePath);
      if (!fromCheck.ok) return fromCheck;
      const toCheck = normalizeByokGameCodeRelativePath(toRelativePath);
      if (!toCheck.ok) return toCheck;
      return invokeIpc('byok-game-code-rename', [
        projectFile,
        gameCodeFolderName,
        fromCheck.relativePath,
        toCheck.relativePath,
      ]);
    }
    return unavailable();
  };

  return { listFiles, readFile, writeFile, deleteFile, renameFile };
};

/**
 * The store the tools and the pane share. It is a module singleton so the
 * two surfaces cannot drift onto two different fs/ipc bindings.
 */
let sharedStore: ?ByokGameCodeStore = null;

export const getByokGameCodeStore = (): ByokGameCodeStore => {
  if (!sharedStore) sharedStore = makeByokGameCodeStore();
  return sharedStore;
};

/** Test seam: forget the shared store (see ByokGameCodeStore.spec.js). */
export const resetByokGameCodeStoreForTests = (): void => {
  sharedStore = null;
};

/**
 * The game-code folder name for the open project — the one rule the tools,
 * the pane and the carrier all need before they can name a single file.
 */
export const getProjectGameCodeFolderName = (project: any): string =>
  getByokGameCodeFolderName(
    project && typeof project.getName === 'function' ? project.getName() : ''
  );
