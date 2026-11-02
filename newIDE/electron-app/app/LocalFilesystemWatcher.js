// @flow
const fileWatcher = require('chokidar');
const path = require('path');

let subscriptionCancelers = {};
let newSubscriptionId = 1;

const getNewSubscriptionId = () => {
  const id = newSubscriptionId++;
  return id.toString();
};

const normalizePath = path => {
  if (!path) return ''; // Safety check

  return path.replace(/\\/g, '/');
};

const setupWatcher = (folderPath, fileWiseCallback, serializedOptions) => {
  const options = JSON.parse(serializedOptions);
  const newSubscriptionId = getNewSubscriptionId();
  const watcher = fileWatcher
    .watch(folderPath, {
      ignored: candidatePath => {
        // Normalize the path to avoid issues with different path separators (\ on Windows, / on other OSes).
        // Even on Windows, "candidatePath" returned by chokidar is always using "/".
        // So we normalize all paths (candidatePath and ignore paths) to avoid missing ignored files on Windows.
        const normalizedCandidatePath = normalizePath(candidatePath);

        if (
          (options.ignore || []).some(ignore =>
            normalizedCandidatePath.includes(normalizePath(ignore))
          ) ||
          // Force ignore, for safety, any node_modules folder as they are too big and would crash the watcher on macOS.
          // Note that this will ignore any folder whose name is prefixed by "node_modules".
          normalizedCandidatePath.includes('/node_modules') ||
          // Same for git repositories (and any file starting by ".git").
          normalizedCandidatePath.includes('/.git')
        ) {
          console.info(
            `Local file watcher has ignored path "${normalizedCandidatePath}".`
          );
          return true;
        }

        return false;
      },
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 250,
        pollInterval: 100,
      },
    })
    // Fork (Phase 17 [P17-kind-hint]): forward the chokidar event TYPE next
    // to the path, so the renderer can tell an added file from a changed one
    // — and observe a deletion. The event name is passed verbatim
    // ('add' | 'change' | 'unlink').
    .on('change', filePath => fileWiseCallback(filePath, 'change'))
    .on('unlink', filePath => fileWiseCallback(filePath, 'unlink'))
    .on('add', filePath => fileWiseCallback(filePath, 'add'));

  subscriptionCancelers[newSubscriptionId] = () => watcher.unwatch(folderPath);

  return newSubscriptionId;
};

const disableWatcher = id => {
  const subscriptionCanceler = subscriptionCancelers[id];
  if (!subscriptionCanceler) {
    console.log('No watcher subscription to disable.');
    return;
  }
  subscriptionCanceler();
  delete subscriptionCancelers[id];
};

module.exports = {
  setupWatcher,
  disableWatcher,
};
