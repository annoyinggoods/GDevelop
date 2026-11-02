/**
 * Tests of the modules shared between the desktop app and the IDE.
 *
 * The desktop app has no test runner: run them with Node's own one:
 *   node --test newIDE/electron-app/tests/
 */

'use strict';

const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
  loadSharedModule,
  resolveSharedModulePath,
  sharedModulePaths,
} = require('../app/SharedCore');

const electronAppFolder = path.join(__dirname, '..', 'app');
const ideSourceFolder = path.join(__dirname, '..', '..', 'app', 'src');

test('the shared modules are found in the IDE sources during a development run', () => {
  const modulePath = resolveSharedModulePath(
    'AiGeneration/Byok/ByokAtomicWriteCore.js',
    { resourcesPath: undefined }
  );

  assert.strictEqual(
    modulePath,
    path.join(ideSourceFolder, 'AiGeneration/Byok/ByokAtomicWriteCore.js')
  );
});

test('the shared modules are found next to a packaged app', () => {
  const resourcesPath = path.join(__dirname, 'fake-resources');
  const packagedModule = path.join(
    resourcesPath,
    'Shared',
    'AiGeneration',
    'Byok',
    'ByokAtomicWriteCore.js'
  );
  fs.mkdirSync(path.dirname(packagedModule), { recursive: true });
  fs.writeFileSync(packagedModule, 'module.exports = {};');

  try {
    const modulePath = resolveSharedModulePath(
      'AiGeneration/Byok/ByokAtomicWriteCore.js',
      { resourcesPath }
    );
    assert.strictEqual(modulePath, packagedModule);
  } finally {
    fs.rmSync(resourcesPath, { recursive: true, force: true });
  }
});

test('a shared module is found even when its extension is not given', () => {
  const resourcesPath = path.join(__dirname, 'fake-resources-3');
  const packagedModule = path.join(
    resourcesPath,
    'Shared',
    'Utils',
    'LocalFileDownloadCore.js'
  );
  fs.mkdirSync(path.dirname(packagedModule), { recursive: true });
  fs.writeFileSync(packagedModule, 'module.exports = {};');

  try {
    const modulePath = resolveSharedModulePath('Utils/LocalFileDownloadCore', {
      resourcesPath,
    });
    assert.strictEqual(modulePath, packagedModule);
  } finally {
    fs.rmSync(resourcesPath, { recursive: true, force: true });
  }
});

test('a shared module missing from the package falls back on the IDE sources', () => {
  const resourcesPath = path.join(__dirname, 'fake-resources-2');
  fs.mkdirSync(path.join(resourcesPath, 'Shared'), { recursive: true });

  try {
    const modulePath = resolveSharedModulePath(
      'AiGeneration/Byok/ByokAtomicWriteCore.js',
      { resourcesPath }
    );
    assert.strictEqual(
      modulePath,
      path.join(ideSourceFolder, 'AiGeneration/Byok/ByokAtomicWriteCore.js')
    );
  } finally {
    fs.rmSync(resourcesPath, { recursive: true, force: true });
  }
});

test('a shared module can be loaded', () => {
  const core = loadSharedModule('AiGeneration/Byok/ByokAtomicWriteCore.js');

  assert.strictEqual(typeof core.writeByokFileAtomically, 'function');
});

test('every shared module of the manifest exists in the IDE sources', () => {
  sharedModulePaths.forEach(relativePath => {
    const modulePath = path.join(ideSourceFolder, relativePath);
    assert.ok(
      fs.existsSync(modulePath),
      `The shared module ${relativePath} does not exist in the IDE sources.`
    );
  });
});

test('the desktop app never requires the IDE sources directly', () => {
  // Such a require works in a development checkout, but the IDE sources are
  // not shipped: the packaged app then dies with "Cannot find module".
  const offenders = fs
    .readdirSync(electronAppFolder)
    .filter(file => file.endsWith('.js'))
    .filter(file => {
      const content = fs.readFileSync(
        path.join(electronAppFolder, file),
        'utf8'
      );
      return content.indexOf("require('../../app/src/") !== -1;
    });

  assert.deepStrictEqual(
    offenders,
    [],
    'Use SharedCore.loadSharedModule() to load the modules shared with the IDE.'
  );
});
