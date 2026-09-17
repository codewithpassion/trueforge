import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EMPTY_SLACK_FORM,
  parseAllowedChannels,
  slackRequestUrl,
  toSlackForm,
  toSlackManifest,
  validateSlackForm,
  type SlackIntegrationForm,
} from '../src/slackIntegration';

const REDACTED_TOKEN = 'xox-***REDACTED***-abc';
const REDACTED_SECRET = 'sig-***REDACTED***-xyz';

function connected(overrides: Partial<TrueForgeApi.Integration> = {}): TrueForgeApi.Integration {
  return {
    id: 'int-1',
    type: 'slack',
    externalAccountId: 'T0TEAM',
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
    createdBySubject: { subjectId: 'admin-1', subjectType: 'user', subjectDisplayName: 'Admin One' },
    manifest: {
      type: 'slack',
      teamId: 'T0TEAM',
      botUserId: 'U0BOT',
      defaultAgentName: 'support-bot',
      allowedChannelIds: ['C0GENERAL'],
      allowDirectMessages: true,
      replyMode: 'thread',
      auth: { botToken: REDACTED_TOKEN, signingSecret: REDACTED_SECRET },
    },
    ...overrides,
  };
}

function filled(overrides: Partial<SlackIntegrationForm> = {}): SlackIntegrationForm {
  return {
    ...EMPTY_SLACK_FORM,
    teamId: 'T0TEAM',
    botUserId: 'U0BOT',
    defaultAgentName: 'support-bot',
    allowedChannels: 'C0GENERAL',
    botToken: 'xoxb-real',
    signingSecret: 'real-secret',
    ...overrides,
  };
}

describe('parseAllowedChannels', () => {
  it('splits on commas and whitespace and drops the gaps', () => {
    assert.deepEqual(parseAllowedChannels(' C0ONE,C0TWO \n C0THREE '), ['C0ONE', 'C0TWO', 'C0THREE']);
    assert.deepEqual(parseAllowedChannels('  '), []);
  });
});

describe('toSlackForm', () => {
  it('never prefills a secret, because the stored one comes back redacted', () => {
    const form = toSlackForm(connected());
    assert.equal(form.botToken, '');
    assert.equal(form.signingSecret, '');
    assert.equal(form.teamId, 'T0TEAM');
    assert.equal(form.allowedChannels, 'C0GENERAL');
  });
});

describe('validateSlackForm', () => {
  it('names the first field a human still has to fill', () => {
    assert.match(validateSlackForm({ form: EMPTY_SLACK_FORM }) ?? '', /Workspace \(team\) id is required/);
    assert.match(validateSlackForm({ form: filled({ botUserId: '' }) }) ?? '', /Bot user id is required/);
    assert.match(validateSlackForm({ form: filled({ defaultAgentName: ' ' }) }) ?? '', /Agent name is required/);
  });

  it('requires real credentials to connect a workspace for the first time', () => {
    assert.match(
      validateSlackForm({ form: filled({ botToken: '', signingSecret: '' }) }) ?? '',
      /bot token and a signing secret are required/,
    );
  });

  it('accepts blank credentials on an edit, because the stored ones are kept', () => {
    const form = filled({ botToken: '', signingSecret: '' });
    assert.equal(validateSlackForm({ form, existing: connected() }), undefined);
  });

  it('refuses to move to another workspace without new credentials', () => {
    // The stored token belongs to the old workspace and would never authenticate.
    const form = filled({ teamId: 'T0OTHER', botToken: '', signingSecret: '' });
    assert.match(validateSlackForm({ form, existing: connected() }) ?? '', /Changing the workspace needs/);
  });

  it('allows the move when both credentials are given', () => {
    assert.equal(validateSlackForm({ form: filled({ teamId: 'T0OTHER' }), existing: connected() }), undefined);
  });

  it('refuses a connection that could never answer anywhere', () => {
    const form = filled({ allowedChannels: '', allowDirectMessages: false });
    assert.match(validateSlackForm({ form }) ?? '', /Allow direct messages, or list at least one channel/);
  });
});

describe('toSlackManifest', () => {
  it('sends what was typed when connecting', () => {
    assert.deepEqual(toSlackManifest({ form: filled({ allowedChannels: 'C0ONE, C0TWO' }) }), {
      type: 'slack',
      teamId: 'T0TEAM',
      botUserId: 'U0BOT',
      defaultAgentName: 'support-bot',
      allowedChannelIds: ['C0ONE', 'C0TWO'],
      allowDirectMessages: true,
      replyMode: 'thread',
      auth: { botToken: 'xoxb-real', signingSecret: 'real-secret' },
    });
  });

  it('echoes the redacted stand-in for a secret left blank, which keeps the stored one', () => {
    const manifest = toSlackManifest({
      form: filled({ botToken: '', signingSecret: '' }),
      existing: connected(),
    });
    assert.deepEqual(manifest.auth, { botToken: REDACTED_TOKEN, signingSecret: REDACTED_SECRET });
  });

  it('rotates only the credential that was retyped', () => {
    const manifest = toSlackManifest({
      form: filled({ botToken: 'xoxb-rotated', signingSecret: '' }),
      existing: connected(),
    });
    assert.deepEqual(manifest.auth, { botToken: 'xoxb-rotated', signingSecret: REDACTED_SECRET });
  });

  it('refuses to invent a credential when there is nothing stored', () => {
    assert.throws(
      () => toSlackManifest({ form: filled({ botToken: '' }) }),
      /bot token and a signing secret are required/,
    );
  });
});

describe('slackRequestUrl', () => {
  it('builds the url the Slack app subscribes to', () => {
    assert.equal(
      slackRequestUrl({ integrationId: 'int-1', origin: 'https://forge.example', basePath: '/' }),
      'https://forge.example/api/v1/integrations/int-1/events',
    );
  });

  it('keeps the public prefix a reverse proxy serves under', () => {
    assert.equal(
      slackRequestUrl({ integrationId: 'int-1', origin: 'https://forge.example', basePath: '/custom/path/' }),
      'https://forge.example/custom/path/api/v1/integrations/int-1/events',
    );
  });
});
