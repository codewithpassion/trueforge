'use client';

import { useThreadIsRunning } from '@assistant-ui/core/react';
import { useTrueForgeToolResponses } from '@truefoundry/trueforge-assistant-ui-runtime';
import { useState } from 'react';

import { auiInputClass } from '../atoms/lib/inputClasses.js';
import { Button } from '../atoms/primitives/Button.js';
import { REQUEST_HUMAN_TAKEOVER_TOOL_NAME } from '../utils/toolCallParsing.js';
import { useToasterOptional } from './ToasterContainer.js';

const ANSWERED_ELSEWHERE_NOTICE = 'Someone else already answered this request; the agent is continuing.';

/** Codes the turn route answers with when another answer to the same pause got in first. */
const ANSWERED_ELSEWHERE_CODES = new Set(['tip_running', 'already_answered']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A 409 whose `{ error: { code } }` body says the paused turn was already continued. */
function isAnsweredElsewhere(error: unknown): boolean {
  if (!isRecord(error) || error['statusCode'] !== 409) return false;
  const body = error['body'];
  const envelope = isRecord(body) ? body['error'] : undefined;
  const code = isRecord(envelope) ? envelope['code'] : undefined;
  return typeof code === 'string' && ANSWERED_ELSEWHERE_CODES.has(code);
}

/**
 * The composer while the agent waits for a person on its screen. The session's owner can answer
 * here instead of on the Screen page; the answer has the same shape the Screen page sends.
 */
export function TakeoverPauseContainer({ disabled = false }: { disabled?: boolean }) {
  const { pending, respond } = useTrueForgeToolResponses();
  const isRunning = useThreadIsRunning();
  const toaster = useToasterOptional();
  const [note, setNote] = useState('');
  const item = pending.find(candidate => candidate.toolName === REQUEST_HUMAN_TAKEOVER_TOOL_NAME);
  if (item == null) return null;

  const answer = (outcome: 'completed' | 'cancelled') => {
    const trimmed = note.trim();
    respond(
      {
        toolCallId: item.toolCallId,
        content: JSON.stringify({ outcome, note: trimmed === '' ? null : trimmed }),
      },
      {
        // Losing the race to someone on the Screen page is expected, not a failure.
        onSendError: error => {
          if (toaster === null || !isAnsweredElsewhere(error)) return false;
          toaster.showSuccess({ title: ANSWERED_ELSEWHERE_NOTICE });
          return true;
        },
      },
    );
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
