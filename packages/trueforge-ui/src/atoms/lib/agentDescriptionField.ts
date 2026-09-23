/** Save-request description: trimmed when the form holds a value ('' clears it); omitted when unknown so the stored one is kept. */
export function agentDescriptionField(description: string | undefined): { description?: string } {
  const trimmed = description?.trim();
  return trimmed === undefined ? {} : { description: trimmed };
}
