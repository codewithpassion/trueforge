import { describe, expect, it } from 'vitest';

import {
  buildApprovalOptions,
  COMPUTER_TOOL_NAMES,
  describeComputerAction,
  formatDuration,
  getAskUserAnswerResult,
  getJsonDisplayValue,
  getToolResultContent,
  mcpDisplayName,
  parseAskUserQuestionArgs,
  parseMcpToolArgs,
  parseSandboxArgs,
  parseSandboxResult,
  parseTakeoverAnswer,
  parseTakeoverReason,
  toStatus,
} from '@/utils/toolCallParsing.js';

describe('toolCallParsing', () => {
  it('parses ask-user args', () => {
    expect(parseAskUserQuestionArgs(JSON.stringify({ question: 'Pick one', options: ['a', 'b', 3] }))).toEqual({
      question: 'Pick one',
      options: ['a', 'b'],
    });
    expect(parseAskUserQuestionArgs('not-json')).toEqual({});
  });

  it('reads ask-user answers from string or content object', () => {
    expect(getAskUserAnswerResult('  yes  ')).toBe('yes');
    expect(getAskUserAnswerResult({ content: 'no' })).toBe('no');
    expect(getAskUserAnswerResult('')).toBeUndefined();
  });

  it('formats durations', () => {
    expect(formatDuration(500)).toBe('<1s');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(15000)).toBe('15s');
    expect(formatDuration(125000)).toBe('2m 5s');
  });

  it('maps status types', () => {
    expect(toStatus('complete')).toBe('success');
    expect(toStatus('incomplete')).toBe('error');
    expect(toStatus('running')).toBe('running');
  });

  it('parses sandbox args and results', () => {
    expect(parseSandboxArgs(JSON.stringify({ command: 'ls', intent: 'list' }))).toMatchObject({
      command: 'ls',
      intent: 'list',
    });
    expect(parseSandboxArgs('{"command":"pnpm test","intent":"still stream')).toEqual({
      command: 'pnpm test',
      intent: 'still stream',
      argsJson: '{"command":"pnpm test","intent":"still stream',
    });
    expect(parseSandboxResult(JSON.stringify({ response: { exitCode: 0, result: 'ok' } }))).toMatchObject({
      exitCode: 0,
      resultText: 'ok',
    });
    expect(parseSandboxResult('{"response":{"exitCode":0,"result":"streamed output"')).toEqual({
      exitCode: 0,
      resultText: 'streamed output',
      resultJson: '{"response":{"exitCode":0,"result":"streamed output"',
    });
    expect(parseSandboxResult('plain')).toEqual({ resultText: 'plain' });
  });

  it('parses mcp tool args and display names', () => {
    expect(
      parseMcpToolArgs(
        JSON.stringify({
          mcp_server: 'github',
          tool_name: 'search',
          input: { q: 'x' },
        }),
      ),
    ).toEqual({
      mcpServer: 'github',
      innerToolName: 'search',
      input: { q: 'x' },
    });
    expect(mcpDisplayName('call_tool', 'github', 'search')).toBe('call_tool: search (github)');
    expect(mcpDisplayName('list_tools', 'github', undefined)).toBe('list_tools (github)');
    expect(mcpDisplayName('get_tool_output_schema', 'github', 'search')).toBe(
      'get_tool_output_schema: search (github)',
    );
  });

  it('pretty-prints json display values', () => {
    expect(getJsonDisplayValue('{"a":1}')).toEqual({
      value: '{\n  "a": 1\n}',
      isJson: true,
    });
    expect(getJsonDisplayValue('{"a":1,"streaming":"unfinished')).toEqual({
      value: '{"a":1,"streaming":"unfinished',
      isJson: false,
    });
    expect(getJsonDisplayValue('hello')).toEqual({
      value: 'hello',
      isJson: false,
    });
  });

  it('extracts tool result content arrays', () => {
    expect(getToolResultContent({ content: [{ text: '{"ok":true}' }] })).toEqual({
      data: '{\n  "ok": true\n}',
      isJson: true,
    });
  });

  it('builds default approval options when none declared', () => {
    expect(buildApprovalOptions(undefined)).toEqual([
      { id: '__allow', label: 'Allow', isAllow: true },
      { id: '__deny', label: 'Deny', isAllow: false, confirm: {} },
    ]);
  });
});

describe('desktop tools', () => {
  it('knows every computer tool', () => {
    expect([...COMPUTER_TOOL_NAMES].sort()).toEqual([
      'computer_click',
      'computer_clipboard_read',
      'computer_clipboard_write',
      'computer_drag',
      'computer_key',
      'computer_screenshot',
      'computer_scroll',
      'computer_type',
    ]);
  });

  it('describes each action in a line', () => {
    expect(describeComputerAction('computer_screenshot', '{}')).toBe('Screenshot');
    expect(describeComputerAction('computer_click', '{"x":10,"y":20}')).toBe('Click at (10, 20)');
    expect(describeComputerAction('computer_click', '{"x":10,"y":20,"button":"right","count":2}')).toBe(
      'Double-click (right) at (10, 20)',
    );
    // Typed text can be a password, so only its length shows.
    expect(describeComputerAction('computer_type', '{"text":"hunter2"}')).toBe('Typed 7 characters');
    expect(describeComputerAction('computer_type', '{"text":"é"}')).toBe('Typed 1 character');
    expect(describeComputerAction('computer_type', JSON.stringify({ text: '🙂'.repeat(50) }))).toBe(
      'Typed 50 characters',
    );
    expect(describeComputerAction('computer_key', '{"keys":"ctrl+l"}')).toBe('Press ctrl+l');
    expect(describeComputerAction('computer_scroll', '{"x":1,"y":2,"dx":0,"dy":3}')).toBe('Scroll at (1, 2)');
    expect(describeComputerAction('computer_drag', '{"from":{"x":1,"y":2},"to":{"x":3,"y":4}}')).toBe(
      'Drag from (1, 2) to (3, 4)',
    );
    expect(describeComputerAction('computer_clipboard_read', undefined)).toBe('Read the clipboard');
    // Streaming arguments are still partial JSON.
    expect(describeComputerAction('computer_click', '{"x":10')).toBe('Click');
  });

  it('reads a takeover reason and its answer', () => {
    expect(parseTakeoverReason('{"reason":"Log in"}')).toBe('Log in');
    expect(parseTakeoverReason('{}')).toBeUndefined();
    expect(parseTakeoverAnswer(undefined)).toBeUndefined();
    expect(parseTakeoverAnswer('{"outcome":"completed","note":null}')).toEqual({ outcome: 'completed', note: null });
    expect(parseTakeoverAnswer('{"outcome":"cancelled","note":"later","answered_by":"session_creator"}')).toEqual({
      outcome: 'cancelled',
      note: 'later',
      answeredBy: 'session_creator',
    });
    expect(parseTakeoverAnswer('done')).toEqual({ outcome: 'answered', note: 'done' });
  });
});
