// @flow
import {
  BYOK_MCP_DOCS_URI_PREFIX,
  BYOK_MCP_NOTES_URI,
  makeByokMcpResourceDescriptors,
  readByokMcpResource,
} from './ByokMcpResources';

describe('ByokMcpResources', () => {
  it('lists the notes resource only while a project host is registered', () => {
    const withNotes = makeByokMcpResourceDescriptors({
      notesText: 'Conventions: snake_case',
    });
    const withoutNotes = makeByokMcpResourceDescriptors({ notesText: null });

    expect(withNotes[0].uri).toBe(BYOK_MCP_NOTES_URI);
    expect(withNotes[0].mimeType).toBe('text/plain');
    expect(
      withoutNotes.find(resource => resource.uri === BYOK_MCP_NOTES_URI)
    ).toBeUndefined();
  });

  it('lists one entry per bundled docs page with the docs URI scheme', () => {
    const resources = makeByokMcpResourceDescriptors({ notesText: null });
    const docsResources = resources.filter(resource =>
      resource.uri.startsWith(BYOK_MCP_DOCS_URI_PREFIX)
    );
    expect(docsResources.length).toBeGreaterThan(3);
    for (const resource of docsResources) {
      expect(resource.mimeType).toBe('text/markdown');
      expect(resource.name).toBeTruthy();
    }
  });

  it('reads the notes text', async () => {
    const contents = await readByokMcpResource({
      uri: BYOK_MCP_NOTES_URI,
      notesText: 'Conventions: snake_case',
    });
    expect(contents?.text).toBe('Conventions: snake_case');
    expect(contents?.mimeType).toBe('text/plain');
  });

  it('refuses the notes resource while no project host is registered', async () => {
    expect(
      await readByokMcpResource({ uri: BYOK_MCP_NOTES_URI, notesText: null })
    ).toBeNull();
  });

  it('reads a bundled docs page', async () => {
    const resources = makeByokMcpResourceDescriptors({ notesText: null });
    const docsResource = resources.find(resource =>
      resource.uri.startsWith(BYOK_MCP_DOCS_URI_PREFIX)
    );
    if (!docsResource) throw new Error('no docs resource');

    const contents = await readByokMcpResource({
      uri: docsResource.uri,
      notesText: null,
    });
    expect(contents?.mimeType).toBe('text/markdown');
    expect(typeof contents?.text).toBe('string');
  });

  it('answers null for an unknown docs path and an unknown scheme', async () => {
    expect(
      await readByokMcpResource({
        uri: `${BYOK_MCP_DOCS_URI_PREFIX}not/a/page.md`,
        notesText: null,
      })
    ).toBeNull();
    expect(
      await readByokMcpResource({ uri: 'file:///etc/passwd', notesText: null })
    ).toBeNull();
  });
});
