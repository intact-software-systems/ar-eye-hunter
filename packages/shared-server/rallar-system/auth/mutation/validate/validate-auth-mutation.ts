import type {
  AuthMutationCommand,
  AuthMutationComputed,
  AuthMutationRead,
} from '../auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '../auth-mutation-rejected-error.ts';
import { requireMatchingAuthKind } from './auth-mutation-validation.ts';
import { validateAuthAgentTicketMutation } from './validate-auth-agent-ticket-mutation.ts';
import { validateAuthSessionMutation } from './validate-auth-session-mutation.ts';
import { validateAuthTicketMutation } from './validate-auth-ticket-mutation.ts';
import { validateAuthUserMutation } from './validate-auth-user-mutation.ts';

export function validateAuthMutation(
  command: AuthMutationCommand,
  read: AuthMutationRead,
  computed: AuthMutationComputed,
): void {
  requireMatchingAuthKind(command, read);
  if (computed.command !== command || computed.read !== read) {
    throw new AuthMutationRejectedError('Auth computed input identity differs');
  }
  if (command.capturedAtEpochMs < 0) {
    throw new AuthMutationRejectedError('Auth command timestamp is invalid');
  }
  const commandKind = command.kind;
  switch (commandKind) {
    case 'register-user':
      return validateAuthUserMutation({ kind: commandKind, command, read });
    case 'issue-session':
      validateAuthSessionMutation({ kind: commandKind, command, read, computed });
      return validateAuthUserMutation({ kind: commandKind, command, read });
    case 'logout-session':
      return validateAuthSessionMutation({ kind: commandKind, command, read, computed });
    case 'issue-ws-ticket':
    case 'consume-ws-ticket':
      return validateAuthTicketMutation({ kind: commandKind, command, read });
    case 'issue-agent-tickets':
    case 'consume-agent-ticket':
      return validateAuthAgentTicketMutation({ kind: commandKind, command, read, computed });
  }
}
