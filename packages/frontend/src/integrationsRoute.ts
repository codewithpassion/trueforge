/**
 * The Integrations page is a host page, not a `<TrueForgeUI>` route: the UI owns its own
 * router, so the shell picks between them on the path under the public base.
 */
import { UI_BASE_PATH } from './publicPath';

export const INTEGRATIONS_SEGMENT = 'integrations';

/** Href for the nav entry and for leaving the page again. */
export function integrationsHref(): string {
  return `${UI_BASE_PATH}${INTEGRATIONS_SEGMENT}`;
}

export function appHomeHref(): string {
  return UI_BASE_PATH;
}

/**
 * Whether a pathname is the Integrations page. Matches with or without a trailing slash and
 * under any public prefix, so a reverse-proxied deployment routes the same as a bare one.
 */
export function isIntegrationsPath(pathname: string, basePath: string = UI_BASE_PATH): boolean {
  const prefix = basePath.endsWith('/') ? basePath : `${basePath}/`;
  if (!pathname.startsWith(prefix)) {
    return false;
  }
  return pathname.slice(prefix.length).replace(/\/+$/, '') === INTEGRATIONS_SEGMENT;
}
