// prettier-ignore
import type {
  RuntimeStateEntryValue,
} from '../../../../runtime-state/RuntimeStateJsonStore.ts';
// prettier-ignore
import {
  validateRuntimeStateExpiredAuthority,
} from '../../../../runtime-state/RuntimeStateExpiredEntry.ts';
import type { PersistedAuthSession } from '../../persistence/auth-persistence-contracts.ts';
import { authSessionKey, authTokenDigestKey } from '../../persistence/auth-storage-keys.ts';
import type {
  AuthMutationCommand,
  AuthMutationRead,
  AuthSessionEntries,
} from '../auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '../auth-mutation-rejected-error.ts';

interface ValidateLiveSessionAuthorityInput {
  readonly expected: Readonly<{
    clientId: string;
    username: string;
    sessionId: string;
    issuedAtEpochMs: number;
    expiresAtEpochMs: number;
  }>;
  readonly read: AuthSessionEntries;
  readonly capturedAtEpochMs: number;
  readonly label: string;
}

export function equalAuthJson<Left, Right>(left: Left, right: Right): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function requireMatchingAuthKind(
  command: AuthMutationCommand,
  read: AuthMutationRead,
): void {
  if (command.kind !== read.kind) {
    throw new AuthMutationRejectedError('Auth command/read operation differs');
  }
}

export function requireAuthTicket<T>(
  entry: RuntimeStateEntryValue<T> | null,
): RuntimeStateEntryValue<T> {
  if (!entry) {
    throw new AuthMutationRejectedError('Auth ticket is invalid or consumed', 404);
  }
  return entry;
}

export function validateIssueSessionRead(
  session: PersistedAuthSession | undefined,
  read: Readonly<{ kind: 'issue-session' }> & AuthSessionEntries,
): void {
  if (!session) {
    throw new AuthMutationRejectedError('Issued auth session is missing');
  }
  validateRuntimeStateExpiredAuthority(
    read.byToken,
    read.expiredByTokenEntry,
    authTokenDigestKey(session.accessTokenDigest),
    'Auth token index read',
  );
  validateRuntimeStateExpiredAuthority(
    read.bySession,
    read.expiredBySessionEntry,
    authSessionKey(session.sessionId),
    'Auth session index read',
  );
  const tokenMatches = !read.byToken || equalAuthJson(read.byToken.value, session);
  const sessionMatches = !read.bySession || equalAuthJson(read.bySession.value, session);
  if (!tokenMatches || !sessionMatches) {
    throw new AuthMutationRejectedError('Auth session identity collision', 409);
  }
  if ((read.byToken === null) !== (read.bySession === null)) {
    throw new AuthMutationRejectedError('Auth session indexes are inconsistent', 500);
  }
}

export function validateLiveSessionAuthority(validation: ValidateLiveSessionAuthorityInput): void {
  if (
    !validation.read.bySession ||
    !validation.read.byToken ||
    !equalAuthJson(validation.read.bySession.value, validation.read.byToken.value)
  ) {
    throw new AuthMutationRejectedError(`${validation.label} is unavailable`, 401);
  }
  const session = validation.read.bySession.value;
  if (
    session.clientId !== validation.expected.clientId ||
    session.username !== validation.expected.username ||
    session.sessionId !== validation.expected.sessionId ||
    session.issuedAtEpochMs !== validation.expected.issuedAtEpochMs ||
    session.expiresAtEpochMs !== validation.expected.expiresAtEpochMs
  ) {
    throw new AuthMutationRejectedError(`${validation.label} differs`, 403);
  }
  if (session.expiresAtEpochMs <= validation.capturedAtEpochMs) {
    throw new AuthMutationRejectedError(`${validation.label} is expired`, 401);
  }
}
