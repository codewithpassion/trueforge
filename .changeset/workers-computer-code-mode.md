---
'@truefoundry/trueforge': patch
'@truefoundry/trueforge-core': patch
---

Code Mode now works on the Cloudflare Workers runtime. An agent with a sandbox and MCP servers can call those servers from inside a sandbox command, the same way it can on the Daytona, TrueFoundry, and local providers.

The sandbox reaches the host over its own egress. Cloudflare intercepts every outbound request the container makes and delivers it to a gateway the Worker owns, which sends one fixed internal hostname to the session that owns the workspace and passes everything else through unchanged. That session is taken from the workspace's own name, never from anything in the request, so a sandbox can only ever reach its own session. Inside the session, a token issued for one turn is what opens the channel, and it stops working when the turn ends.

The sandbox MCP client, `mcp_client.py`, gained an HTTP mode for this, selected by environment variables and written against the Python standard library alone. The NATS mode the Node deployments use is unchanged, and so is the client's public surface: `from mcp_client import call_tool` and the `mcp-client` CLI behave the same on every provider. Reply handling is now shared between the two modes, so an invalid request or a transport failure reads the same wherever it happened.

Because Cloudflare now terminates the container's outbound HTTPS, the sandbox trusts the certificate authority Cloudflare creates for each container. That CA appears only after the container has started, so the image installs it in the background, and the Worker checks it once per container before the first command, logging an error if it is missing. Every command gets `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `PIP_CERT` and `NODE_EXTRA_CA_CERTS` pointing at the system bundle, which replace any value the command sets. Without these, every HTTPS call from a sandbox, a skill clone included, would fail to verify.

Code Mode follows the built-in sandbox: it is available once a tenant admin enables the Cloudflare Computer provider in Settings. Code Mode requests from the sandbox are limited to 1 MiB, and trace headers from the sandbox are kept only when they are valid W3C trace context.
