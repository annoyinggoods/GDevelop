// @flow

/**
 * Phase 15.1 — the pure rules of the BYOK game-code folder.
 *
 * Nothing in this module touches a file, a project or a React tree: it is
 * the layer every other game-code module (the store, the carrier extension,
 * the tools, the pane, the hot reload) agrees on, so it is the layer the
 * specs pin. Four concerns live here:
 *
 * 1. WHERE the files live — `<project>/<GameName>Code/`, and the refusal
 *    of every path that tries to leave it (A15-3).
 * 2. IN WHICH ORDER they load — the D15-3a taxonomy (tier 1 = folder root
 *    plus `core/`, tier 2 = every other grouping, alphabetical inside).
 * 3. WHICH NAMESPACE they publish — D15-12: classic scripts (no ES modules,
 *    because an ES module can never be unloaded from a running page) that
 *    assign into a folder-derived global, `GameCode.character.spawn`.
 * 4. WHICH NAME each file takes in the exported game — the exporter copies
 *    every project resource FLAT into the export folder
 *    (`ResourcesMergingHelper::ExposeFile` with
 *    `preserveDirectoriesStructure = false`, see
 *    `Core/GDCore/IDE/Project/ResourcesMergingHelper.cpp`), so the
 *    `<script src>` of `character/spawn.js` is NOT
 *    `MyGameCode/character/spawn.js`. The hot reload has to fetch that
 *    exact name, so it is computed here rather than guessed at the call
 *    site.
 */

import { sanitizeFilename } from '../../../Utils/Filename';

/** The folder that holds the game code, created next to the project file. */
export const BYOK_GAME_CODE_FOLDER_SUFFIX = 'Code';

/** The global the folder taxonomy is published as (D15-12). */
export const BYOK_GAME_CODE_NAMESPACE_ROOT = 'GameCode';

/** The manifest written inside the game-code folder (Phase 15.1). */
export const BYOK_GAME_CODE_MANIFEST_FILE_NAME = 'gamecode.json';

/**
 * The extension that carries the `AddSourceFile()` declarations (D15-4).
 * Also the namespace of the one internal action that keeps the extension
 * structurally used — see ByokGameCodeCarrier.js.
 */
export const BYOK_GAME_CODE_CARRIER_EXTENSION_NAME = 'GameCode';

/**
 * A single game-code file is a source file, and every one of them is
 * inlined in the exported `index.html`. 256 KB is far above a hand-written
 * script and far below anything that would make the export unreadable.
 */
export const BYOK_GAME_CODE_MAX_FILE_BYTES = 256 * 1024;

/** Refuse absurd relative paths before they ever reach the filesystem. */
export const BYOK_GAME_CODE_MAX_PATH_LENGTH = 1024;
export const BYOK_GAME_CODE_MAX_SEGMENT_LENGTH = 255;

/**
 * Windows device names: `CON.js` and `LPT1.js` are real files on NTFS with
 * surprising behaviour (they resolve to the console device), and the
 * exporter would then copy a device instead of a file. The same rule the
 * app already applies to the chat and RAG file names (`isSafeRagFileName`
 * in `electron-app/app/ByokRagFiles.js`), kept here so the renderer refuses
 * the path before it ever reaches a filesystem.
 */
const BYOK_GAME_CODE_RESERVED_DEVICE_NAMES = [
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
];

/** Characters Windows forbids in a path segment, plus the URL-ish ones. */
const BYOK_GAME_CODE_FORBIDDEN_SEGMENT_CHARACTERS = /[<>:"|?*]/;

/**
 * The NUL byte, built from its char code so this file stays plain text
 * (a literal NUL makes the whole module unreadable by every text tool).
 */
const BYOK_GAME_CODE_NUL = String.fromCharCode(0);

export type ByokGameCodePathCheck =
  | {| ok: true, relativePath: string |}
  | {| ok: false, error: string |};

export type ByokGameCodeExportedScriptName = {|
  relativePath: string,
  /**
   * The file name the exporter gives this file inside the exported game, or
   * null when it cannot be known — see
   * computeByokGameCodeExportedScriptNames for why a foreign resource makes
   * it unknowable, and ByokGameCodeHotReload.js for what happens then.
   */
  scriptName: string | null,
|};

/**
 * The game-code folder name for a project: `<GameName>Code`.
 *
 * The project name is user text, so it goes through the same sanitizer the
 * resource importer uses — it removes separators, control characters and
 * Windows reserved names, which are exactly the shapes that would let a
 * project name escape the project folder.
 */
export const getByokGameCodeFolderName = (projectName: string): string => {
  const safeProjectName = sanitizeFilename((projectName || '').trim()).trim();
  // A name made only of punctuation ("///") sanitizes to "___", which is
  // confined but unreadable in the tree and the resource list — fall back
  // to a readable default instead.
  const hasReadableCharacter = /[a-zA-Z0-9]/.test(safeProjectName);
  const baseName = hasReadableCharacter ? safeProjectName : 'Game';
  return baseName + BYOK_GAME_CODE_FOLDER_SUFFIX;
};

/**
 * Check one relative path against the game-code folder's rules and return it
 * normalized (`\` becomes `/`, `./` segments are dropped).
 *
 * This is the single confinement gate of A15-3: the tools, the tree, the
 * editor and the agent all route through it, so no surface can be the one
 * that forgets a check.
 */
export const normalizeByokGameCodeRelativePath = (
  // Deliberately `mixed`: this is THE untrusted gate (A15-3) and the model,
  // the tree and the tools all hand it whatever they have.
  input: mixed
): ByokGameCodePathCheck => {
  if (typeof input !== 'string' || !input) {
    return { ok: false, error: 'The game code path is empty.' };
  }
  if (input.indexOf(BYOK_GAME_CODE_NUL) !== -1) {
    return { ok: false, error: 'The game code path contains a NUL byte.' };
  }
  if (input.length > BYOK_GAME_CODE_MAX_PATH_LENGTH) {
    return {
      ok: false,
      error: `The game code path is longer than ${BYOK_GAME_CODE_MAX_PATH_LENGTH} characters.`,
    };
  }

  // Normalize BEFORE validating: a backslash is a separator on Windows, so
  // rejecting it while a model writes `character\spawn.js` would be
  // surprising, but keeping it would make `..\..\x` a second spelling of a
  // traversal the `/` checks below would have refused.
  const normalizedSeparators = input.replace(/\\/g, '/');
  if (normalizedSeparators.startsWith('/')) {
    return {
      ok: false,
      error: 'The game code path must be relative to the game code folder.',
    };
  }
  // A Windows drive prefix (`C:/…`) is absolute even though it does not
  // start with a slash.
  if (/^[a-zA-Z]:/.test(normalizedSeparators)) {
    return {
      ok: false,
      error: 'The game code path must be relative to the game code folder.',
    };
  }

  const segments = normalizedSeparators.split('/');
  const keptSegments = [];
  for (const segment of segments) {
    if (segment === '') {
      // `a//b` and a trailing `/` are not a traversal, but dropping them
      // here keeps exactly one spelling per file, which is what the
      // resource registry and the manifest key on.
      continue;
    }
    if (segment === '.') continue;
    if (segment === '..') {
      return {
        ok: false,
        error: `The game code path escapes the game code folder: "${input}".`,
      };
    }
    if (segment.length > BYOK_GAME_CODE_MAX_SEGMENT_LENGTH) {
      return {
        ok: false,
        error: `A folder or file name is longer than ${BYOK_GAME_CODE_MAX_SEGMENT_LENGTH} characters.`,
      };
    }
    if (segment !== segment.trim() || segment.endsWith('.')) {
      return {
        ok: false,
        error: `"${segment}" must not start or end with a space or a dot.`,
      };
    }
    if (BYOK_GAME_CODE_FORBIDDEN_SEGMENT_CHARACTERS.test(segment)) {
      return {
        ok: false,
        error: `"${segment}" contains a character that is not allowed in a file name.`,
      };
    }
    const baseName = segment.split('.')[0].toLowerCase();
    if (BYOK_GAME_CODE_RESERVED_DEVICE_NAMES.includes(baseName)) {
      return {
        ok: false,
        error: `"${segment}" is a reserved device name on Windows.`,
      };
    }
    keptSegments.push(segment);
  }

  if (keptSegments.length === 0) {
    return { ok: false, error: 'The game code path is empty.' };
  }
  const fileName = keptSegments[keptSegments.length - 1];
  if (!/\.js$/i.test(fileName)) {
    return {
      ok: false,
      error: `"${fileName}" is not a JavaScript file: game code files must end with ".js".`,
    };
  }
  if (fileName === '.js') {
    return { ok: false, error: 'A game code file must have a name.' };
  }

  return { ok: true, relativePath: keptSegments.join('/') };
};

/**
 * Compare two game-code paths for the load order.
 *
 * Case-sensitive first so the order does not depend on the machine's
 * locale, then case-insensitive so two files that differ only by case
 * (`Spawn.js` and `spawn.js` — allowed on Linux, not on Windows) still get
 * a stable order instead of one that flips with the input order.
 */
const compareByokGameCodePaths = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  const lowerLeft = left.toLowerCase();
  const lowerRight = right.toLowerCase();
  if (lowerLeft < lowerRight) return -1;
  if (lowerLeft > lowerRight) return 1;
  return 0;
};

/**
 * The top-level grouping a path belongs to for the D15-3a tiering: the first
 * segment when the file sits in a grouping, or '' for a file at the folder
 * root.
 */
const getByokGameCodeTopLevelFolder = (relativePath: string): string => {
  const separatorIndex = relativePath.indexOf('/');
  return separatorIndex === -1 ? '' : relativePath.slice(0, separatorIndex);
};

/**
 * D15-3a: tier 1 is the folder root plus `core/`, tier 2 is every other
 * top-level grouping. Inside a tier the files are alphabetical, and the
 * tier-2 groupings are alphabetical among themselves — so `character/`
 * always loads before `enemy/` whatever order the filesystem listed them in.
 *
 * Total and deterministic: the input order never leaks, because the sort
 * below is a total order over distinct paths.
 */
export const orderByokGameCodeRelativePaths = (
  relativePaths: Array<string>
): Array<string> => {
  const isTierOne = (relativePath: string): boolean => {
    const folder = getByokGameCodeTopLevelFolder(relativePath);
    return folder === '' || folder === 'core';
  };

  const tierOne = relativePaths.filter(isTierOne);
  const tierTwo = relativePaths.filter(
    relativePath => !isTierOne(relativePath)
  );
  tierOne.sort(compareByokGameCodePaths);
  tierTwo.sort(compareByokGameCodePaths);
  return tierOne.concat(tierTwo);
};

/**
 * D15-12: the namespace path segments a file publishes into, i.e. its
 * relative path without the `.js` extension and without the `core/` marker
 * folder (`core/` marks a file as boot-order-critical, it does not nest it).
 *
 * `main.js` -> ['main'], `core/boot.js` -> ['boot'],
 * `character/spawn.js` -> ['character', 'spawn'].
 */
export const getByokGameCodeNamespaceSegments = (
  relativePath: string
): Array<string> => {
  const withoutExtension = relativePath.replace(/\.js$/i, '');
  const segments = withoutExtension.split('/').filter(Boolean);
  if (segments[0] === 'core') return segments.slice(1);
  return segments;
};

/** `character/spawn.js` -> `GameCode.character.spawn`. */
export const getByokGameCodeNamespaceExpression = (
  relativePath: string
): string =>
  [BYOK_GAME_CODE_NAMESPACE_ROOT]
    .concat(getByokGameCodeNamespaceSegments(relativePath))
    .join('.');

/**
 * The defensive namespace-creation lines D15-12 asks every file to open
 * with: `GameCode = window.GameCode || {}` and then one line per grouping.
 * Creating the namespace on the way in is what makes load order irrelevant
 * for a file to LOAD — a file that runs before the one that creates its
 * grouping still gets a namespace to assign into.
 */
export const getByokGameCodeNamespacePrologue = (
  relativePath: string
): string => {
  const segments = getByokGameCodeNamespaceSegments(relativePath);
  const lines = [
    `${BYOK_GAME_CODE_NAMESPACE_ROOT} = window.${BYOK_GAME_CODE_NAMESPACE_ROOT} || {};`,
  ];
  // Every GROUPING on the way to the file, so `character/hero/attack.js`
  // creates both `GameCode.character` and `GameCode.character.hero`. The
  // leaf is assigned by the file itself, never created here.
  const groupings = segments.slice(0, -1);
  for (let index = 0; index < groupings.length; index++) {
    const expression =
      BYOK_GAME_CODE_NAMESPACE_ROOT +
      '.' +
      groupings.slice(0, index + 1).join('.');
    lines.push(`${expression} = ${expression} || {};`);
  }
  return lines.join('\n');
};

/** The file name of a relative path (no folder part). */
const getByokGameCodeBaseFileName = (relativePath: string): string => {
  const lastSeparator = relativePath.lastIndexOf('/');
  return lastSeparator === -1
    ? relativePath
    : relativePath.slice(lastSeparator + 1);
};

/**
 * The `<script src>` each game-code file gets in the exported game.
 *
 * The exporter copies every resource flat into the export folder and
 * renames on collision: `ResourcesMergingHelper::ExposeFile` calls
 * `SetNewFilename(absolutePath, FileNameFrom(absolutePath))`, and
 * `NewNameGenerator::Generate` then appends `2`, `3`, … — so the second
 * `spawn.js` exports as `spawn2.js`. Two game-code files may share a base
 * name (`character/spawn.js` and `enemy/spawn.js` are the owner's own
 * taxonomy, so they always will), and because we know the D15-3a order AND
 * which names WE already took, that case is computed exactly.
 *
 * A collision with a FOREIGN resource cannot be: the exporter walks the
 * whole project, so which of the two keeps `spawn.js` depends on a
 * visitation order this module does not own. Rather than guess a URL that
 * would 404 at runtime, the whole set is reported as unknown and the caller
 * hard-reloads instead (see ByokGameCodeHotReload.js).
 */
export const computeByokGameCodeExportedScriptNames = (
  orderedRelativePaths: Array<string>,
  foreignFileNames: Array<string>
): Array<ByokGameCodeExportedScriptName> => {
  const foreignNames = new Set(foreignFileNames);
  const hasForeignCollision = orderedRelativePaths.some(relativePath =>
    foreignNames.has(getByokGameCodeBaseFileName(relativePath))
  );
  if (hasForeignCollision) {
    return orderedRelativePaths.map(relativePath => ({
      relativePath,
      scriptName: null,
    }));
  }

  const takenNames = new Set<string>();
  const results: Array<ByokGameCodeExportedScriptName> = [];
  for (const relativePath of orderedRelativePaths) {
    const fileName = getByokGameCodeBaseFileName(relativePath);
    if (!takenNames.has(fileName)) {
      takenNames.add(fileName);
      results.push({ relativePath, scriptName: fileName });
      continue;
    }
    // Our own collision: the first file in D15-3a order keeps the name, this
    // one takes the next free suffix, exactly like NewNameGenerator.
    const extensionIndex = fileName.lastIndexOf('.');
    const baseName =
      extensionIndex === -1 ? fileName : fileName.slice(0, extensionIndex);
    const extension =
      extensionIndex === -1 ? '' : fileName.slice(extensionIndex);
    let suffix = 2;
    while (takenNames.has(baseName + suffix + extension)) {
      suffix++;
    }
    const scriptName = baseName + suffix + extension;
    takenNames.add(scriptName);
    results.push({ relativePath, scriptName });
  }
  return results;
};

/** The name a game-code file is registered under in the resources manager. */
export const getByokGameCodeResourceName = (
  relativePath: string,
  gameCodeFolderName: string
): string => gameCodeFolderName + '/' + relativePath;

/**
 * The project-relative path a game-code resource points at, i.e. what
 * `resource.setFile()` receives: `MyGameCode/character/spawn.js`, relative
 * to the project folder — the folder the project file itself is serialized
 * against.
 */
export const getByokGameCodeProjectRelativeFilePath = (
  relativePath: string,
  gameCodeFolderName: string
): string => gameCodeFolderName + '/' + relativePath;
