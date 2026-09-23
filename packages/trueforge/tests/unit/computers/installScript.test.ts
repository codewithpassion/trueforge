/**
 * The installer runs as `sh` on someone else's machine, so it is executed here rather than only
 * read: a PATH of stubs stands in for the machine, and a fake client records how it was called.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DESKTOP_APT_LINE, renderInstallScript } from '../../../src/computers/installScript';

const script = renderInstallScript({
  baseUrl: 'https://trueforge.example.com',
  releaseBaseUrl: 'https://releases.example.com/computer',
});

const DESKTOP_TOOLS = ['Xvfb', 'openbox', 'xterm', 'chromium', 'xdotool', 'xclip'];

let bin: string;

function stub(name: string, body: string): void {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

function linkRealTool(name: string): void {
  const real = ['/bin', '/usr/bin'].map(dir => path.join(dir, name)).find(candidate => existsSync(candidate));
  if (real === undefined) {
    throw new Error(`${name} is not in /bin or /usr/bin`);
  }
  symlinkSync(real, path.join(bin, name));
}

/** Runs the installer on a pretend Linux box whose PATH holds only the named extra tools. */
function install({ args, tools }: { args: string[]; tools: string[] }) {
  for (const tool of tools) {
    stub(tool, 'exit 0');
  }
  return spawnSync('/bin/sh', ['-s', '--', '--code', 'enroll-me', '--insecure-skip-verify', ...args], {
    input: script,
    encoding: 'utf8',
    env: { PATH: bin, HOME: path.join(bin, 'home') },
  });
}

/** Every invocation of the installed client, one line of arguments each. */
function clientCalls(): string[] {
  const log = path.join(bin, 'client-calls');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
}

beforeEach(() => {
  bin = mkdtempSync(path.join(tmpdir(), 'install-sh-'));
  for (const tool of ['chmod', 'grep', 'mkdir', 'mktemp', 'mv', 'readlink', 'rm']) {
    linkRealTool(tool);
  }
  stub('id', 'case "$1" in -u) echo 1000 ;; *) echo tester ;; esac');
  stub('uname', 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac');
  // The "download" is a client that only records how it was called.
  stub(
    'curl',
    [
      'while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done',
      `printf '#!/bin/sh\\necho "$*" >> ${bin}/client-calls\\n' > "$out"`,
    ].join('\n'),
  );
});

afterEach(() => {
  rmSync(bin, { recursive: true, force: true });
});

describe('install.sh', () => {
  it('is valid POSIX sh', () => {
    const check = spawnSync('/bin/sh', ['-n'], { input: script, encoding: 'utf8' });
    expect(check.status).toBe(0);
    expect(check.stderr).toBe('');
  });

  it('without --desktop does not look for the desktop programs or pass the flag', () => {
    const run = install({ args: [], tools: [] });
    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain('apt-get');
    expect(clientCalls()).toEqual(['enroll --url https://trueforge.example.com', 'run']);
  });

  it('with --desktop names the missing programs and the apt-get line, and stops', () => {
    const run = install({ args: ['--desktop'], tools: ['Xvfb', 'openbox', 'xterm'] });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('does not have: chromium xdotool xclip');
    expect(run.stderr).toContain('supported on Debian only');
    expect(run.stderr).toContain(DESKTOP_APT_LINE);
    expect(DESKTOP_APT_LINE).toBe('sudo apt-get install -y xvfb openbox xterm chromium xdotool xclip');
    expect(clientCalls()).toEqual([]);
  });

  it('with --desktop and every program present enrolls with --desktop, which the config keeps', () => {
    const run = install({ args: ['--desktop'], tools: DESKTOP_TOOLS });
    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain('apt-get');
    expect(clientCalls()).toEqual(['enroll --url https://trueforge.example.com --desktop', 'run']);
  });

  it("with --desktop refuses Ubuntu's chromium stub, which only asks for the snap", () => {
    stub('chromium', `echo "Command '$0' requires the chromium snap to be installed." >&2\nexit 1`);
    const run = install({ args: ['--desktop'], tools: DESKTOP_TOOLS.filter(tool => tool !== 'chromium') });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("is Ubuntu's snap");
    expect(run.stderr).toContain('supported on Debian only');
    expect(clientCalls()).toEqual([]);
  });

  it('with --desktop refuses a chromium that resolves to the snap launcher', () => {
    stub('snap', 'exit 0');
    symlinkSync(path.join(bin, 'snap'), path.join(bin, 'chromium'));
    const run = install({ args: ['--desktop'], tools: DESKTOP_TOOLS.filter(tool => tool !== 'chromium') });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("is Ubuntu's snap");
    expect(clientCalls()).toEqual([]);
  });

  it('with --desktop refuses a machine that is not Linux', () => {
    stub('uname', 'case "$1" in -s) echo Darwin ;; -m) echo arm64 ;; esac');
    const run = install({ args: ['--desktop'], tools: DESKTOP_TOOLS });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--desktop is only supported on Linux.');
    expect(clientCalls()).toEqual([]);
  });
});
