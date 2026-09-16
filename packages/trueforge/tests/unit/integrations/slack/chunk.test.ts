import { chunkForSlack, SLACK_MESSAGE_MAX_LENGTH } from '../../../../src/integrations/slack/chunk';

/** Slack renders a fence that never closes as literal text, so every message must balance. */
function fenceCount(chunk: string): number {
  return chunk.split('\n').filter(line => line.trimStart().startsWith('```')).length;
}

describe('chunkForSlack', () => {
  it('leaves a message that already fits as one chunk', () => {
    expect(chunkForSlack('  short answer  ')).toEqual(['short answer']);
  });

  it('posts nothing for empty text', () => {
    expect(chunkForSlack('   \n  ')).toEqual([]);
  });

  it('splits on line boundaries and keeps every chunk under the limit', () => {
    const lines = Array.from({ length: 400 }, (_unused, index) => `line ${String(index)} ${'x'.repeat(20)}`);
    const chunks = chunkForSlack(lines.join('\n'));

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SLACK_MESSAGE_MAX_LENGTH);
    }
    expect(chunks.join('\n')).toBe(lines.join('\n'));
  });

  it('breaks a single oversized line on a word boundary', () => {
    const words = Array.from({ length: 900 }, () => 'word').join(' ');
    const chunks = chunkForSlack(words);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SLACK_MESSAGE_MAX_LENGTH);
      expect(chunk.startsWith('word')).toBe(true);
    }
    expect(chunks.join(' ')).toBe(words);
  });

  it('hard-splits a line with no usable break', () => {
    const chunks = chunkForSlack('y'.repeat(SLACK_MESSAGE_MAX_LENGTH * 2 + 5));

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(SLACK_MESSAGE_MAX_LENGTH);
    expect(chunks.join('')).toHaveLength(SLACK_MESSAGE_MAX_LENGTH * 2 + 5);
  });

  it('honours a caller-supplied limit', () => {
    expect(chunkForSlack('alpha\nbeta\ngamma', 11)).toEqual(['alpha\nbeta', 'gamma']);
  });

  it('closes and reopens a fence that spans a chunk break', () => {
    const code = Array.from({ length: 12 }, (_unused, index) => `const line${String(index)} = ${String(index)};`);
    const chunks = chunkForSlack(['Here you go:', '```ts', ...code, '```', 'That is all.'].join('\n'), 120);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // An odd count is an unterminated fence, which Slack renders as broken monospace.
      expect(fenceCount(chunk) % 2).toBe(0);
      expect(chunk.length).toBeLessThanOrEqual(120);
    }
    // Every line of the block survives, and each continuation reopens the block in its language.
    const body = chunks.join('\n');
    for (const line of code) {
      expect(body).toContain(line);
    }
    expect(chunks.filter(chunk => chunk.startsWith('```ts')).length).toBeGreaterThanOrEqual(1);
  });

  it('leaves text outside a fence unfenced', () => {
    const chunks = chunkForSlack(['```', 'code', '```', 'x'.repeat(200)].join('\n'), 60);

    const last = chunks.at(-1);
    expect(last).toBeDefined();
    expect(fenceCount(last ?? '')).toBe(0);
  });

  it('never splits a surrogate pair', () => {
    const chunks = chunkForSlack('🎉'.repeat(200), 51);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const lastUnit = chunk.charCodeAt(chunk.length - 1);
      expect(lastUnit >= 0xd800 && lastUnit <= 0xdbff).toBe(false);
      // A lone low surrogate at the start would mean the previous chunk cut a pair.
      const firstUnit = chunk.charCodeAt(0);
      expect(firstUnit >= 0xdc00 && firstUnit <= 0xdfff).toBe(false);
    }
    expect(chunks.join('')).toBe('🎉'.repeat(200));
  });
});
