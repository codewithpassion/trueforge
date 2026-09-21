---
'@truefoundry/trueforge': patch
---

The built-in Cloudflare sandbox can now be turned on from Settings. On a Workers deploy, Settings → Sandbox providers offered only Daytona, whose `PUT` answers 422 on that runtime, and the built-in sandbox could be switched on only by redeploying with `TRUEFORGE_SANDBOX_BACKEND=cloudflare-computer`. The deploy variable now means the provider is *available*; a tenant enables it by saving a sandbox provider of the new type `cloudflare-computer`, which takes no credentials and is ready at once. With the variable unset nothing is offered and the sandbox stays off.

`GET /api/v1/catalogs/sandbox-providers` now answers for the runtime it is running on: the shipped Daytona presets where Daytona can run, the built-in entry where it can, and an empty list otherwise. `SandboxProviderManifest` and `CatalogSandboxProvider` are discriminated unions over the provider type, and the stored manifest gained the same member (existing Daytona rows are untouched and need no migration).

`DELETE /api/v1/settings/sandbox-providers` is new, so a configured provider can be removed. It is also what backs the settings section's "Remove" action on Node, which until now had no route behind it.

"Is a sandbox configured" is answered in one place. `GET /api/v1/capabilities`, the agent-spec validator, and turn-time provider resolution all go through the runtime sandbox port, so a capability endpoint can no longer report a sandbox the validator rejects.
