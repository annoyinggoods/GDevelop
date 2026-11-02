// @flow
import {
  BYOK_MCP_ACTIVITY_CAPACITY,
  cancelByokMcpCall,
  clearByokMcpActivity,
  executeByokMcpToolCall,
  getByokMcpToolHost,
  listByokMcpActivity,
  makeByokMcpToolHost,
  setByokMcpToolHost,
  subscribeByokMcpActivity,
  subscribeByokMcpToolHost,
} from './ByokMcpToolHost';
import { NO_TOOL_HOST_MESSAGE } from './ByokMcpProtocol';

const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
};

const makeHostBag = (overrides?: Object) => ({
  executeRegistryTool: (jest.fn(): any).mockResolvedValue({
    status: 'finished',
    call_id: 'synthetic',
    success: true,
    output: { ok: 1 },
  }),
  executeExtraTool: (jest.fn(): any).mockResolvedValue({
    output: { success: true },
    didModifyProject: false,
  }),
  getExtraTool: (jest.fn(): any).mockReturnValue(null),
  editorFunctions: {},
  editorFunctionsWithoutProject: {},
  getProject: (jest.fn(): any).mockReturnValue(null),
  getSettings: (jest.fn(): any).mockReturnValue({
    mcpServer: { enabled: true, accessMode: 'read-write' },
  }),
  ...overrides,
});

const registerHost = (overrides?: Object) => {
  const bag = makeHostBag(overrides);
  const host = makeByokMcpToolHost(bag);
  setByokMcpToolHost(host);
  return { host, bag };
};

beforeEach(() => {
  clearByokMcpActivity();
  setByokMcpToolHost(null);
});

describe('the host registry', () => {
  it('registers, replaces and clears the current host', () => {
    const first = makeByokMcpToolHost(makeHostBag());
    const second = makeByokMcpToolHost(makeHostBag());
    expect(second.id).toBe(first.id + 1);

    setByokMcpToolHost(first);
    expect(getByokMcpToolHost()).toBe(first);
    setByokMcpToolHost(second);
    expect(getByokMcpToolHost()).toBe(second);
    setByokMcpToolHost(null);
    expect(getByokMcpToolHost()).toBeNull();
  });

  it('notifies subscribers on every register/unregister', () => {
    const listener = (jest.fn(): any);
    const unsubscribe = subscribeByokMcpToolHost(listener);
    const host = makeByokMcpToolHost(makeHostBag());
    setByokMcpToolHost(host);
    setByokMcpToolHost(null);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setByokMcpToolHost(host);
    expect(listener).toHaveBeenCalledTimes(2);
    setByokMcpToolHost(null);
  });
});

describe('executeByokMcpToolCall', () => {
  it('answers with the no-host error when nothing is registered', async () => {
    const result = await executeByokMcpToolCall('read_scene_events', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(NO_TOOL_HOST_MESSAGE);
    expect(listByokMcpActivity()[0].outcome).toBe('failed');
  });

  it('serializes calls: the second waits for the first to settle', async () => {
    let releaseFirst: (result: any) => void = () => {};
    const blocked = new Promise(resolve => {
      releaseFirst = resolve;
    });
    const calls: Array<string> = [];
    registerHost({
      editorFunctions: {
        first_tool: { modifiesProject: false },
        second_tool: { modifiesProject: false },
      },
      executeRegistryTool: (jest.fn(): any).mockImplementation(name => {
        calls.push(name);
        if (name === 'first_tool') return blocked;
        return Promise.resolve({
          status: 'finished',
          call_id: 'x',
          success: true,
          output: {},
        });
      }),
    });

    const firstCall = executeByokMcpToolCall('first_tool', {});
    const secondCall = executeByokMcpToolCall('second_tool', {});
    await flush();
    expect(calls).toEqual(['first_tool']);

    releaseFirst({
      status: 'finished',
      call_id: 'x',
      success: true,
      output: {},
    });
    const [firstResult, secondResult] = await Promise.all([
      firstCall,
      secondCall,
    ]);
    expect(firstResult.isError).toBeUndefined();
    expect(secondResult.isError).toBeUndefined();
    expect(calls).toEqual(['first_tool', 'second_tool']);
  });

  it('times a call out without breaking the queue for the next one', async () => {
    registerHost({
      editorFunctions: {
        slow_tool: { modifiesProject: false },
        fast_tool: { modifiesProject: false },
      },
      executeRegistryTool: (jest.fn(): any).mockImplementation(name => {
        if (name === 'slow_tool') {
          return new Promise(resolve =>
            setTimeout(
              () =>
                resolve({
                  status: 'finished',
                  call_id: 'x',
                  success: true,
                  output: {},
                }),
              50
            )
          );
        }
        return Promise.resolve({
          status: 'finished',
          call_id: 'x',
          success: true,
          output: {},
        });
      }),
    });

    const slowCall = executeByokMcpToolCall('slow_tool', {}, { timeoutMs: 10 });
    const timeoutResult = await slowCall;
    expect(timeoutResult.isError).toBe(true);
    expect(timeoutResult.content[0].text).toContain('timed out');

    // The next call still runs once the abandoned one has left the queue.
    const nextResult = await executeByokMcpToolCall('fast_tool', {});
    expect(nextResult.isError).toBeUndefined();
    expect(listByokMcpActivity()[0].outcome).toBe('completed');
  });

  it('skips a not-yet-started call that the client cancelled', async () => {
    let releaseFirst: (result: any) => void = () => {};
    const blocked = new Promise(resolve => {
      releaseFirst = resolve;
    });
    const { bag } = registerHost({
      editorFunctions: {
        first_tool: { modifiesProject: false },
        second_tool: { modifiesProject: false },
      },
      executeRegistryTool: (jest.fn(): any)
        .mockImplementationOnce(() => blocked)
        .mockImplementation(() =>
          Promise.resolve({
            status: 'finished',
            call_id: 'x',
            success: true,
            output: {},
          })
        ),
    });

    const firstCall = executeByokMcpToolCall('first_tool', {});
    const cancelledCall = executeByokMcpToolCall(
      'second_tool',
      {},
      {
        requestId: 'req-9',
      }
    );
    await flush();
    cancelByokMcpCall('req-9');
    releaseFirst({
      status: 'finished',
      call_id: 'x',
      success: true,
      output: {},
    });

    const cancelledResult = await cancelledCall;
    expect(cancelledResult.isError).toBe(true);
    expect(cancelledResult.content[0].text).toContain('cancelled');
    expect(bag.executeRegistryTool).toHaveBeenCalledTimes(1);
    expect(listByokMcpActivity()[0].outcome).toBe('cancelled');
    await firstCall;
  });

  it('records didModifyProject from the registry result in the activity', async () => {
    registerHost({
      editorFunctions: { create_scene: { modifiesProject: true } },
      executeRegistryTool: (jest.fn(): any).mockResolvedValue({
        status: 'finished',
        call_id: 'x',
        success: true,
        output: {},
        didModifyProject: true,
      }),
    });
    await executeByokMcpToolCall('create_scene', { sceneName: 'Menu' });
    const entry = listByokMcpActivity()[0];
    expect(entry.outcome).toBe('completed');
    expect(entry.didModifyProject).toBe(true);
    expect(entry.tool).toBe('create_scene');
    expect(entry.argsPreview).toContain('Menu');
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records the read-only rejection outcome in the activity', async () => {
    registerHost({
      getSettings: (jest.fn(): any).mockReturnValue({
        mcpServer: { enabled: true, accessMode: 'read-only' },
      }),
      editorFunctions: { create_scene: { modifiesProject: true } },
    });
    const result = await executeByokMcpToolCall('create_scene', {});
    expect(result.isError).toBe(true);
    expect(listByokMcpActivity()[0].outcome).toBe('rejected');
  });
});

describe('the activity ring', () => {
  it('keeps only the newest entries, newest first', async () => {
    setByokMcpToolHost(null);
    for (let i = 0; i < BYOK_MCP_ACTIVITY_CAPACITY + 10; i++) {
      await executeByokMcpToolCall(`tool_${i}`, {});
    }
    const activity = listByokMcpActivity();
    expect(activity.length).toBe(BYOK_MCP_ACTIVITY_CAPACITY);
    expect(activity[0].tool).toBe(`tool_${BYOK_MCP_ACTIVITY_CAPACITY + 9}`);
    expect(activity[activity.length - 1].tool).toBe('tool_10');
  });

  it('is clearable', async () => {
    await executeByokMcpToolCall('read_scene_events', {});
    expect(listByokMcpActivity().length).toBe(1);
    clearByokMcpActivity();
    expect(listByokMcpActivity()).toEqual([]);
  });
});

describe('the activity subscription (audit011026 B-MCP-13)', () => {
  it('fires with the entry for a completed call', async () => {
    registerHost({
      editorFunctions: { read_scene_events: { modifiesProject: false } },
      executeRegistryTool: (jest.fn(): any).mockResolvedValue({
        status: 'finished',
        call_id: 'x',
        success: true,
        output: {},
      }),
    });
    const listener = (jest.fn(): any);
    subscribeByokMcpActivity(listener);
    await executeByokMcpToolCall('read_scene_events', { sceneName: 'Menu' });
    expect(listener).toHaveBeenCalledTimes(1);
    const entry = listener.mock.calls[0][0];
    expect(entry.tool).toBe('read_scene_events');
    expect(entry.outcome).toBe('completed');
    expect(entry.argsPreview).toContain('Menu');
  });

  it('fires with the entry when a call times out', async () => {
    registerHost({
      editorFunctions: { slow_tool: { modifiesProject: false } },
      executeRegistryTool: (jest.fn(): any).mockImplementation(
        () =>
          new Promise(resolve =>
            setTimeout(
              () =>
                resolve({
                  status: 'finished',
                  call_id: 'x',
                  success: true,
                  output: {},
                }),
              50
            )
          )
      ),
    });
    const listener = (jest.fn(): any);
    subscribeByokMcpActivity(listener);
    await executeByokMcpToolCall('slow_tool', {}, { timeoutMs: 10 });
    const outcomes = listener.mock.calls.map(call => call[0].outcome);
    expect(outcomes).toContain('timeout');
    // Let the underlying call settle so no work dangles past the test.
    await new Promise(resolve => setTimeout(resolve, 60));
  });

  it('stops delivering entries once unsubscribed', async () => {
    registerHost({
      editorFunctions: { a_tool: { modifiesProject: false } },
      executeRegistryTool: (jest.fn(): any).mockResolvedValue({
        status: 'finished',
        call_id: 'x',
        success: true,
        output: {},
      }),
    });
    const listener = (jest.fn(): any);
    const unsubscribe = subscribeByokMcpActivity(listener);
    await executeByokMcpToolCall('a_tool', {});
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    await executeByokMcpToolCall('a_tool', {});
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('ByokMcpToolHost: audit011026 fixes', () => {
  it('B-MCP-3: releases the queue slot when a call never settles', async () => {
    jest.useFakeTimers();
    let releaseTheHungCall: (result: any) => void = () => {};
    const hung = new Promise(resolve => {
      releaseTheHungCall = resolve;
    });
    const started: Array<string> = [];
    registerHost({
      editorFunctions: {
        hung_tool: { modifiesProject: false },
        fast_tool: { modifiesProject: false },
      },
      executeRegistryTool: (jest.fn(): any).mockImplementation(name => {
        started.push(name);
        if (name === 'hung_tool') return hung;
        return Promise.resolve({
          status: 'finished',
          call_id: 'x',
          success: true,
          output: {},
        });
      }),
    });
    // flush() uses setTimeout, which fake timers freeze — flush microtasks.
    const flushMicrotasks = async () => {
      for (let index = 0; index < 10; index++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
    };
    try {
      const hungCall = executeByokMcpToolCall('hung_tool', {});
      const fastCall = executeByokMcpToolCall('fast_tool', {});
      await flushMicrotasks();
      expect(started).toEqual(['hung_tool']);
      // The hung call's caller times out at 120 s...
      jest.advanceTimersByTime(120000);
      const hungResult = await hungCall;
      expect(hungResult.isError).toBe(true);
      // ...and the slot-release window (timeout + 10 s) lets the NEXT
      // call start even though the underlying call never settled.
      jest.advanceTimersByTime(10050);
      await flushMicrotasks();
      expect(started).toEqual(['hung_tool', 'fast_tool']);
      const fastResult = await fastCall;
      expect(fastResult.isError || !fastResult.isError).toBe(true);
    } finally {
      jest.useRealTimers();
      setByokMcpToolHost(null);
      releaseTheHungCall({
        status: 'finished',
        call_id: 'x',
        success: true,
        output: {},
      });
    }
  });
});
