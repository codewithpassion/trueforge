/** Wire schemas for watching and driving a remote computer's desktop. */
import { z } from '@hono/zod-openapi';
import {
  DESKTOP_MAX_ACTIONS,
  DESKTOP_SCROLL_BUDGET_MESSAGE,
  DesktopClickActionSchema,
  DesktopClipboardTextSchema,
  DesktopKeyActionSchema,
  DesktopMouseDownActionSchema,
  DesktopMouseMoveActionSchema,
  DesktopMouseUpActionSchema,
  DesktopScrollActionSchema,
  DesktopTypeActionSchema,
  fitsScrollBudget,
} from '../computers/protocol';
import { RequestErrorResponseSchema } from './errors';

/** The takeover note the agent reads back, bounded like any other tool response a person writes. */
const DESKTOP_NOTE_MAX_CHARS = 2000;

// The protocol owns each action's bounds; these only give them OpenAPI names.
export const DesktopActionSchema = z
  .discriminatedUnion('type', [
    z.object(DesktopMouseMoveActionSchema.shape).openapi('DesktopMouseMoveAction'),
    z.object(DesktopMouseDownActionSchema.shape).openapi('DesktopMouseDownAction'),
    z.object(DesktopMouseUpActionSchema.shape).openapi('DesktopMouseUpAction'),
    z.object(DesktopClickActionSchema.shape).openapi('DesktopClickAction'),
    z.object(DesktopScrollActionSchema.shape).openapi('DesktopScrollAction'),
    z.object(DesktopKeyActionSchema.shape).openapi('DesktopKeyAction'),
    z.object(DesktopTypeActionSchema.shape).openapi('DesktopTypeAction'),
  ])
  .openapi('DesktopAction');

export const ComputerDesktopRequestQuerySchema = z
  .object({
    agent_id: z
      .string()
      .min(1)
      .optional()
      .describe('The saved agent whose desktop this is. Required unless the caller is a tenant admin.'),
  })
  .openapi('ComputerDesktopRequestQuery');

export const DesktopControllerNoneSchema = z.object({ kind: z.literal('none') }).openapi('DesktopControllerNone');
export const DesktopControllerAgentSchema = z
  .object({ kind: z.literal('agent'), session_id: z.string() })
  .openapi('DesktopControllerAgent');
export const DesktopControllerHumanSchema = z
  .object({
    kind: z.literal('human'),
    user_id: z.string(),
    is_me: z.boolean().describe('Whether the caller is the person in control.'),
    expires_at: z.string().describe('ISO-8601 instant control lapses without further input.'),
  })
  .openapi('DesktopControllerHuman');
export const DesktopControllerClearingSchema = z
  .object({ kind: z.literal('clearing') })
  .openapi('DesktopControllerClearing');

export const DesktopControllerSchema = z
  .discriminatedUnion('kind', [
    DesktopControllerNoneSchema,
    DesktopControllerAgentSchema,
    DesktopControllerHumanSchema,
    DesktopControllerClearingSchema,
  ])
  .openapi('DesktopController');

export const PendingDesktopTakeoverSchema = z
  .object({
    session_id: z.string(),
    turn_id: z.string(),
    tool_call_id: z.string(),
    reason: z.string().describe('Why the agent asked for a person.'),
    requested_at: z.string(),
    agent_id: z.string(),
  })
  .openapi('PendingDesktopTakeover');

export const DesktopStatusSchema = z
  .object({
    computer_id: z.string(),
    online: z.boolean(),
    desktop: z.boolean().describe('Whether the computer reports a running desktop.'),
    controller: DesktopControllerSchema,
    pending_takeovers: z.array(PendingDesktopTakeoverSchema),
  })
  .openapi('DesktopStatus');

export const GetDesktopStatusResponseSchema = z
  .object({ data: DesktopStatusSchema })
  .openapi('GetDesktopStatusResponse');

export const SendDesktopInputRequestSchema = z
  .object({
    actions: z
      .array(DesktopActionSchema)
      .min(1)
      .max(DESKTOP_MAX_ACTIONS)
      .refine(fitsScrollBudget, { message: DESKTOP_SCROLL_BUDGET_MESSAGE }),
  })
  .strict()
  .openapi('SendDesktopInputRequest');

export const DesktopClipboardSchema = z.object({ text: DesktopClipboardTextSchema }).openapi('DesktopClipboard');

export const GetDesktopClipboardResponseSchema = z
  .object({ data: DesktopClipboardSchema })
  .openapi('GetDesktopClipboardResponse');

export const SetDesktopClipboardRequestSchema = z
  .object({ text: DesktopClipboardTextSchema })
  .strict()
  .openapi('SetDesktopClipboardRequest');

export const HandBackDesktopRequestSchema = z
  .object({
    session_id: z.string().min(1).optional().describe('The pending takeover to answer as completed.'),
    note: z.string().max(DESKTOP_NOTE_MAX_CHARS).optional().describe('Passed to the agent with the answer.'),
  })
  .strict()
  .openapi('HandBackDesktopRequest');

/** A refused hand-back still reports the desktop, since control may already have been released. */
export const HandBackDesktopConflictResponseSchema = z
  .object({ ...RequestErrorResponseSchema.shape, data: DesktopStatusSchema })
  .openapi('HandBackDesktopConflictResponse');

export const CancelDesktopTakeoverRequestSchema = z
  .object({
    session_id: z.string().min(1).describe('The pending takeover to answer as cancelled.'),
    note: z.string().max(DESKTOP_NOTE_MAX_CHARS).optional().describe('Passed to the agent with the answer.'),
  })
  .strict()
  .openapi('CancelDesktopTakeoverRequest');

export type DesktopStatus = z.infer<typeof DesktopStatusSchema>;
export type DesktopController = z.infer<typeof DesktopControllerSchema>;
