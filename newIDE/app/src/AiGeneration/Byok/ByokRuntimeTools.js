// @flow
import optionalRequire from '../../Utils/OptionalRequire';
import type { EditorFunctionCallResult } from '../../EditorFunctions';
import type { ByokExtraTool, ByokExtraToolResult } from './ByokExtraTools';
import {
  createByokPreviewSession,
  type ByokPreviewLauncher,
  type ByokPreviewSession,
} from './ByokPreviewSession';
import type { ByokImageInfo } from './ByokImageContent';

const electron = optionalRequire('electron');
const ipcRenderer = electron ? electron.ipcRenderer : null;

/**
 * The perception tools of Phase 6: screenshots (scene editor canvas, live
 * preview window), preview control, runtime feedback (logs, crashes,
 * state), and the gameplay-test result shaping that turns base64
 * screenshots into image parts. The tools are registered in
 * ByokExtraTools; everything environment-specific (canvas capture, the
 * Electron IPC, the preview launcher, the image store) is injected.
 */

/** The smallest canvas considered a scene editor (previews in panels are far smaller). */
const MINIMUM_SCENE_CANVAS_WIDTH = 400;
const MINIMUM_SCENE_CANVAS_HEIGHT = 300;

/**
 * Find the canvas of the currently visible scene editor: the largest
 * visible canvas of the document (the scene editor's Pixi canvas, created
 * with preserveDrawingBuffer, dominates the layout; smaller canvases
 * belong to resource previews). Returns null when none is visible.
 */
export const findLargestVisibleSceneCanvas = (
  documentLike: any
): any | null => {
  if (!documentLike || typeof documentLike.querySelectorAll !== 'function') {
    return null;
  }
  const canvases = documentLike.querySelectorAll('canvas');
  let bestCanvas = null;
  let bestArea = 0;
  for (const canvas of canvases) {
    if (!canvas || typeof canvas.clientWidth !== 'number') continue;
    if (canvas.offsetParent === null && !canvas.getClientRects) continue;
    if (
      canvas.offsetParent === null &&
      canvas.getClientRects &&
      canvas.getClientRects().length === 0
    ) {
      continue;
    }
    if (canvas.clientWidth < MINIMUM_SCENE_CANVAS_WIDTH) continue;
    if (canvas.clientHeight < MINIMUM_SCENE_CANVAS_HEIGHT) continue;
    const area = canvas.clientWidth * canvas.clientHeight;
    if (area > bestArea) {
      bestArea = area;
      bestCanvas = canvas;
    }
  }
  return bestCanvas;
};

/** Everything the perception tools need from their host. */
export type ByokRuntimeToolDeps = {|
  getProject: () => any,
  // Captures the visible scene editor canvas as a JPEG data URL (null when
  // no scene editor is visible) — implemented in AskAiEditorContainer.
  captureSceneCanvas: () => ?string,
  // Runs the Electron `byok-preview-capture` IPC (null when not in
  // Electron — the web build cannot capture a preview window).
  invokePreviewCapture: (
    previewId: ?number
  ) => Promise<{| ok: boolean, data?: string, error?: string |}>,
  // Resolves the preview launcher registered by MainFrame.
  getPreviewLauncher: () => ?ByokPreviewLauncher,
  // The image pipeline (downscale + register, see ByokImageContent).
  storeImage: (dataUrl: string) => Promise<ByokImageInfo>,
  // Runs one editor-registry call (used by the gameplay-test shaping).
  executeSingleToolCall: (
    name: string,
    args: Object
  ) => Promise<EditorFunctionCallResult>,
|};

/**
 * Call the Electron `byok-preview-capture` IPC of the main process. Outside
 * Electron (web build), previews cannot be captured — the actionable
 * failure says so.
 */
export const invokeByokPreviewCapture = async (
  previewId: ?number
): Promise<{| ok: boolean, data?: string, error?: string |}> => {
  if (!ipcRenderer) {
    return {
      ok: false,
      error: 'Preview capture is only available in the desktop app.',
    };
  }
  try {
    return await ipcRenderer.invoke('byok-preview-capture', previewId);
  } catch (error) {
    return {
      ok: false,
      error: (error && error.message) || String(error),
    };
  }
};

const makeFailureOutput = (message: string) => ({ success: false, message });

/**
 * Replace the base64 screenshots of a gameplay test result by image ids
 * (registered through the image pipeline) and keep everything else the
 * model needs to self-correct: assertions, errors, console logs, final
 * state, and the executed source on failure.
 */
export const shapeByokGameplayTestOutput = async (
  output: any,
  storeImage: (dataUrl: string) => Promise<ByokImageInfo>
): Promise<{| output: Object, imageIds: Array<string> |}> => {
  const shaped = { ...output };
  const imageIds: Array<string> = [];
  if (Array.isArray(output.screenshots)) {
    const shapedScreenshots = [];
    for (const screenshot of output.screenshots) {
      if (
        !screenshot ||
        typeof screenshot !== 'object' ||
        typeof screenshot.jpegBase64 !== 'string' ||
        !screenshot.jpegBase64
      ) {
        continue;
      }
      const image = await storeImage(
        `data:image/jpeg;base64,${screenshot.jpegBase64}`
      );
      imageIds.push(image.id);
      shapedScreenshots.push({
        label: typeof screenshot.label === 'string' ? screenshot.label : '',
        frame: typeof screenshot.frame === 'number' ? screenshot.frame : null,
        image: image.id,
      });
    }
    shaped.screenshots = shapedScreenshots;
  }
  return { output: shaped, imageIds };
};

/**
 * Create the perception tools. The preview session is created on first use
 * (one BYOK preview at a time — the v1 rule).
 */
// The session holder the completion gate reads (see getByokPreviewHasCrashed):
// the production tools are created once at import time, so exactly one
// holder exists at runtime. Kept module-level (and not returned) so the
// tool list's shape stays unchanged.
const activePreviewSessionHolder: {| session: ?ByokPreviewSession |} = {
  session: null,
};

/**
 * Whether the BYOK preview of this window crashed and was not restarted
 * since — the completion gate's "no crashed previews pending" check.
 */
export const getByokPreviewHasCrashed = (): boolean =>
  !!activePreviewSessionHolder.session &&
  activePreviewSessionHolder.session.hasCrashed();

/** Test-only: drop the cached session between tests. */
export const resetByokPreviewSessionForTests = (): void => {
  activePreviewSessionHolder.session = null;
};

/**
 * The one BYOK preview session, created on first use (one BYOK preview at
 * a time — the v1 rule). Shared by the perception tools (Phase 6) and the
 * debugger tools (Phase 12), so they steer the SAME preview.
 */
export const getOrCreateByokPreviewSession = (
  deps: ByokRuntimeToolDeps
): ByokPreviewSession => {
  if (!activePreviewSessionHolder.session) {
    activePreviewSessionHolder.session = createByokPreviewSession({
      getPreviewLauncher: deps.getPreviewLauncher,
      getProject: deps.getProject,
    });
  }
  return activePreviewSessionHolder.session;
};

export const makeByokRuntimeTools = (): Array<ByokExtraTool> => {
  const getOrCreatePreviewSession = getOrCreateByokPreviewSession;

  const captureSceneScreenshotTool: ByokExtraTool = {
    name: 'capture_scene_screenshot',
    modifiesProject: false,
    run: async (args, collaborators): Promise<ByokExtraToolResult> => {
      const runtimeDeps = (collaborators.runtimeDeps: ?ByokRuntimeToolDeps);
      if (!runtimeDeps) {
        return {
          output: makeFailureOutput(
            'Scene screenshots are not available in this environment.'
          ),
          didModifyProject: false,
        };
      }
      const dataUrl = runtimeDeps.captureSceneCanvas();
      if (!dataUrl) {
        return {
          output: makeFailureOutput(
            'No scene editor canvas is visible — open the scene in the editor (or ask the user to), then capture again.'
          ),
          didModifyProject: false,
        };
      }
      const image = await runtimeDeps.storeImage(dataUrl);
      const requestedScene =
        typeof args.scene_name === 'string' ? args.scene_name : '';
      return {
        output: {
          success: true,
          image: image.id,
          width: image.width,
          height: image.height,
          note: `Captured the currently visible scene editor canvas${
            requestedScene
              ? ` — it may not be the requested scene "${requestedScene}" (only the open editor can be captured)`
              : ''
          }. Read the machine-readable state with describe_instances / inspect_scene_properties_layers_effects.`,
        },
        images: [image.id],
        didModifyProject: false,
      };
    },
  };

  const capturePreviewScreenshotTool: ByokExtraTool = {
    name: 'capture_preview_screenshot',
    modifiesProject: false,
    run: async (args, collaborators): Promise<ByokExtraToolResult> => {
      const runtimeDeps = (collaborators.runtimeDeps: ?ByokRuntimeToolDeps);
      if (!runtimeDeps) {
        return {
          output: makeFailureOutput(
            'Preview screenshots are not available in this environment.'
          ),
          didModifyProject: false,
        };
      }
      const previewId =
        typeof args.preview_id === 'number' ? args.preview_id : null;
      const response = await runtimeDeps.invokePreviewCapture(previewId);
      if (!response.ok || !response.data) {
        return {
          output: makeFailureOutput(
            `No preview window could be captured: ${response.error ||
              'unknown error'}. Start one with start_preview first.`
          ),
          didModifyProject: false,
        };
      }
      const image = await runtimeDeps.storeImage(
        `data:image/png;base64,${response.data}`
      );
      return {
        output: {
          success: true,
          image: image.id,
          width: image.width,
          height: image.height,
          note:
            'Live preview frame. Pair it with read_preview_logs and inspect_runtime_state for the machine-readable state.',
        },
        images: [image.id],
        didModifyProject: false,
      };
    },
  };

  const startPreviewTool: ByokExtraTool = {
    name: 'start_preview',
    modifiesProject: false,
    run: async (args, collaborators): Promise<ByokExtraToolResult> => {
      const runtimeDeps = (collaborators.runtimeDeps: ?ByokRuntimeToolDeps);
      if (!runtimeDeps) {
        return {
          output: makeFailureOutput('Previews are not available here.'),
          didModifyProject: false,
        };
      }
      const session = getOrCreatePreviewSession(runtimeDeps);
      const sceneName =
        typeof args.scene_name === 'string' && args.scene_name
          ? args.scene_name
          : undefined;
      const result = await session.start({ sceneName });
      return {
        output: {
          ...result,
          note:
            'Read the game vitals with read_preview_logs, get_runtime_errors and inspect_runtime_state; see the frame with capture_preview_screenshot.',
        },
        didModifyProject: false,
      };
    },
  };

  const stopPreviewTool: ByokExtraTool = {
    name: 'stop_preview',
    modifiesProject: false,
    run: async (args, collaborators): Promise<ByokExtraToolResult> => {
      const runtimeDeps = (collaborators.runtimeDeps: ?ByokRuntimeToolDeps);
      if (!runtimeDeps) {
        return {
          output: makeFailureOutput('Previews are not available here.'),
          didModifyProject: false,
        };
      }
      const session = getOrCreatePreviewSession(runtimeDeps);
      return { output: session.stop(), didModifyProject: false };
    },
  };

  const readPreviewLogsTool: ByokExtraTool = {
    name: 'read_preview_logs',
    modifiesProject: false,
    run: async (args, collaborators): Promise<ByokExtraToolResult> => {
      const runtimeDeps = (collaborators.runtimeDeps: ?ByokRuntimeToolDeps);
      if (!runtimeDeps) {
        return {
          output: makeFailureOutput('Previews are not available here.'),
          didModifyProject: false,
        };
      }
      const session = getOrCreatePreviewSession(runtimeDeps);
      if (!session.isRunning()) {
        return {
          output: makeFailureOutput(
            'No preview is running — start_preview first.'
          ),
          didModifyProject: false,
        };
      }
      const logs = session.getLogs({
        sinceIndex: typeof args.since_index === 'number' ? args.since_index : 0,
        level: typeof args.level === 'string' ? args.level : undefined,
      });
      const logStats = session.getLogStats();
      return {
        output: {
          success: true,
          logs,
          log_count: logs.length,
          dropped_log_count: logStats.droppedCount,
          note:
            'console.log output of the running game. The buffer keeps the latest 200 entries; when dropped_log_count grows, old indexes shift — re-read from 0. Pair with capture_preview_screenshot to see the frame.',
        },
        didModifyProject: false,
      };
    },
  };

  const getRuntimeErrorsTool: ByokExtraTool = {
    name: 'get_runtime_errors',
    modifiesProject: false,
    run: async (args, collaborators): Promise<ByokExtraToolResult> => {
      const runtimeDeps = (collaborators.runtimeDeps: ?ByokRuntimeToolDeps);
      if (!runtimeDeps) {
        return {
          output: makeFailureOutput('Previews are not available here.'),
          didModifyProject: false,
        };
      }
      const session = getOrCreatePreviewSession(runtimeDeps);
      if (!session.isRunning()) {
        return {
          output: makeFailureOutput(
            'No preview is running — start_preview first.'
          ),
          didModifyProject: false,
        };
      }
      const errors = session.getNewErrors();
      return {
        output: {
          success: true,
          errors,
          hasErrors: errors.length > 0,
          note:
            'Errors and crashes since the last call. Fix the events or code they point to, then look again.',
        },
        didModifyProject: false,
      };
    },
  };

  const inspectRuntimeStateTool: ByokExtraTool = {
    name: 'inspect_runtime_state',
    modifiesProject: false,
    run: async (args, collaborators): Promise<ByokExtraToolResult> => {
      const runtimeDeps = (collaborators.runtimeDeps: ?ByokRuntimeToolDeps);
      if (!runtimeDeps) {
        return {
          output: makeFailureOutput('Previews are not available here.'),
          didModifyProject: false,
        };
      }
      const session = getOrCreatePreviewSession(runtimeDeps);
      // The schema advertised scene_name / variable_paths and the handler
      // ignored them: a narrow query answered with the full multi-scene
      // dump, which the tool cap then cut mid-JSON (audit100226 TOOL-3).
      const sceneName =
        typeof args.scene_name === 'string' && args.scene_name
          ? args.scene_name
          : null;
      const variablePaths = Array.isArray(args.variable_paths)
        ? args.variable_paths.filter(path => typeof path === 'string')
        : null;
      const result = await session.inspectState({ sceneName, variablePaths });
      if (!result.success) {
        return { output: result, didModifyProject: false };
      }
      return {
        output: {
          success: true,
          state: result.state,
          note:
            'Live game state (instances per scene, scene and global variables). When coordinates matter, read them here — never guess from pixels.',
        },
        didModifyProject: false,
      };
    },
  };

  const runGameplayTestTool: ByokExtraTool = {
    name: 'run_gameplay_test',
    modifiesProject: true,
    run: async (args, collaborators): Promise<ByokExtraToolResult> => {
      const runtimeDeps = (collaborators.runtimeDeps: ?ByokRuntimeToolDeps);
      if (!runtimeDeps) {
        return {
          output: makeFailureOutput('Gameplay tests are not available here.'),
          didModifyProject: false,
        };
      }
      const result = await runtimeDeps.executeSingleToolCall(
        'run_gameplay_test',
        args
      );
      if (result.status !== 'finished') {
        return {
          output: makeFailureOutput(
            'The gameplay test did not finish (it may have been aborted).'
          ),
          didModifyProject: false,
        };
      }
      const shaped = await shapeByokGameplayTestOutput(
        result.output,
        runtimeDeps.storeImage
      );
      return {
        output: shaped.output,
        images: shaped.imageIds,
        didModifyProject: !!result.didModifyProject,
      };
    },
  };

  return [
    captureSceneScreenshotTool,
    capturePreviewScreenshotTool,
    startPreviewTool,
    stopPreviewTool,
    readPreviewLogsTool,
    getRuntimeErrorsTool,
    inspectRuntimeStateTool,
    runGameplayTestTool,
  ];
};
