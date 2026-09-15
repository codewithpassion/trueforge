declare namespace Cloudflare {
  interface Env {
    DB: import('@cloudflare/workers-types').D1Database;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
