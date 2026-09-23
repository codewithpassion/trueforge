import { AgentSpecSchema, type CreatedBySubject } from '@truefoundry/trueforge-core/agent-session';
import { runInDurableObject } from 'cloudflare:test';
import type { IntegrationManifest } from '../../src/schemas/integration';
import { d1Persistence, migrateDatabase, sessionStub, TENANT_ID, upsertMockProvider, USER_REF } from './harness';

/**
 * Every `chat.postMessage` body the real Slack adapter sent, from inside the Durable Object.
 * The registry is mocked because the pool's `outboundService` refuses anything but the mock
 * model; the adapter behind it is the real one, driven by this fetch.
 */
const posted = vi.hoisted((): Record<string, unknown>[] => []);

vi.mock('../../src/integrations/registry', async () => {
  const { SlackChannelAdapter: RealAdapter } = await import('../../src/integrations/slack/SlackChannelAdapter');
  const fetchImpl: typeof fetch = (_input, init) => {
    posted.push(JSON.parse(String(init?.body)));
    return Promise.resolve(Response.json({ ok: true }));
  };
  return { createIntegrationAdapters: () => new Map([['slack', new RealAdapter({ fetchImpl })]]) };
});

const CREATED_BY: CreatedBySubject = {
  subject_id: USER_REF,
  subject_type: 'user',
  subject_display_name: USER_REF,
};

const SCHEDULE_NAME = 'nightly-report';
const CHANNEL_ID = 'C0RELEASES';

function manifest(scheduleName: string): IntegrationManifest {
  return {
    type: 'slack',
    bot_display_name: 'trueforge',
    team_id: 'T0TEAM',
    bot_user_id: 'U0BOT',
    allowed_channel_ids: [],
    allow_direct_messages: false,
    reply_mode: 'thread',
    approver_slack_user_ids: [],
    notification_rules: [{ schedule_name: scheduleName, channel_id: CHANNEL_ID, outcome: 'any' }],
    auth: { bot_token: 'xoxb-test', signing_secret: 'sigsecret' },
  };
}

/**
 * A schedule, a connected integration carrying a rule, and the run's own session. Every case
 * binds its integration to its own agent, so a rule left behind by an earlier case in this shared
 * D1 database cannot match this one's run. `ruleOnOtherAgent` binds the integration to a second
 * agent instead of the schedule's.
 */
async function createScheduleRun(input: {
  sessionId: string;
  scenario: string;
  scheduleName: string;
  ruleScheduleName?: string;
  ruleOnOtherAgent?: boolean;
}) {
  const stores = d1Persistence();
  const providerName = await upsertMockProvider({ stores, scenario: input.scenario });
  const agent = await stores.agentStore.createAgent({
    tenant_id: TENANT_ID,
    name: `agent-${input.sessionId}`,
    description: 'schedule owner',
    manifest: AgentSpecSchema.parse({ model: { name: `${providerName}/mock-model` }, instructions: 'test' }),
    external_id: null,
    created_by_subject: CREATED_BY,
  });
  const { schedule } = await stores.scheduleStore.createScheduleAndRun({
    tenant_id: TENANT_ID,
    agent_id: agent.id,
    agent_name: agent.name,
    name: input.scheduleName,
    manifest: { task: 'report on the deploys', cron: '0 0 * * *', timezone: 'UTC', status: 'active' },
    created_by_subject: CREATED_BY,
    runFrom: new Date(),
  });
  const ruleAgent =
    input.ruleOnOtherAgent === true
      ? await stores.agentStore.createAgent({
          tenant_id: TENANT_ID,
          name: `other-${input.sessionId}`,
          description: 'another agent with a same-named schedule',
          manifest: AgentSpecSchema.parse({ model: { name: `${providerName}/mock-model` }, instructions: 'test' }),
          external_id: null,
          created_by_subject: CREATED_BY,
        })
      : agent;
  await stores.integrationStore.createIntegration({
    id: `int-${input.sessionId}`,
    tenant_id: TENANT_ID,
    agent_id: ruleAgent.id,
    agent_name: ruleAgent.name,
    type: 'slack',
    external_account_id: `T-${input.sessionId}`,
    manifest: manifest(input.ruleScheduleName ?? input.scheduleName),
    created_by_subject: CREATED_BY,
  });
  // A schedule run's session is keyed by the run id, not by any channel.
  await stores.sessionStore.createSession({
    tenant_id: TENANT_ID,
    session_id: input.sessionId,
    created_by_subject: CREATED_BY,
    agent: {
      type: 'inline',
      spec: AgentSpecSchema.parse({ model: { name: `${providerName}/mock-model` }, instructions: 'test' }),
    },
    custom: null,
    metadata: {},
    external_id: input.sessionId,
    source: { type: 'schedule', id: schedule.id, run_id: `run-${input.sessionId}` },
  });
  return { stores, scheduleId: schedule.id };
}

beforeAll(async () => {
  await migrateDatabase();
});

beforeEach(() => {
  posted.length = 0;
});

describe('notification rules inside SessionDO', () => {
  it('enqueues and posts a finished schedule run to the rule’s channel, inside the alarm', async () => {
    const sessionId = 'schedule-notify';
    const { stores } = await createScheduleRun({ sessionId, scenario: 'text', scheduleName: SCHEDULE_NAME });
    const stub = sessionStub(sessionId);

    const started = await stub.startTurn({
      tenant_id: TENANT_ID,
      session_id: sessionId,
      input: [{ type: 'user.message', content: 'report on the deploys' }],
      previous_turn_id: undefined,
      user_ref: USER_REF,
    });
    if (!started.ok) {
      throw new Error(`startTurn failed: ${started.code} ${started.message}`);
    }

    // The alarm holds the turn until its drain settles, so the rule runs before this returns.
    await runInDurableObject(stub, instance => instance.alarm());

    expect(posted).toHaveLength(1);
    // A rule posts at the top of the channel, so there is no thread to reply into.
    expect(posted[0]).toMatchObject({ channel: CHANNEL_ID });
    expect(posted[0]).not.toHaveProperty('thread_ts');

    const rows = await d1Persistence().integrationStore.listRetryableDeliveries({
      before: new Date(Date.now() + 60_000),
      limit: 10,
    });
    expect(rows).toEqual([]);
    const delivery = await stores.integrationStore.getPendingDelivery({
      integration_id: `int-${sessionId}`,
      turn_id: started.turn.id,
      conversation_key: `slack:T0TEAM:${CHANNEL_ID}:channel`,
    });
    expect(delivery).toBeUndefined();
  });

  it('posts nothing for a schedule no rule names', async () => {
    const sessionId = 'schedule-notify-unmatched';
    await createScheduleRun({
      sessionId,
      scenario: 'text',
      scheduleName: 'weekly-digest',
      ruleScheduleName: 'some-other-schedule',
    });
    const stub = sessionStub(sessionId);

    const started = await stub.startTurn({
      tenant_id: TENANT_ID,
      session_id: sessionId,
      input: [{ type: 'user.message', content: 'report' }],
      previous_turn_id: undefined,
      user_ref: USER_REF,
    });
    if (!started.ok) {
      throw new Error(`startTurn failed: ${started.code} ${started.message}`);
    }
    await runInDurableObject(stub, instance => instance.alarm());

    expect(posted).toHaveLength(0);
  });

  it("does not fire another agent's rule for a schedule of the same name", async () => {
    const sessionId = 'schedule-notify-other-agent';
    await createScheduleRun({ sessionId, scenario: 'text', scheduleName: 'daily', ruleOnOtherAgent: true });
    const stub = sessionStub(sessionId);

    const started = await stub.startTurn({
      tenant_id: TENANT_ID,
      session_id: sessionId,
      input: [{ type: 'user.message', content: 'report' }],
      previous_turn_id: undefined,
      user_ref: USER_REF,
    });
    if (!started.ok) {
      throw new Error(`startTurn failed: ${started.code} ${started.message}`);
    }
    await runInDurableObject(stub, instance => instance.alarm());

    expect(posted).toHaveLength(0);
  });
});
