/** Mount root of the Computer workspace; `computerd` mounts the VFS here inside the container. */
export const COMPUTER_WORKSPACE_ROOT = '/workspace';

export const COMPUTER_UPLOADS_DIR = `${COMPUTER_WORKSPACE_ROOT}/uploads`;
export const COMPUTER_TOOL_RESULT_DIR = `${COMPUTER_WORKSPACE_ROOT}/.trueforge/tool-results`;
export const COMPUTER_SKILLS_DIR = `${COMPUTER_WORKSPACE_ROOT}/.trueforge/skills`;
export const COMPUTER_SKILL_DOWNLOADER_PATH = `${COMPUTER_WORKSPACE_ROOT}/.trueforge/bin/skill_downloader.py`;
export const COMPUTER_GIT_CREDENTIALS_PATH = `${COMPUTER_WORKSPACE_ROOT}/.trueforge/git-credentials`;

/** Code Mode MCP client. The module is on the workspace; the CLI link is container-local, on PATH. */
export const COMPUTER_MCP_CLIENT_PATH = `${COMPUTER_WORKSPACE_ROOT}/.trueforge/mcp-client/mcp_client.py`;
export const COMPUTER_MCP_CLIENT_BIN = '/usr/local/bin/mcp-client';

/** Installs the per-container egress CA; its argument is how many seconds to wait for one. */
export const COMPUTER_TRUST_EGRESS_CA_BIN = '/usr/local/bin/trueforge-trust-egress-ca';

/** The system bundle, which is the one store the egress CA is added to. */
export const COMPUTER_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';

/**
 * Points every TLS client the image carries at the system bundle. Clients that ship their own store
 * (certifi, Node, pip) would otherwise reject intercepted HTTPS even once the bundle trusts the CA.
 */
export const COMPUTER_TLS_TRUST_ENV: Readonly<Record<string, string>> = {
  SSL_CERT_FILE: COMPUTER_CA_BUNDLE,
  REQUESTS_CA_BUNDLE: COMPUTER_CA_BUNDLE,
  CURL_CA_BUNDLE: COMPUTER_CA_BUNDLE,
  GIT_SSL_CAINFO: COMPUTER_CA_BUNDLE,
  PIP_CERT: COMPUTER_CA_BUNDLE,
  NODE_EXTRA_CA_CERTS: COMPUTER_CA_BUNDLE,
};
