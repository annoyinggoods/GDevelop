// @flow

/**
 * The MCP protocol core (Phase 10): JSON-RPC 2.0 framing plus the MCP
 * method table, pure and dependency-free. Everything editor-specific
 * arrives injected through `ByokMcpToolHandlers`, so the whole surface is
 * unit-testable with fakes and the transport (loopback HTTP ⇄ stdio
 * adapter) never leaks in.
 *
 * Spec revision pinned: 2026-07-28 (stateless-first). A future revision is
 * a one-line addition to `BYOK_MCP_SUPPORTED_PROTOCOL_VERSIONS`.
 */

export const BYOK_MCP_PROTOCOL_VERSION: string = '2026-07-28';

export const BYOK_MCP_SUPPORTED_PROTOCOL_VERSIONS: Array<string> = [
  '2026-07-28',
];

export const BYOK_MCP_SERVER_NAME: string = 'gdevelop';
export const BYOK_MCP_SERVER_TITLE: string = 'GDevelop';

/** Standard JSON-RPC 2.0 error codes. */
export const BYOK_MCP_ERROR_PARSE_ERROR: number = -32700;
export const BYOK_MCP_ERROR_INVALID_REQUEST: number = -32600;
export const BYOK_MCP_ERROR_METHOD_NOT_FOUND: number = -32601;
export const BYOK_MCP_ERROR_INVALID_PARAMS: number = -32602;

/** Server-defined errors (the -32000…-32099 range). */
export const BYOK_MCP_ERROR_TIMEOUT: number = -32000;
export const BYOK_MCP_ERROR_NO_TOOL_HOST: number = -32001;
export const BYOK_MCP_ERROR_ENDPOINT_UNREACHABLE: number = -32002;

export const NO_TOOL_HOST_MESSAGE: string =
  'No GDevelop tool host is available — open the Ask AI panel in the project window, then retry.';

/**
 * One MCP tool descriptor as `tools/list` returns it. `inputSchema` is the
 * very JSON Schema object the BYOK tool schemas already carry (their
 * `parameters`), passed through verbatim.
 */
export type ByokMcpToolDescriptor = {|
  name: string,
  description: string,
  inputSchema: Object,
|};

export type ByokMcpContentPart =
  | {| type: 'text', text: string |}
  | {| type: 'image', data: string, mimeType: string |};

/** The `tools/call` result shape of the spec (business errors included). */
export type ByokMcpCallToolResult = {|
  content: Array<ByokMcpContentPart>,
  isError?: boolean,
|};

/** Structural slices of the prompts/resources results (no module cycle). */
export type ByokMcpPromptDescriptorLike = {|
  name: string,
  description: string,
|};
export type ByokMcpGetPromptResultLike = Object;
export type ByokMcpResourceDescriptorLike = Object;
export type ByokMcpResourceContentsLike = {|
  uri: string,
  mimeType: string,
  text: string,
|};

export type ByokMcpToolHandlers = {|
  listTools: () => Array<ByokMcpToolDescriptor>,
  callTool: (
    params: {|
      name: string,
      args: Object,
    |},
    requestId: string | number
  ) => Promise<ByokMcpCallToolResult>,
  cancel: (requestId: string | number, reason: string) => void,
  getAppVersion: () => string,
  // Whether the host knows a tool name. Optional: without it an unknown
  // tool keeps answering a successful response carrying an isError result,
  // while the MCP specification asks for a -32602 protocol error for an
  // unknown tool — the same treatment this module already gives unknown
  // methods, prompts and resources (audit100226 MCP-6).
  +hasTool?: (name: string) => boolean,
  // The prompts/resources primitives (Phase 12, D12-6). Optional so older
  // hosts keep working: the methods then answer with empty lists / -32602.
  +listPrompts?: () =>
    | Array<ByokMcpPromptDescriptorLike>
    | Promise<Array<ByokMcpPromptDescriptorLike>>,
  +getPrompt?: (
    name: string
  ) =>
    | Promise<ByokMcpGetPromptResultLike | null>
    | ByokMcpGetPromptResultLike
    | null,
  +listResources?: () =>
    | Array<ByokMcpResourceDescriptorLike>
    | Promise<Array<ByokMcpResourceDescriptorLike>>,
  +readResource?: (
    uri: string
  ) =>
    | Promise<ByokMcpResourceContentsLike | null>
    | ByokMcpResourceContentsLike
    | null,
|};

export type ByokMcpMessageOutcome =
  | {| kind: 'response', response: Object |}
  | {| kind: 'notification' |};

export type ByokMcpRawParseResult =
  | {| ok: true, message: any |}
  | {| ok: false, errorCode: number, errorMessage: string |};

const isPlainObject = (value: any): boolean =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Parse one raw protocol message (the transport reads strings; this is the
 * only place JSON.parse failures become the -32700 code).
 */
export const parseByokMcpRawMessage = (raw: string): ByokMcpRawParseResult => {
  try {
    return { ok: true, message: JSON.parse(raw) };
  } catch (error) {
    return {
      ok: false,
      errorCode: BYOK_MCP_ERROR_PARSE_ERROR,
      errorMessage: 'Parse error.',
    };
  }
};

const makeResponse = (id: any, body: Object): ByokMcpMessageOutcome => ({
  kind: 'response',
  response: { jsonrpc: '2.0', id, ...body },
});

const makeResultResponse = (id: any, result: any): ByokMcpMessageOutcome =>
  makeResponse(id, { result });

const makeErrorResponse = (
  id: any,
  code: number,
  message: string
): ByokMcpMessageOutcome => makeResponse(id, { error: { code, message } });

/**
 * Handle one parsed MCP message. Requests (with an id) always produce a
 * response — success or JSON-RPC error; notifications produce no response
 * (the transport answers 202). Tool failures are results with `isError`,
 * not JSON-RPC errors: only malformed requests are protocol errors.
 */
export const handleByokMcpMessage = async (
  message: any,
  handlers: ByokMcpToolHandlers
): Promise<ByokMcpMessageOutcome> => {
  if (!isPlainObject(message)) {
    return makeErrorResponse(
      null,
      BYOK_MCP_ERROR_INVALID_REQUEST,
      'Invalid Request.'
    );
  }

  const { id, method, params } = message;
  const isNotification = id === null || id === undefined;

  if (typeof method !== 'string') {
    if (isNotification) return { kind: 'notification' };
    return makeErrorResponse(
      id,
      BYOK_MCP_ERROR_INVALID_REQUEST,
      'Invalid Request.'
    );
  }

  switch (method) {
    case 'initialize': {
      if (isNotification) return { kind: 'notification' };
      return makeResultResponse(id, makeInitializeResult(params, handlers));
    }
    case 'notifications/initialized': {
      return { kind: 'notification' };
    }
    case 'notifications/cancelled': {
      const requestId = isPlainObject(params) ? params.requestId : null;
      if (requestId !== null && requestId !== undefined) {
        const reason =
          isPlainObject(params) && typeof params.reason === 'string'
            ? params.reason
            : '';
        handlers.cancel(requestId, reason);
      }
      return { kind: 'notification' };
    }
    case 'ping': {
      if (isNotification) return { kind: 'notification' };
      return makeResultResponse(id, {});
    }
    case 'tools/list': {
      if (isNotification) return { kind: 'notification' };
      return makeResultResponse(id, { tools: handlers.listTools() });
    }
    case 'tools/call': {
      if (isNotification) return { kind: 'notification' };
      const toolParams = readToolCallParams(params);
      if (!toolParams) {
        return makeErrorResponse(
          id,
          BYOK_MCP_ERROR_INVALID_PARAMS,
          'tools/call requires a "name" string; "arguments", when present, must be an object.'
        );
      }
      if (handlers.hasTool && !handlers.hasTool(toolParams.name)) {
        return makeErrorResponse(
          id,
          BYOK_MCP_ERROR_INVALID_PARAMS,
          `Unknown tool: ${toolParams.name}`
        );
      }
      const result = await handlers.callTool(toolParams, id);
      return makeResultResponse(id, result);
    }
    case 'prompts/list': {
      if (isNotification) return { kind: 'notification' };
      const prompts = handlers.listPrompts ? await handlers.listPrompts() : [];
      return makeResultResponse(id, { prompts });
    }
    case 'prompts/get': {
      if (isNotification) return { kind: 'notification' };
      if (!isPlainObject(params) || typeof params.name !== 'string') {
        return makeErrorResponse(
          id,
          BYOK_MCP_ERROR_INVALID_PARAMS,
          'prompts/get requires a "name" string.'
        );
      }
      const prompt = handlers.getPrompt
        ? await handlers.getPrompt(params.name)
        : null;
      if (!prompt) {
        return makeErrorResponse(
          id,
          BYOK_MCP_ERROR_INVALID_PARAMS,
          `Unknown prompt: ${params.name}`
        );
      }
      return makeResultResponse(id, prompt);
    }
    case 'resources/list': {
      if (isNotification) return { kind: 'notification' };
      const resources = handlers.listResources
        ? await handlers.listResources()
        : [];
      return makeResultResponse(id, { resources });
    }
    case 'resources/read': {
      if (isNotification) return { kind: 'notification' };
      if (!isPlainObject(params) || typeof params.uri !== 'string') {
        return makeErrorResponse(
          id,
          BYOK_MCP_ERROR_INVALID_PARAMS,
          'resources/read requires a "uri" string.'
        );
      }
      const contents = handlers.readResource
        ? await handlers.readResource(params.uri)
        : null;
      if (!contents) {
        return makeErrorResponse(
          id,
          BYOK_MCP_ERROR_INVALID_PARAMS,
          `Unknown resource: ${params.uri}`
        );
      }
      return makeResultResponse(id, { contents: [contents] });
    }
    default: {
      if (isNotification) return { kind: 'notification' };
      return makeErrorResponse(
        id,
        BYOK_MCP_ERROR_METHOD_NOT_FOUND,
        `Method not found: ${method}`
      );
    }
  }
};

const makeInitializeResult = (params: any, handlers: ByokMcpToolHandlers) => {
  const requestedVersion =
    isPlainObject(params) && typeof params.protocolVersion === 'string'
      ? params.protocolVersion
      : null;
  const negotiatedVersion =
    requestedVersion &&
    BYOK_MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
      ? requestedVersion
      : BYOK_MCP_PROTOCOL_VERSION;
  return {
    protocolVersion: negotiatedVersion,
    capabilities: {
      tools: { listChanged: false },
      prompts: { listChanged: false },
      resources: { listChanged: false },
    },
    serverInfo: {
      name: BYOK_MCP_SERVER_NAME,
      title: BYOK_MCP_SERVER_TITLE,
      version: handlers.getAppVersion(),
    },
  };
};

/**
 * Read `tools/call` params: `{ name, arguments }` with `arguments` an
 * object per the spec — but be liberal and accept the JSON string shape the
 * chat loop uses, since some clients serialize it that way.
 */
const readToolCallParams = (params: any): ?{| name: string, args: Object |} => {
  if (!isPlainObject(params) || typeof params.name !== 'string') return null;
  if (params.arguments === undefined || params.arguments === null) {
    return { name: params.name, args: {} };
  }
  if (isPlainObject(params.arguments)) {
    return { name: params.name, args: params.arguments };
  }
  if (typeof params.arguments === 'string') {
    try {
      const parsed = JSON.parse(params.arguments);
      if (isPlainObject(parsed)) return { name: params.name, args: parsed };
    } catch (error) {
      return null;
    }
  }
  return null;
};
