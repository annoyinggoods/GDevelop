/**
 * The `byok-download-resource` IPC (audit011026 B-ELEC-14): the confined
 * download path of the BYOK `import_project_resources` tool. Thin on
 * purpose — every rule lives in the Jest-tested core
 * (app/src/AiGeneration/Byok/ByokResourceDownloader.js).
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { session } = require('electron');
const core = require('./SharedCore').loadSharedModule(
  'AiGeneration/Byok/ByokResourceDownloader'
);

const findGDevelopCloudCookieValue = async () => {
  try {
    const cookies = await session.defaultSession.cookies.get({
      domain: 'gdevelop.io',
      name: 'gd_resource',
    });
    return cookies[0] ? cookies[0].value : null;
  } catch (error) {
    return null;
  }
};

const registerByokResourceDownload = ipcMain => {
  const downloadByokResource = core.createByokResourceDownloader({
    https,
    http,
    fs,
    pathLib: path,
    getCloudCookieValue: findGDevelopCloudCookieValue,
  });
  ipcMain.handle(
    'byok-download-resource',
    async (_event, url, outputPath, projectFile) => {
      try {
        return await downloadByokResource({ url, outputPath, projectFile });
      } catch (error) {
        return {
          ok: false,
          error: error && error.message ? error.message : String(error),
        };
      }
    }
  );
};

module.exports = { registerByokResourceDownload };
