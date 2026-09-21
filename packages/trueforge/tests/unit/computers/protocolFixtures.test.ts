/**
 * The Go client's golden fixtures, copied verbatim from `packages/trueforge-computer/testdata`.
 * They are the other side's idea of the frozen v1 contract, so parsing them here is what proves
 * the two halves still agree — a shape that drifts on either side turns this red.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CancelRequestSchema,
  CancelResultPayloadSchema,
  classifyClientFrame,
  ClientOpRequestSchema,
  ExecRequestSchema,
  ExecResultPayloadSchema,
  FileGetRequestSchema,
  FileGetResultPayloadSchema,
  FilePutRequestSchema,
  FilePutResultPayloadSchema,
  HelloMessageSchema,
} from '../../../src/computers/protocol';
import { EnrollComputerRequestSchema, EnrollComputerResponseSchema } from '../../../src/schemas/computer';

const FIXTURES = path.join(__dirname, 'fixtures');

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

function parsed(name: string): unknown {
  return JSON.parse(fixture(name));
}

describe('requests the server sends', () => {
  it.each([
    ['server_to_client_exec.json', ExecRequestSchema],
    ['server_to_client_exec_null_cwd.json', ExecRequestSchema],
    ['server_to_client_cancel.json', CancelRequestSchema],
    ['server_to_client_file_put_chunk.json', FilePutRequestSchema],
    ['server_to_client_file_put_final.json', FilePutRequestSchema],
    ['server_to_client_file_get.json', FileGetRequestSchema],
  ])('%s matches its op schema and the op union', (name, schema) => {
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
    expect(classifyClientFrame(raw)).toMatchObject({ kind: 'hello' });
  });

  it.each([
    ['client_to_server_reply_exec.json', ExecResultPayloadSchema],
    ['client_to_server_reply_cancel.json', CancelResultPayloadSchema],
    ['client_to_server_reply_file_put.json', FilePutResultPayloadSchema],
    ['client_to_server_reply_file_get.json', FileGetResultPayloadSchema],
  ])('%s is a reply whose result matches its payload schema', (name, schema) => {
    const frame = classifyClientFrame(fixture(`protocol/${name}`));
    expect(frame.kind).toBe('reply');
    if (frame.kind !== 'reply' || !frame.reply.ok) {
      throw new Error('expected a successful reply');
    }
    expect(schema.safeParse(JSON.parse(frame.reply.result_json)).success).toBe(true);
  });

  it('an error reply keeps the code the client chose, including one the server does not know', () => {
    const frame = classifyClientFrame(fixture('protocol/client_to_server_reply_error.json'));
    expect(frame).toMatchObject({
      kind: 'reply',
      reply: { ok: false, error: { code: 'denied', message: 'command refused by the local deny list' } },
    });
  });
});

describe('enrollment', () => {
  it('the request and the response match the wire schemas', () => {
    expect(EnrollComputerRequestSchema.safeParse(parsed('enroll/request.json')).success).toBe(true);
    expect(EnrollComputerResponseSchema.safeParse(parsed('enroll/response.json')).success).toBe(true);
  });
});
