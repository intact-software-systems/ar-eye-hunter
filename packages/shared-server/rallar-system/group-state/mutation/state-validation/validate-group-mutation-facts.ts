import {
    isGroupStateRecord,
    toGroupStateValidationIssue,
    validateExactKeys,
    validateJsonSafe,
    validateNonEmptyString,
    validatePositiveSafeInteger,
    type GroupStateValidationIssue
} from '../../group-state-validation-issues.ts';
import { GROUP_MUTATION_INTERNAL_AUTHORITY_MODES, type GroupMutationFacts } from '../group-mutation-contracts.ts';

const GROUP_MUTATION_FACT_KEYS = [
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
];

export function validateGroupMutationFacts(facts: GroupMutationFacts): readonly GroupStateValidationIssue[] {
    const issues = [...validateJsonSafe(facts, 'Group mutation facts')];
    if (!isGroupStateRecord(facts)) {
        return [...issues, toGroupStateValidationIssue('facts', 'Group mutation facts must be an object')];
    }
    issues.push(...validateExactKeys(facts, GROUP_MUTATION_FACT_KEYS, 'Group mutation facts'));
    if (!Number.isSafeInteger(facts.nowEpochMs) || facts.nowEpochMs < 0) {
        issues.push(toGroupStateValidationIssue('facts.nowEpochMs', 'Group mutation timestamp is invalid'));
    }
    if (
        !Number.isSafeInteger(facts.expireAtEpochMs) ||
        (typeof facts.nowEpochMs === 'number' && facts.expireAtEpochMs <= facts.nowEpochMs)
    ) {
        issues.push(toGroupStateValidationIssue('facts.expireAtEpochMs', 'Group mutation expiry timestamp is invalid'));
    }
    issues.push(
        ...validatePositiveSafeInteger(facts.attemptCount, 'Group mutation attemptCount'),
        ...validateNonEmptyString(facts.serviceId, 'Group mutation serviceId'),
        ...validateNonEmptyString(facts.eventId, 'Group mutation eventId')
    );
    if (typeof facts.commandHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(facts.commandHash)) {
        issues.push(toGroupStateValidationIssue('facts.commandHash', 'Group mutation commandHash is invalid'));
    }
    if (!(GROUP_MUTATION_INTERNAL_AUTHORITY_MODES as readonly string[]).includes(facts.internalAuthority)) {
        issues.push(
            toGroupStateValidationIssue('facts.internalAuthority', 'Group mutation internal authority is invalid')
        );
    }
    issues.push(...validateCapacityFacts(facts.capacity));
    issues.push(...validateAuthenticatedAuthorityFacts(facts.authenticatedAuthority));
    issues.push(...validateResolvedJoinCodePair(facts));
    if (facts.internalAuthority !== 'none' && facts.authenticatedAuthority !== null) {
        issues.push(
            toGroupStateValidationIssue(
                'facts.authenticatedAuthority',
                'Internal group authority cannot also be authenticated authority'
            )
        );
    }
    return issues;
}

function validateCapacityFacts(capacity: GroupMutationFacts['capacity']): readonly GroupStateValidationIssue[] {
    if (capacity === undefined) {
        return [];
    }
    if (!isGroupStateRecord(capacity)) {
        return [toGroupStateValidationIssue('facts.capacity', 'Group mutation capacity facts must be an object')];
    }
    return [
        ...validateExactKeys(capacity, ['defaultMaxMembers'], 'Group mutation capacity facts'),
        ...(capacity.defaultMaxMembers === null
            ? []
            : validatePositiveSafeInteger(capacity.defaultMaxMembers, 'Group mutation capacity defaultMaxMembers'))
    ];
}

function validateAuthenticatedAuthorityFacts(
    authenticatedAuthority: GroupMutationFacts['authenticatedAuthority']
): readonly GroupStateValidationIssue[] {
    if (authenticatedAuthority === null) {
        return [];
    }
    if (!isGroupStateRecord(authenticatedAuthority)) {
        return [
            toGroupStateValidationIssue(
                'facts.authenticatedAuthority',
                'Group mutation authenticated authority must be an object'
            )
        ];
    }
    return [
        ...validateExactKeys(
            authenticatedAuthority,
            ['principalId', 'sessionId'],
            'Group mutation authenticated authority'
        ),
        ...validateNonEmptyString(
            authenticatedAuthority.principalId,
            'Group mutation authenticated authority principalId'
        ),
        ...validateNonEmptyString(authenticatedAuthority.sessionId, 'Group mutation authenticated authority sessionId')
    ];
}

function validateResolvedJoinCodePair(facts: GroupMutationFacts): readonly GroupStateValidationIssue[] {
    const issues = [
        ...(facts.joinCodeVerifier === null
            ? []
            : validateNonEmptyString(facts.joinCodeVerifier, 'Group mutation joinCodeVerifier')),
        ...(facts.resolvedJoinCode === null
            ? []
            : validateNonEmptyString(facts.resolvedJoinCode, 'Group mutation resolvedJoinCode'))
    ];
    if ((facts.resolvedJoinCode === null) !== (facts.joinCodeVerifier === null)) {
        issues.push(
            toGroupStateValidationIssue(
                'facts.resolvedJoinCode',
                'Group mutation resolved join code and verifier differ'
            )
        );
    }
    return issues;
}

