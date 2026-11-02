// @flow
import {
  listByokBundledDocPages,
  readByokDocPage,
  BYOK_DOCS_READ_CHAR_CAP,
} from '../ByokDocs';

/**
 * The MCP `resources` primitive (Phase 12, D12-6): the project notes and
 * the bundled documentation index as first-class MCP resources, readable
 * without any tool call. The URI scheme is this module's contract:
 *
 * - `gdevelop://project/notes` — the merged BYOK notes of the open project
 *   (only listed while a project host is registered);
 * - `gdevelop://docs/<page-path>` — one bundled documentation page (the
 *   same pages the read_doc tool serves).
 *
 * No arbitrary project files as resources (binary/large — D12-6), and
 * `resources/templates` is deliberately not offered.
 */

export const BYOK_MCP_NOTES_URI = 'gdevelop://project/notes';
export const BYOK_MCP_DOCS_URI_PREFIX = 'gdevelop://docs/';

export type ByokMcpResourceDescriptor = {|
  uri: string,
  name: string,
  mimeType: string,
  description?: string,
|};

export type ByokMcpResourceContents = {|
  uri: string,
  mimeType: string,
  text: string,
|};

/**
 * `resources/list`: the notes resource (when a project host is registered,
 * i.e. `notesText` is not null) plus one entry per bundled docs page.
 */
export const makeByokMcpResourceDescriptors = (options: {|
  notesText: string | null,
|}): Array<ByokMcpResourceDescriptor> => {
  const resources: Array<ByokMcpResourceDescriptor> = [];
  if (options.notesText !== null) {
    resources.push({
      uri: BYOK_MCP_NOTES_URI,
      name: 'Project notes',
      mimeType: 'text/plain',
      description:
        'The persistent notes the GDevelop AI keeps about this project (conventions, work in progress, decisions).',
    });
  }
  for (const page of listByokBundledDocPages()) {
    resources.push({
      uri: `${BYOK_MCP_DOCS_URI_PREFIX}${page.path}`,
      name: page.title,
      mimeType: 'text/markdown',
    });
  }
  return resources;
};

/**
 * `resources/read`: the notes text, or one bundled docs page (capped like
 * read_doc). Unknown URI → null (the protocol layer answers -32602).
 */
export const readByokMcpResource = async (options: {|
  uri: string,
  notesText: string | null,
|}): Promise<ByokMcpResourceContents | null> => {
  if (options.uri === BYOK_MCP_NOTES_URI) {
    if (options.notesText === null) return null;
    return {
      uri: options.uri,
      mimeType: 'text/plain',
      text: options.notesText,
    };
  }
  if (options.uri.startsWith(BYOK_MCP_DOCS_URI_PREFIX)) {
    const pagePath = options.uri.slice(BYOK_MCP_DOCS_URI_PREFIX.length);
    // Bundled pages only: the MCP surface never expands to the online docs
    // on its own (that stays behind the user's onlineDocsEnabled setting
    // in the chat tools).
    const page = await readByokDocPage(pagePath, { onlineEnabled: false });
    if (!page.found) return null;
    return {
      uri: options.uri,
      mimeType: 'text/markdown',
      text:
        page.content.length > BYOK_DOCS_READ_CHAR_CAP
          ? `${page.content.slice(0, BYOK_DOCS_READ_CHAR_CAP)}…`
          : page.content,
    };
  }
  return null;
};
