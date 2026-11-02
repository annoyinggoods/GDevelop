// @flow

/**
 * Local persistence of the built-in benchmark reports (Phase 9.5; the
 * "shown next to the model dropdown" half, closed from the Phase 9
 * leftovers on 2026-09-23): the last report per (endpoint, model) stays in
 * localStorage so the user sees the previous result without re-running the
 * ~2-minute benchmark. Nothing ever leaves the machine.
 */

const BYOK_BENCHMARK_STORE_PREFIX = 'gd-byok-benchmark-';

export type ByokStoredBenchmarkReport = {|
  reportText: string,
  finishedAt: string,
|};

/** The storage key of one (endpoint, model) pair, sanitized for localStorage. */
export const makeByokBenchmarkStoreKey = (options: {|
  endpointUrl: string,
  modelName: string,
|}): string =>
  BYOK_BENCHMARK_STORE_PREFIX +
  `${options.endpointUrl}|${options.modelName}`.replace(
    /[^a-zA-Z0-9._|-]+/g,
    '_'
  );

const readStorage = (): Storage | null => {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
};

export const saveByokBenchmarkReport = (options: {|
  endpointUrl: string,
  modelName: string,
  reportText: string,
|}): void => {
  const storage = readStorage();
  if (!storage) return;
  const record: ByokStoredBenchmarkReport = {
    reportText: options.reportText,
    finishedAt: new Date().toISOString(),
  };
  try {
    storage.setItem(
      makeByokBenchmarkStoreKey({
        endpointUrl: options.endpointUrl,
        modelName: options.modelName,
      }),
      JSON.stringify(record)
    );
  } catch (error) {
    // A full or blocked storage must never break the settings tab.
  }
};

export const loadByokBenchmarkReport = (options: {|
  endpointUrl: string,
  modelName: string,
|}): ?ByokStoredBenchmarkReport => {
  const storage = readStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(makeByokBenchmarkStoreKey(options));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed.reportText !== 'string' ||
      typeof parsed.finishedAt !== 'string'
    ) {
      return null;
    }
    return {
      reportText: parsed.reportText,
      finishedAt: parsed.finishedAt,
    };
  } catch (error) {
    return null;
  }
};
