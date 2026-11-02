// @flow
import * as React from 'react';
import { t, Trans } from '@lingui/macro';

import { AutoSizer } from 'react-virtualized';
import TreeView from '../../UI/TreeView';
import CompactSelectField from '../../UI/CompactSelectField';
import SelectOption from '../../UI/SelectOption';
import InlineCheckbox from '../../UI/InlineCheckbox';
import Text from '../../UI/Text';
import Background from '../../UI/Background';
import { Column, Line } from '../../UI/Grid';
import useForceUpdate from '../../Utils/UseForceUpdate';
import {
  registerOnProjectFileEventCallback,
  unregisterOnProjectFileEventCallback,
} from '../../MainFrame/ResourcesWatcher';
import {
  buildForkAssetTree,
  type ForkAssetTreeItem,
  type ForkAssetTreeTagItem,
} from './ForkAssetTree';
import { collectForkAssetTagVocabulary } from './ForkAssetTags';
import {
  getForkResourceTags,
  subscribeForkAssetTagChanges,
} from './ForkAssetTagStore';
import {
  getForkAssetPipelineSettings,
  setForkAssetPipelineSettings,
  subscribeForkAssetPipelineSettings,
} from './ForkAssetPipelineSettings';
import { updateForkAssetCompletionCatalogFromProject } from './ForkAssetCatalog';

/** The select-field values of the tag filter ("all" and the Untagged bucket). */
export const FORK_ASSET_FILTER_ALL = '';
export const FORK_ASSET_FILTER_UNTAGGED = '__untagged__';

/**
 * Keep only the folder the filter selects ("all" keeps everything, the
 * untagged pseudo-value keeps the Untagged bucket, anything else is a tag
 * name). Pure — spec'd directly.
 */
export const filterForkAssetTreeByTag = (
  tree: Array<ForkAssetTreeTagItem>,
  filterValue: string
): Array<ForkAssetTreeTagItem> => {
  if (filterValue === FORK_ASSET_FILTER_ALL) return tree;
  return tree.filter(folder =>
    filterValue === FORK_ASSET_FILTER_UNTAGGED
      ? folder.tagName === ''
      : folder.tagName === filterValue
  );
};

type Props = {|
  project: gdProject,
  /** Selects/opens a resource in the host editor (the flat list's hook). */
  onSelectResource: (resource: gdResource | null) => void,
  /** The host's current selection (kept for future highlight wiring). */
  selectedResource?: ?gdResource,
  /** Optional render height override (the pane fills by default). */
  height?: number,
|};

/**
 * Phase 17.4 — the Assets view (D17-4): the fork-owned tag tree layered
 * over the flat resource list. An asset appears under every tag it
 * carries; untagged assets stay reachable in their bucket; clicking an
 * asset selects it in the host (the upstream resources editor, which then
 * shows its properties — tags included).
 *
 * The view also hosts the two pipeline toggles (auto-register D17-5,
 * auto-reload D17-7). The lifecycles THEMSELVES moved to the MainFrame
 * ([P17-auto-register-mount], useForkAssetPipelineLifecycles): they run
 * whatever editor is open, not only while this view is mounted.
 */
const ForkAssetsView = ({
  project,
  onSelectResource,
  height,
}: Props): React.Node => {
  const forceUpdate = useForceUpdate();
  const [filterTag, setFilterTag] = React.useState<string>(
    FORK_ASSET_FILTER_ALL
  );

  // Refresh on tag writes (the chip editor or the AI tools), on setting
  // flips and on disk events (external changes, auto-registered files).
  // The same refresh re-feeds the Monaco completion catalog (17.5).
  React.useEffect(
    () => {
      const refresh = () => {
        updateForkAssetCompletionCatalogFromProject(project);
        forceUpdate();
      };
      const unsubscribeTags = subscribeForkAssetTagChanges(refresh);
      const unsubscribeSettings = subscribeForkAssetPipelineSettings(refresh);
      const fileEventCallbackId = registerOnProjectFileEventCallback(refresh);
      updateForkAssetCompletionCatalogFromProject(project);
      return () => {
        unsubscribeTags();
        unsubscribeSettings();
        unregisterOnProjectFileEventCallback(fileEventCallbackId);
      };
    },
    [project, forceUpdate]
  );

  // Recomputed on every render (the project model is mutable — the same
  // discipline as the flat ResourcesList; the subscriptions above decide
  // WHEN a re-render happens).
  const resourcesManager = project.getResourcesManager();
  const entries = resourcesManager
    .getAllResourceNames()
    .toJSArray()
    .map(resourceName => ({
      name: resourceName,
      tags: getForkResourceTags(resourcesManager.getResource(resourceName)),
    }));

  const vocabulary = collectForkAssetTagVocabulary(entries);
  const tree = filterForkAssetTreeByTag(
    buildForkAssetTree({ resources: entries }),
    filterTag
  );

  const settings = getForkAssetPipelineSettings();

  const handleSelectAsset = (item: ForkAssetTreeItem) => {
    if (item.kind !== 'asset') return;
    const resourcesManager = project.getResourcesManager();
    if (!resourcesManager.hasResource(item.name)) return;
    onSelectResource(resourcesManager.getResource(item.name));
  };

  return (
    <Background>
      <Column noMargin expand>
        <Line noMargin alignItems="center" justifyContent="space-between">
          <CompactSelectField
            value={filterTag}
            onChange={(value: string) => setFilterTag(value)}
          >
            <SelectOption
              value={FORK_ASSET_FILTER_ALL}
              label={t`All tags`}
              key="all"
            />
            <SelectOption
              value={FORK_ASSET_FILTER_UNTAGGED}
              label={t`Untagged`}
              key="untagged"
            />
            {vocabulary.map(tag => (
              <SelectOption value={tag} label={tag} key={tag} />
            ))}
          </CompactSelectField>
        </Line>
        <Line noMargin alignItems="center">
          <InlineCheckbox
            label={<Trans>Auto-register dropped files</Trans>}
            checked={settings.autoRegister}
            onCheck={(event, checked) => {
              setForkAssetPipelineSettings({ autoRegister: checked });
            }}
          />
          <InlineCheckbox
            label={<Trans>Auto-reload changed assets</Trans>}
            checked={settings.autoReload}
            onCheck={(event, checked) => {
              setForkAssetPipelineSettings({ autoReload: checked });
            }}
          />
        </Line>
        <Text noMargin size="body-small">
          {filterTag === FORK_ASSET_FILTER_UNTAGGED ? (
            <Trans>Assets without any tag.</Trans>
          ) : (
            <Trans>
              Assets grouped by tags — one asset appears under every tag it
              carries.
            </Trans>
          )}
        </Text>
        <div style={{ flex: 1 }}>
          {height !== undefined ? (
            <ForkAssetsTreeView
              tree={tree}
              height={height}
              onSelectAsset={handleSelectAsset}
            />
          ) : (
            <AutoSizer defaultHeight={400} defaultWidth={400}>
              {({ height: sizedHeight, width }) => (
                <ForkAssetsTreeView
                  tree={tree}
                  height={sizedHeight}
                  width={width}
                  onSelectAsset={handleSelectAsset}
                />
              )}
            </AutoSizer>
          )}
        </div>
      </Column>
    </Background>
  );
};

type TreeViewProps = {|
  tree: Array<ForkAssetTreeTagItem>,
  height: number,
  width?: number,
  onSelectAsset: (item: ForkAssetTreeItem) => void,
|};

/** The TreeView wrapper (GameCodeTree's usage pattern). */
const ForkAssetsTreeView = ({
  tree,
  height,
  width,
  onSelectAsset,
}: TreeViewProps): React.Node => (
  // $FlowFixMe[incompatible-type] - TreeView typing has issues (see "treeview typing issues" in the codebase).
  <TreeView
    items={(tree: any)}
    height={height}
    width={width}
    multiSelect={false}
    getItemId={(item: ForkAssetTreeItem) =>
      item.kind === 'tag' ? 'tag:' + item.tagName : 'asset:' + item.name
    }
    getItemName={(item: ForkAssetTreeItem) => item.name}
    getItemChildren={(item: ForkAssetTreeItem) =>
      item.kind === 'tag' ? item.children : null
    }
    onClickItem={onSelectAsset}
    selectedItems={[]}
    onSelectItems={() => {}}
    onRenameItem={() => {}}
    onMoveSelectionToItem={() => {}}
    canMoveSelectionToItem={() => false}
    buildMenuTemplate={() => []}
    reactDndType="fork-asset-tree-item"
    forceAllOpened
  />
);

export default ForkAssetsView;
