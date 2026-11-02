// Note: this file intentionally does NOT use import/export or Flow
// annotations, so the GDevelop MCP stdio adapter
// (newIDE/app/scripts/gdevelop-mcp-stdio.js) can require it under plain
// Node.js — the same rule OptionalRequire.js follows. Keep it
// dependency-free (Node built-ins only) and CommonJS.

/**
 * The pure logic of the GDevelop MCP stdio adapter (Phase 10): CLI
 * parsing, the discovery-file contract, endpoint resolution (flags win
 * over the discovery file), and the stdout-purity rules. The script owns
 * every side effect (fs, fetch, stdin/stdout); everything decidable here
 * is tested in ByokMcpStdioAdapterCore.spec.js.
 */

const path = require('path');

const DISCOVERY_FILE_NAME = 'gdevelop-mcp-endpoint.json';
const DEFAULT_PROTOCOL_VERSION = '2026-07-28';
const ENDPOINT_ERROR_CODE = -32002;
const ENDPOINT_ERROR_MESSAGE =
  'The GDevelop MCP endpoint is unreachable — is GDevelop running with the MCP server enabled?';
const PARSE_ERROR_CODE = -32700;

// Electron's userData folder follows the app's productName, "GDevelop 5"
// (with the space) — not the npm package name "gdevelop". Getting this
// wrong silently disables the discovery-file wiring for every client.
const APP_DATA_FOLDER_NAME = 'GDevelop 5';

const resolveDefaultDiscoveryPath = (platform, homeDir) => {
  if (platform === 'win32') {
    return path.join(
      homeDir,
      'AppData',
      'Roaming',
      APP_DATA_FOLDER_NAME,
      DISCOVERY_FILE_NAME
    );
  }
  if (platform === 'darwin') {
    return path.join(
      homeDir,
      'Library',
      'Application Support',
      APP_DATA_FOLDER_NAME,
      DISCOVERY_FILE_NAME
    );
  }
  return path.join(
    homeDir,
    '.config',
    APP_DATA_FOLDER_NAME,
    DISCOVERY_FILE_NAME
  );
};

const parseCliArgs = argv => {
  const args = { help: false, url: null, port: null, token: null, file: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const hasValue = index + 1 < argv.length;
    if (argument === '--help' || argument === '-h') {
      args.help = true;
    } else if (argument === '--url' && hasValue) {
      index += 1;
      args.url = argv[index];
    } else if (argument === '--port' && hasValue) {
      index += 1;
      args.port = Number(argv[index]);
    } else if (argument === '--token' && hasValue) {
      index += 1;
      args.token = argv[index];
    } else if (argument === '--file' && hasValue) {
      index += 1;
      args.file = argv[index];
    }
    // Unknown flags are ignored: clients may pass extra ones any time.
  }
  return args;
};

/**
 * The endpoint a discovery file describes ({ port, token, … }), or null
 * when the text is missing or does not carry a usable port/token. The
 * protocol version is reported but not enforced (the IDE may move to a
 * newer revision before the adapter is updated).
 */
const parseDiscoveryFileText = fileText => {
  if (typeof fileText !== 'string') return null;
  try {
    const discovery = JSON.parse(fileText);
    if (typeof discovery.port !== 'number') return null;
    if (discovery.port <= 0 || discovery.port > 65535) return null;
    if (typeof discovery.token !== 'string' || !discovery.token) return null;
    return {
      port: discovery.port,
      token: discovery.token,
      protocolVersion:
        typeof discovery.protocolVersion === 'string'
          ? discovery.protocolVersion
          : null,
    };
  } catch (error) {
    return null;
  }
};

const buildEndpointUrl = port => `http://127.0.0.1:${port}/mcp`;

const buildFlagUrl = cliArgs => {
  if (cliArgs.url) return cliArgs.url;
  if (cliArgs.port) return buildEndpointUrl(cliArgs.port);
  return null;
};

/**
 * The endpoint to use: flags first, the discovery file for whatever they
 * leave out. `discoveryReader` returns the file text (or null); it is only
 * consulted for what the flags do not provide.
 */
const resolveEndpoint = (cliArgs, discoveryReader) => {
  const flagUrl = buildFlagUrl(cliArgs);
  if (flagUrl && cliArgs.token) {
    return { url: flagUrl, token: cliArgs.token };
  }
  const discoveryText = discoveryReader ? discoveryReader() : null;
  const discovery = parseDiscoveryFileText(discoveryText);
  const url = flagUrl || (discovery ? buildEndpointUrl(discovery.port) : null);
  const token = cliArgs.token || (discovery ? discovery.token : null);
  if (!url || !token) return null;
  return { url, token };
};

const buildErrorResponseText = (id, code, message) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id: id === undefined || id === null ? null : id,
    error: { code, message },
  });

/**
 * stdout purity: a response body is printed only when it is non-empty (the
 * 202 answer to a notification) AND the request carried an id (never print
 * anything for a notification).
 */
const shouldRelayResponseBody = (parsedMessage, responseBody) => {
  if (!responseBody) return false;
  if (!parsedMessage) return false;
  if (parsedMessage.id === null || parsedMessage.id === undefined) return false;
  return true;
};

/**
 * The error text to print when the server answered ≥400 with no relayable
 * body (an empty 403/413, or a batch array the server rejects — its error
 * body has no top-level id, so shouldRelayResponseBody skips it). Without
 * this the client hung forever on its request (audit011026 B-MCP-11).
 *
 * A LEGACY client sends a JSON-RPC batch (an array of requests). The server
 * answers 400 with a single error object carrying `id: null`, and the array
 * itself has no `id` — so nothing was ever written to stdout and the client
 * waited forever for the ids it had put inside the array. Answering for the
 * first id-bearing member is enough to unblock it (audit100226 MCP-9).
 * Notifications still get silence: there is nothing to wait for.
 */
const buildHttpFailureText = (parsedMessage, statusCode) => {
  const requestsInBatch = Array.isArray(parsedMessage) ? parsedMessage : null;
  const requestToAnswer = requestsInBatch
    ? requestsInBatch.find(
        candidate =>
          candidate &&
          typeof candidate === 'object' &&
          candidate.id !== null &&
          candidate.id !== undefined
      )
    : parsedMessage;
  const carriesId =
    requestToAnswer &&
    typeof requestToAnswer === 'object' &&
    requestToAnswer.id !== null &&
    requestToAnswer.id !== undefined;
  if (!carriesId) return null;
  return buildErrorResponseText(
    requestToAnswer.id,
    ENDPOINT_ERROR_CODE,
    `The GDevelop MCP endpoint answered HTTP ${statusCode} for the request.`
  );
};

module.exports = {
  DISCOVERY_FILE_NAME,
  DEFAULT_PROTOCOL_VERSION,
  ENDPOINT_ERROR_CODE,
  ENDPOINT_ERROR_MESSAGE,
  PARSE_ERROR_CODE,
  resolveDefaultDiscoveryPath,
  parseCliArgs,
  parseDiscoveryFileText,
  buildEndpointUrl,
  buildFlagUrl,
  resolveEndpoint,
  buildErrorResponseText,
  shouldRelayResponseBody,
  buildHttpFailureText,
};
