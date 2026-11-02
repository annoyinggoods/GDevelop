// @flow
import optionalRequire from '../../Utils/OptionalRequire';
import { sanitizeFilename } from '../../Utils/Filename';
import {
  applyResourceDefaults,
  isURL,
} from '../../ResourcesList/ResourceUtils';
import { createNewResource } from '../../ResourcesList/ResourceSource';
import type { ByokExtraTool, ByokExtraToolResult } from './ByokExtraTools';

const electron = optionalRequire('electron');
const ipcRenderer = electron ? electron.ipcRenderer : null;
const fs = optionalRequire('fs-extra');
const pathLib = optionalRequire('path');

const gd: libGDevelop = global.gd;

/**
 * The resource import tool (Phase 11, D11-3): brings real files into the
 * project — images, audio, fonts, JSON… — from a URL (downloaded through
 * the existing `local-file-download` IPC), an absolute path (copied into
 * the project folder, with dedupe), or a project-relative path (registered
 * in place). `replace_existing` retargets an existing resource in place
 * (same resource object, so every reference follows). Desktop-only: the
 * web build has neither fs nor the download IPC — the call fails with an
 * explicit message. Everything environment-specific is injected into the
 * core so the tests need no real filesystem.
 */

export type ByokResourceImportEntry = {|
  kind?: string,
  source: string,
  name?: string,
|};

export type ByokResourceImportDeps = {|
  // The fs subset used: existsSync, copyFile, ensureDir.
  fs: any,
  pathLib: any,
  // Downloads a URL to a local path (the Electron IPC wrapper).
  downloadFile: (url: string, targetPath: string) => Promise<void>,
|};

export type ByokResourceImportEntryResult = {|
  source: string,
  name: string | null,
  kind: string | null,
  file: string | null,
  status: 'registered' | 'replaced' | 'already-exists' | 'failed',
  error?: string,
  usedBy?: Array<string>,
|};

const FILE_EXTENSION_TO_KIND: { [string]: string } = {
  aac: 'audio',
  wav: 'audio',
  mp3: 'audio',
  ogg: 'audio',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  ttf: 'font',
  otf: 'font',
  mp4: 'video',
  webm: 'video',
  json: 'json',
};

/** The kind for an entry: explicit wins, else inferred from the extension. */
export const inferByokResourceKind = (
  entry: ByokResourceImportEntry
): string | null => {
  const explicitKind = entry.kind;
  if (explicitKind && createNewResource(explicitKind)) return explicitKind;
  const extension = entry.source.split('.').pop() || '';
  const inferred = FILE_EXTENSION_TO_KIND[extension.toLowerCase()];
  if (inferred && createNewResource(inferred)) return inferred;
  return null;
};

/**
 * Whether absolutePath lies inside projectFolder — segment-aware (a sibling
 * folder whose name merely extends the project folder's name does not
 * count: "/projects/game2/x.png" is NOT inside "/projects/game").
 */
const isPathInsideFolder = (
  deps: ByokResourceImportDeps,
  absolutePath: string,
  projectFolder: string
): boolean => {
  const relative = deps.pathLib.relative(projectFolder, absolutePath);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !deps.pathLib.isAbsolute(relative))
  );
};

/** A collision-free target path in the project folder (name, name-1, …). */
const makeUnusedTargetPath = (
  deps: ByokResourceImportDeps,
  projectFolder: string,
  fileName: string
): string => {
  const candidate = deps.pathLib.join(projectFolder, fileName);
  if (!deps.fs.existsSync(candidate)) return candidate;
  const extension = deps.pathLib.extname(fileName);
  const baseName = deps.pathLib.basename(fileName, extension);
  let suffix = 1;
  while (
    deps.fs.existsSync(
      deps.pathLib.join(projectFolder, `${baseName}-${suffix}${extension}`)
    )
  ) {
    suffix += 1;
  }
  return deps.pathLib.join(projectFolder, `${baseName}-${suffix}${extension}`);
};

const fileNameFromUrl = (deps: ByokResourceImportDeps, url: string): string => {
  try {
    const parsed = new URL(url);
    // Decode FIRST, sanitize AFTER: basename leaves "%2F" and "%5C" intact,
    // so decoding later would smuggle separators past the sanitizing
    // basename — a traversal straight out of the project folder
    // (audit011026 B-TOOL-2).
    const decoded = decodeURIComponent(parsed.pathname);
    // sanitizeFilename is the app's own rule and rejects the Windows shapes
    // the guards below miss: a colon (an NTFS Alternate Data Stream, e.g.
    // "hero.png:secret") and a reserved device name ("CON.png", "nul").
    // audit011026 B-ELEC-12 fixed those for the chat/RAG file names but
    // never reached this model-controlled path (audit100226 ELEC-18).
    const safeName = sanitizeFilename(deps.pathLib.basename(decoded));
    if (
      safeName &&
      safeName !== '.' &&
      safeName !== '..' &&
      safeName.indexOf('/') === -1 &&
      safeName.indexOf('\\') === -1
    ) {
      return safeName;
    }
  } catch (error) {
    // Not a parsable/decodable URL: fall through to the fallback name.
  }
  return 'download';
};

/** Report-only: which objects use a resource (the registry's usage guard). */
const listObjectsUsingResource = (
  project: any,
  resourceName: string
): Array<string> => {
  const resourcesManager = project.getResourcesManager();
  const collector = new gd.ObjectsUsingResourceCollector(
    resourcesManager,
    resourceName
  );
  (gd.ProjectBrowserHelper: any).exposeProjectObjects(project, collector);
  const objectNames = collector.getObjectNames().toJSArray();
  collector.delete();
  return objectNames;
};

const makeEntryFailure = (
  source: string,
  error: string
): ByokResourceImportEntryResult => ({
  source,
  name: null,
  kind: null,
  file: null,
  status: 'failed',
  error,
});

/**
 * Resolve one entry's source to a file INSIDE the project folder (downloading
 * or copying as needed), returned as a project-relative path — or the entry
 * failure. In-project sources register in place.
 */
const resolveEntryToFile = async (
  project: any,
  entry: ByokResourceImportEntry,
  deps: ByokResourceImportDeps
): Promise<{|
  file: string | null,
  error: string | null,
  absolutePath: string | null,
|}> => {
  const projectFolder = deps.pathLib.dirname(project.getProjectFile());

  if (isURL(entry.source)) {
    const targetPath = makeUnusedTargetPath(
      deps,
      projectFolder,
      fileNameFromUrl(deps, entry.source)
    );
    try {
      await deps.downloadFile(entry.source, targetPath);
    } catch (error) {
      return {
        file: null,
        absolutePath: null,
        error: `The download failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    return {
      file: deps.pathLib
        .relative(projectFolder, targetPath)
        .replace(/\\/g, '/'),
      absolutePath: targetPath,
      error: null,
    };
  }

  if (deps.pathLib.isAbsolute(entry.source)) {
    if (!deps.fs.existsSync(entry.source)) {
      return {
        file: null,
        absolutePath: null,
        error: `File not found: ${entry.source}`,
      };
    }
    // Already inside the project folder: register in place.
    if (isPathInsideFolder(deps, entry.source, projectFolder)) {
      return {
        file: deps.pathLib
          .relative(projectFolder, entry.source)
          .replace(/\\/g, '/'),
        absolutePath: entry.source,
        error: null,
      };
    }
    // Copy into the project folder (the LocalResourceSources semantics,
    // dedupe included).
    // Same rule as the URL branch: no ADS colon, no reserved device name on
    // the target we write (audit100226 ELEC-18).
    const fileName = sanitizeFilename(deps.pathLib.basename(entry.source));
    const targetPath = makeUnusedTargetPath(deps, projectFolder, fileName);
    try {
      await deps.fs.copyFile(entry.source, targetPath);
    } catch (error) {
      return {
        file: null,
        absolutePath: null,
        error: `The copy failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    return {
      file: deps.pathLib
        .relative(projectFolder, targetPath)
        .replace(/\\/g, '/'),
      absolutePath: targetPath,
      error: null,
    };
  }

  // A project-relative path: register in place, but never accept one that
  // escapes the project folder (../..).
  const resolved = deps.pathLib.resolve(projectFolder, entry.source);
  if (!isPathInsideFolder(deps, resolved, projectFolder)) {
    return {
      file: null,
      absolutePath: null,
      error: `Refused: "${entry.source}" resolves outside the project folder.`,
    };
  }
  if (!deps.fs.existsSync(resolved)) {
    return {
      file: null,
      absolutePath: null,
      error: `File not found in the project: ${entry.source}`,
    };
  }
  return {
    file: entry.source.replace(/\\/g, '/'),
    absolutePath: resolved,
    error: null,
  };
};

/**
 * The core: import/replace every entry against the project's resource
 * manager. One entry failing never stops the others (results are per
 * entry, the same shape as the registry's search-and-install results).
 */
export const importByokProjectResources = async (options: {|
  project: any,
  entries: Array<ByokResourceImportEntry>,
  replaceExisting: boolean,
  deps: ByokResourceImportDeps,
|}): Promise<Array<ByokResourceImportEntryResult>> => {
  const { project, entries, replaceExisting, deps } = options;
  const resourcesManager = project.getResourcesManager();
  const results: Array<ByokResourceImportEntryResult> = [];

  for (const entry of entries) {
    if (!entry || typeof entry.source !== 'string' || !entry.source) {
      results.push(
        makeEntryFailure(String(entry && entry.source), 'Missing source.')
      );
      continue;
    }
    const kind = inferByokResourceKind(entry);
    if (!kind) {
      results.push(
        makeEntryFailure(
          entry.source,
          'Unknown resource kind: pass "kind" (image, audio, font, video, json…).'
        )
      );
      continue;
    }
    const resolved = await resolveEntryToFile(project, entry, deps);
    const file = resolved.file;
    if (resolved.error || !file) {
      results.push(makeEntryFailure(entry.source, resolved.error || 'Failed.'));
      continue;
    }

    const defaultName = deps.pathLib.basename(resolved.file);
    const name =
      typeof entry.name === 'string' && entry.name ? entry.name : defaultName;

    if (resourcesManager.hasResource(name)) {
      if (!replaceExisting) {
        results.push({
          source: entry.source,
          name,
          kind,
          file,
          status: 'already-exists',
        });
        continue;
      }
      // Retarget the existing resource in place: same resource object, so
      // every reference in the project follows automatically. A kind
      // mismatch is refused — silently pointing an image resource at a
      // .wav breaks every renderer that follows the reference.
      const existing = resourcesManager.getResource(name);
      const existingKind =
        typeof existing.getKind === 'function' ? existing.getKind() : '';
      if (existingKind && existingKind !== kind) {
        results.push(
          makeEntryFailure(
            entry.source,
            `Refused to replace: the existing resource "${name}" is of kind "${existingKind}", but the new file is of kind "${kind}". Delete the resource first or import under a different name.`
          )
        );
        continue;
      }
      existing.setFile(file);
      existing.setOrigin('byok-import', entry.source);
      results.push({
        source: entry.source,
        name,
        kind,
        file: resolved.file,
        status: 'replaced',
        usedBy: listObjectsUsingResource(project, name),
      });
      continue;
    }

    const resource = createNewResource(kind);
    if (!resource) {
      results.push(
        makeEntryFailure(entry.source, `Unknown resource kind: ${kind}.`)
      );
      continue;
    }
    resource.setName(name);
    resource.setFile(file);
    resource.setOrigin('byok-import', entry.source);
    applyResourceDefaults(project, resource);
    resourcesManager.addResource(resource);
    // addResource stored a copy: free the wrapper (ResourceSelector's rule).
    resource.delete();
    results.push({
      source: entry.source,
      name,
      kind,
      file,
      status: 'registered',
    });
  }

  return results;
};

const makeImportProjectResourcesTool = (): ByokExtraTool => ({
  name: 'import_project_resources',
  modifiesProject: true,
  run: async (args, collaborators): Promise<ByokExtraToolResult> => {
    const project = collaborators.getProject();
    if (!project) {
      return {
        output: {
          success: false,
          message: 'No project is open — open or create one first.',
        },
        didModifyProject: false,
      };
    }
    if (!fs || !pathLib || !ipcRenderer) {
      return {
        output: {
          success: false,
          message:
            'import_project_resources is only available in the desktop app (it needs the local filesystem and downloads).',
        },
        didModifyProject: false,
      };
    }
    const rawEntries = Array.isArray(args.entries) ? args.entries : [];
    const entries: Array<ByokResourceImportEntry> = rawEntries.map(entry =>
      entry && typeof entry === 'object'
        ? {
            kind: typeof entry.kind === 'string' ? entry.kind : undefined,
            source: typeof entry.source === 'string' ? entry.source : '',
            name: typeof entry.name === 'string' ? entry.name : undefined,
          }
        : { source: '' }
    );
    if (entries.length === 0) {
      return {
        output: {
          success: false,
          message: 'The "entries" array is required (kind?, source, name?).',
        },
        didModifyProject: false,
      };
    }

    const results = await importByokProjectResources({
      project,
      entries,
      replaceExisting: args.replace_existing === true,
      deps: {
        fs,
        pathLib,
        // The confined BYOK download IPC (audit011026 B-ELEC-14): the
        // upstream local-file-download attaches the GDevelop cloud session
        // cookie to ANY host and validates nothing — never hand it a
        // model-chosen URL.
        downloadFile: async (url, targetPath) => {
          const result = await ipcRenderer.invoke(
            'byok-download-resource',
            new URL(url).href,
            targetPath,
            project.getProjectFile()
          );
          // The dep is typed `Promise<void>` and its only failure channel
          // is a rejection (resolveEntryToFile catches it); the main
          // handler answers EVERY failure as {ok:false}, so resolving one
          // made a 404 / cap-exceeded / refused download look like a
          // success and the resource was registered pointing at a file
          // that was never written (audit 2026-10-02 ELEC-15).
          if (!result || !result.ok) {
            throw new Error((result && result.error) || 'The download failed.');
          }
        },
      },
    });
    const anyChange = results.some(
      result => result.status === 'registered' || result.status === 'replaced'
    );
    return {
      output: {
        success: results.some(result => result.status !== 'failed'),
        message: anyChange
          ? `Imported ${
              results.filter(r => r.status === 'registered').length
            } resource(s), replaced ${
              results.filter(r => r.status === 'replaced').length
            }.`
          : 'No resource was imported (see the per-entry results).',
        results,
      },
      didModifyProject: anyChange,
    };
  },
});

/** The resource import tools (a fresh read, like ByokExtraTools). */
export const getByokResourceTools = (): Array<ByokExtraTool> => [
  makeImportProjectResourcesTool(),
];
