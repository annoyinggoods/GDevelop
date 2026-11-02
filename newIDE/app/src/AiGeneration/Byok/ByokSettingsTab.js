// @flow
import { t, Trans } from '@lingui/macro';
import * as React from 'react';

import PreferencesContext from '../../MainFrame/Preferences/PreferencesContext';
import Checkbox from '../../UI/Checkbox';
import FlatButton from '../../UI/FlatButton';
import { Column, Line } from '../../UI/Grid';
import { ColumnStackLayout, LineStackLayout } from '../../UI/Layout';
import CompactSelectField from '../../UI/CompactSelectField';
import RaisedButton from '../../UI/RaisedButton';
import SelectOption from '../../UI/SelectOption';
import Text from '../../UI/Text';
import TextField from '../../UI/TextField';
import { Accordion, AccordionHeader, AccordionBody } from '../../UI/Accordion';
import {
  BYOK_CUSTOM_INSTRUCTIONS_MAX_CHARS,
  BYOK_IMAGE_SUPPORTS,
  BYOK_REASONING_EFFORTS,
  BYOK_ROUTING_MODES,
  BYOK_CHAT_STORAGE_QUOTA_BYTES,
  DEFAULT_BYOK_SETTINGS,
  DEFAULT_STALL_WINDOW_SECONDS,
  MAX_CONTEXT_WINDOW_TOKENS,
  MIN_CONTEXT_WINDOW_TOKENS,
  getByokSettings,
  getByokProviderModelSettings,
  upsertByokProviderModelSettings,
  removeByokProviderModelSettings,
  type ByokChatCompletionOptions,
  type ByokModelInfo,
  type ByokProvider,
  type ByokProviderModelSettings,
  type ByokSettings,
} from './ByokTypes';
import {
  clearByokKey,
  getByokKeyStorageInfo,
  loadByokKey,
  saveByokKey,
} from './ByokKeyStorage';
import {
  classifyByokError,
  getGenericMessageForKind,
  type ByokError,
  type ByokErrorKind,
} from './ByokErrors';
import {
  clearByokModels,
  getCachedByokModels,
  refreshByokModels,
} from './ByokModelsCache';
import { sendByokChatCompletionWithRetries } from './ByokClient';
import { buildEventScriptSourceView } from '../../EventsSheet/EventsTree/TextRenderer/EventScriptSourceView';
import {
  buildLegacyMigrationProviders,
  makeByokProviderId,
  migrateByokRoutingProfiles,
  removeByokProvider,
} from './ByokModelRouter';
import { exportByokFeedbackJson } from './ByokSuggestions';
import { getByokChatPersistence } from './ByokChatStore';
import {
  BYOK_BENCHMARK_MAX_OUTPUT_TOKENS,
  formatByokBenchmarkReport,
  runByokBenchmark,
  type ByokBenchmarkProjectSnapshot,
  type ByokBenchmarkReport,
} from './ByokBenchmark';
import {
  loadByokBenchmarkReport,
  saveByokBenchmarkReport,
} from './ByokBenchmarkStore';
import { editorFunctions } from '../../EditorFunctions';
import { findByNameokExtraTool } from './ByokExtraTools';
import ByokMcpSettingsCard from './Mcp/ByokMcpSettingsCard';

/**
 * Keep the context window in a range every provider accepts: below the
 * minimum, requests would lose too much context; above the maximum, the
 * value is almost certainly a typo (and would break the request budgeting).
 */
export const clampContextWindow = (value: number): number => {
  if (Number.isNaN(value)) return DEFAULT_BYOK_SETTINGS.contextWindowTokens;
  if (value < MIN_CONTEXT_WINDOW_TOKENS) return MIN_CONTEXT_WINDOW_TOKENS;
  if (value > MAX_CONTEXT_WINDOW_TOKENS) return MAX_CONTEXT_WINDOW_TOKENS;
  return value;
};

/**
 * The storage-status text shown under the API key field: null (row hidden)
 * when no key is stored, the OS-encryption text on the desktop app, and the
 * honest obfuscation warning on the web build.
 */
export const getKeyStorageStatusText = (
  encrypted: boolean,
  hasStoredKey: boolean
): React.Node => {
  if (!hasStoredKey) return null;
  if (encrypted) {
    return (
      <Trans>
        Your API key is encrypted by your operating system (DPAPI on Windows)
        and can only be read by this app under your user account.
      </Trans>
    );
  }
  return (
    <Trans>
      Your API key is stored with light obfuscation only. The desktop app
      protects it with OS-level encryption.
    </Trans>
  );
};

/**
 * The translated message for each error kind — the display-side counterpart
 * of ByokErrors' English fallbacks (which stay machine-readable and are also
 * what non-React consumers log).
 */
const renderGenericMessageForKind = (kind: ByokErrorKind): React.Node => {
  if (kind === 'authentication') {
    return (
      <Trans>
        Your API key was rejected by the endpoint (401). Check the API key in
        the BYOK settings.
      </Trans>
    );
  }
  if (kind === 'forbidden') {
    return (
      <Trans>
        The endpoint refused the request (403). Your API key may not have access
        to this model or resource.
      </Trans>
    );
  }
  if (kind === 'not-found') {
    return (
      <Trans>
        The endpoint was not found (404). Check the base URL in the BYOK
        settings: for most providers it should end with /v1.
      </Trans>
    );
  }
  if (kind === 'rate-limit') {
    return (
      <Trans>
        The endpoint is rate-limiting the requests (429). Wait a moment and try
        again.
      </Trans>
    );
  }
  if (kind === 'invalid-request') {
    return (
      <Trans>
        The endpoint rejected the request as invalid (400). The request
        contained something it does not accept.
      </Trans>
    );
  }
  if (kind === 'server') {
    return <Trans>The endpoint had an internal error. Try again later.</Trans>;
  }
  if (kind === 'network') {
    return (
      <Trans>
        Could not reach the endpoint (network error). Check the base URL and
        your internet connection.
      </Trans>
    );
  }
  if (kind === 'timeout') {
    return (
      <Trans>
        The endpoint took too long to answer (timeout). Try again in a moment.
      </Trans>
    );
  }
  if (kind === 'cancelled') {
    return <Trans>The request was cancelled.</Trans>;
  }
  return <Trans>The endpoint returned an unexpected error.</Trans>;
};

/**
 * What to show the user for a BYOK error: the endpoint-provided message when
 * it sent one (dynamic text, escaped by React), the translated generic
 * message otherwise.
 */
export const renderByokErrorMessage = (error: ByokError): React.Node => {
  if (error.message !== getGenericMessageForKind(error.kind)) {
    return error.message;
  }
  return renderGenericMessageForKind(error.kind);
};

// The value of the "Type manually…" option of the models dropdown: chosen,
// it swaps the dropdown back to the free-text field (for servers without a
// /models endpoint).
const MANUAL_MODEL_OPTION_VALUE = '__manual__';

// A test ping should fail fast, not hold the button for up to 3 × 120s of
// retries (the conversation timeout does not fit a settings dialog).
const CONNECTION_TEST_TIMEOUT_MS = 15000;

type ConnectionTestResult = {| ok: boolean, message: React.Node |};

// ---- The benchmark's bridge to the real tools (Phase 9.5) ----
// The benchmark module is pure (executor + snapshot injected); these two
// helpers adapt the editor registry and libGDevelop to it. They run on a
// scratch project, never on the user's.

/**
 * Read the scratch project back into the plain shape the scorers run on.
 * The events are rendered as EventScript text — the exact format the
 * scorers parse with parseByokEventScript (the same source view the
 * read_events_source tool serves). The historical alternative
 * (`gd.Serializer.toJSON(scene.getEvents())`) was doubly wrong: it passed
 * an EventsList where a SerializerElement is required (a type confusion
 * that crashed the libGD WASM heap and poisoned the module until reload —
 * the outofscoped.md O1 entry), and its output was gd serialized JSON,
 * which the EventScript scorer can never parse.
 */
const BYOK_BENCHMARK_SNAPSHOT_MAX_CHARS = 30000;

/**
 * The model name a provider's Test button sends, or '' when the provider has
 * no model at all. A provider card can be created before any model is
 * configured for it (Phase 13.4 ships an empty `modelSettings`), and a
 * fetched model list is a perfectly good model to test with — so fall back
 * to the first one. The old code sent `''` in that case, and the endpoint's
 * "model not found" answer told the user their endpoint and key were broken
 * (audit100226 UI-10). Returns '' so the caller can refuse the request with
 * an actionable message instead of sending a doomed ping.
 */
export const resolveByokProviderTestModelName = (
  provider: ByokProvider,
  cachedModels: $ReadOnlyArray<{ id: string, ... }>
): string => {
  if (provider.modelSettings.length > 0) {
    return provider.modelSettings[0].modelName;
  }
  const firstCachedModel = cachedModels[0];
  return firstCachedModel ? firstCachedModel.id : '';
};

export const snapshotProjectForBenchmark = (
  project: any
): ByokBenchmarkProjectSnapshot => {
  const scenes = [];
  for (let index = 0; index < project.getLayoutsCount(); index++) {
    const scene = project.getLayoutAt(index);
    const objectNames = [];
    const objects = scene.getObjects();
    for (
      let objectIndex = 0;
      objectIndex < objects.getObjectsCount();
      objectIndex++
    ) {
      objectNames.push(objects.getObjectAt(objectIndex).getName());
    }
    let eventsSource = null;
    try {
      const view = buildEventScriptSourceView({
        eventsList: scene.getEvents(),
        maxChars: BYOK_BENCHMARK_SNAPSHOT_MAX_CHARS,
      });
      eventsSource = view.text.length > 0 ? view.text : null;
    } catch (error) {
      // An unreadable events list scores as "no events written".
    }
    scenes.push({
      name: scene.getName(),
      objectNames,
      eventsSource,
    });
  }
  return ({
    scenes,
    firstSceneName:
      project.getLayoutsCount() > 0 ? project.getLayoutAt(0).getName() : null,
  }: any);
};

/**
 * A libGD/WASM abort during a benchmark run is not an endpoint error: the
 * module is poisoned until the window reloads, and "the endpoint returned
 * an unexpected error" sends the user debugging the wrong side.
 */
export const describeByokBenchmarkCrash = (rawError: any): string | null => {
  const message =
    rawError instanceof Error ? rawError.message : String(rawError);
  if (/memory access out of bounds|abort\(/i.test(message)) {
    return 'The GDevelop engine crashed while running the benchmark (a WebAssembly memory error). Reload the IDE window, then run the benchmark again.';
  }
  return null;
};

/** Delete the scratch project wrapper (leaks the WASM heap if skipped). */
const deleteScratchProject = (scratchProject: any): void => {
  if (scratchProject && typeof scratchProject.delete === 'function') {
    scratchProject.delete();
  }
};

/**
 * Execute the benchmark model's tool calls against the scratch project:
 * the intercepted BYOK tools first (the local event writer), then the
 * editor registry's launch functions. Results are tool-message shaped.
 */
const executeByokBenchmarkCalls = async ({
  calls,
  project,
}: {|
  calls: Array<{| name: string, arguments: string |}>,
  project: any,
|}) => {
  const results = [];
  for (const call of calls) {
    const extraTool = findByNameokExtraTool(call.name);
    if (extraTool) {
      try {
        const { output } = await extraTool.run(JSON.parse(call.arguments), {
          getProject: () => project,
          onSceneEventsModifiedOutsideEditor: () => {},
        });
        results.push({
          call_id: call.name,
          success: !!output.success,
          output: JSON.stringify(output),
        });
      } catch (error) {
        results.push({
          call_id: call.name,
          success: false,
          output: JSON.stringify({
            success: false,
            message: error instanceof Error ? error.message : String(error),
          }),
        });
      }
      continue;
    }

    const editorFunction = editorFunctions[call.name] || null;
    if (!editorFunction || !editorFunction.launchFunction) {
      results.push({
        call_id: call.name,
        success: false,
        output: JSON.stringify({
          success: false,
          message: `The tool "${
            call.name
          }" is not available for the benchmark.`,
        }),
      });
      continue;
    }
    try {
      const output = await editorFunction.launchFunction(
        ({
          project,
          args: JSON.parse(call.arguments),
        }: any)
      );
      results.push({
        call_id: call.name,
        success: !(output && output.success === false),
        output: JSON.stringify(output || { success: true }),
      });
    } catch (error) {
      results.push({
        call_id: call.name,
        success: false,
        output: JSON.stringify({
          success: false,
          message: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  }
  return results;
};

const ByokSettingsTab = (): React.Node => {
  const { values, setMultipleValues } = React.useContext(PreferencesContext);
  const byokSettings = getByokSettings(values);
  const gd: libGDevelop = global.gd;
  // The API key lives in its own storage (see `saveByokKey`), never in the
  // preferences: it is held here in local state until the field is left.
  const [apiKey, setApiKey] = React.useState<string>('');
  // Whether the user actually edited the key field since it was last
  // committed: leaving an untouched field must save nothing — in particular,
  // an *empty untouched* field must never clear the stored key on a mere
  // click-through (D10).
  const [isKeyFieldEdited, setIsKeyFieldEdited] = React.useState<boolean>(
    false
  );
  const [
    isKeyStorageEncrypted,
    setIsKeyStorageEncrypted,
  ] = React.useState<boolean>(false);
  const [hasStoredKey, setHasStoredKey] = React.useState<boolean>(false);
  const [
    fetchedModels,
    setFetchedModels,
  ] = React.useState<?Array<ByokModelInfo>>(null);
  const [isFetchingModels, setIsFetchingModels] = React.useState<boolean>(
    false
  );
  const [
    modelsFetchMessage,
    setModelsFetchMessage,
  ] = React.useState<?React.Node>(null);
  const [
    isManuallyTypingModel,
    setIsManuallyTypingModel,
  ] = React.useState<boolean>(false);
  const [isTestingConnection, setIsTestingConnection] = React.useState<boolean>(
    false
  );
  const [
    connectionTestResult,
    setConnectionTestResult,
  ] = React.useState<?ConnectionTestResult>(null);
  // The raw text of the default context-window field being edited: while
  // set, the field shows it as-is and the clamped value is persisted only on
  // blur — clamping on every keystroke would rewrite what the user is typing.
  const [
    defaultContextWindowDraft,
    setDefaultContextWindowDraft,
  ] = React.useState<string | null>(null);
  // The raw text of a per-model field being edited (Phase 13.4): same
  // commit-on-blur discipline, keyed by provider id + model name + field.
  const [perModelDraft, setPerModelDraft] = React.useState<{|
    providerId: string,
    modelName: string,
    field: 'temperature' | 'maxTokens' | 'contextWindowTokens',
    text: string,
  |} | null>(null);

  // Async handlers must not update state once the dialog is closed.
  const isSubscribedRef = React.useRef<boolean>(true);
  React.useEffect(() => {
    isSubscribedRef.current = true;
    return () => {
      isSubscribedRef.current = false;
    };
  }, []);

  // The save triggered by leaving the key field is async (an IPC round-trip
  // on desktop): buttons reading the key await this promise first, so
  // "type a key then immediately click Fetch models" cannot race the save
  // and read the previous (or empty) stored key.
  const pendingKeySaveRef = React.useRef<?Promise<boolean>>(null);

  const refreshKeyStorageState = React.useCallback(async () => {
    const storageInfo = await getByokKeyStorageInfo();
    const storedKey = await loadByokKey();
    if (!isSubscribedRef.current) return;

    setIsKeyStorageEncrypted(storageInfo.encrypted);
    // An unreadable entry still exists (e.g. a key that can no longer be
    // decrypted after an OS account change): the "Clear the stored key"
    // button must stay available to remove it.
    setHasStoredKey(storedKey.status !== 'none');
  }, []);

  React.useEffect(
    () => {
      refreshKeyStorageState();
    },
    [refreshKeyStorageState]
  );

  // Partial rather than the $Shape the preferences files use: this Flow
  // version flags $Shape as deprecated.
  const updateByokSetting = (partial: Partial<ByokSettings>) => {
    setMultipleValues({ byok: { ...byokSettings, ...partial } });
  };

  // The models fetched in a previous visit of the tab are shown right away
  // (a pure read of the in-memory cache, safe during render).
  const cachedModels = getCachedByokModels(byokSettings.endpointUrl);
  const visibleModels = fetchedModels || cachedModels;

  const showModelsDropdown =
    !!visibleModels &&
    visibleModels.length > 0 &&
    !isManuallyTypingModel &&
    // A model the list does not contain (typed manually earlier) would
    // render as a blank dropdown selection: keep the free-text field until
    // the model appears in the list.
    (!byokSettings.modelName ||
      visibleModels.some(model => model.id === byokSettings.modelName));

  const onFetchModels = async () => {
    setIsFetchingModels(true);
    setModelsFetchMessage(null);
    setIsManuallyTypingModel(false);

    try {
      if (pendingKeySaveRef.current) await pendingKeySaveRef.current;
      const storedKey = await loadByokKey();
      const storedApiKey = storedKey.status === 'ok' ? storedKey.key : '';
      const models = await refreshByokModels({
        baseUrl: byokSettings.endpointUrl,
        apiKey: storedApiKey,
      });
      if (!isSubscribedRef.current) return;

      setFetchedModels(models);
      if (models.length === 0) {
        setModelsFetchMessage(
          <Trans>
            The endpoint returned an empty model list. Type the model name
            manually below.
          </Trans>
        );
      }
    } catch (rawError) {
      if (!isSubscribedRef.current) return;

      const byokError = classifyByokError(rawError);
      setModelsFetchMessage(renderByokErrorMessage(byokError));
    } finally {
      if (isSubscribedRef.current) setIsFetchingModels(false);
    }
  };

  const onTestConnection = async () => {
    setIsTestingConnection(true);
    setConnectionTestResult(null);

    const options: ByokChatCompletionOptions = {
      model: byokSettings.modelName,
      messages: [{ role: 'user', content: 'ping' }],
      timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
    };
    if (byokSettings.reasoningEffort !== 'default') {
      options.reasoningEffort = byokSettings.reasoningEffort;
    }

    try {
      if (pendingKeySaveRef.current) await pendingKeySaveRef.current;
      const storedKey = await loadByokKey();
      const storedApiKey = storedKey.status === 'ok' ? storedKey.key : '';
      await sendByokChatCompletionWithRetries({
        baseUrl: byokSettings.endpointUrl,
        apiKey: storedApiKey,
        options,
      });
      if (!isSubscribedRef.current) return;

      setConnectionTestResult({
        ok: true,
        message: (
          <Trans>
            Connection successful! The endpoint answered the test message.
          </Trans>
        ),
      });
    } catch (rawError) {
      if (!isSubscribedRef.current) return;

      const byokError = classifyByokError(rawError);
      setConnectionTestResult({
        ok: false,
        message: renderByokErrorMessage(byokError),
      });
    } finally {
      if (isSubscribedRef.current) setIsTestingConnection(false);
    }
  };

  const saveApiKey = () => {
    const savePromise = saveByokKey(apiKey).then(saved => {
      // The cached model list belongs to the previous key: forget it so the
      // next fetch reflects what the new key can access.
      if (apiKey) clearByokModels();
      return saved;
    });
    pendingKeySaveRef.current = savePromise;
    savePromise.then(() => {
      if (isSubscribedRef.current) refreshKeyStorageState();
    });
  };

  // ---- The migrations of the settings data (run once per tab visit) ----

  // The legacy single endpoint migrates into provider #1 on first visit
  // (9.4): it keeps keyRef '' — the legacy key slot — so nothing is lost.
  React.useEffect(
    () => {
      const migration = buildLegacyMigrationProviders(byokSettings);
      if (migration) updateByokSetting({ providers: migration });
    },
    // Runs once per visit of the tab: the migration is idempotent anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // The Phase 13.4 routing-pair migration: old profiles (model name, no
  // provider) fall back to the first provider.
  React.useEffect(
    () => {
      const migrated = migrateByokRoutingProfiles(byokSettings);
      if (migrated) {
        setMultipleValues({ byok: migrated });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // ---- Providers (Phase 9.4 + the 13.4 layout) ----

  // Per-provider API keys live in their own slots; the draft state here
  // mirrors the key field pattern of the global key above (commit on blur,
  // only when edited).
  const [providerKeyDrafts, setProviderKeyDrafts] = React.useState<{|
    [providerId: string]: string,
  |}>({});
  const [editedProviderKeyIds, setEditedProviderKeyIds] = React.useState<
    Set<string>
  >(new Set());
  const [providerTestResults, setProviderTestResults] = React.useState<{|
    [providerId: string]: ConnectionTestResult | null,
  |}>({});
  const [providerUnderTestId, setProviderUnderTestId] = React.useState<
    string | null
  >(null);
  const [providerUnderFetchId, setProviderUnderFetchId] = React.useState<
    string | null
  >(null);
  const [providerModelsMessages, setProviderModelsMessages] = React.useState<{|
    [providerId: string]: React.Node,
  |}>({});
  // The "Customize another model" draft: the provider id whose picker row
  // is open (choosing a model materializes the per-model block).
  const [
    providerDraftModelPickerId,
    setProviderDraftModelPickerId,
  ] = React.useState<string | null>(null);
  // The per-(provider, model) benchmark runs (13.4): one at a time, with
  // the report text keyed by `providerId/modelName`.
  const [benchmarkUnderKey, setBenchmarkUnderKey] = React.useState<
    string | null
  >(null);
  const [benchmarkReportsByKey, setBenchmarkReportsByKey] = React.useState<{|
    [key: string]: string,
  |}>({});

  const commitProviderKeyField = (provider: ByokProvider) => {
    if (!editedProviderKeyIds.has(provider.id)) return;
    setEditedProviderKeyIds(previous => {
      const next = new Set(previous);
      next.delete(provider.id);
      return next;
    });
    const key = providerKeyDrafts[provider.id] || '';
    const savePromise = saveByokKey(key, provider.keyRef).then(saved => {
      if (key) clearByokModels();
      return saved;
    });
    savePromise.then(() => {
      if (isSubscribedRef.current) refreshKeyStorageState();
    });
  };

  const onAddProvider = () => {
    const providerId = makeByokProviderId();
    const provider: ByokProvider = {
      id: providerId,
      name: `Provider ${byokSettings.providers.length + 1}`,
      endpointUrl: '',
      keyRef: providerId,
      modelSettings: [],
    };
    updateByokSetting({
      providers: [...byokSettings.providers, provider],
    });
  };

  const onRemoveProvider = (provider: ByokProvider) => {
    const remainingProviders = removeByokProvider(
      byokSettings.providers,
      provider.id
    );
    // Re-migrate the routing profiles NOW (audit011026 B-UI-9): dangling
    // profiles pointed at the removed provider fell through to the GLOBAL
    // endpoint until the tab was remounted.
    const migrated = migrateByokRoutingProfiles({
      ...byokSettings,
      providers: remainingProviders,
    });
    updateByokSetting({
      providers: remainingProviders,
      ...(migrated ? { ...migrated } : {}),
    });
    // The legacy slot (keyRef === '') is NOT exclusively owned by a provider
    // card: the still-present "Single-endpoint fallback" section, the Test
    // button and every ''-routed call read it. Clearing it on removal left
    // a working global endpoint silently keyless (audit100226 UI-5).
    if (provider.keyRef) {
      void clearByokKey(provider.keyRef);
    }
    clearByokModels();
  };

  const updateProvider = (
    providerId: string,
    partial: Partial<ByokProvider>
  ) => {
    updateByokSetting({
      providers: byokSettings.providers.map(entry =>
        entry.id === providerId ? { ...entry, ...partial } : entry
      ),
    });
  };

  const onTestProviderConnection = async (provider: ByokProvider) => {
    setProviderUnderTestId(provider.id);
    setProviderTestResults(previous => ({ ...previous, [provider.id]: null }));

    // The PROVIDER'S own model (audit011026 B-UI-8): the global model name
    // belongs to the global endpoint — cross-vendor setups failed "model
    // not found" for providers that worked fine.
    const testedModelName = resolveByokProviderTestModelName(
      provider,
      getProviderModels(provider)
    );
    // A provider card exists before any model is configured for it, and
    // sending an EMPTY model name produced a "model not found" answer that
    // told the user their endpoint and key were broken (audit100226 UI-10).
    if (!testedModelName) {
      setProviderTestResults(previous => ({
        ...previous,
        [provider.id]: {
          ok: false,
          message: (
            <Trans>
              Add a model for this provider first, then test the connection.
            </Trans>
          ),
        },
      }));
      setProviderUnderTestId(null);
      return;
    }
    const options: ByokChatCompletionOptions = {
      model: testedModelName,
      messages: [{ role: 'user', content: 'ping' }],
      timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
    };

    try {
      const draftKey = providerKeyDrafts[provider.id];
      const storedKey = await loadByokKey(provider.keyRef);
      const apiKey =
        draftKey || (storedKey.status === 'ok' ? storedKey.key : '');
      const endpointUrl = provider.endpointUrl || byokSettings.endpointUrl;
      await sendByokChatCompletionWithRetries({
        baseUrl: endpointUrl,
        apiKey,
        options,
      });
      if (!isSubscribedRef.current) return;
      setProviderTestResults(previous => ({
        ...previous,
        [provider.id]: {
          ok: true,
          message: <Trans>Connection successful!</Trans>,
        },
      }));
    } catch (rawError) {
      if (!isSubscribedRef.current) return;
      const byokError = classifyByokError(rawError);
      setProviderTestResults(previous => ({
        ...previous,
        [provider.id]: {
          ok: false,
          message: renderByokErrorMessage(byokError),
        },
      }));
    } finally {
      if (isSubscribedRef.current) setProviderUnderTestId(null);
    }
  };

  const onFetchProviderModels = async (provider: ByokProvider) => {
    setProviderUnderFetchId(provider.id);
    setProviderModelsMessages(previous => ({
      ...previous,
      [provider.id]: null,
    }));
    try {
      const draftKey = providerKeyDrafts[provider.id];
      const storedKey = await loadByokKey(provider.keyRef);
      const apiKey =
        draftKey || (storedKey.status === 'ok' ? storedKey.key : '');
      const endpointUrl = provider.endpointUrl || byokSettings.endpointUrl;
      const models = await refreshByokModels({
        baseUrl: endpointUrl,
        apiKey,
      });
      if (!isSubscribedRef.current) return;
      if (models.length === 0) {
        setProviderModelsMessages(previous => ({
          ...previous,
          [provider.id]: (
            <Trans>
              The endpoint returned an empty model list — type the model name in
              a per-model block instead.
            </Trans>
          ),
        }));
      }
    } catch (rawError) {
      if (!isSubscribedRef.current) return;
      const byokError = classifyByokError(rawError);
      setProviderModelsMessages(previous => ({
        ...previous,
        [provider.id]: renderByokErrorMessage(byokError),
      }));
    } finally {
      if (isSubscribedRef.current) setProviderUnderFetchId(null);
    }
  };

  const updateProviderModelSettings = (
    provider: ByokProvider,
    modelSettings: ByokProviderModelSettings
  ) => {
    updateByokSetting({
      providers: byokSettings.providers.map(entry =>
        entry.id === provider.id
          ? upsertByokProviderModelSettings(entry, modelSettings)
          : entry
      ),
    });
  };

  const onRemoveProviderModelSettings = (
    provider: ByokProvider,
    modelName: string
  ) => {
    updateByokSetting({
      providers: byokSettings.providers.map(entry =>
        entry.id === provider.id
          ? removeByokProviderModelSettings(entry, modelName)
          : entry
      ),
    });
  };

  /**
   * The per-model benchmark (13.4): the same 4-task run as the global one,
   * against THIS provider's endpoint and key — so "Run benchmark" next to a
   * model measures that exact pairing. Stored results stay keyed
   * endpoint+model.
   */
  const onRunProviderBenchmark = async (
    provider: ByokProvider,
    modelName: string
  ) => {
    const benchmarkKey = `${provider.id}/${modelName}`;
    setBenchmarkUnderKey(benchmarkKey);
    setBenchmarkReportsByKey(previous => ({
      ...previous,
      [benchmarkKey]: '',
    }));
    let scratchProject: any = null;
    try {
      const draftKey = providerKeyDrafts[provider.id];
      const storedKey = await loadByokKey(provider.keyRef);
      const apiKey =
        draftKey || (storedKey.status === 'ok' ? storedKey.key : '');
      if (!apiKey) {
        setBenchmarkReportsByKey(previous => ({
          ...previous,
          [benchmarkKey]:
            'Add an API key for this provider first, then run the benchmark.',
        }));
        return;
      }
      // eslint-disable-next-line no-new-wrappers
      scratchProject = new (gd: any).ProjectHelper.createNewGDJSProject();
      const endpointUrl = provider.endpointUrl || byokSettings.endpointUrl;
      const report: ByokBenchmarkReport = await runByokBenchmark({
        modelName,
        scratchProject,
        sendCompletion: async ({ messages, tools }) =>
          await sendByokChatCompletionWithRetries({
            baseUrl: endpointUrl,
            apiKey,
            options: {
              model: modelName,
              messages,
              // The cap keeps a degenerate model from burning an unbounded
              // token budget on a benchmark task (see the constant).
              maxTokens: BYOK_BENCHMARK_MAX_OUTPUT_TOKENS,
              // No `tools` key at all when the task has none: an empty array
              // is a valid-looking but confusing request for some endpoints.
              tools: tools.length > 0 ? tools : undefined,
              timeoutMs: 60000,
            },
          }),
        executeToolCalls: async ({ calls, scratchProject: project }) =>
          await executeByokBenchmarkCalls({ calls, project }),
        snapshotProject: project => snapshotProjectForBenchmark(project),
        isVisionEnabled: () => byokSettings.imageSupport !== 'no',
      });
      const formattedReport = formatByokBenchmarkReport(report);
      saveByokBenchmarkReport({
        endpointUrl,
        modelName,
        reportText: formattedReport,
      });
      if (isSubscribedRef.current) {
        setBenchmarkReportsByKey(previous => ({
          ...previous,
          [benchmarkKey]: formattedReport,
        }));
      }
    } catch (rawError) {
      const crashText = describeByokBenchmarkCrash(rawError);
      const failureText =
        crashText !== null
          ? crashText
          : ((renderByokErrorMessage(
              classifyByokError(rawError)
            ): any): string);
      if (isSubscribedRef.current) {
        setBenchmarkReportsByKey(previous => ({
          ...previous,
          [benchmarkKey]: failureText,
        }));
      }
    } finally {
      deleteScratchProject(scratchProject);
      if (isSubscribedRef.current) setBenchmarkUnderKey(null);
    }
  };

  // The legacy/global benchmark (kept for the single-endpoint path).
  const [isBenchmarkRunning, setIsBenchmarkRunning] = React.useState<boolean>(
    false
  );
  const [benchmarkReportText, setBenchmarkReportText] = React.useState<
    string | null
  >(() => {
    const stored = loadByokBenchmarkReport({
      endpointUrl: byokSettings.endpointUrl,
      modelName: byokSettings.modelName,
    });
    if (!stored) return null;
    return `${stored.reportText}\n\n(Stored result from ${
      stored.finishedAt
    } — re-run to refresh.)`;
  });

  const onRunBenchmark = async () => {
    setIsBenchmarkRunning(true);
    setBenchmarkReportText(null);
    let scratchProject: any = null;
    try {
      const storedKey = await loadByokKey();
      if (storedKey.status !== 'ok') {
        setBenchmarkReportText('Add an API key first, then run the benchmark.');
        return;
      }
      // eslint-disable-next-line no-new-wrappers
      scratchProject = new (gd: any).ProjectHelper.createNewGDJSProject();
      const connection = {
        baseUrl: byokSettings.endpointUrl,
        apiKey: storedKey.key,
      };
      const benchmarkConnection = connection;
      const report: ByokBenchmarkReport = await runByokBenchmark({
        modelName: byokSettings.modelName,
        scratchProject,
        sendCompletion: async ({ messages, tools }) =>
          await sendByokChatCompletionWithRetries({
            ...benchmarkConnection,
            options: {
              model: byokSettings.modelName,
              messages,
              // The cap keeps a degenerate model from burning an unbounded
              // token budget on a benchmark task (see the constant).
              maxTokens: BYOK_BENCHMARK_MAX_OUTPUT_TOKENS,
              // No `tools` key at all when the task has none: an empty array
              // is a valid-looking but confusing request for some endpoints.
              tools: tools.length > 0 ? tools : undefined,
              timeoutMs: 60000,
            },
          }),
        executeToolCalls: async ({ calls, scratchProject: project }) =>
          await executeByokBenchmarkCalls({ calls, project }),
        snapshotProject: project => snapshotProjectForBenchmark(project),
        isVisionEnabled: () => byokSettings.imageSupport !== 'no',
      });
      const formattedReport = formatByokBenchmarkReport(report);
      saveByokBenchmarkReport({
        endpointUrl: byokSettings.endpointUrl,
        modelName: byokSettings.modelName,
        reportText: formattedReport,
      });
      setBenchmarkReportText(formattedReport);
    } catch (rawError) {
      const crashText = describeByokBenchmarkCrash(rawError);
      setBenchmarkReportText(
        crashText !== null
          ? crashText
          : ((renderByokErrorMessage(classifyByokError(rawError)): any): string)
      );
    } finally {
      deleteScratchProject(scratchProject);
      if (isSubscribedRef.current) setIsBenchmarkRunning(false);
    }
  };

  // The durable history's storage usage line (9.3) — under CHAT HISTORY
  // STORAGE since 13.4 (it moved from the removed history dialog).
  const [storageUsageText, setStorageUsageText] = React.useState<string | null>(
    null
  );
  React.useEffect(() => {
    const readUsage = async () => {
      const store = getByokChatPersistence();
      if (!store) return;
      try {
        const usage = await store.getStorageUsage();
        const megaBytes = usage.totalBytes / (1000 * 1000);
        const capMegaBytes = BYOK_CHAT_STORAGE_QUOTA_BYTES / (1000 * 1000);
        if (isSubscribedRef.current) {
          setStorageUsageText(
            `${megaBytes.toFixed(
              1
            )} MB of ${capMegaBytes} MB used for chat history.`
          );
        }
      } catch (error) {
        // The usage line is informational only.
      }
    };
    readUsage();
  }, []);

  const onExportFeedback = () => {
    const json = exportByokFeedbackJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'byok-ai-feedback.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  /**
   * Leaving the key field commits it — but only when the user actually
   * edited it (D10): an untouched field (even focused and left empty) never
   * saves, so a low-skill user cannot lose their stored key to a
   * non-obvious gesture. Typing is an explicit edit — including typing and
   * erasing everything, which therefore stays a deliberate delete.
   */
  const commitApiKeyField = () => {
    if (!isKeyFieldEdited) return;
    setIsKeyFieldEdited(false);
    saveApiKey();
  };

  const onClearStoredKey = async () => {
    setApiKey('');
    setIsKeyFieldEdited(false);
    await clearByokKey();
    clearByokModels();
    if (isSubscribedRef.current) {
      setIsKeyStorageEncrypted(false);
      setHasStoredKey(false);
    }
  };

  const commitDefaultContextWindowDraft = () => {
    if (defaultContextWindowDraft === null) return;

    updateByokSetting({
      contextWindowTokens: clampContextWindow(
        parseInt(defaultContextWindowDraft, 10)
      ),
    });
    setDefaultContextWindowDraft(null);
  };

  const commitPerModelDraft = () => {
    if (!perModelDraft) return;
    const { providerId, modelName, field, text } = perModelDraft;
    const provider = byokSettings.providers.find(
      entry => entry.id === providerId
    );
    setPerModelDraft(null);
    if (!provider) return;
    const existing =
      getByokProviderModelSettings(provider, modelName) ||
      ({
        modelName,
        temperature: null,
        maxTokens: null,
        contextWindowTokens: null,
      }: ByokProviderModelSettings);
    if (field === 'temperature') {
      const parsed = parseFloat(text);
      updateProviderModelSettings(provider, {
        ...existing,
        temperature: text.trim() === '' || Number.isNaN(parsed) ? null : parsed,
      });
      return;
    }
    if (field === 'maxTokens') {
      const parsed = parseInt(text, 10);
      updateProviderModelSettings(provider, {
        ...existing,
        maxTokens: text.trim() === '' || Number.isNaN(parsed) ? null : parsed,
      });
      return;
    }
    updateProviderModelSettings(provider, {
      ...existing,
      contextWindowTokens:
        text.trim() === '' ? null : clampContextWindow(parseInt(text, 10)),
    });
  };

  const reasoningEffortLabels = {
    default: t`Default`,
    low: t`Low`,
    medium: t`Medium`,
    high: t`High`,
  };

  const imageSupportLabels = {
    auto: t`Auto-detect`,
    yes: t`Yes`,
    no: t`No`,
  };

  const keyStorageStatusText = getKeyStorageStatusText(
    isKeyStorageEncrypted,
    hasStoredKey
  );

  const hasProviders = byokSettings.providers.length > 0;

  // The models of one provider, from the session cache (fetched with the
  // provider's Fetch models button, or left empty until then).
  const getProviderModels = (provider: ByokProvider): Array<ByokModelInfo> =>
    getCachedByokModels(provider.endpointUrl, provider.id) || [];

  const renderProfilePicker = (
    profileName: 'fastProfile' | 'strongProfile',
    title: React.Node
  ) => {
    const profile = byokSettings[profileName];
    const profileModels = byokSettings.providers.find(
      entry => entry.id === profile.providerId
    );
    const models = profileModels ? getProviderModels(profileModels) : [];
    return (
      <ColumnStackLayout key={profileName} noMargin>
        <Text noMargin>{title}</Text>
        <LineStackLayout noMargin alignItems="center">
          <Column noMargin expand>
            <Text size="body2" noMargin>
              <Trans>Provider</Trans>
            </Text>
            <CompactSelectField
              value={profile.providerId}
              onChange={(value: string) => {
                updateByokSetting(
                  (({
                    [profileName]: {
                      ...profile,
                      providerId: value,
                      modelName: '',
                    },
                  }: any): any)
                );
              }}
            >
              <SelectOption value="" label={t`Global endpoint`} />
              {byokSettings.providers.map(provider => (
                <SelectOption
                  key={provider.id}
                  value={provider.id}
                  label={provider.name}
                />
              ))}
            </CompactSelectField>
          </Column>
          <Column noMargin expand>
            <Text size="body2" noMargin>
              <Trans>Model</Trans>
            </Text>
            {models.length > 0 ? (
              <CompactSelectField
                value={profile.modelName}
                onChange={(value: string) => {
                  updateByokSetting(
                    (({
                      [profileName]: { ...profile, modelName: value },
                    }: any): any)
                  );
                }}
              >
                <SelectOption value="" label={t`From the global settings`} />
                {models.map(model => (
                  <SelectOption
                    key={model.id}
                    value={model.id}
                    label={model.id}
                  />
                ))}
              </CompactSelectField>
            ) : (
              <TextField
                name={`byok-${profileName}-model`}
                floatingLabelText={<Trans>Model name</Trans>}
                hintText={
                  profileName === 'fastProfile' ? 'gpt-4o-mini' : 'gpt-4.1'
                }
                value={profile.modelName}
                onChange={(event, text) => {
                  updateByokSetting(
                    (({
                      [profileName]: { ...profile, modelName: text },
                    }: any): any)
                  );
                }}
              />
            )}
          </Column>
        </LineStackLayout>
      </ColumnStackLayout>
    );
  };

  const renderProviderModelSettingsBlock = (
    provider: ByokProvider,
    modelSettings: ByokProviderModelSettings
  ) => {
    const benchmarkKey = `${provider.id}/${modelSettings.modelName}`;
    const draftFor = (
      field: 'temperature' | 'maxTokens' | 'contextWindowTokens'
    ) =>
      perModelDraft &&
      perModelDraft.providerId === provider.id &&
      perModelDraft.modelName === modelSettings.modelName &&
      perModelDraft.field === field
        ? perModelDraft.text
        : null;
    return (
      <ColumnStackLayout key={modelSettings.modelName} noMargin>
        <LineStackLayout noMargin alignItems="center">
          <Column noMargin expand>
            <Text noMargin>{modelSettings.modelName}</Text>
          </Column>
          <Column noMargin>
            <FlatButton
              label={<Trans>Remove</Trans>}
              onClick={() =>
                onRemoveProviderModelSettings(provider, modelSettings.modelName)
              }
            />
          </Column>
        </LineStackLayout>
        <LineStackLayout noMargin>
          <Column noMargin expand>
            <TextField
              name={`byok-model-temperature-${provider.id}-${
                modelSettings.modelName
              }`}
              type="number"
              floatingLabelText={<Trans>Temperature (empty = default)</Trans>}
              value={
                draftFor('temperature') !== null
                  ? (draftFor('temperature'): any)
                  : modelSettings.temperature === null
                  ? ''
                  : String(modelSettings.temperature)
              }
              onChange={(event, text) =>
                setPerModelDraft({
                  providerId: provider.id,
                  modelName: modelSettings.modelName,
                  field: 'temperature',
                  text,
                })
              }
              onBlur={commitPerModelDraft}
            />
          </Column>
          <Column noMargin expand>
            <TextField
              name={`byok-model-max-tokens-${provider.id}-${
                modelSettings.modelName
              }`}
              type="number"
              floatingLabelText={<Trans>Max tokens (empty = omitted)</Trans>}
              value={
                draftFor('maxTokens') !== null
                  ? (draftFor('maxTokens'): any)
                  : modelSettings.maxTokens === null
                  ? ''
                  : String(modelSettings.maxTokens)
              }
              onChange={(event, text) =>
                setPerModelDraft({
                  providerId: provider.id,
                  modelName: modelSettings.modelName,
                  field: 'maxTokens',
                  text,
                })
              }
              onBlur={commitPerModelDraft}
            />
          </Column>
        </LineStackLayout>
        <LineStackLayout noMargin alignItems="center">
          <Column noMargin expand>
            <TextField
              name={`byok-model-context-window-${provider.id}-${
                modelSettings.modelName
              }`}
              type="number"
              floatingLabelText={<Trans>Context window (empty = auto)</Trans>}
              value={
                draftFor('contextWindowTokens') !== null
                  ? (draftFor('contextWindowTokens'): any)
                  : modelSettings.contextWindowTokens === null
                  ? ''
                  : String(modelSettings.contextWindowTokens)
              }
              min={MIN_CONTEXT_WINDOW_TOKENS}
              max={MAX_CONTEXT_WINDOW_TOKENS}
              onChange={(event, text) =>
                setPerModelDraft({
                  providerId: provider.id,
                  modelName: modelSettings.modelName,
                  field: 'contextWindowTokens',
                  text,
                })
              }
              onBlur={commitPerModelDraft}
            />
          </Column>
          <Column noMargin>
            <RaisedButton
              label={
                benchmarkUnderKey === benchmarkKey ? (
                  <Trans>Benchmark running…</Trans>
                ) : (
                  <Trans>Run benchmark</Trans>
                )
              }
              onClick={() =>
                onRunProviderBenchmark(provider, modelSettings.modelName)
              }
              disabled={benchmarkUnderKey === benchmarkKey}
            />
          </Column>
        </LineStackLayout>
        {benchmarkReportsByKey[benchmarkKey] !== undefined &&
          benchmarkReportsByKey[benchmarkKey] !== '' && (
            <Line noMargin>
              <Text size="body2" color="secondary">
                {benchmarkReportsByKey[benchmarkKey]}
              </Text>
            </Line>
          )}
      </ColumnStackLayout>
    );
  };

  const renderProviderCard = (provider: ByokProvider) => {
    const models = getProviderModels(provider);
    return (
      <ColumnStackLayout key={provider.id} noMargin>
        <LineStackLayout noMargin alignItems="center">
          <Column noMargin expand>
            <TextField
              name={`byok-provider-name-${provider.id}`}
              floatingLabelText={<Trans>Provider name</Trans>}
              value={provider.name}
              onChange={(event, text) =>
                updateProvider(provider.id, { name: text })
              }
            />
          </Column>
          <Column noMargin>
            <FlatButton
              label={<Trans>Remove</Trans>}
              onClick={() => onRemoveProvider(provider)}
            />
          </Column>
        </LineStackLayout>
        <TextField
          name={`byok-provider-url-${provider.id}`}
          floatingLabelText={<Trans>Endpoint base URL</Trans>}
          hintText="https://api.openai.com/v1"
          value={provider.endpointUrl}
          onChange={(event, text) =>
            updateProvider(provider.id, { endpointUrl: text })
          }
        />
        <TextField
          name={`byok-provider-key-${provider.id}`}
          type="password"
          autoComplete="off"
          floatingLabelText={<Trans>API key for this provider</Trans>}
          value={providerKeyDrafts[provider.id] || ''}
          onChange={(event, text) => {
            setProviderKeyDrafts(previous => ({
              ...previous,
              [provider.id]: text,
            }));
            setEditedProviderKeyIds(
              previous => new Set([...previous, provider.id])
            );
          }}
          onBlur={() => commitProviderKeyField(provider)}
        />
        <LineStackLayout noMargin alignItems="center">
          <Column noMargin>
            <RaisedButton
              label={
                providerUnderTestId === provider.id ? (
                  <Trans>Testing…</Trans>
                ) : (
                  <Trans>Test</Trans>
                )
              }
              onClick={() => onTestProviderConnection(provider)}
              disabled={providerUnderTestId === provider.id}
            />
          </Column>
          <Column noMargin>
            <RaisedButton
              label={
                providerUnderFetchId === provider.id ? (
                  <Trans>Fetching…</Trans>
                ) : (
                  <Trans>Fetch models</Trans>
                )
              }
              onClick={() => onFetchProviderModels(provider)}
              disabled={
                providerUnderFetchId === provider.id || !provider.endpointUrl
              }
            />
          </Column>
          {providerTestResults[provider.id] && (
            <Column noMargin expand>
              <Text
                size="body2"
                color={
                  providerTestResults[provider.id].ok ? 'secondary' : 'error'
                }
              >
                {providerTestResults[provider.id].message}
              </Text>
            </Column>
          )}
        </LineStackLayout>
        {providerModelsMessages[provider.id] && (
          <Line noMargin>
            <Text size="body2" color="error">
              {providerModelsMessages[provider.id]}
            </Text>
          </Line>
        )}
        <Accordion>
          <AccordionHeader>
            <Text size="body2" noMargin>
              <Trans>Advanced provider settings</Trans>
            </Text>
          </AccordionHeader>
          <AccordionBody>
            <ColumnStackLayout noMargin>
              <Text size="block-title">
                <Trans>PER MODEL SETTINGS</Trans>
              </Text>
              {provider.modelSettings.map(modelSettings =>
                renderProviderModelSettingsBlock(provider, modelSettings)
              )}
              {providerDraftModelPickerId === provider.id ? (
                <ColumnStackLayout noMargin>
                  <Text size="body2" noMargin>
                    <Trans>Pick model</Trans>
                  </Text>
                  {models.length > 0 ? (
                    <CompactSelectField
                      value=""
                      onChange={(value: string) => {
                        setProviderDraftModelPickerId(null);
                        if (!value) return;
                        updateProviderModelSettings(provider, {
                          modelName: value,
                          temperature: null,
                          maxTokens: null,
                          contextWindowTokens: null,
                        });
                      }}
                    >
                      <SelectOption value="" label={t`Pick a model…`} />
                      {models
                        .filter(
                          model =>
                            !getByokProviderModelSettings(provider, model.id)
                        )
                        .map(model => (
                          <SelectOption
                            key={model.id}
                            value={model.id}
                            label={model.id}
                          />
                        ))}
                    </CompactSelectField>
                  ) : (
                    <TextField
                      name={`byok-provider-model-name-${provider.id}`}
                      floatingLabelText={<Trans>Model name</Trans>}
                      hintText="gpt-4o-mini"
                      value=""
                      onChange={(event, text) => {
                        if (!text) return;
                        setProviderDraftModelPickerId(null);
                        updateProviderModelSettings(provider, {
                          modelName: text,
                          temperature: null,
                          maxTokens: null,
                          contextWindowTokens: null,
                        });
                      }}
                    />
                  )}
                </ColumnStackLayout>
              ) : (
                <Line noMargin>
                  <FlatButton
                    label={<Trans>Customize another model</Trans>}
                    onClick={() => setProviderDraftModelPickerId(provider.id)}
                  />
                </Line>
              )}
            </ColumnStackLayout>
          </AccordionBody>
        </Accordion>
      </ColumnStackLayout>
    );
  };

  return (
    <ColumnStackLayout>
      <Text size="block-title">
        <Trans>BYOK — Bring Your Own Key</Trans>
      </Text>
      <Text>
        <Trans>
          Use your own OpenAI-compatible provider (with your own API key) to
          power Ask AI, instead of using GDevelop AI credits.
        </Trans>
      </Text>
      <Checkbox
        checked={byokSettings.enabled}
        onCheck={(event, checked) => updateByokSetting({ enabled: checked })}
        label={<Trans>Use BYOK as is</Trans>}
      />
      {/* The legacy single-endpoint connection block — the simple
          no-providers path. Visually secondary once providers exist. */}
      <ColumnStackLayout noMargin>
        {hasProviders && (
          <Line noMargin>
            <Text size="body2" color="secondary">
              <Trans>
                Single-endpoint fallback (used by models without a provider):
              </Trans>
            </Text>
          </Line>
        )}
        <TextField
          name="byok-endpoint-url"
          floatingLabelText={<Trans>Endpoint base URL</Trans>}
          hintText="https://api.openai.com/v1"
          value={byokSettings.endpointUrl}
          onChange={(event, text) => updateByokSetting({ endpointUrl: text })}
        />
        <Line noMargin>
          <Text size="body2" color="secondary">
            <Trans>
              The base URL of your provider, including /v1 if it uses one:
              /models and /chat/completions are appended automatically.
            </Trans>
          </Text>
        </Line>
        <TextField
          name="byok-api-key"
          type="password"
          autoComplete="off"
          floatingLabelText={<Trans>API key</Trans>}
          value={apiKey}
          onChange={(event, text) => {
            setApiKey(text);
            setIsKeyFieldEdited(true);
          }}
          onBlur={commitApiKeyField}
        />
        {keyStorageStatusText && (
          <Line noMargin>
            <Text size="body2" color="secondary">
              {keyStorageStatusText}
            </Text>
          </Line>
        )}
        <Line noMargin>
          {/* The discoverable way to remove a stored key: an untouched empty
              field never clears anything (D10), so this button is the only
              obvious delete gesture. */}
          <FlatButton
            label={<Trans>Clear the stored key</Trans>}
            onClick={onClearStoredKey}
            disabled={!hasStoredKey}
          />
        </Line>
        <LineStackLayout noMargin alignItems="center">
          <Column noMargin expand>
            <Text noMargin>
              <Trans>Model</Trans>
            </Text>
          </Column>
          <Column noMargin expand>
            <RaisedButton
              label={
                isFetchingModels ? (
                  <Trans>Fetching…</Trans>
                ) : (
                  <Trans>Fetch models</Trans>
                )
              }
              onClick={onFetchModels}
              disabled={isFetchingModels || !byokSettings.endpointUrl}
            />
          </Column>
        </LineStackLayout>
        {modelsFetchMessage && (
          <Line noMargin>
            <Text size="body2" color="error">
              {modelsFetchMessage}
            </Text>
          </Line>
        )}
        {showModelsDropdown ? (
          <CompactSelectField
            value={byokSettings.modelName}
            onChange={(value: string) => {
              if (value === MANUAL_MODEL_OPTION_VALUE) {
                setIsManuallyTypingModel(true);
                return;
              }

              updateByokSetting({ modelName: value });
            }}
          >
            {visibleModels &&
              visibleModels.map(model => (
                <SelectOption
                  key={model.id}
                  value={model.id}
                  label={model.id}
                />
              ))}
            <SelectOption
              value={MANUAL_MODEL_OPTION_VALUE}
              label={t`Type manually…`}
            />
          </CompactSelectField>
        ) : (
          <TextField
            name="byok-model"
            floatingLabelText={<Trans>Model</Trans>}
            hintText="gpt-4o-mini"
            value={byokSettings.modelName}
            onChange={(event, text) => updateByokSetting({ modelName: text })}
          />
        )}
        <LineStackLayout noMargin alignItems="center">
          <Column noMargin expand>
            <Text noMargin>
              <Trans>Default context window (tokens)</Trans>
            </Text>
          </Column>
          <Column noMargin expand>
            <TextField
              name="byok-context-window"
              type="number"
              value={
                defaultContextWindowDraft !== null
                  ? defaultContextWindowDraft
                  : String(byokSettings.contextWindowTokens)
              }
              min={MIN_CONTEXT_WINDOW_TOKENS}
              max={MAX_CONTEXT_WINDOW_TOKENS}
              onChange={(event, value) => setDefaultContextWindowDraft(value)}
              onBlur={commitDefaultContextWindowDraft}
            />
          </Column>
        </LineStackLayout>
        <LineStackLayout noMargin alignItems="center">
          <Column noMargin expand>
            <Text noMargin>
              <Trans>Reasoning effort</Trans>
            </Text>
          </Column>
          <Column noMargin expand>
            <CompactSelectField
              value={byokSettings.reasoningEffort}
              onChange={(value: string) => {
                const effort = BYOK_REASONING_EFFORTS.find(
                  candidate => candidate === value
                );
                if (!effort) return;

                updateByokSetting({ reasoningEffort: effort });
              }}
            >
              {BYOK_REASONING_EFFORTS.map(effort => (
                <SelectOption
                  key={effort}
                  value={effort}
                  label={reasoningEffortLabels[effort]}
                />
              ))}
            </CompactSelectField>
          </Column>
        </LineStackLayout>
        <LineStackLayout noMargin alignItems="center">
          <Column noMargin expand>
            <Text noMargin>
              <Trans>Image support</Trans>
            </Text>
          </Column>
          <Column noMargin expand>
            <CompactSelectField
              value={byokSettings.imageSupport}
              onChange={(value: string) => {
                const support = BYOK_IMAGE_SUPPORTS.find(
                  candidate => candidate === value
                );
                if (!support) return;

                updateByokSetting({ imageSupport: support });
              }}
            >
              {BYOK_IMAGE_SUPPORTS.map(support => (
                <SelectOption
                  key={support}
                  value={support}
                  label={imageSupportLabels[support]}
                />
              ))}
            </CompactSelectField>
          </Column>
        </LineStackLayout>
        <LineStackLayout noMargin alignItems="center">
          <Column noMargin expand>
            <Text noMargin>
              <Trans>Connection</Trans>
            </Text>
          </Column>
          <Column noMargin expand>
            <RaisedButton
              label={
                isTestingConnection ? (
                  <Trans>Testing…</Trans>
                ) : (
                  <Trans>Test connection</Trans>
                )
              }
              onClick={onTestConnection}
              disabled={
                isTestingConnection ||
                !byokSettings.endpointUrl ||
                !byokSettings.modelName
              }
            />
          </Column>
        </LineStackLayout>
        {connectionTestResult && (
          <Line noMargin>
            <Text
              size="body2"
              color={connectionTestResult.ok ? 'secondary' : 'error'}
            >
              {connectionTestResult.message}
            </Text>
          </Line>
        )}
        <Text size="block-title">
          <Trans>Test this model</Trans>
        </Text>
        <Text>
          <Trans>
            Run 4 short game-building tasks with the configured model, on a
            scratch project, and see how many pass (about 2 minutes).
          </Trans>
        </Text>
        <Line noMargin>
          <RaisedButton
            label={
              isBenchmarkRunning ? (
                <Trans>Benchmark running…</Trans>
              ) : (
                <Trans>Run the benchmark (≈2 min)</Trans>
              )
            }
            onClick={onRunBenchmark}
            disabled={
              isBenchmarkRunning ||
              !byokSettings.endpointUrl ||
              !byokSettings.modelName
            }
          />
        </Line>
        {benchmarkReportText && (
          <Line noMargin>
            <Text size="body2" color="secondary">
              {benchmarkReportText}
            </Text>
          </Line>
        )}
      </ColumnStackLayout>
      <Checkbox
        checked={byokSettings.onlineDocsEnabled}
        onCheck={(event, checked) =>
          updateByokSetting({ onlineDocsEnabled: checked })
        }
        label={
          <Trans>
            Fetch missing documentation pages online (the bundled docs work
            offline; fetched pages are cached for a day)
          </Trans>
        }
      />
      <Checkbox
        checked={byokSettings.buildWorkflowAutoSuggest}
        onCheck={(event, checked) =>
          updateByokSetting({ buildWorkflowAutoSuggest: checked })
        }
        label={
          <Trans>
            Auto-load the build workflow for game requests (the playbook is
            included from the first turn when a message looks like "make me a
            game")
          </Trans>
        }
      />
      <Line noMargin>
        <Text size="body2" color="secondary">
          <Trans>
            Skills (desktop): drop your own .md skill files in the "byok-skills"
            folder of your user data — the AI can load them with its load_skill
            tool.
          </Trans>
        </Text>
      </Line>
      <TextField
        name="byok-custom-instructions"
        multiline
        rows={4}
        maxLength={BYOK_CUSTOM_INSTRUCTIONS_MAX_CHARS}
        floatingLabelText={
          <Trans>Custom instructions (applied to every chat)</Trans>
        }
        translatableHintText={t`e.g. Always answer in French, use 2-space indents…`}
        value={byokSettings.customInstructions}
        onChange={(event, text) =>
          updateByokSetting({
            customInstructions: text.slice(
              0,
              BYOK_CUSTOM_INSTRUCTIONS_MAX_CHARS
            ),
          })
        }
      />
      <Text size="block-title">
        <Trans>PROVIDERS</Trans>
      </Text>
      <Text>
        <Trans>
          Register several OpenAI-compatible providers and pick, per chat, which
          model answers. The first provider is your previously configured
          endpoint (its stored key was kept).
        </Trans>
      </Text>
      {byokSettings.providers.map(provider => renderProviderCard(provider))}
      <Line noMargin>
        <FlatButton
          label={<Trans>Add a provider</Trans>}
          onClick={onAddProvider}
        />
      </Line>
      <Text size="block-title">
        <Trans>Model routing</Trans>
      </Text>
      <LineStackLayout noMargin alignItems="center">
        <Column noMargin expand>
          <Text noMargin>
            <Trans>Routing</Trans>
          </Text>
        </Column>
        <Column noMargin expand>
          <CompactSelectField
            value={byokSettings.routingMode}
            onChange={(value: string) => {
              const mode = BYOK_ROUTING_MODES.find(
                candidate => candidate === value
              );
              if (!mode) return;
              updateByokSetting({ routingMode: mode });
            }}
          >
            <SelectOption
              value="automatic"
              label={t`Route automatically (fast models for simple calls)`}
            />
            <SelectOption
              value="always-strong"
              label={t`Always use the strong model`}
            />
          </CompactSelectField>
        </Column>
      </LineStackLayout>
      {renderProfilePicker(
        'strongProfile',
        <Trans>DEFAULT STRONG MODEL (edits and generation)</Trans>
      )}
      {renderProfilePicker(
        'fastProfile',
        <Trans>DEFAULT FAST MODEL (scouting, summaries, suggestions)</Trans>
      )}
      <Text size="block-title">
        <Trans>WHILE THE AI IS WORKING</Trans>
      </Text>
      <Checkbox
        checked={byokSettings.stallWatchdogEnabled}
        onCheck={(event, checked) =>
          updateByokSetting({ stallWatchdogEnabled: checked })
        }
        label={
          <Trans>
            Warn me in the chat when nothing happens for a while (the model may
            be stuck)
          </Trans>
        }
      />
      <LineStackLayout noMargin alignItems="center">
        <Column noMargin expand>
          <Text noMargin>
            <Trans>Stall warning delay (seconds)</Trans>
          </Text>
        </Column>
        <Column noMargin expand>
          <TextField
            name="byok-stall-window"
            type="number"
            value={String(
              byokSettings.stallWindowSeconds || DEFAULT_STALL_WINDOW_SECONDS
            )}
            min={10}
            max={600}
            onChange={(event, value) =>
              updateByokSetting({
                stallWindowSeconds:
                  parseInt(value, 10) || DEFAULT_STALL_WINDOW_SECONDS,
              })
            }
          />
        </Column>
      </LineStackLayout>
      <Checkbox
        checked={byokSettings.suggestionsEnabled}
        onCheck={(event, checked) =>
          updateByokSetting({ suggestionsEnabled: checked })
        }
        label={
          <Trans>
            Suggest follow-up messages when the AI finishes (uses a few extra
            tokens on your endpoint)
          </Trans>
        }
      />
      <Text size="block-title">
        <Trans>CHAT HISTORY STORAGE</Trans>
      </Text>
      {storageUsageText && (
        <Line noMargin>
          <Text size="body2" color="secondary">
            {storageUsageText}
          </Text>
        </Line>
      )}
      <Line noMargin>
        <FlatButton
          label={<Trans>Export AI feedback (JSON)</Trans>}
          onClick={onExportFeedback}
        />
      </Line>
      <ByokMcpSettingsCard
        mcpServer={byokSettings.mcpServer}
        onChange={partial =>
          updateByokSetting({
            mcpServer: { ...byokSettings.mcpServer, ...partial },
          })
        }
      />
    </ColumnStackLayout>
  );
};

export default ByokSettingsTab;
