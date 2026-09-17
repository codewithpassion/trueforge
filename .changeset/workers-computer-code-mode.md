---
'@truefoundry/trueforge': patch
'@truefoundry/trueforge-core': patch
---

Code Mode now works on the Cloudflare Workers runtime. An agent with a sandbox and MCP servers can call those servers from inside a sandbox command, the same way it can on the Daytona, TrueFoundry, and local providers.

The sandbox reaches the host over its own egress. Cloudflare intercepts every outbound request the container makes and delivers it to a gateway the Worker owns, which sends one fixed internal hostname to the session that owns the workspace and passes everything else through unchanged. That session is taken from the workspace's own name, never from anything in the request, so a sandbox can only ever reach its own session. Inside the session, a token issued for one turn is what opens the channel, and it stops working when the turn ends.

The sandbox MCP client, `mcp_client.py`, gained an HTTP mode for this, selected by environment variables and written against the Python standard library alone. The NATS mode the Node deployments use is unchanged, and so is the client's public surface: `from mcp_client import call_tool` and the `mcp-client` CLI behave the same on every provider. Reply handling is now shared between the two modes, so an invalid request or a transport failure reads the same wherever it happened.

Because the container's outbound HTTPS is now terminated by Cloudflare, the sandbox image starts through an entrypoint that installs the certificate authority Cloudflare mints for it before handing over to the workspace runtime. Without that, every HTTPS call from a sandbox — a skill clone included — would fail to verify.
