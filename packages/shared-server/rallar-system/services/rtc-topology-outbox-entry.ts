import { Temporal } from '@js-temporal/polyfill';

import {
    EnqueuedType,
    type RttMeasurementInfo,
} from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { readGroupStateRevision } from '@shared/api/group-client-views.ts';
import { groupStateGroupStorageKey } from '../group-state-storage-keys.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type {
    GroupRef,
    GroupSnapshot,
    GroupStateCausalRevision,
} from '@shared/api/group-types.ts';
import type { CanonicalGroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
import { readCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    EntityStatus,
    type ResourceEntry,
} from '@shared/queuebox/ResourceEntry.ts';

import type { PSqlTransactionSql } from '../../postgres/PostgresSqlClient.ts';
import { ResourceInboxRepository } from '../../postgres/resource-inbox/ResourceInboxRepository.ts';
// prettier-ignore
import { validateRtcRttMeasurement }
  from '../rtc-topology/persistence/rtc-rtt-persistence-validation.ts';
// prettier-ignore
import { toRtcRttMutationReceiptId }
  from '../rtc-topology/mutation/rtc-rtt-mutation-identifiers.ts';
import { AppOutboxType } from './AppOutboxService.ts';
import { toAppQueueCreatedBy, toAppQueueKey } from './app-inbox-queue-key.ts';

export const APP_OUTBOX_RTC_TOPOLOGY_TOPIC = 'app-outbox.rtc-topology';

export type RtcTopologyOutboxWriteSink = () => void;

// One process-wide sink keeps this free-function write path additive and opt-in.
let outboxWriteSink: RtcTopologyOutboxWriteSink | undefined;

export function setRtcTopologyOutboxWriteSink(
    sink: RtcTopologyOutboxWriteSink | undefined,
): void {
    outboxWriteSink = sink;
}

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
    | (ComputedRtcTopologyOutboxBase &
          Readonly<{
              payloadKind: 'group-revision';
          }>)
    | (ComputedRtcTopologyOutboxBase &
          Readonly<{
              payloadKind: 'rtt-refresh';
              rtt: RttMeasurementInfo;
              refinementObservationId: string;
          }>);

type LegacyComputedRtcTopologyOutboxInput =
    ComputedRtcTopologyOutbox extends infer T
        ? T extends ComputedRtcTopologyOutbox
            ? Omit<T, 'senderId' | 'resourceId'>
            : never
        : never;

interface RtcTopologyGroupRevisionWork {
    readonly kind: 'group-revision';
    readonly overlayId: string;
    readonly groupSnapshot: GroupSnapshot;
    readonly sourceGroupStateRevision: number;
    readonly requestedAtEpochMs: number;
    readonly requestOptions: CanonicalGroupTopologyConfigPatch;
    readonly publish: boolean;
}

interface RtcTopologyRttRefreshWork {
    readonly kind: 'rtt-refresh';
    readonly overlayId: string;
    readonly groupSnapshot: GroupSnapshot;
    readonly requestedGroupStateRevision: number;
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

export function computeRtcTopologyEntry(
    computed: ComputedRtcTopologyOutbox,
): ResourceEntry;
/** @deprecated Materialize sender and resource identity before calling. */
export function computeRtcTopologyEntry(
    computed: LegacyComputedRtcTopologyOutboxInput,
    senderId: string,
): ResourceEntry;
export function computeRtcTopologyEntry(
    input: ComputedRtcTopologyOutbox | LegacyComputedRtcTopologyOutboxInput,
    legacySenderId?: string,
): ResourceEntry {
    const computed =
        'senderId' in input && 'resourceId' in input
            ? input
            : {
                  ...input,
                  senderId: legacySenderId ?? '',
                  resourceId: deriveRtcTopologyEntryResourceId(input),
              };
    validateComputedRtcTopologyOutbox(computed);
    const createdBy = toAppQueueCreatedBy(computed.senderId);
    const overlayId = toScopedOverlayId(computed.aggregateRef);
    const sourceGroupStateRevision = readGroupStateRevision(
        computed.groupSnapshot,
    );
    const messageId = toRtcTopologyEntryResourceId(computed);
    const contextId = groupStateGroupStorageKey(computed.aggregateRef);
    const key = toAppQueueKey({
        topicId: APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
        resourceId: messageId,
        contextId,
    });
    const commonWork = {
        overlayId,
        groupSnapshot: computed.groupSnapshot,
        requestedAtEpochMs: computed.createdAtEpochMs,
        requestOptions: computed.requestOptions,
        publish: computed.publish,
    } as const;
    const data: RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork =
        computed.payloadKind === 'rtt-refresh'
            ? {
                  ...commonWork,
                  kind: 'rtt-refresh',
                  requestedGroupStateRevision: sourceGroupStateRevision,
                  requestedRttVersion: computed.rtt.version,
                  rtt: computed.rtt,
                  refinementObservationId: computed.refinementObservationId,
              }
            : {
                  ...commonWork,
                  kind: 'group-revision',
                  sourceGroupStateRevision,
              };
    const envelope: RtcTopologyWorkEnvelope = {
        type: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
        topicId: APP_OUTBOX_RTC_TOPOLOGY_TOPIC,
        resourceId: messageId,
        contextId,
        senderId: createdBy,
        data,
    };
    const message: ALMessage = {
        id: {
            v: 2,
            msgId: messageId,
            ts: computed.createdAtEpochMs,
            senderId: createdBy,
        },
        route: key,
        constraints: { expiresAtMs: computed.expireAtEpochMs },
        ordering: {
            orderingKey: key.contextId,
            epoch: computed.acceptedCausalRevision.groupRevision,
            seq: computed.acceptedCausalRevision.presenceRevision,
        },
        delivery: {
            ownership: 'exclusive',
            reliability: 'at-least-once',
            ack: 'none',
        },
        payload: {
            typeId: AppOutboxType.RTC_TOPOLOGY_RECOMPUTE,
            contentType: 'application/json',
            resource: JSON.stringify(envelope),
        },
        audit: {
            createdBy,
            createdTs: computed.createdAtEpochMs,
        },
    };
    const createdTs = Temporal.Instant.fromEpochMilliseconds(
        computed.createdAtEpochMs,
    )
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
            expiryTs: Temporal.Instant.fromEpochMilliseconds(
                computed.expireAtEpochMs,
            ),
        },
        dequeueAudit: { attempts: 0 },
    };
}

export function toRtcTopologyEntryResourceId(
    computed: ComputedRtcTopologyOutbox,
): string {
    return computed.resourceId;
}

export async function writeRtcTopologyOutbox(
    transaction: PSqlTransactionSql,
    computed: ComputedRtcTopologyOutbox,
): Promise<ResourceEntry>;
/** @deprecated Materialize sender and resource identity before calling. */
export async function writeRtcTopologyOutbox(
    transaction: PSqlTransactionSql,
    computed: LegacyComputedRtcTopologyOutboxInput,
    senderId: string,
): Promise<ResourceEntry>;
export async function writeRtcTopologyOutbox(
    transaction: PSqlTransactionSql,
    computed: ComputedRtcTopologyOutbox | LegacyComputedRtcTopologyOutboxInput,
    senderId?: string,
): Promise<ResourceEntry> {
    const entry =
        'senderId' in computed && 'resourceId' in computed
            ? computeRtcTopologyEntry(computed)
            : computeRtcTopologyEntry(computed, senderId ?? '');
    await new ResourceInboxRepository(transaction).writeIfAbsentOrMatch(entry);
    try {
        outboxWriteSink?.();
    } catch {
        // Recording must never affect topology outbox writes.
    }
    return entry;
}

export function deriveRtcTopologyEntryResourceId(
    computed: Pick<
        ComputedRtcTopologyOutbox,
        'commandId' | 'effectKind' | 'payloadKind' | 'acceptedCausalRevision'
    >,
): string {
    return [
        computed.commandId,
        computed.effectKind,
        computed.payloadKind,
        `group=${computed.acceptedCausalRevision.groupRevision};presence=${computed.acceptedCausalRevision.presenceRevision}`,
    ].join(':');
}

function validateComputedRtcTopologyOutbox(
    computed: ComputedRtcTopologyOutbox,
): void {
    const snapshot = computed.groupSnapshot;
    validateAuthoritativeGroupSnapshot(snapshot);
    if (
        computed.commandId.length === 0 ||
        computed.resourceId.length === 0 ||
        computed.senderId.length === 0 ||
        computed.effectKind !== 'rtc-topology-recompute' ||
        (computed.payloadKind !== 'group-revision' &&
            computed.payloadKind !== 'rtt-refresh') ||
        !Number.isSafeInteger(computed.createdAtEpochMs) ||
        !Number.isSafeInteger(computed.expireAtEpochMs) ||
        computed.createdAtEpochMs < 0 ||
        computed.expireAtEpochMs <= computed.createdAtEpochMs ||
        computed.aggregateRef.applicationId !== snapshot.group.applicationId ||
        computed.aggregateRef.workspaceId !== snapshot.group.workspaceId ||
        computed.aggregateRef.groupId !== snapshot.group.groupId ||
        computed.acceptedCausalRevision.groupRevision !==
            snapshot.causalRevision.groupRevision ||
        computed.acceptedCausalRevision.presenceRevision !==
            snapshot.causalRevision.presenceRevision ||
        typeof computed.publish !== 'boolean' ||
        !hasCanonicalRequestOptions(computed.requestOptions)
    ) {
        throw new TypeError('Computed RTC topology outbox facts are invalid');
    }
    if (computed.payloadKind === 'rtt-refresh') {
        validateRtcRttMeasurement(computed.rtt);
        if (
            computed.refinementObservationId !==
            toRtcRttMutationReceiptId(computed.rtt)
        ) {
            throw new TypeError(
                'Computed RTC topology RTT refresh facts are invalid',
            );
        }
    }
}

function hasCanonicalRequestOptions(value: unknown): boolean {
    try {
        readCanonicalGroupTopologyConfigPatch(value);
        return true;
    } catch {
        return false;
    }
}
