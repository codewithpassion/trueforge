/** Bindings of the throwaway spike Worker. Deployed separately from the product Worker. */
export interface SpikeEnv {
  readonly REMOTE_COMPUTER_DO: DurableObjectNamespace<import('./RemoteComputerDO').RemoteComputerDO>;
  readonly CALLER_DO: DurableObjectNamespace<import('./CallerDO').CallerDO>;
  /** Guards every test route; set with `wrangler secret put`. */
  readonly SPIKE_SECRET: string;
  /** Presented by the client as a bearer credential on `/connect`. */
  readonly SPIKE_CLIENT_TOKEN: string;
}
