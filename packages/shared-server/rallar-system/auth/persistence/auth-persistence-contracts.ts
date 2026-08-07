export type PersistedAuthSession = Readonly<{
  clientId: string;
  username: string;
  sessionId: string;
  accessTokenDigest: string;
  issuedAtEpochMs: number;
  expiresAtEpochMs: number;
}>;

export type PersistedWebSocketTicket = Readonly<{
  ticketDigest: string;
  accessTokenDigest: string;
  sessionId: string;
  clientId: string;
  issuedAtEpochMs: number;
  expiresAtEpochMs: number;
}>;

export type PersistedAgentSessionTicket = PersistedWebSocketTicket & Readonly<{ agentId: string }>;

export function decodePersistedAuthSession(input: unknown): PersistedAuthSession {
  const value = requirePlainRecord(input, 'Persisted auth session');
  requireExactKeys(
    value,
    [
      'clientId',
      'username',
      'sessionId',
      'accessTokenDigest',
      'issuedAtEpochMs',
      'expiresAtEpochMs',
    ],
    'Persisted auth session',
  );
  for (const field of ['clientId', 'username', 'sessionId', 'accessTokenDigest'] as const) {
    requireNonEmptyString(value[field], `Persisted auth session ${field}`);
  }
  validateLifecycle(value, 'Persisted auth session');
  return structuredClone(value) as PersistedAuthSession;
}

export function decodePersistedWebSocketTicket(input: unknown): PersistedWebSocketTicket {
  const value = requirePlainRecord(input, 'Persisted websocket ticket');
  requireExactKeys(
    value,
    [
      'ticketDigest',
      'accessTokenDigest',
      'sessionId',
      'clientId',
      'issuedAtEpochMs',
      'expiresAtEpochMs',
    ],
    'Persisted websocket ticket',
  );
  validateTicketFields(value, 'Persisted websocket ticket');
  return structuredClone(value) as PersistedWebSocketTicket;
}

export function decodePersistedAgentSessionTicket(input: unknown): PersistedAgentSessionTicket {
  const value = requirePlainRecord(input, 'Persisted agent session ticket');
  requireExactKeys(
    value,
    [
      'ticketDigest',
      'accessTokenDigest',
      'sessionId',
      'clientId',
      'agentId',
      'issuedAtEpochMs',
      'expiresAtEpochMs',
    ],
    'Persisted agent session ticket',
  );
  validateTicketFields(value, 'Persisted agent session ticket');
  requireNonEmptyString(value.agentId, 'Persisted agent session ticket agentId');
  return structuredClone(value) as PersistedAgentSessionTicket;
}

function validateTicketFields(value: Readonly<Record<string, unknown>>, label: string): void {
  for (const field of ['ticketDigest', 'accessTokenDigest', 'sessionId', 'clientId'] as const) {
    requireNonEmptyString(value[field], `${label} ${field}`);
  }
  validateLifecycle(value, label);
}

function validateLifecycle(value: Readonly<Record<string, unknown>>, label: string): void {
  requireTimestamp(value.issuedAtEpochMs, `${label} issuedAtEpochMs`);
  requireTimestamp(value.expiresAtEpochMs, `${label} expiresAtEpochMs`);
  if (value.issuedAtEpochMs >= value.expiresAtEpochMs) {
    throw new TypeError(`${label} lifecycle is invalid`);
  }
}

function requirePlainRecord(input: unknown, label: string): Readonly<Record<string, unknown>> {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain JSON object`);
  }
  return input as Readonly<Record<string, unknown>>;
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new TypeError(`${label} fields are invalid`);
  }
}

function requireNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} is required`);
  }
}

function requireTimestamp(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} is invalid`);
  }
}
