/**
 * Backend-agnostic behavioural contract for IComputerStore.
 * Runs against a fresh store per test (see backend test files).
 */
import type { ComputerCapabilities } from '../../src/computers/protocol';
import type { AppendComputerAuditInput, CreateComputerInput, IComputerStore } from '../../src/db/computerStore';
import { ComputerNameConflictError } from '../../src/db/computerStoreErrors';

const TENANT = 'default';
const OTHER_TENANT = 'other';
const OWNER = 'user_owner';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const CAPABILITIES: ComputerCapabilities = { python3: true, git: false };

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function createInput(overrides: Partial<CreateComputerInput> = {}): CreateComputerInput {
  return {
    id: 'cmp_one',
    tenant_id: TENANT,
    name: 'workshop-mac',
    owner_subject: OWNER,
    require_approval: true,
    code_hash: 'hash_code_one',
    code_expires_at: isoIn(60_000),
    ...overrides,
  };
}

/** ULIDs are 26 characters and sort by time; these differ only in their last two. */
function auditId(sequence: number): string {
  return `01J8Z000000000000000000${String(sequence).padStart(3, '0')}`;
}

function auditInput(overrides: Partial<AppendComputerAuditInput> = {}): AppendComputerAuditInput {
  return {
    id: auditId(1),
    computer_id: 'cmp_one',
    tenant_id: TENANT,
    session_id: 'ses_one',
    turn_id: 'trn_one',
    op: 'exec',
    command: 'ls -la',
    exit_code: 0,
    duration_ms: 42,
    bytes_out: 128,
    created_at: isoIn(0),
    ...overrides,
  };
}

export function runComputerStoreContractSuite(getStore: () => IComputerStore): void {
  it('create round-trips every field, starts pending and holds no credential', async () => {
    const store = getStore();
    const created = await store.createComputer(createInput());

    expect(created.id).toBe('cmp_one');
    expect(created.tenant_id).toBe(TENANT);
    expect(created.name).toBe('workshop-mac');
    expect(created.owner_subject).toBe(OWNER);
    expect(created.status).toBe('pending');
    expect(created.credential_hash).toBeNull();
    expect(created.hostname).toBeNull();
    expect(created.os).toBeNull();
    expect(created.arch).toBeNull();
    expect(created.agent_version).toBeNull();
    expect(created.capabilities).toBeNull();
    expect(created.run_as_user).toBeNull();
    expect(created.require_approval).toBe(true);
    expect(created.last_seen_at).toBeNull();
    expect(created.created_at).toMatch(ISO_UTC);
    expect(created.updated_at).toMatch(ISO_UTC);

    expect(await store.getComputer({ tenant_id: TENANT, computer_id: 'cmp_one' })).toEqual(created);
  });

  it('create writes the first enrollment code in the same write', async () => {
    const store = getStore();
    await store.createComputer(createInput());

    const enrolled = await store.redeemEnrollment({
      code_hash: 'hash_code_one',
      credential_hash: 'hash_cred_one',
      hostname: 'workshop.local',
      os: 'darwin',
      arch: 'arm64',
      agent_version: '1.2.3',
      now: isoIn(0),
    });
    expect(enrolled?.id).toBe('cmp_one');
  });

  it('create stores require_approval false as a real boolean', async () => {
    const store = getStore();
    const created = await store.createComputer(createInput({ require_approval: false }));
    expect(created.require_approval).toBe(false);
    expect((await store.getComputerById('cmp_one'))?.require_approval).toBe(false);
  });

  it('create rejects a duplicate name in the same tenant but allows it in another', async () => {
    const store = getStore();
    await store.createComputer(createInput());

    await expect(
      store.createComputer(createInput({ id: 'cmp_two', code_hash: 'hash_code_two' })),
    ).rejects.toBeInstanceOf(ComputerNameConflictError);

    const other = await store.createComputer(
      createInput({ id: 'cmp_two', tenant_id: OTHER_TENANT, code_hash: 'hash_code_two' }),
    );
    expect(other.tenant_id).toBe(OTHER_TENANT);
    expect(other.name).toBe('workshop-mac');
  });

  it('get and list are tenant scoped while getComputerById is not', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.createComputer(
      createInput({ id: 'cmp_two', tenant_id: OTHER_TENANT, name: 'other-box', code_hash: 'hash_code_two' }),
    );

    expect(await store.getComputer({ tenant_id: OTHER_TENANT, computer_id: 'cmp_one' })).toBeUndefined();
    expect((await store.listComputers(TENANT)).map(row => row.id)).toEqual(['cmp_one']);
    expect((await store.listComputers(OTHER_TENANT)).map(row => row.id)).toEqual(['cmp_two']);
    expect((await store.getComputerById('cmp_two'))?.tenant_id).toBe(OTHER_TENANT);
  });

  it('update changes name and require_approval independently and stays tenant scoped', async () => {
    const store = getStore();
    await store.createComputer(createInput());

    const renamed = await store.updateComputer({
      tenant_id: TENANT,
      computer_id: 'cmp_one',
      name: 'garage-pi',
      require_approval: undefined,
    });
    expect(renamed?.name).toBe('garage-pi');
    expect(renamed?.require_approval).toBe(true);

    const relaxed = await store.updateComputer({
      tenant_id: TENANT,
      computer_id: 'cmp_one',
      name: undefined,
      require_approval: false,
    });
    expect(relaxed?.name).toBe('garage-pi');
    expect(relaxed?.require_approval).toBe(false);

    expect(
      await store.updateComputer({
        tenant_id: OTHER_TENANT,
        computer_id: 'cmp_one',
        name: 'stolen',
        require_approval: undefined,
      }),
    ).toBeUndefined();
    expect((await store.getComputerById('cmp_one'))?.name).toBe('garage-pi');
  });

  it('update rejects a name another computer in the tenant already holds', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.createComputer(createInput({ id: 'cmp_two', name: 'garage-pi', code_hash: 'hash_code_two' }));

    await expect(
      store.updateComputer({
        tenant_id: TENANT,
        computer_id: 'cmp_two',
        name: 'workshop-mac',
        require_approval: undefined,
      }),
    ).rejects.toBeInstanceOf(ComputerNameConflictError);
  });

  it('redeem binds the credential, records the machine facts and leaves the computer offline', async () => {
    const store = getStore();
    await store.createComputer(createInput());

    const enrolled = await store.redeemEnrollment({
      code_hash: 'hash_code_one',
      credential_hash: 'hash_cred_one',
      hostname: 'workshop.local',
      os: 'darwin',
      arch: 'arm64',
      agent_version: '1.2.3',
      now: isoIn(0),
    });

    expect(enrolled?.status).toBe('offline');
    expect(enrolled?.credential_hash).toBe('hash_cred_one');
    expect(enrolled?.hostname).toBe('workshop.local');
    expect(enrolled?.os).toBe('darwin');
    expect(enrolled?.arch).toBe('arm64');
    expect(enrolled?.agent_version).toBe('1.2.3');
    expect(enrolled?.updated_at).toMatch(ISO_UTC);
  });

  it('redeem answers undefined for a used, expired, unknown or revoked code alike', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.createComputer(
      createInput({ id: 'cmp_two', name: 'expired-box', code_hash: 'hash_code_two', code_expires_at: isoIn(-60_000) }),
    );
    await store.createComputer(createInput({ id: 'cmp_three', name: 'dead-box', code_hash: 'hash_code_three' }));
    await store.revokeComputer({ tenant_id: TENANT, computer_id: 'cmp_three' });

    const redeem = async (codeHash: string, credentialHash: string) =>
      await store.redeemEnrollment({
        code_hash: codeHash,
        credential_hash: credentialHash,
        hostname: 'host',
        os: 'linux',
        arch: 'amd64',
        agent_version: '1.0.0',
        now: isoIn(0),
      });

    expect(await redeem('hash_code_one', 'hash_cred_one')).toBeDefined();
    expect(await redeem('hash_code_one', 'hash_cred_again')).toBeUndefined();
    expect(await redeem('hash_code_two', 'hash_cred_two')).toBeUndefined();
    expect(await redeem('hash_code_nope', 'hash_cred_nope')).toBeUndefined();
    expect(await redeem('hash_code_three', 'hash_cred_three')).toBeUndefined();
    expect(await store.getComputerByCredentialHash('hash_cred_three')).toBeUndefined();
  });

  it('getComputerByCredentialHash finds an enrolled machine and never a revoked or unknown one', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.redeemEnrollment({
      code_hash: 'hash_code_one',
      credential_hash: 'hash_cred_one',
      hostname: 'workshop.local',
      os: 'darwin',
      arch: 'arm64',
      agent_version: '1.2.3',
      now: isoIn(0),
    });

    expect((await store.getComputerByCredentialHash('hash_cred_one'))?.id).toBe('cmp_one');
    expect(await store.getComputerByCredentialHash('hash_cred_unknown')).toBeUndefined();

    await store.revokeComputer({ tenant_id: TENANT, computer_id: 'cmp_one' });
    expect(await store.getComputerByCredentialHash('hash_cred_one')).toBeUndefined();
  });

  it('rotate issues a new code, drops the credential and kills the old code', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.redeemEnrollment({
      code_hash: 'hash_code_one',
      credential_hash: 'hash_cred_one',
      hostname: 'workshop.local',
      os: 'darwin',
      arch: 'arm64',
      agent_version: '1.2.3',
      now: isoIn(0),
    });

    const rotated = await store.rotateComputer({
      tenant_id: TENANT,
      computer_id: 'cmp_one',
      code_hash: 'hash_code_two',
      code_expires_at: isoIn(60_000),
    });
    expect(rotated?.status).toBe('pending');
    expect(rotated?.credential_hash).toBeNull();
    expect(await store.getComputerByCredentialHash('hash_cred_one')).toBeUndefined();

    const reEnrolled = await store.redeemEnrollment({
      code_hash: 'hash_code_two',
      credential_hash: 'hash_cred_two',
      hostname: 'workshop.local',
      os: 'darwin',
      arch: 'arm64',
      agent_version: '1.2.4',
      now: isoIn(0),
    });
    expect(reEnrolled?.credential_hash).toBe('hash_cred_two');
  });

  it('rotate retires an unused code that was issued before it', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.rotateComputer({
      tenant_id: TENANT,
      computer_id: 'cmp_one',
      code_hash: 'hash_code_two',
      code_expires_at: isoIn(60_000),
    });

    expect(
      await store.redeemEnrollment({
        code_hash: 'hash_code_one',
        credential_hash: 'hash_cred_one',
        hostname: 'host',
        os: 'linux',
        arch: 'amd64',
        agent_version: '1.0.0',
        now: isoIn(0),
      }),
    ).toBeUndefined();
  });

  it('rotate is tenant scoped and refuses a revoked computer', async () => {
    const store = getStore();
    await store.createComputer(createInput());

    expect(
      await store.rotateComputer({
        tenant_id: OTHER_TENANT,
        computer_id: 'cmp_one',
        code_hash: 'hash_code_two',
        code_expires_at: isoIn(60_000),
      }),
    ).toBeUndefined();

    await store.revokeComputer({ tenant_id: TENANT, computer_id: 'cmp_one' });
    expect(
      await store.rotateComputer({
        tenant_id: TENANT,
        computer_id: 'cmp_one',
        code_hash: 'hash_code_three',
        code_expires_at: isoIn(60_000),
      }),
    ).toBeUndefined();
  });

  it('revoke drops the credential and is tenant scoped', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.redeemEnrollment({
      code_hash: 'hash_code_one',
      credential_hash: 'hash_cred_one',
      hostname: 'workshop.local',
      os: 'darwin',
      arch: 'arm64',
      agent_version: '1.2.3',
      now: isoIn(0),
    });

    expect(await store.revokeComputer({ tenant_id: OTHER_TENANT, computer_id: 'cmp_one' })).toBeUndefined();
    expect((await store.getComputerById('cmp_one'))?.status).toBe('offline');

    const revoked = await store.revokeComputer({ tenant_id: TENANT, computer_id: 'cmp_one' });
    expect(revoked?.status).toBe('revoked');
    expect(revoked?.credential_hash).toBeNull();
  });

  it('delete is tenant scoped and takes the enrollment, access and audit rows with it', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.putAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one', agent_names: ['scout'] });
    await store.appendAudit(auditInput());

    expect(await store.deleteComputer({ tenant_id: OTHER_TENANT, computer_id: 'cmp_one' })).toBe(false);
    expect(await store.deleteComputer({ tenant_id: TENANT, computer_id: 'cmp_one' })).toBe(true);

    expect(await store.getComputerById('cmp_one')).toBeUndefined();
    expect(await store.listAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one' })).toEqual([]);
    expect(
      await store.listAudit({ tenant_id: TENANT, computer_id: 'cmp_one', limit: 10, before_id: undefined }),
    ).toEqual([]);
    expect(
      await store.redeemEnrollment({
        code_hash: 'hash_code_one',
        credential_hash: 'hash_cred_one',
        hostname: 'host',
        os: 'linux',
        arch: 'amd64',
        agent_version: '1.0.0',
        now: isoIn(0),
      }),
    ).toBeUndefined();
  });

  it('recordPresence writes the status, last seen instant and hello facts', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    const seenAt = isoIn(0);

    await store.recordPresence({
      computer_id: 'cmp_one',
      status: 'online',
      last_seen_at: seenAt,
      hello: {
        hostname: 'workshop.local',
        os: 'darwin',
        arch: 'arm64',
        agent_version: '1.2.3',
        run_as_user: 'dom',
        capabilities: CAPABILITIES,
      },
    });

    const present = await store.getComputerById('cmp_one');
    expect(present?.status).toBe('online');
    expect(present?.last_seen_at).toBe(seenAt);
    expect(present?.hostname).toBe('workshop.local');
    expect(present?.run_as_user).toBe('dom');
    expect(present?.capabilities).toEqual(CAPABILITIES);
  });

  it('recordPresence leaves the stored facts alone for a null instant and an absent hello', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    const seenAt = isoIn(0);
    await store.recordPresence({
      computer_id: 'cmp_one',
      status: 'online',
      last_seen_at: seenAt,
      hello: {
        hostname: 'workshop.local',
        os: 'darwin',
        arch: 'arm64',
        agent_version: '1.2.3',
        run_as_user: 'dom',
        capabilities: CAPABILITIES,
      },
    });

    await store.recordPresence({
      computer_id: 'cmp_one',
      status: 'offline',
      last_seen_at: null,
      hello: undefined,
    });

    const present = await store.getComputerById('cmp_one');
    expect(present?.status).toBe('offline');
    expect(present?.last_seen_at).toBe(seenAt);
    expect(present?.hostname).toBe('workshop.local');
    expect(present?.run_as_user).toBe('dom');
    expect(present?.capabilities).toEqual(CAPABILITIES);
  });

  it('recordPresence never resurrects a revoked computer', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.revokeComputer({ tenant_id: TENANT, computer_id: 'cmp_one' });

    await store.recordPresence({
      computer_id: 'cmp_one',
      status: 'online',
      last_seen_at: isoIn(0),
      hello: undefined,
    });

    const present = await store.getComputerById('cmp_one');
    expect(present?.status).toBe('revoked');
    expect(present?.last_seen_at).toBeNull();
  });

  it('putAgentAccess replaces the whole allowlist and returns it sorted', async () => {
    const store = getStore();
    await store.createComputer(createInput());

    expect(
      await store.putAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one', agent_names: ['scout', 'atlas'] }),
    ).toEqual(['atlas', 'scout']);
    expect(await store.listAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one' })).toEqual(['atlas', 'scout']);

    expect(await store.putAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one', agent_names: ['beacon'] })).toEqual([
      'beacon',
    ]);
    expect(await store.listAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one' })).toEqual(['beacon']);

    expect(await store.putAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one', agent_names: [] })).toEqual([]);
    expect(await store.countAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one' })).toBe(0);
  });

  it('isAgentAllowed and countAgentAccess answer for the stored allowlist', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.putAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one', agent_names: ['scout', 'atlas'] });

    expect(await store.isAgentAllowed({ tenant_id: TENANT, computer_id: 'cmp_one', agent_name: 'scout' })).toBe(true);
    expect(await store.isAgentAllowed({ tenant_id: TENANT, computer_id: 'cmp_one', agent_name: 'ghost' })).toBe(false);
    expect(await store.countAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one' })).toBe(2);
  });

  it('agent access is tenant scoped and a foreign put changes nothing', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.putAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one', agent_names: ['scout'] });

    expect(await store.listAgentAccess({ tenant_id: OTHER_TENANT, computer_id: 'cmp_one' })).toEqual([]);
    expect(await store.isAgentAllowed({ tenant_id: OTHER_TENANT, computer_id: 'cmp_one', agent_name: 'scout' })).toBe(
      false,
    );
    expect(await store.countAgentAccess({ tenant_id: OTHER_TENANT, computer_id: 'cmp_one' })).toBe(0);

    expect(
      await store.putAgentAccess({ tenant_id: OTHER_TENANT, computer_id: 'cmp_one', agent_names: ['intruder'] }),
    ).toBeUndefined();
    expect(await store.listAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one' })).toEqual(['scout']);
  });

  it('putAgentAccess stores 150 names, so no statement expands one placeholder per name', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    const names = Array.from({ length: 150 }, (_unused, index) => `agent-${String(index).padStart(3, '0')}`);

    const stored = await store.putAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one', agent_names: names });
    expect(stored).toEqual(names);
    expect(await store.countAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one' })).toBe(150);
    expect(await store.isAgentAllowed({ tenant_id: TENANT, computer_id: 'cmp_one', agent_name: 'agent-149' })).toBe(
      true,
    );
  });

  it('audit rows come back newest first and page on before_id', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.appendAudit(auditInput({ id: auditId(1) }));
    await store.appendAudit(auditInput({ id: auditId(2), op: 'file_put', command: '/tmp/a', exit_code: null }));
    await store.appendAudit(auditInput({ id: auditId(3), op: 'file_get', command: '/tmp/b' }));

    const newest = await store.listAudit({
      tenant_id: TENANT,
      computer_id: 'cmp_one',
      limit: 10,
      before_id: undefined,
    });
    expect(newest.map(row => row.id)).toEqual([auditId(3), auditId(2), auditId(1)]);
    expect(newest[1]?.op).toBe('file_put');
    expect(newest[1]?.exit_code).toBeNull();
    expect(newest[0]?.created_at).toMatch(ISO_UTC);

    const limited = await store.listAudit({
      tenant_id: TENANT,
      computer_id: 'cmp_one',
      limit: 2,
      before_id: undefined,
    });
    expect(limited.map(row => row.id)).toEqual([auditId(3), auditId(2)]);

    const page = await store.listAudit({
      tenant_id: TENANT,
      computer_id: 'cmp_one',
      limit: 10,
      before_id: auditId(2),
    });
    expect(page.map(row => row.id)).toEqual([auditId(1)]);
  });

  it('audit listing is tenant scoped', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.appendAudit(auditInput());

    expect(
      await store.listAudit({ tenant_id: OTHER_TENANT, computer_id: 'cmp_one', limit: 10, before_id: undefined }),
    ).toEqual([]);
  });

  it('deleteAuditBefore drops the older rows and reports how many went', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.appendAudit(auditInput({ id: auditId(1), created_at: isoIn(-120_000) }));
    await store.appendAudit(auditInput({ id: auditId(2), created_at: isoIn(-90_000) }));
    await store.appendAudit(auditInput({ id: auditId(3), created_at: isoIn(0) }));

    expect(await store.deleteAuditBefore({ before: isoIn(-60_000) })).toBe(2);
    const remaining = await store.listAudit({
      tenant_id: TENANT,
      computer_id: 'cmp_one',
      limit: 10,
      before_id: undefined,
    });
    expect(remaining.map(row => row.id)).toEqual([auditId(3)]);
  });
}
