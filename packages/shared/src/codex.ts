const CODEX_THREAD_ID_REGEX =
  /(?:urn:uuid:)?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;

export function extractCodexThreadId(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const match = CODEX_THREAD_ID_REGEX.exec(trimmed);
  return match?.[1]?.toLowerCase() ?? null;
}
