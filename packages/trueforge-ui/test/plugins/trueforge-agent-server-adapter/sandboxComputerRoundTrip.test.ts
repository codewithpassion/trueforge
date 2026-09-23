/**
 * `sandbox.computerId` crosses two renames on its way to the server and back, so the UI's camelCase
 * and the wire's `computer_id` are checked together rather than one at a time.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { createHarnessBuilderServer } from '@/plugins/trueforge-agent-server-adapter/builderServer.js';
import { toUiAgentSpec } from '@/plugins/trueforge-agent-server-adapter/chatServer.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The `sandbox` object as it was actually written to the request body. */
function sentSandbox(body: unknown): Record<string, unknown> {
  assert.ok(isRecord(body), 'request had no JSON body');
  const manifest = body.manifest;
  assert.ok(isRecord(manifest), 'request body carried no manifest');
  const config = manifest.config;
  assert.ok(isRecord(config), 'manifest carried no config');
  const sandbox = config.sandbox;
  assert.ok(isRecord(sandbox), 'config carried no sandbox');
  return sandbox;
}

function recordingBuilder() {
  const bodies: unknown[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const raw = init?.body;
    if (typeof raw === 'string') bodies.push(JSON.parse(raw));
    if (new URL(url).pathname.endsWith('/api/v1/agents') && (init?.method ?? 'GET') === 'GET') {
      return Response.json({ data: [], pagination: { limit: 50, total: 0 } });
    }
    return Response.json({ data: { id: 'agent-1' } });
  };
  return { bodies, builder: createHarnessBuilderServer({ fetch: fetchMock }) };
}

describe('sandbox.computerId on the wire', () => {
  it('reaches the server as config.sandbox.computer_id', async () => {
    const { bodies, builder } = recordingBuilder();

    await builder.saveAgent({
      agentName: 'release-bot',
      description: 'runs the release',
      agentSpec: {
        model: { name: 'openai-main/gpt-4.1' },
        config: { sandbox: { enabled: true, fileDownloads: true, computerId: 'cmp-1' } },
      },
      intent: 'create',
    });

    const sandbox = sentSandbox(bodies.at(-1));
    assert.equal(sandbox.computer_id, 'cmp-1');
    assert.equal(sandbox.file_downloads, true);
    assert.equal('computerId' in sandbox, false);
  });

  it('omits the key entirely for the tenant sandbox — not null, not an empty string', async () => {
    const { bodies, builder } = recordingBuilder();

    await builder.saveAgent({
      agentName: 'release-bot',
      description: 'runs the release',
      agentSpec: {
        model: { name: 'openai-main/gpt-4.1' },
        config: { sandbox: { enabled: true, fileDownloads: true } },
      },
      intent: 'create',
    });

    const sandbox = sentSandbox(bodies.at(-1));
    assert.equal('computer_id' in sandbox, false);
    assert.equal(sandbox.enabled, true);
  });

  it('comes back from the server as computerId, so the picker sees what was saved', () => {
    const reloaded = toUiAgentSpec({
      model: { name: 'openai-main/gpt-4.1' },
      config: { sandbox: { enabled: true, fileDownloads: true, computerId: 'cmp-1' } },
    });

    assert.equal(reloaded.config?.sandbox?.computerId, 'cmp-1');
  });
});

describe('sandbox.desktop on the wire', () => {
  it('survives a save, so editing a desktop agent in the builder keeps its desktop', async () => {
    const { bodies, builder } = recordingBuilder();

    await builder.saveAgent({
      agentName: 'release-bot',
      description: 'runs the release',
      agentSpec: {
        model: { name: 'openai-main/gpt-4.1' },
        config: { sandbox: { enabled: true, computerId: 'cmp-1', desktop: true } },
      },
      intent: 'create',
    });

    assert.equal(sentSandbox(bodies.at(-1)).desktop, true);
  });

  it('comes back from the server', () => {
    const reloaded = toUiAgentSpec({
      model: { name: 'openai-main/gpt-4.1' },
      config: { sandbox: { enabled: true, computerId: 'cmp-1', desktop: true } },
    });

    assert.equal(reloaded.config?.sandbox?.desktop, true);
  });
});
