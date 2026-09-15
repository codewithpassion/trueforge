---
'@truefoundry/trueforge': patch
---

The Cloudflare Workers build now serves the chat UI as static assets from `/`, and served files get the same cache headers as on the Node server. New scripts: `workers:deploy`, `build:workers-assets`, `d1:migrate:local`, and `d1:migrate:remote` (replaces `workers:d1:migrate:local`). `TRUEFORGE_RUNTIME` is now documented in `.env.example` and the CLI help. With `TRUEFORGE_RUNTIME=workers`, a `PUBLIC_BASE_URL` that is empty or includes a path now fails startup.
