import configuration from '../config';
import { HASHED_ASSET_PREFIX, isServerPath, REVALIDATE_CACHE_CONTROL } from '../frontendShell';
import type { Env } from './env';
import { createWorkersServerRuntime } from './runtime';
import { assertWorkersRuntime } from './runtimeGuard';
import { SCHEDULER_INSTANCE_NAME } from './SchedulerDO';

export { SchedulerDO } from './SchedulerDO';
export { SessionDO } from './SessionDO';

let app: ReturnType<typeof createWorkersServerRuntime> | undefined;

/**
 * Runs only when no static asset matched. A missing hashed asset gets a plain 404 so no cache stores HTML
 * under a script name; browser navigations get the shell, fetched as `/` because `/index.html` redirects.
 */
async function respondToAssetMiss({ request, assets }: { request: Request; assets: Fetcher }): Promise<Response> {
  const isNavigation =
    (request.method === 'GET' || request.method === 'HEAD') &&
    request.headers.get('accept')?.includes('text/html') === true;
  if (new URL(request.url).pathname.startsWith(HASHED_ASSET_PREFIX) || !isNavigation) {
    return new Response('Not found', { status: 404 });
  }
  const shell = await assets.fetch(new Request(new URL('/', request.url), request));
  const response = new Response(shell.body, shell);
  response.headers.set('Cache-Control', REVALIDATE_CACHE_CONTROL);
  return response;
}

export default {
  async fetch(request, env, ctx) {
    if (!isServerPath(new URL(request.url).pathname)) {
      return respondToAssetMiss({ request, assets: env.ASSETS });
    }
    try {
      assertWorkersRuntime(configuration);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      return Response.json({ error: { message: 'Server is misconfigured' } }, { status: 500 });
    }
    // A failed build (for example OIDC discovery) is retried on the next request.
    app ??= createWorkersServerRuntime(env).catch((error: unknown) => {
      app = undefined;
      throw error;
    });
    return (await app).fetch(request, env, ctx);
  },

  /** Dispatch runs from the scheduler's own alarm; the cron only re-arms it, for example after a deploy. */
  async scheduled(_controller, env) {
    await env.SCHEDULER_DO.get(env.SCHEDULER_DO.idFromName(SCHEDULER_INSTANCE_NAME)).ensureAlarm();
  },
} satisfies ExportedHandler<Env>;
