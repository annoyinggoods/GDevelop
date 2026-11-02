// @flow

/**
 * Phase 16.4 — the one-shot after-export report channel.
 *
 * The optimizer runs inside `launchCompression`, which is plain JavaScript,
 * while the report is a React dialog. The pipeline wrapper publishes the
 * report here and the `ForkAssetReportDialogHost` — mounted once at the
 * MainFrame level ([P16-report-host]) — shows the pending report once,
 * right after the export that produced it, whatever the export path. The
 * store keeps a single pending report (the next export replaces it).
 */

import type { ForkAssetOptimizationReport } from './ForkAssetOptimizerPort';

let pendingReport: ?ForkAssetOptimizationReport = null;
const listeners: Set<() => void> = new Set();

const notify = (): void => {
  listeners.forEach(listener => listener());
};

/** Publish the report of a finished optimization run (replaces any pending). */
export const publishForkAssetReport = (
  report: ForkAssetOptimizationReport
): void => {
  pendingReport = report;
  notify();
};

/** The report waiting to be shown, if any. */
export const getPendingForkAssetReport = (): ?ForkAssetOptimizationReport =>
  pendingReport;

/** Drop the pending report (the dialog was dismissed — it is shown once). */
export const dismissForkAssetReport = (): void => {
  if (!pendingReport) return;
  pendingReport = null;
  notify();
};

/** Subscribe to report changes; returns the unsubscribe function. */
export const subscribeForkAssetReport = (
  listener: () => void
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Test-only: clear the pending report and every listener. */
export const resetForkAssetReportForTests = (): void => {
  pendingReport = null;
  listeners.clear();
};
