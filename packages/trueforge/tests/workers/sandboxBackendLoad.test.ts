import { Workspace, WorkspaceProxy } from '@cloudflare/computer';
import { CloudflareContainerBackend, withWorkspaceContainer } from '@cloudflare/computer/backends/container';
import { Daytona } from '@daytona/sdk';

/**
 * Only the worker-shell and worker-javascript backends need the `experimental` flag; this Worker
 * sets `nodejs_compat` alone (tests/workers/wrangler.jsonc), so these imports fail if that changes.
 */
describe('@cloudflare/computer load check', () => {
  it('loads the workspace entrypoint in workerd', () => {
    expect(typeof Workspace).toBe('function');
    expect(typeof WorkspaceProxy).toBe('function');
  });

  it('loads the container backend without the experimental flag', () => {
    expect(typeof CloudflareContainerBackend).toBe('function');
    expect(typeof withWorkspaceContainer).toBe('function');
  });
});

/** Kept as the standing evidence for a bring-your-own-Daytona provider on Workers. */
describe('@daytona/sdk load check', () => {
  it('loads in workerd', () => {
    expect(typeof Daytona).toBe('function');
  });
});
