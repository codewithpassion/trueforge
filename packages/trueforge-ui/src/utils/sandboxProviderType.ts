import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';

/** The deploy's built-in sandbox: no credentials, nothing to tune. Tied to the generated wire type. */
export const CLOUDFLARE_COMPUTER_SANDBOX_TYPE: TrueForgeApi.CloudflareComputerSandboxProvider['type'] =
  'cloudflare-computer';
