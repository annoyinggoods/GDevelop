// @flow
import {
  BYOK_MCP_ERROR_INVALID_PARAMS,
  BYOK_MCP_ERROR_INVALID_REQUEST,
  BYOK_MCP_ERROR_METHOD_NOT_FOUND,
  BYOK_MCP_ERROR_PARSE_ERROR,
  BYOK_MCP_PROTOCOL_VERSION,
  handleByokMcpMessage,
  parseByokMcpRawMessage,
} from './ByokMcpProtocol';

/**
 * The handlers are fakes: the protocol core must be testable with no
 * editor, no transport and no host — only this contract.
 */
const makeHandlers = (overrides?: Object) => ({
  listTools: (jest.fn(): any).mockReturnValue([
    { name: 'read_scene_events', description: 'Read events.', inputSchema: {} },
  ]),
  callTool: (jest.fn(): any).mockResolvedValue({
    content: [{ type: 'text', text: '{"success":true}' }],
  }),
  cancel: (jest.fn(): any),
  getAppVersion: (jest.fn(): any).mockReturnValue('5.6.282'),
  ...overrides,
});

describe('parseByokMcpRawMessage', () => {
  it('parses a valid JSON message', () => {
    const parsed = parseByokMcpRawMessage(
      '{"jsonrpc":"2.0","id":1,"method":"ping"}'
    );
    expect(parsed).toEqual({
      ok: true,
      message: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
  });

  it('reports a parse error for invalid JSON', () => {
    const parsed = parseByokMcpRawMessage('{not json');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errorCode).toBe(BYOK_MCP_ERROR_PARSE_ERROR);
    }
  });
});

describe('handleByokMcpMessage — initialize', () => {
  it('echoes a supported protocol version and describes the server', async () => {
    const handlers = makeHandlers();
    const outcome = await handleByokMcpMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: BYOK_MCP_PROTOCOL_VERSION },
      },
      handlers
    );
    expect(outcome.kind).toBe('response');
    if (outcome.kind !== 'response') return;
    expect(outcome.response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: BYOK_MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          prompts: { listChanged: false },
          resources: { listChanged: false },
        },
        serverInfo: {
          name: 'gdevelop',
          title: 'GDevelop',
          version: '5.6.282',
        },
      },
    });
  });

  it('answers with its own version when the client asks for an unknown one', async () => {
    const outcome = await handleByokMcpMessage(
      {
        jsonrpc: '2.0',
        id: 'a',
        method: 'initialize',
        params: { protocolVersion: '1999-01-01' },
      },
      makeHandlers()
    );
    if (outcome.kind !== 'response') return;
    expect(outcome.response.result.protocolVersion).toBe(
      BYOK_MCP_PROTOCOL_VERSION
    );
  });
});

describe('handleByokMcpMessage — tools', () => {
  it('returns the descriptors of the injected listTools', async () => {
    const handlers = makeHandlers();
    const outcome = await handleByokMcpMessage(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      handlers
    );
    if (outcome.kind !== 'response') return;
    expect(outcome.response.result).toEqual({
      tools: handlers.listTools(),
    });
  });

  it('dispatches tools/call with parsed arguments', async () => {
    const handlers = makeHandlers();
    const outcome = await handleByokMcpMessage(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'read_scene_events', arguments: { sceneName: 'Menu' } },
      },
      handlers
    );
    expect(handlers.callTool).toHaveBeenCalledWith(
      { name: 'read_scene_events', args: { sceneName: 'Menu' } },
      3
    );
    if (outcome.kind !== 'response') return;
    expect(outcome.response.result).toEqual({
      content: [{ type: 'text', text: '{"success":true}' }],
    });
  });

  it('accepts arguments serialized as a JSON string', async () => {
    const handlers = makeHandlers();
    await handleByokMcpMessage(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'read_scene_events',
          arguments: '{"sceneName":"Menu"}',
        },
      },
      handlers
    );
    expect(handlers.callTool).toHaveBeenCalledWith(
      { name: 'read_scene_events', args: { sceneName: 'Menu' } },
      4
    );
  });

  it('rejects tools/call without a tool name with -32602', async () => {
    const outcome = await handleByokMcpMessage(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: {} },
      makeHandlers()
    );
    if (outcome.kind !== 'response') return;
    expect(outcome.response.error.code).toBe(BYOK_MCP_ERROR_INVALID_PARAMS);
  });
});

describe('handleByokMcpMessage — ping and notifications', () => {
  it('answers ping with an empty result', async () => {
    const outcome = await handleByokMcpMessage(
      { jsonrpc: '2.0', id: 6, method: 'ping' },
      makeHandlers()
    );
    expect(outcome).toEqual({
      kind: 'response',
      response: { jsonrpc: '2.0', id: 6, result: {} },
    });
  });

  it('accepts notifications/initialized without a response', async () => {
    const outcome = await handleByokMcpMessage(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      makeHandlers()
    );
    expect(outcome).toEqual({ kind: 'notification' });
  });

  it('forwards notifications/cancelled to the cancel handler', async () => {
    const handlers = makeHandlers();
    const outcome = await handleByokMcpMessage(
      {
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 7, reason: 'user' },
      },
      handlers
    );
    expect(outcome).toEqual({ kind: 'notification' });
    expect(handlers.cancel).toHaveBeenCalledWith(7, 'user');
  });

  it('ignores unknown notifications but errors unknown requests', async () => {
    const notificationOutcome = await handleByokMcpMessage(
      { jsonrpc: '2.0', method: 'sampling/createMessage' },
      makeHandlers()
    );
    expect(notificationOutcome).toEqual({ kind: 'notification' });

    const requestOutcome = await handleByokMcpMessage(
      { jsonrpc: '2.0', id: 8, method: 'sampling/createMessage' },
      makeHandlers()
    );
    if (requestOutcome.kind !== 'response') return;
    expect(requestOutcome.response.error.code).toBe(
      BYOK_MCP_ERROR_METHOD_NOT_FOUND
    );
  });
});

describe('handleByokMcpMessage — prompts and resources (Phase 12)', () => {
  const makePromptsResourcesHandlers = () =>
    makeHandlers({
      listPrompts: (jest.fn(): any).mockResolvedValue([
        { name: 'build-workflow', description: 'The build pipeline.' },
      ]),
      getPrompt: (jest.fn(): any).mockImplementation(async (name: string) =>
        name === 'build-workflow'
          ? {
              description: 'The build pipeline.',
              messages: [
                { role: 'user', content: { type: 'text', text: 'Do it.' } },
              ],
            }
          : null
      ),
      listResources: (jest.fn(): any).mockResolvedValue([
        {
          uri: 'gdevelop://project/notes',
          name: 'Project notes',
          mimeType: 'text/plain',
        },
      ]),
      readResource: (jest.fn(): any).mockImplementation(async (uri: string) =>
        uri === 'gdevelop://project/notes'
          ? { uri, mimeType: 'text/plain', text: 'Conventions: …' }
          : null
      ),
    });

  it('serves prompts/list from the handlers', async () => {
    const outcome = await handleByokMcpMessage(
      { jsonrpc: '2.0', id: 21, method: 'prompts/list' },
      makePromptsResourcesHandlers()
    );
    if (outcome.kind !== 'response') return;
    expect(outcome.response.result.prompts).toEqual([
      { name: 'build-workflow', description: 'The build pipeline.' },
    ]);
  });

  it('serves prompts/get with the messages, and -32602 for an unknown name', async () => {
    const handlers = makePromptsResourcesHandlers();
    const found = await handleByokMcpMessage(
      {
        jsonrpc: '2.0',
        id: 22,
        method: 'prompts/get',
        params: { name: 'build-workflow' },
      },
      handlers
    );
    if (found.kind !== 'response') return;
    expect(found.response.result.messages[0].content.text).toBe('Do it.');

    const missing = await handleByokMcpMessage(
      {
        jsonrpc: '2.0',
        id: 23,
        method: 'prompts/get',
        params: { name: 'nope' },
      },
      handlers
    );
    if (missing.kind !== 'response') return;
    expect(missing.response.error.code).toBe(BYOK_MCP_ERROR_INVALID_PARAMS);
  });

  it('rejects prompts/get without a name string', async () => {
    const outcome = await handleByokMcpMessage(
      { jsonrpc: '2.0', id: 24, method: 'prompts/get', params: {} },
      makePromptsResourcesHandlers()
    );
    if (outcome.kind !== 'response') return;
    expect(outcome.response.error.code).toBe(BYOK_MCP_ERROR_INVALID_PARAMS);
  });

  it('serves resources/list and resources/read, and -32602 for unknown uris', async () => {
    const handlers = makePromptsResourcesHandlers();
    const list = await handleByokMcpMessage(
      { jsonrpc: '2.0', id: 25, method: 'resources/list' },
      handlers
    );
    if (list.kind !== 'response') return;
    expect(list.response.result.resources).toHaveLength(1);

    const read = await handleByokMcpMessage(
      {
        jsonrpc: '2.0',
        id: 26,
        method: 'resources/read',
        params: { uri: 'gdevelop://project/notes' },
      },
      handlers
    );
    if (read.kind !== 'response') return;
    expect(read.response.result.contents[0].text).toBe('Conventions: …');

    const unknown = await handleByokMcpMessage(
      {
        jsonrpc: '2.0',
        id: 27,
        method: 'resources/read',
        params: { uri: 'gdevelop://nope' },
      },
      handlers
    );
    if (unknown.kind !== 'response') return;
    expect(unknown.response.error.code).toBe(BYOK_MCP_ERROR_INVALID_PARAMS);
  });

  it('answers empty lists and -32602 when the host provides no handlers', async () => {
    const handlers = makeHandlers();
    const list = await handleByokMcpMessage(
      { jsonrpc: '2.0', id: 28, method: 'prompts/list' },
      handlers
    );
    if (list.kind !== 'response') return;
    expect(list.response.result.prompts).toEqual([]);

    const get = await handleByokMcpMessage(
      { jsonrpc: '2.0', id: 29, method: 'prompts/get', params: { name: 'x' } },
      handlers
    );
    if (get.kind !== 'response') return;
    expect(get.response.error.code).toBe(BYOK_MCP_ERROR_INVALID_PARAMS);
  });
});

describe('handleByokMcpMessage — malformed input', () => {
  it('rejects a non-object message with -32600', async () => {
    const outcome = await handleByokMcpMessage([1, 2], makeHandlers());
    if (outcome.kind !== 'response') return;
    expect(outcome.response.error.code).toBe(BYOK_MCP_ERROR_INVALID_REQUEST);
  });

  it('rejects a message without a method, but only when it has an id', async () => {
    const withId = await handleByokMcpMessage(
      { jsonrpc: '2.0', id: 9 },
      makeHandlers()
    );
    if (withId.kind !== 'response') return;
    expect(withId.response.error.code).toBe(BYOK_MCP_ERROR_INVALID_REQUEST);

    const withoutId = await handleByokMcpMessage(
      { jsonrpc: '2.0' },
      makeHandlers()
    );
    expect(withoutId).toEqual({ kind: 'notification' });
  });
});

describe('handleByokMcpMessage: unknown tool names (audit100226 MCP-6)', () => {
  const callToolMessage = (name: string) => ({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name, arguments: {} },
  });

  it('answers an unknown tool with -32602, not a successful isError result', async () => {
    // Every other unknown (method, prompt, resource) already answered a
    // protocol error; the tool name was the outlier, and a client could not
    // tell a failed call from a successful one holding an error payload.
    const callTool: any = jest.fn();
    callTool.mockResolvedValue({ content: [] });
    const handlers = makeHandlers({
      callTool,
      hasTool: (name: string) => name === 'read_scene_events',
    });

    const outcome = await handleByokMcpMessage(
      callToolMessage('no_such_tool'),
      handlers
    );

    if (outcome.kind !== 'response') throw new Error('expected a response');
    expect(outcome.response.result).toBeUndefined();
    expect(outcome.response.error.code).toBe(BYOK_MCP_ERROR_INVALID_PARAMS);
    expect(outcome.response.error.message).toContain('no_such_tool');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('still calls a tool the host knows', async () => {
    const handlers = makeHandlers({
      hasTool: (name: string) => name === 'read_scene_events',
    });

    const outcome = await handleByokMcpMessage(
      callToolMessage('read_scene_events'),
      handlers
    );

    if (outcome.kind !== 'response') throw new Error('expected a response');
    expect(outcome.response.error).toBeUndefined();
    expect(outcome.response.result.content).toHaveLength(1);
    expect(handlers.callTool).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous behavior when the host cannot tell', async () => {
    // hasTool is optional (older hosts): without it, an unknown name keeps
    // reaching the tool layer, which answers an isError result.
    const handlers = makeHandlers();

    const outcome = await handleByokMcpMessage(
      callToolMessage('whatever'),
      handlers
    );

    if (outcome.kind !== 'response') throw new Error('expected a response');
    expect(handlers.callTool).toHaveBeenCalledTimes(1);
  });
});
