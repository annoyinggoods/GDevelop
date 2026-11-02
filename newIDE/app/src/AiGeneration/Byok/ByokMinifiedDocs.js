// @flow
import minifiedDocPages from './docs/gdevelop-docs/MinifiedDocs.generated';
import type { ByokMinifiedDocPage } from './docs/gdevelop-docs/MinifiedDocs.generated';

/**
 * The minified-docs access layer (Phase 14.2, D14-2): the whole gdevelop5
 * wiki, minified to a 40–60 % band and committed as generated data
 * (`MinifiedDocs.generated.js`, built by `scripts/build-byok-minified-docs.js`
 * from the DOCs clone). Same pattern as BundledDocs: generated data,
 * validated once by the pipeline, still treated as untrusted here — every
 * accessor filters before exposing. The corpus turns these pages into the
 * `docs-min` map/page chunk grades (ByokRagCorpus), so the wiki is
 * searchable with RAG off (lexical) and offline.
 */

export type { ByokMinifiedDocPage };

// The generated artifact is the one and only production source; the tests
// replace it to exercise the validation of untrusted shapes.
let pagesOverride: ?Array<any> = null;

/** Replace the artifact pages (tests only). */
export const setByokMinifiedDocPagesForTests = (pages: ?Array<any>): void => {
  pagesOverride = pages;
};

/** True when a raw artifact entry has the shape the accessors expose. */
const isValidMinifiedDocPage = (raw: any): boolean =>
  !!raw &&
  typeof raw.path === 'string' &&
  raw.path.endsWith('.md') &&
  !raw.path.startsWith('/') &&
  typeof raw.title === 'string' &&
  raw.title.trim().length > 0 &&
  typeof raw.category === 'string' &&
  raw.category.trim().length > 0 &&
  typeof raw.summary === 'string' &&
  typeof raw.body === 'string' &&
  Array.isArray(raw.tags) &&
  raw.tags.every((tag: any) => typeof tag === 'string');

/**
 * Every valid page of the artifact, in its stable (path-sorted) order.
 *
 * Memoized: the artifact is immutable generated data, and re-validating +
 * re-copying all 601 pages (2.3 MB) happened on EVERY accessor call — once
 * per `read_doc_page` tool call and once per corpus build (audit100226
 * CACHE-5). The cache is dropped whenever `pagesOverride` changes.
 */
let validPagesCache: ?Array<ByokMinifiedDocPage> = null;
let validPagesCacheSource = null;

const buildValidPages = (): Array<ByokMinifiedDocPage> =>
  (pagesOverride || minifiedDocPages)
    .filter(isValidMinifiedDocPage)
    .map(page => ({
      path: page.path,
      title: page.title,
      category: page.category,
      summary: page.summary,
      body: page.body,
      tags: page.tags,
    }));

export const getByokMinifiedDocPages = (): Array<ByokMinifiedDocPage> => {
  const source = pagesOverride || minifiedDocPages;
  if (validPagesCache && validPagesCacheSource === source) {
    return validPagesCache;
  }
  validPagesCache = buildValidPages();
  validPagesCacheSource = source;
  return validPagesCache;
};

/** The categories (top-level wiki folders, plus `general`), sorted. */
export const listByokMinifiedDocCategories = (): Array<string> =>
  Array.from(
    new Set(getByokMinifiedDocPages().map(page => page.category))
  ).sort();

/** The pages of one category, in the stable path-sorted order. */
export const getByokMinifiedDocPagesOfCategory = (
  category: string
): Array<ByokMinifiedDocPage> =>
  getByokMinifiedDocPages().filter(page => page.category === category);

/**
 * Read one minified page by its wiki path (leading slashes tolerated, as
 * `read_doc_page` does). Null when the path is not in the artifact.
 */
export const readByokMinifiedDocPage = (
  pagePath: string
): ?ByokMinifiedDocPage => {
  const normalized = pagePath.trim().replace(/^\/+/, '');
  return (
    getByokMinifiedDocPages().find(page => page.path === normalized) || null
  );
};
