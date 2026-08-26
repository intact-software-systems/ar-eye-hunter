import {
    assertExactKeys,
    assertRequiredKeys,
    requireNonNegativeSafeInteger,
    requireOneOf
} from '../../group-state-validation-primitives.ts';
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
}: ValidateComputedGroupMutationWriteInput): void {
    const guard = computed.guard;
    const expectedKeys = [
        'kind',
        'operation',
        'value',
        ...(guard.operation === 'insert' ? [] : ['expectedRevision'])
    ];
    assertExactKeys(guard, expectedKeys, 'Group mutation computed guard');
    assertRequiredKeys(guard, expectedKeys, 'Group mutation computed guard');
    requireOneOf(guard.kind, ['group', 'presence'], 'Group mutation computed guard kind');
    requireOneOf(
        guard.operation,
        ['insert', 'update', 'delete'],
        'Group mutation computed guard operation'
    );
    if (guard.operation !== 'insert') {
        requireNonNegativeSafeInteger(
            guard.expectedRevision,
            'Group mutation computed guard expectedRevision'
        );
    }
    if (guard.kind === 'group') {
        validateComputedGroupGuard({ command, read, guard });
        return;
    }
    validateComputedPresenceGuard({ command, read, facts, guard });
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
}: ValidateComputedGroupGuardInput): void {
    if (Object.is(guard.operation, 'delete')) {
        throw new TypeError('Group mutation cannot use a group delete guard');
    }
    validateStoredGroup(guard.value, command.aggregateRef);
    const expectedRevision = read.group?.entry.revision ?? read.expiredGroupEntry?.revision;
    if (guard.operation === 'insert') {
        if (expectedRevision !== undefined) {
            throw new TypeError('Group insert guard has an existing predecessor');
        }
    }
    else if (guard.expectedRevision !== expectedRevision) {
        throw new TypeError('Group update guard revision differs from predecessor');
    }
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
}: ValidateComputedPresenceGuardInput): void {
    validatePresenceSession(
        guard.value,
        command.aggregateRef,
        'Group mutation computed presence guard'
    );
    const expectedSessionId = resolveGroupMutationTargetSessionId(command);
    const expectedPrincipalId = resolveGroupMutationTargetPrincipalId(command);
    if (
        expectedSessionId === null ||
        expectedPrincipalId === null ||
        guard.value.sessionId !== expectedSessionId ||
        guard.value.principalId !== expectedPrincipalId
    ) {
        throw new TypeError('Group mutation presence guard differs from command target identity');
    }
    const expectedRevision = read.targetPresence?.entry.revision ??
        read.expiredTargetPresenceEntry?.revision;
    if (guard.operation === 'insert') {
        if (expectedRevision !== undefined) {
            throw new TypeError('Presence insert guard has an existing predecessor');
        }
    }
    else if (guard.expectedRevision !== expectedRevision) {
        throw new TypeError('Presence write guard revision differs from predecessor');
    }
    if (
        guard.operation === 'delete' &&
        (command.operation !== 'disconnectPresence' ||
            facts.internalAuthority !== 'expiry' ||
            command.input.reason !== 'expired')
    ) {
        throw new TypeError('Presence delete guard requires expiry authority');
    }
}
