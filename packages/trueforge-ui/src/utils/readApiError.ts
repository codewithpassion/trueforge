export interface ApiErrorDetails {
  status: number | undefined;
  code: string | undefined;
  message: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A display string from an API-shaped value: its `message`, then its `{ error: { message } }`. */
export function readErrorShapedMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const envelope = value['error'];
  return (
    readNonEmptyString(value['message']) ?? (isRecord(envelope) ? readNonEmptyString(envelope['message']) : undefined)
  );
}

/**
 * Reads an SDK status error structurally (`statusCode` plus the parsed `body`): the SDK's error
 * classes are re-exported through `export *`, which some ESM loaders cannot see by name.
 */
export function readApiError(error: unknown): ApiErrorDetails {
  if (!isRecord(error)) return { status: undefined, code: undefined, message: undefined };
  const status = error['statusCode'];
  const body = error['body'];
  const envelope = isRecord(body) ? body['error'] : undefined;
  const code = isRecord(envelope) ? envelope['code'] : undefined;
  return {
    status: typeof status === 'number' ? status : undefined,
    code: typeof code === 'string' ? code : undefined,
    message: readErrorShapedMessage(body),
  };
}
