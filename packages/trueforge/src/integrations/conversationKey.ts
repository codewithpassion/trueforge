/** Session `external_id` is capped at 128 characters; longer conversation keys are hashed. */
const MAX_EXTERNAL_ID_LENGTH = 128;
/** Leaves room for the separator and a 43-character base64url SHA-256 digest. */
const PREFIX_LENGTH = 64;

function toBase64Url(digest: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * The session `external_id` for a conversation. Keys within the limit are used as-is;
 * longer ones keep a readable prefix and a SHA-256 digest so they stay stable and unique.
 * Web Crypto keeps this identical on Node and Workers.
 */
export async function toSessionExternalId(conversationKey: string): Promise<string> {
  if (conversationKey.length <= MAX_EXTERNAL_ID_LENGTH) {
    return conversationKey;
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(conversationKey));
  return `${conversationKey.slice(0, PREFIX_LENGTH)}:${toBase64Url(digest)}`;
}
