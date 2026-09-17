/**
 * Slack rejects a `chat.postMessage` text over 40,000 characters and truncates long ones in the
 * client, so an answer is posted as several messages well under that.
 */
export const SLACK_MESSAGE_MAX_LENGTH = 3500;

/**
 * Headroom kept while a fenced block is open, for the closing fence a break appends and the
 * opening fence the next chunk starts with. Both are short, so it costs a few characters.
 */
const FENCE_RESERVE = 12;

function fenceInfo(line: string): string | undefined {
  const trimmed = line.trimStart();
  return trimmed.startsWith('```') ? trimmed : undefined;
}

/**
 * A break between the halves of a surrogate pair would post a lone code unit, so it steps back
 * to before the pair — unless that would leave nothing to take, in which case it takes the whole
 * pair instead. A cut of zero makes no progress and the caller would never terminate.
 */
function safeCut(text: string, cut: number): number {
  const before = text.charCodeAt(cut - 1);
  if (before < 0xd800 || before > 0xdbff) {
    return cut;
  }
  return cut > 1 ? cut - 1 : Math.min(cut + 1, text.length);
}

function splitOversizedLine(line: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const lastSpace = window.lastIndexOf(' ');
    // Only break on a word boundary when one is reasonably close to the limit.
    const cut = safeCut(rest, lastSpace > limit / 2 ? lastSpace : limit);
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) {
    parts.push(rest);
  }
  return parts;
}

/**
 * Splits text into postable messages, preferring line boundaries and then word boundaries.
 *
 * A fenced code block that spans a break is closed at the end of one message and reopened at the
 * start of the next, so no message renders with an unterminated fence.
 */
export function chunkForSlack(text: string, limit: number = SLACK_MESSAGE_MAX_LENGTH): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }
  // Nothing that already fits can break a fence, so it needs no headroom.
  if (trimmed.length <= limit) {
    return [trimmed];
  }

  const chunks: string[] = [];
  let current = '';
  /** The opening fence of the block being written, when a chunk break would land inside one. */
  let openFence: string | undefined;

  const push = (): void => {
    if (current.length === 0) {
      return;
    }
    chunks.push(openFence === undefined ? current : `${current}\n\`\`\``);
    current = openFence ?? '';
  };

  for (const line of trimmed.split('\n')) {
    const fence = fenceInfo(line);
    // Inside a fence the fill stops short, so a chunk still fits once `push` closes it. The
    // floor keeps a caller-supplied limit smaller than the headroom from stalling the split.
    const fill = openFence === undefined && fence === undefined ? limit : Math.max(1, limit - FENCE_RESERVE);
    for (const piece of splitOversizedLine(line, fill)) {
      const candidate = current.length === 0 ? piece : `${current}\n${piece}`;
      if (candidate.length > fill) {
        push();
        current = current.length === 0 ? piece : `${current}\n${piece}`;
      } else {
        current = candidate;
      }
    }
    if (fence !== undefined) {
      openFence = openFence === undefined ? fence : undefined;
    }
  }
  // The last chunk closes nothing: its fence, if any, was never reopened.
  openFence = undefined;
  push();
  return chunks;
}
