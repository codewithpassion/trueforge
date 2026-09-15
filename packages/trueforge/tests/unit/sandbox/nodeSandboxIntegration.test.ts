import { createNodeSandboxIntegration, localSandboxSessionSegment } from '../../../src/sandbox/nodeSandboxIntegration';

describe('localSandboxSessionSegment', () => {
  it('keeps a single-segment session id and rejects missing or unsafe values', () => {
    expect(localSandboxSessionSegment('sess_1')).toBe('sess_1');
    expect(localSandboxSessionSegment(undefined)).toBe('_');
    expect(localSandboxSessionSegment('')).toBe('_');
    expect(localSandboxSessionSegment('a/b')).toBe('_');
    expect(localSandboxSessionSegment('..')).toBe('_');
    expect(localSandboxSessionSegment('foo..bar')).toBe('_');
  });
});

describe('createNodeSandboxIntegration', () => {
  it('enables the local fallback only for a supported standalone probe', () => {
    expect(createNodeSandboxIntegration({ localSupport: undefined }).isLocalFallbackEnabled()).toBe(false);
    expect(
      createNodeSandboxIntegration({
        localSupport: { supported: false, reason: 'no bubblewrap' },
      }).isLocalFallbackEnabled(),
    ).toBe(false);
    expect(
      createNodeSandboxIntegration({
        localSupport: { supported: true, platform: 'darwin', shell: '/bin/bash', python: '/usr/bin/python3' },
      }).isLocalFallbackEnabled(),
    ).toBe(true);
  });
});
