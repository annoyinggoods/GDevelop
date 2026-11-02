// @flow
import {
  findLargestVisibleSceneCanvas,
  makeByokRuntimeTools,
  shapeByokGameplayTestOutput,
} from './ByokRuntimeTools';
import { registerByokImage } from './ByokImageContent';
import type { ByokExtraToolCollaborators } from './ByokExtraTools';

const makeCanvas = (width: number, height: number) => ({
  clientWidth: width,
  clientHeight: height,
  offsetParent: ({}: any),
});

describe('findLargestVisibleSceneCanvas', () => {
  const makeDocument = (canvases: Array<any>) => ({
    querySelectorAll: () => canvases,
  });

  it('picks the largest visible canvas above the scene-editor threshold', () => {
    const sceneCanvas = makeCanvas(1200, 800);
    const previewCanvas = makeCanvas(150, 150);
    expect(
      findLargestVisibleSceneCanvas(
        makeDocument([previewCanvas, sceneCanvas, makeCanvas(600, 400)])
      )
    ).toBe(sceneCanvas);
  });

  it('ignores hidden canvases', () => {
    const hiddenCanvas = makeCanvas(1200, 800);
    hiddenCanvas.offsetParent = null;
    expect(
      findLargestVisibleSceneCanvas(makeDocument([hiddenCanvas]))
    ).toBeNull();
  });

  it('returns null when no canvas is big enough or none exists', () => {
    expect(
      findLargestVisibleSceneCanvas(makeDocument([makeCanvas(300, 200)]))
    ).toBeNull();
    expect(findLargestVisibleSceneCanvas(makeDocument([]))).toBeNull();
    expect(findLargestVisibleSceneCanvas(null)).toBeNull();
  });
});

describe('shapeByokGameplayTestOutput', () => {
  it('turns base64 screenshots into image ids and keeps the repair data', async () => {
    const output = {
      success: false,
      status: 'error',
      assertions: [{ message: 'player should move', passed: false }],
      errors: ['assertion failed'],
      consoleLogs: ['[log] started'],
      finalState: { sceneName: 'Scene' },
      source: 'stepFrames(10); assert(...)',
      screenshots: [{ label: 'failure', frame: 42, jpegBase64: 'QUJD' }],
    };

    const shaped = await shapeByokGameplayTestOutput(output, async dataUrl => {
      expect(dataUrl).toBe('data:image/jpeg;base64,QUJD');
      return registerByokImage({
        dataUrl,
        width: 512,
        height: 512,
      });
    });

    // The base64 payload never reaches the model: only the id reference.
    expect(JSON.stringify(shaped.output)).not.toContain('QUJD');
    expect(shaped.output.screenshots).toEqual([
      { label: 'failure', frame: 42, image: shaped.imageIds[0] },
    ]);
    expect(shaped.imageIds).toHaveLength(1);
    // Everything the model needs to self-correct is kept.
    expect(shaped.output.source).toBe('stepFrames(10); assert(...)');
    expect(shaped.output.assertions).toEqual(output.assertions);
    expect(shaped.output.consoleLogs).toEqual(output.consoleLogs);
    expect(shaped.output.finalState).toEqual(output.finalState);
  });

  it('keeps an output without screenshots as-is', async () => {
    const output = { success: true, status: 'passed', assertions: [] };
    const shaped = await shapeByokGameplayTestOutput(output, async dataUrl => {
      throw new Error('must not be called');
    });
    expect(shaped.output).toEqual(output);
    expect(shaped.imageIds).toEqual([]);
  });
});

describe('makeByokRuntimeTools', () => {
  const makeRuntimeDeps = (overrides: Object = {}) => ({
    getProject: () => null,
    captureSceneCanvas: () => null,
    invokePreviewCapture: async () => ({ ok: false, error: 'no window' }),
    getPreviewLauncher: () => null,
    storeImage: async (dataUrl: string) =>
      registerByokImage({ dataUrl, width: 640, height: 480 }),
    executeSingleToolCall: (jest.fn(): any),
    ...overrides,
  });

  const makeCollaborators = (runtimeDeps: any): ByokExtraToolCollaborators => ({
    getProject: () => null,
    onSceneEventsModifiedOutsideEditor: (jest.fn(): any),
    runtimeDeps,
  });

  const getTool = (name: string) => {
    const tool = makeByokRuntimeTools().find(
      candidate => candidate.name === name
    );
    if (!tool) throw new Error(`tool ${name} not found`);
    return tool;
  };

  it('capture_scene_screenshot fails actionably without a visible canvas', async () => {
    const result = await getTool('capture_scene_screenshot').run(
      {},
      makeCollaborators(makeRuntimeDeps())
    );
    expect(result.output.success).toBe(false);
    expect(result.output.message).toContain('No scene editor canvas');
    expect(result.didModifyProject).toBe(false);
  });

  it('capture_scene_screenshot stores the canvas and references the image id', async () => {
    const result = await getTool('capture_scene_screenshot').run(
      { scene_name: 'Level 1' },
      makeCollaborators(
        makeRuntimeDeps({
          captureSceneCanvas: () => 'data:image/jpeg;base64,QUJD',
        })
      )
    );
    expect(result.output.success).toBe(true);
    const firstImage = result.images && result.images[0];
    if (!firstImage) {
      throw new Error('expected a stored image');
    }
    expect(result.output.image).toBe(firstImage);
    expect(result.output.note).toContain('Level 1');
    expect(result.didModifyProject).toBe(false);
  });

  it('capture_scene_screenshot answers actionably without runtime deps (web build edge)', async () => {
    const result = await getTool('capture_scene_screenshot').run(
      {},
      {
        getProject: () => null,
        onSceneEventsModifiedOutsideEditor: (jest.fn(): any),
      }
    );
    expect(result.output.success).toBe(false);
    expect(result.output.message).toContain('not available');
  });

  it('capture_preview_screenshot surfaces the IPC failure with guidance', async () => {
    const result = await getTool('capture_preview_screenshot').run(
      {},
      makeCollaborators(makeRuntimeDeps())
    );
    expect(result.output.success).toBe(false);
    expect(result.output.message).toContain('start_preview');
  });

  it('capture_preview_screenshot stores the captured PNG as an image', async () => {
    const result = await getTool('capture_preview_screenshot').run(
      {},
      makeCollaborators(
        makeRuntimeDeps({
          invokePreviewCapture: async () => ({ ok: true, data: 'QUJD' }),
        })
      )
    );
    expect(result.output.success).toBe(true);
    expect(result.images).toHaveLength(1);
  });

  it('start_preview and stop_preview delegate to the session', async () => {
    // One registry = one shared preview session (the v1 one-preview rule).
    const tools = makeByokRuntimeTools();
    const toolOf = (name: string) => {
      const tool = tools.find(candidate => candidate.name === name);
      if (!tool) throw new Error(`tool ${name} not found`);
      return tool;
    };
    const runtimeDeps = makeRuntimeDeps({
      getPreviewLauncher: () => ({
        launchPreview: async () => {},
        closePreview: () => {},
        getPreviewDebuggerServer: () => ({
          registerCallbacks: () => () => {},
        }),
      }),
      getProject: () => ({ getFirstLayout: () => 'Scene 1' }),
    });
    const collaborators = makeCollaborators(runtimeDeps);

    const start = await toolOf('start_preview').run({}, collaborators);
    expect(start.output.success).toBe(true);

    const logs = await toolOf('read_preview_logs').run({}, collaborators);
    expect(logs.output.success).toBe(true);

    const stop = await toolOf('stop_preview').run({}, collaborators);
    expect(stop.output.success).toBe(true);
  });

  it('read_preview_logs fails actionably without a running preview', async () => {
    const result = await getTool('read_preview_logs').run(
      {},
      makeCollaborators(makeRuntimeDeps())
    );
    expect(result.output.success).toBe(false);
    expect(result.output.message).toContain('start_preview');
  });

  it('run_gameplay_test shapes the registry result and passes the approval flag through', async () => {
    const executeSingleToolCall = jest.fn(async () => ({
      status: 'finished',
      call_id: 'byok-internal-1',
      success: false,
      didModifyProject: true,
      output: {
        success: false,
        status: 'error',
        source: 'assert(true)',
        screenshots: [{ label: 'failure', frame: 1, jpegBase64: 'QUJD' }],
      },
    }));
    const result = await getTool('run_gameplay_test').run(
      {
        scope: { type: 'project' },
        test_name: 'my test',
        source: 'assert(true)',
      },
      makeCollaborators(makeRuntimeDeps({ executeSingleToolCall }))
    );

    expect(executeSingleToolCall).toHaveBeenCalledWith('run_gameplay_test', {
      scope: { type: 'project' },
      test_name: 'my test',
      source: 'assert(true)',
    });
    expect(result.didModifyProject).toBe(true);
    expect(result.images).toHaveLength(1);
    expect(JSON.stringify(result.output)).not.toContain('QUJD');
    expect(result.output.source).toBe('assert(true)');
  });

  it('run_gameplay_test reports an aborted registry call as a failure', async () => {
    const executeSingleToolCall = jest.fn(async () => ({
      status: 'aborted',
      call_id: 'byok-internal-1',
    }));
    const result = await getTool('run_gameplay_test').run(
      { scope: { type: 'project' }, test_name: 'my test' },
      makeCollaborators(makeRuntimeDeps({ executeSingleToolCall }))
    );
    expect(result.output.success).toBe(false);
    expect(result.output.message).toContain('did not finish');
  });
});
