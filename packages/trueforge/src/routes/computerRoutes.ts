/**
 * Remote computer route definitions (mounted at /api/v1/computers).
 * Everything except enroll is admin-only; enroll is the machine's own unauthenticated exchange and
 * the WebSocket connect is a plain Hono route, because an upgrade is not an OpenAPI operation.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  ComputerAgentAccessSchema,
  CreateComputerEnrollmentResponseSchema,
  CreateComputerRequestSchema,
  CreateComputerResponseSchema,
  DeleteComputerResponseSchema,
  EnrollComputerRequestSchema,
  EnrollComputerResponseSchema,
  GetComputerAgentAccessResponseSchema,
  GetComputerResponseSchema,
  ListComputerAuditRequestQuerySchema,
  ListComputerAuditResponseSchema,
  ListComputersResponseSchema,
  UpdateComputerRequestSchema,
} from '../schemas/computer';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { TOKEN_PAGINATION } from './fernExtensions';
import { OpenApiTag } from './openapiTags';

const ComputerPathParamsSchema = z.object({
  computer_id: z.string().min(1).describe('Computer id.'),
});

const unauthorized = {
  content: { 'application/json': { schema: RequestErrorResponseSchema } },
  description: 'Authentication required.',
};

const forbidden = {
  content: { 'application/json': { schema: RequestErrorResponseSchema } },
  description: 'The caller is authenticated but not an admin.',
};

const notFound = {
  content: { 'application/json': { schema: RequestErrorResponseSchema } },
  description: 'No such computer, or this server does not serve remote computers.',
};

export const listComputersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [OpenApiTag.COMPUTERS],
  summary: 'List computers',
  description: 'Machines this tenant has enrolled, newest first.',
  'x-fern-sdk-group-name': ['computers'],
  'x-fern-sdk-method-name': 'list',
  responses: {
    200: { content: { 'application/json': { schema: ListComputersResponseSchema } }, description: 'The computers.' },
    401: unauthorized,
    403: forbidden,
    404: notFound,
  },
});

export const createComputerRoute = createRoute({
  method: 'post',
  path: '/',
  tags: [OpenApiTag.COMPUTERS],
  summary: 'Create a computer',
  description: 'Registers a machine and returns its single-use enrollment code with commands to run there.',
  'x-fern-sdk-group-name': ['computers'],
  'x-fern-sdk-method-name': 'create',
  request: {
    body: { content: { 'application/json': { schema: CreateComputerRequestSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: CreateComputerResponseSchema } },
      description: 'The computer and its one-time enrollment code.',
    },
    400: { content: { 'application/json': { schema: RequestErrorResponseSchema } }, description: 'Invalid body.' },
    401: unauthorized,
    403: forbidden,
    404: notFound,
    409: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'A computer with this name already exists.',
    },
  },
});

export const getComputerRoute = createRoute({
  method: 'get',
  path: '/{computer_id}',
  tags: [OpenApiTag.COMPUTERS],
  summary: 'Get a computer',
  description: 'One machine, with what it last reported about itself.',
  'x-fern-sdk-group-name': ['computers'],
  'x-fern-sdk-method-name': 'get',
  request: { params: ComputerPathParamsSchema },
  responses: {
    200: { content: { 'application/json': { schema: GetComputerResponseSchema } }, description: 'The computer.' },
    401: unauthorized,
    403: forbidden,
    404: notFound,
  },
});

export const patchComputerRoute = createRoute({
  method: 'patch',
  path: '/{computer_id}',
  tags: [OpenApiTag.COMPUTERS],
  summary: 'Update a computer',
  description: 'Renames the machine or changes whether its commands need approval.',
  'x-fern-sdk-group-name': ['computers'],
  'x-fern-sdk-method-name': 'update',
  request: {
    params: ComputerPathParamsSchema,
    body: { content: { 'application/json': { schema: UpdateComputerRequestSchema } }, required: true },
  },
  responses: {
    200: { content: { 'application/json': { schema: GetComputerResponseSchema } }, description: 'The computer.' },
    400: { content: { 'application/json': { schema: RequestErrorResponseSchema } }, description: 'Invalid body.' },
    401: unauthorized,
    403: forbidden,
    404: notFound,
    409: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'A computer with this name already exists.',
    },
  },
});

export const deleteComputerRoute = createRoute({
  method: 'delete',
  path: '/{computer_id}',
  tags: [OpenApiTag.COMPUTERS],
  summary: 'Delete a computer',
  description: 'Removes the machine, its access list and its activity. Refused while any agent may use it.',
  'x-fern-sdk-group-name': ['computers'],
  'x-fern-sdk-method-name': 'delete',
  request: { params: ComputerPathParamsSchema },
  responses: {
    200: { content: { 'application/json': { schema: DeleteComputerResponseSchema } }, description: 'Deleted.' },
    401: unauthorized,
    403: forbidden,
    404: notFound,
    409: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'An agent is still allowed to use this computer.',
    },
  },
});

export const getComputerAgentAccessRoute = createRoute({
  method: 'get',
  path: '/{computer_id}/agents',
  tags: [OpenApiTag.COMPUTERS],
  summary: 'List the agents allowed on a computer',
  description: 'Saved agents that may run on this machine.',
  'x-fern-sdk-group-name': ['computers', 'agents'],
  'x-fern-sdk-method-name': 'list',
  request: { params: ComputerPathParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: GetComputerAgentAccessResponseSchema } },
      description: 'The allowed agents.',
    },
    401: unauthorized,
    403: forbidden,
    404: notFound,
  },
});

export const putComputerAgentAccessRoute = createRoute({
  method: 'put',
  path: '/{computer_id}/agents',
  tags: [OpenApiTag.COMPUTERS],
  summary: 'Replace the agents allowed on a computer',
  description: 'Sets the whole list. An agent removed here stops being able to use the machine at once.',
  'x-fern-sdk-group-name': ['computers', 'agents'],
  'x-fern-sdk-method-name': 'create_or_update',
  request: {
    params: ComputerPathParamsSchema,
    body: { content: { 'application/json': { schema: ComputerAgentAccessSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: GetComputerAgentAccessResponseSchema } },
      description: 'The allowed agents.',
    },
    400: { content: { 'application/json': { schema: RequestErrorResponseSchema } }, description: 'Invalid body.' },
    401: unauthorized,
    403: forbidden,
    404: notFound,
  },
});

export const rotateComputerEnrollmentRoute = createRoute({
  method: 'post',
  path: '/{computer_id}/enrollment',
  tags: [OpenApiTag.COMPUTERS],
  summary: 'Issue a new enrollment code',
  description: 'Invalidates the current credential, disconnects the machine, and returns a fresh single-use code.',
  'x-fern-sdk-group-name': ['computers'],
  'x-fern-sdk-method-name': 'rotate_enrollment',
  request: { params: ComputerPathParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: CreateComputerEnrollmentResponseSchema } },
      description: 'The new one-time enrollment code.',
    },
    401: unauthorized,
    403: forbidden,
    404: notFound,
  },
});

export const revokeComputerRoute = createRoute({
  method: 'post',
  path: '/{computer_id}/revoke',
  tags: [OpenApiTag.COMPUTERS],
  summary: 'Revoke a computer',
  description: 'Drops the credential and closes the live connection. The machine cannot come back without a new code.',
  'x-fern-sdk-group-name': ['computers'],
  'x-fern-sdk-method-name': 'revoke',
  request: { params: ComputerPathParamsSchema },
  responses: {
    200: { content: { 'application/json': { schema: GetComputerResponseSchema } }, description: 'The computer.' },
    401: unauthorized,
    403: forbidden,
    404: notFound,
  },
});

export const listComputerAuditRoute = createRoute({
  method: 'get',
  path: '/{computer_id}/audit',
  tags: [OpenApiTag.COMPUTERS],
  summary: 'List what ran on a computer',
  description: 'Commands and file transfers this machine has served, newest first.',
  'x-fern-sdk-group-name': ['computers', 'audit'],
  'x-fern-sdk-method-name': 'list',
  'x-fern-pagination': TOKEN_PAGINATION,
  request: { params: ComputerPathParamsSchema, query: ListComputerAuditRequestQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: ListComputerAuditResponseSchema } },
      description: 'Paginated activity.',
    },
    400: {
      content: { 'application/json': { schema: RequestErrorResponseSchema } },
      description: 'Invalid query parameters.',
    },
    401: unauthorized,
    403: forbidden,
    404: notFound,
  },
});

/**
 * The machine's own exchange: an enrollment code for a lasting credential. Unauthenticated by
 * design, and every bad, expired or spent code answers identically. Clients read the protocol
 * document rather than the SDK, so it is not generated.
 */
export const enrollComputerRoute = createRoute({
  method: 'post',
  path: '/enroll',
  tags: [OpenApiTag.COMPUTERS],
  summary: 'Exchange an enrollment code for a machine credential',
  description: 'Called once by the client on the machine. Any code that is unknown, expired or used answers 401.',
  'x-fern-ignore': true,
  'x-excluded': true,
  request: {
    body: { content: { 'application/json': { schema: EnrollComputerRequestSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: EnrollComputerResponseSchema } },
      description: 'The computer id and its lasting credential.',
    },
    400: { content: { 'application/json': { schema: RequestErrorResponseSchema } }, description: 'Invalid body.' },
    401: { content: { 'application/json': { schema: RequestErrorResponseSchema } }, description: 'Unauthorized.' },
    404: notFound,
  },
});
