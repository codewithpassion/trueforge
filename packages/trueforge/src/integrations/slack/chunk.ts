/**
 * Slack rejects a `chat.postMessage` text over 40,000 characters and truncates long ones in the
 * client, so an answer is posted as several messages well under that.
 */
export const SLACK_MESSAGE_MAX_LENGTH = 3500;

function splitOversizedLine(line: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const lastSpace = window.lastIndexOf(' ');
    // Only break on a word boundary when one is reasonably close to the limit.
    const cut = lastSpace > limit / 2 ? lastSpace : limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) {
    parts.push(rest);
  }
  return parts;
}

/** Splits text into postable messages, preferring line boundaries and then word boundaries. */
export function chunkForSlack(text: string, limit: number = SLACK_MESSAGE_MAX_LENGTH): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.length <= limit) {
    return [trimmed];
  }

  const chunks: string[] = [];
  let current = '';
  const push = (): void => {
    if (current.length > 0) {
      chunks.push(current);
      current = '';
    }
  };
  for (const line of trimmed.split('\n')) {
    for (const piece of splitOversizedLine(line, limit)) {
      const candidate = current.length === 0 ? piece : `${current}\n${piece}`;
      if (candidate.length > limit) {
        push();
        current = piece;
      } else {
        current = candidate;
      }
    }
  }
  push();
  return chunks;
}
