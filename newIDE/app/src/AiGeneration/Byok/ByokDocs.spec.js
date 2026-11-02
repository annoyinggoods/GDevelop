/**
 * @jest-environment jsdom
 */
// @flow
import {
  BYOK_DOCS_SEARCH_RESULT_CAP,
  BYOK_DOCS_READ_CHAR_CAP,
  listByokBundledDocPages,
  searchByokDocs,
  readBundledByokDocPage,
  readByokDocPage,
  sliceByokDocSection,
} from './ByokDocs';

describe('ByokDocs: bundled subset', () => {
  it('ships the curated pages', () => {
    const pages = listByokBundledDocPages();
    const paths = pages.map(page => page.path);

    expect(paths).toContain('events/index.md');
    expect(paths).toContain('events/js-code/index.md');
    expect(paths).toContain('events/object-picking/index.md');
    expect(paths).toContain('events/expressions/index.md');
    expect(paths).toContain('events/foreach/index.md');
    // Every bundled page has a title and content.
    const rawPages = require('./docs/gdevelop-docs/BundledDocs.generated')
      .default;
    for (const page of rawPages) {
      expect(page.title).not.toBe('');
      expect(page.content.length).toBeGreaterThan(0);
    }
  });
});

describe('ByokDocs: search', () => {
  it('ranks a title match above a body match', () => {
    const pickResult = searchByokDocs('object picking');
    expect(pickResult.results.length).toBeGreaterThan(0);
    expect(pickResult.results[0].path).toBe('events/object-picking/index.md');
    expect(pickResult.results[0].matchedIn).toBe('title');
  });

  it('finds pages by heading and by body content', () => {
    const headings = searchByokDocs('For each');
    expect(headings.results.length).toBeGreaterThan(0);

    const body = searchByokDocs('TimeDelta');
    expect(body.results.length).toBeGreaterThan(0);
  });

  it('returns an empty result for a nonsense query without crashing', () => {
    const result = searchByokDocs('zzz-never-in-the-docs-zzz');
    expect(result.results).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('respects the result cap', () => {
    // An empty query lists everything; the corpus is bigger than nothing
    // but smaller than the cap — so the cap is pinned by construction.
    expect(BYOK_DOCS_SEARCH_RESULT_CAP).toBe(15);
    const result = searchByokDocs('');
    expect(result.results.length).toBeLessThanOrEqual(
      BYOK_DOCS_SEARCH_RESULT_CAP
    );
  });
});

describe('ByokDocs: read', () => {
  it('reads a bundled page and reports truncation for huge content', () => {
    const read = readBundledByokDocPage('events/index.md');
    if (!read || !read.found) throw new Error('The page was not bundled');
    expect(read.origin).toBe('bundled');
    expect(read.content.length).toBeLessThanOrEqual(BYOK_DOCS_READ_CHAR_CAP);

    expect(BYOK_DOCS_READ_CHAR_CAP).toBe(12000);
  });

  it('slices a section by anchor', () => {
    const content = [
      '# Main title',
      'Intro text.',
      '## First section',
      'First body.',
      '## Second section',
      'Second body.',
      '### Subsection',
      'Sub body.',
    ].join('\n');

    const slice = sliceByokDocSection(content, 'Second section');
    expect(slice).toContain('Second body.');
    expect(slice).toContain('Subsection');
    expect(slice).not.toContain('First body.');
    expect(slice).not.toContain('Main title');

    // A deeper anchor keeps its subsections.
    const subSlice = sliceByokDocSection(content, 'Subsection');
    expect(subSlice).toContain('Sub body.');
  });

  it('falls back to the whole page when the anchor matches nothing', () => {
    const content = '# Title\n\nSome body.';
    expect(sliceByokDocSection(content, 'no-such-anchor')).toBe(content);
  });
});

describe('ByokDocs: online expansion', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('never fetches when the toggle is off (asserted with a mocked fetch)', async () => {
    const fetchDoc = (jest.fn(): any).mockResolvedValue(
      '# Fetched\n\nContent.'
    );
    const result = await readByokDocPage('events/never-bundled/index.md', {
      onlineEnabled: false,
      fetchDoc,
    });

    expect(fetchDoc).not.toHaveBeenCalled();
    expect(result.found).toBe(false);
    expect(result.origin).toBe('offline');
  });

  it('fetches a missing page when the toggle is on, then serves it from the cache', async () => {
    const fetchDoc = (jest.fn(): any).mockResolvedValue(
      '# Fetched page\n\nContent.'
    );
    const first = await readByokDocPage('events/never-bundled/index.md', {
      onlineEnabled: true,
      fetchDoc,
    });
    expect(first.found).toBe(true);
    expect(first.origin).toBe('network');
    expect(first.content).toContain('Fetched page');

    // Second read: served from the 24h cache, no network call.
    const secondFetchDoc = (jest.fn(): any).mockResolvedValue(
      '# Should not load'
    );
    const second = await readByokDocPage('events/never-bundled/index.md', {
      onlineEnabled: true,
      fetchDoc: secondFetchDoc,
    });
    expect(secondFetchDoc).not.toHaveBeenCalled();
    expect(second.origin).toBe('cache');
    expect(second.content).toContain('Fetched page');
  });

  it('prefers the bundled page over any network fetch', async () => {
    const fetchDoc = (jest.fn(): any).mockResolvedValue('# Should never load');
    const result = await readByokDocPage('events/index.md', {
      onlineEnabled: true,
      fetchDoc,
    });
    expect(fetchDoc).not.toHaveBeenCalled();
    expect(result.origin).toBe('bundled');
  });

  it('reports a missing page after a failed fetch', async () => {
    const fetchDoc = (jest.fn(): any).mockRejectedValue(
      new Error('No internet')
    );
    const result = await readByokDocPage('events/also-not-bundled.md', {
      onlineEnabled: true,
      fetchDoc,
    });
    expect(result.found).toBe(false);
    expect(result.origin).toBe('missing');
    expect(result.content).toContain('could not be fetched');
  });
});
