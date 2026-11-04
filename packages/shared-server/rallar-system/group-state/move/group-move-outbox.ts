import { Temporal } from '@js-temporal/polyfill';
import { AL_MESSAGE_ENVELOPE_VERSION, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics, EnqueuedType } from '@shared/api/api-config.ts';
import type { GroupMove } from '@shared/api/mutation/group-move.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import type { GroupMoveClaim } from '@shared/api/mutation/decode-group-move.ts';
import type { RuntimeStateGuardedBatchEffect } from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { computeAppOutboxInsert, type AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import { AppOutboxType } from '../../app-outbox/app-outbox-type.ts';
import { computeSha256CanonicalJson } from '../../protocol/compute-sha256-canonical-json.ts';
import { computeWsOutboxProvenanceRecord } from '../../websocket/outbox/ws-outbox-provenance.ts';
import { groupStateGroupStorageKey } from '../persistence/aggregate/group-aggregate-storage-keys.ts';

import {
    groupMoveDeadlineDueAt,
    toGroupMoveDeadline,
    type GroupMoveDeadline,
    type GroupMoveHistoryDeadline
} from './group-move-deadline.ts';

interface GroupMovePublicationFacts {
    readonly createdAtEpochMs: number;
    readonly retentionMs: number;
    readonly serviceId: string;
    readonly traceId: string;
}

export interface GroupMovePublicationInput extends GroupMovePublicationFacts {
    readonly move: GroupMove;
    readonly revision: number;
    readonly previousStatus: GroupMove['status'] | null;
}

export interface GroupMovePublication {
    readonly outbox: readonly AppOutboxInsert[];
    readonly provenance: readonly RuntimeStateGuardedBatchEffect[];
}

interface GroupMoveChangeInput extends GroupMovePublicationFacts {
    readonly claim: GroupMoveClaim;
    readonly principalIds: readonly string[];
    readonly changeId: string;
}

export function computeGroupMovePublication(input: GroupMovePublicationInput): GroupMovePublication {
    const { move } = input;
    const claim = { source: move.source, moveId: move.moveId };
    const changes = computeGroupMoveChanges({
        ...input,
        claim,
        principalIds: [...new Set(move.participants.map((participant) => participant.principalId))].sort(),
        changeId: computeSha256CanonicalJson({
            kind: 'transition',
            claim,
            moveCreatedAtEpochMs: move.createdAtEpochMs,
            revision: input.revision
        })
    });
    const deadline = toGroupMoveDeadline(move, input.previousStatus, input.retentionMs);
    return deadline === null
        ? changes
        : { ...changes, outbox: [...changes.outbox, computeMoveDeadline(input, deadline)] };
}

export function computeGroupMoveHistoryPublication(
    command: GroupMoveHistoryDeadline,
    facts: GroupMovePublicationFacts
): GroupMovePublication {
    // The retained command, not a possibly reused move ID, owns this historical audience.
    return computeGroupMoveChanges({
        ...facts,
        claim: { source: command.source, moveId: command.moveId },
        principalIds: command.principalIds,
        changeId: computeSha256CanonicalJson(command)
    });
}

function computeGroupMoveChanges(input: GroupMoveChangeInput): GroupMovePublication {
    const { claim } = input;
    const expiresAtMs = input.createdAtEpochMs + input.retentionMs;
    const outbox: AppOutboxInsert[] = [];
    const provenance: RuntimeStateGuardedBatchEffect[] = [];
    for (const principalId of input.principalIds) {
        const principalRef = {
            applicationId: claim.source.applicationId,
            workspaceId: claim.source.workspaceId,
            principalId
        };
        const message = moveMessage(input, {
            topicId: AppTopics.groupMoveChanged,
            identity: { changeId: input.changeId, principalId },
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
            producerKind: 'group-move',
            entry,
            message,
            expiresAtMs,
            target: { kind: 'scoped-account-view', principalRef }
        });
        provenance.push({ effectId: `move-publication:${entry.key.resourceId}`, operation: 'insert', ...record });
        outbox.push(computeAppOutboxInsert(entry));
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

function moveMessage(input: GroupMovePublicationFacts, message: MoveMessageInput): ALMessage {
    const route = toAppQueueKey({
        topicId: message.topicId,
        resourceId: `gm-${computeSha256CanonicalJson(message.identity).slice(7, 37)}`,
        contextId: groupStateGroupStorageKey(message.payload.source)
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

function computeMoveDeadline(input: GroupMovePublicationFacts, deadline: GroupMoveDeadline): AppOutboxInsert {
    const message = moveMessage(input, {
        topicId: 'group-move.deadline',
        identity: deadline,
        expiresAtMs: groupMoveDeadlineDueAt(deadline) + input.retentionMs,
        targets: undefined,
        payload: deadline
    });
    const entry: ResourceEntry = {
        ...QueueBoxUtilities.toResourceEntryFromMsg(
            { ...message, payload: { ...message.payload, typeId: AppOutboxType.GROUP_MOVE_DEADLINE } },
            EnqueuedType.APP_OUTBOX,
            Temporal.Instant.fromEpochMilliseconds(input.createdAtEpochMs)
        ),
        dequeueAudit: { attempts: 0, nextTs: Temporal.Instant.fromEpochMilliseconds(groupMoveDeadlineDueAt(deadline)) }
    };
    return computeAppOutboxInsert(entry);
}
