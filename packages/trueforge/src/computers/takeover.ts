export interface PendingTakeover {
  session_id: string;
  turn_id: string;
  tool_call_id: string;
  reason: string;
  requested_at: string;
  agent_id: string;
}

export interface HumanTakeoverService {
  /** Reads RemoteComputerDO pointers, drops stale ones lazily, and resolves payload from turn state. */
  listPendingTakeovers(input: {
    tenant_id: string;
    computer_id: string;
    agent_id?: string;
  }): Promise<PendingTakeover[]>;
  /** Resumes the session server-side with the tool response; audit row computer.desktop.hand_back / cancel. */
  resolveTakeover(input: {
    tenant_id: string;
    computer_id: string;
    session_id: string;
    outcome: 'completed' | 'cancelled';
    note: string | null;
    acting_user_id: string;
  }): Promise<{ ok: true } | { ok: false; code: 'not_pending' | 'takeover_already_answered' }>;
}
