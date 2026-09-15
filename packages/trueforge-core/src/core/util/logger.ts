// Logger surface core calls; hosts pass any structurally compatible logger.
export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child(bindings: Record<string, unknown>): Logger;
}
