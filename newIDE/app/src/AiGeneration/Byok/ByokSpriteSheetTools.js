// @flow

/**
 * Phase 19.5 (D19-1) — the thin BYOK adapter over the fork's sprite-sheet
 * pipeline.
 *
 * One tool, a `ByokExtraTool` registered through the interception registry
 * (ByokExtraTools):
 * - `import_sprite_sheet`: slice one local image (a texture atlas) along an
 *   explicit grid into frame PNGs written into the project's assets folder,
 *   register them, and append them as a new animation of a Sprite object —
 *   "import this sheet as a 4×4 grid onto Player" from chat (D19-4: the
 *   grid is stated, never auto-detected).
 *
 * It WRITES the project and the assets folder (`modifiesProject: true`, so
 * the approval gate fires — ByokSeam), is desktop-guarded by the handler
 * (the slicer needs the Electron filesystem), and like every BYOK tool it
 * answers failures with `{success:false,message}` instead of throwing — a
 * thrown error here would orphan the agent's tool_calls and brick the chat.
 * The tool is advertised ONLY through `search_tools` (never in
 * BYOK_CORE_TOOL_NAMES), so the always-on prompt budget is untouched.
 */

import {
  importForkSpriteSheet,
  type ForkSpriteSheetToolDeps,
} from '../../Fork/SpriteSheet/ForkSpriteSheetToolHandler';
import type { ForkSpriteSheetGrid } from '../../Fork/SpriteSheet/ForkSpriteSheetPort';
import type { ByokExtraTool, ByokExtraToolResult } from './ByokExtraTools';

export type ByokSpriteSheetToolDeps = {|
  /** Null resolves the real desktop deps at call time (the test seam). */
  handlerDeps: ?ForkSpriteSheetToolDeps,
|};

const makeDefaultDeps = (): ByokSpriteSheetToolDeps => ({
  handlerDeps: null,
});

/** The one failure shape of the tool (never throw, always a message). */
const refusal = (message: string): ByokExtraToolResult => ({
  output: { success: false, message },
  didModifyProject: false,
});

/** Read an integer grid knob only when the model actually sent one. */
const readGridInt = (value: mixed): number | void =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined;

/**
 * The model-provided grid, mapped from the schema's snake_case fields to
 * the pipeline's grid type — or null when it is missing/ill-typed.
 */
const readGrid = (args: Object): ForkSpriteSheetGrid | null => {
  const raw = args.grid;
  if (!raw || typeof raw !== 'object') return null;
  if (raw.mode !== 'rows-columns' && raw.mode !== 'frame-size') return null;
  return {
    mode: raw.mode,
    rows: readGridInt(raw.rows),
    columns: readGridInt(raw.columns),
    frameWidth: readGridInt(raw.frame_width),
    frameHeight: readGridInt(raw.frame_height),
    margin: readGridInt(raw.margin),
    spacing: readGridInt(raw.spacing),
  };
};

const makeImportSpriteSheetTool = (
  deps: ByokSpriteSheetToolDeps
): ByokExtraTool => ({
  name: 'import_sprite_sheet',
  // Frame files land in the project folder and the object gains an
  // animation: a project change to approve and save like any other edit.
  modifiesProject: true,
  run: async (args, collaborators) => {
    const project = collaborators.getProject();
    if (!project) {
      return refusal('No project is open — open or create one first.');
    }
    const objectName =
      typeof args.object_name === 'string' ? args.object_name.trim() : '';
    if (!objectName) {
      return refusal(
        'The "object_name" of the Sprite object to import into is required.'
      );
    }
    const sourcePath =
      typeof args.source_path === 'string' ? args.source_path.trim() : '';
    if (!sourcePath) {
      return refusal(
        'The "source_path" of the sprite sheet image is required (an absolute path, or one relative to the project folder).'
      );
    }
    const grid = readGrid(args);
    if (!grid) {
      return refusal(
        'The "grid" is required: {mode: "rows-columns", rows, columns} or {mode: "frame-size", frame_width, frame_height}, plus optional integer margin and spacing (both default 0).'
      );
    }
    const animationName =
      typeof args.animation_name === 'string' && args.animation_name.trim()
        ? args.animation_name.trim()
        : 'Imported';
    const fps =
      typeof args.fps === 'number' && Number.isFinite(args.fps) && args.fps > 0
        ? args.fps
        : 10;
    const loop = typeof args.loop === 'boolean' ? args.loop : true;

    const result = await importForkSpriteSheet(
      project,
      {
        objectName,
        sourceAbsolutePath: sourcePath,
        grid,
        animationName,
        fps,
        loop,
      },
      deps.handlerDeps || undefined
    );
    if (!result.success) {
      return {
        output: { success: false, message: result.message },
        didModifyProject: result.didModifyProject,
      };
    }
    return {
      output: {
        success: true,
        message: result.output,
        animation_name: result.animationName,
        frame_count: result.frameCount,
        resource_names: result.resourceNames,
      },
      didModifyProject: true,
    };
  },
});

/**
 * The sprite-sheet tool of Phase 19.5. The deps are injectable so the tests
 * drive a fake slicer/filesystem; production resolves the real desktop
 * deps at call time.
 */
export const getByokSpriteSheetTools = (
  overrides?: Partial<ByokSpriteSheetToolDeps>
): Array<ByokExtraTool> => {
  const deps: ByokSpriteSheetToolDeps = {
    ...makeDefaultDeps(),
    ...(overrides || {}),
  };
  return [makeImportSpriteSheetTool(deps)];
};
