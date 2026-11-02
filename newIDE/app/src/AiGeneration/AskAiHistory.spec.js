/**
 * @jest-environment jsdom
 */
// @flow

// jsdom does not implement matchMedia, which PreferencesContext.js calls at
// module load. Polyfill BEFORE the modules below are loaded — hence the
// `require`s instead of imports.
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
const { act } = require('react-dom/test-utils');
const reactTestRenderer = require('react-test-renderer');
const { I18nProvider } = require('@lingui/react');
const { setupI18n } = require('@lingui/core');
const { AskAiHistoryContent } = require('./AskAiHistory');
const { AiRequestContext } = require('./AiRequestContext');
const AlertContext = require('../UI/Alert/AlertContext').default;

const i18n = setupI18n({ language: 'en', catalogs: {} });

const makeAiRequestContextValue = (overrides: Object = {}) => ({
  aiRequestStorage: {
    aiRequestSummaries: {},
    fetchAiRequestSummaries: (jest.fn(): any),
    onLoadMoreAiRequestSummaries: (jest.fn(async () => {}): any),
    canLoadMore: false,
    isLoading: false,
    error: null,
    renameAiRequest: (jest.fn(): any),
    setAiRequestArchived: (jest.fn(): any),
    deleteAiRequest: (jest.fn(): any),
    aiRequestSummariesFilter: 'active',
    setAiRequestSummariesFilter: (jest.fn(): any),
    aiRequestSummariesGameId: null,
    onLoadMoreGameAiRequestSummaries: (jest.fn(async () => {}): any),
    canLoadMoreGameAiRequestSummaries: false,
    ...overrides,
  },
  pendingEditApproval: null,
});

const makeByokEntry = (overrides: Object = {}) => ({
  id: 'byok-rail-1',
  title: 'Make a platformer_2026-09-25',
  archivedAt: null,
  gameId: null,
  createdAt: '2026-09-25T10:00:00.000Z',
  updatedAt: '2026-09-25T11:00:00.000Z',
  userId: '',
  status: 'ready',
  mode: 'orchestrator',
  error: null,
  firstUserMessage: '',
  lastMessage: '',
  outputMessagesCount: 4,
  ...overrides,
});

const makeHostedEntry = (overrides: Object = {}) => ({
  id: 'server-chat-1',
  title: 'Hosted chat',
  archivedAt: null,
  gameId: null,
  createdAt: '2026-09-25T09:00:00.000Z',
  updatedAt: '2026-09-25T09:30:00.000Z',
  userId: 'user-1',
  status: 'ready',
  mode: 'orchestrator',
  error: null,
  firstUserMessage: 'Hosted chat',
  lastMessage: '',
  outputMessagesCount: 2,
  ...overrides,
});

const renderHistory = ({ contextValue, ...props }: any) => {
  let component: any = null;
  act(() => {
    component = reactTestRenderer.create(
      <I18nProvider i18n={i18n} language="en">
        <AlertContext.Provider
          value={
            ({
              showAlertDialog: (jest.fn(): any),
              showConfirmDialog: jest.fn(({ callback }: any) => callback(true)),
              showConfirmDeleteDialog: (jest.fn(): any),
              showYesNoCancelDialog: (jest.fn(): any),
            }: any)
          }
        >
          <AiRequestContext.Provider value={contextValue}>
            <AskAiHistoryContent
              onOpenAiRequest={(jest.fn(): any)}
              onStartNewChat={(jest.fn(): any)}
              canStartNewChat
              selectedAiRequestId={null}
              {...props}
            />
          </AiRequestContext.Provider>
        </AlertContext.Provider>
      </I18nProvider>
    );
  });
  return component;
};

// The rows' context menu (the filter chooser renders one too): pick the one
// whose template answers BYOK options with the row actions.
const findRowMenu = (component: any, options: any): any => {
  const ContextMenu = require('../UI/Menu/ContextMenu').default;
  const translate = (descriptor: any) =>
    typeof descriptor === 'string' ? descriptor : descriptor.id;
  const menus = component.root.findAllByType(ContextMenu);
  const rowMenu = menus.find(menu =>
    menu.props
      .buildMenuTemplate(
        { _: translate },
        { aiRequestId: 'byok-rail-1', ...options }
      )
      .some((item: any) => item.label === 'Delete')
  );
  if (!rowMenu) throw new Error('The BYOK row menu was not found.');
  return rowMenu.props;
};

describe('AskAiHistoryContent: the BYOK section of the Recents rail (Phase 13.1)', () => {
  it('lists the BYOK chats in their own section, above the hosted Recents', () => {
    const contextValue = makeAiRequestContextValue({
      aiRequestSummaries: { 'server-chat-1': makeHostedEntry() },
    });
    const component = renderHistory({
      contextValue,
      byokChatSummaries: [makeByokEntry()],
      onSetByokChatArchived: (jest.fn(): any),
      onDeleteByokChat: (jest.fn(async () => {}): any),
    });

    const json = JSON.stringify(component.toJSON());
    expect(json).toContain('BYOK (your own key)');
    expect(json).toContain('Make a platformer_2026-09-25');
    expect(json).toContain('Hosted chat');
    // The BYOK section title comes before the hosted entry in the tree.
    expect(json.indexOf('BYOK (your own key)')).toBeLessThan(
      json.indexOf('Hosted chat')
    );
  });

  it('renders no BYOK section when no BYOK chats are passed (BYOK off)', () => {
    const contextValue = makeAiRequestContextValue({
      aiRequestSummaries: { 'server-chat-1': makeHostedEntry() },
    });
    const component = renderHistory({ contextValue });
    expect(JSON.stringify(component.toJSON())).not.toContain(
      'BYOK (your own key)'
    );
  });

  it('routes a click on a BYOK row through onOpenAiRequest', () => {
    const onOpenAiRequest = (jest.fn(): any);
    const contextValue = makeAiRequestContextValue();
    const component = renderHistory({
      contextValue,
      byokChatSummaries: [makeByokEntry()],
      onOpenAiRequest,
      onSetByokChatArchived: (jest.fn(): any),
      onDeleteByokChat: (jest.fn(async () => {}): any),
    });

    const rowButton = component.root.findAll(
      node =>
        node.type === 'button' &&
        node.props.title === 'Make a platformer_2026-09-25'
    );
    expect(rowButton.length).toBe(1);
    act(() => {
      rowButton[0].props.onClick();
    });
    expect(onOpenAiRequest).toHaveBeenCalledWith('byok-rail-1');
  });

  it('hides archived BYOK chats from the active filter and shows them in the archived one', () => {
    const contextValue = makeAiRequestContextValue({
      aiRequestSummariesFilter: 'active',
    });
    const entries = [
      makeByokEntry(),
      makeByokEntry({
        id: 'byok-rail-archived',
        title: 'Old project_2026-09-20',
        archivedAt: '2026-09-24T10:00:00.000Z',
      }),
    ];
    const active = renderHistory({
      contextValue,
      byokChatSummaries: entries,
      onSetByokChatArchived: (jest.fn(): any),
      onDeleteByokChat: (jest.fn(async () => {}): any),
    });
    const activeJson = JSON.stringify(active.toJSON());
    expect(activeJson).toContain('Make a platformer_2026-09-25');
    expect(activeJson).not.toContain('Old project_2026-09-20');

    const archivedContext = makeAiRequestContextValue({
      aiRequestSummariesFilter: 'archived',
    });
    const archived = renderHistory({
      contextValue: archivedContext,
      byokChatSummaries: entries,
      onSetByokChatArchived: (jest.fn(): any),
      onDeleteByokChat: (jest.fn(async () => {}): any),
    });
    const archivedJson = JSON.stringify(archived.toJSON());
    expect(archivedJson).toContain('Old project_2026-09-20');
    expect(archivedJson).not.toContain('Make a platformer_2026-09-25');
  });

  it('deletes a BYOK chat after the confirmation, leaving it first if selected', async () => {
    const onDeleteByokChat = (jest.fn(async () => {}): any);
    const onStartNewChat = (jest.fn(): any);
    const contextValue = makeAiRequestContextValue();
    const component = renderHistory({
      contextValue,
      byokChatSummaries: [makeByokEntry()],
      onStartNewChat,
      selectedAiRequestId: 'byok-rail-1',
      onSetByokChatArchived: (jest.fn(): any),
      onDeleteByokChat,
    });

    // The menu template is built by the ContextMenu child: drive it
    // directly (the menu itself opens in a portal outside the test tree).
    const rowMenu = findRowMenu(component, { isArchived: false });
    const template = rowMenu.buildMenuTemplate(
      {
        _: (descriptor: any) =>
          typeof descriptor === 'string' ? descriptor : descriptor.id,
      },
      { aiRequestId: 'byok-rail-1', isArchived: false }
    );

    const deleteItem = template.find((item: any) => item.label === 'Delete');
    expect(deleteItem).toBeTruthy();
    await act(async () => {
      await deleteItem.click();
    });
    expect(onStartNewChat).toHaveBeenCalledWith();
    expect(onDeleteByokChat).toHaveBeenCalledWith('byok-rail-1');
  });

  it('archives and restores a BYOK chat through the menu', async () => {
    const onSetByokChatArchived = (jest.fn(): any);
    const contextValue = makeAiRequestContextValue();
    const component = renderHistory({
      contextValue,
      byokChatSummaries: [makeByokEntry()],
      onSetByokChatArchived,
      onDeleteByokChat: (jest.fn(async () => {}): any),
    });

    const translate = (descriptor: any) =>
      typeof descriptor === 'string' ? descriptor : descriptor.id;

    const activeTemplate = findRowMenu(component, {
      isArchived: false,
    }).buildMenuTemplate(
      { _: translate },
      {
        aiRequestId: 'byok-rail-1',
        isArchived: false,
      }
    );
    const archiveItem = activeTemplate.find(
      (item: any) => item.label === 'Archive'
    );
    expect(archiveItem).toBeTruthy();
    act(() => {
      archiveItem.click();
    });
    expect(onSetByokChatArchived).toHaveBeenCalledWith('byok-rail-1', true);

    // An archived row offers Unarchive instead (visible under the
    // archived filter).
    const archivedComponent = renderHistory({
      contextValue: makeAiRequestContextValue({
        aiRequestSummariesFilter: 'archived',
      }),
      byokChatSummaries: [
        makeByokEntry({ archivedAt: '2026-09-24T10:00:00.000Z' }),
      ],
      onSetByokChatArchived,
      onDeleteByokChat: (jest.fn(async () => {}): any),
    });
    const archivedTemplate = findRowMenu(archivedComponent, {
      isArchived: true,
    }).buildMenuTemplate(
      { _: translate },
      { aiRequestId: 'byok-rail-1', isArchived: true }
    );
    expect(
      archivedTemplate.some((item: any) => item.label === 'Unarchive')
    ).toBe(true);
    expect(archivedTemplate.some((item: any) => item.label === 'Archive')).toBe(
      false
    );
  });
});
