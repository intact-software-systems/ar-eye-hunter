import { decodeALTraceId } from '@shared/al-contracts/trace/al-trace-id.ts';

import {
    assertExactKeys,
    requireJsonSafe,
    requireNonEmptyString,
    requirePositiveSafeInteger,
    requireRecord
} from '../../group-state-validation-primitives.ts';
import {
    GROUP_MUTATION_INTERNAL_AUTHORITY_MODES,
    type GroupMutationFacts,
    type GroupMutationIngressFacts
} from '../group-mutation-contracts.ts';

export function assertGroupMutationFacts(facts: GroupMutationFacts): void {
    requireRecord(facts, 'Group mutation facts');
    const { attemptCount, attemptAtEpochMs, traceId, ...ingressFacts } = facts;
    assertGroupMutationIngressFacts(ingressFacts);
    requirePositiveSafeInteger(attemptCount, 'Group mutation attemptCount');
    if (decodeALTraceId(traceId).left !== undefined) {
        throw new TypeError('Group mutation trace is invalid');
    }
    if (!Number.isSafeInteger(attemptAtEpochMs) || attemptAtEpochMs < facts.nowEpochMs) {
        throw new TypeError('Group mutation attempt timestamp is invalid');
    }
}

export function assertGroupMutationIngressFacts(facts: GroupMutationIngressFacts): void {
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
            'authenticatedAuthority'
        ],
        'Group mutation facts'
    );
    if (!Number.isSafeInteger(facts.nowEpochMs) || facts.nowEpochMs < 0) {
        throw new TypeError('Group mutation timestamp is invalid');
    }
    if (!Number.isSafeInteger(facts.expireAtEpochMs) || facts.expireAtEpochMs <= facts.nowEpochMs) {
        throw new TypeError('Group mutation expiry timestamp is invalid');
    }
    requireNonEmptyString(facts.serviceId, 'Group mutation serviceId');
    requireNonEmptyString(facts.eventId, 'Group mutation eventId');
    if (!/^sha256:[0-9a-f]{64}$/.test(facts.commandHash)) {
        throw new TypeError('Group mutation commandHash is invalid');
    }
    if (!(GROUP_MUTATION_INTERNAL_AUTHORITY_MODES as readonly string[]).includes(facts.internalAuthority)) {
        throw new TypeError('Group mutation internal authority is invalid');
    }
    assertCapacityFacts(facts.capacity);
    assertAuthenticatedAuthorityFacts(facts.authenticatedAuthority);
    assertResolvedJoinCodePair(facts);
    if (facts.internalAuthority !== 'none' && facts.authenticatedAuthority !== null) {
        throw new TypeError('Internal group authority cannot also be authenticated authority');
    }
}

function assertCapacityFacts(capacity: GroupMutationIngressFacts['capacity']): void {
    const record = requireRecord(capacity, 'Group mutation capacity facts');
    assertExactKeys(record, ['defaultMaxMembers'], 'Group mutation capacity facts');
    if (record.defaultMaxMembers === null) {
        return;
    }
    requirePositiveSafeInteger(record.defaultMaxMembers, 'Group mutation capacity defaultMaxMembers');
}

function assertAuthenticatedAuthorityFacts(
    authenticatedAuthority: GroupMutationIngressFacts['authenticatedAuthority']
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

function assertResolvedJoinCodePair(facts: GroupMutationIngressFacts): void {
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
