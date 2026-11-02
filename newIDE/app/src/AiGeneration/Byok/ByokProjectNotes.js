// @flow
import type { ByokProjectNotes } from './Knowledge/ByokKnowledgeSections';

/**
 * The per-project notes (Phase 7.8): a small persistent memory the agent
 * reads at chat start and updates with the `update_project_notes` tool —
 * the CLAUDE.md discipline, auto-maintained. Stored in localStorage for v1
 * (Phase 9 moves persistence to IndexedDB), keyed by the project's file
 * identifier (cloud-save metadata; local fallback: a hash of the project
 * name).
 */

export const BYOK_PROJECT_NOTES_MAX_CHARS = 8 * 1024;

/** One notes field cannot exceed this (three fields stay well under 8 KB). */
export const BYOK_PROJECT_NOTES_FIELD_MAX_CHARS = 2000;

export const BYOK_PROJECT_NOTES_STORAGE_PREFIX = 'gd-byok-project-notes-';

const STORAGE_KEYS = ['conventions', 'inProgress', 'decisions'];

export const getEmptyByokProjectNotes = (): ByokProjectNotes => ({
  conventions: '',
  inProgress: '',
  decisions: '',
  updatedAt: '',
});

const clampField = (value: string): string =>
  value.length > BYOK_PROJECT_NOTES_FIELD_MAX_CHARS
    ? `${value.slice(0, BYOK_PROJECT_NOTES_FIELD_MAX_CHARS)}…`
    : value;

/**
 * Merge model-provided updates over the existing notes: an absent (or
 * non-string) field keeps its value, a string replaces it (an explicit
 * empty string clears it). Every field is clamped, and `updatedAt` is
 * refreshed.
 */
export const mergeByokProjectNotes = (
  existing: ByokProjectNotes,
  updates: {|
    conventions?: string,
    inProgress?: string,
    decisions?: string,
  |}
): ByokProjectNotes => {
  const merged: ByokProjectNotes = {
    conventions:
      typeof updates.conventions === 'string'
        ? clampField(updates.conventions)
        : existing.conventions,
    inProgress:
      typeof updates.inProgress === 'string'
        ? clampField(updates.inProgress)
        : existing.inProgress,
    decisions:
      typeof updates.decisions === 'string'
        ? clampField(updates.decisions)
        : existing.decisions,
    updatedAt: new Date().toISOString(),
  };
  return merged;
};

/** The total size of the notes blob, for the 8 KB cap. */
export const getByokProjectNotesSize = (notes: ByokProjectNotes): number =>
  notes.conventions.length + notes.inProgress.length + notes.decisions.length;

/**
 * A stable identifier for the project: the cloud-save file identifier when
 * the project has one, else a hash of the project name (a rename changes
 * the identity — acceptable for a v1 local memory).
 */
export const makeByokProjectNotesIdentifierFromProjectName = (
  projectName: string
): string => {
  // FNV-1a, rendered in base36: short, deterministic, dependency-free.
  let hash = 0x811c9dc5;
  for (let index = 0; index < projectName.length; index++) {
    hash ^= projectName.charCodeAt(index);
    hash = (hash * 0x01000193) >>> 0;
  }
  return `name-${hash.toString(36)}`;
};

const storageKeyFor = (identifier: string): string =>
  `${BYOK_PROJECT_NOTES_STORAGE_PREFIX}${identifier}`;

/**
 * Load the notes of a project. Untrusted data: anything that does not look
 * like notes is ignored (the empty notes are returned).
 */
export const loadByokProjectNotes = async (
  identifier: string
): Promise<ByokProjectNotes> => {
  try {
    const raw = localStorage.getItem(storageKeyFor(identifier));
    if (!raw) return getEmptyByokProjectNotes();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return getEmptyByokProjectNotes();
    }
    const record: Object = parsed;
    const notes: ByokProjectNotes = {
      conventions:
        typeof record.conventions === 'string' ? record.conventions : '',
      inProgress:
        typeof record.inProgress === 'string' ? record.inProgress : '',
      decisions: typeof record.decisions === 'string' ? record.decisions : '',
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    };
    if (getByokProjectNotesSize(notes) > BYOK_PROJECT_NOTES_MAX_CHARS) {
      // Over the cap (e.g. written by an older build with other limits):
      // refuse to serve, the model would drown in it.
      return getEmptyByokProjectNotes();
    }
    return notes;
  } catch (error) {
    console.error('Unable to read the BYOK project notes:', error);
    return getEmptyByokProjectNotes();
  }
};

/**
 * Save the notes of a project. Resolves to false when the notes are over
 * the cap or the storage refused the write, so the tool can tell the model
 * to trim instead of silently losing the notes.
 */
export const saveByokProjectNotes = async (
  identifier: string,
  notes: ByokProjectNotes
): Promise<boolean> => {
  if (getByokProjectNotesSize(notes) > BYOK_PROJECT_NOTES_MAX_CHARS) {
    return false;
  }
  try {
    localStorage.setItem(storageKeyFor(identifier), JSON.stringify(notes));
    return true;
  } catch (error) {
    console.error('Unable to save the BYOK project notes:', error);
    return false;
  }
};

/** True when the notes hold nothing at all (the section is then skipped). */
export const areByokProjectNotesEmpty = (notes: ByokProjectNotes): boolean =>
  getByokProjectNotesSize(notes) === 0;

export { STORAGE_KEYS as BYOK_PROJECT_NOTES_FIELD_KEYS };
