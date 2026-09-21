import type { Logger } from '@truefoundry/trueforge-core/core/util/logger';
import { EgressCaTrust } from '../../src/workers/sandbox/egressCaTrust';

/** Stands in for the workspace: scripted helper results and a container exit the test can flip. */
class FakeContainer {
  helperRuns = 0;
  exited = false;
  results: ({ exitCode: number; output: string } | Error)[] = [];
  readonly errors: string[] = [];

  trust(): EgressCaTrust {
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: message => {
        this.errors.push(message);
      },
      child: () => logger,
    };
    return new EgressCaTrust({
      runHelper: () => {
        this.helperRuns += 1;
        // A command runs in a fresh container once the old one has exited.
        this.exited = false;
        const next = this.results.shift() ?? { exitCode: 0, output: '' };
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
      containerHasExited: () => Promise.resolve(this.exited),
      logger,
    });
  }
}

const MISSING_CA = { exitCode: 3, output: 'trueforge: no Cloudflare egress CA' };

describe('EgressCaTrust', () => {
  it('asks a container once the CA is trusted', async () => {
    const container = new FakeContainer();
    const trust = container.trust();

    await trust.ensure();
    await trust.ensure();

    expect(container.helperRuns).toBe(1);
    expect(container.errors).toHaveLength(0);
  });

  it('does not retry a container whose CA never appeared, and logs it once', async () => {
    const container = new FakeContainer();
    container.results = [MISSING_CA, MISSING_CA];
    const trust = container.trust();

    await trust.ensure();
    await trust.ensure();
    await trust.ensure();

    expect(container.helperRuns).toBe(1);
    expect(container.errors).toEqual([
      'The sandbox does not trust the Cloudflare egress CA; its HTTPS requests will fail',
    ]);
  });

  it('asks again once the container has exited, since the next one has a CA of its own', async () => {
    const container = new FakeContainer();
    container.results = [MISSING_CA, { exitCode: 0, output: '' }];
    const trust = container.trust();

    await trust.ensure();
    container.exited = true;
    await trust.ensure();
    await trust.ensure();

    expect(container.helperRuns).toBe(2);
    expect(container.errors).toHaveLength(1);
  });

  it('tries again on the next command when the helper could not run at all', async () => {
    const container = new FakeContainer();
    container.results = [new Error('container failed to start'), { exitCode: 0, output: '' }];
    const trust = container.trust();

    await trust.ensure();
    await trust.ensure();
    await trust.ensure();

    expect(container.helperRuns).toBe(2);
    expect(container.errors).toEqual(['Could not check that the sandbox trusts the Cloudflare egress CA']);
  });
});
