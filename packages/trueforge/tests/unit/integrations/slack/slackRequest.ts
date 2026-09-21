/**
 * Builds a Slack-signed ingress request. Shared by the jest unit tests and the Workers suite,
 * so both exercise the same signing the adapter verifies.
 */

const SIGNING_SECRET = 'sigsecret';

export const SLACK_TEST_SIGNING_SECRET = SIGNING_SECRET;

function toHex(signature: ArrayBuffer): string {
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function signSlackBody(input: {
  body: string;
  timestamp: string;
  signingSecret?: string;
}): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(input.signingSecret ?? SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`v0:${input.timestamp}:${input.body}`));
  return `v0=${toHex(signature)}`;
}

/**
 * An interactive callback: Slack posts it form-encoded with the JSON in `payload`, and signs
 * the raw form body, not the JSON. Signing the JSON instead is exactly the mistake a fixture
 * would hide, so the body is built once and both the request and the signature use it.
 */
export async function slackInteractionRequest(input: {
  url?: string;
  payload: unknown;
  nowMs?: number;
  signingSecret?: string;
  /** Replaces the computed signature, for the bad-signature cases. */
  signature?: string;
}): Promise<Request> {
  const body = new URLSearchParams({ payload: JSON.stringify(input.payload) }).toString();
  const timestamp = String(Math.floor((input.nowMs ?? Date.now()) / 1000));
  const signature =
    input.signature ??
    (await signSlackBody({
      body,
      timestamp,
      ...(input.signingSecret === undefined ? {} : { signingSecret: input.signingSecret }),
    }));
  return new Request(input.url ?? 'https://trueforge.test/api/v1/integrations/int-1/interactions', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
    body,
  });
}

export async function slackRequest(input: {
  url?: string;
  payload: unknown;
  nowMs?: number;
  signingSecret?: string;
  /** Replaces the computed signature, for the bad-signature cases. */
  signature?: string;
}): Promise<Request> {
  const body = JSON.stringify(input.payload);
  const timestamp = String(Math.floor((input.nowMs ?? Date.now()) / 1000));
  const signature =
    input.signature ??
    (await signSlackBody({
      body,
      timestamp,
      ...(input.signingSecret === undefined ? {} : { signingSecret: input.signingSecret }),
    }));
  return new Request(input.url ?? 'https://trueforge.test/api/v1/integrations/int-1/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
    body,
  });
}
