import { SLACK_SIGNATURE_MAX_AGE_MS, verifySlackSignature } from '../../../../src/integrations/slack/signature';
import { signSlackBody, SLACK_TEST_SIGNING_SECRET } from './slackRequest';

const NOW_MS = 1_700_000_000_000;
const TIMESTAMP = String(NOW_MS / 1000);
const BODY = '{"type":"url_verification","challenge":"abc"}';

async function verify(overrides: Partial<Parameters<typeof verifySlackSignature>[0]> = {}) {
  return verifySlackSignature({
    body: BODY,
    timestamp: TIMESTAMP,
    signature: await signSlackBody({ body: BODY, timestamp: TIMESTAMP }),
    signingSecret: SLACK_TEST_SIGNING_SECRET,
    nowMs: NOW_MS,
    ...overrides,
  });
}

describe('verifySlackSignature', () => {
  it('accepts a signature over the raw body and timestamp', async () => {
    expect(await verify()).toEqual({ valid: true });
  });

  it('rejects a signature that does not match the body', async () => {
    expect(await verify({ body: `${BODY} ` })).toMatchObject({ valid: false });
  });

  it('rejects a signature made with another signing secret', async () => {
    const signature = await signSlackBody({ body: BODY, timestamp: TIMESTAMP, signingSecret: 'other-secret' });
    expect(await verify({ signature })).toEqual({ valid: false, reason: 'Slack signature did not verify' });
  });

  it('rejects a timestamp outside the replay window in either direction', async () => {
    const stale = String((NOW_MS - SLACK_SIGNATURE_MAX_AGE_MS - 1000) / 1000);
    expect(
      await verify({ timestamp: stale, signature: await signSlackBody({ body: BODY, timestamp: stale }) }),
    ).toMatchObject({ valid: false, reason: 'Slack request timestamp is outside the replay window' });

    const future = String((NOW_MS + SLACK_SIGNATURE_MAX_AGE_MS + 1000) / 1000);
    expect(
      await verify({ timestamp: future, signature: await signSlackBody({ body: BODY, timestamp: future }) }),
    ).toMatchObject({ valid: false, reason: 'Slack request timestamp is outside the replay window' });
  });

  it('accepts a timestamp at the edge of the replay window', async () => {
    const edge = String((NOW_MS - SLACK_SIGNATURE_MAX_AGE_MS) / 1000);
    expect(await verify({ timestamp: edge, signature: await signSlackBody({ body: BODY, timestamp: edge }) })).toEqual({
      valid: true,
    });
  });

  it('rejects missing, malformed and unsupported headers', async () => {
    expect(await verify({ signature: null })).toMatchObject({ valid: false });
    expect(await verify({ timestamp: null })).toMatchObject({ valid: false });
    expect(await verify({ timestamp: 'not-a-number' })).toMatchObject({ valid: false });
    expect(await verify({ signature: 'v1=deadbeef' })).toMatchObject({
      valid: false,
      reason: 'Unsupported Slack signature version',
    });
    expect(await verify({ signature: 'v0=nothex' })).toEqual({ valid: false, reason: 'Malformed Slack signature' });
  });

  it('never repeats the signature or the secret in a rejection reason', async () => {
    const result = await verify({ signature: 'v0=abcd' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).not.toContain('abcd');
      expect(result.reason).not.toContain(SLACK_TEST_SIGNING_SECRET);
    }
  });
});
