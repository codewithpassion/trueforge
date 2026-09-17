import { SANDBOX_IMAGE_URI } from '@truefoundry/trueforge-core/core/sandbox/sandboxImage';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const packageDir = path.join(__dirname, '../../..');
const dockerfile = readFileSync(path.join(packageDir, 'workers/computer.Dockerfile'), 'utf8');
const entrypoint = readFileSync(path.join(packageDir, 'workers/computer-entrypoint.sh'), 'utf8');

interface BaseImage {
  /** Everything before `@sha256:` — what the version and URI pins are compared against. */
  reference: string;
  digest: string | undefined;
}

function fromImages(): BaseImage[] {
  return [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map(match => {
    const [reference = '', digest] = (match[1] ?? '').split('@');
    return { reference, digest };
  });
}

function references(): string[] {
  return fromImages().map(image => image.reference);
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
    expect(references()).toContain(SANDBOX_IMAGE_URI);
  });

  it('pins computerd to the exact @cloudflare/computer version', () => {
    expect(computerVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(references()).toContain(`ghcr.io/cloudflare/computer-computerd-linux-x64:${computerVersion()}`);
  });

  it('pins every base by digest, so a moved tag cannot change the build', () => {
    const images = fromImages();
    expect(images).not.toHaveLength(0);
    for (const image of images) {
      expect(image.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('mounts the workspace where the provider expects it', () => {
    expect(dockerfile).toContain('ENV MOUNT_POINT=/workspace');
  });

  it('starts through the entrypoint that trusts the egress CA', () => {
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/trueforge-entrypoint"]');
    expect(dockerfile).toContain('COPY computer-entrypoint.sh /usr/local/bin/trueforge-entrypoint');
  });
});

describe('workers/computer-entrypoint.sh', () => {
  it('installs the CA Cloudflare mints for intercepted HTTPS into the system trust store', () => {
    expect(entrypoint).toContain('/etc/cloudflare/certs/cloudflare-containers-ca.crt');
    expect(entrypoint).toContain('/usr/local/share/ca-certificates/cloudflare-containers-ca.crt');
    expect(entrypoint).toContain('update-ca-certificates');
  });

  it('becomes computerd, so nothing is left between the platform and the runtime', () => {
    expect(entrypoint).toContain('exec /usr/local/bin/computerd "$@"');
  });

  it('starts anyway when no CA appears, because direct egress needs none', () => {
    expect(entrypoint).not.toContain('exit 1');
  });
});
