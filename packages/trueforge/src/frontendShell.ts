/** Shell token and cache policy for the built UI, shared by Node serving and the Workers asset build. */

/** Vite writes this into the production shell. Must not appear in JS identifiers. */
export const SHELL_BASE_TOKEN = '%%TRUEFORGE_BASE_PATH%%';

/** Only Vite's hashed asset names can be cached forever. */
export const HASHED_ASSET_PREFIX = '/assets/';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const REVALIDATE_CACHE_CONTROL = 'no-cache';

export function applyShellTokens(options: { html: string; uiBasePath: string }): string {
  return options.html.replaceAll(SHELL_BASE_TOKEN, options.uiBasePath);
}

/**
 * `_headers` for Workers static assets. Matching rules join repeated headers with a comma, so the
 * hashed-asset rule detaches the catch-all value before setting its own.
 */
export function renderStaticAssetHeaders(): string {
  return [
    '/*',
    `  Cache-Control: ${REVALIDATE_CACHE_CONTROL}`,
    '',
    `${HASHED_ASSET_PREFIX}*`,
    '  ! Cache-Control',
    `  Cache-Control: ${IMMUTABLE_CACHE_CONTROL}`,
    '',
  ].join('\n');
}
