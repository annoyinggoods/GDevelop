/**
 * The pure modules shared with the IDE (newIDE/app/src).
 *
 * The desktop app needs a few of the IDE's pure modules (the atomic write
 * core, the download core, the game code path core...). They live in the IDE
 * sources because the IDE is built with webpack, which cannot import files
 * from outside of its own source folder.
 *
 * In a development checkout the desktop app reads them from the IDE sources.
 * In a packaged app the IDE sources are not shipped, so they are copied next
 * to the app, in the "Shared" folder of the resources (see the
 * "extraResources" of electron-builder-config.js). Without this, the packaged
 * app dies at startup with "Cannot find module".
 */

const fs = require('fs');
const path = require('path');

const sharedModulePaths = require('./SharedModules.json');

/**
 * The folder holding the IDE sources, used in a development checkout.
 */
const ideSourceFolder = path.join(__dirname, '..', '..', 'app', 'src');

/**
 * The folder holding the copies shipped with a packaged app.
 * @param {Object} environment The environment of the process (for the tests).
 */
const getPackagedFolder = environment => {
  const resourcesPath = environment.resourcesPath;
  if (!resourcesPath) {
    return null;
  }
  const packagedFolder = path.join(resourcesPath, 'Shared');
  if (!fs.existsSync(packagedFolder)) {
    return null;
  }
  return packagedFolder;
};

/**
 * Find the file of a module, adding the extension Node would add when it
 * requires it (the callers give the path without its extension).
 * @param {string} filePath The path of the module.
 */
const findModuleFile = filePath => {
  if (fs.existsSync(filePath)) {
    return filePath;
  }
  if (fs.existsSync(filePath + '.js')) {
    return filePath + '.js';
  }
  if (fs.existsSync(filePath + '.json')) {
    return filePath + '.json';
  }
  return null;
};

/**
 * Find the file of a shared module.
 * @param {string} relativePath The path of the module, relative to the IDE sources.
 * @param {Object} environment The environment of the process (for the tests).
 */
const resolveSharedModulePath = (relativePath, environment) => {
  const packagedFolder = getPackagedFolder(environment);
  if (packagedFolder) {
    const packagedModule = findModuleFile(
      path.join(packagedFolder, relativePath)
    );
    if (packagedModule) {
      return packagedModule;
    }
  }

  return path.join(ideSourceFolder, relativePath);
};

/**
 * Load a pure module shared with the IDE.
 * @param {string} relativePath The path of the module, relative to the IDE sources.
 */
const loadSharedModule = relativePath => {
  const modulePath = resolveSharedModulePath(relativePath, {
    resourcesPath: process.resourcesPath,
  });
  return require(modulePath);
};

module.exports = {
  loadSharedModule,
  resolveSharedModulePath,
  sharedModulePaths,
};
