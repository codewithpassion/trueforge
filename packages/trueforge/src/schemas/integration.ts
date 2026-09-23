/**
 * Integration domain + wire schemas: the persisted `integration.manifest` jsonb
 * document and the OpenAPI request/response shapes.
 */
import { z } from '@hono/zod-openapi';
import { CreatedBySubjectSchema } from '@truefoundry/trueforge-core/agent-session';
import { NameSchema, parseCommaSeparatedQuery } from './common';

/** Channel types the integrations layer knows about. */
export const IntegrationTypeSchema = z.enum(['slack']).describe('Channel type.').openapi('IntegrationType');

export const SlackIntegrationAuthSchema = z
  .object({
    bot_token: z
      .string()
      .min(1)
      .describe(
        'Slack bot user OAuth token. Responses are redacted; on PUT, a real value sets/rotates and a redacted value keeps the stored token.',
      ),
    signing_secret: z
      .string()
      .min(1)
      .describe(
        'Slack app signing secret used to verify request signatures. Responses are redacted; on PUT, a real value sets/rotates and a redacted value keeps the stored secret.',
      ),
  })
  .strict()
  .describe('Slack app credentials.')
  .openapi('SlackIntegrationAuth');

/** Where a reply to an inbound message is posted. */
export const SlackReplyModeSchema = z.enum(['thread']).describe('Where replies are posted.').openapi('SlackReplyMode');

/** Whether the channel app has been installed and its credentials saved. */
export const IntegrationStatusSchema = z
  .enum(['pending', 'connected'])
  .describe('`pending` until the channel app is installed and its credentials are saved.')
  .openapi('IntegrationStatus');

/** Slack's cap on `features.bot_user.display_name`. */
const SLACK_BOT_USER_DISPLAY_NAME_MAX = 80;
/** Slack's cap on `display_information.name`. */
const SLACK_APP_NAME_MAX = 35;

/**
 * Latin letters that carry no combining mark, so `NFKD` leaves them whole. Without these,
 * "Bøt" would slug to `b-t` and "Straße" to `stra-e`.
 */
const LATIN_FOLDING: Record<string, string> = {
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ł: 'l',
  ħ: 'h',
  ı: 'i',
  ŋ: 'n',
};

/**
 * Slack's bot user display name allows only `a-z 0-9 . _ -`, while the app name it sits under
 * is free text. Rather than make people type the restricted form, the app name is what they
 * choose and the bot display name is derived from it here — the one place that owns the rule.
 */
export function slackBotUserDisplayName(appName: string): string {
  const folded = appName
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[øæœßđðþłħıŋ]/g, character => LATIN_FOLDING[character] ?? character);
  return folded
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, SLACK_BOT_USER_DISPLAY_NAME_MAX);
}

/**
 * The name a person chooses for the bot. It becomes Slack's app name as typed, and the bot
 * user's display name once slugged — so a name that leaves no letter or digit behind is
 * refused here rather than by Slack.
 */
export const SlackBotDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(SLACK_APP_NAME_MAX)
  .refine(value => /[a-z0-9]/.test(slackBotUserDisplayName(value)), {
    message: 'The bot name must contain a letter or a digit.',
  })
  // Slack reserves its own name, so an app called "slackbot" or "Slack helper" is refused on
  // creation; catching it here costs one round trip less.
  .refine(value => !/slack/i.test(value), {
    message: 'Slack does not allow "slack" in an app name.',
  })
  .describe('Bot name in Slack, up to 35 characters. The bot user display name is derived from it.')
  .openapi('SlackBotDisplayName');

/** Which finished schedule runs a notification rule posts. */
export const IntegrationNotificationOutcomeSchema = z
  .enum(['any', 'success', 'failure'])
  .describe('Which schedule outcomes the rule posts: any, only successes, or only failures.')
  .openapi('IntegrationNotificationOutcome');

/**
 * "Post the result of schedule `<name>` to channel `<id>`". The outcome filter is a required
 * choice rather than an optional flag, so a rule can never be half-specified.
 *
 * The channel is a posting target, not a listening one: it is deliberately separate from
 * `allowed_channel_ids`, which says where the bot answers.
 */
export const IntegrationNotificationRuleSchema = z
  .object({
    schedule_name: NameSchema,
    channel_id: z.string().min(1).describe('Channel the result is posted to. The bot must be a member of it.'),
    outcome: IntegrationNotificationOutcomeSchema,
  })
  .strict()
  .describe('Posts a finished schedule run to a channel.')
  .openapi('IntegrationNotificationRule');

/**
 * Slack workspace connection, persisted as `integration.manifest`.
 * `allowed_channel_ids` is an allowlist: an empty list allows no channel.
 *
 * `team_id`, `bot_user_id` and `auth` only exist once the Slack app is installed: the app is
 * created from a manifest this integration generates, so the integration comes first.
 */
export const SlackIntegrationManifestSchema = z
  .object({
    type: z.literal(IntegrationTypeSchema.enum.slack).describe('Slack workspace connection.'),
    bot_display_name: SlackBotDisplayNameSchema.default('TrueForge'),
    team_id: z
      .string()
      .min(1)
      .optional()
      .describe('Slack workspace (team) id. Filled from `auth.test` when credentials are saved.'),
    bot_user_id: z
      .string()
      .min(1)
      .optional()
      .describe('User id of the bot, used to ignore its own messages. Filled from `auth.test`.'),
    allowed_channel_ids: z
      .array(z.string().min(1))
      .describe('Channels the bot answers in. An empty list allows no channel.'),
    allow_direct_messages: z.boolean().describe('Whether direct messages to the bot are answered.'),
    reply_mode: SlackReplyModeSchema,
    approver_slack_user_ids: z
      .array(z.string().min(1))
      .default([])
      .describe('Slack users who may approve or deny a tool call. An empty list allows nobody.'),
    notification_rules: z
      .array(IntegrationNotificationRuleSchema)
      .default([])
      .describe('Schedule results posted to a channel, independent of the allowed channels.'),
    auth: SlackIntegrationAuthSchema.optional(),
  })
  .strict();

/**
 * The same manifest once the Slack app exists. Ingress and delivery only ever run against
 * this shape; `connectedSlackManifest` is the one way to obtain it.
 */
const ConnectedSlackIntegrationManifestSchema = z
  .object({
    ...SlackIntegrationManifestSchema.shape,
    team_id: z.string().min(1),
    bot_user_id: z.string().min(1),
    auth: SlackIntegrationAuthSchema,
  })
  .strict();

/**
 * Persisted integration document. Slack is the only channel today, so this names the
 * Slack object directly; it becomes `z.discriminatedUnion('type', …)` when a second
 * channel lands (a one-member `oneOf` is not allowed on the wire).
 */
export const IntegrationManifestSchema = SlackIntegrationManifestSchema.describe(
  'Channel connection document. Credentials are redacted on read.',
).openapi('IntegrationManifest');

/** List/get/create/update response item. */
export const IntegrationSchema = z
  .object({
    id: z.string().describe('Immutable integration id.'),
    agent_name: NameSchema,
    type: IntegrationTypeSchema,
    status: IntegrationStatusSchema,
    external_account_id: z.string().describe('Channel-side account this integration is bound to.'),
    manifest: IntegrationManifestSchema,
    created_by_subject: CreatedBySubjectSchema,
    created_at: z.string().describe('ISO 8601 creation timestamp.'),
    updated_at: z.string().describe('ISO 8601 last-update timestamp.'),
  })
  .strict()
  .openapi('Integration');

/** The agent binding is fixed at create: the channel app is named for it and its threads map to its sessions. */
export const CreateIntegrationRequestSchema = z
  .object({
    agent_name: NameSchema,
    manifest: IntegrationManifestSchema,
  })
  .strict()
  .openapi('CreateIntegrationRequest');

export const UpdateIntegrationRequestSchema = z
  .object({
    manifest: IntegrationManifestSchema,
  })
  .strict()
  .openapi('UpdateIntegrationRequest');

/** Everything needed to create the channel's app: the document to paste and where to paste it. */
export const IntegrationAppManifestSchema = z
  .object({
    request_url: z.string().describe('Events request URL the manifest carries.'),
    interactions_request_url: z.string().describe('Interactivity request URL the manifest carries.'),
    manifest_json: z.string().describe('App manifest as pretty-printed JSON, ready to paste.'),
    create_app_url: z.string().describe('Page on the channel that accepts the manifest.'),
  })
  .strict()
  .openapi('IntegrationAppManifest');

export const GetIntegrationAppManifestResponseSchema = z
  .object({ data: IntegrationAppManifestSchema })
  .openapi('GetIntegrationAppManifestResponse');

/** What a tool approval was settled as. Answering a question is not recorded: anyone in the
 * conversation may do it, so it identifies nobody. */
export const IntegrationDecisionOutcomeSchema = z
  .enum(['allow', 'deny'])
  .describe('Whether the tool call was allowed or denied.')
  .openapi('IntegrationDecisionOutcome');

/** One tool approval settled from the channel. Read-only: nothing but the channel writes these. */
export const IntegrationDecisionSchema = z
  .object({
    id: z.string().describe('Immutable decision id.'),
    turn_id: z.string().describe('Turn the decision settled.'),
    session_id: z.string().describe('Session that held the turn.'),
    decided_by_id: z.string().describe('Channel-side user id of whoever decided.'),
    decided_by_display_name: z.string().describe('Channel-side display name at the time.'),
    decision: IntegrationDecisionOutcomeSchema,
    decided_at: z.string().describe('ISO 8601 time the decision was recorded.'),
  })
  .strict()
  .openapi('IntegrationDecision');

export const ListIntegrationDecisionsResponseSchema = z
  .object({ data: z.array(IntegrationDecisionSchema) })
  .openapi('ListIntegrationDecisionsResponse');

export const GetIntegrationResponseSchema = z.object({ data: IntegrationSchema }).openapi('GetIntegrationResponse');

export const ListIntegrationsQuerySchema = z
  .object({
    // comma-separated string -> array of names
    agent_names: z
      .string()
      .optional()
      .openapi({
        type: 'string',
        description: 'Filter by one or more agent names (comma-separated). When set, at least one name is required.',
      })
      .transform(value => parseCommaSeparatedQuery(value))
      .pipe(z.array(NameSchema).min(1).optional()),
  })
  .openapi('ListIntegrationsQuery');

export const ListIntegrationsResponseSchema = z
  .object({ data: z.array(IntegrationSchema) })
  .openapi('ListIntegrationsResponse');

export const DeleteIntegrationResponseSchema = z.object({}).openapi('DeleteIntegrationResponse');

export type IntegrationType = z.infer<typeof IntegrationTypeSchema>;
export type IntegrationNotificationOutcome = z.infer<typeof IntegrationNotificationOutcomeSchema>;
export type IntegrationDecision = z.infer<typeof IntegrationDecisionSchema>;
export type IntegrationNotificationRule = z.infer<typeof IntegrationNotificationRuleSchema>;
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;
export type SlackIntegrationAuth = z.infer<typeof SlackIntegrationAuthSchema>;
export type SlackReplyMode = z.infer<typeof SlackReplyModeSchema>;
export type SlackIntegrationManifest = z.infer<typeof SlackIntegrationManifestSchema>;
export type ConnectedSlackIntegrationManifest = z.infer<typeof ConnectedSlackIntegrationManifestSchema>;
export type IntegrationManifest = z.infer<typeof IntegrationManifestSchema>;
export type IntegrationAppManifest = z.infer<typeof IntegrationAppManifestSchema>;
export type Integration = z.infer<typeof IntegrationSchema>;
export type CreateIntegrationRequest = z.infer<typeof CreateIntegrationRequestSchema>;
export type UpdateIntegrationRequest = z.infer<typeof UpdateIntegrationRequestSchema>;

/** The manifest narrowed to an installed app, or undefined while the integration is pending. */
export function connectedSlackManifest(manifest: IntegrationManifest): ConnectedSlackIntegrationManifest | undefined {
  const parsed = ConnectedSlackIntegrationManifestSchema.safeParse(manifest);
  return parsed.success ? parsed.data : undefined;
}

export function integrationStatus(manifest: IntegrationManifest): IntegrationStatus {
  return connectedSlackManifest(manifest) === undefined
    ? IntegrationStatusSchema.enum.pending
    : IntegrationStatusSchema.enum.connected;
}

/**
 * Channel-side account a manifest is bound to, used for the
 * `(tenant_id, type, external_account_id, agent_id)` uniqueness of an integration.
 *
 * A pending integration has no channel account yet, so it stands on its own id: the column is
 * `NOT NULL` and two pending integrations must not collide with each other.
 */
export function integrationExternalAccountId(input: { manifest: IntegrationManifest; integration_id: string }): string {
  return input.manifest.team_id ?? `pending:${input.integration_id}`;
}
