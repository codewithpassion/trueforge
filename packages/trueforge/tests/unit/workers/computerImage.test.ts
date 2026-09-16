import { SANDBOX_IMAGE_URI } from '@truefoundry/trueforge-core/core/sandbox/sandboxImage';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const packageDir = path.join(__dirname, '../../..');
const dockerfile = readFileSync(path.join(packageDir, 'workers/computer.Dockerfile'), 'utf8');

function fromImages(): string[] {
  return [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map(match => match[1] ?? '');
}

function computerVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  if (typeof manifest !== 'object' || manifest === null || !('dependencies' in manifest)) {
    throw new Error('package.json has no dependencies');
  }
  const { dependencies } = manifest;
  if (typeof dependencies !== 'object' || dependencies === null || !('@cloudflare/computer' in dependencies)) {
    throw new Error('package.json does not depend on @cloudflare/computer');
  }
  const version: unknown = dependencies['@cloudflare/computer'];
  if (typeof version !== 'string') {
    throw new Error('@cloudflare/computer version must be a string');
  }
  return version;
}

describe('workers/computer.Dockerfile', () => {
  it('builds on the release sandbox image', () => {
    expect(fromImages()).toContain(SANDBOX_IMAGE_URI);
  });

  it('pins computerd to the exact @cloudflare/computer version', () => {
    expect(computerVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fromImages()).toContain(`ghcr.io/cloudflare/computer-computerd-linux-x64:${computerVersion()}`);
  });

  it('mounts the workspace where the provider expects it', () => {
    expect(dockerfile).toContain('ENV MOUNT_POINT=/workspace');
  });
});
