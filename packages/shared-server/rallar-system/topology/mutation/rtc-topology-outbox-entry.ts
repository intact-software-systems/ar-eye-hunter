import { Temporal } from '@js-temporal/polyfill';

import {
    computeAppOutboxInsert,
    type AppOutboxInsert
} from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { AL_MESSAGE_ENVELOPE_VERSION, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType, type RttMeasurementInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { CanonicalGroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
import { readGroupCausalRevision } from '@shared/api/group-client-views.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import {
    toCanonicalGroupRef,
    type GroupRef,
    type GroupSnapshot,
    type GroupStateCausalRevision
} from '@shared/api/group-types.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

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
    readonly traceId: string;
}

export type ComputedRtcTopologyOutbox =
    | (
        & ComputedRtcTopologyOutboxBase
        & Readonly<{
            payloadKind: 'group-revision';
            /**
             * Who asked. The planner freezes `automatic` work under
             * `commanded` and `corrupt` replanning, so an application command
             * that arrives stamped `automatic` is discarded by exactly the
             * mode that exists to honour it (product decision 4).
             */
            origin: 'automatic' | 'commanded';
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

/**
 * A change of the group's membership or presence to plan for (D290): the group and the revision
 * that asked, never the snapshot itself, so the worker plans from the group's current stored
 * state and a 50-member room's queued row stays a few hundred bytes.
 */
export interface RtcTopologyGroupRevisionWork {
    readonly kind: 'group-revision';
    readonly overlayId: string;
    readonly groupRef: GroupRef;
    readonly sourceGroupStateCausalRevision: GroupStateCausalRevision;
    readonly requestedAtEpochMs: number;
    readonly requestOptions: CanonicalGroupTopologyConfigPatch;
    readonly origin: 'automatic' | 'commanded';
    readonly publish: boolean;
}

export interface RtcTopologyRttRefreshWork {
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

/**
 * A held reshape's wake-up (the reshape gate): one row per gate period, due when the gate opens, so a room where
 * nothing else happens still gets the reshape it is owed.
 */
export interface RtcTopologyReshapeDueWork {
    readonly kind: 'reshape-due';
    readonly overlayId: string;
    readonly groupRef: GroupRef;
    /** The gate period this row belongs to: the `gate.lastPassAtEpochMs` it was queued under. */
    readonly periodStartedAtEpochMs: number;
    readonly notBeforeEpochMs: number;
    readonly requestedAtEpochMs: number;
    readonly requestOptions: CanonicalGroupTopologyConfigPatch;
    readonly publish: boolean;
}

export interface ComputeRtcTopologyReshapeDueEntryInput {
    readonly groupRef: GroupRef;
    readonly periodStartedAtEpochMs: number;
    readonly notBeforeEpochMs: number;
    readonly requestedAtEpochMs: number;
    readonly expireAtEpochMs: number;
    readonly senderId: string;
    readonly traceId: string;
}

type RtcTopologyWork = RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork | RtcTopologyReshapeDueWork;

interface RtcTopologyWorkEnvelope {
    readonly type: typeof AppOutboxType.RTC_TOPOLOGY_RECOMPUTE;
    readonly topicId: string;
    readonly resourceId: string;
    readonly contextId: string;
    readonly senderId: string;
    readonly data: RtcTopologyWork;
}

interface ToRtcTopologyWorkEntryInput {
    readonly groupRef: GroupRef;
    readonly resourceId: string;
    readonly senderId: string;
    readonly data: RtcTopologyWork;
    readonly createdAtEpochMs: number;
    readonly expireAtEpochMs: number;
    readonly traceId: string;
    readonly ordering: Readonly<{ epoch: number; seq: number; }>;
    /** Null for work due at once; otherwise the queue holds the row invisible until then. */
    readonly notBeforeEpochMs: number | null;
}

function computeRtcTopologyEntry(computed: ComputedRtcTopologyOutbox): ResourceEntry {
    const commonWork = {
        overlayId: toScopedOverlayId(computed.aggregateRef),
        requestedAtEpochMs: computed.createdAtEpochMs,
        requestOptions: computed.requestOptions,
        publish: computed.publish
    } as const;
    const sourceGroupStateCausalRevision = readGroupCausalRevision(computed.groupSnapshot);
    const data: RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork = computed.payloadKind === 'rtt-refresh'
        ? {
            ...commonWork,
            kind: 'rtt-refresh',
            groupSnapshot: computed.groupSnapshot,
            requestedGroupStateCausalRevision: sourceGroupStateCausalRevision,
            requestedRttVersion: computed.rtt.version,
            rtt: computed.rtt,
            refinementObservationId: computed.refinementObservationId
        }
        : {
            ...commonWork,
            kind: 'group-revision',
            groupRef: toCanonicalGroupRef(computed.aggregateRef),
            sourceGroupStateCausalRevision,
            origin: computed.origin
        };
    return toRtcTopologyWorkEntry({
        groupRef: computed.aggregateRef,
        resourceId: toRtcTopologyEntryResourceId(computed),
        senderId: computed.senderId,
        data,
        createdAtEpochMs: computed.createdAtEpochMs,
        expireAtEpochMs: computed.expireAtEpochMs,
        traceId: computed.traceId,
        ordering: {
            epoch: computed.acceptedCausalRevision.groupRevision,
            seq: computed.acceptedCausalRevision.presenceRevision
        },
        notBeforeEpochMs: null
    });
}

/** Insert-only: its identity is the room and the period, so the period's one first hold writes the one row. */
export function computeRtcTopologyReshapeDueEntry(input: ComputeRtcTopologyReshapeDueEntryInput): ResourceEntry {
    const overlayId = toScopedOverlayId(input.groupRef);
    return toRtcTopologyWorkEntry({
        groupRef: input.groupRef,
        resourceId: `${overlayId}:reshape-due:${input.periodStartedAtEpochMs}`,
        senderId: input.senderId,
        data: {
            kind: 'reshape-due',
            overlayId,
            groupRef: toCanonicalGroupRef(input.groupRef),
            periodStartedAtEpochMs: input.periodStartedAtEpochMs,
            notBeforeEpochMs: input.notBeforeEpochMs,
            requestedAtEpochMs: input.requestedAtEpochMs,
            requestOptions: toCanonicalGroupTopologyConfigPatch({}),
            publish: true
        },
        createdAtEpochMs: input.requestedAtEpochMs,
        expireAtEpochMs: input.expireAtEpochMs,
        traceId: input.traceId,
        ordering: { epoch: 0, seq: 0 },
        notBeforeEpochMs: input.notBeforeEpochMs
    });
}

function toRtcTopologyWorkEntry(input: ToRtcTopologyWorkEntryInput): ResourceEntry {
    const createdBy = toAppQueueCreatedBy(input.senderId);
    const contextId = groupStateGroupStorageKey(input.groupRef);
    const key = toAppQueueKey({ topicId: APP_OUTBOX_RTC_TOPOLOGY_TOPIC, resourceId: input.resourceId, contextId });
    const envelope: RtcTopologyWorkEnvelope = {
        type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
        topicId: APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
        resourceId: input.resourceId,
        contextId,
        senderId: createdBy,
        data: input.data
    };
    const createdTs = Temporal.Instant.fromEpochMilliseconds(input.createdAtEpochMs)
        .toZonedDateTimeISO('UTC')
        .toPlainDateTime();
    return {
        key,
        resource: JSON.stringify(toRtcTopologyWorkMessage({ input, key, createdBy, envelope })),
        typeId: EnqueuedType.APP_OUTBOX,
        status: EntityStatus.NEW,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy,
            createdTs,
            expiryTs: Temporal.Instant.fromEpochMilliseconds(input.expireAtEpochMs)
        },
        dequeueAudit: input.notBeforeEpochMs === null
            ? { attempts: 0 }
            : { attempts: 0, nextTs: Temporal.Instant.fromEpochMilliseconds(input.notBeforeEpochMs) }
    };
}

interface ToRtcTopologyWorkMessageInput {
    readonly input: ToRtcTopologyWorkEntryInput;
    readonly key: Key;
    readonly createdBy: string;
    readonly envelope: RtcTopologyWorkEnvelope;
}

function toRtcTopologyWorkMessage({ input, key, createdBy, envelope }: ToRtcTopologyWorkMessageInput): ALMessage {
    return {
        id: {
            v: AL_MESSAGE_ENVELOPE_VERSION,
            msgId: input.resourceId,
            ts: input.createdAtEpochMs,
            senderId: createdBy,
            traceId: input.traceId
        },
        route: key,
        constraints: { expiresAtMs: input.expireAtEpochMs },
        ordering: { orderingKey: key.contextId, ...input.ordering },
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
            createdTs: input.createdAtEpochMs
        }
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
