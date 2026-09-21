import type { CodeModeDispatcher } from '@truefoundry/trueforge-core/core/sandbox/codeMode/CodeModeDispatcher';
import {
  CodeModeRequestSchema,
  type CodeModeReply,
  type CodeModeRequest,
} from '@truefoundry/trueforge-core/core/sandbox/codeMode/types';
import { withTimeout } from '@truefoundry/trueforge-core/core/util/promiseUtils';

/**
 * Where the sandbox's MCP client posts. The name resolves nowhere on the internet: the container's
 * egress is intercepted, so the workspace's gateway answers it before anything leaves the machine.
 */
export const CODE_MODE_BRIDGE_HOST = 'code-mode.trueforge.internal';
export const CODE_MODE_BRIDGE_URL = `http://${CODE_MODE_BRIDGE_HOST}/dispatch`;

/**
 * What the gateway turns into an HTTP answer. Error classes do not survive Workers RPC, and the
 * reply crosses it already serialized because `CodeModeReply.result` is `unknown`, which the RPC
 * types cannot carry.
 */
export type CodeModeDispatchOutcome = { ok: true; replyJson: string } | { ok: false; status: number; message: string };

function reply(value: CodeModeReply): CodeModeDispatchOutcome {
  return { ok: true, replyJson: JSON.stringify(value) };
}

function parseRequest(requestJson: string): CodeModeRequest | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(requestJson);
  } catch {
    return undefined;
  }
  const parsed = CodeModeRequestSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The Code Mode channels the turns running in one session have open, keyed by the per-turn token
 * their sandbox carries. A token that is not in here belongs to no turn of this session.
 */
export class CodeModeBridgeRegistry {
  readonly #channels = new Map<string, { dispatcher: CodeModeDispatcher; timeoutMs: number }>();

  /** Returns the token the sandbox must present; it is the only thing that names this channel. */
  open(channel: { dispatcher: CodeModeDispatcher; timeoutMs: number }): string {
    // The lookup below is not constant-time; 122 random bits are what make that irrelevant, so the
    // token must never become shorter or guessable.
    const token = crypto.randomUUID();
    this.#channels.set(token, channel);
    return token;
  }

  close(token: string): void {
    this.#channels.delete(token);
  }

  async dispatch(request: {
    token: string;
    requestJson: string;
    traceCarrier: Readonly<Record<string, string>>;
  }): Promise<CodeModeDispatchOutcome> {
    const channel = this.#channels.get(request.token);
    if (channel === undefined) {
      return { ok: false, status: 401, message: 'Code Mode token is not open for this session' };
    }
    const parsed = parseRequest(request.requestJson);
    if (parsed === undefined) {
      return reply({ ok: false, error: 'Malformed Code Mode request', source: 'caller' });
    }
    try {
      return reply(
        await withTimeout(
          channel.dispatcher.dispatch({ request: parsed, traceCarrier: request.traceCarrier }),
          channel.timeoutMs,
          'code mode dispatch',
        ),
      );
    } catch (error) {
      // The alarm pass holding this turn must not wait on a tool longer than the command that asked.
      const message = error instanceof Error ? error.message : String(error);
      return reply({ ok: false, error: `Code Mode dispatch gave up: ${message}`, source: 'transport' });
    }
  }
}
