/** Remote desktop route definitions (mounted at /api/v1/computer-desktops). */
import { createRoute, z } from '@hono/zod-openapi';
import {
  CancelDesktopTakeoverRequestSchema,
  ComputerDesktopRequestQuerySchema,
  GetDesktopClipboardResponseSchema,
  GetDesktopStatusResponseSchema,
  HandBackDesktopConflictResponseSchema,
  HandBackDesktopRequestSchema,
  SendDesktopInputRequestSchema,
  SetDesktopClipboardRequestSchema,
} from '../schemas/computerDesktop';
import { RequestErrorResponseSchema } from '../schemas/errors';
import { OpenApiTag } from './openapiTags';

const DesktopPathParamsSchema = z.object({
  computer_id: z.string().min(1).describe('Computer id.'),
});

function errorResponse(description: string) {
  return { content: { 'application/json': { schema: RequestErrorResponseSchema } }, description };
}

const badRequest = errorResponse('Invalid body.');
const unauthorized = errorResponse('Authentication required.');
const forbidden = errorResponse(
  'The agent does not use this desktop, no saved agent was named, or a browser write came from another origin.',
);
const notFound = errorResponse('No such computer or agent, or this server does not serve remote computers.');
const clearing = errorResponse('Code `clearing`: the clipboard of the last person in control is still being cleared.');
const locked = errorResponse(
  'Code `human_in_control`: another person controls the desktop. Code `lease_required`: take control first.',
);
const badGateway = errorResponse('The computer answered with an error or a reply this server cannot read.');
const unavailable = errorResponse(
  'Code `offline` or `desktop_unavailable`: the computer or its desktop is not running.',
);

const jpegFrame = {
  content: { 'image/jpeg': { schema: z.string().openapi({ format: 'binary' }) } },
  description: 'A JPEG frame of the desktop.',
};

const statusResponse = {
  content: { 'application/json': { schema: GetDesktopStatusResponseSchema } },
  description: 'The desktop status.',
};

const FERN_GROUP = ['computerDesktops'];

export const getDesktopStatusRoute = createRoute({
  method: 'get',
  path: '/{computer_id}',
  tags: [OpenApiTag.COMPUTERS],
  summary: 'Get a desktop status',
  description: 'Whether the desktop is up, who controls it, and the takeovers agents are waiting on.',
  'x-fern-sdk-group-name': FERN_GROUP,
  'x-fern-sdk-method-name': 'get',
  request: { params: DesktopPathParamsSchema, query: ComputerDesktopRequestQuerySchema },
  responses: { 200: statusResponse, 401: unauthorized, 403: forbidden, 404: notFound },
});

export const getDesktopScreenshotRoute = createRoute({
  method: 'get',
  path: '/{computer_id}/screenshot',
  tags: [OpenApiTag.COMPUTERS],
  summary: 'Get a desktop frame',
  description: 'A live JPEG frame, never stored. Refused with 423 while another person controls the desktop.',
  'x-fern-sdk-group-name': FERN_GROUP,
  'x-fern-sdk-method-name': 'get_screenshot',
  request: { params: DesktopPathParamsSchema, query: ComputerDesktopRequestQuerySchema },
  responses: {
    200: jpegFrame,
    401: unauthorized,
    403: forbidden,
    404: notFound,
    409: clearing,
    423: locked,
    502: badGateway,
    503: unavailable,
  },
});

export const sendDesktopInputRoute = createRoute({
  method: 'post',
  path: '/{computer_id}/input',
  tags: [OpenApiTag.COMPUTERS],
  summary: 'Send desktop input',
  description: 'Runs mouse and keyboard actions in order and returns a fresh frame. Needs control; renews it.',
  'x-fern-sdk-group-name': FERN_GROUP,
  'x-fern-sdk-method-name': 'send_input',
  request: {
    params: DesktopPathParamsSchema,
    query: ComputerDesktopRequestQuerySchema,
    body: { content: { 'application/json': { schema: SendDesktopInputRequestSchema } }, required: true },
  },
  responses: {
    200: jpegFrame,
    400: badRequest,
    401: unauthorized,
    403: forbidden,
    404: notFound,
    409: clearing,
    423: locked,
    502: badGateway,
    503: unavailable,
  },
});

export const getDesktopClipboardRoute = createRoute({
  method: 'get',
  path: '/{computer_id}/clipboard',
  tags: [OpenApiTag.COMPUTERS],
  summary: 'Read the desktop clipboard',
  description: 'The clipboard text, empty when nothing was copied. Only the person in control may read it.',
  'x-fern-sdk-group-name': FERN_GROUP,
  'x-fern-sdk-method-name': 'get_clipboard',
  request: { params: DesktopPathParamsSchema, query: ComputerDesktopRequestQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: GetDesktopClipboardResponseSchema } },
      description: 'The clipboard.',
    },
    401: unauthorized,
    403: forbidden,
    404: notFound,
    409: clearing,
    423: locked,
    502: badGateway,
    503: unavailable,
  },
});

export const setDesktopClipboardRoute = createRoute({
  method: 'put',
  path: '/{computer_id}/clipboard',
  tags: [OpenApiTag.COMPUTERS],
  summary: 'Set the desktop clipboard',
  description: 'Sets the clipboard and primary selection. Only the person in control may set it. At most 64 KiB.',
  'x-fern-sdk-group-name': FERN_GROUP,
  'x-fern-sdk-method-name': 'set_clipboard',
  request: {
    params: DesktopPathParamsSchema,
    query: ComputerDesktopRequestQuerySchema,
    body: { content: { 'application/json': { schema: SetDesktopClipboardRequestSchema } }, required: true },
  },
  responses: {
    204: { description: 'The clipboard is set.' },
    400: badRequest,
    401: unauthorized,
    403: forbidden,
    404: notFound,
    409: clearing,
    423: locked,
    502: badGateway,
    503: unavailable,
  },
});

export const takeDesktopControlRoute = createRoute({
  method: 'post',
  path: '/{computer_id}/take-control',
  tags: [OpenApiTag.COMPUTERS],
  summary: 'Take control of a desktop',
  description:
    'Makes the caller the only one who may drive the desktop, preempting an agent or another person. Agent work on the computer pauses until control is handed back.',
  'x-fern-sdk-group-name': FERN_GROUP,
  'x-fern-sdk-method-name': 'take_control',
  request: { params: DesktopPathParamsSchema, query: ComputerDesktopRequestQuerySchema },
  responses: {
    200: statusResponse,
    401: unauthorized,
    403: forbidden,
    404: notFound,
    409: clearing,
    503: unavailable,
  },
});

export const handBackDesktopRoute = createRoute({
  method: 'post',
  path: '/{computer_id}/hand-back',
  tags: [OpenApiTag.COMPUTERS],
  summary: 'Hand a desktop back',
  description:
    'Ends the control the caller holds and clears the clipboard. With `session_id`, also answers that pending takeover as completed so the agent continues.',
  'x-fern-sdk-group-name': FERN_GROUP,
  'x-fern-sdk-method-name': 'hand_back',
  request: {
    params: DesktopPathParamsSchema,
    query: ComputerDesktopRequestQuerySchema,
    body: { content: { 'application/json': { schema: HandBackDesktopRequestSchema } }, required: true },
  },
  responses: {
    200: statusResponse,
    400: badRequest,
    401: unauthorized,
    403: forbidden,
    404: notFound,
    409: {
      content: { 'application/json': { schema: HandBackDesktopConflictResponseSchema } },
      description:
        'Code `not_pending`: nothing changed. Code `takeover_already_answered`: answered elsewhere, but control is released. Either way `data` is the desktop status after the request.',
    },
    423: errorResponse('Code `lease_required`: the caller does not control the desktop.'),
    503: errorResponse('Takeovers cannot be answered on this server.'),
  },
});

export const cancelDesktopTakeoverRoute = createRoute({
  method: 'post',
  path: '/{computer_id}/cancel-takeover',
  tags: [OpenApiTag.COMPUTERS],
  summary: 'Cancel a desktop takeover',
  description:
    'Answers a pending takeover as cancelled so the agent continues without help. Needs no control; releases it if the caller holds it.',
  'x-fern-sdk-group-name': FERN_GROUP,
  'x-fern-sdk-method-name': 'cancel_takeover',
  request: {
    params: DesktopPathParamsSchema,
    query: ComputerDesktopRequestQuerySchema,
    body: { content: { 'application/json': { schema: CancelDesktopTakeoverRequestSchema } }, required: true },
  },
  responses: {
    200: statusResponse,
    400: badRequest,
    401: unauthorized,
    403: forbidden,
    404: notFound,
    409: errorResponse('Code `takeover_already_answered` or `not_pending`: the takeover was answered elsewhere.'),
    503: errorResponse('Takeovers cannot be answered on this server.'),
  },
});
