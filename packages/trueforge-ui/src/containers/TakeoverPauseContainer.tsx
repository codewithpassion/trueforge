'use client';

import { useThreadIsRunning } from '@assistant-ui/core/react';
import { useTrueForgeToolResponses } from '@truefoundry/trueforge-assistant-ui-runtime';
import { useState } from 'react';

import { auiInputClass } from '../atoms/lib/inputClasses.js';
import { Button } from '../atoms/primitives/Button.js';
import { REQUEST_HUMAN_TAKEOVER_TOOL_NAME } from '../utils/toolCallParsing.js';

/**
 * The composer while the agent waits for a person on its screen. The session's owner can answer
 * here instead of on the Screen page; the answer has the same shape the Screen page sends.
 */
export function TakeoverPauseContainer({ disabled = false }: { disabled?: boolean }) {
  const { pending, respond } = useTrueForgeToolResponses();
  const isRunning = useThreadIsRunning();
  const [note, setNote] = useState('');
  const item = pending.find(candidate => candidate.toolName === REQUEST_HUMAN_TAKEOVER_TOOL_NAME);
  if (item == null) return null;

  const answer = (outcome: 'completed' | 'cancelled') => {
    const trimmed = note.trim();
    respond({
      toolCallId: item.toolCallId,
      content: JSON.stringify({ outcome, note: trimmed === '' ? null : trimmed }),
    });
    setNote('');
  };
  const locked = disabled || isRunning;

  return (
    <div
      data-slot="aui_composer-takeover-pause"
      className="flex w-full flex-col gap-2 rounded-xl border border-border bg-card-bg p-3"
    >
      <p className="text-sm text-text-primary">
        The agent is waiting for a person to finish a step on its screen. Use <strong>Open screen</strong> above, or
        answer here once it is done.
      </p>
      <input
        aria-label="Note for the agent"
        value={note}
        disabled={locked}
        onChange={event => setNote(event.target.value)}
        placeholder="Optional note for the agent"
        className={auiInputClass('h-9')}
      />
      <div className="flex justify-end gap-2">
        <Button.Ghost type="button" size="small" disabled={locked} onClick={() => answer('cancelled')}>
          Cancel request
        </Button.Ghost>
        <Button.Primary type="button" size="small" disabled={locked} onClick={() => answer('completed')}>
          It&rsquo;s done
        </Button.Primary>
      </div>
    </div>
  );
}
