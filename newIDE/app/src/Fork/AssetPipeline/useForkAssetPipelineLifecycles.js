// @flow
import * as React from 'react';

import { startForkAssetAutoRegister } from './ForkAssetAutoRegister';
import { startForkAssetAutoReload } from './ForkAssetAutoReload';

/**
 * Phase 17 ([P17-auto-register-mount]) — the project-wide asset pipeline
 * lifecycles, mounted ONCE from the MainFrame.
 *
 * Both used to mount inside ForkAssetsView, which kept the Phase 17 upstream
 * budget at zero — but it also meant a dropped file was only registered (and
 * a changed asset only hot-reloaded) while the Resources editor was open.
 * This hook moves the two lifecycles to the MainFrame level (the same
 * pattern as the MCP endpoint host), keyed on the open project: whatever
 * editor is open, the pipeline runs. The view keeps only its own refresh
 * subscriptions.
 */

type Options = {|
  project: ?any,
  /** Called whenever the auto-registration changed the project model. */
  onProjectModified: () => void,
|};

export const useForkAssetPipelineLifecycles = (options: Options): void => {
  const { project, onProjectModified } = options;

  React.useEffect(
    () => {
      if (!project) return () => {};
      return startForkAssetAutoRegister({
        project,
        onProjectModified,
      });
    },
    [project, onProjectModified]
  );

  React.useEffect(
    () => {
      if (!project) return () => {};
      return startForkAssetAutoReload({ project });
    },
    [project]
  );
};

export default useForkAssetPipelineLifecycles;
