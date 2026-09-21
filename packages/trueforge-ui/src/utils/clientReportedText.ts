/** Control characters and the bidi overrides, which can hide or reverse what a row appears to say. */
const UNSAFE = /[\p{Cc}\p{Cf}]/gu;

/**
 * Text a remote machine chose — its hostname, OS, version, run-as user, a recorded command.
 * Stripped of characters that can misrepresent the rest of the row, and capped so one long
 * value cannot push everything else out of view.
 */
export function clientReportedText(value: string, maxLength = 80): string {
  const stripped = value.replace(UNSAFE, '');
  return stripped.length <= maxLength ? stripped : `${stripped.slice(0, maxLength)}…`;
}
