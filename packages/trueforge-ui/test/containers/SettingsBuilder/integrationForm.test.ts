import { describe, expect, it } from 'vitest';

import {
  completedNotificationRules,
  EMPTY_INTEGRATION_FORM,
  emptyNotificationRule,
  parseAllowedChannels,
  parseApproverUserIds,
  toIntegrationForm,
  toUpdateIntegrationRequest,
  validateCredentials,
  validateIntegrationForm,
  type IntegrationFormDraft,
} from '@/containers/SettingsBuilder/integrationForm.js';
import type { IntegrationBase } from '@/server/types.js';

function form(overrides: Partial<IntegrationFormDraft> = {}): IntegrationFormDraft {
  return {
    botDisplayName: 'release-bot',
    defaultAgentName: 'support-bot',
    allowedChannels: 'C0GENERAL, C0RELEASES',
    allowDirectMessages: true,
    approverUserIds: 'U0ADMIN',
    notificationRules: [],
    ...overrides,
  };
}

describe('parseAllowedChannels', () => {
  it('splits on commas and whitespace and drops the blanks', () => {
    expect(parseAllowedChannels(' C0ONE,C0TWO \n C0THREE,, ')).toEqual(['C0ONE', 'C0TWO', 'C0THREE']);
  });

  it('reads an empty box as an empty allowlist', () => {
    expect(parseAllowedChannels('  ')).toEqual([]);
  });
});

describe('toIntegrationForm', () => {
  it('fills the form from an integration and never prefills a credential', () => {
    const integration: IntegrationBase = {
      id: 'int-1',
      type: 'slack',
      status: 'connected',
      botDisplayName: 'release-bot',
      defaultAgentName: 'support-bot',
      allowedChannelIds: ['C0GENERAL', 'C0RELEASES'],
      allowDirectMessages: false,
      approverUserIds: ['U0ADMIN', 'U0LEAD'],
      notificationRules: [{ scheduleName: 'nightly-report', channelId: 'C0RELEASES', outcome: 'failure' }],
      externalAccountId: 'T0TEAM',
    };

    expect(toIntegrationForm(integration)).toEqual({
      botDisplayName: 'release-bot',
      defaultAgentName: 'support-bot',
      allowedChannels: 'C0GENERAL, C0RELEASES',
      allowDirectMessages: false,
      approverUserIds: 'U0ADMIN, U0LEAD',
      notificationRules: [{ scheduleName: 'nightly-report', channelId: 'C0RELEASES', outcome: 'failure' }],
    });
  });
});

describe('validateIntegrationForm', () => {
  it('accepts a complete form', () => {
    expect(validateIntegrationForm(form())).toBeUndefined();
  });

  it('asks for a bot name first', () => {
    expect(validateIntegrationForm(EMPTY_INTEGRATION_FORM)).toBe('A bot name is required.');
  });

  it.each(['TrueForge Bot', 'Release-Bot', 'Über Bot', 'a'.repeat(35)])(
    'accepts the human-readable bot name %p',
    botDisplayName => {
      expect(validateIntegrationForm(form({ botDisplayName }))).toBeUndefined();
    },
  );

  it('refuses a bot name past Slack’s app-name limit', () => {
    expect(validateIntegrationForm(form({ botDisplayName: 'a'.repeat(36) }))).toContain('at most 35');
  });

  // The character rules belong to the server, which owns the slug; the form only checks what
  // it can without duplicating them, and surfaces the server's message for the rest.
  it.each(['???', '---', 'slackbot'])('leaves %p for the server to refuse', botDisplayName => {
    expect(validateIntegrationForm(form({ botDisplayName }))).toBeUndefined();
  });

  it('asks for an agent', () => {
    expect(validateIntegrationForm(form({ defaultAgentName: ' ' }))).toBe('An agent name is required.');
  });

  it('refuses a configuration where the bot can never answer', () => {
    expect(validateIntegrationForm(form({ allowedChannels: '', allowDirectMessages: false }))).toContain(
      'can never answer',
    );
  });

  it('accepts an empty approver list, which simply allows nobody to approve', () => {
    expect(validateIntegrationForm(form({ approverUserIds: '' }))).toBeUndefined();
  });

  it.each([
    { scheduleName: 'nightly-report', channelId: '', outcome: 'any' as const },
    { scheduleName: '', channelId: 'C0RELEASES', outcome: 'any' as const },
  ])('refuses a half-filled rule (%o)', rule => {
    expect(validateIntegrationForm(form({ notificationRules: [rule] }))).toContain('both a schedule and a channel');
  });

  it('ignores a rule row nobody has typed into yet', () => {
    expect(validateIntegrationForm(form({ notificationRules: [emptyNotificationRule()] }))).toBeUndefined();
  });
});

describe('parseApproverUserIds', () => {
  it('splits on commas and whitespace and drops the blanks', () => {
    expect(parseApproverUserIds(' U0ONE,U0TWO \n ')).toEqual(['U0ONE', 'U0TWO']);
  });
});

describe('completedNotificationRules', () => {
  it('drops a row nobody typed into and trims the rest', () => {
    expect(
      completedNotificationRules([
        emptyNotificationRule(),
        { scheduleName: ' nightly-report ', channelId: ' C0RELEASES ', outcome: 'success' },
      ]),
    ).toEqual([{ scheduleName: 'nightly-report', channelId: 'C0RELEASES', outcome: 'success' }]);
  });
});

describe('validateCredentials', () => {
  it('accepts both blank, meaning keep what is stored', () => {
    expect(validateCredentials({ botToken: '', signingSecret: '' })).toBeUndefined();
  });

  it('accepts both given', () => {
    expect(validateCredentials({ botToken: 'xoxb-1', signingSecret: 's' })).toBeUndefined();
  });

  it.each([
    { botToken: 'xoxb-1', signingSecret: '' },
    { botToken: '', signingSecret: 's' },
  ])('refuses only one of the pair (%o)', input => {
    expect(validateCredentials(input)).toContain('both');
  });
});

describe('toUpdateIntegrationRequest', () => {
  it('omits auth when nothing was typed, so the server keeps what it stores', () => {
    const request = toUpdateIntegrationRequest({ id: 'int-1', form: form(), botToken: '  ', signingSecret: '' });

    expect(request).toEqual({
      id: 'int-1',
      botDisplayName: 'release-bot',
      defaultAgentName: 'support-bot',
      allowedChannelIds: ['C0GENERAL', 'C0RELEASES'],
      allowDirectMessages: true,
      approverUserIds: ['U0ADMIN'],
      notificationRules: [],
    });
    expect('auth' in request).toBe(false);
  });

  it('sends the pair when both were typed, trimmed', () => {
    const request = toUpdateIntegrationRequest({
      id: 'int-1',
      form: form(),
      botToken: ' xoxb-1 ',
      signingSecret: ' secret ',
    });

    expect(request.auth).toEqual({ botToken: 'xoxb-1', signingSecret: 'secret' });
  });

  it('never sends a workspace or bot user id: the server reads those from Slack', () => {
    const request = toUpdateIntegrationRequest({
      id: 'int-1',
      form: form(),
      botToken: 'xoxb-1',
      signingSecret: 'secret',
    });

    expect(Object.keys(request).sort()).toEqual([
      'allowDirectMessages',
      'allowedChannelIds',
      'approverUserIds',
      'auth',
      'botDisplayName',
      'defaultAgentName',
      'id',
      'notificationRules',
    ]);
  });

  it('sends the rules a person completed and leaves the blank row behind', () => {
    const request = toUpdateIntegrationRequest({
      id: 'int-1',
      form: form({
        notificationRules: [
          { scheduleName: 'nightly-report', channelId: 'C0RELEASES', outcome: 'failure' },
          emptyNotificationRule(),
        ],
      }),
      botToken: '',
      signingSecret: '',
    });

    expect(request.notificationRules).toEqual([
      { scheduleName: 'nightly-report', channelId: 'C0RELEASES', outcome: 'failure' },
    ]);
  });
});
