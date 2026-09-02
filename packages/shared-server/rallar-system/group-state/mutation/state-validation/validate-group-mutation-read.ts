import type { GroupRef } from '@shared/api/group-types.ts';
import {
    isGroupStateRecord,
    toGroupStateValidationIssue,
    type GroupStateValidationIssue
} from '../../group-state-validation-issues.ts';

import { validateExactKeys, validateJsonSafe, validateRequiredKeys } from '../../group-state-validation-issues.ts';
import { groupStateGroupStorageKey } from '../../persistence/aggregate/group-aggregate-storage-keys.ts';
import { groupStateIdempotencyStorageKey } from '../../persistence/idempotency/group-idempotency-storage-key.ts';
import {
    groupStatePresenceSessionStorageKey,
    groupStatePresenceSummaryStorageKey
} from '../../persistence/presence/group-presence-storage-keys.ts';
import { validateGroupStateRuntimeEntry } from '../../persistence/validate-group-state-runtime-entry.ts';
import {
    validatePresenceSession,
    validatePresenceSummaryValue
} from '../../persistence/validate-persisted-group-presence.ts';
import { validateStoredGroup } from '../../persistence/validate-persisted-group.ts';
import { validateGroupExpiredStateAuthority } from '../../presence/group-expired-state-authority.ts';
import type { GroupMutationCommand, GroupMutationRead } from '../group-mutation-contracts.ts';
import { groupMutationIdempotencyKey } from '../group-mutation-idempotency-key.ts';
import { resolveGroupMutationReadIdentities } from '../read/resolve-group-mutation-read-identities.ts';
import { validateGroupMutationIdempotencyRecord } from '../result-validation/validate-group-mutation-result.ts';
import {
    validateGroupMutationAuthorityPresenceReads,
    validateGroupMutationAuthorityReads
} from './validate-group-mutation-authority-reads.ts';
import { validateGroupMutationMemberReads } from './validate-group-mutation-member-reads.ts';
import { validateGroupMutationOperationReads } from './validate-group-mutation-operation-reads.ts';

const GROUP_MUTATION_READ_KEYS = [
    'idempotency',
    'group',
    'actorMember',
    'targetMember',
    'authorityMember',
    'expiredGroupEntry',
    'expiredTargetPresenceEntry',
    'directorMember',
    'actorMemberEntry',
    'targetMemberEntry',
    'authorityMemberEntry',
    'directorMemberEntry',
    'targetPresence',
    'targetAdmission',
    'authorityAdmission',
    'directorAdmission',
    'authorityPresenceSessions',
    'authorityPresenceSessionEntries',
    'presenceSummary',
    'lifecyclePolicy',
    'activeMemberPrincipalIds',
    'connectTriggerLatch',
    'plannedLayoutRow',
    'acceptedLayoutRow'
] as const;

export function validateGroupMutationRead(
    read: GroupMutationRead,
    command: GroupMutationCommand
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    const ref = command.aggregateRef;
    const shapeIssues = validateReadShape(read);
    issues.push(...shapeIssues);
    if (shapeIssues.length > 0) {
        return issues;
    }
    const groupIssues = validateStoredGroupRead(read, ref);
    issues.push(...groupIssues, ...validateGroupMutationAuthorityPresenceReads(read, ref));
    issues.push(...validateSummaryAndIdempotencyReads(read, command, ref));
    issues.push(...validateGroupMutationOperationReads(read, command));
    if (groupIssues.length > 0) {
        return issues;
    }
    const identities = resolveGroupMutationReadIdentities(read, command);
    issues.push(...validateGroupMutationMemberReads(read, ref, identities));
    issues.push(...validateTargetPresenceRead({
        read,
        ref,
        targetSessionId: identities.targetSessionId,
        targetPrincipalId: identities.targetPrincipalId
    }));
    issues.push(...validateGroupExpiredStateAuthority({
        ref,
        targetSessionId: identities.targetSessionId,
        group: read.group,
        expiredGroupEntry: read.expiredGroupEntry,
        targetPresence: read.targetPresence,
        expiredTargetPresenceEntry: read.expiredTargetPresenceEntry
    }));
    issues.push(...validateGroupMutationAuthorityReads({ read, command, ref, identities }));
    return issues;
}

function validateReadShape(read: GroupMutationRead): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (!isGroupStateRecord(read)) {
        return [toGroupStateValidationIssue('read', 'Group mutation read must be an object')];
    }
    issues.push(...validateJsonSafe(read, 'Group mutation read'));
    issues.push(...validateExactKeys(read, GROUP_MUTATION_READ_KEYS, 'Group mutation read'));
    issues.push(...validateRequiredKeys(read, GROUP_MUTATION_READ_KEYS, 'Group mutation read'));
    for (const key of GROUP_MUTATION_READ_KEYS) {
        if (
            key === 'authorityPresenceSessions' || key === 'authorityPresenceSessionEntries' ||
            key === 'activeMemberPrincipalIds'
        ) {
            continue;
        }
        if (read[key] !== null && !isGroupStateRecord(read[key])) {
            issues.push(
                toGroupStateValidationIssue(`read.${key}`, `Group mutation read ${key} must be an object or null`)
            );
        }
    }
    return issues;
}

function validateStoredGroupRead(read: GroupMutationRead, ref: GroupRef): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (!read.group) {
        return issues;
    }
    issues.push(...validateGroupStateRuntimeEntry(
        read.group,
        'Stored group',
        groupStateGroupStorageKey(ref)
    ));
    issues.push(...validateStoredGroup(read.group.value, ref));
    return issues;
}

interface ValidateTargetPresenceReadInput {
    readonly read: GroupMutationRead;
    readonly ref: GroupRef;
    readonly targetSessionId: string | null;
    readonly targetPrincipalId: string | null;
}

function validateTargetPresenceRead({
    read,
    ref,
    targetSessionId,
    targetPrincipalId
}: ValidateTargetPresenceReadInput): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (!read.targetPresence) {
        return issues;
    }
    if (
        targetSessionId === null || !isGroupStateRecord(read.targetPresence.value) ||
        read.targetPresence.value.sessionId !== targetSessionId
    ) {
        issues.push(
            toGroupStateValidationIssue(
                'read.targetPresence',
                'Stored target presence session differs from command slot identity'
            )
        );
    }
    if (
        targetPrincipalId === null || !isGroupStateRecord(read.targetPresence.value) ||
        read.targetPresence.value.principalId !== targetPrincipalId
    ) {
        issues.push(
            toGroupStateValidationIssue(
                'read.targetPresence',
                'Stored target presence principal differs from command slot identity'
            )
        );
    }
    issues.push(...validateGroupStateRuntimeEntry(
        read.targetPresence,
        'Stored target presence',
        targetSessionId === null
            ? undefined
            : groupStatePresenceSessionStorageKey({ ...ref, sessionId: targetSessionId })
    ));
    issues.push(...validatePresenceSession(read.targetPresence.value, ref, 'Stored target presence'));
    return issues;
}

function validateSummaryAndIdempotencyReads(
    read: GroupMutationRead,
    command: GroupMutationCommand,
    ref: GroupRef
): readonly GroupStateValidationIssue[] {
    const issues: GroupStateValidationIssue[] = [];
    if (read.presenceSummary) {
        issues.push(...validateGroupStateRuntimeEntry(
            read.presenceSummary,
            'Stored presence summary',
            groupStatePresenceSummaryStorageKey(ref)
        ));
        issues.push(...validatePresenceSummaryValue(read.presenceSummary.value, ref));
    }
    if (!read.idempotency) {
        return issues;
    }
    const idempotencyKey = groupMutationIdempotencyKey(command);
    if (
        idempotencyKey === null || !isGroupStateRecord(read.idempotency.value) ||
        read.idempotency.value.requestId !== idempotencyKey
    ) {
        issues.push(
            toGroupStateValidationIssue(
                'read.idempotency',
                'Stored group idempotency request differs from command identity'
            )
        );
    }
    issues.push(...validateGroupStateRuntimeEntry(
        read.idempotency,
        'Stored group idempotency',
        idempotencyKey === null ? undefined : groupStateIdempotencyStorageKey(ref, idempotencyKey)
    ));
    issues.push(...validateGroupMutationIdempotencyRecord(read.idempotency.value, ref));
    return issues;
}

