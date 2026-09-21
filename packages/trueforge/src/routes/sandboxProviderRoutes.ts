/**
 * Sandbox-provider admin route definitions (mounted at /api/v1/settings/sandbox-providers).
 * Discovery catalog lives at GET /api/v1/catalogs/sandbox-providers.
 * Handlers are registered in apis/sandboxProviders.ts.
 */
import { createRoute } from '@hono/zod-openapi';
import { RequestErrorResponseSchema } from '../schemas/errors';
import {
  DeleteSandboxProviderResponseSchema,
  GetSandboxProviderResponseSchema,
  UpdateSandboxProviderRequestSchema,
} from '../schemas/sandboxProvider';
import { OpenApiTag } from './openapiTags';

export const getSandboxProviderRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.SANDBOXES],
  summary: 'Get the configured sandbox provider',
  description: 'The single configured sandbox provider for this tenant. `auth.api_key` is redacted.',
  'x-fern-sdk-group-name': ['settings', 'sandboxProviders'],
  'x-fern-sdk-method-name': 'get',
  responses: {
    200: {
      content: { 'application/json': { schema: GetSandboxProviderResponseSchema } },
      description: 'The configured sandbox provider.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'No sandbox provider configured.',
    },
  },
});

export const putSandboxProviderRoute = createRoute({
  method: 'put',
  path: '/',
  tags: [OpenApiTag.SANDBOXES],
  summary: 'Create or replace the sandbox provider',
  description:
    'Upserts the single sandbox provider for this tenant: creates it or replaces its entire configuration. ' +
    'For Daytona, `auth.api_key`: real value sets/rotates; redacted keeps existing (400 if none). ' +
    'The built-in provider takes no credentials and is ready at once.',
  'x-fern-sdk-group-name': ['settings', 'sandboxProviders'],
  'x-fern-sdk-method-name': 'create_or_update',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateSandboxProviderRequestSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetSandboxProviderResponseSchema } },
      description: 'The saved sandbox provider.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid request body, or redacted API key with no stored secret to keep.',
    },
    422: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'The provider type is unavailable on this server, or Daytona rejected the provided API key.',
    },
  },
});

export const deleteSandboxProviderRoute = createRoute({
  method: 'delete',
  path: '/',
  tags: [OpenApiTag.SANDBOXES],
  summary: 'Remove the sandbox provider',
  description: 'Removes the configured sandbox provider for this tenant. Sandbox features then report unavailable.',
  'x-fern-sdk-group-name': ['settings', 'sandboxProviders'],
  'x-fern-sdk-method-name': 'delete',
  responses: {
    200: {
      content: { 'application/json': { schema: DeleteSandboxProviderResponseSchema } },
      description: 'The sandbox provider was removed.',
    },
    404: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'No sandbox provider configured.',
    },
  },
});
