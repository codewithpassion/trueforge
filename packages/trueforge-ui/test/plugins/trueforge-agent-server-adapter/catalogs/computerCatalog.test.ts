import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  createComputerCatalog,
  toUiComputer,
  toUiComputerAuditEntry,
  toUiEnrollment,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/computerCatalog.js';
import { createTrueForgeClient } from '@/plugins/trueforge-agent-server-adapter/client.js';

const HARNESS_COMPUTER = {
  id: 'cmp-1',
  name: 'office-box',
  status: 'online' as const,
  hostname: 'office.local',
  os: 'linux',
  arch: 'amd64',
  agentVersion: '0.1.0',
  tools: { python3: true, git: false },
  runAsUser: 'trueforge',
  requireApproval: true,
  lastSeenAt: '2026-09-21T10:00:00.000Z',
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

type Captured = { url: string; method: string; body: unknown };

/** Records what the SDK actually put on the wire, which is the half the mappers cannot show. */
function recordingCatalog(respond: (url: string) => unknown) {
  const calls: Captured[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const raw = init?.body;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof raw === 'string' ? JSON.parse(raw) : undefined,
    });
    return Response.json(respond(url));
  };
  return { calls, catalog: createComputerCatalog(createTrueForgeClient({ fetch: fetchMock })) };
}

describe('computerCatalog mappers', () => {
  it('keeps a machine that has not reported anything as nulls, not as blanks', () => {
    assert.deepEqual(
      toUiComputer({
        ...HARNESS_COMPUTER,
        hostname: null,
        os: null,
        arch: null,
        agentVersion: null,
        tools: null,
        runAsUser: null,
        lastSeenAt: null,
      }),
      {
        id: 'cmp-1',
        name: 'office-box',
        status: 'online',
        hostname: null,
        os: null,
        arch: null,
        agentVersion: null,
        tools: null,
        runAsUser: null,
        requireApproval: true,
        lastSeenAt: null,
        createdAt: '2026-09-20T10:00:00.000Z',
        updatedAt: '2026-09-21T10:00:00.000Z',
      },
    );
  });

  it('carries both detected tools through', () => {
    assert.deepEqual(toUiComputer(HARNESS_COMPUTER).tools, { python3: true, git: false });
  });

  it('keeps a null docker command rather than inventing one', () => {
    assert.deepEqual(toUiEnrollment({ enrollmentCode: 'code-abc', installCommand: 'curl …', dockerCommand: null }), {
      enrollmentCode: 'code-abc',
      installCommand: 'curl …',
      dockerCommand: null,
    });
  });

  it('keeps a null exit code, which means the outcome never came back', () => {
    const entry = toUiComputerAuditEntry({
      id: 'aud-1',
      computerId: 'cmp-1',
      computerName: 'office-box',
      sessionId: null,
      turnId: null,
      op: 'exec',
      command: 'uname -a',
      exitCode: null,
      outcome: 'offline',
      durationMs: 3,
      bytesOut: 0,
      createdAt: '2026-09-21T10:00:00.000Z',
    });
    assert.equal(entry.exitCode, null);
    assert.equal(entry.sessionId, null);
  });
});

describe('computerCatalog requests', () => {
  it('sends only the fields an update names', async () => {
    const { calls, catalog } = recordingCatalog(() => ({ data: HARNESS_COMPUTER }));

    await catalog.updateComputer({ computerId: 'cmp-1', requireApproval: false });
    assert.deepEqual(calls[0]?.body, { require_approval: false });

    await catalog.updateComputer({ computerId: 'cmp-1', name: 'renamed' });
    assert.deepEqual(calls[1]?.body, { name: 'renamed' });
  });

  it('puts the allowlist as agent names and reads back what the server stored', async () => {
    const { calls, catalog } = recordingCatalog(() => ({ data: { agent_names: ['release-bot'] } }));

    assert.deepEqual(await catalog.putComputerAgentAccess({ computerId: 'cmp-1', agentNames: ['release-bot'] }), [
      'release-bot',
    ]);
    assert.equal(calls[0]?.method, 'PUT');
    assert.deepEqual(calls[0]?.body, { agent_names: ['release-bot'] });
  });

  it('lets the server 422 for an unknown agent name through untouched', async () => {
    const fetchMock: typeof fetch = async () =>
      Response.json({ error: { message: 'No such agent: ghost' } }, { status: 422 });
    const catalog = createComputerCatalog(createTrueForgeClient({ fetch: fetchMock }));

    await assert.rejects(
      catalog.putComputerAgentAccess({ computerId: 'cmp-1', agentNames: ['ghost'] }),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'body' in error &&
        JSON.stringify(error.body).includes('No such agent: ghost'),
    );
  });

  it('passes the audit cursor as page_token and returns the next one', async () => {
    const { calls, catalog } = recordingCatalog(() => ({
      data: [],
      pagination: { limit: 25, next_page_token: 'page-3' },
    }));

    const page = await catalog.listComputerAudit({ computerId: 'cmp-1', limit: 25, pageToken: 'page-2' });

    assert.equal(page.nextPageToken, 'page-3');
    const query = new URL(calls[0]?.url ?? '').searchParams;
    assert.equal(query.get('page_token'), 'page-2');
    assert.equal(query.get('limit'), '25');
  });

  it('omits the cursor on the first page', async () => {
    const { calls, catalog } = recordingCatalog(() => ({ data: [], pagination: { limit: 25 } }));

    const page = await catalog.listComputerAudit({ computerId: 'cmp-1', limit: 25 });

    assert.equal(page.nextPageToken, undefined);
    assert.equal(new URL(calls[0]?.url ?? '').searchParams.has('page_token'), false);
  });
});
