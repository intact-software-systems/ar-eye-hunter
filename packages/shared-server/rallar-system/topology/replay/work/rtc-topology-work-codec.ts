import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/group-state-storage-keys.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { CanonicalGroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
import { readGroupCausalRevision } from '@shared/api/group-client-views.ts';
import { readCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { GroupRef, GroupSnapshot, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import {
    COALESCED_APP_OUTBOX_WORK_FIELD,
    type CoalescedAppOutboxWorkMetadata
} from '../../../app-outbox/coalesced-app-outbox-work-service.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import {
    readRtcRttTopologyOutboxIdentity,
    toRtcRttMutationReceiptId,
    type RtcRttTopologyOutboxIdentity
} from '../../../rtc-rtt/mutation/rtc-rtt-mutation-identifiers.ts';
import { validateRtcRttMeasurement } from '../../../rtc-rtt/persistence/rtc-rtt-persistence-validation.ts';
import type {
    RtcTopologyGroupRevisionWork,
    RtcTopologyRttRefreshWork
} from '../../mutation/rtc-topology-outbox-work.ts';

export interface RtcTopologyWorkEnvelope<T extends object> {
    readonly type: string;
    readonly topicId: string;
    readonly resourceId: string;
    readonly contextId: string;
    readonly senderId: string;
    readonly data: T;
}

export type PersistedRtcTopologyWork =
    & (RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork)
    & Readonly<{
        [COALESCED_APP_OUTBOX_WORK_FIELD]?: CoalescedAppOutboxWorkMetadata;
    }>;

interface RequireWorkKeysInput {
    readonly value: JsonWireObject;
    readonly required: readonly string[];
    readonly allowed: readonly string[];
    readonly label: string;
}

interface RtcTopologyCommonWork {
    readonly overlayId: string;
    readonly groupSnapshot: GroupSnapshot;
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

export function readRtcTopologyWorkEnvelope(
    message: ALMessage,
    expectedWorkType: string
): RtcTopologyWorkEnvelope<PersistedRtcTopologyWork> {
    const persistedMessage = decodePersistedALMessageValue(message);
    const value = decodeJsonWireValue(
        JSON.parse(persistedMessage.payload.resource),
        'RTC topology work envelope'
    );
    return readPersistedRtcTopologyWorkEnvelope(value, persistedMessage, expectedWorkType);
}

export function toRtcTopologyExecutionId(
    envelope: RtcTopologyWorkEnvelope<PersistedRtcTopologyWork>
): string {
    const metadata = envelope.data[COALESCED_APP_OUTBOX_WORK_FIELD];
    return [
        envelope.topicId,
        envelope.contextId,
        envelope.resourceId,
        metadata?.generation ?? 0
    ].join(':');
}

export function toRtcTopologyQueueContextId(groupRef: GroupRef): string {
    return groupStateGroupStorageKey(groupRef);
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
    const common = [
        'kind',
        'overlayId',
        'groupSnapshot',
        'requestedAtEpochMs',
        'requestOptions',
        'publish'
    ];
    if (work.kind !== 'group-revision' && work.kind !== 'rtt-refresh') {
        throw new TypeError('RTC topology work kind is invalid');
    }
    const commonWork = readCommonRtcTopologyWork(work, contextId);
    const durableIdentity = readRtcRttTopologyOutboxIdentity(
        resourceId,
        commonWork.groupSnapshot.group
    );
    const variantInput = { work, commonKeys: common, commonWork, durableIdentity };
    return work.kind === 'group-revision'
        ? readGroupRevisionWork(variantInput)
        : readRttRefreshWork(variantInput);
}

function readCommonRtcTopologyWork(
    work: JsonWireObject,
    contextId: string
): RtcTopologyCommonWork {
    requireWorkString(work.overlayId, 'RTC topology work overlayId');
    requireWorkInteger(work.requestedAtEpochMs, 'RTC topology work requestedAtEpochMs');
    const requestOptions = readCanonicalGroupTopologyConfigPatch(work.requestOptions);
    if (typeof work.publish !== 'boolean') {
        throw new TypeError('RTC topology work request options are invalid');
    }
    validateAuthoritativeGroupSnapshot(work.groupSnapshot);
    if (work.overlayId !== toScopedOverlayId(work.groupSnapshot.group)) {
        throw new TypeError('RTC topology work overlayId differs from group scope');
    }
    if (contextId !== toRtcTopologyQueueContextId(work.groupSnapshot.group)) {
        throw new TypeError('RTC topology work context differs from group scope');
    }
    return {
        overlayId: work.overlayId,
        groupSnapshot: work.groupSnapshot,
        requestedAtEpochMs: work.requestedAtEpochMs,
        requestOptions,
        publish: work.publish
    };
}

function readGroupRevisionWork(input: ReadRtcTopologyWorkVariantInput): PersistedRtcTopologyWork {
    const { work, commonKeys, commonWork, durableIdentity } = input;
    if (durableIdentity) {
        throw new TypeError('RTC topology group-revision work cannot use an RTT durable identity');
    }
    requireWorkKeys({
        value: work,
        required: [...commonKeys, 'sourceGroupStateCausalRevision'],
        allowed: [...commonKeys, 'sourceGroupStateCausalRevision', COALESCED_APP_OUTBOX_WORK_FIELD],
        label: 'RTC topology work data'
    });
    const sourceGroupStateCausalRevision = readWorkGroupCausalRevision(
        work.sourceGroupStateCausalRevision,
        'RTC topology work source causal revision'
    );
    validateWorkGroupCausalRevision(sourceGroupStateCausalRevision, commonWork.groupSnapshot);
    const metadata = readOptionalCoalescedWorkMetadata(work);
    return {
        kind: 'group-revision',
        ...commonWork,
        sourceGroupStateCausalRevision,
        ...optionalCoalescedMetadata(metadata)
    };
}

function readRttRefreshWork(input: ReadRtcTopologyWorkVariantInput): PersistedRtcTopologyWork {
    const { work, commonKeys, commonWork, durableIdentity } = input;
    const revision = ['requestedGroupStateCausalRevision', 'requestedRttVersion'];
    requireWorkKeys({
        value: work,
        required: [...commonKeys, ...revision, 'rtt', 'refinementObservationId'],
        allowed: [
            ...commonKeys,
            ...revision,
            'rtt',
            'refinementObservationId',
            COALESCED_APP_OUTBOX_WORK_FIELD
        ],
        label: 'RTC topology work data'
    });
    const requestedGroupStateCausalRevision = readWorkGroupCausalRevision(
        work.requestedGroupStateCausalRevision,
        'RTC topology RTT group causal revision'
    );
    validateWorkGroupCausalRevision(requestedGroupStateCausalRevision, commonWork.groupSnapshot);
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
    const metadata = readOptionalCoalescedWorkMetadata(work);
    if (metadata && durableIdentity) {
        throw new TypeError('RTC topology RTT work cannot combine coalesced and durable identity');
    }
    if (
        !metadata &&
        (!durableIdentity ||
            durableIdentity.receiptId !== work.refinementObservationId ||
            durableIdentity.version !== rtt.version)
    ) {
        throw new TypeError('RTC topology RTT work lacks durable or coalesced identity');
    }
    return {
        kind: 'rtt-refresh',
        ...commonWork,
        requestedGroupStateCausalRevision,
        requestedRttVersion: work.requestedRttVersion,
        rtt,
        refinementObservationId: work.refinementObservationId,
        ...optionalCoalescedMetadata(metadata)
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

function validateWorkGroupCausalRevision(
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

function optionalCoalescedMetadata(metadata: CoalescedAppOutboxWorkMetadata | undefined) {
    return metadata ? { [COALESCED_APP_OUTBOX_WORK_FIELD]: metadata } : {};
}

function readCoalescedWorkMetadata(value: JsonWireValue): CoalescedAppOutboxWorkMetadata {
    const metadata = requireWorkRecord(value, 'RTC topology coalescing metadata');
    requireWorkKeys({
        value: metadata,
        required: ['generation', 'requestedAtEpochMs', 'dueAtEpochMs', 'reasons'],
        allowed: ['generation', 'requestedAtEpochMs', 'dueAtEpochMs', 'reasons'],
        label: 'RTC topology coalescing metadata'
    });
    requireWorkInteger(metadata.generation, 'RTC topology coalescing generation');
    requireWorkInteger(metadata.requestedAtEpochMs, 'RTC topology coalescing requestedAtEpochMs');
    requireWorkInteger(metadata.dueAtEpochMs, 'RTC topology coalescing dueAtEpochMs');
    if (!isNonEmptyStringArray(metadata.reasons)) {
        throw new TypeError('RTC topology coalescing reasons are invalid');
    }
    return {
        generation: metadata.generation,
        requestedAtEpochMs: metadata.requestedAtEpochMs,
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
