// The SSRF guard needs node:dns and undici, and the Node file stores need node:fs or an S3 client;
// the Workers bundle must never pull them in.
import { readFileSync } from 'node:fs';

const NODE_ONLY = ['ssrfGuard', 'src/files/', 'aws4fetch'];

const metafile = JSON.parse(readFileSync('.wrangler/check/metafile.json', 'utf8'));
const leaked = Object.keys(metafile.inputs).filter(input => NODE_ONLY.some(marker => input.includes(marker)));
if (leaked.length > 0) {
  console.error(`Workers bundle includes Node-only modules: ${leaked.join(', ')}`);
  process.exit(1);
}
console.log(`Workers bundle excludes ${NODE_ONLY.join(', ')}`);
