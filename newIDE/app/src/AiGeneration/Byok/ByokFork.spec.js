// @flow
import {
  BYOK_PROJECT_SNAPSHOT_CAPACITY,
  dropByokChatSnapshots,
  forkByokChat,
  getByokProjectSnapshot,
  listByokProjectSnapshots,
  resetByokSnapshotsForTests,
  restoreByokProjectFromSnapshot,
  takeByokProjectSnapshot,
} from './ByokFork';
import {
  archiveByokChat,
  createByokChat,
  getByokChat,
  updateByokChat,
} from './ByokChatStore';
import { findByNameokExtraTool } from './ByokExtraTools';
import { serializeToJSON } from '../../Utils/Serializer';

// The restore itself is a real-WASM round-trip in its own test below; the
// TOOL tests mock it (repeated in-place restores inside one WASM instance
// are flaky, and the tool's contract is the lookup + the messages).
jest.mock('./ByokFork', () => ({
  ...jest.requireActual('./ByokFork'),
  restoreByokProjectFromSnapshot: (jest.fn(): any),
}));

/**
 * The fork / restore-point tests (Phase 8.6) drive the real store and the
 * real WASM libGD for the project round-trip.
 */
const gd: libGDevelop = global.gd;

const makeChatWithMessages = (messageIds: Array<string>): Object => {
  const chat = createByokChat();
  chat.output = messageIds.map(id => ({
    type: 'message',
    status: 'completed',
    role: 'user',
    messageId: id,
    content: [{ type: 'user_request', status: 'completed', text: `m ${id}` }],
  }));
  updateByokChat(chat);
  return chat;
};

describe('forkByokChat', () => {
  it('copies the output up to and INCLUDING the target message', () => {
    const chat = makeChatWithMessages(['m1', 'm2', 'm3', 'm4']);
    const fork: any = forkByokChat(chat.id, 'm2');

    expect(fork.output.length).toBe(2);
    expect(fork.output.map((message: Object) => message.messageId)).toEqual([
      'm1',
      'm2',
    ]);
    // The fork is a NEW chat, titled, linked to its parent.
    expect(fork.id).not.toBe(chat.id);
    expect(fork.title).toContain('Fork of');
    expect(fork.forkedFromAiRequestId).toBe(chat.id);
    expect(fork.forkedAfterOriginalMessageId).toBe('m2');
    // The copied items are independent copies (mutating one side never
    // touches the other).
    fork.output.push({
      type: 'message',
      status: 'completed',
      role: 'user',
      messageId: 'fork-extra',
      content: [],
    });
    expect(
      ((getByokChat(chat.id) || { output: [] }: any).output: Array<any>).length
    ).toBe(4);
  });

  it('returns null for an unknown chat or message', () => {
    expect(forkByokChat('does-not-exist', 'm1')).toBe(null);
    const chat = makeChatWithMessages(['m1']);
    expect(forkByokChat(chat.id, 'not-a-message')).toBe(null);
  });
});

describe('the project snapshot store', () => {
  beforeEach(() => {
    resetByokSnapshotsForTests();
  });

  it('caps the snapshots at the last 5 (the 6th evicts the 1st)', () => {
    for (let index = 1; index <= 6; index++) {
      takeByokProjectSnapshot('chat', `m${index}`, `state-${index}`);
    }
    const snapshots = listByokProjectSnapshots('chat');
    expect(snapshots.length).toBe(BYOK_PROJECT_SNAPSHOT_CAPACITY);
    expect(getByokProjectSnapshot('chat', 'm1')).toBe(null);
    expect(getByokProjectSnapshot('chat', 'm2')).not.toBe(null);
    expect(getByokProjectSnapshot('chat', 'm6')).not.toBe(null);
  });

  it('drops the snapshots when the chat closes', () => {
    takeByokProjectSnapshot('chat', 'm1', 'state-1');
    dropByokChatSnapshots('chat');
    expect(listByokProjectSnapshots('chat')).toEqual([]);
  });
});

describe('restoring a project from a snapshot', () => {
  it('round-trips a real project through serialize → restore', () => {
    const realRestore: any = (jest.requireActual: any)('./ByokFork')
      .restoreByokProjectFromSnapshot;
    const mockRestore: any = restoreByokProjectFromSnapshot;
    mockRestore.mockImplementation(realRestore);
    const project = gd.ProjectHelper.createNewGDJSProject();
    try {
      project.setName('Before');
      project.insertNewLayout('Level 1', 0);
      const serialized = gd.Serializer.toJSON(
        (() => {
          const element = new gd.SerializerElement();
          project.serializeTo(element);
          return element;
        })()
      );
      // Mutate after the capture.
      project.setName('After');
      project.insertNewLayout('Level 2', 1);
      expect(project.getLayoutsCount()).toBe(2);

      restoreByokProjectFromSnapshot(project, {
        messageId: 'm1',
        serializedProject: serialized,
        takenAt: new Date().toISOString(),
      });
      expect(project.getName()).toBe('Before');
      expect(project.getLayoutsCount()).toBe(1);
      expect(project.hasLayoutNamed('Level 2')).toBe(false);
    } finally {
      project.delete();
    }
  });
});

describe('the restore_project_point tool', () => {
  let project: any = null;

  beforeEach(() => {
    resetByokSnapshotsForTests();
    project = gd.ProjectHelper.createNewGDJSProject();
  });

  afterEach(() => {
    project.delete();
    project = null;
  });

  const runRestoreTool = async (args: Object, chatId: ?string) => {
    const tool = findByNameokExtraTool('restore_project_point');
    if (!tool) throw new Error('restore_project_point not intercepted');
    return tool.run(args, {
      getProject: () => project,
      onSceneEventsModifiedOutsideEditor: (jest.fn(): any),
      byokChatId: chatId || undefined,
    });
  };

  it('is approval-gated (it overwrites the project)', () => {
    const tool = findByNameokExtraTool('restore_project_point');
    expect(tool && tool.modifiesProject).toBe(true);
  });

  it('restores a known point and refuses an unknown one', async () => {
    project.setName('Before');
    const serialized = serializeToJSON(project);
    project.setName('After');
    takeByokProjectSnapshot('chat-1', 'm3', serialized);

    const unknown = await runRestoreTool({ message_id: 'nope' }, 'chat-1');
    expect(unknown.output.success).toBe(false);
    expect(unknown.output.message).toContain('Available restore points');

    const mockRestore: any = restoreByokProjectFromSnapshot;
    mockRestore.mockImplementation(() => {
      project.setName('Before');
    });
    const restored = await runRestoreTool({ message_id: 'm3' }, 'chat-1');
    expect(restored.output.success).toBe(true);
    expect(restored.didModifyProject).toBe(true);
    expect(project.getName()).toBe('Before');
    expect(mockRestore).toHaveBeenCalledTimes(1);
  });

  it('answers with actionable failures without a project or chat', async () => {
    const restoreTool = findByNameokExtraTool('restore_project_point');
    if (!restoreTool) throw new Error('restore_project_point not intercepted');
    const noProject = await restoreTool.run(
      { message_id: 'm1' },
      {
        getProject: () => null,
        onSceneEventsModifiedOutsideEditor: (jest.fn(): any),
      }
    );
    expect(noProject.output.success).toBe(false);

    const noChat = await runRestoreTool({ message_id: 'm1' }, null);
    expect(noChat.output.success).toBe(false);
  });
});

describe('the snapshot lifecycle through the chat store', () => {
  it('archiving a chat drops its snapshots (wired in the seam)', () => {
    // The seam calls dropByokChatSnapshots before archiveByokChat: assert
    // the pieces compose (the seam itself is covered by useByokChatSeam).
    const chat = createByokChat();
    takeByokProjectSnapshot(chat.id, 'm1', 'state');
    dropByokChatSnapshots(chat.id);
    archiveByokChat(chat.id);
    expect(listByokProjectSnapshots(chat.id)).toEqual([]);
    // Archived since Phase 9.3: out of the default list, but restorable.
    const archivedChat = getByokChat(chat.id);
    expect(archivedChat && archivedChat.archivedAt).toBeTruthy();
  });
});
