'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { cn } from '@/atoms/lib/cn.js';
import { auiInputClass } from '@/atoms/lib/inputClasses.js';
import { Button } from '@/atoms/primitives/Button.js';
import { CenteredModal } from '@/atoms/primitives/CenteredModal.js';
import { Switch } from '@/atoms/primitives/Switch.js';
import { Icon } from '@/icons/Icon.js';
import { useCatalogServer, useOptionalServer } from '@/server/ServerContext.js';
import type { ComputerAuditEntry, ComputerBase, ComputerCatalogServer, ComputerEnrollment } from '@/server/types.js';
import { clientReportedText } from '@/utils/clientReportedText.js';
import { getErrorMessage } from '@/utils/getErrorMessage.js';
import { useToasterOptional } from '../ToasterContainer.js';

/** Agent names offered by the access editor; one page is plenty for a datalist. */
const AGENT_PICKER_LIMIT = 100;
const AUDIT_PAGE_SIZE = 25;
/** Longer than a command usually is; the rest is behind "Show more". */
const COMMAND_PREVIEW_LENGTH = 120;
/** The server truncates at 4 KiB; one row still must not own the page. */
const COMMAND_MAX_LENGTH = 2000;

const STATUS_LABELS: Record<ComputerBase['status'], string> = {
  pending: 'Waiting to enroll',
  online: 'Online',
  offline: 'Offline',
  revoked: 'Revoked',
};

const STATUS_ICONS: Record<ComputerBase['status'], 'clock' | 'circle-check' | 'circle-xmark'> = {
  pending: 'clock',
  online: 'circle-check',
  offline: 'clock',
  revoked: 'circle-xmark',
};

function StatusBadge({ status }: { status: ComputerBase['status'] }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        status === 'online' && 'bg-success-bg/10 text-success-bg',
        status === 'revoked' && 'bg-failure-bg/10 text-failure-bg',
        status !== 'online' && status !== 'revoked' && 'bg-secondary-bg text-text-secondary',
      )}
    >
      <Icon name={STATUS_ICONS[status]} className="size-3" />
      {STATUS_LABELS[status]}
    </span>
  );
}

function formatInstant(value: string | null): string {
  if (value === null) return 'never';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function reported(value: string | null, fallback: string): string {
  return value === null ? fallback : clientReportedText(value);
}

function toolsLabel(tools: ComputerBase['tools']): string {
  if (tools === null) return 'not reported yet';
  const present = [tools.python3 ? 'python3' : undefined, tools.git ? 'git' : undefined].filter(
    (name): name is string => name !== undefined,
  );
  return present.length === 0 ? 'none detected' : present.join(', ');
}

function SecurityNote() {
  return (
    <p className="flex items-start gap-2 rounded-md border border-warning-bg/30 bg-warning-bg/10 px-3 py-2 text-sm text-text-primary">
      <Icon name="triangle-exclamation" className="mt-0.5 size-4 shrink-0 text-warning-bg" />
      <span>
        This is a real machine, not a sandbox. Commands run as the client&rsquo;s user and reach whatever that user can
        reach, and anything the agent reads — a web page, a file, a tool result — can steer what it runs.
      </span>
    </p>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const toaster = useToasterOptional();
  const [failed, setFailed] = useState(false);
  return (
    <Button.Secondary
      size="small"
      type="button"
      onClick={() => {
        // Absent outside a secure context, where an optional call would silently do nothing.
        const clipboard = navigator.clipboard;
        if (clipboard === undefined) {
          setFailed(true);
          return;
        }
        void clipboard.writeText(value).then(
          () => {
            setFailed(false);
            toaster?.showSuccess({ title: `${label} copied` });
          },
          () => {
            setFailed(true);
          },
        );
      }}
    >
      <Icon name="copy" size="1rem" className="mr-1" />
      {failed ? 'Could not copy — select it instead' : `Copy ${label.toLowerCase()}`}
    </Button.Secondary>
  );
}

function CommandBlock({ title, command, label }: { title: string; command: string; label: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{title}</p>
      <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-border bg-secondary-bg p-3 text-xs text-text-primary">
        <code>{command}</code>
      </pre>
      <div className="mt-2">
        <CopyButton value={command} label={label} />
      </div>
    </div>
  );
}

function AuditCommand({ command }: { command: string }) {
  const [expanded, setExpanded] = useState(false);
  // A recorded command is the machine's text: capped generously here, previewed shorter below.
  const safe = clientReportedText(command, COMMAND_MAX_LENGTH);
  if (safe.length <= COMMAND_PREVIEW_LENGTH) {
    return <code className="break-all text-xs text-text-primary">{safe}</code>;
  }
  return (
    <span className="flex flex-col items-start gap-1">
      <code className="break-all text-xs text-text-primary">
        {expanded ? safe : `${safe.slice(0, COMMAND_PREVIEW_LENGTH)}…`}
      </code>
      <button
        type="button"
        className="text-xs font-medium text-primary-button-bg hover:underline"
        onClick={() => {
          setExpanded(!expanded);
        }}
      >
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </span>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className="min-w-0 break-words text-right text-text-primary">{children}</span>
    </div>
  );
}

type PendingConfirm = 'rotate' | 'revoke' | 'delete';

const CONFIRM_TITLES: Record<PendingConfirm, string> = {
  rotate: 'Rotate the enrollment?',
  revoke: 'Revoke this computer?',
  delete: 'Delete this computer?',
};

const CONFIRM_DESCRIPTIONS: Record<PendingConfirm, string> = {
  rotate:
    'The current credential stops working and the connection closes. The machine has to enroll again with the new code.',
  revoke:
    'The credential is dropped and the live connection closes. This cannot be undone: the machine has to be added again from scratch.',
  delete:
    'The computer is removed and its credential stops working, so the machine can no longer connect. This cannot be undone. What already ran on it stays in the activity log for 30 days.',
};

/**
 * Held in component state until the admin dismisses it: the code is never readable again.
 * Only the two commands are kept — a second copy of the bare code would be one more place
 * for it to be read from.
 */
type OneTimeEnrollment = { computerName: string; installCommand: string; dockerCommand: string | null };

function toOneTime({ computerName, enrollment }: { computerName: string; enrollment: ComputerEnrollment }) {
  return { computerName, installCommand: enrollment.installCommand, dockerCommand: enrollment.dockerCommand };
}

const ComputerSettings = () => {
  const catalog = useCatalogServer();
  // The section only renders when the host supplied this port (see SettingsBuilder/index.tsx).
  const computerCatalog: ComputerCatalogServer | undefined = catalog.computerCatalog;
  const server = useOptionalServer();

  const [computers, setComputers] = useState<ComputerBase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [oneTime, setOneTime] = useState<OneTimeEnrollment | null>(null);

  const [detailName, setDetailName] = useState('');
  const [detailRequireApproval, setDetailRequireApproval] = useState(true);

  const [agentNames, setAgentNames] = useState<string[]>([]);
  const [agentDraft, setAgentDraft] = useState('');
  const [accessError, setAccessError] = useState<string | null>(null);
  // Distinct from an empty allowlist: neither may be read as "no agent holds this computer".
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessFailed, setAccessFailed] = useState(false);
  const [accessEpoch, setAccessEpoch] = useState(0);
  const [knownAgentNames, setKnownAgentNames] = useState<string[]>([]);

  const [audit, setAudit] = useState<ComputerAuditEntry[]>([]);
  const [auditNextToken, setAuditNextToken] = useState<string | undefined>(undefined);
  const [auditLoading, setAuditLoading] = useState(false);

  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);

  const selected = computers.find(computer => computer.id === selectedId) ?? null;

  const refresh = useCallback(async () => {
    if (computerCatalog === undefined) return;
    setLoading(true);
    setError(null);
    try {
      setComputers(await computerCatalog.listComputers());
    } catch (err) {
      setError(getErrorMessage(err, 'Could not load computers'));
    } finally {
      setLoading(false);
    }
  }, [computerCatalog]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Only to suggest names in the access editor; a grant may name an agent this list omits.
  useEffect(() => {
    if (server === null) return;
    let cancelled = false;
    void server
      .searchAgents({ limit: AGENT_PICKER_LIMIT })
      .then(agents => {
        if (!cancelled) setKnownAgentNames(agents.map(agent => agent.name));
      })
      .catch(() => {
        // A picker with no suggestions still takes a typed name, so this is not worth reporting.
      });
    return () => {
      cancelled = true;
    };
  }, [server]);

  // Access and audit belong to the selected machine, so both are fetched per selection.
  useEffect(() => {
    if (computerCatalog === undefined || selectedId === null) {
      setAgentNames([]);
      setAudit([]);
      setAuditNextToken(undefined);
      return;
    }
    let cancelled = false;
    setAccessLoading(true);
    setAccessFailed(false);
    void computerCatalog
      .getComputerAgentAccess({ computerId: selectedId })
      .then(names => {
        if (cancelled) return;
        setAgentNames(names);
        setAccessError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setAccessFailed(true);
        setAccessError(getErrorMessage(err, 'Could not load agent access'));
      })
      .finally(() => {
        if (!cancelled) setAccessLoading(false);
      });
    void computerCatalog
      .listComputerAudit({ computerId: selectedId, limit: AUDIT_PAGE_SIZE })
      .then(page => {
        if (cancelled) return;
        setAudit(page.data);
        setAuditNextToken(page.nextPageToken);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(getErrorMessage(err, 'Could not load the activity list'));
      });
    return () => {
      cancelled = true;
    };
  }, [computerCatalog, selectedId, accessEpoch]);

  const openDetail = (computer: ComputerBase) => {
    setSelectedId(computer.id);
    setDetailName(computer.name);
    setDetailRequireApproval(computer.requireApproval);
    setError(null);
    setAccessError(null);
    setAccessFailed(false);
    setAgentDraft('');
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
    if (computerCatalog === undefined) return;
    const name = addName.trim();
    if (name === '') {
      setFormError('Give the computer a name.');
      return;
    }
    setFormError(null);
    void runMutation(async () => {
      const created = await computerCatalog.createComputer({ name, requireApproval: true });
      // Set before the list refresh inside runMutation, and never cleared by it.
      setOneTime(toOneTime({ computerName: created.computer.name, enrollment: created.enrollment }));
      setAddOpen(false);
      setAddName('');
    }, setFormError);
  };

  const handleSaveDetail = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (computerCatalog === undefined || selected === null) return;
    const name = detailName.trim();
    if (name === '') {
      setError('Give the computer a name.');
      return;
    }
    void runMutation(async () => {
      await computerCatalog.updateComputer({
        computerId: selected.id,
        name,
        requireApproval: detailRequireApproval,
      });
    });
  };

  const handleSaveAccess = (next: string[]) => {
    if (computerCatalog === undefined || selected === null) return;
    setAccessError(null);
    void runMutation(async () => {
      setAgentNames(await computerCatalog.putComputerAgentAccess({ computerId: selected.id, agentNames: next }));
      setAgentDraft('');
    }, setAccessError);
  };

  const handleRotate = () => {
    if (computerCatalog === undefined || selected === null) return;
    setConfirm(null);
    void runMutation(async () => {
      const enrollment = await computerCatalog.rotateComputerEnrollment({ computerId: selected.id });
      setOneTime(toOneTime({ computerName: selected.name, enrollment }));
    });
  };

  const handleRevoke = () => {
    if (computerCatalog === undefined || selected === null) return;
    setConfirm(null);
    void runMutation(async () => {
      await computerCatalog.revokeComputer({ computerId: selected.id });
    });
  };

  const handleDelete = () => {
    if (computerCatalog === undefined || selected === null) return;
    setConfirm(null);
    void runMutation(async () => {
      await computerCatalog.deleteComputer({ computerId: selected.id });
      setSelectedId(null);
    });
  };

  const loadMoreAudit = () => {
    if (computerCatalog === undefined || selectedId === null || auditNextToken === undefined) return;
    const pageToken = auditNextToken;
    setAuditLoading(true);
    void computerCatalog
      .listComputerAudit({ computerId: selectedId, limit: AUDIT_PAGE_SIZE, pageToken })
      .then(page => {
        setAudit(current => [...current, ...page.data]);
        setAuditNextToken(page.nextPageToken);
      })
      .catch((err: unknown) => {
        setError(getErrorMessage(err, 'Could not load more activity'));
      })
      .finally(() => {
        setAuditLoading(false);
      });
  };

  if (computerCatalog === undefined) return null;

  const oneTimePanel = (
    <CenteredModal
      open={oneTime !== null}
      // Nothing but Done may close it: an Escape here costs a rotate to recover.
      onOpenChange={() => undefined}
      persistent
      title="Run this on the machine"
      description={
        oneTime === null ? undefined : `The enrollment code for ${oneTime.computerName} is shown once, here, now.`
      }
      contentSized
      className="md:max-w-2xl"
    >
      {oneTime === null ? null : (
        <div className="flex flex-col gap-4 px-5 py-5">
          <p className="flex items-start gap-2 rounded-md border border-warning-bg/30 bg-warning-bg/10 px-3 py-2 text-sm text-text-primary">
            <Icon name="triangle-exclamation" className="mt-0.5 size-4 shrink-0 text-warning-bg" />
            <span>
              Copy a command now. The code is single-use, expires in 15 minutes, and cannot be shown again — if you lose
              it, rotate the enrollment for a fresh one.
            </span>
          </p>
          <CommandBlock title="Install and run" command={oneTime.installCommand} label="Install command" />
          {oneTime.dockerCommand === null ? (
            <p className="text-sm text-text-secondary">
              This server has no client image configured, so there is no Docker command.
            </p>
          ) : (
            <CommandBlock title="Or run in Docker" command={oneTime.dockerCommand} label="Docker command" />
          )}
        </div>
      )}
      <footer className="flex justify-end gap-2 border-t border-border px-5 py-4">
        <Button.Primary
          type="button"
          onClick={() => {
            setOneTime(null);
          }}
        >
          Done
        </Button.Primary>
      </footer>
    </CenteredModal>
  );

  if (selected !== null) {
    const grantedCount = agentNames.length;
    const revoked = selected.status === 'revoked';
    // An empty list is only evidence of "no grants" once the lookup actually came back.
    const grantsKnown = !accessLoading && !accessFailed;
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
          <h3 className="text-xl font-semibold tracking-tight text-text-primary">{selected.name}</h3>
          <StatusBadge status={selected.status} />
        </div>

        {error ? (
          <p className="mt-3 rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-sm text-failure-bg">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex-1 overflow-y-auto pb-1">
          <div className="flex flex-col gap-5">
            <SecurityNote />

            <section
              aria-labelledby="computer-facts-heading"
              className="rounded-xl border border-border bg-card-bg p-4"
            >
              <h4 id="computer-facts-heading" className="text-[0.8125rem] font-semibold uppercase text-text-secondary">
                What the machine reports
              </h4>
              <div className="mt-3 divide-y divide-border">
                <DetailRow label="Hostname">{reported(selected.hostname, 'not reported yet')}</DetailRow>
                <DetailRow label="OS">
                  {selected.os === null
                    ? 'not reported yet'
                    : `${reported(selected.os, '')}${selected.arch === null ? '' : ` / ${reported(selected.arch, '')}`}`}
                </DetailRow>
                <DetailRow label="Client version">{reported(selected.agentVersion, 'not reported yet')}</DetailRow>
                <DetailRow label="Runs commands as">{reported(selected.runAsUser, 'not reported yet')}</DetailRow>
                <DetailRow label="Detected tools">{toolsLabel(selected.tools)}</DetailRow>
                <DetailRow label="Last seen">{formatInstant(selected.lastSeenAt)}</DetailRow>
              </div>
            </section>

            <form onSubmit={handleSaveDetail} className="rounded-xl border border-border bg-card-bg p-4">
              <h4 className="text-[0.8125rem] font-semibold uppercase text-text-secondary">Settings</h4>
              <div className="mt-3 flex flex-col gap-4">
                <div>
                  <label
                    htmlFor="computer-name"
                    className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary"
                  >
                    Name
                  </label>
                  <input
                    id="computer-name"
                    value={detailName}
                    disabled={revoked}
                    onChange={event => {
                      setDetailName(event.target.value);
                    }}
                    className={auiInputClass('h-11 disabled:opacity-60')}
                  />
                </div>
                <div className="flex items-start justify-between gap-4">
                  <span>
                    <span className="block text-sm font-medium text-text-primary">Ask before each command</span>
                    <span className="mt-0.5 block text-xs text-text-secondary">
                      Stored now, enforced from a later release — this server records the setting but does not yet pause
                      a command for approval.
                    </span>
                  </span>
                  <Switch
                    checked={detailRequireApproval}
                    disabled={busy || revoked}
                    onCheckedChange={setDetailRequireApproval}
                    aria-label="Ask before each command"
                  />
                </div>
                <div className="flex items-center justify-end gap-3">
                  {revoked ? (
                    <span className="text-xs text-text-secondary">
                      This computer is revoked, so there is nothing left for a setting to apply to.
                    </span>
                  ) : null}
                  <Button.Primary type="submit" disabled={busy || revoked}>
                    Save
                  </Button.Primary>
                </div>
              </div>
            </form>

            <section
              aria-labelledby="computer-access-heading"
              className="rounded-xl border border-border bg-card-bg p-4"
            >
              <h4 id="computer-access-heading" className="text-[0.8125rem] font-semibold uppercase text-text-secondary">
                Agents allowed to use it
              </h4>
              <p className="mt-2 text-sm text-text-secondary">
                Granting an agent trusts everyone who can edit that agent: they can point it at this machine and change
                what it is told to do. Only saved, named agents can be granted.
              </p>
              {accessError ? (
                <p className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-failure-bg/30 bg-failure-bg/10 px-3 py-2 text-sm text-failure-bg">
                  <span>{accessError}</span>
                  {accessFailed ? (
                    <Button.Secondary
                      size="small"
                      type="button"
                      onClick={() => {
                        setAccessEpoch(epoch => epoch + 1);
                      }}
                    >
                      <Icon name="rotate-right" size="1rem" className="mr-1" />
                      Try again
                    </Button.Secondary>
                  ) : null}
                </p>
              ) : null}
              <ul className="mt-3 flex flex-wrap gap-2">
                {agentNames.map(name => (
                  <li
                    key={name}
                    className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-text-primary"
                  >
                    {name}
                    <button
                      type="button"
                      aria-label={`Remove ${name}`}
                      disabled={busy}
                      className="text-text-secondary transition-colors hover:text-text-primary disabled:opacity-40"
                      onClick={() => {
                        handleSaveAccess(agentNames.filter(granted => granted !== name));
                      }}
                    >
                      <Icon name="xmark" className="size-3.5" />
                    </button>
                  </li>
                ))}
                {agentNames.length === 0 ? (
                  <li className="text-sm text-text-secondary">
                    {accessLoading
                      ? 'Loading the allowlist…'
                      : accessFailed
                        ? 'The allowlist could not be read, so what holds this computer is unknown.'
                        : 'No agents granted.'}
                  </li>
                ) : null}
              </ul>
              <datalist id="computer-agent-names">
                {knownAgentNames.map(name => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <div className="mt-3 flex gap-2">
                <input
                  aria-label="Agent name"
                  list="computer-agent-names"
                  value={agentDraft}
                  onChange={event => {
                    setAgentDraft(event.target.value);
                  }}
                  placeholder="release-bot"
                  className={auiInputClass('h-11')}
                />
                <Button.Secondary
                  type="button"
                  disabled={busy || accessFailed || agentDraft.trim() === ''}
                  onClick={() => {
                    const name = agentDraft.trim();
                    if (name === '' || agentNames.includes(name)) return;
                    handleSaveAccess([...agentNames, name]);
                  }}
                >
                  <Icon name="plus" size="1rem" className="mr-1" />
                  Grant
                </Button.Secondary>
              </div>
            </section>

            <section
              aria-labelledby="computer-audit-heading"
              className="rounded-xl border border-border bg-card-bg p-4"
            >
              <h4 id="computer-audit-heading" className="text-[0.8125rem] font-semibold uppercase text-text-secondary">
                Activity
              </h4>
              <p className="mt-2 text-sm text-text-secondary">
                Newest first. Commands are stored in clear for 30 days, so a secret typed into one is readable here
                until it is swept.
              </p>
              {audit.length === 0 ? (
                <p className="mt-3 text-sm text-text-secondary">Nothing has run on this computer yet.</p>
              ) : (
                <ul className="mt-3 divide-y divide-border">
                  {audit.map(entry => (
                    <li key={entry.id} className="flex flex-col gap-1 py-3">
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
                        <span>{formatInstant(entry.createdAt)}</span>
                        <span className="font-medium text-text-primary">{entry.op}</span>
                        <span>{entry.sessionId === null ? 'no session' : `session ${entry.sessionId}`}</span>
                        <span>exit {entry.exitCode === null ? 'unknown' : String(entry.exitCode)}</span>
                        <span>{entry.outcome}</span>
                        <span>{entry.durationMs} ms</span>
                      </span>
                      <AuditCommand command={entry.command} />
                    </li>
                  ))}
                </ul>
              )}
              {auditNextToken === undefined ? null : (
                <Button.Secondary
                  size="small"
                  type="button"
                  className="mt-3"
                  disabled={auditLoading}
                  onClick={loadMoreAudit}
                >
                  {auditLoading ? 'Loading…' : 'Load more'}
                </Button.Secondary>
              )}
            </section>

            <section
              aria-labelledby="computer-danger-heading"
              className="rounded-xl border border-border bg-card-bg p-4"
            >
              <h4 id="computer-danger-heading" className="text-[0.8125rem] font-semibold uppercase text-text-secondary">
                Enrollment and removal
              </h4>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button.Secondary
                  type="button"
                  disabled={busy || revoked}
                  onClick={() => {
                    setConfirm('rotate');
                  }}
                >
                  <Icon name="rotate-right" size="1rem" className="mr-1" />
                  Rotate enrollment
                </Button.Secondary>
                <Button.Destructive
                  type="button"
                  disabled={busy || revoked}
                  onClick={() => {
                    setConfirm('revoke');
                  }}
                >
                  Revoke
                </Button.Destructive>
                <Button.Ghost
                  type="button"
                  disabled={busy || !grantsKnown || grantedCount > 0}
                  onClick={() => {
                    setConfirm('delete');
                  }}
                >
                  <Icon name="trash" size="1rem" className="mr-1" />
                  Delete
                </Button.Ghost>
              </div>
              {revoked ? (
                <p className="mt-2 text-xs text-text-secondary">
                  A revoked computer holds no credential, so there is nothing left to rotate or revoke. Delete it once
                  no agent is granted it.
                </p>
              ) : null}
              {grantsKnown && grantedCount > 0 ? (
                <p className="mt-2 text-xs text-text-secondary">
                  {grantedCount} agent(s) are still allowed to use this computer — remove their access before deleting
                  it.
                </p>
              ) : null}
              {grantsKnown ? null : (
                <p className="mt-2 text-xs text-text-secondary">
                  {accessLoading
                    ? 'Checking which agents hold this computer…'
                    : 'Deleting is held back until the allowlist can be read — retry it above.'}
                </p>
              )}
            </section>
          </div>
        </div>

        <CenteredModal
          open={confirm !== null}
          onOpenChange={open => {
            if (!open) setConfirm(null);
          }}
          title={CONFIRM_TITLES[confirm ?? 'rotate']}
          description={CONFIRM_DESCRIPTIONS[confirm ?? 'rotate']}
          contentSized
        >
          <footer className="flex justify-end gap-2 border-t border-border px-5 py-4">
            <Button.Ghost
              type="button"
              onClick={() => {
                setConfirm(null);
              }}
            >
              Cancel
            </Button.Ghost>
            {confirm === 'revoke' ? (
              <Button.Destructive type="button" disabled={busy} onClick={handleRevoke}>
                Revoke
              </Button.Destructive>
            ) : confirm === 'delete' ? (
              <Button.Destructive type="button" disabled={busy} onClick={handleDelete}>
                Delete
              </Button.Destructive>
            ) : (
              <Button.Primary type="button" disabled={busy} onClick={handleRotate}>
                Rotate
              </Button.Primary>
            )}
          </footer>
        </CenteredModal>

        {oneTimePanel}
      </>
    );
  }

  return (
    <>
      <h3 className="text-xl font-semibold tracking-tight text-text-primary">Computers</h3>
      <p className="mt-1 text-sm text-text-secondary">Let an agent run on a machine you own instead of a sandbox.</p>

      <div className="mt-3">
        <SecurityNote />
      </div>

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
                setAddName('');
                setAddOpen(true);
              }}
            >
              <Icon name="plus" size="1rem" className="mr-1" />
              Add computer
            </Button.Secondary>
          </div>

          <div className="flex flex-1 flex-col gap-5 overflow-y-auto pb-1">
            {loading ? <p className="py-8 text-center text-sm text-text-secondary">Loading…</p> : null}

            {!loading && computers.length > 0 ? (
              <div className="overflow-hidden rounded-xl border border-border bg-card-bg">
                {computers.map(computer => (
                  <button
                    key={computer.id}
                    type="button"
                    onClick={() => {
                      openDetail(computer);
                    }}
                    className="flex min-h-16 w-full items-center gap-3 border-b border-border p-3 text-left last:border-b-0 hover:bg-ghost-button-hover/60"
                  >
                    <span
                      className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary-bg"
                      aria-hidden
                    >
                      <Icon name="terminal" className="size-4.5 text-text-primary" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-text-primary">{computer.name}</span>
                        <StatusBadge status={computer.status} />
                      </span>
                      <span className="block truncate text-xs text-text-secondary">
                        {reported(computer.hostname, 'no hostname yet')} · {reported(computer.os, 'unknown OS')} ·{' '}
                        {reported(computer.agentVersion, 'no version')} · as{' '}
                        {reported(computer.runAsUser, 'unknown user')} · {toolsLabel(computer.tools)} · last seen{' '}
                        {formatInstant(computer.lastSeenAt)}
                      </span>
                    </span>
                    <Icon name="chevron-right" className="size-4 text-text-secondary" />
                  </button>
                ))}
              </div>
            ) : null}

            {!loading && computers.length === 0 ? (
              <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-border p-8 text-center text-sm text-text-secondary">
                No computers yet.
              </div>
            ) : null}
          </div>

          <CenteredModal
            open={addOpen}
            onOpenChange={open => {
              setAddOpen(open);
              if (!open) setFormError(null);
            }}
            title="Add a computer"
            description="Name it, then run the command it gives you on the machine."
            contentSized
            className="md:max-w-xl"
          >
            <form onSubmit={handleAdd}>
              <div className="flex flex-col gap-4 px-5 py-5">
                <div>
                  <label
                    htmlFor="add-computer-name"
                    className="mb-2 block text-xs font-semibold uppercase tracking-wide text-text-secondary"
                  >
                    Name
                  </label>
                  <input
                    id="add-computer-name"
                    value={addName}
                    onChange={event => {
                      setAddName(event.target.value);
                    }}
                    placeholder="office-box"
                    className={auiInputClass('h-11')}
                  />
                </div>
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

          {oneTimePanel}
        </div>
      </div>
    </>
  );
};

export default ComputerSettings;
