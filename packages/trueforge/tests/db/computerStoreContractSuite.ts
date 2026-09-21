/**
 * Backend-agnostic behavioural contract for IComputerStore.
 * Runs against a fresh store per test (see backend test files).
 */
import type { ComputerCapabilities } from '../../src/computers/protocol';
import type {
  AppendComputerAuditInput,
  ComputerAgentGrant,
  CreateComputerInput,
  IComputerStore,
} from '../../src/db/computerStore';
import { ComputerNameConflictError } from '../../src/db/computerStoreErrors';

const TENANT = 'default';
const OTHER_TENANT = 'other';
const OWNER = 'user_owner';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const CAPABILITIES: ComputerCapabilities = { python3: true, git: false, skills: false };

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
/** Presence is only ever written for a machine that has already enrolled. */
async function enrol(store: IComputerStore): Promise<void> {
  await store.redeemEnrollment({
    code_hash: 'hash_code_one',
    credential_hash: 'hash_cred_one',
    hostname: 'workshop.local',
    os: 'darwin',
    arch: 'arm64',
    agent_version: '1.2.3',
    now: isoIn(0),
  });
}

function auditId(sequence: number): string {
  return `01J8Z000000000000000000${String(sequence).padStart(3, '0')}`;
}

function auditInput(overrides: Partial<AppendComputerAuditInput> = {}): AppendComputerAuditInput {
  return {
    id: auditId(1),
    computer_id: 'cmp_one',
    computer_name: 'workshop-mac',
    tenant_id: TENANT,
    session_id: 'ses_one',
    turn_id: 'trn_one',
    op: 'exec',
    command: 'ls -la',
    exit_code: 0,
    outcome: 'ok',
    duration_ms: 42,
    bytes_out: 128,
    created_at: isoIn(0),
    ...overrides,
  };
}

const SCOUT: ComputerAgentGrant = { agent_id: 'agt_scout', agent_name: 'scout' };
const ATLAS: ComputerAgentGrant = { agent_id: 'agt_atlas', agent_name: 'atlas' };
const BEACON: ComputerAgentGrant = { agent_id: 'agt_beacon', agent_name: 'beacon' };

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

  it('two redeems of one code at the same instant leave exactly one live credential', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    // The same `now` for both is what used to make the loser's guard match the winner's burn.
    const moment = isoIn(0);
    const redeem = async (credentialHash: string) =>
      await store.redeemEnrollment({
        code_hash: 'hash_code_one',
        credential_hash: credentialHash,
        hostname: 'workshop.local',
        os: 'darwin',
        arch: 'arm64',
        agent_version: '1.2.3',
        now: moment,
      });

    const results = await Promise.all([redeem('hash_cred_a'), redeem('hash_cred_b')]);
    const won = results.filter(result => result !== undefined);
    expect(won).toHaveLength(1);

    const stored = await store.getComputerById('cmp_one');
    expect(stored?.credential_hash).toBe(won[0]?.credential_hash);

    const reachable = [
      await store.getComputerByCredentialHash('hash_cred_a'),
      await store.getComputerByCredentialHash('hash_cred_b'),
    ].filter(row => row !== undefined);
    expect(reachable).toHaveLength(1);
    expect(reachable[0]?.credential_hash).toBe(won[0]?.credential_hash);
  });

  it('hasRedeemableEnrollment answers only for a code that redeemEnrollment would still take', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.createComputer(
      createInput({ id: 'cmp_two', name: 'expired-box', code_hash: 'hash_code_two', code_expires_at: isoIn(-60_000) }),
    );
    await store.createComputer(createInput({ id: 'cmp_three', name: 'dead-box', code_hash: 'hash_code_three' }));
    await store.revokeComputer({ tenant_id: TENANT, computer_id: 'cmp_three' });

    const now = isoIn(0);
    expect(await store.hasRedeemableEnrollment({ code_hash: 'hash_code_one', now })).toBe(true);
    expect(await store.hasRedeemableEnrollment({ code_hash: 'hash_code_two', now })).toBe(false);
    expect(await store.hasRedeemableEnrollment({ code_hash: 'hash_code_three', now })).toBe(false);
    expect(await store.hasRedeemableEnrollment({ code_hash: 'hash_code_nope', now })).toBe(false);

    await enrol(store);
    expect(await store.hasRedeemableEnrollment({ code_hash: 'hash_code_one', now })).toBe(false);
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

  it('two rotations at the same instant leave exactly one redeemable code', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await enrol(store);

    const rotate = async (codeHash: string) =>
      await store.rotateComputer({
        tenant_id: TENANT,
        computer_id: 'cmp_one',
        code_hash: codeHash,
        code_expires_at: isoIn(60_000),
      });
    const rotated = await Promise.all([rotate('hash_code_a'), rotate('hash_code_b')]);
    for (const row of rotated) {
      expect(row?.status).toBe('pending');
      expect(row?.credential_hash).toBeNull();
    }

    // Only the rotation that ran last may still be redeemable: the earlier code was retired.
    const redeem = async (codeHash: string) =>
      await store.redeemEnrollment({
        code_hash: codeHash,
        credential_hash: `cred_of_${codeHash}`,
        hostname: 'host',
        os: 'linux',
        arch: 'amd64',
        agent_version: '1.0.0',
        now: isoIn(0),
      });
    const accepted = [await redeem('hash_code_a'), await redeem('hash_code_b')].filter(row => row !== undefined);
    expect(accepted).toHaveLength(1);
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

  it('delete is tenant scoped and takes the enrollment and access rows with it', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.putAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one', agents: [SCOUT] });

    expect(await store.deleteComputer({ tenant_id: OTHER_TENANT, computer_id: 'cmp_one' })).toBe(false);
    expect(await store.deleteComputer({ tenant_id: TENANT, computer_id: 'cmp_one' })).toBe(true);

    expect(await store.getComputerById('cmp_one')).toBeUndefined();
    expect(await store.listAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one' })).toEqual([]);
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

  it('delete leaves the audit rows, so an admin cannot erase what ran on the machine', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.appendAudit(auditInput({ id: auditId(1) }));
    await store.appendAudit(auditInput({ id: auditId(2), command: 'whoami' }));

    expect(await store.deleteComputer({ tenant_id: TENANT, computer_id: 'cmp_one' })).toBe(true);

    const byComputer = await store.listAudit({
      tenant_id: TENANT,
      computer_id: 'cmp_one',
      limit: 10,
      before_id: undefined,
    });
    expect(byComputer.map(row => row.id)).toEqual([auditId(2), auditId(1)]);
    // The denormalised name is the only trace of the machine left.
    expect(byComputer[0]?.computer_name).toBe('workshop-mac');

    const tenantWide = await store.listAudit({
      tenant_id: TENANT,
      computer_id: undefined,
      limit: 10,
      before_id: undefined,
    });
    expect(tenantWide.map(row => row.id)).toEqual([auditId(2), auditId(1)]);
  });

  it('recordPresence writes the status, last seen instant and hello facts', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await enrol(store);
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
    await enrol(store);
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
    await enrol(store);
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

  it('recordPresence leaves a rotated computer pending rather than calling it offline', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await enrol(store);
    await store.rotateComputer({
      tenant_id: TENANT,
      computer_id: 'cmp_one',
      code_hash: 'rotated-code-hash',
      code_expires_at: isoIn(15),
    });

    // The alarm of the socket the rotation closed fires a minute later and must not overwrite
    // `pending`: the machine is waiting to be enrolled again, not unreachable.
    await store.recordPresence({
      computer_id: 'cmp_one',
      status: 'offline',
      last_seen_at: isoIn(0),
      hello: undefined,
    });

    expect((await store.getComputerById('cmp_one'))?.status).toBe('pending');
  });

  it('putAgentAccess replaces the whole allowlist and returns it sorted by name', async () => {
    const store = getStore();
    await store.createComputer(createInput());

    expect(await store.putAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one', agents: [SCOUT, ATLAS] })).toEqual([
      ATLAS,
      SCOUT,
    ]);
    expect(await store.listAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one' })).toEqual([ATLAS, SCOUT]);

    expect(await store.putAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one', agents: [BEACON] })).toEqual([
      BEACON,
    ]);
    expect(await store.listAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one' })).toEqual([BEACON]);

    expect(await store.putAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one', agents: [] })).toEqual([]);
    expect(await store.countAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one' })).toBe(0);
  });

  it('access is keyed by agent id, so a renamed agent keeps it and a reused name gains nothing', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.putAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one', agents: [SCOUT] });

    // The grant follows the id even once the stored display name has gone stale.
    expect(await store.isAgentAllowed({ tenant_id: TENANT, computer_id: 'cmp_one', agent_id: 'agt_scout' })).toBe(true);
    // A different agent that took the name over is a stranger to the allowlist.
    expect(await store.isAgentAllowed({ tenant_id: TENANT, computer_id: 'cmp_one', agent_id: 'agt_impostor' })).toBe(
      false,
    );
  });

  it('isAgentAllowed and countAgentAccess answer for the stored allowlist', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.putAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one', agents: [SCOUT, ATLAS] });

    expect(await store.isAgentAllowed({ tenant_id: TENANT, computer_id: 'cmp_one', agent_id: 'agt_scout' })).toBe(true);
    expect(await store.isAgentAllowed({ tenant_id: TENANT, computer_id: 'cmp_one', agent_id: 'agt_ghost' })).toBe(
      false,
    );
    expect(await store.countAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one' })).toBe(2);
  });

  it('agent access is tenant scoped and a foreign put changes nothing', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.putAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one', agents: [SCOUT] });

    expect(await store.listAgentAccess({ tenant_id: OTHER_TENANT, computer_id: 'cmp_one' })).toEqual([]);
    expect(await store.isAgentAllowed({ tenant_id: OTHER_TENANT, computer_id: 'cmp_one', agent_id: 'agt_scout' })).toBe(
      false,
    );
    expect(await store.countAgentAccess({ tenant_id: OTHER_TENANT, computer_id: 'cmp_one' })).toBe(0);

    expect(
      await store.putAgentAccess({
        tenant_id: OTHER_TENANT,
        computer_id: 'cmp_one',
        agents: [{ agent_id: 'agt_intruder', agent_name: 'intruder' }],
      }),
    ).toBeUndefined();
    expect(await store.listAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one' })).toEqual([SCOUT]);
  });

  it('putAgentAccess stores 150 grants, so no statement expands one placeholder per grant', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    const agents = Array.from({ length: 150 }, (_unused, index) => ({
      agent_id: `agt_${String(index).padStart(3, '0')}`,
      agent_name: `agent-${String(index).padStart(3, '0')}`,
    }));

    const stored = await store.putAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one', agents });
    expect(stored).toEqual(agents);
    expect(await store.countAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one' })).toBe(150);
    expect(await store.isAgentAllowed({ tenant_id: TENANT, computer_id: 'cmp_one', agent_id: 'agt_149' })).toBe(true);
  });

  it('deleteAgentAccessForAgent drops the agent across the tenant and leaves other tenants alone', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.createComputer(createInput({ id: 'cmp_two', name: 'garage-pi', code_hash: 'hash_code_two' }));
    await store.createComputer(createInput({ id: 'cmp_three', tenant_id: OTHER_TENANT, code_hash: 'hash_code_three' }));
    await store.putAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one', agents: [SCOUT, ATLAS] });
    await store.putAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_two', agents: [SCOUT] });
    await store.putAgentAccess({ tenant_id: OTHER_TENANT, computer_id: 'cmp_three', agents: [SCOUT] });

    expect(await store.deleteAgentAccessForAgent({ tenant_id: TENANT, agent_id: 'agt_scout' })).toBe(2);
    expect(await store.listAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_one' })).toEqual([ATLAS]);
    expect(await store.listAgentAccess({ tenant_id: TENANT, computer_id: 'cmp_two' })).toEqual([]);
    expect(await store.listAgentAccess({ tenant_id: OTHER_TENANT, computer_id: 'cmp_three' })).toEqual([SCOUT]);

    expect(await store.deleteAgentAccessForAgent({ tenant_id: TENANT, agent_id: 'agt_scout' })).toBe(0);
  });

  it('audit rows come back newest first and page on before_id', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.appendAudit(auditInput({ id: auditId(1) }));
    await store.appendAudit(
      auditInput({ id: auditId(2), op: 'file_put', command: '/tmp/a', exit_code: null, outcome: 'too_large' }),
    );
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
    expect(newest[1]?.outcome).toBe('too_large');
    expect(newest[0]?.computer_name).toBe('workshop-mac');
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

  it('an undefined computer_id lists the whole tenant, across machines and past a delete', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.createComputer(createInput({ id: 'cmp_two', name: 'garage-pi', code_hash: 'hash_code_two' }));
    await store.appendAudit(auditInput({ id: auditId(1) }));
    await store.appendAudit(auditInput({ id: auditId(2), computer_id: 'cmp_two', computer_name: 'garage-pi' }));
    await store.appendAudit(auditInput({ id: auditId(3) }));

    const spanning = await store.listAudit({
      tenant_id: TENANT,
      computer_id: undefined,
      limit: 10,
      before_id: undefined,
    });
    expect(spanning.map(row => row.id)).toEqual([auditId(3), auditId(2), auditId(1)]);
    expect(spanning.map(row => row.computer_name)).toEqual(['workshop-mac', 'garage-pi', 'workshop-mac']);

    const page = await store.listAudit({
      tenant_id: TENANT,
      computer_id: undefined,
      limit: 10,
      before_id: auditId(3),
    });
    expect(page.map(row => row.id)).toEqual([auditId(2), auditId(1)]);

    await store.deleteComputer({ tenant_id: TENANT, computer_id: 'cmp_two' });
    const afterDelete = await store.listAudit({
      tenant_id: TENANT,
      computer_id: undefined,
      limit: 10,
      before_id: undefined,
    });
    expect(afterDelete.map(row => row.id)).toEqual([auditId(3), auditId(2), auditId(1)]);

    const dead = await store.listAudit({
      tenant_id: TENANT,
      computer_id: 'cmp_two',
      limit: 10,
      before_id: undefined,
    });
    expect(dead.map(row => row.id)).toEqual([auditId(2)]);
    expect(dead[0]?.computer_name).toBe('garage-pi');
  });

  it('audit listing is tenant scoped', async () => {
    const store = getStore();
    await store.createComputer(createInput());
    await store.appendAudit(auditInput());

    expect(
      await store.listAudit({ tenant_id: OTHER_TENANT, computer_id: 'cmp_one', limit: 10, before_id: undefined }),
    ).toEqual([]);
    expect(
      await store.listAudit({ tenant_id: OTHER_TENANT, computer_id: undefined, limit: 10, before_id: undefined }),
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
