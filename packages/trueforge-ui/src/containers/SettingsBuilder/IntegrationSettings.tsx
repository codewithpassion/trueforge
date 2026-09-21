'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';

import { cn } from '@/atoms/lib/cn.js';
import { auiInputClass } from '@/atoms/lib/inputClasses.js';
import { Button } from '@/atoms/primitives/Button.js';
import { CenteredModal } from '@/atoms/primitives/CenteredModal.js';
import { Icon } from '@/icons/Icon.js';
import { useCatalogServer } from '@/server/ServerContext.js';
import type { IntegrationBase, IntegrationCatalogServer, IntegrationSetupManifest } from '@/server/types.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';
import { useToasterOptional } from '../ToasterContainer.js';
import {
  EMPTY_INTEGRATION_FORM,
  parseAllowedChannels,
  toIntegrationForm,
  toUpdateIntegrationRequest,
  validateCredentials,
  validateIntegrationForm,
  type IntegrationFormDraft,
} from './integrationForm.js';

function StatusBadge({ status }: { status: IntegrationBase['status'] }) {
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

/**
 * The handle Slack will give the bot user. Read from the manifest the server generated rather
 * than derived again here: the server owns that rule.
 */
const BotHandleSchema = z.object({
  features: z.object({ bot_user: z.object({ display_name: z.string() }) }),
});

function botHandleFrom(manifestJson: string): string | undefined {
  let document: unknown;
  try {
    document = JSON.parse(manifestJson);
  } catch {
    return undefined;
  }
  const parsed = BotHandleSchema.safeParse(document);
  return parsed.success ? parsed.data.features.bot_user.display_name : undefined;
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary">
      {children}
    </label>
  );
}

const IntegrationSettings = () => {
  const catalog = useCatalogServer();
  // The section only renders when the host supplied this port (see SettingsBuilder/index.tsx).
  const integrationCatalog: IntegrationCatalogServer | undefined = catalog.integrationCatalog;
  const toaster = useToasterOptional();

  const [integrations, setIntegrations] = useState<IntegrationBase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<IntegrationFormDraft>(EMPTY_INTEGRATION_FORM);

  const [detailForm, setDetailForm] = useState<IntegrationFormDraft>(EMPTY_INTEGRATION_FORM);
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [setup, setSetup] = useState<IntegrationSetupManifest | null>(null);

  const selected = integrations.find(integration => integration.id === selectedId) ?? null;
  const botHandle = setup === null ? undefined : botHandleFrom(setup.manifestJson);

  const refresh = useCallback(async () => {
    if (integrationCatalog === undefined) return;
    setLoading(true);
    setError(null);
    try {
      setIntegrations(await integrationCatalog.listIntegrations());
    } catch (err) {
      setError(getErrorMessage(err, 'Could not load integrations'));
    } finally {
      setLoading(false);
    }
  }, [integrationCatalog]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The manifest names the integration's own ingress URL, so it is fetched per selection.
  useEffect(() => {
    if (integrationCatalog === undefined || selectedId === null) {
      setSetup(null);
      return;
    }
    let cancelled = false;
    void integrationCatalog
      .getIntegrationSetupManifest({ id: selectedId })
      .then(manifest => {
        if (!cancelled) setSetup(manifest);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(getErrorMessage(err, 'Could not build the Slack app manifest'));
      });
    return () => {
      cancelled = true;
    };
  }, [integrationCatalog, selectedId]);

  const openDetail = (integration: IntegrationBase) => {
    setSelectedId(integration.id);
    setDetailForm(toIntegrationForm(integration));
    setBotToken('');
    setSigningSecret('');
    setError(null);
    setFormError(null);
  };

  const runMutation = async (fn: () => Promise<void>, setMutationError = setError) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setMutationError(getErrorMessage(err, 'Request failed'));
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (integrationCatalog === undefined) return;
    const problem = validateIntegrationForm(addForm);
    if (problem !== undefined) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    void runMutation(async () => {
      const created = await integrationCatalog.createIntegration({
        type: 'slack',
        botDisplayName: addForm.botDisplayName.trim(),
        defaultAgentName: addForm.defaultAgentName.trim(),
        allowedChannelIds: parseAllowedChannels(addForm.allowedChannels),
        allowDirectMessages: addForm.allowDirectMessages,
      });
      setAddOpen(false);
      setAddForm(EMPTY_INTEGRATION_FORM);
      openDetail(created);
    }, setFormError);
  };

  const handleSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (integrationCatalog === undefined || selected === null) return;
    const problem = validateIntegrationForm(detailForm) ?? validateCredentials({ botToken, signingSecret });
    if (problem !== undefined) {
      setError(problem);
      return;
    }
    void runMutation(async () => {
      const saved = await integrationCatalog.updateIntegration(
        toUpdateIntegrationRequest({ id: selected.id, form: detailForm, botToken, signingSecret }),
      );
      setBotToken('');
      setSigningSecret('');
      toaster?.showSuccess({ title: saved.status === 'connected' ? 'Slack connected' : 'Saved' });
    });
  };

  const handleDisconnect = () => {
    if (integrationCatalog === undefined || selected === null) return;
    void runMutation(async () => {
      await integrationCatalog.deleteIntegration({ id: selected.id });
      setSelectedId(null);
    });
  };

  const copyManifest = () => {
    if (setup === null) return;
    void navigator.clipboard?.writeText(setup.manifestJson).then(
      () => toaster?.showSuccess({ title: 'Manifest copied' }),
      () => setError('Could not copy the manifest; select it and copy by hand.'),
    );
  };

  const downloadManifest = () => {
    if (setup === null) return;
    const url = URL.createObjectURL(new Blob([setup.manifestJson], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'slack-app-manifest.json';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (integrationCatalog === undefined) return null;

  const settingsFields = (
    form: IntegrationFormDraft,
    setForm: (next: IntegrationFormDraft) => void,
    idPrefix: string,
  ) => (
    <>
      <div>
        <FieldLabel htmlFor={`${idPrefix}-bot-name`}>Bot name</FieldLabel>
        <input
          id={`${idPrefix}-bot-name`}
          value={form.botDisplayName}
          onChange={event => {
            setForm({ ...form, botDisplayName: event.target.value });
          }}
          placeholder="release-bot"
          className={auiInputClass('h-11')}
        />
        <p className="mt-1 text-xs text-text-secondary">
          Up to 35 characters, written however you like. Renaming here changes the generated manifest only — an app
          Slack has already created keeps its name.
        </p>
      </div>
      <div>
        <FieldLabel htmlFor={`${idPrefix}-agent`}>Agent</FieldLabel>
        <input
          id={`${idPrefix}-agent`}
          value={form.defaultAgentName}
          onChange={event => {
            setForm({ ...form, defaultAgentName: event.target.value });
          }}
          placeholder="support-bot"
          className={auiInputClass('h-11')}
        />
      </div>
      <div>
        <FieldLabel htmlFor={`${idPrefix}-channels`}>Allowed channels</FieldLabel>
        <input
          id={`${idPrefix}-channels`}
          value={form.allowedChannels}
          onChange={event => {
            setForm({ ...form, allowedChannels: event.target.value });
          }}
          placeholder="C0GENERAL, C0RELEASES"
          className={auiInputClass('h-11')}
        />
        <p className="mt-1 text-xs text-text-secondary">Channel ids, comma separated. An empty list allows none.</p>
      </div>
      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input
          type="checkbox"
          checked={form.allowDirectMessages}
          onChange={event => {
            setForm({ ...form, allowDirectMessages: event.target.checked });
          }}
        />
        Answer direct messages
      </label>
    </>
  );

  if (selected !== null) {
    return (
      <>
        <div className="flex items-center gap-2">
          <Button.Ghost
            type="button"
            onClick={() => {
              setSelectedId(null);
            }}
          >
            <Icon name="arrow-left" size="1rem" className="mr-1" />
            Back
          </Button.Ghost>
          <h3 className="text-xl font-semibold tracking-tight text-text-primary">{selected.botDisplayName}</h3>
          <StatusBadge status={selected.status} />
        </div>

        {error ? (
          <p className="mt-3 rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-sm text-failure-bg">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex-1 overflow-y-auto pb-1">
          <div className="flex flex-col gap-5">
            <section aria-labelledby="slack-app-heading" className="rounded-xl border border-border bg-card-bg p-4">
              <h4 id="slack-app-heading" className="text-[0.8125rem] font-semibold uppercase text-text-secondary">
                1 · Create the Slack app
              </h4>
              <p className="mt-2 text-sm text-text-secondary">
                Paste this manifest into Slack. It already carries the scopes, the two event subscriptions and this
                integration&rsquo;s request URL, which Slack checks while it creates the app.
              </p>
              {setup === null ? (
                <p className="mt-3 text-sm text-text-secondary">Loading the manifest…</p>
              ) : (
                <>
                  <pre className="mt-3 max-h-80 overflow-auto rounded-lg border border-border bg-secondary-bg p-3 text-xs text-text-primary">
                    <code>{setup.manifestJson}</code>
                  </pre>
                  <p className="mt-2 break-all text-xs text-text-secondary">Request URL: {setup.requestUrl}</p>
                  {botHandle === undefined ? null : (
                    <p className="mt-1 text-xs text-text-secondary">The bot will appear in Slack as @{botHandle}.</p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button.Secondary type="button" onClick={copyManifest}>
                      <Icon name="copy" size="1rem" className="mr-1" />
                      Copy manifest
                    </Button.Secondary>
                    <Button.Secondary type="button" onClick={downloadManifest}>
                      <Icon name="download" size="1rem" className="mr-1" />
                      Download JSON
                    </Button.Secondary>
                    <a
                      href={setup.createAppUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center text-sm font-medium text-primary-button-bg hover:underline"
                    >
                      Create the app in Slack
                      <Icon name="external-link" size="1rem" className="ml-1" />
                    </a>
                  </div>
                </>
              )}
            </section>

            <form onSubmit={handleSave} className="flex flex-col gap-5">
              <section
                aria-labelledby="slack-credentials-heading"
                className="rounded-xl border border-border bg-card-bg p-4"
              >
                <h4
                  id="slack-credentials-heading"
                  className="text-[0.8125rem] font-semibold uppercase text-text-secondary"
                >
                  2 · Paste the credentials
                </h4>
                <p className="mt-2 text-sm text-text-secondary">
                  Install the app, then copy its bot user OAuth token and signing secret. The workspace and bot user ids
                  are read from Slack, so there is nothing else to type. Leave both blank to keep what is stored.
                </p>
                <div className="mt-3 flex flex-col gap-4">
                  <div>
                    <FieldLabel htmlFor="slack-bot-token">Bot user OAuth token</FieldLabel>
                    <input
                      id="slack-bot-token"
                      type="password"
                      value={botToken}
                      onChange={event => {
                        setBotToken(event.target.value);
                      }}
                      placeholder="xoxb-…"
                      className={auiInputClass('h-11')}
                    />
                  </div>
                  <div>
                    <FieldLabel htmlFor="slack-signing-secret">Signing secret</FieldLabel>
                    <input
                      id="slack-signing-secret"
                      type="password"
                      value={signingSecret}
                      onChange={event => {
                        setSigningSecret(event.target.value);
                      }}
                      className={auiInputClass('h-11')}
                    />
                  </div>
                </div>
                {selected.externalAccountId === undefined ? null : (
                  <p className="mt-3 text-xs text-text-secondary">Workspace: {selected.externalAccountId}</p>
                )}
              </section>

              <section
                aria-labelledby="slack-settings-heading"
                className="rounded-xl border border-border bg-card-bg p-4"
              >
                <h4
                  id="slack-settings-heading"
                  className="text-[0.8125rem] font-semibold uppercase text-text-secondary"
                >
                  Settings
                </h4>
                <div className="mt-3 flex flex-col gap-4">{settingsFields(detailForm, setDetailForm, 'detail')}</div>
              </section>

              <div className="flex justify-between gap-2 pb-2">
                <Button.Ghost type="button" onClick={handleDisconnect} disabled={busy}>
                  Disconnect
                </Button.Ghost>
                <Button.Primary type="submit" disabled={busy}>
                  Save
                </Button.Primary>
              </div>
            </form>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <h3 className="text-xl font-semibold tracking-tight text-text-primary">Integrations</h3>
      <p className="mt-1 text-sm text-text-secondary">Let a Slack workspace talk to one of your agents.</p>

      {error ? (
        <p className="mt-3 rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-sm text-failure-bg">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex-1 overflow-y-hidden">
        <div className="flex h-full flex-col gap-3">
          <div className="flex justify-end">
            <Button.Secondary
              type="button"
              onClick={() => {
                setFormError(null);
                setAddForm(EMPTY_INTEGRATION_FORM);
                setAddOpen(true);
              }}
            >
              <Icon name="plus" size="1rem" className="mr-1" />
              Add Slack workspace
            </Button.Secondary>
          </div>

          <div className="flex flex-1 flex-col gap-5 overflow-y-auto pb-1">
            {loading ? <p className="py-8 text-center text-sm text-text-secondary">Loading…</p> : null}

            {!loading && integrations.length > 0 ? (
              <div className="overflow-hidden rounded-xl border border-border bg-card-bg">
                {integrations.map(integration => (
                  <button
                    key={integration.id}
                    type="button"
                    onClick={() => {
                      openDetail(integration);
                    }}
                    className="flex min-h-16 w-full items-center gap-3 border-b border-border p-3 text-left last:border-b-0 hover:bg-ghost-button-hover/60"
                  >
                    <span
                      className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary-bg"
                      aria-hidden
                    >
                      <Icon name="message-square-text" className="size-4.5 text-text-primary" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-text-primary">
                          {integration.botDisplayName}
                        </span>
                        <StatusBadge status={integration.status} />
                      </span>
                      <span className="block truncate text-xs text-text-secondary">
                        Answers as {integration.defaultAgentName}
                      </span>
                    </span>
                    <Icon name="chevron-right" className="size-4 text-text-secondary" />
                  </button>
                ))}
              </div>
            ) : null}

            {!loading && integrations.length === 0 ? (
              <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-border p-8 text-center text-sm text-text-secondary">
                No integrations yet.
              </div>
            ) : null}
          </div>

          <CenteredModal
            open={addOpen}
            onOpenChange={open => {
              setAddOpen(open);
              if (!open) setFormError(null);
            }}
            title="Add a Slack workspace"
            description="Name the bot and pick its agent; TrueForge then generates the Slack app manifest."
            contentSized
            className="md:max-w-xl"
          >
            <form onSubmit={handleAdd}>
              <div className="flex flex-col gap-4 px-5 py-5">
                {settingsFields(addForm, setAddForm, 'add')}
                {formError ? <p className="text-sm text-failure-bg">{formError}</p> : null}
              </div>
              <footer className="flex justify-end gap-2 border-t border-border px-5 py-4">
                <Button.Ghost
                  type="button"
                  onClick={() => {
                    setAddOpen(false);
                  }}
                  disabled={busy}
                >
                  Cancel
                </Button.Ghost>
                <Button.Primary type="submit" disabled={busy}>
                  Create
                </Button.Primary>
              </footer>
            </form>
          </CenteredModal>
        </div>
      </div>
    </>
  );
};

export default IntegrationSettings;
