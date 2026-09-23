import { estimateTokensForString } from '../../../src/core/llm/usage';
import { estimateTokensForContextMessages } from '../../../src/core/runtime/contextUtils';

describe('estimateTokensForContextMessages', () => {
  it('counts a tool-result image by its pixel size, capped for large images', () => {
    const imageTokens = (width: number, height: number): number =>
      estimateTokensForContextMessages([
        {
          role: 'tool',
          tool_call_id: 'c1',
          content: [{ type: 'image', file_id: 'f1', media_type: 'image/png', width, height }],
        },
      ]).prompt_tokens - estimateTokensForString('c1');

    expect(imageTokens(1280, 800)).toBe(1366);
    expect(imageTokens(3840, 2160)).toBe(1600);
  });
});
