/**
 * Maps the desktop port onto Harness `/api/v1/computer-desktops`. Refusals become
 * `ComputerDesktopError`, so the UI branches on status and code without knowing the SDK.
 */
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import type { ComputerDesktopServer, DesktopRequestFailure } from '../../../server/types.js';
import { readApiError } from '../../../utils/readApiError.js';

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

/** SDK status errors become `ComputerDesktopError`; anything else is rethrown as is. */
function toDesktopError(caught: unknown): unknown {
  if (!(caught instanceof Error)) return caught;
  const { status, code, message } = readApiError(caught);
  if (status === undefined) return caught;
  return new ComputerDesktopError(
    { statusCode: status, code: code ?? null, message: message ?? caught.message },
    { cause: caught },
  );
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
