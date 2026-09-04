import type {
    AuthMutationCommand,
    AuthMutationComputed,
    AuthMutationFacts,
    AuthMutationRead
} from '../auth-mutation-contracts.ts';
import { AuthMutationRejectedError } from '../auth-mutation-rejected-error.ts';
import { computeAuthMutation } from '../compute/compute-auth-mutation.ts';
import { equalAuthJson, requireMatchingAuthKind } from './auth-mutation-validation.ts';
import { validateAuthAgentTicketMutation } from './validate-auth-agent-ticket-mutation.ts';
import { validateAuthSessionMutation } from './validate-auth-session-mutation.ts';
import { validateAuthTicketMutation } from './validate-auth-ticket-mutation.ts';
import { validateAuthUserMutation } from './validate-auth-user-mutation.ts';

export interface ValidateAuthMutationInput {
    readonly command: AuthMutationCommand;
    readonly read: AuthMutationRead;
    readonly facts: AuthMutationFacts;
    readonly computed: AuthMutationComputed;
}

export function validateAuthMutation(input: ValidateAuthMutationInput): void {
    const { command, read, facts, computed } = input;
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
            validateAuthUserMutation({ kind: commandKind, command, read });
            break;
        case 'issue-session':
            validateAuthSessionMutation({ kind: commandKind, command, read, computed });
            validateAuthUserMutation({ kind: commandKind, command, read });
            break;
        case 'logout-session':
            validateAuthSessionMutation({ kind: commandKind, command, read, computed });
            break;
        case 'issue-ws-ticket':
        case 'consume-ws-ticket':
            validateAuthTicketMutation({ kind: commandKind, command, read });
            break;
        case 'issue-agent-tickets':
        case 'consume-agent-ticket':
            validateAuthAgentTicketMutation({ kind: commandKind, command, read, computed });
            break;
    }
    const expected = computeAuthMutation({ command, read, facts });
    if (!isExactAuthComputed(expected, computed)) {
        throw new AuthMutationRejectedError('Auth computed value differs');
    }
}

function isExactAuthComputed(
    expected: AuthMutationComputed,
    computed: AuthMutationComputed
): boolean {
    return equalAuthJson(expected, computed);
}
