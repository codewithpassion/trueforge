import { Icon } from '@truefoundry/trueforge-ui';
import { integrationsHref } from './integrationsRoute';
import { LogoutButton } from './LogoutButton';
import './ShellActions.css';

/**
 * Everything the host adds next to Settings, through the single `ShellActionsActionSlot`
 * override the shell exposes.
 */
export function ShellActions() {
  return (
    <>
      <a className="harness-shell-action" href={integrationsHref()} aria-label="Integrations" title="Integrations">
        <Icon name="plug" />
      </a>
      <LogoutButton />
    </>
  );
}
