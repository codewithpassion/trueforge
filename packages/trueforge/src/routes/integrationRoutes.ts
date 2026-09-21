/**
 * Integration route definitions: admin CRUD at /api/v1/settings/integrations and the
 * channel ingress at /api/v1/integrations/{integration_id}/events.
 * Handlers are registered in apis/integrations.ts and apis/integrationEvents.ts.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  CreateIntegrationRequestSchema,
  DeleteIntegrationResponseSchema,
  GetIntegrationAppManifestResponseSchema,
  GetIntegrationResponseSchema,
  ListIntegrationsResponseSchema,
  UpdateIntegrationRequestSchema,
} from '../schemas/integration';
import { OpenApiTag } from './openapiTags';

const IntegrationIdParamsSchema = z.object({
  integration_id: z.string().min(1).describe('Immutable integration id.'),
});

export const listIntegrationsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.INTEGRATIONS],
  summary: 'List connected integrations',
  description: 'All channel integrations for this tenant. Manifest credentials are redacted.',
  'x-fern-sdk-group-name': ['settings', 'integrations'],
  'x-fern-sdk-method-name': 'list',
  responses: {
    200: {
      content: { 'application/json': { schema: ListIntegrationsResponseSchema } },
      description: 'All connected integrations.',
    },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'OIDC is configured and the request has no valid session cookie.',
    },
    403: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'OIDC is configured and the caller is authenticated but not an admin.',
    },
  },
});

export const createIntegrationRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [OpenApiTag.INTEGRATIONS],
  summary: 'Create an integration',
  description:
    'Creates a channel integration. Without credentials it stays pending until the channel app ' +
    'is installed; with them the workspace and bot ids are read from the channel.',
  'x-fern-sdk-group-name': ['settings', 'integrations'],
  'x-fern-sdk-method-name': 'create',
  request: {
    body: {
      content: { 'application/json': { schema: CreateIntegrationRequestSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: GetIntegrationResponseSchema } },
      description: 'The new integration.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body, or a redacted credential with no stored secret to keep.',
    },
    409: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'That channel account is already connected.',
    },
    422: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The channel refused the credentials; they are wrong or not a bot token.',
    },
    502: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The channel could not be reached to confirm the credentials.',
    },
  },
});

export const getIntegrationRoute = createRoute({
  method: 'get',
  path: '/{integration_id}',
  tags: [OpenApiTag.INTEGRATIONS],
  summary: 'Get a connected integration',
  description: 'One integration by immutable id. Manifest credentials are redacted.',
  'x-fern-sdk-group-name': ['settings', 'integrations'],
  'x-fern-sdk-method-name': 'get',
  request: { params: IntegrationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: GetIntegrationResponseSchema } },
      description: 'The integration.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Integration not found.',
    },
  },
});

export const putIntegrationRoute = createRoute({
  method: 'put',
  path: '/{integration_id}',
  tags: [OpenApiTag.INTEGRATIONS],
  summary: 'Replace a connected integration',
  description:
    'Replaces the whole manifest of an existing integration. Credentials: a real value sets or ' +
    'rotates and the workspace and bot ids are read from the channel; omitted or redacted keeps ' +
    'the stored secret.',
  'x-fern-sdk-group-name': ['settings', 'integrations'],
  'x-fern-sdk-method-name': 'update',
  request: {
    params: IntegrationIdParamsSchema,
    body: {
      content: { 'application/json': { schema: UpdateIntegrationRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetIntegrationResponseSchema } },
      description: 'The saved integration.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body, or a redacted credential with no stored secret to keep.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Integration not found.',
    },
    409: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'That channel account is already connected, or belongs to a different workspace.',
    },
    422: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The channel refused the credentials; they are wrong or not a bot token.',
    },
    502: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The channel could not be reached to confirm the credentials.',
    },
  },
});

export const getIntegrationAppManifestRoute = createRoute({
  method: 'get',
  path: '/{integration_id}/app-manifest',
  tags: [OpenApiTag.INTEGRATIONS],
  summary: 'Get the channel app manifest',
  description:
    'App manifest to paste into the channel, built from the bot name and this integration id. ' +
    'Create the app from it, then save the credentials it issues.',
  'x-fern-sdk-group-name': ['settings', 'integrations'],
  'x-fern-sdk-method-name': 'get_app_manifest',
  request: { params: IntegrationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: GetIntegrationAppManifestResponseSchema } },
      description: 'The app manifest and where to paste it.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Integration not found.',
    },
    500: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Server misconfiguration (e.g. PUBLIC_BASE_URL unset).',
    },
  },
});

export const deleteIntegrationRoute = createRoute({
  method: 'delete',
  path: '/{integration_id}',
  tags: [OpenApiTag.INTEGRATIONS],
  summary: 'Disconnect an integration',
  description: 'Deletes the integration by immutable id and stops its ingress. Existing sessions stay.',
  'x-fern-sdk-group-name': ['settings', 'integrations'],
  'x-fern-sdk-method-name': 'delete',
  request: { params: IntegrationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: DeleteIntegrationResponseSchema } },
      description: 'Integration disconnected.',
    },
  },
});

export const postIntegrationEventsRoute = createRoute({
  method: 'post',
  path: '/{integration_id}/events',
  tags: [OpenApiTag.INTEGRATIONS],
  summary: 'Receive a channel event',
  description:
    'Endpoint a channel posts events to. The request is authenticated by the channel signature ' +
    'in its own headers, not by a TrueForge credential.',
  // Called by the channel with its own signature, never through the generated SDK.
  'x-fern-ignore': true,
  'x-excluded': true,
  request: { params: IntegrationIdParamsSchema },
  responses: {
    200: { description: 'Event accepted, ignored as a duplicate, or answered by the channel adapter.' },
    401: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The channel signature did not verify.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Integration not found.',
    },
    409: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The integration is still pending: its credentials have not been saved.',
    },
    422: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The event cannot run: the bound agent is missing, or the turn could not start.',
    },
    501: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'No adapter is registered for this integration type.',
    },
  },
});
