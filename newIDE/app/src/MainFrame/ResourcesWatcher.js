// @flow
import * as React from 'react';
import ResourcesLoader from '../ResourcesLoader';
import PreferencesContext from './Preferences/PreferencesContext';
import { type StorageProvider, type FileMetadata } from '../ProjectsStorage';
import type { ResourcesWatcherCallbackPayload } from '../ProjectsStorage/LocalFileStorageProvider/LocalFileResourcesWatcher';

const callbacks: { [key: string]: Function } = {};

let callbackId = 1;
const getNewId = () => {
  return callbackId++;
};

export const registerOnResourceExternallyChangedCallback = (
  callback: Function
): string => {
  const id = getNewId().toString();
  callbacks[id] = callback;
  return id;
};

export const unregisterOnResourceExternallyChangedCallback = (
  callbackId: ?string
) => {
  if (!callbackId || !callbacks[callbackId]) return;
  delete callbacks[callbackId];
};

/**
 * Tell the editors a resource changed on disk. The `fileIdentifier` is the
 * resource's FILE: a project-relative path with forward slashes (what
 * `resource.getFile()` returns for a local resource — the same shape the
 * watcher sends). It was renamed from `identifier` ([P17-B3]) so the one
 * canonical meaning is in the name: senders must NOT pass a resource NAME.
 */
export const triggerOnResourceExternallyChanged = (resourceInfo: {|
  fileIdentifier: string,
|}) => {
  ResourcesLoader.burstAllUrlsCache();
  Object.keys(callbacks).forEach(callbackId =>
    callbacks[callbackId](resourceInfo)
  );
};

// Fork (Phase 17.3): a registry for everything the project-folder watcher
// saw on disk — including files that are NOT resources yet (a newly dropped
// file). The resource-externally-changed registry above cannot serve that
// purpose: it fires per RESOURCE and its semantics are "reload this
// resource", while the asset pipeline needs "here is what happened on
// disk". Fired only from the watcher callback below, never from the manual
// reload path, so a user-triggered "Reload from disk" is not mistaken for
// a file event.
const projectFileEventCallbacks: { [key: string]: Function } = {};

let projectFileEventCallbackId = 1;

export const registerOnProjectFileEventCallback = (
  callback: Function
): string => {
  const id = (projectFileEventCallbackId++).toString();
  projectFileEventCallbacks[id] = callback;
  return id;
};

export const unregisterOnProjectFileEventCallback = (callbackId: ?string) => {
  if (!callbackId || !projectFileEventCallbacks[callbackId]) return;
  delete projectFileEventCallbacks[callbackId];
};

/**
 * The disk event, with the watcher's kind ('add' | 'change' | 'unlink' —
 * Fork, Phase 17 [P17-kind-hint]): unlike the resource-semantic trigger
 * above, a deletion is a first-class event here.
 */
export const triggerOnProjectFileEvent = (
  event: ResourcesWatcherCallbackPayload
) => {
  Object.keys(projectFileEventCallbacks).forEach(callbackId =>
    projectFileEventCallbacks[callbackId](event)
  );
};

const useResourcesWatcher = ({
  getStorageProvider,
  fileMetadata,
  isProjectSplitInMultipleFiles,
}: {|
  getStorageProvider: () => StorageProvider,
  fileMetadata: ?FileMetadata,
  isProjectSplitInMultipleFiles: boolean,
|}) => {
  const {
    values: { watchProjectFolderFilesForLocalProjects },
  } = React.useContext(PreferencesContext);
  // Whole fileMetadata object is not used because lastModifiedDate changes on save
  // thus triggering the effect.
  const fileIdentifier = fileMetadata ? fileMetadata.fileIdentifier : null;

  const informEditorsResourceExternallyChanged = React.useCallback(
    (watcherEvent: ResourcesWatcherCallbackPayload) => {
      // Fork (Phase 17.3): the disk-event registry hears everything the
      // watcher saw (added files included) BEFORE the resource-semantic
      // fan-out below bursts the URL cache.
      triggerOnProjectFileEvent(watcherEvent);
      triggerOnResourceExternallyChanged({
        fileIdentifier: watcherEvent.fileIdentifier,
      });
    },
    []
  );

  React.useEffect(
    () => {
      const storageProvider = getStorageProvider();
      if (
        storageProvider.internalName === 'LocalFile' &&
        !watchProjectFolderFilesForLocalProjects
      ) {
        return;
      }
      if (fileIdentifier && storageProvider.setupResourcesWatcher) {
        const unsubscribe = storageProvider.setupResourcesWatcher({
          fileIdentifier,
          callback: informEditorsResourceExternallyChanged,
          options: {
            isProjectSplitInMultipleFiles,
          },
        });
        return unsubscribe;
      }
    },
    [
      fileIdentifier,
      informEditorsResourceExternallyChanged,
      getStorageProvider,
      watchProjectFolderFilesForLocalProjects,
      isProjectSplitInMultipleFiles,
    ]
  );
};
export default useResourcesWatcher;
