// @flow
import {
  DEFAULT_BYOK_SETTINGS,
  type ByokProvider,
  type ByokSettings,
} from './ByokTypes';
import {
  type ByokCallKind,
  buildLegacyMigrationProviders,
  getByokChatModelSelection,
  getByokEffortOptions,
  isFastByokCallKind,
  listByokModelChoices,
  migrateByokRoutingProfiles,
  makeByokProviderId,
  removeByokProvider,
  resolveByokModelTarget,
  resolveByokReasoningEffort,
  resolveByokRoutingProfile,
  setByokChatModelSelection,
  upsertByokProvider,
} from './ByokModelRouter';

const makeSettings = (overrides?: Object): ByokSettings => ({
  ...DEFAULT_BYOK_SETTINGS,
  ...overrides,
});

describe('ByokModelRouter: routing policy (the truth table)', () => {
  it('routes edits/generation/event-writing (main) to strong', () => {
    expect(resolveByokRoutingProfile(makeSettings(), 'main')).toBe('strong');
  });

  it('routes scout, compaction, suggestions and docs to fast', () => {
    expect(isFastByokCallKind('scout')).toBe(true);
    expect(isFastByokCallKind('compaction')).toBe(true);
    expect(isFastByokCallKind('suggestions')).toBe(true);
    expect(isFastByokCallKind('docs')).toBe(true);
    expect(resolveByokRoutingProfile(makeSettings(), 'scout')).toBe('fast');
    expect(resolveByokRoutingProfile(makeSettings(), 'compaction')).toBe(
      'fast'
    );
  });

  it('keeps the reviewer on strong (it gates the final quality)', () => {
    expect(resolveByokRoutingProfile(makeSettings(), 'reviewer')).toBe(
      'strong'
    );
  });

  it("'always-strong' overrides the fast kinds", () => {
    const settings = makeSettings({ routingMode: 'always-strong' });
    const fastKinds: Array<ByokCallKind> = [
      'scout',
      'compaction',
      'suggestions',
      'docs',
    ];
    for (const kind of fastKinds) {
      expect(resolveByokRoutingProfile(settings, kind)).toBe('strong');
    }
  });
});

describe('ByokModelRouter: target resolution order', () => {
  const settingsWithProviders = makeSettings({
    endpointUrl: 'https://legacy.example.com/v1',
    modelName: 'legacy-model',
    providers: [
      {
        id: 'prov-a',
        name: 'Alpha',
        endpointUrl: 'https://alpha.example.com/v1',
        keyRef: 'prov-a',
        modelSettings: [],
      },
      {
        id: 'prov-b',
        name: 'Beta',
        endpointUrl: 'https://beta.example.com/v1',
        keyRef: '',
        modelSettings: [],
      },
    ],
    fastProfile: {
      providerId: 'prov-a',
      modelName: 'fast-model',
      temperature: 0.2,
      maxTokens: 512,
    },
  });

  it('falls back to the global endpoint/model when nothing is configured', () => {
    const target = resolveByokModelTarget({
      settings: makeSettings({
        endpointUrl: 'https://global.example.com/v1',
        modelName: 'global-model',
      }),
      chatSelection: null,
      callKind: 'main',
    });
    expect(target).toEqual({
      providerId: '',
      endpointUrl: 'https://global.example.com/v1',
      modelName: 'global-model',
      temperature: null,
      maxTokens: null,
      source: 'global',
    });
  });

  it('applies the profile policy (per call kind) over the global fallback', () => {
    const target = resolveByokModelTarget({
      settings: settingsWithProviders,
      chatSelection: null,
      callKind: 'compaction',
    });
    expect(target.modelName).toBe('fast-model');
    expect(target.endpointUrl).toBe('https://alpha.example.com/v1');
    expect(target.temperature).toBe(0.2);
    expect(target.maxTokens).toBe(512);
    expect(target.source).toBe('policy');

    const strongTarget = resolveByokModelTarget({
      settings: settingsWithProviders,
      chatSelection: null,
      callKind: 'main',
    });
    expect(strongTarget.modelName).toBe('legacy-model');
    expect(strongTarget.source).toBe('global');
  });

  it('lets the per-chat dropdown override profile and global', () => {
    const target = resolveByokModelTarget({
      settings: settingsWithProviders,
      chatSelection: {
        providerId: 'prov-b',
        modelName: 'chat-model',
        reasoningEffort: 'medium',
      },
      callKind: 'main',
    });
    expect(target.endpointUrl).toBe('https://beta.example.com/v1');
    expect(target.modelName).toBe('chat-model');
    expect(target.source).toBe('chat-override');
  });

  it('keeps the advanced fields of the routed profile under a chat override', () => {
    const target = resolveByokModelTarget({
      settings: settingsWithProviders,
      chatSelection: {
        providerId: 'prov-b',
        modelName: 'chat-model',
        reasoningEffort: 'default',
      },
      callKind: 'compaction',
    });
    expect(target.temperature).toBe(0.2);
    expect(target.maxTokens).toBe(512);
  });

  it('treats a profile without a model name as "no policy"', () => {
    const target = resolveByokModelTarget({
      settings: makeSettings({
        endpointUrl: 'https://global.example.com/v1',
        modelName: 'global-model',
        fastProfile: {
          providerId: '',
          modelName: '',
          temperature: null,
          maxTokens: null,
        },
      }),
      chatSelection: null,
      callKind: 'suggestions',
    });
    expect(target.source).toBe('global');
  });

  it('falls back to the global endpoint for an unknown provider id', () => {
    const target = resolveByokModelTarget({
      settings: makeSettings({
        endpointUrl: 'https://global.example.com/v1',
        modelName: 'global-model',
        providers: [
          {
            id: 'other',
            name: 'Other',
            endpointUrl: 'https://other.example.com/v1',
            keyRef: 'other',
            modelSettings: [],
          },
        ],
      }),
      chatSelection: {
        providerId: 'gone',
        modelName: 'chat-model',
        reasoningEffort: 'default',
      },
      callKind: 'main',
    });
    expect(target.endpointUrl).toBe('https://global.example.com/v1');
    // The selection pinned a provider the user has since deleted. It must
    // fall through to normal profile/global resolution: keeping the dead
    // provider's MODEL against the global endpoint sent a model that
    // endpoint never knew (audit100226 UI-4).
    expect(target.modelName).toBe('global-model');
  });

  it('keeps a chat selection whose provider still exists', () => {
    const target = resolveByokModelTarget({
      settings: makeSettings({
        endpointUrl: 'https://global.example.com/v1',
        modelName: 'global-model',
        providers: [
          {
            id: 'kept',
            name: 'Kept',
            endpointUrl: 'https://kept.example.com/v1',
            keyRef: 'kept',
            modelSettings: [],
          },
        ],
      }),
      chatSelection: {
        providerId: 'kept',
        modelName: 'chat-model',
        reasoningEffort: 'default',
      },
      callKind: 'main',
    });
    expect(target.endpointUrl).toBe('https://kept.example.com/v1');
    expect(target.modelName).toBe('chat-model');
  });
});

describe('ByokModelRouter: provider registry CRUD', () => {
  it('upserts by id, preserving the other entries', () => {
    const first: ByokProvider = {
      id: 'p1',
      name: 'One',
      endpointUrl: 'https://one/v1',
      keyRef: 'p1',
      modelSettings: [],
    };
    const second: ByokProvider = {
      id: 'p2',
      name: 'Two',
      endpointUrl: 'https://two/v1',
      keyRef: 'p2',
      modelSettings: [],
    };
    const updated: ByokProvider = {
      id: 'p1',
      name: 'One renamed',
      endpointUrl: 'https://one-new/v1',
      keyRef: 'p1',
      modelSettings: [],
    };

    let providers = upsertByokProvider([], first);
    expect(providers).toHaveLength(1);
    providers = upsertByokProvider(providers, second);
    expect(providers).toHaveLength(2);
    providers = upsertByokProvider(providers, updated);
    expect(providers).toHaveLength(2);
    const renamed = providers.find(provider => provider.id === 'p1');
    expect(renamed && renamed.name).toBe('One renamed');
  });

  it('removes only the targeted provider', () => {
    const providers: Array<ByokProvider> = [
      { id: 'p1', name: 'One', endpointUrl: '', keyRef: '', modelSettings: [] },
      { id: 'p2', name: 'Two', endpointUrl: '', keyRef: '', modelSettings: [] },
    ];
    expect(removeByokProvider(providers, 'p1').map(p => p.id)).toEqual(['p2']);
    expect(removeByokProvider(providers, 'nope')).toHaveLength(2);
  });

  it('migrates the legacy single endpoint into provider #1 with the legacy key slot', () => {
    const providers = buildLegacyMigrationProviders(
      makeSettings({
        endpointUrl: 'https://legacy.example.com/v1',
        modelName: 'legacy-model',
      })
    );
    expect(providers).not.toBe(null);
    expect(providers && providers[0].endpointUrl).toBe(
      'https://legacy.example.com/v1'
    );
    expect(providers && providers[0].keyRef).toBe('');
    expect(providers && providers[0].id).toBeTruthy();
  });

  it('does not migrate when a registry already exists or nothing is configured', () => {
    expect(
      buildLegacyMigrationProviders(
        makeSettings({
          endpointUrl: 'https://x/v1',
          providers: [
            {
              id: 'p',
              name: 'P',
              endpointUrl: 'https://x/v1',
              keyRef: 'p',
              modelSettings: [],
            },
          ],
        })
      )
    ).toBe(null);
    expect(buildLegacyMigrationProviders(makeSettings())).toBe(null);
  });

  it('generates distinct provider ids', () => {
    expect(makeByokProviderId()).not.toBe(makeByokProviderId());
  });
});

describe('ByokModelRouter: chat model selection on the record', () => {
  it('round-trips through the chat record and rejects corrupted values', () => {
    const chat: any = {};
    expect(getByokChatModelSelection(chat)).toBe(null);

    setByokChatModelSelection(chat, {
      providerId: 'p1',
      modelName: 'm1',
      reasoningEffort: 'high',
    });
    expect(getByokChatModelSelection(chat)).toEqual({
      providerId: 'p1',
      modelName: 'm1',
      reasoningEffort: 'high',
    });

    setByokChatModelSelection(chat, null);
    expect(getByokChatModelSelection(chat)).toBe(null);

    chat.byokModelSelection = { modelName: '' };
    expect(getByokChatModelSelection(chat)).toBe(null);
    chat.byokModelSelection = {
      providerId: 42,
      modelName: 'm1',
      reasoningEffort: 'extreme',
    };
    const selection = getByokChatModelSelection(chat);
    expect(selection && selection.reasoningEffort).toBe('default');
  });
});

describe('ByokModelRouter: reasoning effort resolution', () => {
  it('prefers the per-chat effort over the global setting', () => {
    expect(
      resolveByokReasoningEffort({
        settings: makeSettings({ reasoningEffort: 'low' }),
        chatSelection: {
          providerId: '',
          modelName: 'm',
          reasoningEffort: 'high',
        },
        capabilityRecord: null,
      })
    ).toBe('high');
  });

  it('falls back to the global setting (null when default)', () => {
    expect(
      resolveByokReasoningEffort({
        settings: makeSettings({ reasoningEffort: 'default' }),
        chatSelection: null,
        capabilityRecord: null,
      })
    ).toBe(null);
    expect(
      resolveByokReasoningEffort({
        settings: makeSettings({ reasoningEffort: 'medium' }),
        chatSelection: null,
        capabilityRecord: null,
      })
    ).toBe('medium');
  });

  it('suppresses the parameter entirely once the model degraded', () => {
    expect(
      resolveByokReasoningEffort({
        settings: makeSettings({ reasoningEffort: 'high' }),
        chatSelection: {
          providerId: '',
          modelName: 'm',
          reasoningEffort: 'high',
        },
        capabilityRecord: {
          images: null,
          effortLevels: null,
          reasoningEffortDegraded: true,
          strictSchemas: null,
          parallelToolCalls: null,
          updatedAt: '2026-09-23T00:00:00.000Z',
        },
      })
    ).toBe(null);
  });
});

describe('ByokModelRouter: effort options source', () => {
  it('defaults to low/medium/high', () => {
    expect(getByokEffortOptions(null)).toEqual(['low', 'medium', 'high']);
  });

  it('uses the server-listed levels when the probe found some', () => {
    expect(
      getByokEffortOptions({
        images: null,
        effortLevels: ['low', 'high'],
        reasoningEffortDegraded: false,
        strictSchemas: null,
        parallelToolCalls: null,
        updatedAt: '',
      })
    ).toEqual(['low', 'high']);
  });

  it('falls back to the defaults on unusable server lists', () => {
    expect(
      getByokEffortOptions({
        images: null,
        effortLevels: ['extreme', 'turbo'],
        reasoningEffortDegraded: false,
        strictSchemas: null,
        parallelToolCalls: null,
        updatedAt: '',
      })
    ).toEqual(['low', 'medium', 'high']);
  });
});

describe('ByokModelRouter: the chat model dropdown choices', () => {
  it('lists each provider model as provider name/model name, plus the global fallback', () => {
    const choices = listByokModelChoices({
      settings: makeSettings({
        modelName: 'global-model',
        providers: [
          {
            id: 'prov-a',
            name: 'Alpha',
            endpointUrl: 'https://a/v1',
            keyRef: 'a',
            modelSettings: [],
          },
        ],
      }),
      modelsByProviderId: {
        'prov-a': ['fast-model', 'alpha-big'],
        '': ['global-model'],
      },
    });
    expect(choices.map(choice => choice.label)).toEqual([
      'Alpha/alpha-big',
      'Alpha/fast-model',
      'Default/global-model',
    ]);
  });

  it('deduplicates identical labels', () => {
    const choices = listByokModelChoices({
      settings: makeSettings({ providers: [] }),
      modelsByProviderId: { '': ['m1', 'm1'] },
    });
    expect(choices).toHaveLength(1);
  });
});

describe('ByokModelRouter: the Phase 13.4 routing-pair migration', () => {
  const makeProvider = (id: string): ByokProvider => ({
    id,
    name: `Provider ${id}`,
    endpointUrl: `https://${id}.example.com/v1`,
    keyRef: id,
    modelSettings: [],
  });

  it('fills an old provider-less profile with the first provider', () => {
    const settings: ByokSettings = {
      ...DEFAULT_BYOK_SETTINGS,
      providers: [makeProvider('p1'), makeProvider('p2')],
      strongProfile: {
        providerId: '',
        modelName: 'old-strong',
        temperature: null,
        maxTokens: null,
      },
    };
    const migrated: any = migrateByokRoutingProfiles(settings);
    expect(migrated).not.toBe(null);
    expect(migrated.strongProfile.providerId).toBe('p1');
    expect(migrated.strongProfile.modelName).toBe('old-strong');
  });

  it('keeps profiles that already point at a real provider', () => {
    const settings: ByokSettings = {
      ...DEFAULT_BYOK_SETTINGS,
      providers: [makeProvider('p1')],
      fastProfile: {
        providerId: 'p1',
        modelName: 'fast-model',
        temperature: null,
        maxTokens: null,
      },
    };
    expect(migrateByokRoutingProfiles(settings)).toBe(null);
  });

  it('returns null without providers or without model names', () => {
    expect(migrateByokRoutingProfiles(DEFAULT_BYOK_SETTINGS)).toBe(null);
    const withProviders: ByokSettings = {
      ...DEFAULT_BYOK_SETTINGS,
      providers: [makeProvider('p1')],
    };
    expect(migrateByokRoutingProfiles(withProviders)).toBe(null);
  });

  it('re-points a profile whose provider no longer exists', () => {
    const settings: ByokSettings = {
      ...DEFAULT_BYOK_SETTINGS,
      providers: [makeProvider('p1')],
      fastProfile: {
        providerId: 'deleted-provider',
        modelName: 'fast-model',
        temperature: null,
        maxTokens: null,
      },
    };
    const migrated: any = migrateByokRoutingProfiles(settings);
    expect(migrated).not.toBe(null);
    expect(migrated.fastProfile.providerId).toBe('p1');
  });
});

describe('ByokModelRouter: per-provider model settings overlay (13.4)', () => {
  const makeProvider = (modelSettings: Array<any>) => ({
    id: 'p1',
    name: 'Provider 1',
    endpointUrl: 'https://p1.example.com/v1',
    keyRef: 'p1',
    modelSettings,
  });

  it('lets a per-model temperature/max-tokens win over the profile values', () => {
    const settings: ByokSettings = {
      ...DEFAULT_BYOK_SETTINGS,
      providers: [
        makeProvider([
          {
            modelName: 'tuned-model',
            temperature: 0.3,
            maxTokens: 2048,
            contextWindowTokens: null,
          },
        ]),
      ],
      strongProfile: {
        providerId: 'p1',
        modelName: 'tuned-model',
        temperature: 0.9,
        maxTokens: null,
      },
    };
    const target = resolveByokModelTarget({
      settings,
      chatSelection: null,
      callKind: 'main',
    });
    expect(target.endpointUrl).toBe('https://p1.example.com/v1');
    expect(target.modelName).toBe('tuned-model');
    expect(target.temperature).toBe(0.3);
    expect(target.maxTokens).toBe(2048);
  });

  it('keeps the profile values when the model has no block', () => {
    const settings: ByokSettings = {
      ...DEFAULT_BYOK_SETTINGS,
      providers: [makeProvider([])],
      strongProfile: {
        providerId: 'p1',
        modelName: 'plain-model',
        temperature: 0.9,
        maxTokens: null,
      },
    };
    const target = resolveByokModelTarget({
      settings,
      chatSelection: null,
      callKind: 'main',
    });
    expect(target.temperature).toBe(0.9);
    expect(target.maxTokens).toBe(null);
  });
});
