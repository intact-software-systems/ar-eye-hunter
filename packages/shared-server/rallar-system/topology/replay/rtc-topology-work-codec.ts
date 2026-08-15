import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
// prettier-ignore
import { validateRtcRttMeasurement }
  from '../../rtc-topology/persistence/rtc-rtt-persistence-validation.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
// prettier-ignore
import { readCanonicalGroupTopologyConfigPatch }
  from '@shared/api/group-topology-config-canonical.ts';
// prettier-ignore
import type { CanonicalGroupTopologyConfigPatch }
  from '@shared/api/graph-topology-management-types.ts';
import { readGroupStateRevision } from '@shared/api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import { groupStateGroupStorageKey } from '../../group-state-storage-keys.ts';
import {
  readRtcRttRecomputeOutboxIdentity,
  toRtcRttMutationReceiptId,
  type RtcRttRecomputeOutboxIdentity,
} from '../../rtc-topology/mutation/rtc-rtt-mutation-identifiers.ts';
import { validatePersistedALMessage } from '../../services/al-message-persistence-validation.ts';
import {
  COALESCED_APP_OUTBOX_WORK_FIELD,
  type CoalescedAppOutboxWorkMetadata,
} from '../../services/CoalescedAppOutboxWorkService.ts';
import { toAppQueueKey } from '../../services/app-inbox-queue-key.ts';
import type {
  RtcTopologyGroupRevisionWork,
  RtcTopologyLegacyRttRefreshWork,
  RtcTopologyRttRefreshWork,
} from '../../services/RtcTopologyOutboxWork.ts';

export type RtcTopologyWorkEnvelope<T extends object> = Readonly<{
  type: string;
  topicId: string;
  resourceId: string;
  contextId: string;
  senderId: string;
  data: T;
}>;

export type PersistedRtcTopologyWork = (
  RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork | RtcTopologyLegacyRttRefreshWork
) &
  Readonly<{
    [COALESCED_APP_OUTBOX_WORK_FIELD]?: CoalescedAppOutboxWorkMetadata;
  }>;

type WorkBoundaryValue =
  null | boolean | number | string | WorkBoundaryRecord | readonly WorkBoundaryValue[];

interface WorkBoundaryRecord {
  readonly [key: string]: WorkBoundaryValue;
}

interface RequireWorkKeysInput {
  readonly value: WorkBoundaryRecord;
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
  readonly work: WorkBoundaryRecord;
  readonly commonKeys: readonly string[];
  readonly commonWork: RtcTopologyCommonWork;
  readonly durableIdentity: RtcRttRecomputeOutboxIdentity | null;
}

export function readRtcTopologyWorkEnvelope(
  message: ALMessage,
  expectedWorkType: string,
): RtcTopologyWorkEnvelope<PersistedRtcTopologyWork> {
  validatePersistedALMessage(message);
  const value = JSON.parse(message.payload.resource) as WorkBoundaryValue;
  return readPersistedRtcTopologyWorkEnvelope(value, message, expectedWorkType);
}

export function toRtcTopologyExecutionId(
  envelope: RtcTopologyWorkEnvelope<PersistedRtcTopologyWork>,
): string {
  const metadata = envelope.data[COALESCED_APP_OUTBOX_WORK_FIELD];
  return [
    envelope.topicId,
    envelope.contextId,
    envelope.resourceId,
    metadata?.generation ?? 0,
  ].join(':');
}

export function parsePersistedRtcTopologyALMessage(serialized: string): ALMessage {
  const value = JSON.parse(serialized) as WorkBoundaryValue;
  validatePersistedALMessage(value);
  return value;
}

export function toRtcTopologyQueueContextId(groupRef: GroupRef): string {
  return groupStateGroupStorageKey(groupRef);
}

function readPersistedRtcTopologyWorkEnvelope(
  value: WorkBoundaryValue,
  message: ALMessage,
  expectedWorkType: string,
): RtcTopologyWorkEnvelope<PersistedRtcTopologyWork> {
  const envelope = requireWorkRecord(value, 'RTC topology work envelope');
  requireWorkKeys({
    value: envelope,
    required: ['type', 'topicId', 'resourceId', 'contextId', 'senderId', 'data'],
    allowed: ['type', 'topicId', 'resourceId', 'contextId', 'senderId', 'data'],
    label: 'RTC topology work envelope',
  });
  requireWorkString(envelope.type, 'RTC topology work type');
  requireWorkString(envelope.topicId, 'RTC topology work topicId');
  requireWorkString(envelope.resourceId, 'RTC topology work resourceId');
  requireWorkString(envelope.contextId, 'RTC topology work contextId');
  requireWorkString(envelope.senderId, 'RTC topology work senderId');
  const queueKey = toAppQueueKey({
    topicId: envelope.topicId,
    resourceId: envelope.resourceId,
    contextId: envelope.contextId,
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
    data: work,
  };
}

function readPersistedRtcTopologyWork(
  envelope: WorkBoundaryRecord,
  resourceId: string,
  contextId: string,
): PersistedRtcTopologyWork {
  const work = requireWorkRecord(envelope.data, 'RTC topology work data');
  const common = [
    'kind',
    'overlayId',
    'groupSnapshot',
    'requestedAtEpochMs',
    'requestOptions',
    'publish',
  ];
  if (work.kind !== 'group-revision' && work.kind !== 'rtt-refresh') {
    throw new TypeError('RTC topology work kind is invalid');
  }
  const commonWork = readCommonRtcTopologyWork(work, contextId);
  const durableIdentity = readRtcRttRecomputeOutboxIdentity(
    resourceId,
    commonWork.groupSnapshot.group,
  );
  const variantInput = { work, commonKeys: common, commonWork, durableIdentity };
  return work.kind === 'group-revision'
    ? readGroupRevisionWork(variantInput)
    : readRttRefreshWork(variantInput);
}

function readCommonRtcTopologyWork(
  work: WorkBoundaryRecord,
  contextId: string,
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
    publish: work.publish,
  };
}

function readGroupRevisionWork(input: ReadRtcTopologyWorkVariantInput): PersistedRtcTopologyWork {
  const { work, commonKeys, commonWork, durableIdentity } = input;
  requireWorkKeys({
    value: work,
    required: [...commonKeys, 'sourceGroupStateRevision'],
    allowed: [...commonKeys, 'sourceGroupStateRevision', COALESCED_APP_OUTBOX_WORK_FIELD],
    label: 'RTC topology work data',
  });
  validatePersistedRtcTopologyRevision(work);
  const metadata = readOptionalCoalescedWorkMetadata(work);
  requireWorkInteger(work.sourceGroupStateRevision, 'RTC topology work source revision');
  if (!durableIdentity) {
    return {
      kind: 'group-revision',
      ...commonWork,
      sourceGroupStateRevision: work.sourceGroupStateRevision,
      ...optionalCoalescedMetadata(metadata),
    };
  }
  if (Object.hasOwn(work, COALESCED_APP_OUTBOX_WORK_FIELD)) {
    throw new TypeError('Legacy durable RTC RTT work cannot contain coalescing metadata');
  }
  return {
    kind: 'legacy-rtt-refresh',
    legacySource: 'durable-group-revision',
    ...commonWork,
    requestedGroupStateRevision: work.sourceGroupStateRevision,
    requestedRttVersion: durableIdentity.version,
    refinementObservationId: durableIdentity.receiptId,
  };
}

function readRttRefreshWork(input: ReadRtcTopologyWorkVariantInput): PersistedRtcTopologyWork {
  const { work, commonKeys, commonWork, durableIdentity } = input;
  const revision = ['requestedGroupStateRevision', 'requestedRttVersion'];
  const hasCanonicalObservation =
    Object.hasOwn(work, 'rtt') || Object.hasOwn(work, 'refinementObservationId');
  requireWorkKeys({
    value: work,
    required: hasCanonicalObservation
      ? [...commonKeys, ...revision, 'rtt', 'refinementObservationId']
      : [...commonKeys, ...revision],
    allowed: [
      ...commonKeys,
      ...revision,
      ...(hasCanonicalObservation ? ['rtt', 'refinementObservationId'] : []),
      COALESCED_APP_OUTBOX_WORK_FIELD,
    ],
    label: 'RTC topology work data',
  });
  validatePersistedRtcTopologyRevision(work);
  requireWorkInteger(work.requestedGroupStateRevision, 'RTC topology RTT group revision');
  requireWorkInteger(work.requestedRttVersion, 'RTC topology RTT version');
  if (!hasCanonicalObservation) {
    const metadata = readOptionalCoalescedWorkMetadata(work);
    if (!metadata) {
      throw new TypeError('Legacy RTC topology RTT work coalescing metadata is required');
    }
    return {
      kind: 'legacy-rtt-refresh',
      legacySource: 'rtt-refresh',
      ...commonWork,
      requestedGroupStateRevision: work.requestedGroupStateRevision,
      requestedRttVersion: work.requestedRttVersion,
      refinementObservationId: null,
      [COALESCED_APP_OUTBOX_WORK_FIELD]: metadata,
    };
  }

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
  if (
    !metadata &&
    (!durableIdentity || durableIdentity.receiptId !== work.refinementObservationId)
  ) {
    throw new TypeError('RTC topology RTT work lacks durable or coalesced identity');
  }
  return {
    kind: 'rtt-refresh',
    ...commonWork,
    requestedGroupStateRevision: work.requestedGroupStateRevision,
    requestedRttVersion: work.requestedRttVersion,
    rtt,
    refinementObservationId: work.refinementObservationId,
    ...optionalCoalescedMetadata(metadata),
  };
}

function validatePersistedRtcTopologyRevision(work: WorkBoundaryRecord): void {
  const groupSnapshot = work.groupSnapshot;
  validateAuthoritativeGroupSnapshot(groupSnapshot);
  const stateRevision = readGroupStateRevision(groupSnapshot);
  if (work.kind === 'group-revision') {
    requireWorkInteger(work.sourceGroupStateRevision, 'RTC topology work sourceGroupStateRevision');
    if (work.sourceGroupStateRevision !== stateRevision) {
      throw new TypeError('RTC topology work source revision differs from snapshot');
    }
  } else {
    requireWorkInteger(
      work.requestedGroupStateRevision,
      'RTC topology work requestedGroupStateRevision',
    );
    requireWorkInteger(work.requestedRttVersion, 'RTC topology work requestedRttVersion');
    if (work.requestedGroupStateRevision !== stateRevision) {
      throw new TypeError('RTC topology RTT work revision differs from snapshot');
    }
  }
}

function readOptionalCoalescedWorkMetadata(
  work: WorkBoundaryRecord,
): CoalescedAppOutboxWorkMetadata | undefined {
  return Object.hasOwn(work, COALESCED_APP_OUTBOX_WORK_FIELD)
    ? readCoalescedWorkMetadata(work[COALESCED_APP_OUTBOX_WORK_FIELD])
    : undefined;
}

function optionalCoalescedMetadata(metadata: CoalescedAppOutboxWorkMetadata | undefined) {
  return metadata ? { [COALESCED_APP_OUTBOX_WORK_FIELD]: metadata } : {};
}

function readCoalescedWorkMetadata(value: WorkBoundaryValue): CoalescedAppOutboxWorkMetadata {
  const metadata = requireWorkRecord(value, 'RTC topology coalescing metadata');
  requireWorkKeys({
    value: metadata,
    required: ['generation', 'requestedAtEpochMs', 'dueAtEpochMs', 'reasons'],
    allowed: ['generation', 'requestedAtEpochMs', 'dueAtEpochMs', 'reasons'],
    label: 'RTC topology coalescing metadata',
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
    reasons: metadata.reasons,
  };
}

function isNonEmptyStringArray(value: WorkBoundaryValue): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

function requireWorkRecord(value: WorkBoundaryValue, label: string): WorkBoundaryRecord {
  if (!isWorkBoundaryRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function isWorkBoundaryRecord(value: WorkBoundaryValue): value is WorkBoundaryRecord {
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

function requireWorkString(value: WorkBoundaryValue, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} is invalid`);
  }
}

function requireWorkInteger(value: WorkBoundaryValue, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} is invalid`);
  }
}
