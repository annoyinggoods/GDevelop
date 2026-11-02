// @flow
import * as React from 'react';
import optionalRequire from '../../../Utils/OptionalRequire';
import PreferencesContext from '../../../MainFrame/Preferences/PreferencesContext';
import { getIDEVersion } from '../../../Version';
import { getByokSettings } from '../ByokTypes';
import {
  handleByokMcpMessage,
  parseByokMcpRawMessage,
  type ByokMcpToolHandlers,
} from './ByokMcpProtocol';
import { hasByokMcpTool, makeByokMcpToolDescriptors } from './ByokMcpTools';
import { getByokMcpPrompt, listByokMcpPrompts } from './ByokMcpPrompts';
import {
  makeByokMcpResourceDescriptors,
  readByokMcpResource,
} from './ByokMcpResources';
import {
  cancelByokMcpCall,
  executeByokMcpToolCall,
  getByokMcpToolHost,
  subscribeByokMcpActivity,
  subscribeByokMcpToolHost,
} from './ByokMcpToolHost';

/**
 * The renderer half of the GDevelop MCP transport (Phase 10): mounted once
 * per window in `MainFrame`, it forwards the MCP messages the main process
 * receives into the protocol core and the tool host, answers them, pushes
 * the enabled state down to main, and announces whether this window can
 * execute tool calls. In the web build (no Electron) everything is inert.
 *
 * Electron is resolved lazily (inside the hook, not at module load) so the
 * environment is a per-render fact, not a module-load fact — that keeps the
 * hook testable without module-registry resets.
 */

export type ByokMcpServerStatus = {|
  running: boolean | null,
  endpointUrl: string | null,
  discoveryPath: string | null,
  error: string | null,
  hostReady: boolean,
|};

const INERT_STATUS: ByokMcpServerStatus = {
  running: null,
  endpointUrl: null,
  discoveryPath: null,
  error: null,
  hostReady: false,
};

const applyEnabledResultToStatus = (result: any): ByokMcpServerStatus => {
  if (!result || result.ok !== true) {
    return {
      running: false,
      endpointUrl: null,
      discoveryPath: (result && result.discoveryPath) || null,
      error: (result && result.error) || 'The MCP server could not start.',
      hostReady: !!getByokMcpToolHost(),
    };
  }
  return {
    running: result.running === true,
    endpointUrl:
      result.running === true && typeof result.port === 'number'
        ? `http://127.0.0.1:${result.port}/mcp`
        : null,
    discoveryPath: result.discoveryPath || null,
    error: null,
    hostReady: !!getByokMcpToolHost(),
  };
};

/**
 * Drive the window's side of the MCP transport. `enabled` comes from the
 * BYOK settings; everything else is owned here.
 */
export const useByokMcpServer = (enabled: boolean): ByokMcpServerStatus => {
  const electron = optionalRequire('electron');
  const ipcRenderer = electron ? electron.ipcRenderer : null;
  const [status, setStatus] = React.useState<ByokMcpServerStatus>(INERT_STATUS);

  // Announce this window's tool-host readiness (and keep it current): main
  // routes requests to a window that can actually execute them.
  React.useEffect(
    () => {
      if (!ipcRenderer) return undefined;
      const announce = () => {
        const ready = !!getByokMcpToolHost();
        setStatus(previousStatus => ({ ...previousStatus, hostReady: ready }));
        ipcRenderer.send('byok-mcp-host-status', { ready });
      };
      announce();
      const unsubscribe = subscribeByokMcpToolHost(announce);
      return unsubscribe;
    },
    [ipcRenderer]
  );

  // Mirror every recorded activity entry to main, fire-and-forget
  // (audit011026 B-MCP-13): the settings card's ring is per-renderer module
  // state, so main aggregates every window's entries and serves the union
  // through `byok-mcp-status`.
  React.useEffect(
    () => {
      if (!ipcRenderer) return undefined;
      const unsubscribe = subscribeByokMcpActivity(entry => {
        ipcRenderer.send('byok-mcp-activity', entry);
      });
      return unsubscribe;
    },
    [ipcRenderer]
  );

  // Push the enabled state to main: on mount (restore) and on every change.
  React.useEffect(
    () => {
      if (!ipcRenderer) return undefined;
      let isCancelled = false;
      const applyEnabled = async (): Promise<void> => {
        try {
          // Errors travel as values ({ ok: false, error }), the ByokSafeStorage
          // pattern; a missing handler rejects and lands in the catch below.
          const result: any = await ipcRenderer.invoke('byok-mcp-set-enabled', {
            enabled,
          });
          if (!isCancelled) {
            setStatus(applyEnabledResultToStatus(result));
          }
        } catch (error) {
          if (!isCancelled) {
            setStatus({
              running: false,
              endpointUrl: null,
              discoveryPath: null,
              error: 'The MCP server state could not be applied.',
              hostReady: !!getByokMcpToolHost(),
            });
          }
        }
      };
      applyEnabled();
      return () => {
        isCancelled = true;
      };
    },
    [enabled, ipcRenderer]
  );

  // The protocol handlers: pure wiring between main's requests and the
  // tool host. Stable for the lifetime of the window.
  const mcpHandlers: ByokMcpToolHandlers = React.useMemo(
    (): ByokMcpToolHandlers => ({
      listTools: () => {
        const host = getByokMcpToolHost();
        return makeByokMcpToolDescriptors({
          hasOpenedProject: !!(host && host.getProject()),
        });
      },
      callTool: async (params, requestId) =>
        executeByokMcpToolCall(params.name, params.args, { requestId }),
      // An unknown name is a protocol error (-32602), not a tool result that
      // happens to carry isError (audit100226 MCP-6). With no host the lists
      // are empty, so every name is unknown — which is the right answer.
      hasTool: name => {
        const host = getByokMcpToolHost();
        return host ? hasByokMcpTool(name, host) : false;
      },
      cancel: (requestId, reason) => {
        cancelByokMcpCall(requestId);
      },
      getAppVersion: () => getIDEVersion(),
      // The prompts/resources primitives (Phase 12): served from the host's
      // data sources; without a host, the lists are empty and the specific
      // reads answer -32602 (mirroring the tools surface's no-host rule).
      listPrompts: async () => {
        const host = getByokMcpToolHost();
        const skills =
          host && host.listSkillPrompts ? await host.listSkillPrompts() : [];
        return listByokMcpPrompts(skills);
      },
      getPrompt: async name => {
        const host = getByokMcpToolHost();
        if (!host || !host.listSkillPrompts) return null;
        return getByokMcpPrompt(await host.listSkillPrompts(), name);
      },
      listResources: async () => {
        const host = getByokMcpToolHost();
        const notesText =
          host && host.readProjectNotes ? await host.readProjectNotes() : null;
        return makeByokMcpResourceDescriptors({ notesText });
      },
      readResource: async uri => {
        const host = getByokMcpToolHost();
        const notesText =
          host && host.readProjectNotes ? await host.readProjectNotes() : null;
        return readByokMcpResource({ uri, notesText });
      },
    }),
    []
  );

  // The request loop: parse → dispatch → always answer (main keeps a pending
  // entry per forwarded request; a missing answer would hang it).
  React.useEffect(
    () => {
      if (!ipcRenderer) return undefined;
      const listener = (event: any, payload: any): void => {
        void handleMcpRequest(ipcRenderer, mcpHandlers, payload);
      };
      ipcRenderer.on('byok-mcp-request', listener);
      return () => {
        ipcRenderer.removeListener('byok-mcp-request', listener);
      };
    },
    [ipcRenderer, mcpHandlers]
  );

  return status;
};

const handleMcpRequest = async (
  ipcRenderer: any,
  mcpHandlers: ByokMcpToolHandlers,
  payload: any
): Promise<void> => {
  if (!payload || typeof payload.requestId !== 'number') return;
  let response = null;
  const parsed = parseByokMcpRawMessage(
    typeof payload.rawMessage === 'string' ? payload.rawMessage : ''
  );
  try {
    const outcome = parsed.ok
      ? await handleByokMcpMessage(parsed.message, mcpHandlers)
      : {
          kind: 'response',
          response: {
            jsonrpc: '2.0',
            id: null,
            error: { code: parsed.errorCode, message: parsed.errorMessage },
          },
        };
    if (outcome.kind === 'response') response = outcome.response;
  } catch (error) {
    // JSON-RPC 2.0: the id is echoed when determinable (audit011026
    // B-MCP-9) — a null id makes the failure unmatchable for the client.
    const parsedId =
      parsed.ok &&
      parsed.message &&
      typeof parsed.message === 'object' &&
      !Array.isArray(parsed.message)
        ? parsed.message.id
        : null;
    response = {
      jsonrpc: '2.0',
      id: parsedId === undefined ? null : parsedId,
      error: {
        code: -32603,
        message: 'Internal error in the GDevelop MCP server.',
      },
    };
  }
  ipcRenderer.send('byok-mcp-response', {
    requestId: payload.requestId,
    response,
  });
};

/**
 * The one-element mount for `MainFrame`: reads the BYOK preferences and
 * runs the server hook. Renders nothing.
 */
export const ByokMcpServerHost = (): React.Node => {
  const { values } = React.useContext(PreferencesContext);
  const byokSettings = getByokSettings(values);
  useByokMcpServer(byokSettings.mcpServer.enabled);
  return null;
};
