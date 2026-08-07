import { requireIssueSessionLifecycle } from '../../sessions/require-issue-session-lifecycle.ts';
import type {
  AuthMutationCommand,
  AuthMutationComputed,
  AuthMutationRead,
  IssueAuthSessionCommand,
  LogoutAuthSessionCommand,
} from '../auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '../auth-mutation-rejected-error.ts';
import { equalAuthJson, validateIssueSessionRead } from './auth-mutation-validation.ts';

type AuthSessionMutationCommand = Extract<
  AuthMutationCommand,
  { kind: 'issue-session' | 'logout-session' }
>;

interface ValidateAuthSessionMutationInput {
  readonly kind: AuthSessionMutationCommand['kind'];
  readonly command: AuthSessionMutationCommand;
  readonly read: AuthMutationRead;
  readonly computed: AuthMutationComputed;
}

export function validateAuthSessionMutation(validation: ValidateAuthSessionMutationInput): void {
  switch (validation.kind) {
    case 'issue-session':
      return validateIssueAuthSession(
        validation.command as IssueAuthSessionCommand,
        validation.read as Extract<AuthMutationRead, { kind: 'issue-session' }>,
        validation.computed,
      );
    case 'logout-session':
      return validateLogoutAuthSession(
        validation.command as LogoutAuthSessionCommand,
        validation.read as Extract<AuthMutationRead, { kind: 'logout-session' }>,
      );
  }
}

function validateIssueAuthSession(
  command: IssueAuthSessionCommand,
  read: Extract<AuthMutationRead, { kind: 'issue-session' }>,
  computed: AuthMutationComputed,
): void {
  requireIssueSessionLifecycle(
    command.capturedAtEpochMs,
    computed.sessions[0]?.session ?? command.session,
  );
  validateIssueSessionRead(computed.sessions[0]?.session, read);
}

function validateLogoutAuthSession(
  command: LogoutAuthSessionCommand,
  read: Extract<AuthMutationRead, { kind: 'logout-session' }>,
): void {
  if (read.bySession === null && read.byToken === null) {
    return;
  }
  if (
    !read.bySession ||
    !read.byToken ||
    !equalAuthJson(read.bySession.value, read.byToken.value)
  ) {
    throw new AuthMutationRejectedError('Auth logout indexes are inconsistent', 500);
  }
  const session = read.bySession.value;
  if (
    session.clientId !== command.expected.clientId ||
    session.username !== command.expected.username ||
    session.sessionId !== command.expected.sessionId ||
    session.issuedAtEpochMs !== command.expected.issuedAtEpochMs ||
    session.expiresAtEpochMs !== command.expected.expiresAtEpochMs
  ) {
    throw new AuthMutationRejectedError('Auth logout authority differs', 403);
  }
}
