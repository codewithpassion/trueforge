/** Unique `(tenant_id, name)` violation when creating or renaming a computer. */
export class ComputerNameConflictError extends Error {
  readonly tenant_id: string;
  readonly computer_name: string;

  constructor({ tenant_id, name }: { tenant_id: string; name: string }, options?: ErrorOptions) {
    super(`Computer name already exists: ${name}`, options);
    this.name = 'ComputerNameConflictError';
    this.tenant_id = tenant_id;
    this.computer_name = name;
  }
}
