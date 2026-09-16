import {
  SandboxFileNotFoundError,
  SandboxFileTooLargeError,
  SandboxPathIsDirectoryError,
} from '@truefoundry/trueforge-core/core/sandbox/SandboxErrors';
import { env } from 'cloudflare:workers';
import { CloudflareComputerProvider } from '../../src/workers/sandbox/CloudflareComputerProvider';

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
