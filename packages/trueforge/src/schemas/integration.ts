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

/**
 * Slack workspace connection, persisted as `integration.manifest`.
 * `allowed_channel_ids` is an allowlist: an empty list allows no channel.
 */
export const SlackIntegrationManifestSchema = z
  .object({
    type: z.literal(IntegrationTypeSchema.enum.slack).describe('Slack workspace connection.'),
    team_id: z.string().min(1).describe('Slack workspace (team) id this integration is bound to.'),
    bot_user_id: z.string().min(1).describe('User id of the bot, used to ignore its own messages.'),
    default_agent_name: NameSchema,
    allowed_channel_ids: z
      .array(z.string().min(1))
      .describe('Channels the bot answers in. An empty list allows no channel.'),
    allow_direct_messages: z.boolean().describe('Whether direct messages to the bot are answered.'),
    reply_mode: SlackReplyModeSchema,
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

export const GetIntegrationResponseSchema = z.object({ data: IntegrationSchema }).openapi('GetIntegrationResponse');

export const ListIntegrationsResponseSchema = z
  .object({ data: z.array(IntegrationSchema) })
  .openapi('ListIntegrationsResponse');

export const DeleteIntegrationResponseSchema = z.object({}).openapi('DeleteIntegrationResponse');

export type IntegrationType = z.infer<typeof IntegrationTypeSchema>;
export type SlackIntegrationAuth = z.infer<typeof SlackIntegrationAuthSchema>;
export type SlackReplyMode = z.infer<typeof SlackReplyModeSchema>;
export type SlackIntegrationManifest = z.infer<typeof SlackIntegrationManifestSchema>;
export type IntegrationManifest = z.infer<typeof IntegrationManifestSchema>;
export type Integration = z.infer<typeof IntegrationSchema>;
export type CreateIntegrationRequest = z.infer<typeof CreateIntegrationRequestSchema>;
export type UpdateIntegrationRequest = z.infer<typeof UpdateIntegrationRequestSchema>;

/**
 * Channel-side account a manifest is bound to, used for the
 * `(tenant_id, type, external_account_id)` uniqueness of an integration.
 */
export function integrationExternalAccountId(manifest: IntegrationManifest): string {
  return manifest.team_id;
}
