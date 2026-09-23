import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  AgentSpecSchema,
  createInMemoryFileStore,
  EventType,
  MAIN_THREAD_ID,
  scopeFileStore,
  Sessions,
  type IFileStore,
  type SessionHandle,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import { setOutboundPolicy } from '@truefoundry/trueforge-core/core/util/outboundFetch';
import { createLogger } from 'winston';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { BetterSqliteAtomicRunner, createSqliteDb } from '../../../src/db/sqlite/client';
import type { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { createSqliteStores } from '../../../src/db/sqlite/stores';
import { ActiveTurnRegistry } from '../../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription';
import type { TurnStores } from '../../../src/runtime/turnExecutor';
import { startTurnInProcess } from '../../../src/runtime/turnRunner';
import { newId } from '../../../src/utils/id';

/**
 * A turn end to end through the server's resolver: an MCP tool returns a screenshot, the harness
 * stores it in the session's files, and the next model request carries the bytes. Model and MCP
 * traffic are answered in process.
 */

const TENANT_ID = 'default';

/** A PNG header for a 64x48 image; the header is all the harness reads. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0, 48, 8, 6,
  0, 0, 0, 0, 0, 0, 0,
]);
const PNG_B64 = Buffer.from(PNG).toString('base64');

interface CapturedModelRequest {
  raw: string;
}

/** An MCP server with one screenshot tool, fresh per request as a stateless streamable-HTTP server. */
async function handleMcpRequest(request: Request): Promise<Response> {
  const server = new McpServer({ name: 'desktop', version: '1.0.0' });
  server.registerTool(
    'screenshot',
    { description: 'Capture the screen.', annotations: { readOnlyHint: true } },
    () => ({ content: [{ type: 'image', data: PNG_B64, mimeType: 'image/png' }] }),
  );
  // No session id generator makes the transport stateless.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}

function sse(events: Record<string, unknown>[]): Response {
  const body = events.map(event => `event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/** Anthropic Messages streaming: a screenshot tool call until the history has a tool result, then text. */
function anthropicReply(raw: string): Response {
  const body: unknown = JSON.parse(raw);
  const tools =
    typeof body === 'object' && body !== null && 'tools' in body && Array.isArray(body.tools) ? body.tools : [];
  const toolName = tools
    .map((tool: unknown) => (typeof tool === 'object' && tool !== null && 'name' in tool ? String(tool.name) : ''))
    .find(name => name.includes('screenshot'));
  const start = {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  };
  if (!raw.includes('"tool_result"') && toolName !== undefined) {
    return sse([
      start,
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: toolName, input: {} },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]);
  }
  return sse([
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]);
}

function silentLogger() {
  return createLogger({ silent: true });
}

describe('turn runner with tool-result images', () => {
  let modelRequests: CapturedModelRequest[];
  let stores: TurnStores;
  let sessionStore: SqliteSessionStore;
  let fileStore: IFileStore;

  beforeEach(async () => {
    modelRequests = [];
    const route: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.hostname === 'mcp.test') {
        return handleMcpRequest(request);
      }
      if (url.hostname === 'llm.test' && url.pathname.endsWith('/messages')) {
        const raw = await request.text();
        modelRequests.push({ raw });
        return anthropicReply(raw);
      }
      return new Response(`Unexpected outbound request: ${request.url}`, { status: 599 });
    };
    setOutboundPolicy({ fetch: route, mcpFetch: route, assertUrl: () => Promise.resolve() });

    const db = createSqliteDb(':memory:');
    await migrateSqliteToLatest(db);
    const all = createSqliteStores({ db, atomic: new BetterSqliteAtomicRunner(db), mcpClientName: 'tool-images-test' });
    sessionStore = all.sessionStore;
    const { modelProviderStore, mcpServerStore } = all;
    stores = {
      agentStore: all.agentStore,
      modelProviderStore,
      mcpServerStore,
      sandboxProviderStore: all.sandboxProviderStore,
      skillStore: all.skillStore,
    };
    fileStore = createInMemoryFileStore();

    await modelProviderStore.upsertProvider({
      tenant_id: TENANT_ID,
      name: 'anthropic',
      manifest: {
        type: 'anthropic',
        base_url: 'https://llm.test/v1',
        auth: { api_key: 'sk-ant-test' },
        models: [
          {
            model_id: 'claude-test',
            name: 'claude-test',
            properties: { context_length: 200_000, max_output_tokens: 1_024 },
          },
        ],
      },
    });
    await mcpServerStore.upsertServer({
      tenant_id: TENANT_ID,
      name: 'desktop',
      manifest: {
        type: 'remote',
        name: 'desktop',
        url: 'https://mcp.test/mcp',
        description: 'A desktop.',
        auth: { type: 'header', headers: { authorization: 'Bearer mcp-test' } },
      },
    });
  });

  afterAll(() => {
    const platformFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
    setOutboundPolicy({ fetch: platformFetch, mcpFetch: platformFetch, assertUrl: () => Promise.resolve() });
  });

  async function createSession(sessionId: string): Promise<void> {
    await sessionStore.createSession({
      tenant_id: TENANT_ID,
      session_id: sessionId,
      created_by_subject: { subject_id: 'user', subject_type: 'user', subject_display_name: 'user' },
      agent: {
        type: 'inline',
        spec: AgentSpecSchema.parse({
          model: { name: 'anthropic/claude-test' },
          instructions: 'test',
          mcp_servers: [{ name: 'desktop', preload: true, require_approval_for_tools: [] }],
        }),
      },
      custom: null,
      metadata: {},
      external_id: null,
      source: null,
    });
  }

  async function sessionHandle(sessionId: string): Promise<SessionHandle> {
    const session = await new Sessions({ sessionStore }).get({ tenant_id: TENANT_ID, session_id: sessionId });
    if (session === undefined) throw new Error('expected the session that was just created');
    return session;
  }

  async function runTurn({ sessionId, previousTurnId }: { sessionId: string; previousTurnId: string | undefined }) {
    const started = await startTurnInProcess({
      session: await sessionHandle(sessionId),
      turn_id: newId(),
      active_executor_id: 'test',
      input: [{ type: 'user.message', content: 'take a screenshot' }],
      previous_turn_id: previousTurnId,
      userRef: 'user',
      request_metadata: undefined,
      deps: {
        ...stores,
        activeTurns: new ActiveTurnRegistry(),
        eventSubscriptions: new EventSubscriptionRegistry<TurnStreamingEvent>(undefined),
        logger: silentLogger(),
        sandboxIntegration: undefined,
        fileStore,
        onTurnDrained: undefined,
      },
    });
    await started.drained;
    const turn = await sessionStore.getTurn({ session_id: sessionId, turn_id: started.turn.record.turn_id });
    const { data: events } = await sessionStore.listTurnEvents({
      session_id: sessionId,
      turn_id: started.turn.record.turn_id,
      limit: 100,
      page_token: undefined,
      order: 'asc',
    });
    return { turn, events };
  }

  it('stores a tool screenshot in the session and sends its bytes to the model', async () => {
    const sessionId = `images-${newId()}`;
    await createSession(sessionId);

    const { turn, events } = await runTurn({ sessionId, previousTurnId: undefined });

    expect(turn?.state.status).toBe('done');
    const toolResponse = events.find(event => event.type === EventType.TOOL_RESPONSE);
    expect(toolResponse).toMatchObject({
      content: [{ type: 'image', file_id: expect.any(String), media_type: 'image/png', width: 64, height: 48 }],
    });
    expect(modelRequests).toHaveLength(2);
    const followUp = modelRequests[1]?.raw ?? '';
    expect(followUp).toContain(PNG_B64);
    expect(followUp).toContain('"type":"image"');
    expect(followUp).not.toContain('omitted');
  });

  it('sends a stub, not the bytes, for an image file that belongs to another session', async () => {
    const foreignSessionId = `images-foreign-${newId()}`;
    const { file_id: foreignFileId } = await scopeFileStore({
      fileStore,
      tenant_id: TENANT_ID,
      session_id: foreignSessionId,
    }).put({ media_type: 'image/png', bytes: PNG });

    // A session whose history references the other session's file.
    const sessionId = `images-${newId()}`;
    await createSession(sessionId);
    const firstTurnId = newId();
    await sessionStore.createTurn({
      turn: {
        turn_id: firstTurnId,
        session_id: sessionId,
        first_turn_id: firstTurnId,
        ancestor_ids: [],
        previous_turn_id: null,
        active_executor_id: 'test',
        state: { status: 'running' },
        input: [],
        created_at: new Date(),
        updated_at: new Date(),
        custom: null,
      },
      new_threads: [{ thread_id: MAIN_THREAD_ID, parent: null, agent_info: null }],
      new_context_appends: [
        {
          thread_id: MAIN_THREAD_ID,
          current_context_usage: null,
          context: [
            { role: 'user', content: 'take a screenshot' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'toolu_0',
                  type: 'function',
                  function: { name: 'desktop__screenshot', arguments: '{}' },
                  tool_info: {
                    type: 'mcp',
                    mcp_server_id: 'desktop',
                    mcp_server_name: 'desktop',
                    original_tool_name: 'screenshot',
                  },
                },
              ],
            },
            {
              role: 'tool',
              tool_call_id: 'toolu_0',
              content: [{ type: 'image', file_id: foreignFileId, media_type: 'image/png', width: 64, height: 48 }],
            },
          ],
        },
      ],
      capability_states: [{ thread_id: MAIN_THREAD_ID, capability_state: null }],
      update_session_title_if_not_exist: null,
    });
    const completedAt = new Date().toISOString();
    await sessionStore.updateTurnState({
      session_id: sessionId,
      turn_id: firstTurnId,
      state: { status: 'done', output: null, required_actions: [], completed_at: completedAt },
      turn_done_event: {
        type: EventType.TURN_DONE,
        id: newId(),
        created_at: completedAt,
        state: { status: 'done', output: null, required_actions: [], completed_at: completedAt },
        thread_id: null,
      },
    });

    const { turn } = await runTurn({ sessionId, previousTurnId: firstTurnId });

    expect(turn?.state.status).toBe('done');
    const [request] = modelRequests;
    expect(request?.raw).toContain('[screenshot 64x48 omitted: the image file could not be loaded]');
    expect(request?.raw).not.toContain(PNG_B64);
  });
});
