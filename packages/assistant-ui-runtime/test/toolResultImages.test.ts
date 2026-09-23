import { describe, expect, it } from 'vitest';
import type { ToolImageContentPart, ToolResponseEvent, TurnEvent } from '../src/server/index.js';

import { ROOT_THREAD_ID } from '../src/constants.js';
import { buildRootAssistantContent, ingestTurnEvent, PeerThreadFoldState } from '../src/foldPeerThreads.js';
import { getToolResultImages } from '../src/toolResultImages.js';

const createdAt = new Date().toISOString();

const screenshot: ToolImageContentPart = {
  type: 'image',
  fileId: 'file-1',
  mediaType: 'image/jpeg',
  width: 1280,
  height: 800,
};

function foldScreenshotCall(response: ToolResponseEvent): ReturnType<typeof buildRootAssistantContent> {
  const state = new PeerThreadFoldState();
  const call: TurnEvent = {
    type: 'model.message',
    id: 'm1',
    createdAt,
    threadId: ROOT_THREAD_ID,
    toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'computer_screenshot', arguments: '{}' } }],
  };
  ingestTurnEvent(state, call);
  ingestTurnEvent(state, response);
  return buildRootAssistantContent(state);
}

describe('tool result images', () => {
  it('keeps image parts on the tool-call part and the text as its result', () => {
    const parts = foldScreenshotCall({
      type: 'tool.response',
      id: 'r1',
      createdAt,
      threadId: ROOT_THREAD_ID,
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'Screenshot taken' }, screenshot],
    });

    const part = parts.find(candidate => candidate.type === 'tool-call');
    expect(part).toMatchObject({ result: 'Screenshot taken' });
    expect(part === undefined ? [] : getToolResultImages(part)).toEqual([screenshot]);
  });

  it('attaches nothing when the result has no images', () => {
    const parts = foldScreenshotCall({
      type: 'tool.response',
      id: 'r1',
      createdAt,
      threadId: ROOT_THREAD_ID,
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'ok' }],
    });

    const part = parts.find(candidate => candidate.type === 'tool-call');
    expect(part).not.toHaveProperty('artifact');
  });

  it('reads no images from an unrelated artifact', () => {
    expect(getToolResultImages({ artifact: { subAgents: [] } })).toEqual([]);
    expect(getToolResultImages({ artifact: { toolImages: [{ type: 'image', fileId: 3 }] } })).toEqual([]);
    expect(getToolResultImages({})).toEqual([]);
  });
});
