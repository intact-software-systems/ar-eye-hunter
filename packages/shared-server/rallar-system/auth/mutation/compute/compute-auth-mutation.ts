import { requireMatchingAuthKind } from '../../../services/auth-state-validation-shared.ts';
import type {
  AuthMutationCommand,
  AuthMutationComputed,
  AuthMutationFacts,
  AuthMutationRead,
} from '../auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '../auth-mutation-rejected-error.ts';
import { computeAuthAgentTicketMutation } from './compute-auth-agent-ticket-mutation.ts';
import { computeAuthSessionMutation } from './compute-auth-session-mutation.ts';
import { computeAuthTicketMutation } from './compute-auth-ticket-mutation.ts';
import { computeAuthUserRegistration } from './compute-auth-user-registration.ts';

export interface ComputeAuthMutationInput {
  readonly command: AuthMutationCommand;
  readonly read: AuthMutationRead;
  readonly facts: AuthMutationFacts;
  readonly serviceId: string;
}

export function computeAuthMutation(input: ComputeAuthMutationInput): AuthMutationComputed {
  requireMatchingAuthKind(input.command, input.read);
  requireMatchingFacts(input.command, input.facts);
  const commandKind = input.command.kind;
  switch (commandKind) {
    case 'register-user':
      return computeAuthUserRegistration(
        input.command as Extract<AuthMutationCommand, { kind: 'register-user' }>,
        input.read as Extract<AuthMutationRead, { kind: 'register-user' }>,
      );
    case 'issue-session':
    case 'logout-session':
      return computeAuthSessionMutation({
        kind: commandKind,
        command: input.command,
        read: input.read,
        serviceId: input.serviceId,
      });
    case 'issue-ws-ticket':
    case 'consume-ws-ticket':
      return computeAuthTicketMutation({
        kind: commandKind,
        command: input.command,
        read: input.read,
      });
    case 'issue-agent-tickets':
    case 'consume-agent-ticket':
      return computeAuthAgentTicketMutation({
        kind: commandKind,
        command: input.command,
        read: input.read,
      });
  }
}

function requireMatchingFacts(command: AuthMutationCommand, facts: AuthMutationFacts): void {
  if (facts.kind !== command.kind) {
    throw new AuthMutationRejectedError('Auth command/facts operation differs');
  }
}
