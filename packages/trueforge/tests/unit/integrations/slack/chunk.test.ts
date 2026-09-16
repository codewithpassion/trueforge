import { chunkForSlack, SLACK_MESSAGE_MAX_LENGTH } from '../../../../src/integrations/slack/chunk';

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
});
