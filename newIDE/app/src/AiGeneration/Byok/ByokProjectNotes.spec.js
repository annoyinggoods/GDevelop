/**
 * @jest-environment jsdom
 */
// @flow
import {
  BYOK_PROJECT_NOTES_MAX_CHARS,
  BYOK_PROJECT_NOTES_FIELD_MAX_CHARS,
  BYOK_PROJECT_NOTES_FIELD_KEYS,
  getEmptyByokProjectNotes,
  mergeByokProjectNotes,
  getByokProjectNotesSize,
  makeByokProjectNotesIdentifierFromProjectName,
  loadByokProjectNotes,
  saveByokProjectNotes,
  areByokProjectNotesEmpty,
} from './ByokProjectNotes';

describe('ByokProjectNotes: merge semantics', () => {
  it('replaces only the fields that are provided', () => {
    const existing = {
      conventions: 'Use "mob_" prefixes.',
      inProgress: 'Level 3 boss.',
      decisions: 'Pixel art.',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const merged = mergeByokProjectNotes(existing, {
      inProgress: 'Level 4 gauntlet.',
    });

    expect(merged.conventions).toBe('Use "mob_" prefixes.');
    expect(merged.inProgress).toBe('Level 4 gauntlet.');
    expect(merged.decisions).toBe('Pixel art.');
    expect(merged.updatedAt).not.toBe(existing.updatedAt);
  });

  it('clears a field on an explicit empty string', () => {
    const existing = {
      conventions: 'To remove',
      inProgress: '',
      decisions: '',
      updatedAt: '',
    };
    const merged = mergeByokProjectNotes(existing, { conventions: '' });
    expect(merged.conventions).toBe('');
  });

  it('clamps an oversized field to the per-field cap', () => {
    const merged = mergeByokProjectNotes(getEmptyByokProjectNotes(), {
      conventions: 'x'.repeat(BYOK_PROJECT_NOTES_FIELD_MAX_CHARS + 500),
    });
    expect(merged.conventions.length).toBe(
      BYOK_PROJECT_NOTES_FIELD_MAX_CHARS + 1
    );
    expect(merged.conventions.endsWith('…')).toBe(true);
  });

  it('ignores non-string updates', () => {
    const existing = {
      conventions: 'Keep me',
      inProgress: '',
      decisions: '',
      updatedAt: '',
    };
    // Non-string values come from untrusted model JSON: they keep the
    // existing value instead of corrupting the notes.
    const merged = mergeByokProjectNotes(
      existing,
      ({
        conventions: 42,
      }: any)
    );
    expect(merged.conventions).toBe('Keep me');
  });
});

describe('ByokProjectNotes: caps and helpers', () => {
  it('exposes the documented caps', () => {
    expect(BYOK_PROJECT_NOTES_MAX_CHARS).toBe(8 * 1024);
    expect(BYOK_PROJECT_NOTES_FIELD_MAX_CHARS).toBe(2000);
    expect(BYOK_PROJECT_NOTES_FIELD_KEYS).toEqual([
      'conventions',
      'inProgress',
      'decisions',
    ]);
  });

  it('computes the blob size and emptiness', () => {
    const notes = {
      conventions: '12345',
      inProgress: '',
      decisions: '67',
      updatedAt: 'ignored',
    };
    expect(getByokProjectNotesSize(notes)).toBe(7);
    expect(areByokProjectNotesEmpty(notes)).toBe(false);
    expect(areByokProjectNotesEmpty(getEmptyByokProjectNotes())).toBe(true);
  });

  it('derives a stable identifier from the project name', () => {
    const first = makeByokProjectNotesIdentifierFromProjectName('My game');
    const second = makeByokProjectNotesIdentifierFromProjectName('My game');
    const other = makeByokProjectNotesIdentifierFromProjectName('Other');
    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first.startsWith('name-')).toBe(true);
  });
});

describe('ByokProjectNotes: storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips notes through the storage', async () => {
    await saveByokProjectNotes('file-id-1', {
      conventions: 'Tabs, not spaces.',
      inProgress: 'Menu scene.',
      decisions: 'Local co-op only.',
      updatedAt: '2026-09-22T00:00:00.000Z',
    });
    const loaded = await loadByokProjectNotes('file-id-1');
    expect(loaded.conventions).toBe('Tabs, not spaces.');
    expect(loaded.decisions).toBe('Local co-op only.');
  });

  it('loads empty notes when nothing was saved (or corrupted)', async () => {
    expect((await loadByokProjectNotes('never-saved')).conventions).toBe('');

    localStorage.setItem('gd-byok-project-notes-corrupted', '{not json at all');
    const corrupted = await loadByokProjectNotes('corrupted');
    expect(areByokProjectNotesEmpty(corrupted)).toBe(true);
  });

  it('refuses to save notes above the 8 KB cap', async () => {
    // Built directly (the merge clamps per field): this is the save-time
    // guard for any caller that bypasses the merge.
    const huge = {
      conventions: 'y'.repeat(BYOK_PROJECT_NOTES_MAX_CHARS + 10),
      inProgress: '',
      decisions: '',
      updatedAt: '2026-09-22T00:00:00.000Z',
    };
    expect(await saveByokProjectNotes('file-id-huge', huge)).toBe(false);
    expect(localStorage.getItem('gd-byok-project-notes-file-id-huge')).toBe(
      null
    );
  });
});
