// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AgentSessionListRow } from '@/atoms/agent-details/AgentSessionListRow.js';
import type { AgentSessionListRowProps } from '@/atoms/agent-details/types.js';

function renderRow(sourceType?: AgentSessionListRowProps['sourceType']) {
  render(
    <AgentSessionListRow
      title="Help me find more details"
      agentName="writer"
      {...(sourceType === undefined ? {} : { sourceType })}
      lastActivityAt="2026-01-02T00:00:00.000Z"
      metrics={{ totalTurns: 2, totalDurationMs: 1000 }}
      active={false}
      onSelect={() => undefined}
    />,
  );
}

describe('AgentSessionListRow', () => {
  it('badges a session a channel opened', () => {
    renderRow('integration');

    expect(screen.getByLabelText('Channel session')).toBeInTheDocument();
    expect(screen.queryByLabelText('Scheduled run')).not.toBeInTheDocument();
  });

  it('keeps the schedule badge for a scheduled run', () => {
    renderRow('schedule');

    expect(screen.getByLabelText('Scheduled run')).toBeInTheDocument();
    expect(screen.queryByLabelText('Channel session')).not.toBeInTheDocument();
  });

  it('shows no badge for an interactive session', () => {
    renderRow();

    expect(screen.queryByLabelText('Scheduled run')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Channel session')).not.toBeInTheDocument();
  });
});
