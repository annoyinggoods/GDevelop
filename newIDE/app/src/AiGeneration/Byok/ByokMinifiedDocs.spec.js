// @flow
import {
  getByokMinifiedDocPages,
  listByokMinifiedDocCategories,
  getByokMinifiedDocPagesOfCategory,
  readByokMinifiedDocPage,
  setByokMinifiedDocPagesForTests,
} from './ByokMinifiedDocs';

/**
 * The minified-docs artifact (Phase 14.2): generated data, still untrusted —
 * the accessors must filter malformed entries, expose the category
 * taxonomy, and address pages by their wiki path (the same paths
 * `read_doc_page` takes online).
 */
describe('ByokMinifiedDocs (the minified wiki artifact)', () => {
  afterEach(() => {
    setByokMinifiedDocPagesForTests(null);
  });

  it('exposes the real artifact: every wiki page, valid and path-sorted', () => {
    const pages = getByokMinifiedDocPages();
    // The whole gdevelop5 wiki (601 pages at generation time; the count is
    // asserted loosely so a DOCs refresh does not break the spec).
    expect(pages.length).toBeGreaterThanOrEqual(590);
    const paths = pages.map(page => page.path);
    for (const path of paths) {
      expect(path.endsWith('.md')).toBe(true);
      expect(path.startsWith('/')).toBe(false);
    }
    // The artifact is sorted the way the assembler sorts (locale-aware).
    expect([...paths].sort((a, b) => a.localeCompare(b))).toEqual(paths);
  });

  it('lists unique, sorted categories and the pages of one category', () => {
    const categories = listByokMinifiedDocCategories();
    expect(categories.length).toBeGreaterThanOrEqual(10);
    expect([...categories].sort()).toEqual(categories);
    const extensions = getByokMinifiedDocPagesOfCategory('extensions');
    expect(extensions.length).toBeGreaterThan(100);
    expect(extensions.every(page => page.category === 'extensions')).toBe(true);
    expect(getByokMinifiedDocPagesOfCategory('no-such-category')).toEqual([]);
  });

  it('reads one page by path, tolerating the leading slash, and rejects unknowns', () => {
    const pages = getByokMinifiedDocPages();
    const sample = pages[0];
    expect(readByokMinifiedDocPage(sample.path)).toEqual(sample);
    expect(readByokMinifiedDocPage(`/${sample.path}`)).toEqual(sample);
    expect(readByokMinifiedDocPage('no/such/page.md')).toBe(null);
    expect(readByokMinifiedDocPage('  ')).toBe(null);
  });

  it('filters malformed entries out of untrusted generated data', () => {
    setByokMinifiedDocPagesForTests([
      {
        path: 'events/ok.md',
        title: 'Ok',
        category: 'events',
        summary: 'Fine.',
        body: 'Content.',
        tags: ['events'],
      },
      {
        path: 'not-md.txt',
        title: 'x',
        category: 'x',
        summary: '',
        body: '',
        tags: [],
      },
      {
        path: '/leading-slash.md',
        title: 'x',
        category: 'x',
        summary: '',
        body: '',
        tags: [],
      },
      {
        path: 'empty-title.md',
        title: '  ',
        category: 'x',
        summary: '',
        body: '',
        tags: [],
      },
      {
        path: 'no-category.md',
        title: 'x',
        category: '',
        summary: '',
        body: '',
        tags: [],
      },
      {
        path: 'bad-tags.md',
        title: 'x',
        category: 'x',
        summary: '',
        body: '',
        tags: [3],
      },
      null,
      'not-an-object',
    ]);
    const pages = getByokMinifiedDocPages();
    expect(pages).toHaveLength(1);
    expect(pages[0].path).toBe('events/ok.md');
    expect(listByokMinifiedDocCategories()).toEqual(['events']);
  });
});
