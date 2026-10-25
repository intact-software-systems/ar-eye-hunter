import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { CanonicalGroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
import { readGroupCausalRevision } from '@shared/api/group-client-views.ts';
import { readCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import {
    toCanonicalGroupRef,
    type GroupRef,
    type GroupSnapshot,
    type GroupStateCausalRevision
} from '@shared/api/group-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { readRtcTopologyWorkMessage } from '@shared/queuebox/rtc-topology-work-entry-contract.ts';
import {
    COALESCED_APP_OUTBOX_WORK_FIELD,
    type CoalescedAppOutboxWorkMetadata
} from '../../../app-outbox/coalesced-app-outbox-work.ts';
import {
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '../../../protocol/json-wire-identity.ts';
import {
    readRtcRttTopologyOutboxIdentity,
    toRtcRttMutationReceiptId,
    type RtcRttTopologyOutboxIdentity
} from '../../../rtc-rtt/mutation/rtc-rtt-mutation-identifiers.ts';
import { validateRtcRttMeasurement } from '../../../rtc-rtt/persistence/rtc-rtt-persistence-validation.ts';
import type {
    RtcTopologyGroupRevisionWork,
    RtcTopologyRttRefreshWork
} from '../../mutation/rtc-topology-outbox-entry.ts';

export interface RtcTopologyWorkEnvelope<T extends object> {
    readonly type: string;
    readonly topicId: string;
    readonly resourceId: string;
    readonly contextId: string;
    readonly senderId: string;
    readonly data: T;
}

interface PersistedRtcTopologyGroupRevisionWork extends RtcTopologyGroupRevisionWork {
    readonly [COALESCED_APP_OUTBOX_WORK_FIELD]?: CoalescedAppOutboxWorkMetadata;
}

export type PersistedRtcTopologyWork = PersistedRtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork;

interface RequireWorkKeysInput {
    readonly value: JsonWireObject;
    readonly required: readonly string[];
    readonly allowed: readonly string[];
    readonly label: string;
}

interface RtcTopologyCommonWork {
    readonly overlayId: string;
    readonly requestedAtEpochMs: number;
    readonly requestOptions: CanonicalGroupTopologyConfigPatch;
    readonly publish: boolean;
}

interface ReadRtcTopologyWorkVariantInput {
    readonly work: JsonWireObject;
    readonly commonKeys: readonly string[];
    readonly commonWork: RtcTopologyCommonWork;
    readonly durableIdentity: RtcRttTopologyOutboxIdentity | null;
}

const COMMON_WORK_KEYS = ['kind', 'overlayId', 'requestedAtEpochMs', 'requestOptions', 'publish'] as const;

export function readRtcTopologyWorkEnvelope(
    message: ALMessage,
    expectedWorkType: string
): RtcTopologyWorkEnvelope<PersistedRtcTopologyWork> {
    const persistedMessage = readRtcTopologyWorkMessage(message);
    const value = decodeJsonWireValue(
        JSON.parse(persistedMessage.payload.resource),
        'RTC topology work envelope'
    );
    return readPersistedRtcTopologyWorkEnvelope(value, persistedMessage, expectedWorkType);
}

/**
 * A work row's execution id: its queue key, the creation instant of its message and its coalesced generation. A
 * coalesced head keeps its creation instant through every generation, and a head written afresh after its group
 * idled past the retention window takes a new one, so the fresh head's generations never reuse a work id that a claim
 * or publication of the head it replaced may still hold.
 */
export function toRtcTopologyExecutionId(
    envelope: RtcTopologyWorkEnvelope<PersistedRtcTopologyWork>,
    createdAtEpochMs: number
): string {
    const metadata = envelope.data.kind === 'group-revision'
        ? envelope.data[COALESCED_APP_OUTBOX_WORK_FIELD]
        : undefined;
    return [
        envelope.topicId,
        envelope.contextId,
        envelope.resourceId,
        createdAtEpochMs,
        metadata?.generation ?? 0
    ].join(':');
}

export function toRtcTopologyQueueContextId(groupRef: GroupRef): string {
    return groupStateGroupStorageKey(groupRef);
}

/** The group a work row plans for: a membership change names it, an RTT refresh carries its snapshot. */
export function toRtcTopologyWorkGroupRef(work: PersistedRtcTopologyWork): GroupRef {
    return work.kind === 'group-revision' ? work.groupRef : toCanonicalGroupRef(work.groupSnapshot.group);
}

function readPersistedRtcTopologyWorkEnvelope(
    value: JsonWireValue,
    message: ALMessage,
    expectedWorkType: string
): RtcTopologyWorkEnvelope<PersistedRtcTopologyWork> {
    const envelope = requireWorkRecord(value, 'RTC topology work envelope');
    requireWorkKeys({
        value: envelope,
        required: ['type', 'topicId', 'resourceId', 'contextId', 'senderId', 'data'],
        allowed: ['type', 'topicId', 'resourceId', 'contextId', 'senderId', 'data'],
        label: 'RTC topology work envelope'
    });
    requireWorkString(envelope.type, 'RTC topology work type');
    requireWorkString(envelope.topicId, 'RTC topology work topicId');
    requireWorkString(envelope.resourceId, 'RTC topology work resourceId');
    requireWorkString(envelope.contextId, 'RTC topology work contextId');
    requireWorkString(envelope.senderId, 'RTC topology work senderId');
    const queueKey = toAppQueueKey({
        topicId: envelope.topicId,
        resourceId: envelope.resourceId,
        contextId: envelope.contextId
    });
    if (
        envelope.senderId !== message.id.senderId ||
        envelope.type !== expectedWorkType ||
        message.payload.typeId !== expectedWorkType ||
        envelope.type !== message.payload.typeId ||
        queueKey.topicId !== message.route.topicId ||
        queueKey.resourceId !== message.route.resourceId ||
        queueKey.contextId !== message.route.contextId
    ) {
        throw new TypeError('RTC topology work envelope differs from its AL route');
    }
    const work = readPersistedRtcTopologyWork(envelope, envelope.resourceId, envelope.contextId);
    return {
        type: envelope.type,
        topicId: envelope.topicId,
        resourceId: envelope.resourceId,
        contextId: envelope.contextId,
        senderId: envelope.senderId,
        data: work
    };
}

function readPersistedRtcTopologyWork(
    envelope: JsonWireObject,
    resourceId: string,
    contextId: string
): PersistedRtcTopologyWork {
    const work = requireWorkRecord(envelope.data, 'RTC topology work data');
    if (work.kind !== 'group-revision' && work.kind !== 'rtt-refresh') {
        throw new TypeError('RTC topology work kind is invalid');
    }
    const groupRef = work.kind === 'group-revision'
        ? readWorkGroupRef(work.groupRef)
        : readWorkGroupSnapshot(work.groupSnapshot).group;
    const commonWork = readCommonRtcTopologyWork(work, contextId, groupRef);
    const durableIdentity = readRtcRttTopologyOutboxIdentity(resourceId, groupRef);
    const variantInput = { work, commonKeys: COMMON_WORK_KEYS, commonWork, durableIdentity };
    return work.kind === 'group-revision'
        ? readGroupRevisionWork(variantInput, groupRef)
        : readRttRefreshWork(variantInput, readWorkGroupSnapshot(work.groupSnapshot));
}

function readCommonRtcTopologyWork(
    work: JsonWireObject,
    contextId: string,
    groupRef: GroupRef
): RtcTopologyCommonWork {
    requireWorkString(work.overlayId, 'RTC topology work overlayId');
    requireWorkInteger(work.requestedAtEpochMs, 'RTC topology work requestedAtEpochMs');
    const requestOptions = readCanonicalGroupTopologyConfigPatch(work.requestOptions);
    if (typeof work.publish !== 'boolean') {
        throw new TypeError('RTC topology work request options are invalid');
    }
    if (work.overlayId !== toScopedOverlayId(groupRef)) {
        throw new TypeError('RTC topology work overlayId differs from group scope');
    }
    if (contextId !== toRtcTopologyQueueContextId(groupRef)) {
        throw new TypeError('RTC topology work context differs from group scope');
    }
    return {
        overlayId: work.overlayId,
        requestedAtEpochMs: work.requestedAtEpochMs,
        requestOptions,
        publish: work.publish
    };
}

function readWorkGroupSnapshot(value: JsonWireValue): GroupSnapshot {
    validateAuthoritativeGroupSnapshot(value);
    return value;
}

function readWorkGroupRef(value: JsonWireValue): GroupRef {
    const groupRef = requireWorkRecord(value, 'RTC topology work groupRef');
    const keys = ['applicationId', 'workspaceId', 'groupId'];
    requireWorkKeys({ value: groupRef, required: keys, allowed: keys, label: 'RTC topology work groupRef' });
    requireWorkString(groupRef.applicationId, 'RTC topology work groupRef applicationId');
    requireWorkString(groupRef.workspaceId, 'RTC topology work groupRef workspaceId');
    requireWorkString(groupRef.groupId, 'RTC topology work groupRef groupId');
    return {
        applicationId: groupRef.applicationId,
        workspaceId: groupRef.workspaceId,
        groupId: groupRef.groupId
    };
}

function readGroupRevisionWork(
    input: ReadRtcTopologyWorkVariantInput,
    groupRef: GroupRef
): PersistedRtcTopologyWork {
    const { work, commonKeys, commonWork, durableIdentity } = input;
    if (durableIdentity) {
        throw new TypeError('RTC topology group-revision work cannot use an RTT durable identity');
    }
    const keys = [...commonKeys, 'groupRef', 'sourceGroupStateCausalRevision', 'origin'];
    requireWorkKeys({
        value: work,
        required: keys,
        allowed: [...keys, COALESCED_APP_OUTBOX_WORK_FIELD],
        label: 'RTC topology work data'
    });
    const sourceGroupStateCausalRevision = readWorkGroupCausalRevision(
        work.sourceGroupStateCausalRevision,
        'RTC topology work source causal revision'
    );
    if (work.origin !== 'automatic' && work.origin !== 'commanded') {
        throw new TypeError('RTC topology group-revision work origin is invalid');
    }
    const metadata = readOptionalCoalescedWorkMetadata(work);
    return {
        kind: 'group-revision',
        ...commonWork,
        groupRef,
        sourceGroupStateCausalRevision,
        origin: work.origin,
        ...optionalCoalescedMetadata(metadata)
    };
}

function readRttRefreshWork(
    input: ReadRtcTopologyWorkVariantInput,
    groupSnapshot: GroupSnapshot
): PersistedRtcTopologyWork {
    const { work, commonKeys, commonWork, durableIdentity } = input;
    const keys = [
        ...commonKeys,
        'groupSnapshot',
        'requestedGroupStateCausalRevision',
        'requestedRttVersion',
        'rtt',
        'refinementObservationId'
    ];
    requireWorkKeys({ value: work, required: keys, allowed: keys, label: 'RTC topology work data' });
    const requestedGroupStateCausalRevision = readWorkGroupCausalRevision(
        work.requestedGroupStateCausalRevision,
        'RTC topology RTT group causal revision'
    );
    assertWorkGroupCausalRevision(requestedGroupStateCausalRevision, groupSnapshot);
    requireWorkInteger(work.requestedRttVersion, 'RTC topology RTT version');
    validateRtcRttMeasurement(work.rtt);
    requireWorkString(work.refinementObservationId, 'RTC topology RTT refinement observation id');
    const rtt = work.rtt;
    if (
        work.requestedRttVersion !== rtt.version ||
        work.refinementObservationId !== toRtcRttMutationReceiptId(rtt)
    ) {
        throw new TypeError('RTC topology RTT observation differs from work identity');
    }
    if (
        !durableIdentity ||
        durableIdentity.receiptId !== work.refinementObservationId ||
        durableIdentity.version !== rtt.version
    ) {
        throw new TypeError('RTC topology RTT work lacks its durable identity');
    }
    return {
        kind: 'rtt-refresh',
        ...commonWork,
        groupSnapshot,
        requestedGroupStateCausalRevision,
        requestedRttVersion: work.requestedRttVersion,
        rtt,
        refinementObservationId: work.refinementObservationId
    };
}

function readWorkGroupCausalRevision(
    value: JsonWireValue,
    label: string
): GroupStateCausalRevision {
    const revision = requireWorkRecord(value, label);
    requireWorkKeys({
        value: revision,
        required: ['groupRevision', 'presenceRevision'],
        allowed: ['groupRevision', 'presenceRevision'],
        label
    });
    requireWorkInteger(revision.groupRevision, `${label} groupRevision`);
    requireWorkInteger(revision.presenceRevision, `${label} presenceRevision`);
    return {
        groupRevision: revision.groupRevision,
        presenceRevision: revision.presenceRevision
    };
}

function assertWorkGroupCausalRevision(
    revision: GroupStateCausalRevision,
    snapshot: GroupSnapshot
): void {
    const snapshotRevision = readGroupCausalRevision(snapshot);
    if (
        revision.groupRevision !== snapshotRevision.groupRevision ||
        revision.presenceRevision !== snapshotRevision.presenceRevision
    ) {
        throw new TypeError('RTC topology work causal revision differs from snapshot');
    }
}

function readOptionalCoalescedWorkMetadata(
    work: JsonWireObject
): CoalescedAppOutboxWorkMetadata | undefined {
    return Object.hasOwn(work, COALESCED_APP_OUTBOX_WORK_FIELD)
        ? readCoalescedWorkMetadata(work[COALESCED_APP_OUTBOX_WORK_FIELD])
        : undefined;
}

function optionalCoalescedMetadata(
    metadata: CoalescedAppOutboxWorkMetadata | undefined
): Pick<Extract<PersistedRtcTopologyWork, { kind: 'group-revision'; }>, typeof COALESCED_APP_OUTBOX_WORK_FIELD> {
    return metadata ? { [COALESCED_APP_OUTBOX_WORK_FIELD]: metadata } : {};
}

function readCoalescedWorkMetadata(value: JsonWireValue): CoalescedAppOutboxWorkMetadata {
    const metadata = requireWorkRecord(value, 'RTC topology coalescing metadata');
    const keys = ['generation', 'requestedAtEpochMs', 'windowOpenedAtEpochMs', 'dueAtEpochMs', 'reasons'];
    requireWorkKeys({
        value: metadata,
        required: keys,
        allowed: keys,
        label: 'RTC topology coalescing metadata'
    });
    requireWorkInteger(metadata.generation, 'RTC topology coalescing generation');
    requireWorkInteger(metadata.requestedAtEpochMs, 'RTC topology coalescing requestedAtEpochMs');
    requireWorkInteger(metadata.windowOpenedAtEpochMs, 'RTC topology coalescing windowOpenedAtEpochMs');
    requireWorkInteger(metadata.dueAtEpochMs, 'RTC topology coalescing dueAtEpochMs');
    if (!isNonEmptyStringArray(metadata.reasons)) {
        throw new TypeError('RTC topology coalescing reasons are invalid');
    }
    return {
        generation: metadata.generation,
        requestedAtEpochMs: metadata.requestedAtEpochMs,
        windowOpenedAtEpochMs: metadata.windowOpenedAtEpochMs,
        dueAtEpochMs: metadata.dueAtEpochMs,
        reasons: metadata.reasons
    };
}

function isNonEmptyStringArray(value: JsonWireValue): value is readonly string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

function requireWorkRecord(value: JsonWireValue, label: string): JsonWireObject {
    if (!isWorkBoundaryRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}

function isWorkBoundaryRecord(value: JsonWireValue): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireWorkKeys(input: RequireWorkKeysInput): void {
    const { value, required, allowed, label } = input;
    const missing = required.find((key) => !Object.hasOwn(value, key));
    if (missing) {
        throw new TypeError(`${label} is missing ${missing}`);
    }
    const allowedKeys = new Set(allowed);
    const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
    if (unexpected) {
        throw new TypeError(`${label} has unexpected ${unexpected}`);
    }
}

function requireWorkString(value: JsonWireValue, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} is invalid`);
    }
}

function requireWorkInteger(value: JsonWireValue, label: string): asserts value is number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${label} is invalid`);
    }
}
