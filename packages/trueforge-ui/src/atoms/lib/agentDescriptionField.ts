/** Save-request description: trimmed when the form holds a value ('' clears it); omitted when unknown so the stored one is kept. */
export function agentDescriptionField(description: string | undefined): { description?: string } {
  const trimmed = description?.trim();
  return trimmed === undefined ? {} : { description: trimmed };
}

/** Stored description as shown and edited; undefined when unknown. Legacy agents stored their name as description, so that reads as ''. */
export function storedAgentDescription({
  name,
  description,
}: {
  name: string;
  description: string | undefined;
}): string | undefined {
  const trimmed = description?.trim();
  return trimmed === name ? '' : trimmed;
}
