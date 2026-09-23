'use client';

import { useCallback, useEffect, useState, type ComponentType, type FormEvent } from 'react';
import { z } from 'zod';

import { cn } from '@/atoms/lib/cn.js';
import { auiInputClass } from '@/atoms/lib/inputClasses.js';
import { Button } from '@/atoms/primitives/Button.js';
import { CenteredModal } from '@/atoms/primitives/CenteredModal.js';
import { useToasterOptional } from '@/containers/ToasterContainer.js';
import { Icon } from '@/icons/Icon.js';
import { useAgentSessionsServer, useIntegrationServer, useOptionalScheduleServer } from '@/server/ServerContext.js';
import type { IntegrationBase, IntegrationNotificationRule, IntegrationSetupManifest } from '@/server/types.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';
import {
  completedNotificationRules,
  EMPTY_INTEGRATION_FORM,
  emptyNotificationRule,
  parseAllowedChannels,
  parseApproverUserIds,
  toIntegrationForm,
  toUpdateIntegrationRequest,
  validateCredentials,
  validateIntegrationForm,
  type IntegrationFormDraft,
} from './integrationForm.js';

/** Schedule names offered by the rule picker; one page is plenty for a datalist. */
const SCHEDULE_PICKER_LIMIT = 25;

export type IntegrationsPageProps = {
  /** The agent whose integrations are listed and created. */
  agentId: string;
};

const NOTIFICATION_OUTCOMES: { value: IntegrationNotificationRule['outcome']; label: string }[] = [
  { value: 'any', label: 'Every run' },
  { value: 'success', label: 'Successful runs' },
  { value: 'failure', label: 'Failed runs' },
];

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

export function IntegrationsPage({ agentId }: IntegrationsPageProps) {
  const integrationServer = useIntegrationServer();
  const sessionsServer = useAgentSessionsServer();
  const scheduleServer = useOptionalScheduleServer();
  const toaster = useToasterOptional();
  const [scheduleNames, setScheduleNames] = useState<string[]>([]);
  // Integrations are bound by agent name; the page is addressed by id.
  const [agentName, setAgentName] = useState<string | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    setAgentName(null);
    setIntegrations([]);
    setLoading(true);
    void sessionsServer
      .getAgent({ agentId })
      .then(detail => {
        if (!cancelled) setAgentName(detail.name);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(getErrorMessage(err, 'Could not load the agent'));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, sessionsServer]);

  const refresh = useCallback(async () => {
    if (agentName === null) return;
    setLoading(true);
    setError(null);
    try {
      setIntegrations(await integrationServer.listIntegrations({ agentNames: [agentName] }));
    } catch (err) {
      setError(getErrorMessage(err, 'Could not load integrations'));
    } finally {
      setLoading(false);
    }
  }, [agentName, integrationServer]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Only to suggest names in the rule editor: a rule may name a schedule this host cannot list.
  useEffect(() => {
    if (scheduleServer === null) return;
    let cancelled = false;
    void scheduleServer
      .listSchedules({ limit: SCHEDULE_PICKER_LIMIT, agentIds: [agentId] })
      .then(page => {
        if (!cancelled) setScheduleNames(page.data.map(schedule => schedule.name));
      })
      .catch(() => {
        // A picker with no suggestions still takes a typed name, so this is not worth reporting.
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, scheduleServer]);

  // The manifest names the integration's own ingress URL, so it is fetched per selection.
  useEffect(() => {
    if (selectedId === null) {
      setSetup(null);
      return;
    }
    let cancelled = false;
    void integrationServer
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
  }, [integrationServer, selectedId]);

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
    if (agentName === null) return;
    const problem = validateIntegrationForm(addForm);
    if (problem !== undefined) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    void runMutation(async () => {
      const created = await integrationServer.createIntegration({
        type: 'slack',
        agentName,
        botDisplayName: addForm.botDisplayName.trim(),
        allowedChannelIds: parseAllowedChannels(addForm.allowedChannels),
        allowDirectMessages: addForm.allowDirectMessages,
        approverUserIds: parseApproverUserIds(addForm.approverUserIds),
        notificationRules: completedNotificationRules(addForm.notificationRules),
      });
      setAddOpen(false);
      setAddForm(EMPTY_INTEGRATION_FORM);
      openDetail(created);
    }, setFormError);
  };

  const handleSave = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected === null) return;
    const problem = validateIntegrationForm(detailForm) ?? validateCredentials({ botToken, signingSecret });
    if (problem !== undefined) {
      setError(problem);
      return;
    }
    void runMutation(async () => {
      const saved = await integrationServer.updateIntegration(
        toUpdateIntegrationRequest({ id: selected.id, form: detailForm, botToken, signingSecret }),
      );
      setBotToken('');
      setSigningSecret('');
      toaster?.showSuccess({ title: saved.status === 'connected' ? 'Slack connected' : 'Saved' });
    });
  };

  const handleDisconnect = () => {
    if (selected === null) return;
    void runMutation(async () => {
      await integrationServer.deleteIntegration({ id: selected.id });
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

  const setRule = (index: number, next: IntegrationNotificationRule) => {
    setDetailForm({
      ...detailForm,
      notificationRules: detailForm.notificationRules.map((rule, position) => (position === index ? next : rule)),
    });
  };

  const notificationRuleRows = detailForm.notificationRules.map((rule, index) => (
    // Rows have no id of their own until they are saved, so position is the only stable key.
    <div key={index} className="grid grid-cols-[1fr_1fr_1fr_2rem] items-end gap-2">
      <div>
        <FieldLabel htmlFor={`rule-${String(index)}-schedule`}>Schedule</FieldLabel>
        <input
          id={`rule-${String(index)}-schedule`}
          list="integration-schedule-names"
          value={rule.scheduleName}
          onChange={event => {
            setRule(index, { ...rule, scheduleName: event.target.value });
          }}
          placeholder="nightly-report"
          className={auiInputClass('h-11')}
        />
      </div>
      <div>
        <FieldLabel htmlFor={`rule-${String(index)}-channel`}>Post to channel</FieldLabel>
        <input
          id={`rule-${String(index)}-channel`}
          value={rule.channelId}
          onChange={event => {
            setRule(index, { ...rule, channelId: event.target.value });
          }}
          placeholder="C0RELEASES"
          className={auiInputClass('h-11')}
        />
      </div>
      <div>
        <FieldLabel htmlFor={`rule-${String(index)}-outcome`}>Post when</FieldLabel>
        <select
          id={`rule-${String(index)}-outcome`}
          value={rule.outcome}
          onChange={event => {
            const outcome = NOTIFICATION_OUTCOMES.find(option => option.value === event.target.value);
            if (outcome !== undefined) {
              setRule(index, { ...rule, outcome: outcome.value });
            }
          }}
          className={auiInputClass('h-11')}
        >
          {NOTIFICATION_OUTCOMES.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        aria-label={`Remove rule ${String(index + 1)}`}
        disabled={busy}
        className="mb-0.5 flex size-9 items-center justify-center rounded-md text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
        onClick={() => {
          setDetailForm({
            ...detailForm,
            notificationRules: detailForm.notificationRules.filter((_, position) => position !== index),
          });
        }}
      >
        <Icon name="trash" className="size-4" />
      </button>
    </div>
  ));

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

  let body;
  if (selected !== null) {
    body = (
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

              <section
                aria-labelledby="slack-approvals-heading"
                className="rounded-xl border border-border bg-card-bg p-4"
              >
                <h4
                  id="slack-approvals-heading"
                  className="text-[0.8125rem] font-semibold uppercase text-text-secondary"
                >
                  Approvals and notifications
                </h4>
                <div className="mt-3 flex flex-col gap-4">
                  <div>
                    <FieldLabel htmlFor="detail-approvers">Who may approve</FieldLabel>
                    <input
                      id="detail-approvers"
                      value={detailForm.approverUserIds}
                      onChange={event => {
                        setDetailForm({ ...detailForm, approverUserIds: event.target.value });
                      }}
                      placeholder="U0ADMIN, U0LEAD"
                      className={auiInputClass('h-11')}
                    />
                    <p className="mt-1 text-xs text-text-secondary">
                      Slack user ids, comma separated. An empty list means nobody can approve a tool call. Answering a
                      question is open to anyone in the thread.
                    </p>
                  </div>
                  <fieldset>
                    <legend className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary">
                      Schedule notifications
                    </legend>
                    <p className="mb-3 text-xs text-text-secondary">
                      Posts a finished schedule run to a channel. The bot must be invited to that channel; it is a
                      posting target, not one it listens in.
                    </p>
                    <datalist id="integration-schedule-names">
                      {scheduleNames.map(name => (
                        <option key={name} value={name} />
                      ))}
                    </datalist>
                    {notificationRuleRows.length === 0 ? (
                      <p className="text-sm text-text-secondary">No notification rules.</p>
                    ) : (
                      <div className="flex flex-col gap-3">{notificationRuleRows}</div>
                    )}
                    <Button.Secondary
                      size="small"
                      type="button"
                      className="mt-4 w-fit"
                      onClick={() => {
                        setDetailForm({
                          ...detailForm,
                          notificationRules: [...detailForm.notificationRules, emptyNotificationRule()],
                        });
                      }}
                    >
                      <Icon name="plus" className="size-3.5" />
                      Add rule
                    </Button.Secondary>
                  </fieldset>
                </div>
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
  } else {
    body = (
      <>
        <h3 className="text-xl font-semibold tracking-tight text-text-primary">Integrations</h3>
        <p className="mt-1 text-sm text-text-secondary">Let a Slack workspace talk to this agent.</p>

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
                disabled={agentName === null}
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
              description="Name the bot; TrueForge then generates the Slack app manifest."
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
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-primary-bg px-6 py-4">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-210 flex-col">{body}</div>
    </div>
  );
}

declare module '../../theme/SlotsProvider.js' {
  interface AtomSlots {
    IntegrationsPage: ComponentType<IntegrationsPageProps>;
  }
}
