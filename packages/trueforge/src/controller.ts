import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import { fetch as undiciFetch, type Dispatcher, type RequestInit as UndiciRequestInit } from 'undici';
import { Controller } from './controller/Controller';
import { createHttpScheduleRunExecutor, scheduleDispatchLoop } from './controller/scheduleDispatch';
import type { IScheduleStore } from './db/scheduleStore';
import type { WithTransaction } from './db/transaction';
import { createTlsDispatcher, normalizeTlsUrl, type TlsOptions } from './http/tls';

/** Resolves `fetch`'s first argument (`string | URL | Request`) to a URL string. */
function requestUrlFromFetchInput(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

/**
 * Copies what the SDK client sends into undici's init. The global fetch types and the undici package
 * disagree on `FormData` and `Headers`, so headers become a plain record and only text bodies pass.
 */
function toUndiciInit({
  init,
  dispatcher,
}: {
  init: RequestInit | undefined;
  dispatcher: Dispatcher;
}): UndiciRequestInit {
  const body = init?.body;
  if (body !== undefined && body !== null && typeof body !== 'string') {
    throw new TypeError('The mTLS fetch sends only text request bodies');
  }
  return {
    dispatcher,
    ...(init?.method === undefined ? {} : { method: init.method }),
    ...(init?.headers === undefined ? {} : { headers: Object.fromEntries(new Headers(init.headers)) }),
    ...(body === undefined || body === null ? {} : { body }),
    ...(init?.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
  };
}

/**
 * `fetch` for the schedule controller SDK client. Undefined when mTLS is off. Kept out of
 * `http/tls.ts`, which the Workers type graph reaches, because undici's Response is not the Workers one.
 */
function createTlsFetch(options: TlsOptions): typeof fetch | undefined {
  const dispatcher = createTlsDispatcher({
    ...options,
    enabledEnvKey: 'TRUEFORGE_MTLS_ENABLED',
  });
  if (dispatcher === undefined) {
    return undefined;
  }
  return (input, init) => undiciFetch(requestUrlFromFetchInput(input), toUndiciInit({ init, dispatcher }));
}

/** Where and how the controller reaches the server's HTTP API. */
export interface ControllerServerTarget {
  /** `SERVER_URL`: loopback in standalone, the server Service in distributed. */
  serverUrl: string;
  /** `TRUEFORGE_API_KEY` presented to the internal execution endpoint. */
  apiKey: string;
  /** `TRUEFORGE_MTLS_*`: present a client certificate and upgrade the URL to https. */
  tls: { enabled: boolean; dir: string };
}

/**
 * Controller whose schedule loop hands runs to the server over HTTP. Standalone uses
 * loopback; distributed uses the dedicated controller against the server Service.
 */
export function createController<TTransaction>(
  params: ControllerServerTarget & {
    scheduleStore: IScheduleStore<TTransaction>;
    withTransaction: WithTransaction<TTransaction>;
    logger: Logger;
  },
): Controller {
  const { tls } = params;
  return new Controller({
    loops: [
      scheduleDispatchLoop({
        scheduleStore: params.scheduleStore,
        withTransaction: params.withTransaction,
        logger: params.logger,
        executeRun: createHttpScheduleRunExecutor({
          baseUrl: normalizeTlsUrl({ url: params.serverUrl, enabled: tls.enabled }),
          token: params.apiKey,
          fetch: createTlsFetch(tls),
        }),
      }),
    ],
    logger: params.logger,
  });
}

/**
 * Runs the controller: starts the loops and drains them on SIGTERM/SIGINT.
 */
export function runController<TTransaction>(
  params: ControllerServerTarget & {
    scheduleStore: IScheduleStore<TTransaction>;
    withTransaction: WithTransaction<TTransaction>;
    logger: Logger;
    gracefulTimeoutSeconds: number;
    /** Releases what the caller opened for the loops, e.g. its database pool. */
    onStopped?: () => Promise<void>;
  },
): Controller {
  const { logger, gracefulTimeoutSeconds, onStopped } = params;
  const controller = createController(params);
  controller.start();

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${signal}, stopping control loops`);

    // Passes only hold short transactions, so the deadline should never elapse.
    setTimeout(() => {
      logger.warn(`Controller drain timed out after ${String(gracefulTimeoutSeconds)}s, exiting`);
      process.exit(1);
    }, gracefulTimeoutSeconds * 1000).unref();

    await controller.stop();
    await onStopped?.();
    process.exit(0);
  };
  process.on('SIGTERM', signal => {
    void shutdown(signal);
  });
  process.on('SIGINT', signal => {
    void shutdown(signal);
  });

  return controller;
}
