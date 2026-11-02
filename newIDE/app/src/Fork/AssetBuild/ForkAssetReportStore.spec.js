// @flow
// Phase 16.4 — the store behind the one-shot after-export report.
import {
  dismissForkAssetReport,
  getPendingForkAssetReport,
  publishForkAssetReport,
  resetForkAssetReportForTests,
  subscribeForkAssetReport,
} from './ForkAssetReportStore';
import type { ForkAssetOptimizationReport } from './ForkAssetOptimizerPort';

const makeReport = (folderPath: string): ForkAssetOptimizationReport => ({
  folderPath,
  ranOptimization: true,
  error: null,
  summary: {
    totalBytesBefore: 0,
    totalBytesAfter: 0,
    savedBytes: 0,
    optimizedCount: 0,
    failedCount: 0,
    largestSavings: [],
  },
  files: [],
  skipped: [],
});

describe('ForkAssetReportStore', () => {
  beforeEach(() => {
    resetForkAssetReportForTests();
  });

  it('starts empty and keeps the latest published report', () => {
    expect(getPendingForkAssetReport()).toBeNull();
    publishForkAssetReport(makeReport('a'));
    expect((getPendingForkAssetReport(): any).folderPath).toBe('a');
    publishForkAssetReport(makeReport('b'));
    expect((getPendingForkAssetReport(): any).folderPath).toBe('b');
  });

  it('notifies the subscribers and unsubscribes cleanly', () => {
    const listener = (jest.fn(): any);
    const unsubscribe = subscribeForkAssetReport(listener);
    publishForkAssetReport(makeReport('a'));
    expect(listener).toHaveBeenCalledTimes(1);
    dismissForkAssetReport();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    publishForkAssetReport(makeReport('b'));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('dismisses only when there is something to dismiss', () => {
    const listener = (jest.fn(): any);
    subscribeForkAssetReport(listener);
    dismissForkAssetReport();
    expect(listener).not.toHaveBeenCalled();
    expect(getPendingForkAssetReport()).toBeNull();
  });

  it('does not leak state across resets', () => {
    publishForkAssetReport(makeReport('a'));
    resetForkAssetReportForTests();
    expect(getPendingForkAssetReport()).toBeNull();
  });
});
