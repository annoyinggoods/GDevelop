// @flow
import {
  BYOK_TEXT_ATTACHMENT_MAX_BYTES,
  buildByokAttachMenuTemplate,
  buildByokTextAttachmentBlock,
  buildByokUserMessageWithAttachments,
  byokContentLooksBinary,
  getByokAttachmentImageIds,
  isByokImageAttachmentExtension,
  isByokTextAttachmentExtension,
  readByokImageAttachment,
  readByokTextAttachment,
} from './ByokAttachments';

const makeFsLike = (files: { [path: string]: string }) => ({
  promises: {
    readFile: async (path: string) => {
      if (!(path in files)) throw new Error('ENOENT');
      return (global: any).Buffer.from(files[path], 'utf8');
    },
  },
});

describe('isByokTextAttachmentExtension', () => {
  it('accepts the text extensions, case-insensitively', () => {
    expect(isByokTextAttachmentExtension('notes.md')).toBe(true);
    expect(isByokTextAttachmentExtension('DATA.JSON')).toBe(true);
    expect(isByokTextAttachmentExtension('script.py')).toBe(true);
  });

  it('refuses binaries and extension-less files', () => {
    expect(isByokTextAttachmentExtension('image.png')).toBe(false);
    expect(isByokTextAttachmentExtension('archive.zip')).toBe(false);
    expect(isByokTextAttachmentExtension('README')).toBe(false);
  });
});

describe('byokContentLooksBinary', () => {
  it('detects a NUL byte', () => {
    expect(byokContentLooksBinary('abc\u0000def')).toBe(true);
  });

  it('passes plain text', () => {
    expect(byokContentLooksBinary('hello\nworld')).toBe(false);
  });
});

describe('readByokTextAttachment', () => {
  it('reads a text file into an attachment', async () => {
    const fsLike = makeFsLike({ 'C:/tmp/notes.md': '# Notes' });
    const result = await readByokTextAttachment(fsLike, 'C:/tmp/notes.md');
    if (!result.ok) throw new Error('expected ok');
    expect(result.attachment).toEqual({
      kind: 'text',
      name: 'notes.md',
      content: '# Notes',
      truncated: false,
    });
  });

  it('refuses a non-text extension with a friendly error', async () => {
    const fsLike = makeFsLike({ 'C:/tmp/program.exe': 'MZ...' });
    const result = await readByokTextAttachment(fsLike, 'C:/tmp/program.exe');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('text file');
  });

  it('refuses content with a NUL byte even under a text extension', async () => {
    const fsLike = makeFsLike({ 'C:/tmp/fake.txt': 'abc\u0000def' });
    const result = await readByokTextAttachment(fsLike, 'C:/tmp/fake.txt');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('binary');
  });

  it('caps the content at the byte cap and marks it truncated', async () => {
    const longContent = 'a'.repeat(BYOK_TEXT_ATTACHMENT_MAX_BYTES + 500);
    const fsLike = makeFsLike({ 'C:/tmp/big.txt': longContent });
    const result = await readByokTextAttachment(fsLike, 'C:/tmp/big.txt');
    if (!result.ok) throw new Error('expected ok');
    expect(result.attachment.truncated).toBe(true);
    expect(((result.attachment: any).content: string).length).toBe(
      BYOK_TEXT_ATTACHMENT_MAX_BYTES
    );
  });

  it('reports unreadable files', async () => {
    const fsLike = makeFsLike({});
    const result = await readByokTextAttachment(fsLike, 'C:/tmp/gone.md');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('could not be read');
  });
});

describe('isByokImageAttachmentExtension', () => {
  it('accepts png, jpg and webp', () => {
    expect(isByokImageAttachmentExtension('shot.png')).toBe(true);
    expect(isByokImageAttachmentExtension('photo.JPG')).toBe(true);
    expect(isByokImageAttachmentExtension('anim.webp')).toBe(true);
    expect(isByokImageAttachmentExtension('doc.pdf')).toBe(false);
  });
});

describe('readByokImageAttachment', () => {
  const makeImageFs = (files: { [path: string]: string }) => ({
    promises: {
      readFile: async (path: string) => {
        if (!(path in files)) throw new Error('ENOENT');
        return (global: any).Buffer.from(files[path], 'binary');
      },
    },
  });

  it('registers the file through the image store as a data URL', async () => {
    const storeImage = (jest.fn(async () => ({ id: 'byok-img-1' })): any);
    const fsLike = makeImageFs({ 'C:/tmp/shot.png': '\x89PNG-data' });
    const result = await readByokImageAttachment(
      fsLike,
      'C:/tmp/shot.png',
      storeImage
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.attachment).toEqual({
      kind: 'image',
      name: 'shot.png',
      imageId: 'byok-img-1',
    });
    expect(storeImage).toHaveBeenCalledWith(
      expect.stringMatching(/^data:image\/png;base64,/)
    );
  });

  it('refuses non-image extensions', async () => {
    const storeImage = (jest.fn(async () => ({ id: 'x' })): any);
    const fsLike = makeImageFs({ 'C:/tmp/file.txt': 'hello' });
    const result = await readByokImageAttachment(
      fsLike,
      'C:/tmp/file.txt',
      storeImage
    );
    expect(result.ok).toBe(false);
    expect(storeImage).not.toHaveBeenCalled();
  });

  it('reports a failing image store as a decode failure', async () => {
    const storeImage = (jest.fn(async () => {
      throw new Error('decode failed');
    }): any);
    const fsLike = makeImageFs({ 'C:/tmp/broken.png': '\x89PNG' });
    const result = await readByokImageAttachment(
      fsLike,
      'C:/tmp/broken.png',
      storeImage
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('decoded');
  });
});

describe('buildByokTextAttachmentBlock', () => {
  it('wraps the content in a fenced block with the filename header', () => {
    const block = buildByokTextAttachmentBlock({
      kind: 'text',
      name: 'notes.md',
      content: '# Hello',
      truncated: false,
    });
    expect(block).toContain('[Attached file: notes.md]');
    expect(block).toContain('```\n# Hello\n```');
    expect(block).not.toContain('truncated');
  });

  it('adds the truncation note when the attachment was capped', () => {
    const block = buildByokTextAttachmentBlock({
      kind: 'text',
      name: 'big.txt',
      content: 'aaa',
      truncated: true,
    });
    expect(block).toContain(
      `[The file was truncated at ${BYOK_TEXT_ATTACHMENT_MAX_BYTES} characters`
    );
  });
});

describe('buildByokUserMessageWithAttachments', () => {
  it('appends the text attachments after the typed message, in order', () => {
    const composed = buildByokUserMessageWithAttachments('Please review', [
      { kind: 'text', name: 'a.txt', content: 'AAA', truncated: false },
      { kind: 'image', name: 'shot.png', imageId: 'img-1' },
      { kind: 'text', name: 'b.md', content: 'BBB', truncated: false },
    ]);
    expect(composed.startsWith('Please review')).toBe(true);
    const aIndex = composed.indexOf('[Attached file: a.txt]');
    const bIndex = composed.indexOf('[Attached file: b.md]');
    expect(aIndex).toBeGreaterThan(-1);
    expect(bIndex).toBeGreaterThan(aIndex);
  });

  it('returns the text untouched without text attachments', () => {
    expect(
      buildByokUserMessageWithAttachments('Hello', [
        { kind: 'image', name: 'shot.png', imageId: 'img-1' },
      ])
    ).toBe('Hello');
  });
});

describe('getByokAttachmentImageIds', () => {
  it('collects the image ids in order and drops the text entries', () => {
    expect(
      getByokAttachmentImageIds([
        { kind: 'text', name: 'a.txt', content: 'AAA', truncated: false },
        { kind: 'image', name: 'one.png', imageId: 'img-1' },
        { kind: 'image', name: 'two.png', imageId: 'img-2' },
      ])
    ).toEqual(['img-1', 'img-2']);
  });
});

describe('buildByokAttachMenuTemplate', () => {
  const translate = (message: string) => message;

  it('offers both entries when the chat can use vision', () => {
    const onAttachTextFile = (jest.fn(): any);
    const onAttachImageFile = (jest.fn(): any);
    const items = buildByokAttachMenuTemplate(translate, {
      canAttachImages: true,
      onAttachTextFile,
      onAttachImageFile,
    });
    expect(items.map(item => item.label)).toEqual([
      'Attach text file…',
      'Attach image…',
    ]);
    items[0].click();
    expect(onAttachTextFile).toHaveBeenCalled();
    items[1].click();
    expect(onAttachImageFile).toHaveBeenCalled();
  });

  it('hides the image entry without vision (D13-5)', () => {
    const items = buildByokAttachMenuTemplate(translate, {
      canAttachImages: false,
      onAttachTextFile: () => {},
      onAttachImageFile: () => {},
    });
    expect(items.map(item => item.label)).toEqual(['Attach text file…']);
  });
});
