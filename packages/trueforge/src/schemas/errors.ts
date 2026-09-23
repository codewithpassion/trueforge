/** Error response wire schema. */
import { z } from '@hono/zod-openapi';

export const RequestErrorResponseSchema = z
  .object({
    error: z.object({
      message: z.string().describe('Human-readable explanation of the failure.'),
      type: z.string().optional().describe('Optional error category (e.g. validation vs conflict).'),
      code: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Optional machine-readable error code, such as `human_in_control` on a 423; null when not applicable.',
        ),
      param: z
        .string()
        .nullable()
        .optional()
        .describe('Optional request field that caused the error; null when not field-specific.'),
    }),
    data: z
      .unknown()
      .optional()
      .describe('State after a refused request, on the routes that document it; absent otherwise.'),
  })
  .openapi('RequestErrorResponse');

export type RequestErrorResponse = z.infer<typeof RequestErrorResponseSchema>;
