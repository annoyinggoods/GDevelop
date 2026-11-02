// @flow
import * as React from 'react';
import reactTestRenderer from 'react-test-renderer';
import { act } from 'react-dom/test-utils';
import useMainFrameCommands from './MainFrameCommands';
import CommandsContext from '../CommandPalette/CommandsContext';
import CommandManager from '../CommandPalette/CommandManager';
import commandsList from '../CommandPalette/CommandsList';
import defaultShortcuts from '../KeyboardShortcuts/DefaultShortcuts';

/**
 * The Phase 12 command-palette entry: "Open Ask AI" with the default
 * Ctrl+Alt+A (Cmd+Alt+A on mac) — the audit found no palette entry and no
 * shortcut for Ask AI. Declared across the four standard touchpoints
 * (CommandsList, DefaultShortcuts, MainFrameCommands, MainFrame/index.js).
 */

const makeHandlers = (overrides: Object = {}) => ({
  i18n: { _: (message: any) => message.id || String(message) },
  project: null,
  previewEnabled: false,
  hasPreviewsRunning: false,
  allowNetworkPreview: false,
  onOpenProjectManager: (jest.fn(): any),
  onLaunchPreview: (jest.fn(): any),
  onLaunchDebugPreview: (jest.fn(): any),
  onLaunchNetworkPreview: (jest.fn(): any),
  onHotReloadPreview: (jest.fn(): any),
  onLaunchPreviewWithDiagnosticReport: (jest.fn(): any),
  onOpenDiagnosticReport: (jest.fn(): any),
  onOpenHomePage: (jest.fn(): any),
  onCreateProject: (jest.fn(): any),
  onOpenProject: (jest.fn(): any),
  onSaveProject: (jest.fn(): any),
  onSaveProjectAs: (jest.fn(): any),
  onCloseApp: (jest.fn(): any),
  onCloseProject: (jest.fn(): any),
  onReloadProject: (jest.fn(): any),
  onExportGame: (jest.fn(): any),
  onExportHtml5External: (jest.fn(): any),
  onInviteCollaborators: (jest.fn(): any),
  onOpenLayout: (jest.fn(): any),
  onOpenExternalEvents: (jest.fn(): any),
  onOpenExternalLayout: (jest.fn(): any),
  onOpenEventsFunctionsExtension: (jest.fn(): any),
  onOpenGameplayTest: (jest.fn(): any),
  onRunGameplayTest: (jest.fn(): any),
  onRunAllGameplayTests: (jest.fn(): any),
  onOpenCommandPalette: (jest.fn(): any),
  onOpenProfile: (jest.fn(): any),
  onRestartInGameEditor: (jest.fn(): any),
  onOpenGlobalSearch: (jest.fn(): any),
  onOpenAskAi: (jest.fn(): any),
  onOpenMemoryTrackerRegistry: (jest.fn(): any),
  onImportExtension: (jest.fn(): any),
  canInstallCliInPath: false,
  onInstallCliInPath: (jest.fn(): any),
  ...overrides,
});

describe('the OPEN_ASK_AI command (Phase 12)', () => {
  it('is declared as a visible command', () => {
    expect(commandsList.OPEN_ASK_AI).toBeTruthy();
    // The "IDE" command area was removed upstream (the IDE-wide commands
    // moved to "General"), so the command follows it there.
    expect(commandsList.OPEN_ASK_AI.area).toBe('GENERAL');
    // Visible in the palette (not ghost) and reassignable (not noShortcut).
    expect(commandsList.OPEN_ASK_AI.ghost).toBeFalsy();
    expect(commandsList.OPEN_ASK_AI.noShortcut).toBeFalsy();
  });

  it('defaults to Ctrl/Cmd+Alt+A with no conflict among the defaults', () => {
    expect(defaultShortcuts.OPEN_ASK_AI).toBe('CmdOrCtrl+Alt+KeyA');
    // Conflict regression: no other default (primary or secondary) may
    // share the combo.
    const combos: Array<string> = Object.values(defaultShortcuts).filter(
      Boolean
    );
    const askAiCombos = combos.filter(combo => combo === 'CmdOrCtrl+Alt+KeyA');
    expect(askAiCombos).toHaveLength(1);
  });

  it('registers in the command manager and dispatches to openAskAi', () => {
    const handlers = makeHandlers();
    const commandManager = new CommandManager();
    const Probe = () => {
      useMainFrameCommands(handlers);
      return null;
    };
    const CapturingProvider = (props: {| children: React.Node |}) => (
      <CommandsContext.Provider value={commandManager}>
        {props.children}
      </CommandsContext.Provider>
    );

    act(() => {
      reactTestRenderer.create(
        <CapturingProvider>
          <Probe />
        </CapturingProvider>
      );
    });

    const command = commandManager.getNamedCommand('OPEN_ASK_AI');
    expect(command).toBeTruthy();
    if (command && command.handler) {
      command.handler();
    }
    expect(handlers.onOpenAskAi).toHaveBeenCalledTimes(1);
  });
});
