// @flow

/**
 * [P17-B2] — the "Scan in the project folder for new resources" naming
 * contract: `path.relative` is OS-separated, so on Windows the scan used to
 * register resource NAMES with backslashes (`art\hero.png`) while every
 * other path surface uses forward slashes. The glob module is faked to
 * answer with Windows-style absolute paths (what a real scan on Windows
 * sees); everything else (the gd vector, findFilesNotInResources, the
 * project) is real.
 */

import { scanForNewResources } from './LocalProjectResourcesHandler';

const gd: libGDevelop = global.gd;

// $FlowFixMe[cannot-resolve-module] - a Node builtin, used by this spec only.
const nodePath = require('path');

// The glob seam. The module under test lazy-requires 'glob' through
// optionalRequire, which resolves through Jest's module registry — so the
// mock answers from `mockGlobFiles` (assigned before each test).
jest.mock(
  'glob',
  () => (
    pattern: string,
    callback: (error: ?any, files: Array<string>) => void
  ) => {
    callback(null, mockGlobFiles);
  }
);

let mockGlobFiles: Array<string> = [];

const makeProject = () => {
  const project = gd.ProjectHelper.createNewGDJSProject();
  project.setProjectFile(nodePath.join('C:', 'tmp', 'proj', 'game.json'));
  return project;
};

const resourceNames = (project: any): Array<string> =>
  project
    .getResourcesManager()
    .getAllResourceNames()
    .toJSArray();

describe('scanForNewResources', () => {
  beforeEach(() => {
    mockGlobFiles = [nodePath.join('C:', 'tmp', 'proj', 'art', 'hero.png')];
  });

  it('registers resource NAMES with forward slashes on Windows paths', async () => {
    const project = makeProject();
    try {
      await scanForNewResources({
        project,
        extensions: ['png'],
        createResource: () => new gd.ImageResource(),
      });

      const names = resourceNames(project);
      expect(names).toEqual(['art/hero.png']);
      // The file also lands forward-slashed (gd normalizes what
      // `setFile` receives on this path).
      expect(
        project
          .getResourcesManager()
          .getResource('art/hero.png')
          .getFile()
      ).toBe('art/hero.png');
    } finally {
      project.delete();
    }
  });

  it('de-duplicates the name against an existing resource of the same name', async () => {
    const project = makeProject();
    try {
      const resource = new gd.ImageResource();
      resource.setName('art/hero.png');
      resource.setFile('elsewhere.png');
      project.getResourcesManager().addResource(resource);
      resource.delete();

      await scanForNewResources({
        project,
        extensions: ['png'],
        createResource: () => new gd.ImageResource(),
      });

      // The scanned file is not in the resources (a different FILE), so it
      // is added — under a suffixed name, not a backslash duplicate.
      expect(resourceNames(project)).toContain('art/hero.png2');
    } finally {
      project.delete();
    }
  });
});
