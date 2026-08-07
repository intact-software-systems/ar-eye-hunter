const RESPONSE_HEADER_ALLOW_LIST = [
  'cache-control',
  'rallar-group-revision',
  'rallar-presence-revision',
  'rallar-state-revision',
  'rallar-state-source',
] as const;

export function normalizeBlackBoxResponseHeaders(
  headers: Headers | Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = {};
  for (const name of RESPONSE_HEADER_ALLOW_LIST) {
    const value = headers instanceof Headers
      ? headers.get(name)
      : readHeaderRecordValue(headers, name);
    if (value !== undefined && value !== null && String(value).length > 0) {
      normalized[name] = String(value);
    }
  }
  return normalized;
}

function readHeaderRecordValue(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(([candidate]) => candidate.toLowerCase() === name);
  return entry?.[1];
}
