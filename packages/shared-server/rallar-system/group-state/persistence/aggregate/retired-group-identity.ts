import type {
    Group,
    GroupRef,
    GroupStateCausalRevision
} from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import {
    requireEpoch,
    requireExactKeys,
    requirePositiveInteger,
    requireRecord,
    requireString
} from '@shared/api/exact-object-decoding.ts';
import type { RuntimeStateEntryValue } from '../../../../runtime-state/runtime-state-json-store.ts';
import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import {
    assertGroupRefIdentity,
    GroupStateRepositoryInvariantCorruptionError
} from '../group-state-persistence-contracts.ts';

/** Permanent reservation of a deleted room's scoped identity; it contains no room or member state. */
export interface RetiredGroupIdentity extends GroupRef {
    readonly kind: 'retired-group';
    readonly deletedAtEpochMs: number;
    readonly causalRevision: GroupStateCausalRevision;
    readonly commandId: string;
    readonly commandHash: string;
}

export function isRetiredGroupIdentity(value: Group | RetiredGroupIdentity): value is RetiredGroupIdentity {
    return 'kind' in value && value.kind === 'retired-group';
}

export function decodeRetiredGroupIdentity(
    stored: RuntimeStateEntryValue<JsonWireValue>,
    expected: GroupRef
): RetiredGroupIdentity {
    try {
        const value = requireRecord(stored.value, 'Retired group');
        requireExactKeys(value, [
            'applicationId',
            'workspaceId',
            'groupId',
            'kind',
            'deletedAtEpochMs',
            'causalRevision',
            'commandId',
            'commandHash'
        ], 'Retired group');
        requireString(value.applicationId, 'Retired application');
        requireString(value.workspaceId, 'Retired workspace');
        requireString(value.groupId, 'Retired group id');
        requireString(value.commandId, 'Retirement command');
        requireString(value.commandHash, 'Retirement hash');
        requireEpoch(value.deletedAtEpochMs, 'Retirement timestamp');
        const revision = requireRecord(value.causalRevision, 'Retirement revision');
        requireExactKeys(revision, ['groupRevision', 'presenceRevision'], 'Retirement revision');
        requirePositiveInteger(revision.groupRevision, 'Retirement group revision');
        requireEpoch(revision.presenceRevision, 'Retirement presence revision');
        if (value.kind !== 'retired-group' || stored.entry.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP) {
            throw new TypeError('Retired group must be permanent');
        }
        const retired: RetiredGroupIdentity = {
            applicationId: value.applicationId,
            workspaceId: value.workspaceId,
            groupId: value.groupId,
            kind: 'retired-group',
            deletedAtEpochMs: Number(value.deletedAtEpochMs),
            causalRevision: {
                groupRevision: Number(revision.groupRevision),
                presenceRevision: Number(revision.presenceRevision)
            },
            commandId: value.commandId,
            commandHash: value.commandHash
        };
        assertGroupRefIdentity(retired, expected, stored.entry.key);
        return retired;
    }
    catch (error) {
        throw new GroupStateRepositoryInvariantCorruptionError(
            stored.entry.key,
            error instanceof Error ? error.message : 'Invalid retirement'
        );
    }
}
