/**
 * Slack rejects a `chat.postMessage` text over 40,000 characters and truncates long ones in the
 * client, so an answer is posted as several messages well under that.
 */
export const SLACK_MESSAGE_MAX_LENGTH = 3500;

/** Longest fence line the splitter reserves room for when a chunk has to close one. */
const FENCE_RESERVE = 12;

function fenceInfo(line: string): string | undefined {
  const trimmed = line.trimStart();
  return trimmed.startsWith('```') ? trimmed : undefined;
}

/** A break between the halves of a surrogate pair would post a lone code unit. */
function safeCut(text: string, cut: number): number {
  const before = text.charCodeAt(cut - 1);
  return before >= 0xd800 && before <= 0xdbff ? cut - 1 : cut;
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
    // Room for the closing fence this chunk may have to grow, so it still fits after `push`.
    const fill = openFence === undefined && fence === undefined ? limit : limit - FENCE_RESERVE;
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
