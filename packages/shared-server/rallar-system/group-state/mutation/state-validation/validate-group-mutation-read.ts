import type { GroupRef } from '@shared/api/group-types.ts';

import { assertExactKeys, assertRequiredKeys, requireJsonSafe } from '../../group-state-validation-primitives.ts';
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
import { validateGroupMutationAuthorityReads } from './validate-group-mutation-authority-reads.ts';
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
    'plannedLayoutRow',
    'acceptedLayoutRow'
] as const;

export function validateGroupMutationRead(
    read: GroupMutationRead,
    command: GroupMutationCommand
): void {
    const ref = command.aggregateRef;
    validateReadShape(read);
    validateStoredGroupRead(read, ref);
    const identities = resolveGroupMutationReadIdentities(read, command);
    validateGroupMutationMemberReads(read, ref, identities);
    validateTargetPresenceRead({
        read,
        ref,
        targetSessionId: identities.targetSessionId,
        targetPrincipalId: identities.targetPrincipalId
    });
    validateGroupExpiredStateAuthority({
        ref,
        targetSessionId: identities.targetSessionId,
        group: read.group,
        expiredGroupEntry: read.expiredGroupEntry,
        targetPresence: read.targetPresence,
        expiredTargetPresenceEntry: read.expiredTargetPresenceEntry
    });
    validateGroupMutationAuthorityReads({ read, command, ref, identities });
    validateSummaryAndIdempotencyReads(read, command, ref);
    validateGroupMutationOperationReads(read, command);
}

function validateReadShape(read: GroupMutationRead): void {
    requireJsonSafe(read, 'Group mutation read');
    assertExactKeys(read, GROUP_MUTATION_READ_KEYS, 'Group mutation read');
    assertRequiredKeys(read, GROUP_MUTATION_READ_KEYS, 'Group mutation read');
}

function validateStoredGroupRead(read: GroupMutationRead, ref: GroupRef): void {
    if (!read.group) {
        return;
    }
    validateGroupStateRuntimeEntry(
        read.group,
        'Stored group',
        groupStateGroupStorageKey(ref)
    );
    validateStoredGroup(read.group.value, ref);
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
}: ValidateTargetPresenceReadInput): void {
    if (!read.targetPresence) {
        return;
    }
    if (targetSessionId === null || read.targetPresence.value.sessionId !== targetSessionId) {
        throw new TypeError('Stored target presence session differs from command slot identity');
    }
    if (targetPrincipalId === null || read.targetPresence.value.principalId !== targetPrincipalId) {
        throw new TypeError('Stored target presence principal differs from command slot identity');
    }
    validateGroupStateRuntimeEntry(
        read.targetPresence,
        'Stored target presence',
        groupStatePresenceSessionStorageKey({ ...ref, sessionId: targetSessionId })
    );
    validatePresenceSession(read.targetPresence.value, ref, 'Stored target presence');
}

function validateSummaryAndIdempotencyReads(
    read: GroupMutationRead,
    command: GroupMutationCommand,
    ref: GroupRef
): void {
    if (read.presenceSummary) {
        validateGroupStateRuntimeEntry(
            read.presenceSummary,
            'Stored presence summary',
            groupStatePresenceSummaryStorageKey(ref)
        );
        validatePresenceSummaryValue(read.presenceSummary.value, ref);
    }
    if (!read.idempotency) {
        return;
    }
    const idempotencyKey = groupMutationIdempotencyKey(command);
    if (idempotencyKey === null || read.idempotency.value.requestId !== idempotencyKey) {
        throw new TypeError('Stored group idempotency request differs from command identity');
    }
    validateGroupStateRuntimeEntry(
        read.idempotency,
        'Stored group idempotency',
        groupStateIdempotencyStorageKey(ref, idempotencyKey)
    );
    validateGroupMutationIdempotencyRecord(read.idempotency.value, ref);
}
