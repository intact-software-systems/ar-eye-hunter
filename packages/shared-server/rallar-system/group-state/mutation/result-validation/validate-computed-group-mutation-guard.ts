import {
    isGroupStateRecord,
    toGroupStateValidationIssue,
    validateExactKeys,
    validateNonNegativeSafeInteger,
    validateOneOf,
    validateRequiredKeys,
    type GroupStateValidationIssue
} from '../../group-state-validation-issues.ts';
import { validatePresenceSession } from '../../persistence/validate-persisted-group-presence.ts';
import { validateStoredGroup } from '../../persistence/validate-persisted-group.ts';
import {
    resolveGroupMutationTargetPrincipalId,
    resolveGroupMutationTargetSessionId
} from '../orchestration/resolve-group-mutation-target-identity.ts';
import type { ValidateComputedGroupMutationWriteInput } from './validate-computed-group-mutation-write.ts';

export function validateComputedGroupMutationGuard({
    command,
    read,
    facts,
    computed
}: ValidateComputedGroupMutationWriteInput): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const guard = computed.guard;
    if (!isGroupStateRecord(guard)) {
        return [toGroupStateValidationIssue('computed.guard', 'Group mutation computed guard must be an object')];
    }
    const expectedKeys = [
        'kind',
        'operation',
        'value',
        ...(guard.operation === 'insert' ? [] : ['expectedRevision'])
    ];
    issues.push(...validateExactKeys(guard, expectedKeys, 'Group mutation computed guard'));
    issues.push(...validateRequiredKeys(guard, expectedKeys, 'Group mutation computed guard'));
    issues.push(...validateOneOf(guard.kind, ['group', 'presence'], 'Group mutation computed guard kind'));
    issues.push(...validateOneOf(
        guard.operation,
        ['insert', 'update', 'delete'],
        'Group mutation computed guard operation'
    ));
    if (guard.operation !== 'insert') {
        issues.push(...validateNonNegativeSafeInteger(
            guard.expectedRevision,
            'Group mutation computed guard expectedRevision'
        ));
    }
    if (guard.kind === 'group') {
        issues.push(...validateComputedGroupGuard({ command, read, guard }));
        return issues;
    }
    if (guard.kind === 'presence') {
        issues.push(...validateComputedPresenceGuard({ command, read, facts, guard }));
    }
    return issues;
}

interface ValidateComputedGroupGuardInput {
    readonly command: ValidateComputedGroupMutationWriteInput['command'];
    readonly read: ValidateComputedGroupMutationWriteInput['read'];
    readonly guard: Extract<ValidateComputedGroupMutationWriteInput['computed']['guard'], { kind: 'group'; }>;
}

function validateComputedGroupGuard({
    command,
    read,
    guard
}: ValidateComputedGroupGuardInput): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (Object.is(guard.operation, 'delete')) {
        issues.push(
            toGroupStateValidationIssue('computed.guard', 'Group mutation cannot use a group delete guard')
        );
    }
    issues.push(...validateStoredGroup(guard.value, command.aggregateRef));
    const expectedRevision = read.group?.entry.revision ?? read.expiredGroupEntry?.revision;
    if (guard.operation === 'insert') {
        if (expectedRevision !== undefined) {
            issues.push(
                toGroupStateValidationIssue(
                    'computed.guard',
                    'Group insert guard has an existing predecessor'
                )
            );
        }
    }
    else if (guard.expectedRevision !== expectedRevision) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.guard',
                'Group update guard revision differs from predecessor'
            )
        );
    }
    return issues;
}

interface ValidateComputedPresenceGuardInput {
    readonly command: ValidateComputedGroupMutationWriteInput['command'];
    readonly read: ValidateComputedGroupMutationWriteInput['read'];
    readonly facts: ValidateComputedGroupMutationWriteInput['facts'];
    readonly guard: Extract<ValidateComputedGroupMutationWriteInput['computed']['guard'], { kind: 'presence'; }>;
}

function validateComputedPresenceGuard({
    command,
    read,
    facts,
    guard
}: ValidateComputedPresenceGuardInput): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    issues.push(...validatePresenceSession(
        guard.value,
        command.aggregateRef,
        'Group mutation computed presence guard'
    ));
    if (!isGroupStateRecord(guard.value)) {
        return issues;
    }
    const expectedSessionId = resolveGroupMutationTargetSessionId(command);
    const expectedPrincipalId = resolveGroupMutationTargetPrincipalId(command);
    if (
        expectedSessionId === null ||
        expectedPrincipalId === null ||
        guard.value.sessionId !== expectedSessionId ||
        guard.value.principalId !== expectedPrincipalId
    ) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.guard',
                'Group mutation presence guard differs from command target identity'
            )
        );
    }
    const expectedRevision = read.targetPresence?.entry.revision ??
        read.expiredTargetPresenceEntry?.revision;
    if (guard.operation === 'insert') {
        if (expectedRevision !== undefined) {
            issues.push(
                toGroupStateValidationIssue(
                    'computed.guard',
                    'Presence insert guard has an existing predecessor'
                )
            );
        }
    }
    else if (guard.expectedRevision !== expectedRevision) {
        issues.push(
            toGroupStateValidationIssue(
                'computed.guard',
                'Presence write guard revision differs from predecessor'
            )
        );
    }
    issues.push(...validatePresenceDeleteAuthority({ command, facts, guard }));
    return issues;
}

function validatePresenceDeleteAuthority(
    { command, facts, guard }: Pick<ValidateComputedPresenceGuardInput, 'command' | 'facts' | 'guard'>
): readonly GroupStateValidationIssue[] {
    return guard.operation === 'delete' &&
            (command.operation !== 'disconnectPresence' ||
                facts.internalAuthority !== 'expiry' ||
                command.input.reason !== 'expired')
        ? [
            toGroupStateValidationIssue(
                'computed.guard',
                'Presence delete guard requires expiry authority'
            )
        ]
        : [];
}

