import {
    requireOptionalPersistedALSafeInteger,
    requireOptionalPersistedALStringArray,
    requireOptionalPersistedALUniqueStringArray,
    requirePersistedALFields,
    requirePersistedALNonEmptyString,
    requirePersistedALRecord,
    type PersistedALValue
} from './persisted-al-value-validation.ts';

export function assertPersistedALTargets(value: PersistedALValue): void {
    const targets = requirePersistedALRecord(value, 'targets');
    if (targets.mode === 'unicast') {
        requirePersistedALFields(targets, ['mode', 'toPeerId'], ['mode', 'toPeerId']);
        requirePersistedALNonEmptyString(targets.toPeerId, 'unicast peer');
        return;
    }
    if (targets.mode === 'multicast') {
        requirePersistedALFields(
            targets,
            ['mode', 'groupRef', 'membershipEpoch', 'minSnapshotVersion'],
            ['mode', 'groupRef']
        );
        assertCanonicalGroupRef(targets.groupRef);
        requireOptionalPersistedALSafeInteger(targets.membershipEpoch, 0, 'membership epoch');
        requireOptionalPersistedALSafeInteger(targets.minSnapshotVersion, 1, 'minimum snapshot version');
        return;
    }
    if (targets.mode !== 'broadcast') {
        throw new TypeError('Persisted AL target mode is invalid');
    }
    requirePersistedALFields(
        targets,
        [
            'mode',
            'scope',
            'groupRef',
            'principalRef',
            'exceptPeerIds',
            'minSnapshotVersion',
            'recipientPeerIds'
        ],
        ['mode', 'scope']
    );
    if (
        typeof targets.scope !== 'string' ||
        !['room', 'world', 'all', 'principal'].includes(targets.scope)
    ) {
        throw new TypeError('Persisted AL broadcast scope is invalid');
    }
    if (targets.scope === 'room' && targets.groupRef === undefined) {
        throw new TypeError('Persisted AL room broadcast group ref is missing');
    }
    if (targets.recipientPeerIds !== undefined && targets.scope !== 'room') {
        throw new TypeError('Persisted AL fixed recipient audience requires room scope');
    }
    if (targets.scope === 'principal' && targets.principalRef === undefined) {
        throw new TypeError('Persisted AL principal broadcast principal ref is missing');
    }
    if (targets.scope !== 'principal' && targets.principalRef !== undefined) {
        throw new TypeError('Persisted AL principal ref requires principal scope');
    }
    if (targets.groupRef !== undefined) {
        assertCanonicalGroupRef(targets.groupRef);
    }
    if (targets.principalRef !== undefined) {
        assertCanonicalPrincipalRef(targets.principalRef);
    }
    requireOptionalPersistedALStringArray(targets.exceptPeerIds, 'broadcast exclusions');
    requireOptionalPersistedALUniqueStringArray(targets.recipientPeerIds, 'broadcast fixed recipients');
    requireOptionalPersistedALSafeInteger(targets.minSnapshotVersion, 1, 'minimum snapshot version');
}

function assertCanonicalGroupRef(value: PersistedALValue | undefined): void {
    if (value === undefined) {
        throw new TypeError('Persisted AL group ref is missing');
    }
    const ref = requirePersistedALRecord(value, 'group ref');
    if (!Object.hasOwn(ref, 'workspaceId')) {
        throw new TypeError('Persisted AL group workspace id is missing');
    }
    requirePersistedALFields(
        ref,
        ['applicationId', 'workspaceId', 'groupId'],
        ['applicationId', 'workspaceId', 'groupId']
    );
    requirePersistedALNonEmptyString(ref.applicationId, 'group application id');
    requirePersistedALNonEmptyString(ref.workspaceId, 'group workspace id');
    requirePersistedALNonEmptyString(ref.groupId, 'group id');
}

function assertCanonicalPrincipalRef(value: PersistedALValue): void {
    const ref = requirePersistedALRecord(value, 'principal ref');
    requirePersistedALFields(
        ref,
        ['applicationId', 'workspaceId', 'principalId'],
        ['applicationId', 'workspaceId', 'principalId']
    );
    requirePersistedALNonEmptyString(ref.applicationId, 'principal application id');
    requirePersistedALNonEmptyString(ref.workspaceId, 'principal workspace id');
    requirePersistedALNonEmptyString(ref.principalId, 'principal id');
}
