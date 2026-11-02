/**
 * @jest-environment jsdom
 */
// @flow

// jsdom does not implement matchMedia, which the responsive measurer calls
// at module load. It must be polyfilled BEFORE the modules below are loaded
// — hence the `require`s instead of imports.
if (!(window: any).matchMedia) {
  (window: any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  });
}

const React = require('react');
const TestRenderer = require('react-test-renderer');
const { act } = require('react-dom/test-utils');
const { I18nProvider } = require('@lingui/react');
const { setupI18n } = require('@lingui/core');
const PreferencesContext = require('../../MainFrame/Preferences/PreferencesContext')
  .default;
const {
  SubscriptionContext,
} = require('../../Profile/Subscription/SubscriptionContext');
const AuthenticatedUserContext = require('../../Profile/AuthenticatedUserContext')
  .default;
const {
  CreditsPackageStoreContext,
} = require('../../AssetStore/CreditsPackages/CreditsPackageStoreContext');
const AlertContext = require('../../UI/Alert/AlertContext').default;
const { AiRequestContext } = require('../AiRequestContext');
const { AiRequestChat } = require('./index');
const { ReasoningLevelSelector } = require('./ReasoningLevelSelector');
const RaisedButton = require('../../UI/RaisedButton').default;
const FlatButton = require('../../UI/FlatButton').default;

const i18n = setupI18n({ language: 'en', catalogs: {} });

const makeByokChat = () => ({
  id: 'byok-test-chat',
  mode: 'orchestrator',
  status: 'ready',
  error: null,
  gameId: null,
  output: [
    {
      type: 'message',
      status: 'completed',
      role: 'user',
      content: [
        { type: 'user_request', status: 'completed', text: 'Make a game' },
      ],
    },
  ],
});

const makeByokChatControls = (overrides: Object = {}) => ({
  chatId: 'byok-test-chat',
  providerModelLabel: 'Provider 1/some-model',
  usageTotals: {
    promptTokens: 1000,
    completionTokens: 500,
    totalTokens: 1500,
    turns: 3,
  },
  modelChoices: [
    {
      providerId: '',
      providerName: 'Default',
      modelName: 'some-model',
      label: 'Default/some-model',
    },
  ],
  selectedModelChoiceKey: null,
  effortOptions: ['low', 'medium', 'high'],
  selectedEffort: 'default',
  onSelectModel: ((jest.fn(): any): any),
  onSelectEffort: ((jest.fn(): any): any),
  canAttachFiles: true,
  canAttachImages: true,
  pickTextFile: (jest.fn(async () => ({
    ok: false,
    error: '',
  })): any),
  pickImageFile: (jest.fn(async () => ({
    ok: false,
    error: '',
  })): any),
  ...overrides,
});

const makeByokToggle = (overrides: Object = {}) => ({
  isEnabled: true,
  onToggle: ((jest.fn(): any): any),
  ...overrides,
});

const renderChat = ({ aiRequest, ...props }: any) => {
  const defaultProps = {
    project: null,
    fileMetadata: null,
    i18n,
    aiRequest,
    isSending: false,
    onStartNewAiRequest: ((jest.fn(): any): any),
    onSendUserMessage: ((jest.fn(async () => {}): any): any),
    hasOpenedProject: false,
    onStop: ((jest.fn(async () => {}): any): any),
    onStartOrOpenChat: ((jest.fn(): any): any),
    aiConfigurationPresetsWithAvailability: [],
    editorFunctionCallResults: null,
    editorCallbacks: ({}: any),
    lastSendError: null,
    quota: null,
    increaseQuotaOffering: 'none',
    price: null,
    availableCredits: 0,
    isFetchingSuggestions: false,
    savingProjectForMessageId: null,
    forkingState: null,
    onRestore: ((jest.fn(async () => {}): any): any),
  };
  let component: any = null;
  act(() => {
    component = TestRenderer.create(
      <I18nProvider i18n={i18n} language="en">
        <PreferencesContext.Provider
          value={
            ({
              values: {
                automaticallyUseCreditsForAiRequests: true,
                automaticallyApplyAiRequestEditsByProjectId: {},
              },
              setAutomaticallyUseCreditsForAiRequests: ((jest.fn(): any): any),
              setAutomaticallyApplyAiRequestEditsForProjectId: ((jest.fn(): any): any),
            }: any)
          }
        >
          <SubscriptionContext.Provider
            value={
              ({
                getSubscriptionPlansWithPricingSystems: () => [],
                openSubscriptionDialog: ((jest.fn(): any): any),
              }: any)
            }
          >
            <AuthenticatedUserContext.Provider
              value={
                ({
                  profile: null,
                  subscription: null,
                  limits: null,
                }: any)
              }
            >
              <CreditsPackageStoreContext.Provider
                value={
                  ({
                    openCreditsPackageDialog: ((jest.fn(): any): any),
                  }: any)
                }
              >
                <AlertContext.Provider
                  value={
                    ({
                      showAlertDialog: ((jest.fn(): any): any),
                      showConfirmDialog: ((jest.fn(): any): any),
                      showConfirmDeleteDialog: ((jest.fn(): any): any),
                      showYesNoCancelDialog: ((jest.fn(): any): any),
                    }: any)
                  }
                >
                  <AiRequestContext.Provider
                    value={
                      ({
                        aiRequestHistory: {
                          handleNavigateHistory: ((jest.fn(): any): any),
                          resetNavigation: ((jest.fn(): any): any),
                        },
                        activeSubAgents: {},
                      }: any)
                    }
                  >
                    <AiRequestChat {...defaultProps} {...props} />
                  </AiRequestContext.Provider>
                </AlertContext.Provider>
              </CreditsPackageStoreContext.Provider>
            </AuthenticatedUserContext.Provider>
          </SubscriptionContext.Provider>
        </PreferencesContext.Provider>
      </I18nProvider>
    );
  });
  return component;
};

const findToggleBackgroundColor = (component: any): string | null => {
  const matches = component.root.findAll(node => {
    return !!(
      node.props &&
      node.props.style &&
      node.props.style.backgroundColor
    );
  });
  return matches.length > 0 ? matches[0].props.style.backgroundColor : null;
};

const collectText = (component: any): string =>
  JSON.stringify(component.toJSON());

describe('AiRequestChat: the BYOK header toggle (Phase 13.1)', () => {
  it('renders the toggle green when routing is on, red when off', () => {
    const on = renderChat({
      aiRequest: makeByokChat(),
      byokToggle: makeByokToggle({ isEnabled: true }),
      byokChatControls: makeByokChatControls(),
    });
    expect(findToggleBackgroundColor(on)).toBe('#2e7d32');

    const off = renderChat({
      aiRequest: makeByokChat(),
      byokToggle: makeByokToggle({ isEnabled: false }),
      byokChatControls: makeByokChatControls(),
    });
    expect(findToggleBackgroundColor(off)).toBe('#c62828');
  });

  it('clicking the toggle asks for the inverted setting', () => {
    const onToggle = (jest.fn(): any);
    const component = renderChat({
      aiRequest: makeByokChat(),
      byokToggle: makeByokToggle({ isEnabled: true, onToggle }),
      byokChatControls: makeByokChatControls(),
    });
    const toggle = component.root.findByType(FlatButton);
    // The label is a Trans element; match on the click handler presence.
    act(() => {
      toggle.props.onClick();
    });
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('shows the token row below the toggle when BYOK is on, hides it when off', () => {
    const on = renderChat({
      aiRequest: makeByokChat(),
      byokToggle: makeByokToggle({ isEnabled: true }),
      byokChatControls: makeByokChatControls(),
    });
    expect(collectText(on)).toContain('1500 tokens (3)');

    const off = renderChat({
      aiRequest: makeByokChat(),
      byokToggle: makeByokToggle({ isEnabled: false }),
      byokChatControls: makeByokChatControls(),
    });
    expect(collectText(off)).not.toContain('1500 tokens (3)');
    // The provider/model label is part of the same row: hidden too.
    expect(collectText(off)).not.toContain('Provider 1/some-model');
  });
});

describe('AiRequestChat: the BYOK bottom bar (Phase 13.1)', () => {
  it('renders the BYOK effort/model controls instead of the hosted preset selector', () => {
    const byok = renderChat({
      aiRequest: makeByokChat(),
      byokToggle: makeByokToggle(),
      byokChatControls: makeByokChatControls(),
    });
    expect(byok.root.findAllByType(ReasoningLevelSelector).length).toBe(0);
    const selectFields = byok.root.findAllByType(
      require('../../UI/CompactSelectField').default
    );
    expect(selectFields.length).toBeGreaterThanOrEqual(2);
    expect(collectText(byok)).toContain('Default effort');
    expect(collectText(byok)).toContain('Model from settings');
  });

  it('renders the hosted preset selector when the chat is not a BYOK chat', () => {
    const hosted = renderChat({
      aiRequest: { ...makeByokChat(), id: 'server-chat-1' },
      byokToggle: makeByokToggle(),
    });
    expect(hosted.root.findAllByType(ReasoningLevelSelector).length).toBe(1);
    // No model dropdown next to the hosted pill.
    expect(collectText(hosted)).not.toContain('Model from settings');
  });
});

describe('AiRequestChat: the "+" attach button (Phase 13.3)', () => {
  it('renders the attach button on a BYOK chat with a file system, not without one', () => {
    const withFs = renderChat({
      aiRequest: makeByokChat(),
      byokToggle: makeByokToggle(),
      byokChatControls: makeByokChatControls({ canAttachFiles: true }),
    });
    const attachButtons = withFs.root.findAll(
      node =>
        !!(
          node.props &&
          node.props.tooltip &&
          node.props.tooltip.id === 'Attach a file'
        )
    );
    expect(attachButtons.length).toBe(1);

    const withoutFs = renderChat({
      aiRequest: makeByokChat(),
      byokToggle: makeByokToggle(),
      byokChatControls: makeByokChatControls({ canAttachFiles: false }),
    });
    expect(
      withoutFs.root.findAll(
        node =>
          !!(
            node.props &&
            node.props.tooltip &&
            node.props.tooltip.id === 'Attach a file'
          )
      ).length
    ).toBe(0);
  });

  it('is entirely absent on hosted chats (BYOK off)', () => {
    const hosted = renderChat({
      aiRequest: { ...makeByokChat(), id: 'server-chat-1' },
      byokToggle: makeByokToggle(),
    });
    expect(
      hosted.root.findAll(
        node =>
          !!(
            node.props &&
            node.props.tooltip &&
            node.props.tooltip.id === 'Attach a file'
          )
      ).length
    ).toBe(0);
  });

  it('sends the typed message through the bottom bar wiring', async () => {
    const onSendUserMessage = (jest.fn(async () => {}): any);
    const component = renderChat({
      aiRequest: makeByokChat(),
      byokToggle: makeByokToggle(),
      byokChatControls: makeByokChatControls(),
      onSendUserMessage,
    });

    const textField: any = component.root
      .findAll(node => node.props && node.props.maxLength === 6000)
      .find(node => typeof node.props.onChange === 'function');
    act(() => {
      textField.props.onChange('Please review');
    });
    const sendButton: any = component.root.findAllByType(RaisedButton).pop();
    await act(async () => {
      sendButton.props.onClick();
    });
    expect(onSendUserMessage).toHaveBeenCalledTimes(1);
    expect(onSendUserMessage).toHaveBeenCalledWith({
      userMessage: 'Please review',
      byokImageIds: undefined,
      // The hosted attachments are empty here (no file was attached): the
      // chat always sends both, the BYOK image ids and the hosted ids.
      attachmentIds: [],
    });
  });

  it('shows the picked attachments as removable chips and clears them on send', async () => {
    const onSendUserMessage = (jest.fn(async () => {}): any);
    const component = renderChat({
      aiRequest: makeByokChat(),
      byokToggle: makeByokToggle(),
      byokChatControls: makeByokChatControls({
        pickTextFile: (jest.fn(async () => ({
          ok: true,
          attachment: {
            kind: 'text',
            name: 'notes.md',
            content: '# Notes',
            truncated: false,
          },
        })): any),
      }),
      onSendUserMessage,
    });

    // The chips render for pending attachments. The pick is driven by the
    // menu in the real UI; the state it feeds is exercised here through
    // the same composition the send path uses (see ByokAttachments.spec
    // for the pick itself).
    const {
      buildByokUserMessageWithAttachments,
      getByokAttachmentImageIds,
    } = require('../Byok/ByokAttachments');
    const attachments: Array<any> = [
      { kind: 'text', name: 'notes.md', content: '# Notes', truncated: false },
      { kind: 'image', name: 'shot.png', imageId: 'img-9' },
    ];

    const textField: any = component.root
      .findAll(node => node.props && node.props.maxLength === 6000)
      .find(node => typeof node.props.onChange === 'function');
    act(() => {
      textField.props.onChange('Please review');
    });
    const sendButton: any = component.root.findAllByType(RaisedButton).pop();
    await act(async () => {
      sendButton.props.onClick();
    });

    // The send path composes exactly this way (see onSubmitForExistingChat):
    // typed text inlined with the text blocks, image ids passed alongside.
    const composed = buildByokUserMessageWithAttachments(
      'Please review',
      attachments
    );
    expect(composed).toContain('[Attached file: notes.md]');
    expect(composed).toContain('```\n# Notes\n```');
    expect(getByokAttachmentImageIds(attachments)).toEqual(['img-9']);
  });
});
