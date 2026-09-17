import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { getErrorMessage, Icon } from '@truefoundry/trueforge-ui';
import { useCallback, useEffect, useState, type SyntheticEvent } from 'react';
import './IntegrationsPage.css';
import { appHomeHref } from './integrationsRoute';
import { UI_BASE_PATH } from './publicPath';
import {
  EMPTY_SLACK_FORM,
  slackRequestUrl,
  toSlackForm,
  toSlackManifest,
  validateSlackForm,
  type SlackIntegrationForm,
} from './slackIntegration';

type Loaded = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready' };

export function IntegrationsPage({ client }: { client: TrueForge }) {
  const [state, setState] = useState<Loaded>({ status: 'loading' });
  const [integrations, setIntegrations] = useState<TrueForgeApi.Integration[]>([]);
  const [form, setForm] = useState<SlackIntegrationForm>(EMPTY_SLACK_FORM);
  const [formError, setFormError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const existing = integrations[0];

  const apply = useCallback((data: TrueForgeApi.Integration[]) => {
    setIntegrations(data);
    setForm(data[0] === undefined ? EMPTY_SLACK_FORM : toSlackForm(data[0]));
  }, []);

  const refresh = useCallback(async () => {
    const { data } = await client.settings.integrations.list();
    apply(data);
  }, [apply, client]);

  useEffect(() => {
    const live = { ok: true };
    void (async () => {
      try {
        const { data } = await client.settings.integrations.list();
        if (live.ok) {
          apply(data);
          setState({ status: 'ready' });
        }
      } catch (error) {
        if (live.ok) {
          setState({ status: 'error', message: getErrorMessage(error, 'Integrations could not be loaded') });
        }
      }
    })();
    return () => {
      live.ok = false;
    };
  }, [apply, client]);

  const field = <K extends keyof SlackIntegrationForm>(key: K, value: SlackIntegrationForm[K]): void => {
    setForm(current => ({ ...current, [key]: value }));
    setFormError(undefined);
  };

  const handleSubmit = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (busy) {
      return;
    }
    const invalid = validateSlackForm({ form, existing });
    if (invalid !== undefined) {
      setFormError(invalid);
      return;
    }
    setBusy(true);
    setFormError(undefined);
    const manifest = toSlackManifest({ form, existing });
    const saved =
      existing === undefined
        ? client.settings.integrations.create({ manifest })
        : client.settings.integrations.update(existing.id, { manifest });
    void saved
      .then(() => refresh())
      .catch((error: unknown) => {
        setFormError(getErrorMessage(error, 'The workspace could not be saved'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const handleDisconnect = (integration: TrueForgeApi.Integration): void => {
    if (busy) {
      return;
    }
    setBusy(true);
    setFormError(undefined);
    void client.settings.integrations
      .delete(integration.id)
      .then(() => refresh())
      .catch((error: unknown) => {
        setFormError(getErrorMessage(error, 'The workspace could not be disconnected'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className="harness-integrations">
      <header className="harness-integrations-header">
        <a className="harness-integrations-back" href={appHomeHref()}>
          <Icon name="arrow-left" />
          <span>Back</span>
        </a>
        <h1>Integrations</h1>
      </header>

      {state.status === 'loading' ? <p className="harness-integrations-note">Loading…</p> : null}
      {state.status === 'error' ? <p className="harness-integrations-error">{state.message}</p> : null}

      {state.status === 'ready' ? (
        <>
          <section className="harness-integrations-card">
            <h2>Slack</h2>
            <p className="harness-integrations-note">
              Mention the bot in an allowed channel, or send it a direct message, and the agent answers in the thread.
            </p>

            {existing === undefined ? null : (
              <dl className="harness-integrations-facts">
                <dt>Workspace</dt>
                <dd>{existing.externalAccountId}</dd>
                <dt>Request URL</dt>
                <dd>
                  <code>
                    {slackRequestUrl({
                      integrationId: existing.id,
                      origin: window.location.origin,
                      basePath: UI_BASE_PATH,
                    })}
                  </code>
                </dd>
                <dt>Connected</dt>
                <dd>{new Date(existing.createdAt).toLocaleString()}</dd>
              </dl>
            )}

            <form className="harness-integrations-form" onSubmit={handleSubmit}>
              <label htmlFor="slack-team-id">Workspace (team) id</label>
              <input
                id="slack-team-id"
                value={form.teamId}
                placeholder="T0EXAMPLE"
                onChange={event => {
                  field('teamId', event.target.value);
                }}
              />

              <label htmlFor="slack-bot-user-id">Bot user id</label>
              <input
                id="slack-bot-user-id"
                value={form.botUserId}
                placeholder="U0EXAMPLEBOT"
                onChange={event => {
                  field('botUserId', event.target.value);
                }}
              />

              <label htmlFor="slack-agent-name">Agent name</label>
              <input
                id="slack-agent-name"
                value={form.defaultAgentName}
                placeholder="support-bot"
                onChange={event => {
                  field('defaultAgentName', event.target.value);
                }}
              />

              <label htmlFor="slack-channels">Allowed channel ids</label>
              <input
                id="slack-channels"
                value={form.allowedChannels}
                placeholder="C0EXAMPLE, C0OTHER"
                onChange={event => {
                  field('allowedChannels', event.target.value);
                }}
              />

              <label htmlFor="slack-bot-token">
                Bot token
                {existing === undefined ? null : <span> (leave blank to keep the stored token)</span>}
              </label>
              <input
                id="slack-bot-token"
                type="password"
                autoComplete="off"
                value={form.botToken}
                placeholder={existing === undefined ? 'xoxb-…' : 'Leave blank to keep existing'}
                onChange={event => {
                  field('botToken', event.target.value);
                }}
              />

              <label htmlFor="slack-signing-secret">
                Signing secret
                {existing === undefined ? null : <span> (leave blank to keep the stored secret)</span>}
              </label>
              <input
                id="slack-signing-secret"
                type="password"
                autoComplete="off"
                value={form.signingSecret}
                placeholder={existing === undefined ? 'Slack app signing secret' : 'Leave blank to keep existing'}
                onChange={event => {
                  field('signingSecret', event.target.value);
                }}
              />

              <label className="harness-integrations-checkbox" htmlFor="slack-allow-dms">
                <input
                  id="slack-allow-dms"
                  type="checkbox"
                  checked={form.allowDirectMessages}
                  onChange={event => {
                    field('allowDirectMessages', event.target.checked);
                  }}
                />
                <span>Answer direct messages to the bot</span>
              </label>

              {formError === undefined ? null : <p className="harness-integrations-error">{formError}</p>}

              <div className="harness-integrations-actions">
                <button type="submit" className="harness-integrations-submit" disabled={busy}>
                  {existing === undefined ? 'Connect Slack' : 'Save changes'}
                </button>
                {existing === undefined ? null : (
                  <button
                    type="button"
                    className="harness-integrations-disconnect"
                    disabled={busy}
                    onClick={() => {
                      handleDisconnect(existing);
                    }}
                  >
                    Disconnect
                  </button>
                )}
              </div>
            </form>
          </section>
        </>
      ) : null}
    </div>
  );
}
