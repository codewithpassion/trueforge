/** The harness issuer from wrangler.jsonc `OIDC_ISSUER_URL`. */
const ISSUER = 'https://issuer.test/';

/**
 * Discovery for the harness issuer, so a test can build the app the way the Worker does. No token
 * is ever issued; such tests stand in their own authenticator. Undefined for any other host.
 */
export function handleMockOidcRequest(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (url.origin !== new URL(ISSUER).origin) {
    return undefined;
  }
  if (url.pathname !== '/.well-known/openid-configuration') {
    return new Response(`Unexpected issuer request: ${request.method} ${request.url}`, { status: 599 });
  }
  return Response.json({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}authorize`,
    token_endpoint: `${ISSUER}token`,
    jwks_uri: `${ISSUER}jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
  });
}
