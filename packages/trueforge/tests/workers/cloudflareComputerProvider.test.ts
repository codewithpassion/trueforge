import {
  SandboxFileNotFoundError,
  SandboxFileTooLargeError,
  SandboxNotAvailableError,
  SandboxPathIsDirectoryError,
} from '@truefoundry/trueforge-core/core/sandbox/SandboxErrors';

import type { SandboxProvider } from '@truefoundry/trueforge-core/core/sandbox/provider/Provider';
import { CloudflareComputerProvider } from '../../src/workers/sandbox/CloudflareComputerProvider';
import type { ComputerReadOutcome, ComputerWorkspace } from '../../src/workers/sandbox/ComputerDO';
import { COMPLETED_EXEC as COMPLETED, FakeComputer } from './harness';

const SANDBOX_ID = 'tenant-1:session-1';
const MAX_DOWNLOAD_BYTES = 1024;

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 1));
      controller.enqueue(bytes.subarray(1));
      controller.close();
    },
  });
}

/** The contract type, because `Sandbox` calls the path getters with an id it may not have yet. */
function buildAsContract(computer: ComputerWorkspace): SandboxProvider {
  return build(computer);
}

function build(computer: ComputerWorkspace): CloudflareComputerProvider {
  return new CloudflareComputerProvider({
    computer,
    sandboxId: SANDBOX_ID,
    defaultExecTimeoutSeconds: 30,
    fileMaxBytesForDownload: MAX_DOWNLOAD_BYTES,
    codeModeRegistry: undefined,
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
    computer.exec = { ...COMPLETED, output: 'out' };
    const result = await build(computer).exec({ sandboxId: SANDBOX_ID, command: 'ls' });
    expect(computer.execCalls).toEqual([{ command: 'ls', cwd: '/workspace', env: {}, timeoutMs: 30_000 }]);
    expect(result).toEqual({ success: true, response: { exitCode: 0, result: 'out' } });
  });

  // Computer calls every non-zero exit `failed`, so a shell error used to read as a broken sandbox.
  it('reports a non-zero exit as a result with its exit code, the way the Node providers do', async () => {
    const computer = new FakeComputer();
    computer.exec = { ...COMPLETED, status: 'failed', exitCode: 3, output: 'OUTLINE\nERRLINE\n' };
    await expect(build(computer).exec({ sandboxId: SANDBOX_ID, command: 'x' })).resolves.toEqual({
      success: true,
      response: { exitCode: 3, result: 'OUTLINE\nERRLINE\n' },
    });
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

  it('reports a cancelled command as an infrastructure failure', async () => {
    const computer = new FakeComputer();
    computer.exec = { ...COMPLETED, status: 'cancelled', exitCode: 137, output: 'boom' };
    await expect(build(computer).exec({ sandboxId: SANDBOX_ID, command: 'x' })).resolves.toEqual({
      success: false,
      error: 'Sandbox exec timed out after 30s',
    });
  });

  // No exit event means nothing launched, which is the only `failed` the caller must not read as output.
  it('reports a command that never ran as an infrastructure failure', async () => {
    const computer = new FakeComputer();
    computer.exec = { ...COMPLETED, status: 'failed', exitCode: -1, output: 'boom' };
    await expect(build(computer).exec({ sandboxId: SANDBOX_ID, command: 'x' })).resolves.toEqual({
      success: false,
      error: 'Sandbox exec did not run: boom',
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

  // Captured live in Section 9 of the sandbox plan: the limit is named only at the tail of a
  // transport string that opens with a health-check timeout.
  it('names the instance limit when the platform refuses to start another container', async () => {
    const computer = new FakeComputer();
    computer.exec = new Error(
      'Workspace backend "container-shell": shell.exec failed after 1 reconnect retry: ' +
        'initial=CloudflareContainerBackend(container-shell): connect failed at stage=health ' +
        'port=8080 attempt=2/2 restarts=1 timeoutMs=30000 lastError=container exited: ' +
        'Maximum number of running container instances exceeded. Try again later, or try configuring a higher limit.',
    );
    // A failed command, not a gone sandbox: the workspace is intact, so nothing should recreate it.
    await expect(build(computer).exec({ sandboxId: SANDBOX_ID, command: 'x' })).resolves.toEqual({
      success: false,
      error:
        'No sandbox could start: the deploy is already running its max_instances limit of containers. Retry in a few minutes.',
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
    await expect(provider.downloadFile({ sandboxId: 'tenant-2:session-9', path: '/a' })).rejects.toBeInstanceOf(
      SandboxNotAvailableError,
    );
    await expect(
      provider.uploadFile({ sandboxId: 'tenant-2:session-9', remotePath: '/a', content: Buffer.from('x') }),
    ).rejects.toBeInstanceOf(SandboxNotAvailableError);
  });

  it('describes the workspace layout before a sandbox exists, when the prompt id is still empty', () => {
    // Sandbox.ts builds the uploads and skills prompt sections with an empty id on a first turn.
    const sandbox = buildAsContract(new FakeComputer());
    expect(sandbox.getFileUploadsDir('')).toBe('/workspace/uploads');
    expect(sandbox.getSkillsDir('')).toBe('/workspace/.trueforge/skills');
    expect(sandbox.getToolResultDumpDir('')).toBe('/workspace/.trueforge/tool-results');
    expect(sandbox.getSkillDownloaderPath('')).toBe('/workspace/.trueforge/bin/skill_downloader.py');
    expect(sandbox.getGitCredentialsPath('')).toBe('/workspace/.trueforge/git-credentials');
  });

  it('does not offer Code Mode, so the core sandbox never asks for a transport', () => {
    expect(build(new FakeComputer()).supportsCodeMode).toBe(false);
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
    const provider = buildAsContract(new FakeComputer());
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

  it('reports no Code Mode on a runtime that serves no bridge', () => {
    const provider = build(new FakeComputer());

    expect(provider.supportsCodeMode).toBe(false);
    expect(() => provider.createCodeModeTransport()).toThrow('runtime that serves the sandbox bridge');
  });
});
