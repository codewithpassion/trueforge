'use client';

import { Suspense, useEffect, useState } from 'react';

import { useResourcePermissions } from '../../hooks/useResourcePermissions.js';
import { Icon } from '../../icons/Icon.js';
import { isIntegrationsChromeEnabled } from '../../server/serverChrome.js';
import { useOptionalAgentSessionsServer, useOptionalIntegrationServer } from '../../server/ServerContext.js';
import { useOptionalShellMode } from '../../server/ShellModeContext.js';
import type { IntegrationBase } from '../../server/types.js';
import { useSlot } from '../../theme/SlotsProvider.js';
import { getErrorMessage } from '../../utils/getErrorMessage.js';
import { IntegrationStatusBadge } from '../integrations/IntegrationStatusBadge.js';
import { auiButtonClass } from '../lib/buttonClasses.js';
import { SideDrawer } from '../primitives/SideDrawer.js';
import { Skeleton } from '../primitives/Skeleton.js';

const TITLE = 'Integrations';
const DESCRIPTION = 'Let people talk to this agent from Slack.';
const MANAGE_LABEL = 'Manage integrations';

/** Builder summary of the loaded agent's Slack integrations; managing them happens in the integrations page. */
export function AgentIntegrationsSection() {
  const integrationServer = useOptionalIntegrationServer();
  const sessionsServer = useOptionalAgentSessionsServer();
  const shell = useOptionalShellMode();
  const Section = useSlot('AgentConfigSection');
  const PermissionGuard = useSlot('PermissionGuard');
  const IntegrationsPage = useSlot('IntegrationsPage');
  const mode = shell?.mode;
  // Integrations bind to a saved agent's name, so a draft has nothing to connect yet.
  const agentId = mode?.status === 'active' && mode.isMutable ? mode.agentId : undefined;
  const agentName = mode?.status === 'active' && mode.isMutable ? mode.agentName : undefined;
  const { allows } = useResourcePermissions({
    resourceType: 'agent',
    resourceIds: agentId === undefined ? [] : [agentId],
  });
  const canManage = allows(agentId, 'MANAGE');
  const [open, setOpen] = useState(false);
  // The integration a row asked the drawer to open on; the Manage action opens the list.
  const [drawerIntegrationId, setDrawerIntegrationId] = useState<string | undefined>(undefined);
  const [reloadEpoch, setReloadEpoch] = useState(0);
  // Tagged with the agent it was listed for, so a switch shows Loading… rather than the previous agent's rows.
  const [listed, setListed] = useState<{ agentName: string; integrations: IntegrationBase[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (integrationServer === null || agentName === undefined) return;
    let cancelled = false;
    setError(null);
    void integrationServer.listIntegrations({ agentNames: [agentName] }).then(
      integrations => {
        if (!cancelled) setListed({ agentName, integrations });
      },
      (err: unknown) => {
        if (!cancelled) setError(getErrorMessage(err, 'Could not load integrations'));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agentName, integrationServer, reloadEpoch]);

  // The drawer's page resolves the agent through the sessions port, so it cannot render without one.
  if (!isIntegrationsChromeEnabled({ integrations: integrationServer }) || sessionsServer === null) return null;

  if (agentId === undefined || agentName === undefined) {
    return (
      <Section title={TITLE} description={DESCRIPTION}>
        <p className="text-text-secondary text-xs">Save the agent to connect Slack.</p>
      </Section>
    );
  }

  const integrations = listed?.agentName === agentName ? listed.integrations : null;
  const openDrawer = (integrationId?: string) => {
    setDrawerIntegrationId(integrationId);
    setOpen(true);
  };
  // The drawer reports a close from its button and again from the dialog's close event.
  const closeDrawer = () => {
    if (!open) return;
    setOpen(false);
    setReloadEpoch(epoch => epoch + 1);
  };

  let body;
  if (error !== null) {
    body = <p className="text-failure-bg text-xs">{error}</p>;
  } else if (integrations === null) {
    body = <p className="text-text-secondary text-xs">Loading…</p>;
  } else if (integrations.length === 0) {
    body = <p className="text-text-secondary text-xs">No Slack workspaces connected.</p>;
  } else {
    body = (
      <ul className="flex flex-col gap-1.5">
        {integrations.map(integration => (
          <li key={integration.id}>
            <button
              type="button"
              className="border-border hover:bg-ghost-button-hover flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors"
              onClick={() => {
                openDrawer(integration.id);
              }}
            >
              <Icon name="message-square-text" className="text-text-secondary size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{integration.botDisplayName}</span>
              <IntegrationStatusBadge status={integration.status} />
            </button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      <Section
        title={TITLE}
        description={DESCRIPTION}
        action={
          <div className="shrink-0">
            <PermissionGuard allowed={canManage}>
              <button
                type="button"
                aria-label={MANAGE_LABEL}
                title={MANAGE_LABEL}
                className={auiButtonClass({ variant: 'ghost', size: 'icon', className: 'size-7' })}
                onClick={() => {
                  openDrawer();
                }}
              >
                <Icon name="sliders" className="size-3.5" />
              </button>
            </PermissionGuard>
          </div>
        }
      >
        {body}
      </Section>
      <SideDrawer
        open={open}
        onOpenChange={nextOpen => {
          if (!nextOpen) closeDrawer();
        }}
        title={TITLE}
        description="Let a Slack workspace talk to this agent."
        anchor="right"
        size="xl"
      >
        {open ? (
          <Suspense
            fallback={
              <div className="p-5" role="status" aria-label="Loading">
                <Skeleton className="min-h-64 rounded-lg" />
              </div>
            }
          >
            <IntegrationsPage agentId={agentId} embedded initialIntegrationId={drawerIntegrationId} />
          </Suspense>
        ) : null}
      </SideDrawer>
    </>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    AgentIntegrationsSection: typeof AgentIntegrationsSection;
  }
}
