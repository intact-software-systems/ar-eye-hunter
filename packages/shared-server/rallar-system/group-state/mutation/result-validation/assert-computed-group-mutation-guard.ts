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
import type { AssertComputedGroupMutationWriteInput } from './assert-computed-group-mutation-write.ts';

export function assertComputedGroupMutationGuard({
    command,
    read,
    facts,
    computed
}: AssertComputedGroupMutationWriteInput): void {
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
        assertComputedGroupGuard({ command, read, guard });
        return;
    }
    assertComputedPresenceGuard({ command, read, facts, guard });
}

interface AssertComputedGroupGuardInput {
    readonly command: AssertComputedGroupMutationWriteInput['command'];
    readonly read: AssertComputedGroupMutationWriteInput['read'];
    readonly guard: Extract<AssertComputedGroupMutationWriteInput['computed']['guard'], { kind: 'group'; }>;
}

function assertComputedGroupGuard({
    command,
    read,
    guard
}: AssertComputedGroupGuardInput): void {
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

interface AssertComputedPresenceGuardInput {
    readonly command: AssertComputedGroupMutationWriteInput['command'];
    readonly read: AssertComputedGroupMutationWriteInput['read'];
    readonly facts: AssertComputedGroupMutationWriteInput['facts'];
    readonly guard: Extract<AssertComputedGroupMutationWriteInput['computed']['guard'], { kind: 'presence'; }>;
}

function assertComputedPresenceGuard({
    command,
    read,
    facts,
    guard
}: AssertComputedPresenceGuardInput): void {
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
