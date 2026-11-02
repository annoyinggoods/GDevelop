// @flow
import axios from 'axios';
import bundledDocPages from './docs/gdevelop-docs/BundledDocs.generated';

/**
 * The BYOK docs access (Phase 7.7): the honest replacement of the hosted
 * agent's server-side `read_full_docs`/`search_docs`. A curated subset of
 * the official documentation is bundled (see docs/ABOUT.md — CC BY-SA 4.0),
 * searched as plain substrings (no dependencies, no embeddings), and read
 * with caps. Online-first-expansion: when the desktop setting is enabled,
 * pages that are not bundled are fetched from the upstream documentation
 * repository and cached for a day. Offline-first, online-best; the GDevelop
 * backend is never called.
 */

import type { ByokBundledDocPage } from './docs/gdevelop-docs/BundledDocs.generated';

/** Search results never exceed this count (tool-response discipline). */
export const BYOK_DOCS_SEARCH_RESULT_CAP = 15;

/** One read_doc result never exceeds this many characters. */
export const BYOK_DOCS_READ_CHAR_CAP = 12000;

/** How long a fetched online page stays in the local cache. */
export const BYOK_DOCS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const DOCS_CACHE_ITEM_PREFIX = 'gd-byok-docs-cache-';

// The upstream repository and the folder the bundled subset mirrors (paths
// in the tools are relative to it: `events/foreach/index.md`, …).
export const BYOK_DOCS_RAW_BASE_URL =
  'https://raw.githubusercontent.com/GDevelopApp/GDevelop-documentation/main/docs/gdevelop5/';

/** The bundled pages (validated once: generated data, still untrusted). */
const getBundledPages = (): Array<ByokBundledDocPage> =>
  bundledDocPages.filter(
    page =>
      page &&
      typeof page.path === 'string' &&
      typeof page.title === 'string' &&
      typeof page.content === 'string' &&
      Array.isArray(page.headings)
  );

/** The pages that ship with the app, as a cheap listing. */
export const listByokBundledDocPages = (): Array<{|
  path: string,
  title: string,
|}> => getBundledPages().map(page => ({ path: page.path, title: page.title }));

/**
 * Search the bundled docs: a query matches a page when it appears in the
 * title, the path, a heading or the body (substring, case-insensitive).
 * Pages matching in the title come first. Nothing matches in the body is
 * ranked above a body-only mention is not attempted — the corpus is small
 * (15 pages), the point is recall, then the model reads the page.
 */
export const searchByokDocs = (
  query: string
): {|
  results: Array<{| path: string, title: string, matchedIn: string |}>,
  truncated: boolean,
|} => {
  const needle = query.trim().toLowerCase();
  const pages = getBundledPages();
  if (!needle) {
    return {
      results: pages.slice(0, BYOK_DOCS_SEARCH_RESULT_CAP).map(page => ({
        path: page.path,
        title: page.title,
        matchedIn: 'listed (empty query)',
      })),
      truncated: pages.length > BYOK_DOCS_SEARCH_RESULT_CAP,
    };
  }

  const scored: Array<{|
    path: string,
    title: string,
    matchedIn: string,
    score: number,
  |}> = [];
  for (const page of pages) {
    const title = page.title.toLowerCase();
    const docPath = page.path.toLowerCase();
    const content = page.content.toLowerCase();
    let score = -1;
    let matchedIn = '';
    if (title.includes(needle)) {
      score = 100;
      matchedIn = 'title';
    } else if (docPath.includes(needle)) {
      score = 80;
      matchedIn = 'path';
    } else if (
      page.headings.some(heading => heading.toLowerCase().includes(needle))
    ) {
      score = 60;
      matchedIn = 'headings';
    } else if (content.includes(needle)) {
      score = 40;
      matchedIn = 'body';
    }
    if (score > 0)
      scored.push({ path: page.path, title: page.title, matchedIn, score });
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return {
    results: scored
      .slice(0, BYOK_DOCS_SEARCH_RESULT_CAP)
      .map(({ path, title, matchedIn }) => ({ path, title, matchedIn })),
    truncated: scored.length > BYOK_DOCS_SEARCH_RESULT_CAP,
  };
};

/**
 * Slice a page's Markdown from the heading matching the anchor (substring,
 * case-insensitive) to the next heading of the same or higher level. When
 * no heading matches, the whole (capped) page is returned.
 */
export const sliceByokDocSection = (
  content: string,
  anchor: string
): string => {
  const lines = content.split('\n');
  const needle = anchor.trim().toLowerCase();
  const startIndex = lines.findIndex(
    line => /^#{1,6}\s/.test(line) && line.toLowerCase().includes(needle)
  );
  if (startIndex === -1) return content;

  const startHeadingMatch = /^#+/.exec(lines[startIndex]);
  if (!startHeadingMatch) return content;
  const startLevel = startHeadingMatch[0].length;
  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index++) {
    const headingMatch = /^(#{1,6})\s/.exec(lines[index]);
    if (headingMatch && headingMatch[1].length <= startLevel) {
      endIndex = index;
      break;
    }
  }
  return lines.slice(startIndex, endIndex).join('\n');
};

export type ByokDocPageRead = {|
  found: boolean,
  // Where the page came from: bundled, cache, network — or why it was not
  // found ("missing" / "offline").
  origin: 'bundled' | 'cache' | 'network' | 'missing' | 'offline',
  path: string,
  title: string,
  content: string,
  truncated: boolean,
|};

/** Read the page from the bundled subset only. */
export const readBundledByokDocPage = (
  pagePath: string,
  anchor?: string
): ByokDocPageRead | null => {
  const normalized = pagePath.trim().replace(/^\/+/, '');
  const page = getBundledPages().find(
    candidate => candidate.path === normalized
  );
  if (!page) return null;

  const sliced = anchor
    ? sliceByokDocSection(page.content, anchor)
    : page.content;
  const truncated = sliced.length > BYOK_DOCS_READ_CHAR_CAP;
  return {
    found: true,
    origin: 'bundled',
    path: page.path,
    title: page.title,
    content: truncated ? sliced.slice(0, BYOK_DOCS_READ_CHAR_CAP) : sliced,
    truncated,
  };
};

type CacheEntry = {| fetchedAt: number, content: string |};

const readCachedPage = (pagePath: string): ?CacheEntry => {
  try {
    const raw = localStorage.getItem(DOCS_CACHE_ITEM_PREFIX + pagePath);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.fetchedAt !== 'number' ||
      typeof parsed.content !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch (error) {
    return null;
  }
};

const writeCachedPage = (pagePath: string, content: string): void => {
  try {
    localStorage.setItem(
      DOCS_CACHE_ITEM_PREFIX + pagePath,
      JSON.stringify(({ fetchedAt: Date.now(), content }: CacheEntry))
    );
  } catch (error) {
    // A full cache must never fail a read: drop it silently.
  }
};

/**
 * Read a page, offline-first: bundled subset → 24h cache → network (only
 * when the user enabled online expansion). `fetchDoc` is injectable for
 * tests; by default it fetches the raw Markdown from the upstream
 * documentation repository.
 */
export const readByokDocPage = async (
  pagePath: string,
  options?: {|
    anchor?: string,
    onlineEnabled?: boolean,
    fetchDoc?: (url: string) => Promise<string>,
  |}
): Promise<ByokDocPageRead> => {
  const normalized = pagePath.trim().replace(/^\/+/, '');
  const bundled = readBundledByokDocPage(normalized, options && options.anchor);
  if (bundled) return bundled;

  const cache = readCachedPage(normalized);
  if (cache && Date.now() - cache.fetchedAt < BYOK_DOCS_CACHE_TTL_MS) {
    const sliced =
      options && options.anchor
        ? sliceByokDocSection(cache.content, options.anchor)
        : cache.content;
    const truncated = sliced.length > BYOK_DOCS_READ_CHAR_CAP;
    return {
      found: true,
      origin: 'cache',
      path: normalized,
      title: normalized,
      content: truncated ? sliced.slice(0, BYOK_DOCS_READ_CHAR_CAP) : sliced,
      truncated,
    };
  }

  if (!options || !options.onlineEnabled) {
    return {
      found: false,
      origin: 'offline',
      path: normalized,
      title: normalized,
      content:
        'This page is not in the bundled documentation and the online docs expansion is disabled.',
      truncated: false,
    };
  }

  const fetchDoc =
    options.fetchDoc ||
    (async (url: string) => {
      // Same suppression as the other services (Generation.js, ByokClient):
      // the flow-typed axios definition has an underconstrained generic.
      // $FlowFixMe[underconstrained-implicit-instantiation]
      const response = await axios.get(url, { timeout: 15000 });
      return typeof response.data === 'string' ? response.data : '';
    });

  try {
    const content = await fetchDoc(`${BYOK_DOCS_RAW_BASE_URL}${normalized}`);
    if (!content) {
      return {
        found: false,
        origin: 'missing',
        path: normalized,
        title: normalized,
        content: 'The page does not exist in the documentation repository.',
        truncated: false,
      };
    }
    writeCachedPage(normalized, content);
    const sliced =
      options && options.anchor
        ? sliceByokDocSection(content, options.anchor)
        : content;
    const truncated = sliced.length > BYOK_DOCS_READ_CHAR_CAP;
    return {
      found: true,
      origin: 'network',
      path: normalized,
      title: normalized,
      content: truncated ? sliced.slice(0, BYOK_DOCS_READ_CHAR_CAP) : sliced,
      truncated,
    };
  } catch (error) {
    return {
      found: false,
      origin: 'missing',
      path: normalized,
      title: normalized,
      content: `The page could not be fetched: ${
        error instanceof Error ? error.message : String(error)
      }`,
      truncated: false,
    };
  }
};
