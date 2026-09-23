import { cn } from '@/atoms/lib/cn.js';
import { Icon } from '@/icons/Icon.js';
import type { IntegrationBase } from '@/server/types.js';

export function IntegrationStatusBadge({ status }: { status: IntegrationBase['status'] }) {
  const connected = status === 'connected';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        connected ? 'bg-success-bg/10 text-success-bg' : 'bg-secondary-bg text-text-secondary',
      )}
    >
      <Icon name={connected ? 'circle-check' : 'clock'} className="size-3" />
      {connected ? 'Connected' : 'Waiting for the Slack app'}
    </span>
  );
}
