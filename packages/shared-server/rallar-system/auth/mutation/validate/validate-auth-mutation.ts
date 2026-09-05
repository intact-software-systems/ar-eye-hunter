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
    assertAuthRuntimeStateAuthority,
    assertMatchingAuthKind,
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
    const issues: AuthMutationValidationIssue[] = [];
    if (command.capturedAtEpochMs < 0) {
        issues.push(
            toAuthMutationValidationIssue(
                'command.capturedAtEpochMs',
                'Auth command timestamp is invalid'
            )
        );
    }
    if (command.kind !== read.kind || command.kind !== facts.kind) {
        return issues;
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
    return issues;
}

export function assertAuthMutationComputed(input: ValidateAuthMutationInput): void {
    const dataIssues = validateComputedData(input.computed, 'computed');
    if (dataIssues[0] !== undefined) {
        throw dataIssues[0].cause;
    }
    assertMatchingAuthKind(input.command, input.read);
    assertMatchingAuthFacts(input.command, input.facts);
    if (input.computed.command !== input.command || input.computed.read !== input.read) {
        throw new TypeError('Auth computed input identity differs');
    }
    assertAuthRuntimeStateAuthority(input.command, input.read);
    const expected = computeAuthMutation({
        command: input.command,
        read: input.read,
        facts: input.facts
    });
    const projectionIssues = validateComputedProjection(expected, input.computed, 'computed');
    if (projectionIssues[0] !== undefined) {
        throw new TypeError('Auth computed value differs', { cause: projectionIssues[0].cause });
    }
}

function assertMatchingAuthFacts(command: AuthMutationCommand, facts: AuthMutationFacts): void {
    if (facts.kind !== command.kind) {
        throw new TypeError('Auth command/facts operation differs');
    }
}
