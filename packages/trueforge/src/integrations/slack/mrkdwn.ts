/**
 * Markdown to Slack mrkdwn. Slack has no tables, no heading levels and no nested emphasis,
 * so those flatten; code, links, lists and quotes survive.
 */

/** Marks where a code span was lifted out, so no other rule can rewrite its contents. */
const PLACEHOLDER_MARK = '\u0000';

/**
 * The three characters Slack's mrkdwn parser reads as markup. Anything a model produced goes
 * through this before it reaches a block, or `<!channel>` in a tool argument pings the channel
 * and `<https://evil|Approve here>` renders as a disguised link.
 */
export function escapeSlackText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeForSlack(text: string): string {
  return escapeSlackText(text);
}

/** Fenced blocks first, then inline spans, so a backtick inside a fence is not treated as a span. */
function liftCode(text: string): { text: string; spans: string[] } {
  const spans: string[] = [];
  const lift = (match: string): string => {
    spans.push(escapeForSlack(match));
    return `${PLACEHOLDER_MARK}${String(spans.length - 1)}${PLACEHOLDER_MARK}`;
  };
  const withoutFences = text.replaceAll(/```[\s\S]*?```/g, lift);
  return { text: withoutFences.replaceAll(/`[^`\n]+`/g, lift), spans };
}

function restoreCode(input: { text: string; spans: string[] }): string {
  return input.text.replaceAll(
    new RegExp(`${PLACEHOLDER_MARK}(\\d+)${PLACEHOLDER_MARK}`, 'g'),
    (_match, index: string) => input.spans[Number(index)] ?? '',
  );
}

/** Converts a Markdown answer to Slack mrkdwn. Tables and images lose their layout. */
export function toMrkdwn(markdown: string): string {
  const lifted = liftCode(markdown.replaceAll('\r\n', '\n'));
  let text = escapeForSlack(lifted.text);

  // Blockquotes: Slack uses the same `>` the escape above turned into an entity.
  text = text.replaceAll(/^(\s*)&gt;\s?/gm, '$1> ');
  // Bullets before emphasis, so a `*` bullet marker is never read as an italic opener.
  text = text.replaceAll(/^(\s*)[-*+][^\S\n]+/gm, '$1• ');
  // Links and images both become Slack's `<url|label>`; a bare label falls back to the url.
  text = text.replaceAll(/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, label: string, url: string) =>
    label.trim().length > 0 ? `<${url}|${label}>` : `<${url}>`,
  );
  // Single `*` is italic in Markdown but bold in mrkdwn, so it converts before `**` does.
  text = text.replaceAll(/(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g, '_$1_');
  text = text.replaceAll(/\*\*([\s\S]+?)\*\*/g, '*$1*');
  text = text.replaceAll(/__([\s\S]+?)__/g, '*$1*');
  text = text.replaceAll(/~~([\s\S]+?)~~/g, '~$1~');
  // Last, so the emphasis rules cannot turn the bold a heading becomes back into italic.
  text = text.replaceAll(/^#{1,6}[^\S\n]+(.+)$/gm, (_match, heading: string) => {
    const title = heading.trim();
    return title.startsWith('*') && title.endsWith('*') ? title : `*${title}*`;
  });

  return restoreCode({ text, spans: lifted.spans });
}
