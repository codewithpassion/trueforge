import { toSessionExternalId } from '../../../src/integrations/conversationKey';

const MAX_EXTERNAL_ID_LENGTH = 128;

describe('toSessionExternalId', () => {
  it('uses a key that already fits the external id limit', async () => {
    const key = 'slack:T0TEAM:C0GENERAL:1700000000.000100';
    expect(await toSessionExternalId(key)).toBe(key);
  });

  it('keeps a boundary-length key intact', async () => {
    const key = `slack:${'c'.repeat(MAX_EXTERNAL_ID_LENGTH - 6)}`;
    expect(key).toHaveLength(MAX_EXTERNAL_ID_LENGTH);
    expect(await toSessionExternalId(key)).toBe(key);
  });

  it('hashes a longer key into a readable, stable id inside the limit', async () => {
    const key = `slack:${'c'.repeat(400)}`;
    const externalId = await toSessionExternalId(key);

    expect(externalId.length).toBeLessThanOrEqual(MAX_EXTERNAL_ID_LENGTH);
    expect(externalId.startsWith('slack:')).toBe(true);
    expect(externalId).toMatch(/^[A-Za-z0-9:._-]+$/);
    expect(await toSessionExternalId(key)).toBe(externalId);
  });

  it('gives two long keys that share a prefix different ids', async () => {
    const prefix = `slack:${'c'.repeat(400)}`;
    expect(await toSessionExternalId(`${prefix}:1`)).not.toBe(await toSessionExternalId(`${prefix}:2`));
  });
});
