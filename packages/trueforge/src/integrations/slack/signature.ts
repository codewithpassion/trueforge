/** Slack request signing (`v0`). Web Crypto only, so the same code runs on Node and Workers. */

/** Scheme prefix Slack puts on the header value and inside the signed base string. */
const SIGNATURE_SCHEME = 'v0';
/** Slack's replay window; a timestamp further away in either direction is refused. */
export const SLACK_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

export const SLACK_SIGNATURE_HEADER = 'x-slack-signature';
export const SLACK_TIMESTAMP_HEADER = 'x-slack-request-timestamp';

/** Reasons reach the caller as a 401 body, so none of them may quote the secret or the signature. */
export type SlackSignatureCheck = { valid: true } | { valid: false; reason: string };

function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    return undefined;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Checks `X-Slack-Signature` against the raw body. `crypto.subtle.verify` does the comparison,
 * so the digests are never compared byte by byte in user code.
 */
export async function verifySlackSignature(input: {
  body: string;
  timestamp: string | null;
  signature: string | null;
  signingSecret: string;
  nowMs: number;
}): Promise<SlackSignatureCheck> {
  const { body, timestamp, signature, signingSecret, nowMs } = input;
  if (timestamp === null || signature === null) {
    return { valid: false, reason: 'Missing Slack signature headers' };
  }
  const timestampSeconds = Number(timestamp);
  if (timestamp.trim().length === 0 || !Number.isFinite(timestampSeconds)) {
    return { valid: false, reason: 'Slack request timestamp is not a number' };
  }
  if (Math.abs(nowMs - timestampSeconds * 1000) > SLACK_SIGNATURE_MAX_AGE_MS) {
    return { valid: false, reason: 'Slack request timestamp is outside the replay window' };
  }
  if (!signature.startsWith(`${SIGNATURE_SCHEME}=`)) {
    return { valid: false, reason: 'Unsupported Slack signature version' };
  }
  const provided = hexToBytes(signature.slice(SIGNATURE_SCHEME.length + 1));
  if (provided === undefined) {
    return { valid: false, reason: 'Malformed Slack signature' };
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const verified = await crypto.subtle.verify(
    'HMAC',
    key,
    provided,
    encoder.encode(`${SIGNATURE_SCHEME}:${timestamp}:${body}`),
  );
  return verified ? { valid: true } : { valid: false, reason: 'Slack signature did not verify' };
}
