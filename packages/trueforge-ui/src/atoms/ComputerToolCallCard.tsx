'use client';

import type { ReactNode } from 'react';

import { useSlot } from '../theme/SlotsProvider.js';
import type { ToolCallStatus } from './ToolCallCard.js';

export type ComputerToolCallCardProps = {
  /** What the call did, e.g. "Click at (640, 400)". */
  action: string;
  status: ToolCallStatus;
  expanded: boolean;
  onToggle: () => void;
  durationText?: string;
  /** Screenshot thumbnails; shown without expanding the card. */
  thumbnailsSlot?: ReactNode;
  requestSlot?: ReactNode;
  responseSlot?: ReactNode;
  approvalSlot?: ReactNode;
  approvalId?: string;
};

/** A desktop tool call: the action on the title line and the screen it left behind below it. */
export function ComputerToolCallCard({
  action,
  status,
  expanded,
  onToggle,
  durationText,
  thumbnailsSlot,
  requestSlot,
  responseSlot,
  approvalSlot,
  approvalId,
}: ComputerToolCallCardProps) {
  const ToolCallCard = useSlot('ToolCallCard');
  return (
    <ToolCallCard
      icon="monitor"
      toolName={action}
      expanded={expanded}
      onToggle={onToggle}
      awaiting={status === 'running'}
      awaitingText={durationText ?? 'Working…'}
      status={status === 'running' ? undefined : status}
      showResponseLine={status !== 'running' && responseSlot !== undefined}
      attachmentsSlot={thumbnailsSlot}
      requestSlot={requestSlot}
      responseSlot={responseSlot}
      approvalSlot={approvalSlot}
      approvalId={approvalId}
      dataTestPrefix="computer"
    />
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    ComputerToolCallCard: typeof ComputerToolCallCard;
  }
}
