// @flow
const ByokChatStore = require('./ByokChatStore');

describe('ByokChatStore', () => {
  // The store is a module-level map: reset it between tests.
  let unsubscribeFromSetup: () => void;
  beforeEach(() => {
    for (const chat of ByokChatStore.listByokChats()) {
      ByokChatStore.archiveByokChat(chat.id);
    }
    unsubscribeFromSetup = ByokChatStore.subscribeByokChats(() => {});
  });
  afterEach(() => {
    unsubscribeFromSetup();
  });

  it('creates chats with unique ids prefixed by "byok-"', () => {
    const firstChat = ByokChatStore.createByokChat();
    const secondChat = ByokChatStore.createByokChat();

    expect(firstChat.id.startsWith('byok-')).toBe(true);
    expect(secondChat.id.startsWith('byok-')).toBe(true);
    expect(firstChat.id).not.toBe(secondChat.id);
  });

  it('creates chats ready to be rendered by the chat UI', () => {
    const chat = ByokChatStore.createByokChat();

    expect(chat.status).toBe('working');
    expect(chat.output).toEqual([]);
    expect(chat.error).toBe(null);
    expect(typeof chat.createdAt).toBe('string');
    expect(typeof chat.updatedAt).toBe('string');
  });

  it('gets a chat by id, and null for an unknown id', () => {
    const chat = ByokChatStore.createByokChat();

    expect(ByokChatStore.getByokChat(chat.id)).not.toBe(null);
    expect(ByokChatStore.getByokChat('byok-does-not-exist')).toBe(null);
  });

  it('updates a chat, bumping updatedAt and notifying the subscribers', () => {
    const listener = mockFn(jest.fn());
    const unsubscribe = ByokChatStore.subscribeByokChats(listener);
    const chat = ByokChatStore.createByokChat();
    listener.mockClear();

    ByokChatStore.updateByokChat({
      ...chat,
      status: 'ready',
    });

    const updatedChat = ByokChatStore.getByokChat(chat.id);
    if (!updatedChat) throw new Error('The chat disappeared from the store');
    expect(updatedChat.status).toBe('ready');
    expect(updatedChat.updatedAt >= chat.updatedAt).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('ignores updates for unknown chat ids', () => {
    const chat = ByokChatStore.createByokChat();
    const listener = mockFn(jest.fn());
    const unsubscribe = ByokChatStore.subscribeByokChats(listener);

    ByokChatStore.updateByokChat({
      ...chat,
      id: 'byok-never-created',
      status: 'ready',
    });

    expect(listener).not.toHaveBeenCalled();
    expect(ByokChatStore.getByokChat('byok-never-created')).toBe(null);
    expect(ByokChatStore.getByokChat(chat.id)).not.toBe(null);

    unsubscribe();
  });

  it('archives a chat: it disappears from the default list but stays restorable', () => {
    const chat = ByokChatStore.createByokChat();
    expect(ByokChatStore.listByokChats()).toContainEqual(
      expect.objectContaining({ id: chat.id })
    );

    ByokChatStore.archiveByokChat(chat.id);

    // Excluded from the default list (the real archive of Phase 9.3), but
    // still returned by getByokChat: delete is explicit and separate.
    expect(ByokChatStore.listByokChats().map(c => c.id)).not.toContain(chat.id);
    const archivedChat = ByokChatStore.getByokChat(chat.id);
    expect(archivedChat).not.toBe(null);
    expect(archivedChat && archivedChat.archivedAt).toBeTruthy();

    // Restore puts it back into the active list.
    if (archivedChat) ByokChatStore.restoreByokChat(chat.id);
    expect(ByokChatStore.listByokChats().map(c => c.id)).toContain(chat.id);
  });

  it('keeps the archive marker when an in-flight orchestrator update lands', () => {
    const listener = mockFn(jest.fn());
    const unsubscribe = ByokChatStore.subscribeByokChats(listener);
    const chat = ByokChatStore.createByokChat();
    ByokChatStore.archiveByokChat(chat.id);
    listener.mockClear();

    // The suspended orchestrator's record carries no archive marker: the
    // stored copy must keep it (the chat was archived, not resurrected).
    chat.status = 'ready';
    ByokChatStore.updateByokChat(chat);

    const storedChat = ByokChatStore.getByokChat(chat.id);
    expect(storedChat && storedChat.archivedAt).toBeTruthy();
    expect(ByokChatStore.listByokChats().map(c => c.id)).not.toContain(chat.id);
    expect(listener).toHaveBeenCalled();

    unsubscribe();
  });

  it('supports subscribing and unsubscribing', () => {
    const listener = mockFn(jest.fn());
    const unsubscribe = ByokChatStore.subscribeByokChats(listener);

    ByokChatStore.createByokChat();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    ByokChatStore.createByokChat();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('documents the durable-history persistence decision (Phase 9.3)', () => {
    expect(ByokChatStore.BYOK_CHAT_PERSISTENCE_ENABLED).toBe(true);
  });

  it('saves through the persistence delegate at the contract save points', async () => {
    const savedChats: Array<string> = [];
    const fileStore = {
      listChatMetas: async () => [],
      loadChat: async () => null,
      saveChat: async (savedChat: any) => {
        savedChats.push(`${savedChat.id}:${savedChat.status}`);
        return `${savedChat.id}.md`;
      },
      setArchived: async () => true,
      renameChat: async () => true,
      deleteChat: async () => true,
      getStorageUsage: async () => ({ totalBytes: 0, imageBytes: 0 }),
      enforceQuota: async () => ({
        evictedImageChatCount: 0,
        evictedChatCount: 0,
      }),
    };

    ByokChatStore.setByokChatPersistence(((fileStore: any): any));
    const chat = ByokChatStore.createByokChat();
    try {
      // A user message lands with status 'working' → debounced, not yet saved.
      chat.status = 'working';
      ByokChatStore.updateByokChat(chat);
      expect(savedChats).toEqual([]);

      // The AI finishes ('ready') → immediate save ("after the AI finishes").
      chat.status = 'ready';
      ByokChatStore.updateByokChat(chat);
      await Promise.resolve();
      await Promise.resolve();
      expect(savedChats).toEqual([`${chat.id}:ready`]);

      // Archive saves too (the archive marker must reach the file).
      ByokChatStore.archiveByokChat(chat.id);
      await Promise.resolve();
      await Promise.resolve();
      expect(savedChats.length).toBe(2);
    } finally {
      ByokChatStore.setByokChatPersistence(null);
      await ByokChatStore.deleteByokChat(chat.id);
    }
  });

  describe('pickByokChatToSelectOnMount (Phase 13.2)', () => {
    it('returns the pending selection when its chat exists', () => {
      const chat = ByokChatStore.createByokChat();
      try {
        expect(ByokChatStore.pickByokChatToSelectOnMount(chat.id)).toBe(
          chat.id
        );
      } finally {
        ByokChatStore.deleteByokChat(chat.id);
      }
    });

    it('falls back to the single working chat with a live orchestrator (remount after a project opens)', async () => {
      const readyChat = ByokChatStore.createByokChat();
      const workingChat = ByokChatStore.createByokChat();
      try {
        ByokChatStore.updateByokChat({ ...readyChat, status: 'ready' });
        ByokChatStore.setByokOrchestrator(workingChat.id, {
          suspend: () => {},
        });
        expect(ByokChatStore.pickByokChatToSelectOnMount(null)).toBe(
          workingChat.id
        );
      } finally {
        ByokChatStore.deleteByokOrchestrator(workingChat.id);
        await ByokChatStore.deleteByokChat(readyChat.id);
        await ByokChatStore.deleteByokChat(workingChat.id);
      }
    });

    it('returns null with several working chats, or none', () => {
      const firstWorking = ByokChatStore.createByokChat();
      const secondWorking = ByokChatStore.createByokChat();
      try {
        ByokChatStore.setByokOrchestrator(firstWorking.id, {
          suspend: () => {},
        });
        ByokChatStore.setByokOrchestrator(secondWorking.id, {
          suspend: () => {},
        });
        expect(ByokChatStore.pickByokChatToSelectOnMount(null)).toBe(null);
      } finally {
        ByokChatStore.deleteByokOrchestrator(firstWorking.id);
        ByokChatStore.deleteByokOrchestrator(secondWorking.id);
        void ByokChatStore.deleteByokChat(firstWorking.id);
        void ByokChatStore.deleteByokChat(secondWorking.id);
      }
      expect(ByokChatStore.pickByokChatToSelectOnMount(null)).toBe(null);
    });

    it('ignores a pending id whose chat no longer exists', () => {
      expect(ByokChatStore.pickByokChatToSelectOnMount('byok-gone-away')).toBe(
        null
      );
    });
  });
});

function mockFn(fn: any): any {
  return fn;
}
