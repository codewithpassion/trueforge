/**
 * Maps the desktop port onto Harness `/api/v1/computer-desktops`. Refusals become
 * `ComputerDesktopError`, so the UI branches on status and code without knowing the SDK.
 */
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import type { ComputerDesktopServer, DesktopRequestFailure } from '../../../server/types.js';

/** Frames are polled; a retried frame is a stale one, so the UI's next poll is the retry. */
const DESKTOP_REQUEST_OPTIONS: { maxRetries: number; timeoutInSeconds: number } = {
  maxRetries: 0,
  timeoutInSeconds: 15,
};

export class ComputerDesktopError extends Error implements DesktopRequestFailure {
  readonly statusCode: number;
  readonly code: string | null;

  constructor(failure: DesktopRequestFailure, options: { cause: unknown }) {
    super(failure.message, options);
    this.name = 'ComputerDesktopError';
    this.statusCode = failure.statusCode;
    this.code = failure.code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `{ error: { code, message } }` envelope of a refused request, when the body has one. */
function readErrorEnvelope(body: unknown): { code: string | null; message: string | undefined } {
  const error = isRecord(body) ? body['error'] : undefined;
  if (!isRecord(error)) return { code: null, message: undefined };
  const code = error['code'];
  const message = error['message'];
  return {
    code: typeof code === 'string' ? code : null,
    message: typeof message === 'string' ? message : undefined,
  };
}

/**
 * The SDK's status errors carry `statusCode` and the parsed `body`. Read structurally: the SDK's
 * error classes are re-exported through `export *`, which some ESM loaders cannot see by name.
 */
function toDesktopError(caught: unknown): unknown {
  if (!(caught instanceof Error)) return caught;
  const statusCode: unknown = Reflect.get(caught, 'statusCode');
  if (typeof statusCode !== 'number') return caught;
  const { code, message } = readErrorEnvelope(Reflect.get(caught, 'body'));
  return new ComputerDesktopError({ statusCode, code, message: message ?? caught.message }, { cause: caught });
}

async function refusalsAsDesktopErrors<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (caught) {
    throw toDesktopError(caught);
  }
}

export function createComputerDesktopServer(client: TrueForge): ComputerDesktopServer {
  const desktops = client.computerDesktops;
  const scope = (agentId: string | undefined) => (agentId === undefined ? {} : { agentId });
  return {
    getDesktopStatus: ({ computerId, agentId }) =>
      refusalsAsDesktopErrors(async () => {
        const body = await desktops.get(computerId, scope(agentId), DESKTOP_REQUEST_OPTIONS);
        return body.data;
      }),
    getDesktopScreenshot: ({ computerId, agentId, signal }) =>
      refusalsAsDesktopErrors(async () => {
        const frame = await desktops.getScreenshot(computerId, scope(agentId), {
          ...DESKTOP_REQUEST_OPTIONS,
          ...(signal === undefined ? {} : { abortSignal: signal }),
        });
        return frame.blob();
      }),
    sendDesktopInput: ({ computerId, agentId, actions }) =>
      refusalsAsDesktopErrors(async () => {
        const frame = await desktops.sendInput(computerId, { ...scope(agentId), actions }, DESKTOP_REQUEST_OPTIONS);
        return frame.blob();
      }),
    getDesktopClipboard: ({ computerId, agentId }) =>
      refusalsAsDesktopErrors(async () => {
        const body = await desktops.getClipboard(computerId, scope(agentId), DESKTOP_REQUEST_OPTIONS);
        return { text: body.data.text };
      }),
    setDesktopClipboard: ({ computerId, agentId, text }) =>
      refusalsAsDesktopErrors(async () => {
        await desktops.setClipboard(computerId, { ...scope(agentId), text }, DESKTOP_REQUEST_OPTIONS);
      }),
    takeDesktopControl: ({ computerId, agentId }) =>
      refusalsAsDesktopErrors(async () => {
        const body = await desktops.takeControl(computerId, scope(agentId), DESKTOP_REQUEST_OPTIONS);
        return body.data;
      }),
    handBackDesktop: ({ computerId, agentId, sessionId, note }) =>
      refusalsAsDesktopErrors(async () => {
        const body = await desktops.handBack(
          computerId,
          {
            ...scope(agentId),
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(note === undefined ? {} : { note }),
          },
          DESKTOP_REQUEST_OPTIONS,
        );
        return body.data;
      }),
    cancelDesktopTakeover: ({ computerId, agentId, sessionId, note }) =>
      refusalsAsDesktopErrors(async () => {
        const body = await desktops.cancelTakeover(
          computerId,
          { ...scope(agentId), sessionId, ...(note === undefined ? {} : { note }) },
          DESKTOP_REQUEST_OPTIONS,
        );
        return body.data;
      }),
  };
}
