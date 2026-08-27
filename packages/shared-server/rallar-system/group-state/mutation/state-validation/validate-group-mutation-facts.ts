import {
    assertExactKeys,
    requireJsonSafe,
    requireNonEmptyString,
    requirePositiveSafeInteger,
    requireRecord
} from '../../group-state-validation-primitives.ts';
import { GROUP_MUTATION_INTERNAL_AUTHORITY_MODES, type GroupMutationFacts } from '../group-mutation-contracts.ts';

export function validateGroupMutationFacts(facts: GroupMutationFacts): void {
    requireJsonSafe(facts, 'Group mutation facts');
    assertExactKeys(
        facts,
        [
            'nowEpochMs',
            'expireAtEpochMs',
            'serviceId',
            'eventId',
            'commandHash',
            'resolvedJoinCode',
            'joinCodeVerifier',
            'internalAuthority',
            'capacity',
            'authenticatedAuthority',
            'attemptCount'
        ],
        'Group mutation facts'
    );
    if (!Number.isSafeInteger(facts.nowEpochMs) || facts.nowEpochMs < 0) {
        throw new TypeError('Group mutation timestamp is invalid');
    }
    if (!Number.isSafeInteger(facts.expireAtEpochMs) || facts.expireAtEpochMs <= facts.nowEpochMs) {
        throw new TypeError('Group mutation expiry timestamp is invalid');
    }
    requirePositiveSafeInteger(facts.attemptCount, 'Group mutation attemptCount');
    requireNonEmptyString(facts.serviceId, 'Group mutation serviceId');
    requireNonEmptyString(facts.eventId, 'Group mutation eventId');
    if (!/^sha256:[0-9a-f]{64}$/.test(facts.commandHash)) {
        throw new TypeError('Group mutation commandHash is invalid');
    }
    if (!(GROUP_MUTATION_INTERNAL_AUTHORITY_MODES as readonly string[]).includes(facts.internalAuthority)) {
        throw new TypeError('Group mutation internal authority is invalid');
    }
    validateCapacityFacts(facts.capacity);
    validateAuthenticatedAuthorityFacts(facts.authenticatedAuthority);
    validateResolvedJoinCodePair(facts);
    if (facts.internalAuthority !== 'none' && facts.authenticatedAuthority !== null) {
        throw new TypeError('Internal group authority cannot also be authenticated authority');
    }
}

function validateCapacityFacts(capacity: GroupMutationFacts['capacity']): void {
    if (capacity === undefined) {
        return;
    }
    const record = requireRecord(capacity, 'Group mutation capacity facts');
    assertExactKeys(record, ['defaultMaxMembers'], 'Group mutation capacity facts');
    if (record.defaultMaxMembers === null) {
        return;
    }
    requirePositiveSafeInteger(record.defaultMaxMembers, 'Group mutation capacity defaultMaxMembers');
}

function validateAuthenticatedAuthorityFacts(
    authenticatedAuthority: GroupMutationFacts['authenticatedAuthority']
): void {
    if (authenticatedAuthority === null) {
        return;
    }
    const authority = requireRecord(
        authenticatedAuthority,
        'Group mutation authenticated authority'
    );
    assertExactKeys(
        authority,
        ['principalId', 'sessionId'],
        'Group mutation authenticated authority'
    );
    requireNonEmptyString(
        authority.principalId,
        'Group mutation authenticated authority principalId'
    );
    requireNonEmptyString(authority.sessionId, 'Group mutation authenticated authority sessionId');
}

function validateResolvedJoinCodePair(facts: GroupMutationFacts): void {
    if (facts.joinCodeVerifier !== null) {
        requireNonEmptyString(facts.joinCodeVerifier, 'Group mutation joinCodeVerifier');
    }
    if (facts.resolvedJoinCode !== null) {
        requireNonEmptyString(facts.resolvedJoinCode, 'Group mutation resolvedJoinCode');
    }
    if ((facts.resolvedJoinCode === null) !== (facts.joinCodeVerifier === null)) {
        throw new TypeError('Group mutation resolved join code and verifier differ');
    }
}
