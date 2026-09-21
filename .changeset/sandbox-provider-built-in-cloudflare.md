---
'@truefoundry/trueforge': patch
---

The built-in Cloudflare sandbox can now be turned on from Settings. On a Workers deploy, Settings → Sandbox providers offered only Daytona, whose `PUT` answers 422 on that runtime, and the built-in sandbox could be switched on only by redeploying with `TRUEFORGE_SANDBOX_BACKEND=cloudflare-computer`. The deploy variable now means the provider is *available*; a tenant enables it by saving a sandbox provider of the new type `cloudflare-computer`, which takes no credentials and is ready at once. With the variable unset nothing is offered and the sandbox stays off.

**Action required on a Workers deploy that already sets `TRUEFORGE_SANDBOX_BACKEND`.** The variable alone no longer enables the sandbox. After upgrading, an admin must open Settings → Sandbox providers and click Enable. Until they do, `GET /api/v1/capabilities` reports the sandbox off and a saved sandbox-enabled agent answers 422 with "no sandbox provider is configured". Node deployments are unaffected.

`GET /api/v1/catalogs/sandbox-providers` now answers for the runtime it is running on: the shipped Daytona presets where Daytona can run, the built-in entry where it can, and an empty list otherwise. `SandboxProviderManifest` and `CatalogSandboxProvider` are discriminated unions over the provider type, and the stored manifest gained the same member (existing Daytona rows are untouched and need no migration). A stored provider this runtime cannot run — a `cloudflare-computer` row in a Node database, say — now reads as no provider at all rather than being reported Ready.

`DELETE /api/v1/settings/sandbox-providers` is new, so a configured provider can be removed. It is also what backs the settings section's "Remove" action on Node, which until now had no route behind it. Removing a provider deletes the stored credentials; sandboxes already running in the provider account are left to that provider's own auto-stop and auto-delete schedule.

"Is a sandbox usable?" is answered in one place. `GET /api/v1/capabilities` and the agent-spec validator both call the runtime sandbox port, so neither can admit what the other refuses. One behaviour change falls out of that: a spec with `sandbox.enabled` is now rejected while the provider's image build is pending or failed, instead of being accepted and then failing at turn time.
