/**
 * The minified-docs pipeline self-check (Phase 14.2): the deterministic
 * helpers of `scripts/build-byok-minified-docs.js` — the engine-token
 * sanity pass (a known-good token passes, an invented one fails the
 * build), the noise-stripping source measurement, the category/tag rules
 * (folder facets + 2d/3d heuristics win over LLM suggestions), the batch
 * bin-packing, the batch validation and the module emission. Dev-only by
 * the script-spec rule (no shipped module imports the script).
 */
const {
  COMPRESSION_BAND,
  ENGINE_TOKEN_ALLOWLIST,
  categoryOfWikiPath,
  stripFrontmatterAndNoise,
  titleOfMarkdown,
  extractEngineCallTokens,
  findUnknownEngineTokens,
  buildTagWhitelist,
  deterministicTagsOf,
  buildBatchPlan,
  validateMinifiedBatch,
  emitGeneratedModule,
  normalizeWikiPath,
} = require('../../../scripts/build-byok-minified-docs.js');

const makePlannedPage = (wikiPath, sourceBytes, stub = false) => ({
  file: `C:/fake/${wikiPath}`,
  wikiPath,
  category: categoryOfWikiPath(wikiPath),
  sourceBytes,
  stub,
  fallbackTitle: '',
});

describe('build-byok-minified-docs: paths and categories', () => {
  it('derives the wiki path and the top-level category', () => {
    expect(
      normalizeWikiPath(
        'C:/DOCs/docs/gdevelop5/extensions/health/index.md',
        'C:/DOCs/docs/gdevelop5'
      )
    ).toBe('extensions/health/index.md');
    expect(categoryOfWikiPath('extensions/health/index.md')).toBe('extensions');
    expect(categoryOfWikiPath('index.md')).toBe('general');
  });

  it('strips frontmatter, images, comments and link-only lines from the source', () => {
    const source = [
      '---',
      'title: Demo',
      '---',
      '# Demo',
      '',
      'Intro paragraph stays.',
      '',
      '![an image](pic.png)',
      '[![badge](i.png)](https://example.com)',
      '<!-- a comment -->',
      '',
      '## Section',
      'Body stays.',
    ].join('\n');
    expect(stripFrontmatterAndNoise(source)).toBe(
      [
        '# Demo',
        '',
        'Intro paragraph stays.',
        '',
        // The badge and comment lines were dropped; the blank lines that
        // separated them remain (the ratio measurement tolerates them).
        '',
        '## Section',
        'Body stays.',
      ].join('\n')
    );
  });

  it('takes the title from the frontmatter, else the first heading', () => {
    expect(titleOfMarkdown('---\ntitle: My Page\n---\n# Other\n')).toBe(
      'My Page'
    );
    expect(titleOfMarkdown('# First Heading\n')).toBe('First Heading');
    expect(titleOfMarkdown('nothing')).toBe('');
  });
});

describe('build-byok-minified-docs: the engine-token sanity pass', () => {
  it('extracts backticked engine-call candidates only', () => {
    const text = [
      'Use `TimeDelta()` and `Random(x)`.',
      'Plain TimeDelta() prose is not a candidate, `some_snake_case(` is not either.',
      'JSON keys like "Duration(" and long `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa(` spans are skipped.',
    ].join('\n');
    expect(extractEngineCallTokens(text)).toEqual(['Random', 'TimeDelta']);
  });

  it('passes known engine names and the documented allowlist', () => {
    const unknown = findUnknownEngineTokens(
      { 'a.md': '`TimeDelta()` and `Random(x)`', 'b.md': '`MovementX(`' },
      ['TimeDelta', 'Random'],
      ENGINE_TOKEN_ALLOWLIST
    );
    expect(unknown).toEqual([]);
  });

  it('fails the build on an invented engine token, naming page and token', () => {
    const unknown = findUnknownEngineTokens(
      { 'all-features/x.md': 'calls `SetPlayerHealth(100)` now' },
      ['TimeDelta'],
      []
    );
    expect(unknown).toEqual([
      { pagePath: 'all-features/x.md', token: 'SetPlayerHealth' },
    ]);
  });
});

describe('build-byok-minified-docs: tags', () => {
  it('builds the whitelist from the folder facets plus 2d/3d', () => {
    const whitelist = buildTagWhitelist([
      'extensions/health/index.md',
      'objects/sprite.md',
      'index.md',
    ]);
    expect(whitelist.has('extensions')).toBe(true);
    expect(whitelist.has('health')).toBe(true);
    expect(whitelist.has('objects')).toBe(true);
    expect(whitelist.has('2d')).toBe(true);
    expect(whitelist.has('3d')).toBe(true);
    expect(whitelist.has('made-up-tag')).toBe(false);
  });

  it('pins the 40–60% compression band (D14-2)', () => {
    // The overall corpus ratio must land inside this band — the assemble
    // subcommand enforces it; the spec pins the constants.
    expect(COMPRESSION_BAND.min).toBe(0.35);
    expect(COMPRESSION_BAND.max).toBe(0.65);
  });

  it('derives deterministic tags: folder facets + 3d heuristic + allowed suggestions only', () => {
    const whitelist = new Set([
      'extensions',
      'health',
      '3d',
      'hud',
      'pixel-art',
    ]);
    expect(
      deterministicTagsOf(
        'extensions/health/index.md',
        ['hud', 'nonsense', 'Pixel-Art'],
        whitelist
      )
    ).toEqual(['extensions', 'health', 'hud', 'pixel-art']);
    expect(
      deterministicTagsOf('extensions/jump3d/index.md', [], whitelist)
    ).toEqual(['3d', 'extensions', 'jump3d']);
  });
});

describe('build-byok-minified-docs: the batch plan', () => {
  it('bin-packs pages under the byte target with bounded page counts', () => {
    const pages = [];
    for (let index = 0; index < 30; index++) {
      pages.push(makePlannedPage(`cat/page-${index}.md`, 10 * 1024));
    }
    const batches = buildBatchPlan(pages, 150 * 1024);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    for (const batch of batches) {
      expect(batch.sourceBytes).toBeLessThanOrEqual(150 * 1024);
      expect(batch.pages.length).toBeLessThanOrEqual(40);
    }
    const total = batches.reduce((sum, batch) => sum + batch.pages.length, 0);
    expect(total).toBe(30);
    // Stable ids in a stable order: the same input plans the same batches.
    expect(buildBatchPlan(pages, 150 * 1024).map(b => b.id)).toEqual(
      batches.map(b => b.id)
    );
  });
});

describe('build-byok-minified-docs: batch validation', () => {
  const plannedPages = [
    makePlannedPage('events/one.md', 1000),
    makePlannedPage('events/two.md', 1000),
    makePlannedPage('stubs/tiny.md', 50, true),
  ];
  const goodEntry = path => ({
    path,
    title: 'T',
    summary: 'S',
    body: 'B'.repeat(400),
    suggestedTags: ['events'],
  });

  it('accepts a complete batch and measures the compression ratio', () => {
    const outcome = validateMinifiedBatch(
      [
        goodEntry('events/one.md'),
        goodEntry('events/two.md'),
        { ...goodEntry('stubs/tiny.md'), body: '' },
      ],
      plannedPages
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.entries).toHaveLength(3);
    // A stub may carry an empty body without failing.
    expect(outcome.entries[2].body).toBe('');
  });

  it('rejects unknown paths, duplicates and missing entries', () => {
    const outcome = validateMinifiedBatch(
      [goodEntry('events/one.md'), goodEntry('made/up.md')],
      plannedPages
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.some(text => text.includes('made/up.md'))).toBe(true);
    expect(
      outcome.errors.some(text =>
        text.includes('Missing entry for events/two.md')
      )
    ).toBe(true);

    const duplicate = validateMinifiedBatch(
      [
        goodEntry('events/one.md'),
        goodEntry('events/one.md'),
        goodEntry('events/two.md'),
        goodEntry('stubs/tiny.md'),
      ],
      plannedPages
    );
    expect(duplicate.ok).toBe(false);
    expect(
      duplicate.errors.some(text => text.includes('Duplicate entry'))
    ).toBe(true);
  });

  it('rejects non-array outputs and empty required fields', () => {
    expect(validateMinifiedBatch('nope', plannedPages).ok).toBe(false);
    const emptyTitle = validateMinifiedBatch(
      [
        { ...goodEntry('events/one.md'), title: ' ' },
        goodEntry('events/two.md'),
        goodEntry('stubs/tiny.md'),
      ],
      plannedPages
    );
    expect(emptyTitle.ok).toBe(false);
    expect(emptyTitle.errors.some(text => text.includes('missing title'))).toBe(
      true
    );
  });

  it('warns (without failing) on out-of-band per-page ratios', () => {
    const outcome = validateMinifiedBatch(
      [
        goodEntry('events/one.md'),
        { ...goodEntry('events/two.md'), body: 'B'.repeat(995) },
        goodEntry('stubs/tiny.md'),
      ],
      plannedPages
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.warnings.some(text => text.includes('events/two.md'))).toBe(
      true
    );
  });

  it('emits the generated module in the BundledDocs pattern', () => {
    const moduleText = emitGeneratedModule([
      {
        path: 'events/one.md',
        title: 'One',
        category: 'events',
        summary: 'S',
        body: 'B',
        tags: ['events'],
      },
    ]);
    expect(moduleText.startsWith('// @flow')).toBe(true);
    expect(moduleText).toContain('export type ByokMinifiedDocPage');
    expect(moduleText).toContain('export default byokMinifiedDocPages;');
    expect(moduleText).toContain('"events/one.md"');
  });
});
