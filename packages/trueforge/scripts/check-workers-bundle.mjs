// The SSRF guard needs node:dns and undici; the Workers bundle must never pull it in.
import { readFileSync } from 'node:fs';

const metafile = JSON.parse(readFileSync('.wrangler/check/metafile.json', 'utf8'));
const leaked = Object.keys(metafile.inputs).filter(input => input.includes('ssrfGuard'));
if (leaked.length > 0) {
  console.error(`Workers bundle includes the Node SSRF guard: ${leaked.join(', ')}`);
  process.exit(1);
}
console.log('Workers bundle excludes ssrfGuard');
