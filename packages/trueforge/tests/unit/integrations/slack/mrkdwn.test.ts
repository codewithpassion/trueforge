import { toMrkdwn } from '../../../../src/integrations/slack/mrkdwn';

describe('toMrkdwn', () => {
  it('maps Markdown emphasis onto Slack emphasis', () => {
    expect(toMrkdwn('**bold** and *italic* and _also italic_ and ~~gone~~')).toBe(
      '*bold* and _italic_ and _also italic_ and ~gone~',
    );
    expect(toMrkdwn('__bold too__')).toBe('*bold too*');
  });

  it('flattens every heading level to bold', () => {
    expect(toMrkdwn('# Title\n### Smaller')).toBe('*Title*\n*Smaller*');
  });

  it('rewrites links and images to Slack link syntax', () => {
    expect(toMrkdwn('see [the docs](https://example.test/a)')).toBe('see <https://example.test/a|the docs>');
    expect(toMrkdwn('![](https://example.test/i.png)')).toBe('<https://example.test/i.png>');
  });

  it('turns list markers into bullets without reading them as emphasis', () => {
    expect(toMrkdwn('- one\n* two\n  + three')).toBe('• one\n• two\n  • three');
  });

  it('escapes the characters Slack reserves', () => {
    expect(toMrkdwn('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d');
  });

  it('keeps blockquotes readable after escaping', () => {
    expect(toMrkdwn('> quoted line')).toBe('> quoted line');
  });

  it('leaves fenced and inline code untouched apart from escaping', () => {
    expect(toMrkdwn('```\nif (a < b) { **x** }\n```')).toBe('```\nif (a &lt; b) { **x** }\n```');
    expect(toMrkdwn('call `a *b* c` now')).toBe('call `a *b* c` now');
  });

  it('does not rewrite a link that only exists inside a code fence', () => {
    expect(toMrkdwn('```\n[text](https://example.test)\n```')).toBe('```\n[text](https://example.test)\n```');
  });
});
