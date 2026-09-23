'use client';

import type { MouseEvent } from 'react';

import { Icon } from '../icons/Icon.js';
import type { TakeoverAnswer } from '../utils/toolCallParsing.js';
import { cn } from './lib/cn.js';

export type HumanTakeoverCardProps = {
  /** What the agent asked the person to do. */
  reason: string;
  /** Undefined while the agent is still waiting. */
  answer?: TakeoverAnswer;
  /** Where the Screen page is, when it can be reached from here. */
  screenHref?: string;
  /** In-app navigation to the Screen page; a plain click uses it instead of loading `screenHref`. */
  onOpenScreen?: () => void;
};

function answerText(answer: TakeoverAnswer): string {
  if (answer.outcome === 'answered') return `Answered in chat: “${answer.note ?? ''}”`;
  const who = answer.answeredBy === 'another_user' ? 'Another person' : 'A person';
  const what = answer.outcome === 'completed' ? `${who} handed the desktop back` : `${who} cancelled the request`;
  return answer.note === null ? `${what}.` : `${what}: “${answer.note}”`;
}

/** The agent asked a person to take over its computer's desktop, for a login, a CAPTCHA or 2FA. */
export function HumanTakeoverCard({ reason, answer, screenHref, onOpenScreen }: HumanTakeoverCardProps) {
  const waiting = answer === undefined;
  const openScreen = (event: MouseEvent<HTMLAnchorElement>) => {
    if (onOpenScreen === undefined) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpenScreen();
  };
  return (
    <div
      data-testid="human-takeover-card"
      className={cn(
        'mt-2 flex flex-col gap-2 rounded-lg border p-3 text-sm',
        waiting ? 'border-warning-bg/40 bg-warning-bg/10' : 'border-border bg-card-bg',
      )}
    >
      <p className="flex items-center gap-2 font-medium text-text-primary">
        <Icon name="monitor" className="size-4 shrink-0" />
        {waiting ? 'The agent needs a person on its screen' : 'The agent asked a person to help'}
      </p>
      <p className="whitespace-pre-wrap break-words text-text-primary">{reason}</p>
      {waiting ? (
        screenHref === undefined && onOpenScreen === undefined ? (
          <p className="text-xs text-text-secondary">Open the agent&rsquo;s Screen page to take control.</p>
        ) : (
          <a
            href={screenHref ?? '#'}
            onClick={openScreen}
            className="inline-flex w-fit items-center gap-1.5 rounded-md bg-primary-button-bg px-3 py-1.5 text-xs font-medium text-primary-button-text hover:bg-primary-button-hover"
          >
            Open screen
            <Icon name="external-link" className="size-3.5" />
          </a>
        )
      ) : (
        <p className="text-xs text-text-secondary">{answerText(answer)}</p>
      )}
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    HumanTakeoverCard: typeof HumanTakeoverCard;
  }
}
