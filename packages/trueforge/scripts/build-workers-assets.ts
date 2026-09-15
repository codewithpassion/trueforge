/** Builds `dist-workers-assets/` for Workers static assets, which always serve the UI from `/`. */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { applyShellTokens, renderStaticAssetHeaders } from '../src/frontendShell';

const packageRoot = path.resolve(import.meta.dirname, '..');
const source = path.resolve(packageRoot, '../frontend/dist');
const destination = path.join(packageRoot, 'dist-workers-assets');
// Node serves these precompressed siblings; Cloudflare compresses assets itself.
const PRECOMPRESSED_SUFFIXES = ['.br', '.gz'];

const indexPath = path.join(source, 'index.html');
if (!existsSync(indexPath)) {
  throw new Error(`No frontend build at ${source}. Run \`pnpm --filter frontend build\` first.`);
}

rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, {
  recursive: true,
  filter: file => !PRECOMPRESSED_SUFFIXES.some(suffix => file.endsWith(suffix)),
});
writeFileSync(
  path.join(destination, 'index.html'),
  applyShellTokens({ html: readFileSync(indexPath, 'utf8'), uiBasePath: '/' }),
);
writeFileSync(path.join(destination, '_headers'), renderStaticAssetHeaders());
console.log(`Wrote Workers assets to ${destination}`);
