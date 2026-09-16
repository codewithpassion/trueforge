import {
  SandboxFileNotFoundError,
  SandboxFileTooLargeError,
  SandboxNotAvailableError,
  SandboxPathIsDirectoryError,
} from '@truefoundry/trueforge-core/core/sandbox/SandboxErrors';

import { CloudflareComputerProvider } from '../../src/workers/sandbox/CloudflareComputerProvider';
import type {
  ComputerExecOutcome,
  ComputerExecRequest,
  ComputerReadOutcome,
  ComputerWorkspace,
} from '../../src/workers/sandbox/ComputerDO';

const SANDBOX_ID = 'tenant-1:session-1';
const MAX_DOWNLOAD_BYTES = 1024;

const COMPLETED: ComputerExecOutcome = {
  status: 'completed',
  exitCode: 0,
  output: '',
  syncPending: false,
  syncError: undefined,
};

class FakeComputer implements ComputerWorkspace {
  readonly execCalls: ComputerExecRequest[] = [];
  readonly writes: { path: string; content: Uint8Array }[] = [];
  exec: ComputerExecOutcome | Error = COMPLETED;
  read: ComputerReadOutcome | Error = { ok: false, reason: 'not_found' };
  writeError: Error | undefined;

  execCommand(request: ComputerExecRequest): Promise<ComputerExecOutcome> {
    this.execCalls.push(request);
    return this.exec instanceof Error ? Promise.reject(this.exec) : Promise.resolve(this.exec);
  }

  writeFile(request: { path: string; content: Uint8Array }): Promise<void> {
    if (this.writeError !== undefined) {
      return Promise.reject(this.writeError);
    }
    this.writes.push(request);
    return Promise.resolve();
  }

  readFile(_request: { path: string; maxBytes: number }): Promise<ComputerReadOutcome> {
    return this.read instanceof Error ? Promise.reject(this.read) : Promise.resolve(this.read);
  }
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 1));
      controller.enqueue(bytes.subarray(1));
      controller.close();
    },
  });
}

function build(computer: ComputerWorkspace): CloudflareComputerProvider {
  return new CloudflareComputerProvider({
    computer,
    sandboxId: SANDBOX_ID,
    defaultExecTimeoutSeconds: 30,
    fileMaxBytesForDownload: MAX_DOWNLOAD_BYTES,
  });
}

describe('CloudflareComputerProvider', () => {
  it('reports the workspace it was built for and a ready image', async () => {
    const provider = build(new FakeComputer());
    await expect(provider.createSandbox()).resolves.toEqual({ sandboxId: SANDBOX_ID });
    await expect(provider.buildImage()).resolves.toEqual({ status: 'ready', reason: null, metadata: null });
    await expect(provider.getImageBuildStatus()).resolves.toEqual({ status: 'ready', reason: null, metadata: null });
    expect(provider.type).toBe('cloudflare-computer');
  });

  it('runs a command in the workspace root with the default timeout', async () => {
    const computer = new FakeComputer();
    computer.exec = { ...COMPLETED, exitCode: 2, output: 'out' };
    const result = await build(computer).exec({ sandboxId: SANDBOX_ID, command: 'ls' });
    expect(computer.execCalls).toEqual([{ command: 'ls', cwd: '/workspace', env: {}, timeoutMs: 30_000 }]);
    expect(result).toEqual({ success: true, response: { exitCode: 2, result: 'out' } });
  });

  it('passes the caller cwd, env and timeout through', async () => {
    const computer = new FakeComputer();
    await build(computer).exec({
      sandboxId: SANDBOX_ID,
      command: 'ls',
      cwd: '/workspace/uploads',
      env: { A: 'b' },
      timeoutSeconds: 5,
    });
    expect(computer.execCalls[0]).toEqual({
      command: 'ls',
      cwd: '/workspace/uploads',
      env: { A: 'b' },
      timeoutMs: 5_000,
    });
  });

  it('joins stdout and stderr into the exec result', async () => {
    const computer = new FakeComputer();
    computer.exec = { ...COMPLETED, output: 'stdout-partstderr-part' };
    await expect(build(computer).exec({ sandboxId: SANDBOX_ID, command: 'x' })).resolves.toEqual({
      success: true,
      response: { exitCode: 0, result: 'stdout-partstderr-part' },
    });
  });

  it.each([
    ['cancelled' as const, 'Sandbox exec timed out after 30s'],
    ['failed' as const, 'Sandbox exec did not run: boom'],
  ])('reports a %s command as an infrastructure failure', async (status, error) => {
    const computer = new FakeComputer();
    computer.exec = { ...COMPLETED, status, output: 'boom' };
    await expect(build(computer).exec({ sandboxId: SANDBOX_ID, command: 'x' })).resolves.toEqual({
      success: false,
      error,
    });
  });

  it('reports an incomplete filesystem sync as a failure', async () => {
    const computer = new FakeComputer();
    computer.exec = { ...COMPLETED, syncPending: true, syncError: 'lost' };
    await expect(build(computer).exec({ sandboxId: SANDBOX_ID, command: 'x' })).resolves.toEqual({
      success: false,
      error: 'Sandbox filesystem sync is incomplete: lost',
    });
  });

  it('reports a lost RPC call as a failure rather than throwing', async () => {
    const computer = new FakeComputer();
    computer.exec = new Error('EEXEC_LOST');
    await expect(build(computer).exec({ sandboxId: SANDBOX_ID, command: 'x' })).resolves.toEqual({
      success: false,
      error: 'Sandbox exec failed: EEXEC_LOST',
    });
  });

  it('refuses a sandbox id from another session', async () => {
    const computer = new FakeComputer();
    const provider = build(computer);
    await expect(provider.exec({ sandboxId: 'tenant-2:session-9', command: 'ls' })).rejects.toBeInstanceOf(
      SandboxNotAvailableError,
    );
    expect(computer.execCalls).toEqual([]);
    expect(() => provider.getFileUploadsDir('tenant-2:session-9')).toThrow(SandboxNotAvailableError);
    await expect(provider.downloadFile({ sandboxId: 'tenant-2:session-9', path: '/a' })).rejects.toBeInstanceOf(
      SandboxNotAvailableError,
    );
    await expect(
      provider.uploadFile({ sandboxId: 'tenant-2:session-9', remotePath: '/a', content: Buffer.from('x') }),
    ).rejects.toBeInstanceOf(SandboxNotAvailableError);
  });

  it('uploads a file to the requested path', async () => {
    const computer = new FakeComputer();
    await build(computer).uploadFile({
      sandboxId: SANDBOX_ID,
      remotePath: '/workspace/uploads/a.txt',
      content: Buffer.from('hi'),
    });
    expect(computer.writes).toHaveLength(1);
    expect(computer.writes[0]?.path).toBe('/workspace/uploads/a.txt');
    expect(Buffer.from(computer.writes[0]?.content ?? new Uint8Array()).toString()).toBe('hi');
  });

  it('turns an upload transport failure into a gone sandbox, keeping the cause', async () => {
    const computer = new FakeComputer();
    const cause = new Error('container exited');
    computer.writeError = cause;
    await expect(
      build(computer).uploadFile({ sandboxId: SANDBOX_ID, remotePath: '/a', content: Buffer.from('x') }),
    ).rejects.toMatchObject({ name: 'SandboxNotAvailableError', cause });
  });

  it('downloads a file by draining the stream', async () => {
    const computer = new FakeComputer();
    computer.read = { ok: true, size: 2, content: streamOf(new Uint8Array([104, 105])) };
    const content = await build(computer).downloadFile({ sandboxId: SANDBOX_ID, path: '/workspace/a.txt' });
    expect(content.toString()).toBe('hi');
  });

  it.each([
    [{ ok: false, reason: 'not_found' } satisfies ComputerReadOutcome, SandboxFileNotFoundError],
    [{ ok: false, reason: 'is_directory' } satisfies ComputerReadOutcome, SandboxPathIsDirectoryError],
    [{ ok: false, reason: 'too_large', size: 99_999 } satisfies ComputerReadOutcome, SandboxFileTooLargeError],
  ])('maps read outcome %p to its sandbox error', async (read, expected) => {
    const computer = new FakeComputer();
    computer.read = read;
    await expect(build(computer).downloadFile({ sandboxId: SANDBOX_ID, path: '/a' })).rejects.toBeInstanceOf(expected);
  });

  it('reports the download size cap it was configured with', async () => {
    const computer = new FakeComputer();
    computer.read = { ok: false, reason: 'too_large', size: 5000 };
    await expect(build(computer).downloadFile({ sandboxId: SANDBOX_ID, path: '/a' })).rejects.toMatchObject({
      fileSize: 5000,
      maxSize: MAX_DOWNLOAD_BYTES,
    });
  });

  it('places every well-known directory under the workspace root', () => {
    const provider = build(new FakeComputer());
    expect({
      uploads: provider.getFileUploadsDir(SANDBOX_ID),
      dumps: provider.getToolResultDumpDir(SANDBOX_ID),
      skills: provider.getSkillsDir(SANDBOX_ID),
      downloader: provider.getSkillDownloaderPath(SANDBOX_ID),
      gitCredentials: provider.getGitCredentialsPath(SANDBOX_ID),
    }).toEqual({
      uploads: '/workspace/uploads',
      dumps: '/workspace/.trueforge/tool-results',
      skills: '/workspace/.trueforge/skills',
      downloader: '/workspace/.trueforge/bin/skill_downloader.py',
      gitCredentials: '/workspace/.trueforge/git-credentials',
    });
    expect(provider.getAdditionalInstructions()).toContain('/workspace');
  });

  it('has no Code Mode transport yet', () => {
    expect(() => build(new FakeComputer()).createCodeModeTransport()).toThrow('Code Mode is not available');
  });
});
