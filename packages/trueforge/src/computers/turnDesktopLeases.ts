/**
 * The computers each running turn has sent a desktop op to, so the turn's end releases exactly
 * those leases however the turn ended. Recorded before the op leaves: the relay takes the lease
 * when the op arrives, and a turn cancelled or failed mid-op never learns whether it did.
 * Releasing a lease the turn never took is a no-op, so recording too much costs nothing.
 */
export class TurnDesktopLeases {
  readonly #computersByTurn = new Map<string, Set<string>>();

  record({ turn_id, computer_id }: { turn_id: string; computer_id: string }): void {
    const computers = this.#computersByTurn.get(turn_id) ?? new Set<string>();
    computers.add(computer_id);
    this.#computersByTurn.set(turn_id, computers);
  }

  /** The computers the turn may hold, forgotten here so a second drain releases nothing twice. */
  take(turn_id: string): string[] {
    const computers = this.#computersByTurn.get(turn_id);
    this.#computersByTurn.delete(turn_id);
    return computers === undefined ? [] : [...computers];
  }
}
