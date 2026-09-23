import {
  stubbedToolImageCount,
  toolImageTrimming,
  trimToolImages,
} from '../../../../src/core/capabilities/builtins/ToolImageTrimming';
import type { LLMRequestMessage } from '../../../../src/core/llm/ILLM';

function screenshotResults(count: number): LLMRequestMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: 'tool',
    tool_call_id: `call-${String(i)}`,
    content: [
      { type: 'text', text: `step ${String(i)}` },
      { type: 'image', file_id: `f${String(i)}`, media_type: 'image/jpeg', width: 1280, height: 800 },
    ],
  }));
}

function imageFileIds(messages: LLMRequestMessage[]): string[] {
  return messages.flatMap(msg =>
    msg.role === 'tool' ? msg.content.flatMap(part => (part.type === 'image' ? [part.file_id] : [])) : [],
  );
}

describe('stubbedToolImageCount', () => {
  it('stubs nothing up to 2N images, then drops back to N in one batch', () => {
    const keep = 5;
    expect([0, 1, 5, 10].map(count => stubbedToolImageCount({ count, keep }))).toEqual([0, 0, 0, 0]);
    expect(stubbedToolImageCount({ count: 11, keep })).toBe(6);
    // The boundary holds while the live count climbs back to 2N.
    expect(stubbedToolImageCount({ count: 16, keep })).toBe(6);
    expect(stubbedToolImageCount({ count: 17, keep })).toBe(12);
  });
});

describe('trimToolImages', () => {
  it('leaves a request with 2N images untouched', () => {
    const messages = screenshotResults(10);
    expect(trimToolImages({ messages, keep: 5 })).toBe(messages);
  });

  it('stubs the oldest images once the count exceeds 2N and keeps the newest N', () => {
    const messages = screenshotResults(11);
    const trimmed = trimToolImages({ messages, keep: 5 });

    expect(imageFileIds(trimmed)).toEqual(['f6', 'f7', 'f8', 'f9', 'f10']);
    expect(trimmed[0]).toEqual({
      role: 'tool',
      tool_call_id: 'call-0',
      content: [
        { type: 'text', text: 'step 0' },
        { type: 'text', text: '[screenshot 1280x800 omitted: trimmed from the conversation to save space]' },
      ],
    });
    // Only the request is trimmed; the history it came from keeps every image.
    expect(imageFileIds(messages)).toHaveLength(11);
  });

  it('runs as a pre-LLM ephemeral processor', () => {
    const [processor] = toolImageTrimming({ keep: 1 }).preLLMEphemeralProcessors ?? [];
    if (processor === undefined) throw new Error('expected a processor');
    expect(imageFileIds(processor.processPreLLMEphemeral(screenshotResults(3)) ?? [])).toEqual(['f2']);
  });
});
