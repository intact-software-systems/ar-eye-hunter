import type {
    Group,
    GroupEvent,
    GroupPresenceAdmission
} from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { computeGroupPresenceSummaryEntry } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';

import { computeRoomOwnedAppDataDelete } from '../../../app-data/room-owned-app-data.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type {
    RuntimeStateGuardedBatchEffect,
    RuntimeStateGuardedBatchUpdate
} from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { validateRuntimeStateGuardedBatch } from '../../../runtime-state/guarded-batch/validate-runtime-state-guarded-batch.ts';
import { computeAppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import { groupStateEventWorkspaceKey } from '../../state-events/postgres/group-state-event-workspace-key.ts';
import { GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS } from '../group-state-service-contracts.ts';
import type { GroupMutationReceipt } from '../mutation/group-mutation-contracts.ts';
import { groupStateUpdateGroupDescriptor } from '../persistence/aggregate/group-aggregate-write-descriptors.ts';
import type { RetiredGroupIdentity } from '../persistence/aggregate/retired-group-identity.ts';
import { GROUPS_NAMESPACE } from '../persistence/group-state-runtime-namespaces.ts';
import { groupStateInsertIdempotencyDescriptor } from '../persistence/idempotency/group-idempotency-write-descriptor.ts';
import {
    groupStateDeletePresenceDescriptor,
    groupStateInsertPresenceAdmissionDescriptor,
    groupStateUpdatePresenceAdmissionDescriptor
} from '../persistence/presence/group-presence-write-descriptors.ts';
import type { GroupRetentionService } from './group-retention-service.ts';

interface RetentionReceiptInput {
    readonly group: Group;
    readonly outcome: 'applied' | 'no-op';
    readonly outboxIds: readonly string[];
}

/** Materializes every conditional row and final outbox insert before AppInbox opens the transaction. */
export function computeGroupRetentionWrite(
    read: GroupRetentionService.Read,
    group: Group
): GroupRetentionService.ComputedWrite {
    const stored = read.authority.group;
    if (stored === undefined) {
        throw new TypeError('Retention write requires its observed group');
    }
    const event = toRetentionEvent(read, group);
    const entry = computeGroupPresenceSummaryEntry({
        effectKind: 'group-presence-summary',
        aggregateRef: read.ingress.command.groupRef,
        commandId: read.ingress.commandId,
        createdAtEpochMs: event.occurredAtEpochMs,
        expireAtEpochMs: GROUP_MUTATION_QUEUE_EXPIRE_AT_EPOCH_MS,
        acceptedCausalRevision: event.causalRevision,
        event
    }, read.ingress.serviceId);
    const receipt = toGroupRetentionReceipt(read, {
        group,
        outcome: 'applied',
        outboxIds: group.status === 'deleted' ? [] : [entry.key.resourceId]
    });
    const effects = group.status === 'deleted'
        ? computeRetirementDeletes(read)
        : group.status === 'archived'
        ? computeArchivePresenceFences(read)
        : [];
    effects.push(computeRetentionReceiptEffect(read, receipt));
    return {
        outcome: 'write',
        group,
        receipt,
        outboxWrites: group.status === 'deleted' ? [] : [computeAppOutboxInsert(entry)],
        ownedAppDataWrites: group.status === 'deleted'
            ? read.ownedAppData.flatMap((row) => computeRoomOwnedAppDataDelete(row) ?? [])
            : [],
        persistence: {
            guardedBatch: computeRuntimeStateGuardedBatchWrite(validateRuntimeStateGuardedBatch({
                guard: group.status === 'deleted'
                    ? computeRetirementGuard(read, group)
                    : groupStateUpdateGroupDescriptor(group, stored.entry.revision),
                effects
            })),
            lifecyclePolicyWrite: null,
            eventWrite: {
                event,
                workspaceKey: groupStateEventWorkspaceKey(group.workspaceId),
                eventJson: JSON.stringify(event)
            }
        }
    };
}

export function toGroupRetentionReceipt(
    read: GroupRetentionService.Read,
    input: RetentionReceiptInput
): GroupMutationReceipt {
    const stored = read.authority.group;
    if (stored === undefined) {
        throw new TypeError('Retention receipt requires its observed group');
    }
    return {
        commandId: read.ingress.commandId,
        requestId: read.ingress.command.requestId,
        commandHash: read.ingress.commandHash,
        aggregateRef: read.ingress.command.groupRef,
        outcome: input.outcome,
        attemptCount: read.attemptCount,
        acceptedStorageRevision: stored.entry.revision + (input.outcome === 'applied' ? 1 : 0),
        snapshotVersion: input.group.snapshotVersion,
        causalRevision: {
            groupRevision: input.group.snapshotVersion,
            presenceRevision: read.authority.current?.value.causalRevision.presenceRevision ?? 0
        },
        eventId: input.outcome === 'applied' ? read.ingress.eventId : null,
        outboxIds: input.outboxIds,
        joinCode: null,
        joinCodeExpiresAtEpochMs: null,
        rejection: null
    };
}

function toRetentionEvent(read: GroupRetentionService.Read, group: Group): GroupEvent {
    return {
        ...read.ingress.command.groupRef,
        eventId: read.ingress.eventId,
        eventType: group.status === 'deleted'
            ? 'group-deleted'
            : group.status === 'archived'
            ? 'group-archived'
            : 'group-updated',
        snapshotVersion: group.snapshotVersion,
        causalRevision: {
            groupRevision: group.snapshotVersion,
            presenceRevision: read.authority.current?.value.causalRevision.presenceRevision ?? 0
        },
        occurredAtEpochMs: read.ingress.capturedAtEpochMs,
        actor: { kind: 'service', serviceId: read.ingress.serviceId },
        reason: 'temporary-room-retention',
        traceId: null,
        requestId: read.ingress.command.requestId,
        payload: {}
    };
}

function computeArchivePresenceFences(read: GroupRetentionService.Read): RuntimeStateGuardedBatchEffect[] {
    // Every observed presence revision and active principal admission must agree before archival can commit.
    const effects: RuntimeStateGuardedBatchEffect[] = read.authority.presenceSessions.map((stored) => ({
        effectId: `retention-presence:${stored.value.sessionId}`,
        ...groupStateDeletePresenceDescriptor(stored.value, stored.entry.revision)
    }));
    const admissions = new Map(read.authority.admissions.map((stored) => [stored.value.principalId, stored]));
    const principals = read.authority.members.filter(({ value }) => value.status === 'active').map(({ value }) =>
        value.principalId
    ).toSorted();
    for (const principalId of principals) {
        const stored = admissions.get(principalId);
        const admission: GroupPresenceAdmission = {
            ...read.ingress.command.groupRef,
            principalId,
            admittedSessions: [],
            updatedAtEpochMs: Math.max(read.attemptAtEpochMs, stored?.value.updatedAtEpochMs ?? 0)
        };
        effects.push({
            effectId: `retention-admission:${principalId}`,
            ...(stored === undefined
                ? groupStateInsertPresenceAdmissionDescriptor(admission)
                : groupStateUpdatePresenceAdmissionDescriptor(admission, stored.entry.revision))
        });
    }
    return effects;
}

function computeRetirementDeletes(read: GroupRetentionService.Read): RuntimeStateGuardedBatchEffect[] {
    return read.retirementEntries.map(({ namespace, entry }) => ({
        effectId: `retirement:${namespace}:${entry.key}`,
        operation: 'delete',
        namespace,
        key: entry.key,
        expectedRevision: entry.revision
    }));
}

function computeRetirementGuard(read: GroupRetentionService.Read, group: Group): RuntimeStateGuardedBatchUpdate {
    const stored = read.authority.group;
    if (stored === undefined || group.deleted === null) {
        throw new TypeError('Retirement requires observed group and deletion timestamp');
    }
    const retired: RetiredGroupIdentity = {
        ...read.ingress.command.groupRef,
        kind: 'retired-group',
        deletedAtEpochMs: group.deleted.atEpochMs,
        causalRevision: {
            groupRevision: group.snapshotVersion,
            presenceRevision: read.authority.current?.value.causalRevision.presenceRevision ?? 0
        },
        commandId: read.ingress.commandId,
        commandHash: read.ingress.commandHash
    };
    return {
        operation: 'update' as const,
        namespace: GROUPS_NAMESPACE,
        key: stored.entry.key,
        expectedRevision: stored.entry.revision,
        value: JSON.stringify(retired),
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    };
}

function computeRetentionReceiptEffect(
    read: GroupRetentionService.Read,
    receipt: GroupMutationReceipt
): RuntimeStateGuardedBatchEffect {
    return {
        effectId: 'retention-receipt',
        ...groupStateInsertIdempotencyDescriptor({
            ref: read.ingress.command.groupRef,
            requestId: read.ingress.commandId,
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
            record: {
                aggregateRef: read.ingress.command.groupRef,
                requestId: read.ingress.commandId,
                commandHash: read.ingress.commandHash,
                receipt
            }
        })
    };
}
