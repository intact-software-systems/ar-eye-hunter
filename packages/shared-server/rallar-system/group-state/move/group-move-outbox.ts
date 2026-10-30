import { Temporal } from '@js-temporal/polyfill';
import { AL_MESSAGE_ENVELOPE_VERSION, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics, EnqueuedType } from '@shared/api/api-config.ts';
import type { GroupMove } from '@shared/api/mutation/group-move.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import { requireExactKeys, requireRecord } from '@shared/api/exact-object-decoding.ts';
import { decodeGroupMoveClaim, type GroupMoveClaim } from '@shared/api/mutation/decode-group-move.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { computeAppOutboxInsert, type AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import { AppOutboxType } from '../../app-outbox/app-outbox-type.ts';
import { computeSha256CanonicalJson } from '../../protocol/canonical-json.ts';
import { computeWsOutboxProvenanceRecord } from '../../websocket/outbox/ws-outbox-provenance.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';

export interface GroupMoveDeadline extends GroupMoveClaim {
    readonly expiresAtEpochMs: number;
}

export interface GroupMovePublicationInput {
    readonly move: GroupMove;
    readonly revision: number;
    readonly createdAtEpochMs: number;
    readonly retentionMs: number;
    readonly serviceId: string;
    readonly traceId: string;
    readonly scheduleDeadline: boolean;
}

export interface GroupMovePublication {
    readonly outbox: readonly AppOutboxInsert[];
    readonly provenance: readonly RuntimeStateGuardedBatchEffect[];
}

export function decodeGroupMoveDeadline(value: unknown): GroupMoveDeadline {
    const deadline = requireRecord(value, 'Group move deadline');
    requireExactKeys(deadline, ['source', 'moveId', 'expiresAtEpochMs'], 'Group move deadline');
    if (
        typeof deadline.expiresAtEpochMs !== 'number' || !Number.isSafeInteger(deadline.expiresAtEpochMs) ||
        deadline.expiresAtEpochMs <= 0
    ) {
        throw new TypeError('Group move deadline is invalid');
    }
    return {
        ...decodeGroupMoveClaim({ source: deadline.source, moveId: deadline.moveId }),
        expiresAtEpochMs: deadline.expiresAtEpochMs
    };
}

export function computeGroupMovePublication(input: GroupMovePublicationInput): GroupMovePublication {
    const { move } = input;
    const claim: GroupMoveClaim = { source: move.source, moveId: move.moveId };
    const expiresAtMs = input.createdAtEpochMs + input.retentionMs;
    const outbox: AppOutboxInsert[] = [];
    const provenance: RuntimeStateGuardedBatchEffect[] = [];
    for (const principalId of [...new Set(move.participants.map((participant) => participant.principalId))].sort()) {
        const principalRef = {
            applicationId: move.source.applicationId,
            workspaceId: move.source.workspaceId,
            principalId
        };
        const message = moveMessage(input, {
            topicId: AppTopics.groupMoveChanged,
            identity: { claim, revision: input.revision, principalId },
            expiresAtMs,
            targets: { mode: 'broadcast', scope: 'principal', principalRef },
            payload: claim
        });
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(
            message,
            EnqueuedType.WS_OUTBOX,
            Temporal.Instant.fromEpochMilliseconds(input.createdAtEpochMs)
        );
        const record = computeWsOutboxProvenanceRecord({
            producerKind: 'state-sync',
            entry,
            message,
            expiresAtMs,
            target: {
                kind: 'scoped-principal-broadcast',
                principalRef,
                admittedAudience: move.participants.filter((participant) => participant.principalId === principalId)
                    .map((participant) => participant.sessionId).sort()
            }
        });
        provenance.push({
            effectId: `move-publication:${entry.key.resourceId}`,
            operation: 'insert',
            ...record
        });
        outbox.push(computeAppOutboxInsert(entry));
    }
    if (input.scheduleDeadline) {
        outbox.push(computeMoveDeadline(input, claim));
    }
    return { outbox, provenance };
}

interface MoveMessageInput {
    readonly topicId: string;
    readonly identity: object;
    readonly expiresAtMs: number;
    readonly targets: ALMessage['targets'];
    readonly payload: GroupMoveClaim | GroupMoveDeadline;
}

function moveMessage(input: GroupMovePublicationInput, message: MoveMessageInput): ALMessage {
    const route = toAppQueueKey({
        topicId: message.topicId,
        resourceId: `gm-${computeSha256CanonicalJson(message.identity).slice(7, 37)}`,
        contextId: groupStateGroupStorageKey(input.move.source)
    });
    return decodePersistedALMessageValue({
        id: {
            v: AL_MESSAGE_ENVELOPE_VERSION,
            msgId: route.resourceId,
            ts: input.createdAtEpochMs,
            senderId: input.serviceId,
            traceId: input.traceId
        },
        route,
        ...(message.targets === undefined ? {} : { targets: message.targets }),
        constraints: { expiresAtMs: message.expiresAtMs },
        delivery: {
            ownership: message.targets === undefined ? 'exclusive' : 'shared',
            reliability: 'at-least-once',
            ack: 'none'
        },
        payload: {
            typeId: message.topicId,
            contentType: 'application/json',
            resource: JSON.stringify(message.payload)
        },
        audit: { createdBy: input.serviceId, createdTs: input.createdAtEpochMs }
    });
}

function computeMoveDeadline(input: GroupMovePublicationInput, claim: GroupMoveClaim): AppOutboxInsert {
    const { move } = input;
    const deadline: GroupMoveDeadline = { ...claim, expiresAtEpochMs: move.expiresAtEpochMs };
    const message = moveMessage(input, {
        topicId: 'group-move.deadline',
        identity: deadline,
        expiresAtMs: move.expiresAtEpochMs + input.retentionMs,
        targets: undefined,
        payload: deadline
    });
    const entry: ResourceEntry = {
        ...QueueBoxUtilities.toResourceEntryFromMsg(
            { ...message, payload: { ...message.payload, typeId: AppOutboxType.GROUP_MOVE_DEADLINE } },
            EnqueuedType.APP_OUTBOX,
            Temporal.Instant.fromEpochMilliseconds(input.createdAtEpochMs)
        ),
        dequeueAudit: { attempts: 0, nextTs: Temporal.Instant.fromEpochMilliseconds(move.expiresAtEpochMs) }
    };
    return computeAppOutboxInsert(entry);
}
