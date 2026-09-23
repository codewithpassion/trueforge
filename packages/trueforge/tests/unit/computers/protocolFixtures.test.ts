/**
 * The Go client's golden fixtures, read from where the client owns them rather than copied. They
 * are the other side's idea of the frozen v1 contract, so parsing them here is what proves the two
 * halves still agree — a shape that drifts on either side turns this red.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  CancelRequestSchema,
  CancelResultPayloadSchema,
  classifyClientFrame,
  ClientOpRequestSchema,
  DesktopClipboardGetRequestSchema,
  DesktopClipboardGetResultPayloadSchema,
  DesktopClipboardSetRequestSchema,
  DesktopInputRequestSchema,
  DesktopOkResultPayloadSchema,
  DesktopScreenshotRequestSchema,
  DesktopScreenshotResultPayloadSchema,
  ExecRequestSchema,
  ExecResultPayloadSchema,
  FileGetRequestSchema,
  FileGetResultPayloadSchema,
  FilePutRequestSchema,
  FilePutResultPayloadSchema,
  HelloMessageSchema,
} from '../../../src/computers/protocol';
import { EnrollComputerRequestSchema, EnrollComputerResponseSchema } from '../../../src/schemas/computer';

/** One owner: the client's own testdata, not a copy that can drift out of step with it. */
const FIXTURES = path.join(__dirname, '../../../../trueforge-computer/testdata');

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

function parsed(name: string): unknown {
  return JSON.parse(fixture(name));
}

/** Every fixture this file accounts for. A new one the client adds must be added here too. */
const REQUEST_FIXTURES = [
  ['server_to_client_exec.json', ExecRequestSchema],
  ['server_to_client_exec_null_cwd.json', ExecRequestSchema],
  ['server_to_client_cancel.json', CancelRequestSchema],
  ['server_to_client_file_put_chunk.json', FilePutRequestSchema],
  ['server_to_client_file_put_final.json', FilePutRequestSchema],
  ['server_to_client_file_get.json', FileGetRequestSchema],
] as const;

const REPLY_FIXTURES = [
  ['client_to_server_reply_exec.json', ExecResultPayloadSchema],
  ['client_to_server_reply_cancel.json', CancelResultPayloadSchema],
  ['client_to_server_reply_file_put.json', FilePutResultPayloadSchema],
  ['client_to_server_reply_file_get.json', FileGetResultPayloadSchema],
] as const;

const OTHER_FIXTURES = ['client_to_server_hello.json', 'client_to_server_reply_error.json', 'error_codes.json'];

/**
 * The desktop extension's fixtures. The client publishes them as one set, so either all of them are
 * here or none are, and a partial set is a drift this file catches.
 */
const DESKTOP_REQUEST_FIXTURES = [
  ['server_to_client_desktop_screenshot.json', DesktopScreenshotRequestSchema],
  ['server_to_client_desktop_screenshot_null_quality.json', DesktopScreenshotRequestSchema],
  ['server_to_client_desktop_input.json', DesktopInputRequestSchema],
  ['server_to_client_desktop_clipboard_get.json', DesktopClipboardGetRequestSchema],
  ['server_to_client_desktop_clipboard_set.json', DesktopClipboardSetRequestSchema],
] as const;

const DESKTOP_REPLY_FIXTURES = [
  ['client_to_server_reply_desktop_screenshot.json', DesktopScreenshotResultPayloadSchema],
  ['client_to_server_reply_desktop_input.json', DesktopOkResultPayloadSchema],
  ['client_to_server_reply_desktop_clipboard_get.json', DesktopClipboardGetResultPayloadSchema],
  ['client_to_server_reply_desktop_clipboard_set.json', DesktopOkResultPayloadSchema],
] as const;

const DESKTOP_HELLO_FIXTURES = [
  'client_to_server_hello_desktop.json',
  'client_to_server_hello_desktop_unavailable.json',
];

const DESKTOP_FIXTURES = [
  ...DESKTOP_REQUEST_FIXTURES.map(([name]) => name),
  ...DESKTOP_REPLY_FIXTURES.map(([name]) => name),
  ...DESKTOP_HELLO_FIXTURES,
];

const desktopFixturesPresent = DESKTOP_FIXTURES.some(name => existsSync(path.join(FIXTURES, 'protocol', name)));

describe('every fixture the client publishes is checked here', () => {
  it('leaves none of them unaccounted for', () => {
    const onDisk = readdirSync(path.join(FIXTURES, 'protocol')).sort();
    const covered = [
      ...REQUEST_FIXTURES.map(([name]) => name),
      ...REPLY_FIXTURES.map(([name]) => name),
      ...OTHER_FIXTURES,
      ...(desktopFixturesPresent ? DESKTOP_FIXTURES : []),
    ].sort();
    // A fixture the client adds without a check here is a shape nobody is holding to the contract.
    expect(onDisk).toEqual(covered);
    expect(readdirSync(path.join(FIXTURES, 'enroll')).sort()).toEqual(['request.json', 'response.json']);
  });
});

describe('requests the server sends', () => {
  it.each(REQUEST_FIXTURES)('%s matches its op schema and the op union', (name, schema) => {
    const value = parsed(`protocol/${name}`);
    expect(schema.safeParse(value).success).toBe(true);
    expect(ClientOpRequestSchema.safeParse(value).success).toBe(true);
  });
});

describe('frames the client sends', () => {
  it('hello parses, carries protocol version 1, and is classified as a hello', () => {
    const raw = fixture('protocol/client_to_server_hello.json');
    const hello = HelloMessageSchema.safeParse(JSON.parse(raw));
    expect(hello.success).toBe(true);
    expect(hello.data?.protocol_version).toBe(1);
    // The sessions root is the one thing only the machine can tell the server.
    expect(hello.data?.workdir).toBe('/var/lib/trueforge-computer/sessions');
    expect(classifyClientFrame(raw)).toMatchObject({ kind: 'hello' });
  });

  it.each([
    ["a quote, which would break out of the server's quoting", "/var/lib/x'; rm -rf /; #"],
    ['a newline', '/var/lib/x\nsessions'],
    ['a relative path', 'var/lib/x/sessions'],
    ['a trailing slash, which stops matching the containment check', '/var/lib/x/sessions/'],
    ['a traversal segment', '/var/lib/x/../../etc'],
    ['nothing but the filesystem root', '/'],
    ['more than 1024 characters', `/${'a'.repeat(1024)}`],
  ])('a hostile workdir — %s — is not a hello this server will read', (_why, workdir) => {
    const raw = JSON.stringify({ ...JSON.parse(fixture('protocol/client_to_server_hello.json')), workdir });
    expect(HelloMessageSchema.safeParse(JSON.parse(raw)).success).toBe(false);
    expect(classifyClientFrame(raw)).toEqual({ kind: 'unreadable_hello' });
  });

  it.each(REPLY_FIXTURES)('%s is a reply whose result matches its payload schema', (name, schema) => {
    const frame = classifyClientFrame(fixture(`protocol/${name}`));
    expect(frame.kind).toBe('reply');
    if (frame.kind !== 'reply' || !frame.reply.ok) {
      throw new Error('expected a successful reply');
    }
    expect(schema.safeParse(JSON.parse(frame.reply.result_json)).success).toBe(true);
  });

  it('an error reply keeps the code the client chose, including one the server does not know', () => {
    const frame = classifyClientFrame(fixture('protocol/client_to_server_reply_error.json'));
    expect(frame).toMatchObject({ kind: 'reply', reply: { ok: false, error: { code: 'denied' } } });
  });
});

describe('the desktop extension', () => {
  const desktopIt = desktopFixturesPresent ? it : it.skip;

  desktopIt('every desktop request matches its op schema and the op union', () => {
    for (const [name, schema] of DESKTOP_REQUEST_FIXTURES) {
      const value = parsed(`protocol/${name}`);
      expect({ name, ok: schema.safeParse(value).success }).toEqual({ name, ok: true });
      expect({ name, ok: ClientOpRequestSchema.safeParse(value).success }).toEqual({ name, ok: true });
    }
  });

  desktopIt('the input fixture exercises every action type', () => {
    const input = DesktopInputRequestSchema.parse(parsed('protocol/server_to_client_desktop_input.json'));
    expect(new Set(input.actions.map(action => action.type))).toEqual(
      new Set(['mouse_move', 'mouse_down', 'mouse_up', 'click', 'scroll', 'key', 'type']),
    );
  });

  desktopIt('every desktop reply is a reply whose result matches its payload schema', () => {
    for (const [name, schema] of DESKTOP_REPLY_FIXTURES) {
      const frame = classifyClientFrame(fixture(`protocol/${name}`));
      if (frame.kind !== 'reply' || !frame.reply.ok) {
        throw new Error(`expected a successful reply in ${name}`);
      }
      expect({ name, ok: schema.safeParse(JSON.parse(frame.reply.result_json)).success }).toEqual({ name, ok: true });
    }
  });

  desktopIt('a desktop hello says so, and one whose desktop failed says why', () => {
    const plain = HelloMessageSchema.parse(parsed('protocol/client_to_server_hello.json'));
    expect(plain.capabilities).toMatchObject({ desktop: false, desktop_unavailable_reason: null });
    const desktop = HelloMessageSchema.parse(parsed('protocol/client_to_server_hello_desktop.json'));
    expect(desktop.capabilities.desktop).toBe(true);
    const unavailable = HelloMessageSchema.parse(parsed('protocol/client_to_server_hello_desktop_unavailable.json'));
    expect(unavailable.capabilities.desktop).toBe(false);
    expect(unavailable.capabilities.desktop_unavailable_reason).toEqual(expect.any(String));
  });

  desktopIt('the client can answer desktop_unavailable, which the server maps', () => {
    const codes = z.object({ codes: z.array(z.string()) }).parse(parsed('protocol/error_codes.json'));
    expect(codes.codes).toContain('desktop_unavailable');
  });

  it('a hello from before the desktop reads as no desktop', () => {
    const legacy: Record<string, unknown> = JSON.parse(fixture('protocol/client_to_server_hello.json'));
    const capabilities = { python3: true, git: true, skills: true };
    const hello = HelloMessageSchema.parse({ ...legacy, capabilities });
    expect(hello.capabilities).toEqual({ ...capabilities, desktop: false, desktop_unavailable_reason: null });
  });
});

describe('the error codes the client can send', () => {
  it('all survive classification, and the ones the server narrows are all still sent', () => {
    const codes = JSON.parse(fixture('protocol/error_codes.json')) as { codes: string[] };
    // The set grows on the client's side, so the server treats it as an open string.
    expect(codes.codes).toContain('duplicate_id');
    for (const code of codes.codes) {
      const frame = classifyClientFrame(JSON.stringify({ id: 'req-1', error: { code, message: 'why' } }));
      expect(frame).toMatchObject({ kind: 'reply', reply: { ok: false, error: { code, message: 'why' } } });
    }
    // These four the server maps onto its own error classes; each must still be one the client sends.
    for (const mapped of ['not_found', 'is_a_directory', 'not_a_regular_file', 'too_large']) {
      expect(codes.codes).toContain(mapped);
    }
  });
});

describe('enrollment', () => {
  it('the request and the response match the wire schemas', () => {
    expect(EnrollComputerRequestSchema.safeParse(parsed('enroll/request.json')).success).toBe(true);
    expect(EnrollComputerResponseSchema.safeParse(parsed('enroll/response.json')).success).toBe(true);
  });
});
