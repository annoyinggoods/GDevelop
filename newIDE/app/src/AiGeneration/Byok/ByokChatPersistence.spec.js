// @flow
import type { AiRequest } from '../../Utils/GDevelopServices/Generation';
import {
  BYOK_CHAT_INDEX_FILE_NAME,
  collectByokChatImageEntries,
  createByokChatFileStore,
  makeByokChatFileName,
  makeByokChatIndexEntryFromChat,
  makeByokChatName,
  parseByokChatFromMarkdown,
  parseByokChatIndex,
  serializeByokChatIndex,
  serializeByokChatToMarkdown,
  sortChatIndexEntries,
} from './ByokChatPersistence';
import { registerByokImage } from './ByokImageContent';

/**
 * The durable history tests run on an in-memory implementation of the
 * backend contract — the exact shape the Electron IPC backend and the
 * IndexedDB backend implement.
 */
const makeMemoryBackend = (): any => {
  const raw: Map<string, string> = new Map();
  return {
    raw,
    listFiles: async () =>
      Array.from(raw.keys()).map((fileName: string) => ({
        fileName,
        sizeBytes: (raw.get(fileName) || '').length,
      })),
    readFile: async (fileName: string) =>
      raw.has(fileName) ? raw.get(fileName) : null,
    writeFile: async (fileName: string, content: string) => {
      raw.set(fileName, content);
    },
    deleteFile: async (fileName: string) => {
      raw.delete(fileName);
    },
    moveFile: async (fromFileName: string, toFileName: string) => {
      const content = raw.get(fromFileName);
      if (content === undefined) return;
      raw.delete(fromFileName);
      raw.set(toFileName, content);
    },
    getTotalBytes: async () =>
      Array.from(raw.values()).reduce(
        (total, content) => total + content.length,
        0
      ),
  };
};

const makeChat = (overrides?: Object): AiRequest => {
  const now = '2026-09-24T10:00:00.000Z';
  return {
    id: 'byok-test-chat',
    createdAt: now,
    updatedAt: now,
    userId: '',
    status: 'ready',
    mode: 'orchestrator',
    error: null,
    output: [
      {
        type: 'message',
        status: 'completed',
        role: 'user',
        content: [
          {
            type: 'user_request',
            status: 'completed',
            text: 'create a forest scene with tall trees',
          },
        ],
      },
      {
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            status: 'completed',
            text: 'Scene created.',
            annotations: [],
          },
        ],
      },
    ],
    contextStats: null,
    ...overrides,
  };
};

describe('ByokChatPersistence: the Markdown codec', () => {
  it('round-trips a chat: create → serialize → parse → identical record', () => {
    const chat = makeChat();
    const serialized = serializeByokChatToMarkdown(chat);
    expect(serialized.startsWith('---')).toBe(true);

    const parsed = parseByokChatFromMarkdown(serialized);
    expect(parsed).not.toBe(null);
    expect(parsed && parsed.id).toBe(chat.id);
    expect(parsed && parsed.title).toContain('create a forest scene');
    expect(parsed && parsed.createdAt).toBe(chat.createdAt);
    expect(parsed && parsed.updatedAt).toBe(chat.updatedAt);
    expect(parsed && parsed.archivedAt).toBe(null);
    expect(parsed && parsed.output).toEqual(chat.output);
  });

  it('round-trips notice rows, tool outputs and image references', () => {
    const chat = makeChat({
      output: [
        {
          type: 'message',
          status: 'completed',
          role: 'user',
          content: [
            { type: 'user_request', status: 'completed', text: 'screenshot' },
          ],
        },
        {
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [
            {
              type: 'function_call',
              status: 'completed',
              call_id: 'call-1',
              name: 'capture_scene_screenshot',
              arguments: '{}',
            },
          ],
        },
        {
          type: 'function_call_output',
          call_id: 'call-1',
          output: '{"success":true}',
          images: ['img-7'],
        },
        {
          type: 'byok_notice',
          status: 'completed',
          noticeKind: 'context-summarized',
          text: 'Context summarized: 4 message(s) condensed.',
        },
      ],
    });
    const parsed = parseByokChatFromMarkdown(serializeByokChatToMarkdown(chat));
    expect(parsed && parsed.output).toEqual(chat.output);
  });

  it('round-trips a message that quotes markdown fences itself', () => {
    const chat = makeChat({
      output: [
        {
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              status: 'completed',
              text: 'Use this:\n```json\n{"tool_calls": []}\n```',
              annotations: [],
            },
          ],
        },
      ],
    });
    const parsed = parseByokChatFromMarkdown(serializeByokChatToMarkdown(chat));
    expect(parsed && parsed.output).toEqual(chat.output);
  });

  it('round-trips an archived chat (archive survives restarts)', () => {
    const chat = makeChat({ archivedAt: '2026-09-25T08:00:00.000Z' });
    const parsed = parseByokChatFromMarkdown(serializeByokChatToMarkdown(chat));
    expect(parsed && parsed.archivedAt).toBe('2026-09-25T08:00:00.000Z');
  });

  it('returns null on garbage, missing front matter or broken messages (quarantine input)', () => {
    expect(parseByokChatFromMarkdown('not a chat file')).toBe(null);
    expect(parseByokChatFromMarkdown('---\nid: "x"\n---\nno body')).toBe(null);
    expect(
      parseByokChatFromMarkdown('---\n"syntax": "error\n---\n```json\n{}\n```')
    ).toBe(null);
    expect(
      parseByokChatFromMarkdown(
        '---\nschema: "1"\nid: "x"\nname: "n"\ncreatedAt: "c"\nupdatedAt: "u"\nmessageCount: 99\n---\n```json\n{"type":"message","role":"user","content":[]}\n```'
      )
    ).toBe(null);
  });

  it('rejects a messageCount mismatch (a truncated file never loads half a chat)', () => {
    const chat = makeChat();
    let serialized = serializeByokChatToMarkdown(chat);
    serialized = serialized.replace('messageCount: "2"', 'messageCount: "5"');
    expect(parseByokChatFromMarkdown(serialized)).toBe(null);
  });
});

describe('ByokChatPersistence: the naming convention', () => {
  it('uses the first 5 words of the first prompt + the last-interaction date', () => {
    const name = makeByokChatName(makeChat());
    // The first 5 words of the first prompt + the last-interaction date.
    expect(name).toBe('create a forest scene with_2026-09-24');
  });

  it('makes a file-system-safe file name embedding the chat id (audit011026 B-UI-3)', () => {
    expect(
      makeByokChatFileName('create a forest scene_2026-09-24', 'byok-abc123')
    ).toBe('create-a-forest-scene_2026-09-24-byok-abc123.md');
    expect(makeByokChatFileName('a/b\\c:d*e?"f', 'byok-x')).not.toMatch(
      /[/\\:*?"]/
    );
    // The id suffix keeps two same-named chats from sharing a file.
    expect(makeByokChatFileName('same name', 'byok-1')).not.toBe(
      makeByokChatFileName('same name', 'byok-2')
    );
    expect(makeByokChatFileName('', 'byok-x')).toBe('chat-byok-x.md');
  });
});

describe('ByokChatPersistence: the file store', () => {
  it('saves and lists metas without loading the transcripts (lazy per chat)', async () => {
    const backend = makeMemoryBackend();
    const store = createByokChatFileStore(backend, () => null);
    await store.saveChat(makeChat());

    const metas = await store.listChatMetas();
    expect(metas).toHaveLength(1);
    expect(metas[0].messageCount).toBe(2);
    expect(metas[0].archivedAt).toBe(null);
    // The heavy transcript content never appears twice on disk.
    expect(backend.raw.size).toBe(1);
  });

  it('loads a chat back identically (round-trip through the store)', async () => {
    const backend = makeMemoryBackend();
    const store = createByokChatFileStore(backend, () => null);
    await store.saveChat(makeChat());

    const loaded = await store.loadChat('byok-test-chat');
    expect(loaded).not.toBe(null);
    expect(loaded && loaded.id).toBe('byok-test-chat');
    expect(loaded && loaded.output).toEqual(makeChat().output);
    expect(await store.loadChat('unknown')).toBe(null);
  });

  it('renames the file when the last-interaction date changes the name', async () => {
    const backend = makeMemoryBackend();
    const store = createByokChatFileStore(backend, () => null);
    await store.saveChat(makeChat());
    const firstName = (await store.listChatMetas())[0].fileName;

    const olderChat = makeChat({
      updatedAt: '2026-09-30T09:00:00.000Z',
    });
    await store.saveChat(olderChat);

    const metas = await store.listChatMetas();
    expect(metas).toHaveLength(1);
    expect(metas[0].fileName).not.toBe(firstName);
  });

  it('UI-6: a FAILED file move never leaves a duplicate of the same chat', async () => {
    const backend = makeMemoryBackend();
    // The move rejects the way the real IPC backend does when the main
    // process could not rename the file (locked, folder moved).
    const moveFile = backend.moveFile;
    backend.moveFile = async (fromFileName: string, toFileName: string) => {
      if (backend.failMoves) {
        throw new Error('EPERM: the file is in use');
      }
      return moveFile(fromFileName, toFileName);
    };
    backend.failMoves = false;

    const store = createByokChatFileStore(backend, () => null);
    await store.saveChat(makeChat());
    const firstName = (await store.listChatMetas())[0].fileName;

    backend.failMoves = true;
    await store.saveChat(makeChat({ updatedAt: '2026-09-30T09:00:00.000Z' }));

    // Reconciliation used to adopt the leftover file as a SECOND entry for
    // the same chat, so the Recents rail showed it twice and one copy was
    // orphaned forever. The chat now simply keeps its current file name.
    const metas = await store.listChatMetas();
    expect(metas).toHaveLength(1);
    expect(metas[0].fileName).toBe(firstName);
    const chatFiles = Array.from(backend.raw.keys()).filter(fileName =>
      fileName.endsWith('.md')
    );
    expect(chatFiles).toEqual([firstName]);
  });

  it('UI-6: a rename whose move fails keeps one file and stays renamable', async () => {
    const backend = makeMemoryBackend();
    const moveFile = backend.moveFile;
    backend.moveFile = async (fromFileName: string, toFileName: string) => {
      if (backend.failMoves) throw new Error('EPERM');
      return moveFile(fromFileName, toFileName);
    };
    backend.failMoves = true;

    const store = createByokChatFileStore(backend, () => null);
    await store.saveChat(makeChat());
    await store.renameChat('byok-test-chat', 'A brand new title');

    const metas = await store.listChatMetas();
    expect(metas).toHaveLength(1);
    const chatFiles = Array.from(backend.raw.keys()).filter(fileName =>
      fileName.endsWith('.md')
    );
    expect(chatFiles).toHaveLength(1);
    // The title is what the user asked for, even though the file could not
    // be renamed — the transcript content still carries it (the display name
    // adds the last-interaction date by convention).
    const loaded = await store.loadChat('byok-test-chat');
    expect(loaded && loaded.title).toContain('A brand new title');
  });

  it('moves a corrupt file aside and never lets it block the list', async () => {
    const backend = makeMemoryBackend();
    const store = createByokChatFileStore(backend, () => null);
    await backend.writeFile('broken.md', 'total garbage');
    await store.saveChat(makeChat());

    const metas = await store.listChatMetas();
    expect(metas).toHaveLength(1);
    // The corrupt file was quarantined (moved aside, marked corrupt).
    const fileNames = Array.from(backend.raw.keys());
    expect(fileNames.some(fileName => fileName.startsWith('corrupt-'))).toBe(
      true
    );
    // Listing again does not re-include it.
    expect(await store.listChatMetas()).toHaveLength(1);
  });

  it('archives, restores and explicitly deletes saved chats', async () => {
    const backend = makeMemoryBackend();
    const store = createByokChatFileStore(backend, () => null);
    await store.saveChat(makeChat());

    expect(
      await store.setArchived('byok-test-chat', '2026-09-25T00:00:00.000Z')
    ).toBe(true);
    let metas = await store.listChatMetas();
    expect(metas[0].archivedAt).toBe('2026-09-25T00:00:00.000Z');

    expect(await store.setArchived('byok-test-chat', null)).toBe(true);
    metas = await store.listChatMetas();
    expect(metas[0].archivedAt).toBe(null);

    expect(await store.deleteChat('byok-test-chat')).toBe(true);
    expect(await store.listChatMetas()).toHaveLength(0);
    expect(await store.deleteChat('byok-test-chat')).toBe(false);
  });

  it('stores image payloads in a sidecar entry, never inline in the file', async () => {
    const image = registerByokImage({
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
      width: 64,
      height: 64,
    });
    const chat = makeChat({
      output: [
        {
          type: 'function_call_output',
          call_id: 'call-1',
          output: '{"success":true}',
          images: [image.id],
        },
      ],
    });

    const backend = makeMemoryBackend();
    const store = createByokChatFileStore(backend, () => image);
    await store.saveChat(chat);

    const chatFileContent = Array.from(backend.raw.entries()).find(
      ([fileName]) => fileName.endsWith('.md')
    );
    expect(chatFileContent && chatFileContent[1].includes(image.dataUrl)).toBe(
      false
    );
    const sidecar = Array.from(backend.raw.entries()).find(([fileName]) =>
      fileName.endsWith('.images.json')
    );
    expect(sidecar).toBeTruthy();

    // The loaded chat re-registers the image under its original id.
    const loaded = await store.loadChat('byok-test-chat');
    expect(loaded).not.toBe(null);
  });

  it('UI-8: deletes the sidecar when a chat no longer references any image', async () => {
    const image = registerByokImage({
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
      width: 64,
      height: 64,
    });
    const chatWithImage = makeChat({
      output: [
        {
          type: 'function_call_output',
          call_id: 'call-1',
          output: '{"success":true}',
          images: [image.id],
        },
      ],
    });

    const backend = makeMemoryBackend();
    const store = createByokChatFileStore(backend, () => image);
    await store.saveChat(chatWithImage);
    expect(backend.raw.has('byok-test-chat.images.json')).toBe(true);

    // The images went away (a quota eviction, or a compaction dropping the
    // references). The stale sidecar used to stay forever — the orphan sweep
    // spares the sidecar of a chat that still exists, and the quota eviction
    // only runs while over cap — so its bytes counted against the quota.
    const storeWithoutImages = createByokChatFileStore(backend, () => null);
    await storeWithoutImages.saveChat(chatWithImage);
    expect(backend.raw.has('byok-test-chat.images.json')).toBe(false);
  });

  it('collects only the image entries the transcript references', () => {
    const image = registerByokImage({
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
      width: 64,
      height: 64,
    });
    const chat = makeChat({
      output: [
        {
          type: 'function_call_output',
          call_id: 'call-1',
          output: '{}',
          images: [image.id, 'missing-image-id'],
        },
      ],
    });
    const entries = collectByokChatImageEntries(chat, (id: string) =>
      id === image.id ? (image: any) : null
    );
    expect(Object.keys(entries)).toEqual([image.id]);
  });

  it('collects the images attached to user messages too (Phase 13.3)', () => {
    const toolImage = registerByokImage({
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
      width: 64,
      height: 64,
    });
    const attachedImage = registerByokImage({
      dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
      width: 32,
      height: 32,
    });
    const chat = makeChat({
      output: [
        {
          type: 'message',
          status: 'completed',
          role: 'user',
          content: [
            { type: 'user_request', status: 'completed', text: 'See this' },
          ],
          images: [attachedImage.id],
        },
        {
          type: 'function_call_output',
          call_id: 'call-1',
          output: '{}',
          images: [toolImage.id],
        },
      ],
    });
    const registry: any = {
      [toolImage.id]: toolImage,
      [attachedImage.id]: attachedImage,
    };
    const entries = collectByokChatImageEntries(
      chat,
      (id: string) => registry[id] || null
    );
    expect(Object.keys(entries).sort()).toEqual(
      [toolImage.id, attachedImage.id].sort()
    );
  });

  it('enforces the quota: image sidecars of the oldest chats evicted first', async () => {
    const backend = makeMemoryBackend();
    const store = createByokChatFileStore(backend, () => null);

    // Three small chats, each with a fat image sidecar; the newest chat
    // carries the transcript bulk.
    for (let index = 0; index < 3; index++) {
      const chat = makeChat({
        id: `byok-chat-${index}`,
        updatedAt: `2026-09-2${index}T10:00:00.000Z`,
        output: [
          {
            type: 'message',
            status: 'completed',
            role: 'user',
            content: [{ type: 'user_request', status: 'completed', text: 'x' }],
          },
        ],
      });
      await store.saveChat(chat);
      await backend.writeFile(
        `byok-chat-${index}.images.json`,
        JSON.stringify({ images: { [`img-${index}`]: 'x'.repeat(1000) } })
      );
    }

    const usageBefore = await store.getStorageUsage();
    expect(usageBefore.imageBytes).toBeGreaterThan(3000);

    // A cap that fits the transcripts but not all the sidecars.
    const transcriptBytes = usageBefore.totalBytes - usageBefore.imageBytes;
    const {
      evictedImageChatCount,
      evictedChatCount,
    } = await store.enforceQuota(transcriptBytes + 1500);
    expect(evictedImageChatCount).toBeGreaterThanOrEqual(2);
    expect(evictedChatCount).toBe(0);

    // The oldest sidecar went first.
    expect(backend.raw.has('byok-chat-0.images.json')).toBe(false);
    // Every transcript survived ("images before any transcript text").
    const metas = await store.listChatMetas();
    expect(metas).toHaveLength(3);
  });

  it('evicts whole chats only as the last resort (no images left to drop)', async () => {
    const backend = makeMemoryBackend();
    const store = createByokChatFileStore(backend, () => null);
    for (let index = 0; index < 2; index++) {
      await store.saveChat(
        makeChat({
          id: `byok-big-${index}`,
          updatedAt: `2026-09-2${index}T10:00:00.000Z`,
        })
      );
    }
    const usage = await store.getStorageUsage();
    // A cap the newer chat alone satisfies: evicting the oldest chat (the
    // sizes are equal) lands clearly under it, so exactly one chat goes.
    const {
      evictedImageChatCount,
      evictedChatCount,
    } = await store.enforceQuota(Math.floor(usage.totalBytes * 0.75));
    expect(evictedImageChatCount).toBe(0);
    expect(evictedChatCount).toBe(1);
    const remaining = await store.listChatMetas();
    expect(remaining).toHaveLength(1);
    // The OLDEST chat was evicted.
    expect(remaining[0].id).toBe('byok-big-1');
  });

  it('UI-7: quarantined files are evicted too, so the quota can be met', async () => {
    const backend = makeMemoryBackend();
    const store = createByokChatFileStore(backend, () => null);
    await store.saveChat(makeChat({ id: 'byok-kept' }));

    // Unparseable leftovers: they count against the quota from the first
    // check, but neither eviction loop iterates them (they are not index
    // entries), so the folder stayed over cap forever.
    const quarantinedBytes = 'x'.repeat(4000);
    await backend.writeFile('corrupt-old-chat.md', quarantinedBytes);
    await backend.writeFile('corrupt-other-chat.md', quarantinedBytes);

    const beforeQuota = (await store.getStorageUsage()).totalBytes;
    await store.enforceQuota(200);

    // No live chat was touched: the first chat is newer than the leftovers
    // by index order but the chat loop only runs when the non-chat files are
    // not enough — here they are, so the transcript survives.
    expect(backend.raw.has('corrupt-old-chat.md')).toBe(false);
    expect(backend.raw.has('corrupt-other-chat.md')).toBe(false);
    expect((await store.getStorageUsage()).totalBytes).toBeLessThanOrEqual(200);
    // Non-vacuity: the leftovers really did exceed the cap on their own.
    expect(beforeQuota).toBeGreaterThan(200 + 4000);
  });

  it('UI-7: the index file is the very last thing evicted', async () => {
    const backend = makeMemoryBackend();
    await createByokChatFileStore(backend, () => null).saveChat(
      makeChat({ id: 'byok-only' })
    );

    // A second session: the index is (re)created by the reconciliation of a
    // store that has never seen these files — which is exactly when the
    // quota sweep runs against a folder that holds one.
    const store = createByokChatFileStore(backend, () => null);
    await store.listChatMetas();
    expect(backend.raw.has('index.json')).toBe(true);

    // A cap no transcript can satisfy: everything goes, index included.
    await store.enforceQuota(0);
    expect(backend.raw.has('index.json')).toBe(false);
  });
});

describe('ByokChatPersistence: the chat index codec (B-UI-13)', () => {
  const makeIndexEntry = (overrides?: Object = {}) => ({
    id: 'byok-chat-1',
    fileName: 'a-chat-byok-chat-1.md',
    name: 'a chat_2026-09-24',
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T11:00:00.000Z',
    archivedAt: null,
    messageCount: 2,
    ...overrides,
  });

  it('round-trips entries through serializeByokChatIndex/parseByokChatIndex', () => {
    const entries = [
      makeIndexEntry(),
      makeIndexEntry({
        id: 'byok-chat-2',
        fileName: 'other-byok-chat-2.md',
        archivedAt: '2026-09-25T00:00:00.000Z',
      }),
    ];
    expect(parseByokChatIndex(serializeByokChatIndex(entries))).toEqual(
      entries
    );
  });

  it('treats missing, unparseable or foreign-shaped indexes as absent', () => {
    expect(parseByokChatIndex(null)).toBe(null);
    expect(parseByokChatIndex('')).toBe(null);
    expect(parseByokChatIndex('{not valid json')).toBe(null);
    expect(
      parseByokChatIndex(JSON.stringify({ schema: 99, entries: [] }))
    ).toBe(null);
    expect(parseByokChatIndex(JSON.stringify({ schema: 1 }))).toBe(null);
    // One malformed entry invalidates the whole index (full rebuild).
    expect(
      parseByokChatIndex(
        JSON.stringify({ schema: 1, entries: [makeIndexEntry(), { id: 'x' }] })
      )
    ).toBe(null);
  });

  it('derives an entry from a chat exactly like the listing did', () => {
    expect(makeByokChatIndexEntryFromChat('some-file.md', makeChat())).toEqual({
      id: 'byok-test-chat',
      fileName: 'some-file.md',
      name: 'create a forest scene with_2026-09-24',
      createdAt: '2026-09-24T10:00:00.000Z',
      updatedAt: '2026-09-24T10:00:00.000Z',
      archivedAt: null,
      messageCount: 2,
    });
  });

  it('sorts entries newest-updated first', () => {
    const sorted = sortChatIndexEntries([
      makeIndexEntry({ id: 'old', updatedAt: '2026-09-01T00:00:00.000Z' }),
      makeIndexEntry({ id: 'new', updatedAt: '2026-09-30T00:00:00.000Z' }),
    ]);
    expect(sorted.map(entry => entry.id)).toEqual(['new', 'old']);
  });
});

describe('ByokChatPersistence: the chat index in the store (B-UI-13)', () => {
  /**
   * A backend wrapper recording every readFile call, so the tests can
   * assert that steady-state operations never touch chat file contents.
   */
  const makeRecordingBackend = (base: any): any => {
    const readFileCalls: Array<string> = [];
    return {
      readFileCalls,
      listFiles: base.listFiles,
      readFile: async (fileName: string) => {
        readFileCalls.push(fileName);
        return base.readFile(fileName);
      },
      writeFile: base.writeFile,
      deleteFile: base.deleteFile,
      moveFile: base.moveFile,
      getTotalBytes: base.getTotalBytes,
    };
  };

  /** The chat file reads (`.md`, quarantined files excluded) so far. */
  const chatFileReads = (backend: any): Array<string> =>
    backend.readFileCalls.filter(
      (fileName: string) =>
        fileName.endsWith('.md') && !fileName.startsWith('corrupt-')
    );

  const seedThreeIndexedChats = async (): Promise<any> => {
    const base = makeMemoryBackend();
    const backend = makeRecordingBackend(base);
    const store = createByokChatFileStore(backend, () => null);
    for (let index = 0; index < 3; index++) {
      await store.saveChat(
        makeChat({
          id: `byok-indexed-${index}`,
          updatedAt: `2026-09-2${index}T10:00:00.000Z`,
        })
      );
    }
    return { base, backend, store };
  };

  const readPersistedIndex = (base: any): Array<any> =>
    parseByokChatIndex(base.raw.get(BYOK_CHAT_INDEX_FILE_NAME) || null) || [];

  it('steady-state listing is stat-only: no chat file is read again', async () => {
    const { backend, store } = await seedThreeIndexedChats();
    const metas = await store.listChatMetas();
    expect(metas).toHaveLength(3);
    backend.readFileCalls.length = 0;

    const metasAgain = await store.listChatMetas();
    expect(metasAgain).toHaveLength(3);
    expect(chatFileReads(backend)).toEqual([]);
  });

  it('saving an existing chat reads no chat file but its own', async () => {
    const { backend, store } = await seedThreeIndexedChats();
    const metas = await store.listChatMetas();
    const targetMeta = metas.find(meta => meta.id === 'byok-indexed-1');
    backend.readFileCalls.length = 0;

    await store.saveChat(
      makeChat({ id: 'byok-indexed-1', updatedAt: '2026-10-01T10:00:00.000Z' })
    );

    const otherFileReads = chatFileReads(backend).filter(
      fileName => !targetMeta || fileName !== targetMeta.fileName
    );
    expect(otherFileReads).toEqual([]);
  });

  it('loadChat resolves through the index: only the target chat file is read', async () => {
    const { backend, store } = await seedThreeIndexedChats();
    const metas = await store.listChatMetas();
    const targetMeta = metas.find(meta => meta.id === 'byok-indexed-2');
    backend.readFileCalls.length = 0;

    const loaded = await store.loadChat('byok-indexed-2');
    expect(loaded && loaded.id).toBe('byok-indexed-2');
    expect(loaded && loaded.output).toEqual(makeChat().output);
    expect(chatFileReads(backend)).toEqual(
      targetMeta ? [targetMeta.fileName] : []
    );
  });

  it('reconciles a chat file the index never saw (legacy/crash) and persists the index', async () => {
    const base = makeMemoryBackend();
    const backend = makeRecordingBackend(base);
    const store = createByokChatFileStore(backend, () => null);
    // A legacy file hand-placed on disk (no index entry, a file name that
    // predates the id embedding) — first run after the upgrade or a crash
    // between the chat write and the index write.
    await base.writeFile(
      'legacy-name.md',
      serializeByokChatToMarkdown(makeChat({ id: 'byok-legacy' }))
    );

    const metas = await store.listChatMetas();
    const legacyMeta = metas.find(meta => meta.id === 'byok-legacy');
    expect(legacyMeta).toBeTruthy();
    expect(legacyMeta && legacyMeta.fileName).toBe('legacy-name.md');
    expect(legacyMeta && legacyMeta.messageCount).toBe(2);
    expect(legacyMeta && legacyMeta.name).toBe(
      'create a forest scene with_2026-09-24'
    );
    // The reconciled index is persisted…
    expect(base.raw.has(BYOK_CHAT_INDEX_FILE_NAME)).toBe(true);

    // …so a brand-new store (a restart) lists it reading no chat content.
    const restartedBackend = makeRecordingBackend(base);
    const restartedStore = createByokChatFileStore(
      restartedBackend,
      () => null
    );
    const restartedMetas = await restartedStore.listChatMetas();
    expect(restartedMetas.map(meta => meta.id)).toEqual(['byok-legacy']);
    expect(chatFileReads(restartedBackend)).toEqual([]);
  });

  it("drops a stale index entry whose file was deleted behind the store's back", async () => {
    const base = makeMemoryBackend();
    const backend = makeRecordingBackend(base);
    const store = createByokChatFileStore(backend, () => null);
    await store.saveChat(
      makeChat({ id: 'byok-kept', updatedAt: '2026-09-20T10:00:00.000Z' })
    );
    await store.saveChat(
      makeChat({ id: 'byok-gone', updatedAt: '2026-09-21T10:00:00.000Z' })
    );
    // A stray file forces the index onto disk (adoption path).
    await base.writeFile(
      'stray.md',
      serializeByokChatToMarkdown(makeChat({ id: 'byok-stray' }))
    );
    const metasBefore = await store.listChatMetas();
    expect(metasBefore).toHaveLength(3);
    expect(base.raw.has(BYOK_CHAT_INDEX_FILE_NAME)).toBe(true);
    const goneMeta = metasBefore.find(meta => meta.id === 'byok-gone');
    if (!goneMeta) throw new Error('The gone chat meta is missing.');
    await base.deleteFile(goneMeta.fileName);

    const metasAfter = await store.listChatMetas();
    expect(metasAfter.map(meta => meta.id).sort()).toEqual([
      'byok-kept',
      'byok-stray',
    ]);
    // The dropped chat no longer loads either.
    expect(await store.loadChat('byok-gone')).toBe(null);
  });

  it('rebuilds silently from a corrupt index file', async () => {
    const base = makeMemoryBackend();
    const backend = makeRecordingBackend(base);
    const store = createByokChatFileStore(backend, () => null);
    await store.saveChat(
      makeChat({ id: 'byok-a', updatedAt: '2026-09-20T10:00:00.000Z' })
    );
    await store.saveChat(
      makeChat({ id: 'byok-b', updatedAt: '2026-09-21T10:00:00.000Z' })
    );
    await base.writeFile(
      'stray.md',
      serializeByokChatToMarkdown(makeChat({ id: 'byok-stray' }))
    );
    await store.listChatMetas();
    // Corrupt the persisted index behind the store's back, then restart.
    await base.writeFile(
      BYOK_CHAT_INDEX_FILE_NAME,
      '{"schema":1,"entries":[{ broken'
    );

    const restartedBackend = makeRecordingBackend(base);
    const restartedStore = createByokChatFileStore(
      restartedBackend,
      () => null
    );
    const metas = await restartedStore.listChatMetas();
    expect(metas.map(meta => meta.id).sort()).toEqual([
      'byok-a',
      'byok-b',
      'byok-stray',
    ]);
    // The rebuilt index was persisted back, valid again.
    expect(
      readPersistedIndex(base)
        .map(entry => entry.id)
        .sort()
    ).toEqual(['byok-a', 'byok-b', 'byok-stray']);
  });

  it('keeps the index consistent across rename, archive and delete', async () => {
    const base = makeMemoryBackend();
    const backend = makeRecordingBackend(base);
    const store = createByokChatFileStore(backend, () => null);
    await store.saveChat(
      makeChat({ id: 'byok-mutated', updatedAt: '2026-09-20T10:00:00.000Z' })
    );
    // A stray file forces the index onto disk, so every mutation below
    // rewrites it in place.
    await base.writeFile(
      'stray.md',
      serializeByokChatToMarkdown(makeChat({ id: 'byok-stray' }))
    );
    await store.listChatMetas();

    expect(await store.renameChat('byok-mutated', 'renamed chat title')).toBe(
      true
    );
    let metas = await store.listChatMetas();
    const renamedMeta = metas.find(meta => meta.id === 'byok-mutated');
    expect(renamedMeta && renamedMeta.name).toBe('renamed chat title');
    expect(renamedMeta && renamedMeta.fileName).toBe(
      makeByokChatFileName('renamed chat title', 'byok-mutated')
    );
    const renamedIndexEntries = readPersistedIndex(base).filter(
      entry => entry.id === 'byok-mutated'
    );
    expect(renamedIndexEntries).toHaveLength(1);
    expect(renamedIndexEntries[0].fileName).toBe(
      renamedMeta && renamedMeta.fileName
    );

    expect(
      await store.setArchived('byok-mutated', '2026-09-26T00:00:00.000Z')
    ).toBe(true);
    metas = await store.listChatMetas();
    const archivedMeta = metas.find(meta => meta.id === 'byok-mutated');
    expect(archivedMeta && archivedMeta.archivedAt).toBe(
      '2026-09-26T00:00:00.000Z'
    );
    const archivedIndexEntry = readPersistedIndex(base).find(
      entry => entry.id === 'byok-mutated'
    );
    expect(archivedIndexEntry && archivedIndexEntry.archivedAt).toBe(
      '2026-09-26T00:00:00.000Z'
    );

    expect(await store.deleteChat('byok-mutated')).toBe(true);
    metas = await store.listChatMetas();
    expect(metas.map(meta => meta.id)).toEqual(['byok-stray']);
    expect(readPersistedIndex(base).map(entry => entry.id)).toEqual([
      'byok-stray',
    ]);
  });

  it('quarantines a corrupt chat file during reconciliation and keeps it out of the index', async () => {
    const base = makeMemoryBackend();
    const backend = makeRecordingBackend(base);
    const store = createByokChatFileStore(backend, () => null);
    await base.writeFile('broken-legacy.md', 'total garbage');
    await base.writeFile(
      'legacy.md',
      serializeByokChatToMarkdown(makeChat({ id: 'byok-legacy' }))
    );

    const metas = await store.listChatMetas();
    expect(metas.map(meta => meta.id)).toEqual(['byok-legacy']);
    // Quarantined during the reconciliation pass, excluded from the index.
    expect(
      Array.from(base.raw.keys()).some(fileName =>
        fileName.startsWith('corrupt-')
      )
    ).toBe(true);
    expect(readPersistedIndex(base).map(entry => entry.id)).toEqual([
      'byok-legacy',
    ]);
  });
});
