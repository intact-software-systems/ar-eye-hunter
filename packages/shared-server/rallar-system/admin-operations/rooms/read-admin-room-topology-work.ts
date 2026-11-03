import {
    type AdminRoomTopologyWorkRequest,
    type AdminRoomTopologyWorkResponse
} from '@shared/api/admin-rooms/admin-room-topology-work.ts';
import { decodeAdminTopologyOutboxId } from '@shared/api/admin-rooms/decode-admin-room-topology-work.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import { toCanonicalGroupRef } from '@shared/api/group-types.ts';
import { assertValidRallarGroupRef } from '@shared/api/rallar-validation.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { EntityStatus, isKeysEqual, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    readRtcTopologyWorkEntry,
    RTC_TOPOLOGY_OUTBOX_TOPIC,
    RTC_TOPOLOGY_OUTBOX_TYPE
} from '@shared/queuebox/rtc-topology-work-entry-contract.ts';

import type { PSqlResourceInboxEntryReader } from '../../../queuebox/postgres/p-sql-resource-inbox-entry-reader.ts';
import {
    readRtcTopologyWorkEnvelope,
    toRtcTopologyQueueContextId,
    toRtcTopologyWorkGroupRef
} from '../../topology/replay/work/rtc-topology-work-codec.ts';

export namespace ReadAdminRoomTopologyWork {
    export interface Dependencies {
        readonly repository: Pick<PSqlResourceInboxEntryReader, 'findByKey'>;
        readonly nowEpochMs: () => number;
    }
}

/** Observes one retained queue row; never executes or repairs work. */
export class ReadAdminRoomTopologyWork {
    private readonly dependencies: ReadAdminRoomTopologyWork.Dependencies;

    constructor(dependencies: ReadAdminRoomTopologyWork.Dependencies) {
        this.dependencies = dependencies;
    }

    async read(request: AdminRoomTopologyWorkRequest): Promise<AdminRoomTopologyWorkResponse> {
        const roomRef = toCanonicalGroupRef(assertValidRallarGroupRef(request.roomRef));
        const outboxId = decodeAdminTopologyOutboxId(request.outboxId);
        const key = toAppQueueKey({
            topicId: RTC_TOPOLOGY_OUTBOX_TOPIC,
            resourceId: outboxId,
            contextId: toRtcTopologyQueueContextId(roomRef)
        });
        const entry = await this.dependencies.repository.findByKey(key);
        const observedAtEpochMs = this.dependencies.nowEpochMs();
        const base = { roomRef, outboxId, observedAtEpochMs };
        if (entry === null || entry.audit.expiryTs.epochMilliseconds <= observedAtEpochMs) {
            return { ...base, status: 'unknown', attempts: null, settledAtEpochMs: null };
        }
        const envelope = readRtcTopologyWorkEnvelope(readRtcTopologyWorkEntry(entry), RTC_TOPOLOGY_OUTBOX_TYPE);
        if (
            !isKeysEqual(entry.key, key) || envelope.resourceId !== outboxId ||
            !isSameGroupRef(toRtcTopologyWorkGroupRef(envelope.data), roomRef)
        ) {
            throw new TypeError('Topology work differs from the requested room or receipt');
        }
        const status = toObservedWorkStatus(entry);
        return {
            ...base,
            status,
            attempts: entry.dequeueAudit.attempts,
            settledAtEpochMs: status === 'pending' ? null : entry.dequeueAudit.endTs?.epochMilliseconds ?? null
        };
    }
}

function toObservedWorkStatus(entry: ResourceEntry): Exclude<AdminRoomTopologyWorkResponse['status'], 'unknown'> {
    switch (entry.status) {
        case EntityStatus.NEW:
        case EntityStatus.RETRY:
        case EntityStatus.RESERVED:
            return 'pending';
        case EntityStatus.COMPLETED:
            if (entry.dequeueAudit.endTs === undefined) {
                throw new TypeError('Completed topology work has no completion time');
            }
            return 'completed';
        case EntityStatus.FAILED:
        case EntityStatus.NON_RETRYABLE:
        case EntityStatus.ABORTED:
            return 'failed';
        default:
            throw new TypeError('Topology work has an unsupported state');
    }
}
