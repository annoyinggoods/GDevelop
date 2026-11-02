/* eslint-disable no-undef */

/**
 * The atomic write both Electron main-process BYOK file modules use
 * (chat files, RAG files): write to a temp file in the same folder, then
 * rename over the target so a crash never leaves a truncated file where a
 * working one was (audit011026 B-ELEC-10 / B-RAG-11).
 *
 * Plain CJS on purpose: the Electron main process requires it directly
 * (electron-app has no test runner), and Jest specs it from the renderer —
 * the same pattern as ByokMcpStdioAdapterCore.js and
 * Utils/LocalFileDownloadCore.js.
 *
 * The temp name is UNIQUE per call. It used to be `<file>.tmp-<pid>`, so two
 * concurrent writers of the same file (the same durable chat open in two
 * windows, or two bundle downloads to the fixed bundle name) wrote the same
 * temp path and each rename could publish the other writer's buffer
 * (audit100226 ELEC-19).
 */

/**
 * The temp file name for one write. `uniqueToken` makes two concurrent
 * writes of the same target collide no longer.
 */
const makeByokAtomicTempName = (fileName, uniqueToken) =>
  `${fileName}.tmp-${process.pid}-${uniqueToken}`;

/**
 * Write `content` to `folderPath/fileName` atomically.
 *
 * `createUniqueToken` is injected so the tests are deterministic; production
 * passes `() => require('crypto').randomBytes(8).toString('hex')`.
 * Throws whatever `fs` throws, after removing the temp file so a failed
 * write leaves nothing behind.
 */
const writeByokFileAtomically = (
  fsModule,
  folderPath,
  fileName,
  content,
  createUniqueToken
) => {
  const path = require('path');
  const finalPath = path.join(folderPath, fileName);
  const temporaryPath = path.join(
    folderPath,
    makeByokAtomicTempName(fileName, createUniqueToken())
  );
  try {
    fsModule.writeFileSync(temporaryPath, content, 'utf8');
    fsModule.renameSync(temporaryPath, finalPath);
  } catch (error) {
    // Best-effort cleanup: the partial temp file must not linger (it would
    // otherwise be enumerated as a chat and counted against the quota).
    try {
      fsModule.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      // The temp file may never have been created.
    }
    throw error;
  }
  return finalPath;
};

module.exports = {
  makeByokAtomicTempName,
  writeByokFileAtomically,
};
