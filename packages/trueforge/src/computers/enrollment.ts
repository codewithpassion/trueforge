/**
 * Minting and hashing the two secrets a machine ever holds, and the commands that carry the first
 * one. Both are 32 random bytes; only their sha256 is ever stored.
 */

/** A code is meant to be pasted within a minute or two of being read off a screen. */
export const ENROLLMENT_CODE_TTL_MS = 15 * 60 * 1000;

const SECRET_BYTES = 32;

/** URL-safe base64 so a code survives a shell one-liner and a docker argument unquoted. */
export function mintSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The code travels in the environment so it never shows up in another user's process list. */
export function buildInstallCommand({ baseUrl, code }: { baseUrl: string; code: string }): string {
  return `TRUEFORGE_ENROLL_CODE=${code} sh -c "curl -fsSL ${baseUrl}/install.sh | sh -s -- --url ${baseUrl}"`;
}

/** Null when this deploy names no client image; the install script is then the only way in. */
export function buildDockerCommand({
  baseUrl,
  code,
  image,
}: {
  baseUrl: string;
  code: string;
  image: string;
}): string | null {
  if (image === '') {
    return null;
  }
  // The image's entrypoint is `trueforge-computer run`, which enrolls itself when it holds no
  // credential, so both values arrive in the environment rather than as arguments.
  return [
    'docker run -d --restart unless-stopped',
    '-v trueforge-computer:/var/lib/trueforge-computer',
    `-e TRUEFORGE_URL=${baseUrl}`,
    `-e TRUEFORGE_ENROLL_CODE=${code}`,
    image,
  ].join(' ');
}
