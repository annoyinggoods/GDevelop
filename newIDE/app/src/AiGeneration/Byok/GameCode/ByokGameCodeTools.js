// @flow

/**
 * Phase 15.3 — the agent's read/write surface over the game code folder.
 *
 * Five tools in the ByokExtraTool shape, registered through the interception
 * registry (ByokExtraTools). The rules are not re-implemented here: the
 * folder, its confinement gate (A15-3) and the load order come from
 * ByokGameCodeCore, the bytes move through ByokGameCodeStore, and every
 * successful write/delete re-syncs the project-model side (the resources
 * and the carrier extension) through ByokGameCodeCarrier — with the FRESH
 * listing, so the carrier's declared order is always the real one.
 *
 * Like ByokResourceTools, this module follows the {success, message} output
 * convention and answers EVERY failure (no project, non-desktop, refused
 * path, missing file, carrier error) instead of throwing — a thrown error
 * here would orphan the agent's tool_calls and brick the chat.
 */

import {
  getByokGameCodeNamespaceExpression,
  getByokGameCodeNamespacePrologue,
  normalizeByokGameCodeRelativePath,
} from './ByokGameCodeCore';
import { ensureByokGameCodeCarrier } from './ByokGameCodeCarrier';
import type { ByokGameCodeCarrierResult } from './ByokGameCodeCarrier';
import {
  getProjectGameCodeFolderName,
  getByokGameCodeStore,
  type ByokGameCodeStore,
} from './ByokGameCodeStore';
import type { ByokExtraTool, ByokExtraToolResult } from '../ByokExtraTools';

/**
 * What `reload_game_code` routes to: the Phase 15.4 hot reload. The dep is
 * `undefined` (resolve the real reload lazily at call time), `null` (no
 * routing: the tool answers with an actionable failure), or an injected
 * function (the tests).
 */
export type ByokGameCodeReloadFunction = (options: {|
  project: any,
|}) => Promise<{| success: boolean, message: string |}>;

export type ByokGameCodeToolDeps = {|
  store: ByokGameCodeStore,
  reloadGameCode: ?ByokGameCodeReloadFunction,
|};

const makeDefaultDeps = (): ByokGameCodeToolDeps => ({
  store: getByokGameCodeStore(),
  reloadGameCode: undefined,
});

/**
 * Resolve the real Phase 15.4 reload at CALL time (the deferred-require
 * pattern of ByokRagBuildService). The module must not be imported at the
 * top: it drags the local exporter (LocalFileSystem, which reads `path`
 * at module scope) into EVERY consumer of this tools module, and that
 * broke the specs that stub the filesystem away.
 */
const loadDefaultReloadGameCode = (): ?ByokGameCodeReloadFunction => {
  const hotReloadModule = require('./ByokGameCodeHotReload');
  // Cast through any: reloadByokGameCode's exact options type carries
  // invariant optional properties, which Flow refuses to narrow down to
  // the one property the tool actually passes.
  const reload: any = hotReloadModule.reloadByokGameCode;
  return typeof reload === 'function'
    ? (reload: ByokGameCodeReloadFunction)
    : null;
};

/** The one failure shape of every tool (never throw, always a message). */
const refusal = (message: string): ByokExtraToolResult => ({
  output: { success: false, message },
  didModifyProject: false,
});

const describeError = (error: mixed): string =>
  error instanceof Error ? error.message : String(error);

const describeCarrier = (carrier: ByokGameCodeCarrierResult): string => {
  const changes: Array<string> = [];
  if (carrier.createdExtension) {
    changes.push('created the GameCode carrier extension');
  }
  if (carrier.addedResourceNames.length > 0) {
    changes.push(`registered ${carrier.addedResourceNames.length} resource(s)`);
  }
  if (carrier.removedResourceNames.length > 0) {
    changes.push(
      `removed ${
        carrier.removedResourceNames.length
      } resource(s) of deleted files`
    );
  }
  if (changes.length === 0) return 'The export carrier is already up to date.';
  return `The export carrier was updated (${changes.join(
    ', '
  )}), so the files ship in previews and exports.`;
};

/**
 * Re-sync the project model (resources + carrier extension) with a FRESH
 * listing of the folder. A store hiccup here must not fail the write that
 * already succeeded — the carrier reports its own errors, and anything
 * thrown folds into the returned failure text.
 */
const syncCarrierAfterChange = async (
  deps: ByokGameCodeToolDeps,
  project: any,
  gameCodeFolderName: string
): Promise<
  | {| ok: true, carrier: ByokGameCodeCarrierResult |}
  | {| ok: false, error: string |}
> => {
  try {
    const listed = await deps.store.listFiles(
      project.getProjectFile(),
      gameCodeFolderName
    );
    if (!listed.ok) return { ok: false, error: listed.error };
    const carrier = ensureByokGameCodeCarrier({
      project,
      gameCodeFolderName,
      relativePaths: listed.data.map(file => file.relativePath),
    });
    return { ok: true, carrier };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
};

const makeListGameCodeFilesTool = (
  deps: ByokGameCodeToolDeps
): ByokExtraTool => ({
  name: 'list_game_code_files',
  modifiesProject: false,
  run: async (args, collaborators) => {
    const project = collaborators.getProject();
    if (!project) {
      return refusal('No project is open — open or create one first.');
    }
    const gameCodeFolderName = getProjectGameCodeFolderName(project);
    try {
      const listed = await deps.store.listFiles(
        project.getProjectFile(),
        gameCodeFolderName
      );
      if (!listed.ok) {
        return refusal(`Could not list the game code files: ${listed.error}`);
      }
      const files = listed.data.map(file => ({
        relativePath: file.relativePath,
        size_bytes: file.sizeBytes,
        namespace: getByokGameCodeNamespaceExpression(file.relativePath),
      }));
      return {
        output: {
          success: true,
          message:
            files.length === 0
              ? `The game code folder "${gameCodeFolderName}/" (next to the project file) has no JavaScript files yet — create the first one with write_game_code_file.`
              : `${
                  files.length
                } game code file(s) in "${gameCodeFolderName}/", in load order (folder root, then core/, then the other folders alphabetically). Each file publishes the GameCode.* namespace shown next to it.`,
          game_code_folder: gameCodeFolderName,
          files,
        },
        didModifyProject: false,
      };
    } catch (error) {
      return refusal(
        `Could not list the game code files: ${describeError(error)}`
      );
    }
  },
});

const makeReadGameCodeFileTool = (
  deps: ByokGameCodeToolDeps
): ByokExtraTool => ({
  name: 'read_game_code_file',
  modifiesProject: false,
  run: async (args, collaborators) => {
    const project = collaborators.getProject();
    if (!project) {
      return refusal('No project is open — open or create one first.');
    }
    const check = normalizeByokGameCodeRelativePath(args.path);
    if (!check.ok) return refusal(`Refused: ${check.error}`);
    const gameCodeFolderName = getProjectGameCodeFolderName(project);
    try {
      const read = await deps.store.readFile(
        project.getProjectFile(),
        gameCodeFolderName,
        check.relativePath
      );
      if (!read.ok) {
        return refusal(`Could not read "${check.relativePath}": ${read.error}`);
      }
      return {
        output: {
          success: true,
          message: `Read "${
            check.relativePath
          }" — it publishes ${getByokGameCodeNamespaceExpression(
            check.relativePath
          )}. Its defensive namespace prologue is:\n${getByokGameCodeNamespacePrologue(
            check.relativePath
          )}`,
          path: check.relativePath,
          namespace: getByokGameCodeNamespaceExpression(check.relativePath),
          content: read.data,
        },
        didModifyProject: false,
      };
    } catch (error) {
      return refusal(
        `Could not read "${check.relativePath}": ${describeError(error)}`
      );
    }
  },
});

const makeWriteGameCodeFileTool = (
  deps: ByokGameCodeToolDeps
): ByokExtraTool => ({
  name: 'write_game_code_file',
  modifiesProject: true,
  run: async (args, collaborators) => {
    const project = collaborators.getProject();
    if (!project) {
      return refusal('No project is open — open or create one first.');
    }
    if (typeof args.content !== 'string') {
      return refusal(
        'The "content" to write is required (a JavaScript source string).'
      );
    }
    // The untrusted gate runs HERE, before anything touches a disk: every
    // refusal below answers without writing.
    const check = normalizeByokGameCodeRelativePath(args.path);
    if (!check.ok) return refusal(`Refused: ${check.error}`);
    const gameCodeFolderName = getProjectGameCodeFolderName(project);
    try {
      const written = await deps.store.writeFile(
        project.getProjectFile(),
        gameCodeFolderName,
        check.relativePath,
        args.content
      );
      if (!written.ok) {
        // The store re-checks the confinement and enforces the size cap
        // (BYOK_GAME_CODE_MAX_FILE_BYTES): report its refusal verbatim.
        return refusal(
          `Could not write "${check.relativePath}": ${written.error}`
        );
      }
      const namespace = getByokGameCodeNamespaceExpression(check.relativePath);
      const carrier = await syncCarrierAfterChange(
        deps,
        project,
        gameCodeFolderName
      );
      const lines = [
        `${
          written.data.created ? 'Created' : 'Updated'
        } ${gameCodeFolderName}/${check.relativePath}.`,
        `The file publishes the namespace ${namespace}: assign into it (functions, classes, constants), starting from the defensive prologue:\n${getByokGameCodeNamespacePrologue(
          check.relativePath
        )}`,
      ];
      if (carrier.ok) {
        lines.push(describeCarrier(carrier.carrier));
      } else {
        lines.push(
          `The file was written, but the export carrier could not be updated: ${
            carrier.error
          }. The file will not ship until the carrier is synced.`
        );
      }
      return {
        output: {
          success: true,
          message: lines.join('\n'),
          path: check.relativePath,
          created: written.data.created,
          namespace,
          prologue: getByokGameCodeNamespacePrologue(check.relativePath),
        },
        // The game's own source changed — the approval gate and the
        // unsaved-changes logic must both see it.
        didModifyProject: true,
      };
    } catch (error) {
      return refusal(
        `Could not write "${check.relativePath}": ${describeError(error)}`
      );
    }
  },
});

const makeDeleteGameCodeFileTool = (
  deps: ByokGameCodeToolDeps
): ByokExtraTool => ({
  name: 'delete_game_code_file',
  modifiesProject: true,
  run: async (args, collaborators) => {
    const project = collaborators.getProject();
    if (!project) {
      return refusal('No project is open — open or create one first.');
    }
    const check = normalizeByokGameCodeRelativePath(args.path);
    if (!check.ok) return refusal(`Refused: ${check.error}`);
    const gameCodeFolderName = getProjectGameCodeFolderName(project);
    try {
      const deleted = await deps.store.deleteFile(
        project.getProjectFile(),
        gameCodeFolderName,
        check.relativePath
      );
      if (!deleted.ok) {
        return refusal(
          `Could not delete "${check.relativePath}": ${deleted.error}`
        );
      }
      const carrier = await syncCarrierAfterChange(
        deps,
        project,
        gameCodeFolderName
      );
      const lines = [
        `Deleted ${gameCodeFolderName}/${check.relativePath}.`,
        carrier.ok
          ? describeCarrier(carrier.carrier)
          : `The carrier could not be updated: ${
              carrier.error
            }. The deleted file will still ship until the carrier is synced.`,
        'A running preview does not pick up a deletion by itself: restart the preview, or call reload_game_code (it hard-reloads for deletions).',
      ];
      return {
        output: {
          success: true,
          message: lines.join('\n'),
          path: check.relativePath,
        },
        didModifyProject: true,
      };
    } catch (error) {
      return refusal(
        `Could not delete "${check.relativePath}": ${describeError(error)}`
      );
    }
  },
});

const makeReloadGameCodeTool = (deps: ByokGameCodeToolDeps): ByokExtraTool => ({
  name: 'reload_game_code',
  modifiesProject: false,
  run: async (args, collaborators) => {
    const project = collaborators.getProject();
    if (!project) {
      return refusal('No project is open — open or create one first.');
    }
    let reloadGameCode = deps.reloadGameCode;
    if (reloadGameCode === undefined) {
      try {
        reloadGameCode = loadDefaultReloadGameCode();
      } catch (error) {
        reloadGameCode = null;
      }
    }
    if (!reloadGameCode) {
      return refusal('Reloading the game code is not available yet.');
    }
    try {
      const result = await reloadGameCode({ project });
      return {
        output: {
          success: !!result && result.success !== false,
          message:
            (result && result.message) ||
            'The game code reload finished without a message.',
        },
        didModifyProject: false,
      };
    } catch (error) {
      return refusal(`The game code reload failed: ${describeError(error)}`);
    }
  },
});

/**
 * The five game-code tools. The deps are injectable so the tests drive a
 * real temp directory or a non-desktop store; production uses the shared
 * store singleton (the same bindings the pane uses — one writer, no drift).
 */
export const getByokGameCodeTools = (
  overrides?: Partial<ByokGameCodeToolDeps>
): Array<ByokExtraTool> => {
  const deps: ByokGameCodeToolDeps = {
    ...makeDefaultDeps(),
    ...overrides,
  };
  return [
    makeListGameCodeFilesTool(deps),
    makeReadGameCodeFileTool(deps),
    makeWriteGameCodeFileTool(deps),
    makeDeleteGameCodeFileTool(deps),
    makeReloadGameCodeTool(deps),
  ];
};
