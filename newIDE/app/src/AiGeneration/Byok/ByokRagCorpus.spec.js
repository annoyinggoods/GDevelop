// @flow
import {
  BYOK_RAG_CHUNK_OVERLAP_TOKENS,
  BYOK_RAG_CHUNK_TARGET_TOKENS,
  buildByokRagCorpus,
  buildByokRagExampleChunks,
  buildByokRagUserDocsChunks,
  chunkByokRagText,
  type ByokRagDocsFolderReader,
} from './Rag/ByokRagCorpus';

describe('chunkByokRagText (Phase 13.7 chunking)', () => {
  it('returns short texts as a single chunk', () => {
    expect(chunkByokRagText('Short text.')).toEqual(['Short text.']);
    expect(chunkByokRagText('   ')).toEqual([]);
  });

  it('chunks long texts on paragraph boundaries with overlap', () => {
    const paragraphs = [];
    for (let index = 0; index < 30; index++) {
      paragraphs.push(`Paragraph ${index}: ${'x'.repeat(300)}`);
    }
    const chunks = chunkByokRagText(paragraphs.join('\n\n'));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Chunks stay near the target (a hair above it with the overlap).
      expect(chunk.length).toBeLessThanOrEqual(
        (BYOK_RAG_CHUNK_TARGET_TOKENS + BYOK_RAG_CHUNK_OVERLAP_TOKENS) * 4 + 16
      );
    }
    // The overlap carries the tail of the previous chunk.
    expect(chunks[1].slice(0, 20)).toContain('x');
  });

  it('hard-splits paragraphs without sentence boundaries', () => {
    const chunks = chunkByokRagText('y'.repeat(5000));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].length).toBeLessThanOrEqual(
      BYOK_RAG_CHUNK_TARGET_TOKENS * 4
    );
  });

  it('is deterministic', () => {
    const text = Array.from(
      { length: 20 },
      (_, i) => `P${i}. One. Two. Three.`
    ).join('\n\n');
    expect(chunkByokRagText(text)).toEqual(chunkByokRagText(text));
  });
});

describe('the corpus builders', () => {
  it('builds the engine-reference chunks from the real catalog', () => {
    const {
      buildByokRagEngineReferenceChunks,
    } = require('./Rag/ByokRagCorpus');
    const chunks = buildByokRagEngineReferenceChunks();
    expect(chunks.length).toBeGreaterThan(1000);
    expect(chunks[0].source).toBe('engine-reference');
    expect(chunks.some(chunk => chunk.title === 'PlaySound')).toBe(true);
  });

  it('builds the docs, example and skill chunks', () => {
    const { buildByokRagDocsChunks } = require('./Rag/ByokRagCorpus');
    const docsChunks = buildByokRagDocsChunks();
    expect(docsChunks.length).toBeGreaterThan(10);
    expect(docsChunks.every(chunk => chunk.source === 'docs')).toBe(true);

    const exampleChunks = buildByokRagExampleChunks();
    expect(exampleChunks.length).toBeGreaterThanOrEqual(10);
    expect(exampleChunks.some(chunk => chunk.title.includes('timer'))).toBe(
      true
    );
  });

  it('builds the whole corpus in a stable order', async () => {
    const corpusA = await buildByokRagCorpus({});
    const corpusB = await buildByokRagCorpus({});
    expect(corpusA.length).toBeGreaterThan(1000);
    expect(corpusA.map(chunk => chunk.id)).toEqual(
      corpusB.map(chunk => chunk.id)
    );
    const sources = new Set(corpusA.map(chunk => chunk.source));
    expect(Array.from(sources).sort()).toEqual([
      'docs',
      'docs-min',
      'docs-min-map',
      'engine-reference',
      'example',
      'skill',
    ]);
    // The docs-min grades sit after the skills and before nothing else in
    // the bundled part (user docs are opt-in and last).
    const lastBundled = corpusA
      .filter(chunk => chunk.source !== 'user-docs')
      .map(chunk => chunk.source);
    expect(lastBundled[lastBundled.length - 1]).toBe('docs-min');
  });

  it('builds the minified-docs map chunks: one category browse-listing each (Phase 14.2)', () => {
    const {
      buildByokRagMinifiedDocsMapChunks,
    } = require('./Rag/ByokRagCorpus');
    const {
      listByokMinifiedDocCategories,
      getByokMinifiedDocPagesOfCategory,
    } = require('./ByokMinifiedDocs');
    const chunks = buildByokRagMinifiedDocsMapChunks();
    const categories = listByokMinifiedDocCategories();
    expect(chunks.length).toBeGreaterThanOrEqual(categories.length);
    for (const chunk of chunks) {
      expect(chunk.source).toBe('docs-min-map');
      expect(chunk.tags).toEqual(
        expect.arrayContaining(['docs-min-map', 'map'])
      );
      // audit011026 B-PROMPT-9: the map chunks no longer claim the page-chunk
      // tag — tags:["docs-min"] must hit pages, not maps.
      expect(chunk.tags).not.toContain('docs-min');
    }
    // A category with few pages is one map chunk listing exactly its pages.
    const smallCategory = categories.find(
      category =>
        getByokMinifiedDocPagesOfCategory(category).length > 0 &&
        getByokMinifiedDocPagesOfCategory(category).length < 20
    );
    if (!smallCategory) throw new Error('No small category in the artifact');
    const pages = getByokMinifiedDocPagesOfCategory(smallCategory);
    // Listing lines have the exact `path — title — summary` shape (the
    // header line contains an em dash too, so match the shape); a category
    // line-packs into as many map chunks as it needs.
    const mapChunksOfCategory = chunks.filter(chunk =>
      chunk.tags.includes(smallCategory)
    );
    expect(mapChunksOfCategory.length).toBeGreaterThanOrEqual(1);
    const lines = mapChunksOfCategory
      .flatMap(chunk => chunk.text.split('\n'))
      .filter(line => /^\S+\.md — .+ — /.test(line));
    expect(lines).toHaveLength(pages.length);
    for (const page of pages) {
      expect(lines.some(line => line.startsWith(`${page.path} — `))).toBe(true);
    }
    // A big category is line-packed into several self-describing chunks.
    const bigCategory = categories.find(
      category => getByokMinifiedDocPagesOfCategory(category).length > 100
    );
    if (!bigCategory) throw new Error('No big category in the artifact');
    const bigMapChunks = chunks.filter(chunk =>
      chunk.tags.includes(bigCategory)
    );
    expect(bigMapChunks.length).toBeGreaterThan(1);
    for (const chunk of bigMapChunks) {
      expect(chunk.text).toContain(`category map "${bigCategory}"`);
      // One page per line — a listing is never sentence-mangled.
      expect(
        chunk.text
          .split('\n')
          .slice(1)
          .every(line => line.includes(' — '))
      ).toBe(true);
    }
    // Deterministic: the same inputs build the same chunks.
    expect(buildByokRagMinifiedDocsMapChunks().map(c => c.id)).toEqual(
      chunks.map(c => c.id)
    );
  });

  it('packs whole lines into size-capped chunks without splitting a line', () => {
    const { packByokRagLines } = require('./Rag/ByokRagCorpus');
    expect(packByokRagLines(['only one line'])).toEqual(['only one line']);
    expect(packByokRagLines([])).toEqual([]);
    const lines = Array.from(
      { length: 20 },
      (_, index) =>
        `page-${index}.md — Title ${index} — Summary of page ${index}.`
    );
    const packed = packByokRagLines(lines, 50);
    expect(packed.length).toBeGreaterThan(1);
    for (const part of packed) {
      expect(part.length).toBeLessThanOrEqual(50 * 4 + 200);
      for (const line of part.split('\n')) {
        expect(lines).toContain(line);
      }
    }
    expect(packed.join('\n').split('\n')).toEqual(lines);
  });

  it('builds the minified-docs page chunks with the read_doc_page pointer on every chunk (Phase 14.2)', () => {
    const {
      buildByokRagMinifiedDocsPageChunks,
    } = require('./Rag/ByokRagCorpus');
    const { getByokMinifiedDocPages } = require('./ByokMinifiedDocs');
    const pages = getByokMinifiedDocPages();
    const chunks = buildByokRagMinifiedDocsPageChunks();
    // Every wiki page yields at least one chunk.
    expect(chunks.length).toBeGreaterThanOrEqual(pages.length);
    const pathsCovered = new Set(
      chunks.map(chunk =>
        chunk.id
          .split(':')
          .slice(1, -1)
          .join(':')
      )
    );
    for (const page of pages) {
      expect(pathsCovered.has(page.path)).toBe(true);
    }
    for (const chunk of chunks.slice(0, 50)) {
      expect(chunk.source).toBe('docs-min');
      expect(chunk.tags).toContain('docs-min');
      const pagePath = chunk.id
        .split(':')
        .slice(1, -1)
        .join(':');
      expect(chunk.text).toContain(`Full page: read_doc_page('${pagePath}').`);
      expect(chunk.text).toContain(chunk.title);
    }
    // Deterministic ids (the corpus hash depends on it).
    expect(buildByokRagMinifiedDocsPageChunks().map(c => c.id)).toEqual(
      chunks.map(c => c.id)
    );
  });

  it('indexes the opt-in local docs folder through the injected reader', async () => {
    const reader: ByokRagDocsFolderReader = {
      listMarkdownFiles: async () => ['C:/docs/a.md', 'C:/docs/b.md'],
      readFile: async (filePath: string) =>
        filePath.endsWith('a.md') ? 'Doc A content here.' : '',
    };
    const chunks = await buildByokRagUserDocsChunks('C:/docs', reader);
    expect(chunks.length).toBe(1);
    expect(chunks[0].source).toBe('user-docs');
    expect(chunks[0].title).toBe('a.md');

    // An unreadable folder contributes nothing, without throwing.
    const failing: ByokRagDocsFolderReader = {
      listMarkdownFiles: async () => {
        throw new Error('gone');
      },
      readFile: async () => '',
    };
    expect(await buildByokRagUserDocsChunks('C:/gone', failing)).toEqual([]);

    // No folder configured: no chunks, no reader call.
    expect(await buildByokRagUserDocsChunks('', reader)).toEqual([]);
  });
});

describe('chunkByokRagText: fenced code blocks (audit011026 B-RAG-14)', () => {
  it('never splits a fence containing a blank line across chunks', () => {
    const text = [
      'Intro paragraph.',
      '',
      '```js',
      'const a = 1;',
      '',
      'const b = 2;',
      '```',
      '',
      'Outro paragraph.',
    ].join('\n');
    const chunks = chunkByokRagText(text, 30);
    // The fence (opener + body + closer) must live inside ONE chunk.
    const fenceChunks = chunks.filter(chunk => chunk.includes('```'));
    expect(fenceChunks).toHaveLength(1);
    expect(fenceChunks[0]).toContain('const a = 1;');
    expect(fenceChunks[0]).toContain('const b = 2;');
  });
});

describe('chunkByokRagText: the overlap boundary (audit100226 RAG-11)', () => {
  const makeParagraphs = (count: number) =>
    Array.from(
      { length: count },
      (_, index) =>
        `Paragraph ${index} discusses the ${'topic '.repeat(20)}${index}.`
    ).join('\n\n');

  const countFenceMarkers = (text: string): number =>
    (text.match(/^\s*(?:```|~~~)/gm) || []).length;

  it('never starts a chunk in the middle of a word', () => {
    const text = makeParagraphs(8);
    const chunks = chunkByokRagText(text, 40);
    expect(chunks.length).toBeGreaterThan(2);

    // A raw slice(-overlapChars) cut lands inside a word often enough to be
    // visible: every non-first chunk must begin with a word the source text
    // actually contains.
    const sourceWords = new Set(text.split(/\s+/));
    const starters = chunks.slice(1).map(chunk => chunk.split(/\s+/)[0]);
    for (const starter of starters) {
      expect(sourceWords.has(starter)).toBe(true);
    }

    // Non-vacuity: with no overlap at all this test would pass trivially, so
    // require that the overlap really changed the output.
    expect(chunkByokRagText(text, 40, 0)).not.toEqual(chunks);
  });

  it('does not carry an overlap out of the middle of a fenced block', () => {
    // A fence longer than one chunk is hard-split, so a chunk can end inside
    // the fence. The overlap must not then re-open the next chunk with fence
    // body — code the model would read as prose.
    const codeLines = Array.from(
      { length: 40 },
      (_, index) => `const value${index} = compute(${index});`
    );
    const text = [
      'Intro.',
      '',
      '```js',
      ...codeLines,
      '```',
      '',
      'Outro.',
    ].join('\n');
    const chunks = chunkByokRagText(text, 40);

    let inspectedBoundaries = 0;
    for (let index = 1; index < chunks.length; index++) {
      const previousChunk = chunks[index - 1];
      if (countFenceMarkers(previousChunk) % 2 === 0) continue;
      inspectedBoundaries++;
      const previousLines = new Set(previousChunk.trim().split('\n'));
      const repeatedLines = chunks[index]
        .trim()
        .split('\n')
        .filter(line => previousLines.has(line));
      expect(repeatedLines).toEqual([]);
    }
    // Non-vacuity: the fixture must actually produce a boundary inside the
    // fence, otherwise the assertion above checked nothing.
    expect(inspectedBoundaries).toBeGreaterThan(0);
  });
});

describe('buildByokRagUserDocsChunks: stable, distinguishing ids (audit100226 RAG-8)', () => {
  const makeTwoSameNamedFilesReader = (): ByokRagDocsFolderReader => ({
    listMarkdownFiles: async () => [
      'C:/docs/design/notes.md',
      'C:/docs/notes.md',
    ],
    readFile: async (filePath: string) =>
      filePath.endsWith('design/notes.md')
        ? 'The design folder keeps its own notes about the game loop.'
        : 'The root notes describe the release checklist for the game.',
  });

  it('titles chunks by their folder-relative path, not the bare file name', async () => {
    const chunks = await buildByokRagUserDocsChunks(
      'C:/docs',
      makeTwoSameNamedFilesReader()
    );
    expect(chunks.length).toBe(2);
    expect(chunks.map(chunk => chunk.title).sort()).toEqual([
      'design/notes.md',
      'notes.md',
    ]);
    // Distinct ids: two same-named files are two different documents.
    expect(chunks[0].id).not.toBe(chunks[1].id);
  });

  it('keeps the same ids when an earlier file grows by a chunk', async () => {
    const reader = makeTwoSameNamedFilesReader();
    const before = await buildByokRagUserDocsChunks('C:/docs', reader);

    const grownReader: ByokRagDocsFolderReader = {
      listMarkdownFiles: reader.listMarkdownFiles,
      readFile: async (filePath: string) =>
        filePath.endsWith('design/notes.md')
          ? `${await reader.readFile(filePath)}\n\n${'more '.repeat(900)}`
          : reader.readFile(filePath),
    };
    const after = await buildByokRagUserDocsChunks('C:/docs', grownReader);

    const rootChunkBefore = before.find(chunk => chunk.title === 'notes.md');
    const rootChunkAfter = after.find(chunk => chunk.title === 'notes.md');
    expect(rootChunkAfter).toBeTruthy();
    // The id used to embed the running chunk count, so ANY earlier file
    // growing by one chunk silently renamed every later chunk.
    expect(rootChunkAfter && rootChunkAfter.id).toBe(
      rootChunkBefore && rootChunkBefore.id
    );
  });

  it('falls back to the file name for a path outside the chosen folder', async () => {
    const reader: ByokRagDocsFolderReader = {
      listMarkdownFiles: async () => ['C:/elsewhere/other.md'],
      readFile: async () => 'Some other document about enemy waves.',
    };
    const chunks = await buildByokRagUserDocsChunks('C:/docs', reader);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].title).toBe('other.md');
  });
});
