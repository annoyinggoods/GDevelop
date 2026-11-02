// @flow
import { t, Trans } from '@lingui/macro';
import * as React from 'react';

import optionalRequire from '../../../Utils/OptionalRequire';
import { copyTextToClipboard } from '../../../Utils/Clipboard';
import Checkbox from '../../../UI/Checkbox';
import FlatButton from '../../../UI/FlatButton';
import { Column, Line } from '../../../UI/Grid';
import { ColumnStackLayout, LineStackLayout } from '../../../UI/Layout';
import CompactSelectField from '../../../UI/CompactSelectField';
import RaisedButton from '../../../UI/RaisedButton';
import SelectOption from '../../../UI/SelectOption';
import Text from '../../../UI/Text';
import {
  BYOK_MCP_ACCESS_MODES,
  type ByokMcpAccessMode,
  type ByokMcpServerSettings,
} from '../ByokTypes';
import {
  clearByokMcpActivity,
  listByokMcpActivity,
  subscribeByokMcpActivity,
  type ByokMcpActivityEntry,
} from './ByokMcpToolHost';
import { mergeByokMcpActivity } from './ByokMcpActivity';

/**
 * The Preferences → BYOK "MCP server" card (Phase 10): the enable toggle,
 * the read-only / read-write access mode, the live endpoint status, the
 * client config to copy, and the activity log of everything external
 * clients called. Props-driven (the settings tab owns the preferences
 * blob), and inert-but-present in the web build, where there is no local
 * server to run.
 */

const STATUS_REFRESH_MS = 5000;
const ACTIVITY_DISPLAY_COUNT = 20;

const CLIENT_CONFIG_SNIPPET = JSON.stringify(
  {
    mcpServers: {
      gdevelop: {
        command: 'node',
        args: [
          '<path-to-the-GDevelop-repository>/newIDE/app/scripts/gdevelop-mcp-stdio.js',
        ],
      },
    },
  },
  null,
  2
);

type McpServerStatus = {|
  running: boolean,
  port: number | null,
  discoveryPath: string | null,
  error: string | null,
|};

const IDLE_STATUS: McpServerStatus = {
  running: false,
  port: null,
  discoveryPath: null,
  error: null,
};

type Props = {|
  mcpServer: ByokMcpServerSettings,
  onChange: (partial: {|
    enabled?: boolean,
    accessMode?: ByokMcpAccessMode,
  |}) => void,
|};

export const ByokMcpSettingsCard = ({
  mcpServer,
  onChange,
}: Props): React.Node => {
  // Resolved per render (cheap), so tests can flip the environment freely.
  const electron = optionalRequire('electron');
  const ipcRenderer = electron ? electron.ipcRenderer : null;
  const isDesktop = !!ipcRenderer;

  const [status, setStatus] = React.useState<McpServerStatus>(IDLE_STATUS);
  const [remoteActivity, setRemoteActivity] = React.useState<
    Array<ByokMcpActivityEntry>
  >([]);
  const [activityVersion, setActivityVersion] = React.useState(0);

  const fetchStatus = React.useCallback(
    async (): Promise<void> => {
      if (!ipcRenderer) return;
      try {
        const result: any = await ipcRenderer.invoke('byok-mcp-status');
        if (result && result.ok) {
          setStatus({
            running: result.running === true,
            port: typeof result.port === 'number' ? result.port : null,
            discoveryPath: result.discoveryPath || null,
            error: null,
          });
          // The main-side aggregate covers every window (audit011026
          // B-MCP-13); without it (or without the field) the card falls
          // back to this window's own ring alone.
          setRemoteActivity(
            Array.isArray(result.activity) ? result.activity : []
          );
        } else {
          setStatus({
            ...IDLE_STATUS,
            error: (result && result.error) || 'The MCP server is unavailable.',
          });
          setRemoteActivity([]);
        }
      } catch (error) {
        setStatus({
          ...IDLE_STATUS,
          error: 'The MCP server state is unavailable.',
        });
        setRemoteActivity([]);
      }
    },
    [ipcRenderer]
  );

  React.useEffect(
    () => {
      if (!isDesktop || !mcpServer.enabled) return undefined;
      void fetchStatus();
      const interval = setInterval(() => {
        void fetchStatus();
        setActivityVersion(version => version + 1);
      }, STATUS_REFRESH_MS);
      return () => clearInterval(interval);
    },
    [isDesktop, mcpServer.enabled, fetchStatus]
  );

  // Local ring entries land outside React's knowledge (module state): the
  // subscription refreshes the moment one is recorded — the interval only
  // refreshes the remote aggregate.
  React.useEffect(() => {
    const unsubscribe = subscribeByokMcpActivity(() => {
      setActivityVersion(version => version + 1);
    });
    return unsubscribe;
  }, []);

  const activity = React.useMemo(
    () => {
      // activityVersion is the refresh signal (the rings are module/IPC
      // state, not React state): the interval tick and the subscription
      // re-read them.
      void activityVersion;
      return mergeByokMcpActivity(listByokMcpActivity(), remoteActivity).slice(
        0,
        ACTIVITY_DISPLAY_COUNT
      );
    },
    [activityVersion, remoteActivity]
  );

  return (
    <ColumnStackLayout noMargin>
      <Text size="block-title">
        <Trans>MCP server (external agents)</Trans>
      </Text>
      <Text>
        <Trans>
          Let apps like Claude Code or ZCode drive this project with the same
          tools the Ask AI chat uses, while GDevelop is running. The server only
          listens on this computer and requires a per-session key.
        </Trans>
      </Text>
      <Checkbox
        checked={mcpServer.enabled}
        disabled={!isDesktop}
        onCheck={(event, checked) => {
          onChange({ enabled: checked });
          if (checked) void fetchStatus();
        }}
        label={
          isDesktop ? (
            <Trans>
              Allow external agents to connect to this GDevelop window
            </Trans>
          ) : (
            <Trans>Available in the GDevelop desktop app only</Trans>
          )
        }
      />
      <LineStackLayout noMargin alignItems="center">
        <Column noMargin expand>
          <Text noMargin>
            <Trans>External agents may</Trans>
          </Text>
        </Column>
        <Column noMargin expand>
          <CompactSelectField
            value={mcpServer.accessMode}
            onChange={(value: string) => {
              const mode = BYOK_MCP_ACCESS_MODES.find(
                candidate => candidate === value
              );
              if (!mode) return;
              onChange({ accessMode: mode });
            }}
          >
            <SelectOption
              value="read-only"
              label={t`Only read the project (no changes)`}
            />
            <SelectOption
              value="read-write"
              label={t`Read and modify the project`}
            />
          </CompactSelectField>
        </Column>
      </LineStackLayout>
      {isDesktop && mcpServer.enabled && (
        <>
          <Text size="body2" color="secondary">
            {status.running ? (
              <Trans>
                Running — external agents connect to{' '}
                {status.port ? `http://127.0.0.1:${status.port}/mcp` : '…'}
              </Trans>
            ) : (
              <Trans>Not running.</Trans>
            )}{' '}
            {status.error}
          </Text>
          {status.discoveryPath && (
            <Text size="body2" color="secondary">
              <Trans>
                Connection file (port and key): {status.discoveryPath}
              </Trans>
            </Text>
          )}
          <LineStackLayout noMargin>
            <RaisedButton
              label={<Trans>Copy client config (JSON)</Trans>}
              onClick={() => {
                void copyTextToClipboard(CLIENT_CONFIG_SNIPPET);
              }}
            />
            <FlatButton
              label={<Trans>Refresh</Trans>}
              onClick={() => {
                void fetchStatus();
                setActivityVersion(version => version + 1);
              }}
            />
          </LineStackLayout>
          <Text size="body2" color="secondary">
            <Trans>
              Tip: to use tools from other MCP servers (for example a Spine
              exporter) alongside GDevelop, add them to the same external AI
              app. Claude Desktop, VS Code, ZCode and similar clients can talk
              to GDevelop and to other MCP servers at the same time, so they act
              as the bridge. GDevelop itself only exposes its own tools over
              MCP; it does not connect out to other servers.
            </Trans>
          </Text>
          <Text size="block-title">
            <Trans>Recent external agent activity</Trans>
          </Text>
          {activity.length === 0 ? (
            <Text size="body2" color="secondary">
              <Trans>Nothing yet.</Trans>
            </Text>
          ) : (
            <ColumnStackLayout noMargin>
              {activity.map((entry, index) => (
                <Text
                  key={`${entry.at}-${index}`}
                  size="body2"
                  color="secondary"
                >
                  {new Date(entry.at).toLocaleTimeString()} — {entry.tool} (
                  {entry.outcome}
                  {entry.didModifyProject ? ', modified the project' : ''},{' '}
                  {entry.durationMs} ms)
                </Text>
              ))}
              <Line noMargin>
                <FlatButton
                  label={<Trans>Clear the activity log</Trans>}
                  onClick={() => {
                    clearByokMcpActivity();
                    // The merged log spans every window: clear the main-side
                    // aggregate too, or the next status poll would bring the
                    // cleared entries right back.
                    if (ipcRenderer) {
                      ipcRenderer.send('byok-mcp-activity-clear');
                    }
                    setRemoteActivity([]);
                    setActivityVersion(version => version + 1);
                  }}
                />
              </Line>
            </ColumnStackLayout>
          )}
        </>
      )}
    </ColumnStackLayout>
  );
};

export default ByokMcpSettingsCard;
