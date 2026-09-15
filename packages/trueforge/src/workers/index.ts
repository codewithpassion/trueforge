import configuration from '../config';
import { isServerPath } from '../frontendShell';
import type { Env } from './env';
import { createWorkersServerRuntime } from './runtime';
import { assertWorkersRuntime } from './runtimeGuard';
import { SCHEDULER_INSTANCE_NAME } from './SchedulerDO';

export { SchedulerDO } from './SchedulerDO';
export { SessionDO } from './SessionDO';

let app: ReturnType<typeof createWorkersServerRuntime> | undefined;

export default {
  async fetch(request, env, ctx) {
    if (!isServerPath(new URL(request.url).pathname)) {
      return env.ASSETS.fetch(request);
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
