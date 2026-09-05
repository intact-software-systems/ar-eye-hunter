import {
    validateComputedData,
    validateComputedProjection
} from '../../../computed-data-validation.ts';
import type {
    AuthMutationCommand,
    AuthMutationComputed,
    AuthMutationFacts,
    AuthMutationRead
} from '../auth-mutation-contracts.ts';
import { computeAuthMutation } from '../compute/compute-auth-mutation.ts';
import {
    toAuthMutationTypeValidationIssue,
    toAuthMutationValidationIssue,
    type AuthMutationValidationIssue
} from './auth-mutation-validation.ts';
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

export function validateAuthMutation(
    input: ValidateAuthMutationInput
): readonly AuthMutationValidationIssue[] {
    const { command, read, facts, computed } = input;
    const issues: AuthMutationValidationIssue[] = [
        ...validateComputedData(computed, 'computed')
    ];
    if (issues.length > 0) {
        return issues;
    }
    if (command.capturedAtEpochMs < 0) {
        issues.push(
            toAuthMutationValidationIssue(
                'command.capturedAtEpochMs',
                'Auth command timestamp is invalid'
            )
        );
    }
    if (command.kind !== read.kind) {
        issues.push(toAuthMutationTypeValidationIssue('read.kind', 'Auth command/read operation differs'));
    }
    if (command.kind !== facts.kind) {
        issues.push(toAuthMutationTypeValidationIssue('facts.kind', 'Auth command/facts operation differs'));
    }
    if (command.kind !== read.kind || command.kind !== facts.kind) {
        return issues;
    }
    if (computed.command !== command || computed.read !== read) {
        issues.push(toAuthMutationTypeValidationIssue('computed', 'Auth computed input identity differs'));
    }
    const commandKind = command.kind;
    switch (commandKind) {
        case 'register-user':
            issues.push(...validateAuthUserMutation({ kind: commandKind, command, read }));
            break;
        case 'issue-session':
            issues.push(...validateAuthSessionMutation({ kind: commandKind, command, read, computed }));
            issues.push(...validateAuthUserMutation({ kind: commandKind, command, read }));
            break;
        case 'logout-session':
            issues.push(...validateAuthSessionMutation({ kind: commandKind, command, read, computed }));
            break;
        case 'issue-ws-ticket':
        case 'consume-ws-ticket':
            issues.push(...validateAuthTicketMutation({ kind: commandKind, command, read }));
            break;
        case 'issue-agent-tickets':
        case 'consume-agent-ticket':
            issues.push(...validateAuthAgentTicketMutation({ kind: commandKind, command, read, computed }));
            break;
    }
    if (issues.length === 0) {
        const expected = computeAuthMutation({ command, read, facts });
        issues.push(...validateComputedProjection(expected, computed, 'computed'));
    }
    return issues;
}
