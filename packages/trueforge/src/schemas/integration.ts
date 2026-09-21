/**
 * Integration domain + wire schemas: the persisted `integration.manifest` jsonb
 * document and the settings OpenAPI request/response shapes.
 */
import { z } from '@hono/zod-openapi';
import { CreatedBySubjectSchema } from '@truefoundry/trueforge-core/agent-session';
import { NameSchema } from './common';

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

/**
 * Bot name, used for both the Slack app name and the bot user's display name. Slack caps the
 * app name at 35 characters and restricts the bot display name to `a-z 0-9 . _ -`, so one
 * value that satisfies both is narrower than either.
 */
export const SlackBotDisplayNameSchema = z
  .string()
  .regex(/^[a-z0-9._-]{1,35}$/)
  .describe('Bot name in Slack: 1-35 characters, lowercase letters, digits, dot, dash or underscore.')
  .openapi('SlackBotDisplayName');

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
    bot_display_name: SlackBotDisplayNameSchema.default('trueforge'),
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
    default_agent_name: NameSchema,
    allowed_channel_ids: z
      .array(z.string().min(1))
      .describe('Channels the bot answers in. An empty list allows no channel.'),
    allow_direct_messages: z.boolean().describe('Whether direct messages to the bot are answered.'),
    reply_mode: SlackReplyModeSchema,
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

export const CreateIntegrationRequestSchema = z
  .object({
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
    manifest_json: z.string().describe('App manifest as pretty-printed JSON, ready to paste.'),
    create_app_url: z.string().describe('Page on the channel that accepts the manifest.'),
  })
  .strict()
  .openapi('IntegrationAppManifest');

export const GetIntegrationAppManifestResponseSchema = z
  .object({ data: IntegrationAppManifestSchema })
  .openapi('GetIntegrationAppManifestResponse');

export const GetIntegrationResponseSchema = z.object({ data: IntegrationSchema }).openapi('GetIntegrationResponse');

export const ListIntegrationsResponseSchema = z
  .object({ data: z.array(IntegrationSchema) })
  .openapi('ListIntegrationsResponse');

export const DeleteIntegrationResponseSchema = z.object({}).openapi('DeleteIntegrationResponse');

export type IntegrationType = z.infer<typeof IntegrationTypeSchema>;
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
 * `(tenant_id, type, external_account_id)` uniqueness of an integration.
 *
 * A pending integration has no channel account yet, so it stands on its own id: the column is
 * `NOT NULL` and two pending integrations must not collide with each other.
 */
export function integrationExternalAccountId(input: { manifest: IntegrationManifest; integration_id: string }): string {
  return input.manifest.team_id ?? `pending:${input.integration_id}`;
}
