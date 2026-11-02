// @flow
import * as React from 'react';
import { type I18n as I18nType } from '@lingui/core';
import { ExtensionStoreContext } from '../AssetStore/ExtensionStore/ExtensionStoreContext';
import {
  useInstallExtension,
  checkRequiredExtensionsUpdate,
  getRequiredExtensions,
  getExtensionHeader,
  ensureExtensionsRegistryLoaded,
} from '../AssetStore/ExtensionStore/InstallExtension';
import { type ExtensionShortHeader } from '../Utils/GDevelopServices/Extension';

export type EnsureExtensionInstalledOptions = {|
  extensionName: string,
  onWillInstallExtension: (extensionNames: Array<string>) => void,
  onExtensionInstalled: (extensionNames: Array<string>) => void,
|};

type _UseEnsureExtensionInstalledReturnType = {
  ensureExtensionInstalled: EnsureExtensionInstalledOptions => Promise<void>,
};
export const useEnsureExtensionInstalled = ({
  project,
  getProject,
  i18n,
}: {|
  project: ?gdProject,
  // Read the live project through a getter when the host has one (the
  // BYOK getters pattern): the React `project` prop can be stale for ~1
  // render after a project was created mid-chat (initialize_project), and
  // an extension install in that window would then silently do nothing
  // (or target the previous project) — the O3 memo-staleness fix.
  getProject?: () => ?gdProject,
  i18n: I18nType,
|}): _UseEnsureExtensionInstalledReturnType => {
  const {
    translatedExtensionShortHeadersByName: extensionShortHeadersByName,
    fetchExtensionsAndFilters,
  } = React.useContext(ExtensionStoreContext);
  const installExtension = useInstallExtension();

  return {
    ensureExtensionInstalled: React.useCallback(
      async ({
        extensionName,
        onExtensionInstalled,
        onWillInstallExtension,
      }: EnsureExtensionInstalledOptions) => {
        const liveProject = getProject ? getProject() : project;
        if (!liveProject) return;
        if (liveProject.getCurrentPlatform().isExtensionLoaded(extensionName))
          return;

        // Warm the context for following installs, and get a loaded registry
        // (fetched directly if it was never loaded in this session).
        fetchExtensionsAndFilters();
        const extensionShortHeadersByNameToUse = await ensureExtensionsRegistryLoaded(
          extensionShortHeadersByName
        );

        if (!extensionShortHeadersByNameToUse[extensionName]) {
          throw new Error(
            `Extension "${extensionName}" does not exist in the extension registry. Use a different extension or behavior.`
          );
        }

        const extensionShortHeader = getExtensionHeader(
          extensionShortHeadersByNameToUse,
          extensionName
        );
        if (!extensionShortHeader) {
          throw new Error(
            'Unable to find extension ' + extensionName + ' in the registry.'
          );
        }
        const extensionShortHeaders: Array<ExtensionShortHeader> = [
          extensionShortHeader,
        ];
        const requiredExtensions = getRequiredExtensions(extensionShortHeaders);
        requiredExtensions.push({
          extensionName: extensionShortHeader.name,
          extensionVersion: extensionShortHeader.version,
        });
        const requiredExtensionInstallation = await checkRequiredExtensionsUpdate(
          {
            requiredExtensions,
            project: liveProject,
            extensionShortHeadersByName: extensionShortHeadersByNameToUse,
          }
        );
        await installExtension({
          project: liveProject,
          requiredExtensionInstallation,
          importedSerializedExtensions: [],
          onWillInstallExtension,
          onExtensionInstalled,
          updateMode: 'safeOnly',
          reason: 'extension',
        });
      },
      [
        extensionShortHeadersByName,
        fetchExtensionsAndFilters,
        installExtension,
        getProject,
        project,
      ]
    ),
  };
};
