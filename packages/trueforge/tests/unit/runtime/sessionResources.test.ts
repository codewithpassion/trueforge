import { OpenAPIHono } from '@hono/zod-openapi';
import {
  AgentSpecSchema,
  InMemorySessionStore,
  Sessions,
  type SessionAgent,
  type SessionHandle,
} from '@truefoundry/trueforge-core/agent-session';
import {
  WebSearchProviders,
  type IWebSearchProvider,
} from '@truefoundry/trueforge-core/core/web-search/WebSearchProvider';
import { HTTPException } from 'hono/http-exception';
import { createLogger } from 'winston';
import { createCapabilitiesRouter } from '../../../src/apis/capabilities';
import { resolveRequestContext } from '../../../src/auth/identity';
import { createAuthMiddleware } from '../../../src/auth/middleware';
import { StandaloneAuthenticator } from '../../../src/auth/standaloneAuthenticator';
import { validateGitAgentSkills } from '../../../src/db/gitSkillMounts';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import type { ISkillStore } from '../../../src/db/skillStore';
import { BetterSqliteAtomicRunner, createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import type { WithTransaction } from '../../../src/db/transaction';
import { GetCapabilitiesResponseSchema } from '../../../src/routes/capabilityRoutes';
import {
  buildGatewayMetadata,
  getModelDetails,
  mergeGatewayMetadata,
  parseGatewayMetadataHeader,
  TFG_METADATA_PREFIX,
  validateAgentSpec,
  withGatewayMetadataHeaders,
  X_TFY_METADATA,
} from '../../../src/runtime/sessionResources';
import type { SandboxIntegration } from '../../../src/sandbox/integration';
import type { LocalSandboxSupportResult } from '../../../src/sandbox/local/provider/LocalSandboxProvider';
import { createNodeSandboxIntegration } from '../../../src/sandbox/nodeSandboxIntegration';
import type { ReasoningEffort } from '../../../src/schemas/modelProvider';
import { SANDBOX_READY_STATUS, type StoredSandboxProviderManifest } from '../../../src/schemas/sandboxProvider';
import { resolveWebSearchProvider } from '../../../src/websearch/providers';

const DAYTONA_MANIFEST: StoredSandboxProviderManifest = {
  type: 'daytona',
  auth: { api_key: 'dtn-test' },
  exec_timeout_ms: 60_000,
  auto_stop_interval_in_minutes: 5,
  auto_archive_interval_in_minutes: 60,
  auto_delete_interval_in_minutes: 7200,
};

const PREBUILT_MANIFEST: StoredSandboxProviderManifest = {
  type: 'truefoundry',
  server_url: 'http://sandbox-server',
  nats_bridge_url: 'ws://nats-bridge',
  exec_timeout_ms: 60_000,
};

const LOCAL_SUPPORTED: LocalSandboxSupportResult = {
  supported: true,
  platform: 'darwin',
  shell: '/bin/bash',
  python: '/usr/bin/python3',
};

jest.mock('../../../src/websearch/providers', () => ({
  resolveWebSearchProvider: jest.fn(() => undefined),
}));

const mockWebSearchProvider: IWebSearchProvider = {
  id: WebSearchProviders.Parallel,
  search: () => Promise.resolve({ hits: [] }),
  fetch: () => Promise.resolve({ pages: [] }),
};

async function createGatewayMetadataSession(input: { agent: SessionAgent }): Promise<SessionHandle> {
  const sessions = new Sessions({ sessionStore: new InMemorySessionStore() });
  return sessions.create({
    tenant_id: 'tenant-1',
    session_id: 'sess-1',
    created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
    agent: input.agent,
    metadata: {},
    external_id: null,
  });
}

describe('parseGatewayMetadataHeader', () => {
  it('parses a JSON object of string values', () => {
    expect(parseGatewayMetadataHeader(JSON.stringify({ env: 'prod', team: 'platform' }))).toEqual({
      env: 'prod',
      team: 'platform',
    });
  });

  it.each([
    ['not json', 'not-json'],
    ['an array', '[]'],
    ['a scalar', '"nope"'],
    ['a value that is not a string', JSON.stringify({ env: 1 })],
  ])('rejects %s rather than silently dropping caller metadata', (_case, raw) => {
    expect(() => parseGatewayMetadataHeader(raw)).toThrow(HTTPException);
  });

  it('keeps the parse failure as the cause, so a bad header can be debugged', () => {
    expect(() => parseGatewayMetadataHeader('not-json')).toThrow(
      expect.objectContaining({ cause: expect.any(SyntaxError) }),
    );
  });
});

describe('buildGatewayMetadata', () => {
  it('stamps session/turn/agent fields only', async () => {
    const session = await createGatewayMetadataSession({
      agent: { type: 'reference', id: 'agent-1', name: 'my-agent' },
    });

    expect(buildGatewayMetadata({ session, turnId: 'turn-1' })).toEqual({
      [`${TFG_METADATA_PREFIX}.session_id`]: 'sess-1',
      [`${TFG_METADATA_PREFIX}.turn_id`]: 'turn-1',
      [`${TFG_METADATA_PREFIX}.agent_id`]: 'agent-1',
      [`${TFG_METADATA_PREFIX}.agent_name`]: 'my-agent',
    });
  });
});

describe('mergeGatewayMetadata', () => {
  it('keeps requestMetadata keys and overwrites spoofed tfg.* fields so order is maintained', async () => {
    const session = await createGatewayMetadataSession({
      agent: { type: 'reference', id: 'agent-1', name: 'my-agent' },
    });

    expect(
      mergeGatewayMetadata({
        session,
        turnId: 'turn-1',
        requestMetadata: {
          env: 'prod',
          [`${TFG_METADATA_PREFIX}.session_id`]: 'spoofed-session',
          [`${TFG_METADATA_PREFIX}.turn_id`]: 'spoofed-turn',
          [`${TFG_METADATA_PREFIX}.agent_id`]: 'spoofed-agent',
          [`${TFG_METADATA_PREFIX}.agent_name`]: 'spoofed-name',
        },
      }),
    ).toEqual({
      env: 'prod',
      [`${TFG_METADATA_PREFIX}.session_id`]: 'sess-1',
      [`${TFG_METADATA_PREFIX}.turn_id`]: 'turn-1',
      [`${TFG_METADATA_PREFIX}.agent_id`]: 'agent-1',
      [`${TFG_METADATA_PREFIX}.agent_name`]: 'my-agent',
    });
  });

  it('matches harness-only stamps when requestMetadata is absent', async () => {
    const session = await createGatewayMetadataSession({
      agent: { type: 'reference', id: 'agent-1', name: 'my-agent' },
    });

    expect(mergeGatewayMetadata({ session, turnId: 'turn-1' })).toEqual(
      buildGatewayMetadata({ session, turnId: 'turn-1' }),
    );
  });
});

describe('withGatewayMetadataHeaders', () => {
  it('merges into async header resolvers and preserves authRequired', async () => {
    const withAuth = withGatewayMetadataHeaders({
      headers: async () => ({ headers: { Authorization: 'Bearer t' } }),
      metadataHeaders: { [X_TFY_METADATA]: '{"k":"v"}' },
    });
    expect(typeof withAuth).toBe('function');
    if (typeof withAuth !== 'function') {
      throw new Error('expected async header resolver');
    }
    await expect(withAuth()).resolves.toEqual({
      headers: {
        Authorization: 'Bearer t',
        [X_TFY_METADATA]: '{"k":"v"}',
      },
    });

    const authRequired = withGatewayMetadataHeaders({
      headers: async () => ({
        authRequired: { servers: [{ id: 'mcp', name: 'mcp', auth_url: 'https://auth.example' }] },
      }),
      metadataHeaders: { [X_TFY_METADATA]: '{"k":"v"}' },
    });
    expect(typeof authRequired).toBe('function');
    if (typeof authRequired !== 'function') {
      throw new Error('expected async header resolver');
    }
    await expect(authRequired()).resolves.toEqual({
      authRequired: { servers: [{ id: 'mcp', name: 'mcp', auth_url: 'https://auth.example' }] },
    });
  });
});

describe('validateAgentSpec', () => {
  afterEach(() => {
    setCachedLocalSandboxSupport(undefined);
    jest.mocked(resolveWebSearchProvider).mockReset();
    jest.mocked(resolveWebSearchProvider).mockReturnValue(undefined);
  });

  async function setup(options?: {
    reasoningEfforts?: ReasoningEffort[] | undefined;
    localSupport?: LocalSandboxSupportResult | undefined;
  }) {
    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const modelProviderStore = new SqliteModelProviderStore(db);
    await modelProviderStore.upsertProvider({
      tenant_id: 'default',
      name: 'test-provider',
      manifest: {
        // Caller-named, so `custom` is the only type it can be.
        type: 'custom',
        name: 'test-provider',
        base_url: 'https://llm.test.example.com/v1',
        auth: { api_key: 'sk-test' },
        models: [
          {
            model_id: 'test-model',
            name: 'test-model',
            properties: {
              context_length: 128000,
              max_output_tokens: 4096,
              ...(options?.reasoningEfforts !== undefined ? { reasoning_efforts: options.reasoningEfforts } : {}),
            },
          },
        ],
      },
    });
    return {
      modelProviderStore,
      mcpServerStore: new SqliteMcpServerStore(db, new BetterSqliteAtomicRunner(db)),
      skillStore: new SqliteSkillStore(db),
      sandboxProviderStore: new SqliteSandboxProviderStore(db),
      sandboxIntegration: createNodeSandboxIntegration({ localSupport: options?.localSupport }),
      logger: createLogger({ silent: true }),
    };
  }

  it('maps the configured model output limit to runtime max_tokens', async () => {
    const stores = await setup();

    await expect(
      getModelDetails({
        tenant_id: 'default',
        name: 'test-provider/test-model',
        store: stores.modelProviderStore,
      }),
    ).resolves.toMatchObject({
      providerConfig: {
        provider: { type: 'custom', name: 'test-provider' },
        model: { id: 'test-model', name: 'test-model' },
        name: 'test-provider/test-model',
      },
      defaultModelParams: { max_tokens: 4096 },
      modelProperties: { contextLength: 128000 },
    });
  });

  it('rejects malformed model FQN with 422', async () => {
    const stores = await setup();
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'not-a-fqn' },
          instructions: 'test',
        }),
        tenant_id: 'default',
        agent_id: undefined,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('fully qualified "provider/model"'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects unknown model provider with 422', async () => {
    const stores = await setup();
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'missing-provider/test-model' },
          instructions: 'test',
        }),
        tenant_id: 'default',
        agent_id: undefined,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('provider not configured'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects unknown model on provider with 422', async () => {
    const stores = await setup();
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/missing-model' },
          instructions: 'test',
        }),
        tenant_id: 'default',
        agent_id: undefined,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('not configured on provider'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects unsupported reasoning effort with 422', async () => {
    const stores = await setup({ reasoningEfforts: ['low', 'high'] });
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model', params: { reasoning_effort: 'medium' } },
          instructions: 'test',
        }),
        tenant_id: 'default',
        agent_id: undefined,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('Reasoning effort "medium"'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects unknown MCP server with 422', async () => {
    const stores = await setup();
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          mcp_servers: [{ name: 'missing-mcp' }],
        }),
        tenant_id: 'default',
        agent_id: undefined,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('Unknown MCP server "missing-mcp"'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects unknown skill with 422', async () => {
    const stores = await setup();
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          skills: [{ name: 'missing-skill' }],
        }),
        tenant_id: 'default',
        agent_id: undefined,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('Unknown skill "missing-skill"'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects sandbox.enabled when no sandbox provider is configured', async () => {
    const stores = await setup();
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          config: { sandbox: { enabled: true } },
        }),
        tenant_id: 'default',
        agent_id: undefined,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('PUT /settings/sandbox-providers'),
    } satisfies Partial<HTTPException>);
  });

  it('rejects web_search.enabled with 422 when no web-search provider is configured', async () => {
    const stores = await setup();
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          config: { web_search: { enabled: true } },
        }),
        tenant_id: 'default',
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('no web-search provider is configured'),
    } satisfies Partial<HTTPException>);
  });

  it('admits web_search.enabled when a web-search provider resolves', async () => {
    const stores = await setup();
    jest.mocked(resolveWebSearchProvider).mockReturnValueOnce(mockWebSearchProvider);
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          config: { web_search: { enabled: true } },
        }),
        tenant_id: 'default',
        ...stores,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects skills when no sandbox provider is configured', async () => {
    const stores = await setup();
    await stores.skillStore.upsertSkill({
      tenant_id: 'default',
      name: 'demo',
      manifest: {
        type: 'git',
        name: 'demo',
        url: 'https://github.com/example/skills',
        ref: 'main',
        description: 'demo skill',
      },
    });

    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          skills: [{ name: 'demo' }],
        }),
        tenant_id: 'default',
        agent_id: undefined,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('skills require a sandbox provider'),
    } satisfies Partial<HTTPException>);
  });

  // A fresh `ready` row short-circuits the status refresh, so this never reaches Daytona.
  async function storeDaytonaProvider(store: SqliteSandboxProviderStore): Promise<void> {
    await store.upsertSandboxProvider({
      tenant_id: 'default',
      manifest: DAYTONA_MANIFEST,
      ...SANDBOX_READY_STATUS,
    });
  }

  it('admits sandbox.enabled when a sandbox provider row is ready', async () => {
    const stores = await setup();
    await storeDaytonaProvider(stores.sandboxProviderStore);

    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          config: { sandbox: { enabled: true } },
        }),
        tenant_id: 'default',
        agent_id: undefined,
        ...stores,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects sandbox.enabled without a sandbox integration even when a provider row exists', async () => {
    const stores = await setup();
    await storeDaytonaProvider(stores.sandboxProviderStore);

    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          config: { sandbox: { enabled: true } },
        }),
        tenant_id: 'default',
        agent_id: undefined,
        ...stores,
        sandboxIntegration: undefined,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('no sandbox provider is configured'),
    } satisfies Partial<HTTPException>);
  });

  it('admits sandbox.enabled when local fallback is supported and the store is empty', async () => {
    const stores = await setup({ localSupport: LOCAL_SUPPORTED });
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          config: { sandbox: { enabled: true } },
        }),
        tenant_id: 'default',
        agent_id: undefined,
        ...stores,
      }),
    ).resolves.toBeUndefined();
    expect(await stores.sandboxProviderStore.getSandboxProvider('default')).toBeUndefined();
  });

  it('rejects registry catalog rows as git mounts (standalone)', async () => {
    const stores = await setup({ localSupport: LOCAL_SUPPORTED });
    const fqn = 'agent-skill:acme/team-a/echo:1';
    const now = '2026-01-01T00:00:00.000Z';
    const skillStore: ISkillStore = {
      listSkills: async () => [
        {
          tenant_id: 'default',
          name: fqn,
          manifest: {
            type: 'truefoundry' as const,
            name: fqn,
            display_name: 'echo',
            description: 'Echo',
            repository_name: 'team-a',
            version: 1,
          },
          created_at: now,
          updated_at: now,
        },
      ],
      createSkill: async () => {
        throw new Error('unused');
      },
      upsertSkill: async () => {
        throw new Error('unused');
      },
      listSkillVersions: async () => [],
      async validateAgentSkills(input) {
        return validateGitAgentSkills(this, input);
      },
      resolveTurnSkills: async () => {
        throw new Error('unused');
      },
    };
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          skills: [{ name: fqn }],
        }),
        tenant_id: 'default',
        agent_id: undefined,
        ...stores,
        skillStore,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: `Skill "${fqn}" is not a git skill`,
    });
  });

  it('validates skills via skillStore.validateAgentSkills', async () => {
    const stores = await setup({ localSupport: LOCAL_SUPPORTED });
    const validateAgentSkills = jest.spyOn(stores.skillStore, 'validateAgentSkills').mockResolvedValue(undefined);
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          skills: [{ name: 'agent-skill:acme/team-a/echo:3', preload: false }],
        }),
        tenant_id: 'default',
        agent_id: undefined,
        ...stores,
      }),
    ).resolves.toBeUndefined();
    expect(validateAgentSkills).toHaveBeenCalledWith({
      tenant_id: 'default',
      skills: [{ name: 'agent-skill:acme/team-a/echo:3', preload: false }],
    });
  });

  it('rejects preload on git skills', async () => {
    const stores = await setup({ localSupport: LOCAL_SUPPORTED });
    await stores.skillStore.upsertSkill({
      tenant_id: 'default',
      name: 'echo',
      manifest: {
        type: 'git',
        name: 'echo',
        description: 'Echo',
        url: 'https://github.com/acme/skills',
        ref: 'main',
      },
    });
    await expect(
      validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          skills: [{ name: 'echo', preload: true }],
        }),
        tenant_id: 'default',
        agent_id: undefined,
        ...stores,
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: 'Skill "echo": preload is not supported for git skills',
    });
  });

  /**
   * Cycle 18: the capability endpoint said yes while the validator said no, because they read
   * "is a sandbox configured" from different places. Both now go through the integration, so
   * this pins them together on the runtime where they drifted.
   */
  /**
   * A Daytona outage makes the build check time out after 60 s. That is the provider being
   * unreachable, not a bad spec, so it must not reach the handler as a generic 500.
   */
  it('answers 503 naming the provider when the build check throws', async () => {
    const stores = await setup();
    const unreachable = new Error('sandbox getImageBuildStatus timed out after 60000ms');
    const sandboxIntegration: SandboxIntegration = {
      ...stores.sandboxIntegration,
      resolveSandboxUsability: () => Promise.reject(unreachable),
    };

    const thrown = await validateAgentSpec({
      spec: AgentSpecSchema.parse({
        model: { name: 'test-provider/test-model' },
        instructions: 'test',
        config: { sandbox: { enabled: true } },
      }),
      tenant_id: 'default',
      agent_id: undefined,
      ...stores,
      sandboxIntegration,
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(HTTPException);
    expect(thrown).toMatchObject({
      status: 503,
      message: expect.stringContaining('sandbox provider is unreachable'),
      cause: unreachable,
    } satisfies Partial<HTTPException>);
  });

  describe('agreement with GET /capabilities on the real Node integration', () => {
    async function bothAnswers(
      stores: Awaited<ReturnType<typeof setup>>,
    ): Promise<{ capability: boolean; validator: boolean }> {
      // The capability handler is read-only; it never opens the transaction it is handed.
      const withTransaction: WithTransaction<never> = () => Promise.reject(new Error('unused'));
      const router = new OpenAPIHono();
      router.use('*', createAuthMiddleware(new StandaloneAuthenticator()));
      router.route(
        '/',
        createCapabilitiesRouter({
          resolveSandboxProviderStore: () => stores.sandboxProviderStore,
          withTransaction,
          logger: stores.logger,
          resolveRequestContext,
          sandboxIntegration: stores.sandboxIntegration,
          computers: undefined,
        }),
      );
      const body: unknown = await (await router.request('/')).json();
      const capability = GetCapabilitiesResponseSchema.parse(body).data.sandbox.enabled;
      const validator = await validateAgentSpec({
        spec: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
          config: { sandbox: { enabled: true } },
        }),
        tenant_id: 'default',
        agent_id: undefined,
        ...stores,
      }).then(
        () => true,
        () => false,
      );
      return { capability, validator };
    }

    it('agrees that nothing is configured', async () => {
      await expect(bothAnswers(await setup())).resolves.toEqual({ capability: false, validator: false });
    });

    it('agrees on the local fallback', async () => {
      await expect(bothAnswers(await setup({ localSupport: LOCAL_SUPPORTED }))).resolves.toEqual({
        capability: true,
        validator: true,
      });
    });

    // A fresh `ready` row short-circuits the refresh, so this never reaches Daytona.
    it('agrees on a Daytona provider whose image is ready', async () => {
      const stores = await setup();
      await stores.sandboxProviderStore.upsertSandboxProvider({
        tenant_id: 'default',
        manifest: DAYTONA_MANIFEST,
        ...SANDBOX_READY_STATUS,
      });

      await expect(bothAnswers(stores)).resolves.toEqual({ capability: true, validator: true });
    });

    /**
     * This pair used to disagree: the capability endpoint refused a build that was not ready
     * while the validator admitted any row, so a spec was accepted that the turn then rejected.
     */
    // `failed` short-circuits the Daytona refresh; `pending` would call it, so that case uses the
    // prebuilt TrueFoundry provider, whose persisted status passes straight through.
    it.each([
      ['a failed Daytona build', DAYTONA_MANIFEST, 'failed' as const],
      ['a pending prebuilt image', PREBUILT_MANIFEST, 'pending' as const],
    ])('agrees that %s is not usable', async (_label, manifest, status) => {
      const stores = await setup();
      await stores.sandboxProviderStore.upsertSandboxProvider({
        tenant_id: 'default',
        manifest,
        status,
        status_reason: null,
        build_metadata: null,
      });

      await expect(bothAnswers(stores)).resolves.toEqual({ capability: false, validator: false });
    });

    // A row this runtime cannot attach to, with no fallback behind it.
    it('agrees that a cloudflare-computer row is not usable here', async () => {
      const stores = await setup();
      await stores.sandboxProviderStore.upsertSandboxProvider({
        tenant_id: 'default',
        manifest: { type: 'cloudflare-computer' },
        ...SANDBOX_READY_STATUS,
      });

      await expect(bothAnswers(stores)).resolves.toEqual({ capability: false, validator: false });
    });
  });
});
