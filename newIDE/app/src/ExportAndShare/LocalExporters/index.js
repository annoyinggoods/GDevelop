// @flow
import { type Exporter } from '../ShareDialog';
import { localCordovaExportPipeline } from './LocalCordovaExport';
import { localElectronExportPipeline } from './LocalElectronExport';
import { localHTML5ExportPipeline } from './LocalHTML5Export';
import { localFacebookInstantGamesExportPipeline } from './LocalFacebookInstantGamesExport';
import { localOnlineCordovaExportPipeline } from './LocalOnlineCordovaExport';
import { localOnlineCordovaIosExportPipeline } from './LocalOnlineCordovaIosExport';
import { localOnlineElectronExportPipeline } from './LocalOnlineElectronExport';
import { localOnlineWebExportPipeline } from './LocalOnlineWebExport';
import { makeForkAssetOptimizingExportPipeline } from '../../Fork/AssetBuild/ForkAssetOptimizingExportPipeline';
import { cordovaExporter } from '../GenericExporters/CordovaExport';
import { onlineWebExporter } from '../GenericExporters/OnlineWebExport';
import { html5Exporter } from '../GenericExporters/HTML5Export';
import { facebookInstantGamesExporter } from '../GenericExporters/FacebookInstantGamesExport';
import { onlineCordovaExporter } from '../GenericExporters/OnlineCordovaExport';
import { onlineCordovaIosExporter } from '../GenericExporters/OnlineCordovaIosExport';
import { onlineElectronExporter } from '../GenericExporters/OnlineElectronExport';
import { electronExporter } from '../GenericExporters/ElectronExport';

// $FlowFixMe[incompatible-type]
export const localOnlineWebExporter: Exporter = {
  ...onlineWebExporter,
  exportPipeline: localOnlineWebExportPipeline,
};

// Phase 16.3 (D16-4): the fork wraps the two desktop pipelines so the
// build-time asset optimizer runs between the resource download and the
// packaging — inside `launchCompression`, before the zip on the online path
// and as the manual path's tail. The wrapper is a pass-through while the
// feature is off (A16-5); the C++ exporter is never touched.
const forkOptimizingOnlineElectronExportPipeline = makeForkAssetOptimizingExportPipeline(
  localOnlineElectronExportPipeline
);
const forkOptimizingElectronExportPipeline = makeForkAssetOptimizingExportPipeline(
  localElectronExportPipeline
);

export const localAutomatedExporters: Array<Exporter> = [
  // $FlowFixMe[incompatible-type]
  {
    ...html5Exporter,
    exportPipeline: localHTML5ExportPipeline,
  },
  // $FlowFixMe[incompatible-type]
  {
    ...onlineCordovaExporter,
    exportPipeline: localOnlineCordovaExportPipeline,
  },
  // $FlowFixMe[incompatible-type]
  {
    ...onlineCordovaIosExporter,
    exportPipeline: localOnlineCordovaIosExportPipeline,
  },
  // $FlowFixMe[incompatible-type]
  {
    ...onlineElectronExporter,
    exportPipeline: forkOptimizingOnlineElectronExportPipeline,
  },
  // $FlowFixMe[incompatible-type]
  {
    ...facebookInstantGamesExporter,
    exportPipeline: localFacebookInstantGamesExportPipeline,
  },
];

export const localManualExporters: Array<Exporter> = [
  // $FlowFixMe[incompatible-type]
  {
    ...html5Exporter,
    exportPipeline: localHTML5ExportPipeline,
  },
  // $FlowFixMe[incompatible-type]
  {
    ...cordovaExporter,
    exportPipeline: localCordovaExportPipeline,
  },
  // $FlowFixMe[incompatible-type]
  {
    ...electronExporter,
    exportPipeline: forkOptimizingElectronExportPipeline,
  },
];
