import type { GroupRef } from '@shared/api/group-types.ts';
import { type GroupMoveClaim } from '@shared/api/mutation/decode-group-move.ts';
import type { GroupMove } from '@shared/api/mutation/group-move.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import {
    groupStateGroupStorageKey,
    groupStateScopeStorageKey
} from '../persistence/aggregate/group-aggregate-storage-keys.ts';
import type { GroupMoveRejection } from './compute-group-move.ts';
import type { GroupMoveRepository } from './group-move-repository.ts';

const SOURCE_CLAIMS_NAMESPACE = 'group_move_source_claims';
const PARTICIPANT_CLAIMS_NAMESPACE = 'group_move_participant_claims';
export const GROUP_MOVE_PARTICIPANT_LOOKUP_NAMESPACE = 'group_move_participant_lookup';

function selectedClaims(
    read: GroupMoveRepository.Read,
    participants: GroupMove['participants']
): readonly GroupMoveRepository.ClaimRead[] {
    return groupMoveClaimSlots(read.identity, participants).map((expected) => {
        const matching = read.claims.filter((claim) =>
            claim.kind === expected.kind && claim.namespace === expected.namespace && claim.key === expected.key &&
            claim.principalId === expected.principalId
        );
        if (matching.length !== 1) {
            throw new TypeError('Group move read does not contain every selected claim exactly once');
        }
        return matching[0];
    });
}

export function computeGroupMoveClaimEffects(
    read: GroupMoveRepository.Read,
    move: GroupMove,
    expireAtTimestamp: number
): Either<GroupMoveRejection, readonly RuntimeStateGuardedBatchEffect[]> {
    const previous = read.record;
    const effects: RuntimeStateGuardedBatchEffect[] = [];
    const claims = selectedClaims(read, move.participants);
    for (const claim of claims) {
        const current = claim.current;
        const claimIdentity = { ...read.identity, principalId: claim.principalId };
        const owned = current !== null && jsonEquals(current.value, claimIdentity);
        if (previous?.value.move.status === 'proposed' && !owned) {
            throw new TypeError('Pending group move has lost a required claim');
        }
        if (!previous && owned) {
            throw new TypeError('Group move claim has no preceding proposal');
        }
        if (claim.kind !== 'lookup' && current && !owned) {
            if (previous?.value.move.status !== 'proposed' && move.status !== 'proposed') {
                continue;
            }
            return Either.ofLeft({
                code: 'group-move-rejected',
                message: 'A source room or participant already has a pending move.'
            });
        }
        if (claim.kind !== 'lookup' && move.status !== 'proposed') {
            if (current && owned) {
                effects.push({
                    effectId: claim.key,
                    operation: 'delete',
                    namespace: claim.namespace,
                    key: claim.key,
                    expectedRevision: current.entry.revision
                });
            }
            continue;
        }
        effects.push({
            effectId: `${claim.kind}:${claim.key}`,
            namespace: claim.namespace,
            key: claim.key,
            value: JSON.stringify(claimIdentity),
            expireAtTimestamp: claim.kind === 'lookup' ? expireAtTimestamp : NEVER_EXPIRE_AT_TIMESTAMP,
            ...(current ? { operation: 'update', expectedRevision: current.entry.revision } : { operation: 'insert' })
        });
    }
    return Either.ofRight(effects);
}

export function groupMoveClaimSlots(
    identity: GroupMoveClaim,
    participants: readonly Pick<GroupMove['participants'][number], 'principalId'>[]
): Omit<GroupMoveRepository.ClaimRead, 'current'>[] {
    const principals = [...new Set(participants.map((participant) => participant.principalId))].sort();
    return [
        {
            kind: 'source',
            principalId: null,
            namespace: SOURCE_CLAIMS_NAMESPACE,
            key: groupStateGroupStorageKey(identity.source)
        },
        ...principals.map((principalId) => ({
            kind: 'participant' as const,
            principalId,
            namespace: PARTICIPANT_CLAIMS_NAMESPACE,
            key: groupMovePrincipalKey(identity.source, principalId)
        })),
        ...principals.map((principalId) => ({
            kind: 'lookup' as const,
            principalId,
            namespace: GROUP_MOVE_PARTICIPANT_LOOKUP_NAMESPACE,
            key: groupMoveLookupKey(identity, principalId)
        }))
    ];
}

export function groupMovePrincipalKey(
    scope: Pick<GroupRef, 'applicationId' | 'workspaceId'>,
    principalId: string
): string {
    return `${groupStateScopeStorageKey(scope)}:principal=${encodeURIComponent(principalId)}`;
}

export function groupMoveLookupKey(identity: GroupMoveClaim, principalId: string): string {
    return `${groupMovePrincipalKey(identity.source, principalId)}:source=${
        encodeURIComponent(identity.source.groupId)
    }:move=${encodeURIComponent(identity.moveId)}`;
}
