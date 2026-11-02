// @flow
const {
  makeByokAtomicTempName,
  writeByokFileAtomically,
} = require('./ByokAtomicWriteCore');

const makeFakeFs = (overrides?: Object) => {
  const calls: Array<Object> = [];
  const unlinked: Array<string> = [];
  return {
    calls,
    unlinked,
    fs: {
      writeFileSync: (filePath: string, content: string) => {
        calls.push({ method: 'write', filePath, content });
      },
      renameSync: (from: string, to: string) => {
        calls.push({ method: 'rename', from, to });
      },
      unlinkSync: (filePath: string) => {
        unlinked.push(filePath);
      },
      ...(overrides || {}),
    },
  };
};

describe('makeByokAtomicTempName (ELEC-19)', () => {
  it('is unique per call even for the same target file', () => {
    const first = makeByokAtomicTempName('chat.md', 'aaa');
    const second = makeByokAtomicTempName('chat.md', 'bbb');
    expect(first).not.toBe(second);
    // The temp name still starts with the target, so an orphan is
    // recognizable as belonging to that file.
    expect(first.startsWith('chat.md.tmp-')).toBe(true);
  });
});

describe('writeByokFileAtomically', () => {
  it('writes to a temp file then renames over the target', () => {
    const { fs, calls } = makeFakeFs();
    const finalPath = writeByokFileAtomically(
      fs,
      '/chats',
      'chat.md',
      'hello',
      () => 'tok'
    );
    expect(finalPath).toContain('chat.md');
    expect(calls.map(call => call.method)).toEqual(['write', 'rename']);
    expect(calls[0].filePath).toContain('chat.md.tmp-');
    expect(calls[1].from).toBe(calls[0].filePath);
    expect(calls[1].to).toBe(finalPath);
  });

  it('removes the temp file and rethrows when the rename fails', () => {
    const { fs, calls, unlinked } = makeFakeFs({
      renameSync: () => {
        throw new Error('EBUSY: file is locked');
      },
    });
    expect(() =>
      writeByokFileAtomically(fs, '/chats', 'chat.md', 'hello', () => 'tok')
    ).toThrow('EBUSY: file is locked');
    // The partial temp must not linger: it would be enumerated as a chat.
    expect(unlinked.length).toBe(1);
    expect(unlinked[0]).toContain('chat.md.tmp-');
    expect(calls.filter(call => call.method === 'rename').length).toBe(0);
  });

  it('removes the temp file when the write itself fails', () => {
    const { fs, unlinked } = makeFakeFs({
      writeFileSync: () => {
        throw new Error('ENOSPC');
      },
    });
    expect(() =>
      writeByokFileAtomically(fs, '/chats', 'chat.md', 'hello', () => 'tok')
    ).toThrow('ENOSPC');
    expect(unlinked.length).toBe(1);
  });

  it('two concurrent writes of the same file never share a temp path', () => {
    const { fs, calls } = makeFakeFs();
    let counter = 0;
    const tokens: Array<string> = [];
    const nextToken = () => {
      counter += 1;
      tokens.push(`tok${counter}`);
      return tokens[tokens.length - 1];
    };
    writeByokFileAtomically(fs, '/chats', 'chat.md', 'a', nextToken);
    writeByokFileAtomically(fs, '/chats', 'chat.md', 'b', nextToken);
    const tempPaths = calls
      .filter(call => call.method === 'write')
      .map(call => call.filePath);
    expect(tempPaths.length).toBe(2);
    expect(tempPaths[0]).not.toBe(tempPaths[1]);
  });
});
