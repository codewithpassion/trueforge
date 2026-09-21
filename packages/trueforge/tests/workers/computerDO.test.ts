import {
  SandboxFileNotFoundError,
  SandboxFileTooLargeError,
  SandboxPathIsDirectoryError,
} from '@truefoundry/trueforge-core/core/sandbox/SandboxErrors';
import { env } from 'cloudflare:workers';
import { CloudflareComputerProvider } from '../../src/workers/sandbox/CloudflareComputerProvider';
import { capOutput, COMPUTER_EXEC_OUTPUT_MAX_BYTES, withTlsTrustEnv } from '../../src/workers/sandbox/ComputerDO';
import { COMPUTER_CA_BUNDLE, COMPUTER_TLS_TRUST_ENV } from '../../src/workers/sandbox/computerPaths';

/**
 * Drives the real Durable Object over real RPC. The container backend connects lazily, so the
 * filesystem half runs against the object's own SQLite without Docker; `execCommand` needs a
 * container and is covered on the deploy instead.
 */
function computer(name: string) {
  return env.COMPUTER_DO.get(env.COMPUTER_DO.idFromName(name));
}

function provider(name: string) {
  return new CloudflareComputerProvider({
    computer: computer(name),
    sandboxId: name,
    defaultExecTimeoutSeconds: 30,
    fileMaxBytesForDownload: 64,
    codeModeRegistry: undefined,
  });
}

describe('ComputerDO over Workers RPC', () => {
  it('writes and reads a file back through the workspace store', async () => {
    const workspace = computer('tenant-1:rpc-round-trip');
    await workspace.writeFile({
      path: '/workspace/uploads/a.txt',
      content: new TextEncoder().encode('hello workspace'),
    });

    const read = await workspace.readFile({ path: '/workspace/uploads/a.txt', maxBytes: 1024 });
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(read.size).toBe(15);
    await expect(new Response(read.content).text()).resolves.toBe('hello workspace');
  });

  it('keeps a file across separate RPC calls and separate stubs', async () => {
    await computer('tenant-1:rpc-persist').writeFile({
      path: '/workspace/keep.txt',
      content: new TextEncoder().encode('kept'),
    });
    const read = await computer('tenant-1:rpc-persist').readFile({ path: '/workspace/keep.txt', maxBytes: 1024 });
    expect(read.ok && (await new Response(read.content).text())).toBe('kept');
  });

  it('isolates one workspace from another', async () => {
    await computer('tenant-1:rpc-a').writeFile({
      path: '/workspace/only-a.txt',
      content: new TextEncoder().encode('a'),
    });
    const other = await computer('tenant-2:rpc-b').readFile({ path: '/workspace/only-a.txt', maxBytes: 1024 });
    expect(other).toEqual({ ok: false, reason: 'not_found' });
  });

  it('classifies a missing path, a directory and an oversized file', async () => {
    const workspace = computer('tenant-1:rpc-errors');
    await workspace.writeFile({ path: '/workspace/dir/x.txt', content: new TextEncoder().encode('x') });
    await workspace.writeFile({ path: '/workspace/big.txt', content: new TextEncoder().encode('0123456789') });

    expect(await workspace.readFile({ path: '/workspace/gone.txt', maxBytes: 1024 })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await workspace.readFile({ path: '/workspace/dir', maxBytes: 1024 })).toEqual({
      ok: false,
      reason: 'is_directory',
    });
    expect(await workspace.readFile({ path: '/workspace/big.txt', maxBytes: 4 })).toEqual({
      ok: false,
      reason: 'too_large',
      size: 10,
    });
  });
});

describe('CloudflareComputerProvider against the real Durable Object', () => {
  it('round-trips an upload through the provider contract', async () => {
    const sandbox = provider('tenant-1:provider-round-trip');
    await sandbox.uploadFile({
      sandboxId: 'tenant-1:provider-round-trip',
      remotePath: '/workspace/uploads/report.json',
      content: Buffer.from('{"ok":true}'),
    });
    const downloaded = await sandbox.downloadFile({
      sandboxId: 'tenant-1:provider-round-trip',
      path: '/workspace/uploads/report.json',
    });
    expect(downloaded.toString()).toBe('{"ok":true}');
  });

  it('maps the workspace read failures to the sandbox error classes', async () => {
    const sandboxId = 'tenant-1:provider-errors';
    const sandbox = provider(sandboxId);
    await sandbox.uploadFile({
      sandboxId,
      remotePath: '/workspace/deep/file.txt',
      content: Buffer.alloc(128, 1),
    });

    await expect(sandbox.downloadFile({ sandboxId, path: '/workspace/missing.txt' })).rejects.toBeInstanceOf(
      SandboxFileNotFoundError,
    );
    await expect(sandbox.downloadFile({ sandboxId, path: '/workspace/deep' })).rejects.toBeInstanceOf(
      SandboxPathIsDirectoryError,
    );
    await expect(sandbox.downloadFile({ sandboxId, path: '/workspace/deep/file.txt' })).rejects.toBeInstanceOf(
      SandboxFileTooLargeError,
    );
  });
});

describe('exec output cap', () => {
  it('stays under the RPC message limit', () => {
    // A serialized Workers RPC message caps at 32 MiB; the output must not be able to reach it.
    expect(COMPUTER_EXEC_OUTPUT_MAX_BYTES).toBeLessThan(32 * 1024 * 1024);
    expect(COMPUTER_EXEC_OUTPUT_MAX_BYTES).toBe(1024 * 1024);
  });

  it('passes a small output through untouched', () => {
    expect(capOutput('hello')).toEqual({ output: 'hello', outputTruncated: false });
  });

  it('cuts an oversized output and says where to find the rest', () => {
    const capped = capOutput('x'.repeat(COMPUTER_EXEC_OUTPUT_MAX_BYTES + 2048));
    expect(capped.outputTruncated).toBe(true);
    expect(capped.output).toContain('[output truncated at 1048576 bytes of 1050624');
    expect(capped.output).toContain('/workspace');
    expect(new TextEncoder().encode(capped.output).byteLength).toBeLessThan(COMPUTER_EXEC_OUTPUT_MAX_BYTES + 512);
  });

  it('cuts inside a character without corrupting the text before it', () => {
    // 3-byte characters and a limit that is not a multiple of 3 put the cut inside a code point.
    expect(COMPUTER_EXEC_OUTPUT_MAX_BYTES % 3).not.toBe(0);
    const capped = capOutput('\u20ac'.repeat(COMPUTER_EXEC_OUTPUT_MAX_BYTES));
    expect(capped.outputTruncated).toBe(true);
    expect(capped.output.startsWith('\u20ac\u20ac')).toBe(true);
    expect(capped.output).toContain('[output truncated at');
  });
});

describe('withTlsTrustEnv', () => {
  it('points every TLS client in the image at the system bundle', () => {
    const merged = withTlsTrustEnv({});
    for (const name of [
      'SSL_CERT_FILE',
      'REQUESTS_CA_BUNDLE',
      'CURL_CA_BUNDLE',
      'GIT_SSL_CAINFO',
      'PIP_CERT',
      'NODE_EXTRA_CA_CERTS',
    ]) {
      expect(merged[name]).toBe(COMPUTER_CA_BUNDLE);
    }
  });

  it('keeps the command env and lets no caller override the trust settings', () => {
    const merged = withTlsTrustEnv({ TFY_CM_HTTP_TOKEN: 'token', SSL_CERT_FILE: '/dev/null', NODE_EXTRA_CA_CERTS: '' });
    expect(merged).toEqual({ TFY_CM_HTTP_TOKEN: 'token', ...COMPUTER_TLS_TRUST_ENV });
  });
});
