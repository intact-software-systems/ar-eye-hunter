import { Temporal } from '@js-temporal/polyfill';

import {
    computeAppOutboxInsert,
    type AppOutboxInsert
} from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType, type RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { CanonicalGroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
import { readGroupCausalRevision } from '@shared/api/group-client-views.ts';
import type { GroupRef, GroupSnapshot, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { toAppQueueCreatedBy, toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { AppOutboxType } from '../../app-outbox/app-outbox-type.ts';

export const APP_OUTBOX_RTC_TOPOLOGY_TOPIC = 'app-outbox.rtc-topology';

interface ComputedRtcTopologyOutboxBase {
    readonly commandId: string;
    readonly aggregateRef: GroupRef;
    readonly acceptedCausalRevision: GroupStateCausalRevision;
    readonly groupSnapshot: GroupSnapshot;
    readonly effectKind: 'rtc-topology-recompute';
    readonly createdAtEpochMs: number;
    readonly expireAtEpochMs: number;
    readonly senderId: string;
    readonly resourceId: string;
    readonly requestOptions: CanonicalGroupTopologyConfigPatch;
    readonly publish: boolean;
}

export type ComputedRtcTopologyOutbox =
    | (
        & ComputedRtcTopologyOutboxBase
        & Readonly<{
            payloadKind: 'group-revision';
        }>
    )
    | (
        & ComputedRtcTopologyOutboxBase
        & Readonly<{
            payloadKind: 'rtt-refresh';
            rtt: RttMeasurementInfo;
            refinementObservationId: string;
        }>
    );

interface RtcTopologyGroupRevisionWork {
    readonly kind: 'group-revision';
    readonly overlayId: string;
    readonly groupSnapshot: GroupSnapshot;
    readonly sourceGroupStateCausalRevision: GroupStateCausalRevision;
    readonly requestedAtEpochMs: number;
    readonly requestOptions: CanonicalGroupTopologyConfigPatch;
    readonly origin: 'automatic' | 'commanded';
    readonly publish: boolean;
}

interface RtcTopologyRttRefreshWork {
    readonly kind: 'rtt-refresh';
    readonly overlayId: string;
    readonly groupSnapshot: GroupSnapshot;
    readonly requestedGroupStateCausalRevision: GroupStateCausalRevision;
    readonly requestedRttVersion: number;
    readonly rtt: RttMeasurementInfo;
    readonly refinementObservationId: string;
    readonly requestedAtEpochMs: number;
    readonly requestOptions: CanonicalGroupTopologyConfigPatch;
    readonly publish: boolean;
}

interface RtcTopologyWorkEnvelope {
    readonly type: typeof AppOutboxType.RTC_TOPOLOGY_RECOMPUTE;
    readonly topicId: string;
    readonly resourceId: string;
    readonly contextId: string;
    readonly senderId: string;
    readonly data: RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork;
}

function computeRtcTopologyEntry(computed: ComputedRtcTopologyOutbox): ResourceEntry {
    const createdBy = toAppQueueCreatedBy(computed.senderId);
    const overlayId = toScopedOverlayId(computed.aggregateRef);
    const sourceGroupStateCausalRevision = readGroupCausalRevision(computed.groupSnapshot);
    const messageId = toRtcTopologyEntryResourceId(computed);
    const contextId = groupStateGroupStorageKey(computed.aggregateRef);
    const key = toAppQueueKey({
        topicId: APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
        resourceId: messageId,
        contextId
    });
    const commonWork = {
        overlayId,
        groupSnapshot: computed.groupSnapshot,
        requestedAtEpochMs: computed.createdAtEpochMs,
        requestOptions: computed.requestOptions,
        publish: computed.publish
    } as const;
    const data: RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork = computed.payloadKind === 'rtt-refresh'
        ? {
            ...commonWork,
            kind: 'rtt-refresh',
            requestedGroupStateCausalRevision: sourceGroupStateCausalRevision,
            requestedRttVersion: computed.rtt.version,
            rtt: computed.rtt,
            refinementObservationId: computed.refinementObservationId
        }
        : {
            ...commonWork,
            kind: 'group-revision',
            sourceGroupStateCausalRevision,
            origin: 'automatic'
        };
    const envelope: RtcTopologyWorkEnvelope = {
        type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
        topicId: APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
        resourceId: messageId,
        contextId,
        senderId: createdBy,
        data
    };
    const message: ALMessage = {
        id: {
            v: 2,
            msgId: messageId,
            ts: computed.createdAtEpochMs,
            senderId: createdBy
        },
        route: key,
        constraints: { expiresAtMs: computed.expireAtEpochMs },
        ordering: {
            orderingKey: key.contextId,
            epoch: computed.acceptedCausalRevision.groupRevision,
            seq: computed.acceptedCausalRevision.presenceRevision
        },
        delivery: {
            ownership: 'exclusive',
            reliability: 'at-least-once',
            ack: 'none'
        },
        payload: {
            typeId: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
            contentType: 'application/json',
            resource: JSON.stringify(envelope)
        },
        audit: {
            createdBy,
            createdTs: computed.createdAtEpochMs
        }
    };
    const createdTs = Temporal.Instant.fromEpochMilliseconds(computed.createdAtEpochMs)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();
    return {
        key,
        resource: JSON.stringify(message),
        typeId: EnqueuedType.APP_OUTBOX,
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy,
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(computed.expireAtEpochMs)
        },
        dequeueAudit: { attempts: 0 }
    };
}

export function computeRtcTopologyOutboxInsert(
    computed: ComputedRtcTopologyOutbox
): AppOutboxInsert {
    return computeAppOutboxInsert(computeRtcTopologyEntry(computed));
}

export function toRtcTopologyEntryResourceId(computed: ComputedRtcTopologyOutbox): string {
    return computed.resourceId;
}

export function deriveRtcTopologyEntryResourceId(
    computed: Pick<ComputedRtcTopologyOutbox, 'commandId' | 'effectKind' | 'payloadKind' | 'acceptedCausalRevision'>
): string {
    return [
        computed.commandId,
        computed.effectKind,
        computed.payloadKind,
        `group=${computed.acceptedCausalRevision.groupRevision};presence=${computed.acceptedCausalRevision.presenceRevision}`
    ].join(':');
}
