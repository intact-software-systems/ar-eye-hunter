import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import {
  readCanonicalGroupTopologyConfigPatch,
} from '@shared/api/group-topology-config-canonical.ts';
import { readGroupStateRevision } from '@shared/api/group-client-views.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import { groupStateGroupStorageKey } from '../../group-state-storage-keys.ts';
import { validatePersistedALMessage } from '../../services/al-message-persistence-validation.ts';
import {
  COALESCED_APP_OUTBOX_WORK_FIELD,
  type CoalescedAppOutboxWorkMetadata,
} from '../../services/CoalescedAppOutboxWorkService.ts';
import { toAppQueueKey } from '../../services/app-inbox-queue-key.ts';
import type {
  RtcTopologyGroupRevisionWork,
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

export type PersistedRtcTopologyWork = (RtcTopologyGroupRevisionWork | RtcTopologyRttRefreshWork) &
  Readonly<{
    [COALESCED_APP_OUTBOX_WORK_FIELD]?: CoalescedAppOutboxWorkMetadata;
  }>;

type WorkBoundaryValue =
  | null
  | boolean
  | number
  | string
  | WorkBoundaryRecord
  | readonly WorkBoundaryValue[];

interface WorkBoundaryRecord {
  readonly [key: string]: WorkBoundaryValue;
}

interface RequireWorkKeysInput {
  readonly value: WorkBoundaryRecord;
  readonly required: readonly string[];
  readonly allowed: readonly string[];
  readonly label: string;
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
  validatePersistedRtcTopologyWork(envelope, expectedWorkType);
  return envelope as WorkBoundaryRecord & RtcTopologyWorkEnvelope<PersistedRtcTopologyWork>;
}

function validatePersistedRtcTopologyWork(
  envelope: WorkBoundaryRecord,
  _expectedWorkType: string,
): void {
  const work = requireWorkRecord(envelope.data, 'RTC topology work data');
  const common = [
    'kind',
    'overlayId',
    'groupSnapshot',
    'requestedAtEpochMs',
    'requestOptions',
    'publish',
  ];
  const variant =
    work.kind === 'group-revision'
      ? ['sourceGroupStateRevision']
      : work.kind === 'rtt-refresh'
        ? ['requestedGroupStateRevision', 'requestedRttVersion']
        : null;
  if (!variant) {
    throw new TypeError('RTC topology work kind is invalid');
  }
  const allowed = [...common, ...variant, COALESCED_APP_OUTBOX_WORK_FIELD];
  requireWorkKeys({
    value: work,
    required: [...common, ...variant],
    allowed,
    label: 'RTC topology work data',
  });
  requireWorkString(work.overlayId, 'RTC topology work overlayId');
  requireWorkInteger(work.requestedAtEpochMs, 'RTC topology work requestedAtEpochMs');
  try {
    readCanonicalGroupTopologyConfigPatch(work.requestOptions);
  } catch {
    throw new TypeError('RTC topology work request options are invalid');
  }
  if (typeof work.publish !== 'boolean') {
    throw new TypeError('RTC topology work request options are invalid');
  }
  validateAuthoritativeGroupSnapshot(work.groupSnapshot);
  if (work.overlayId !== toScopedOverlayId(work.groupSnapshot.group)) {
    throw new TypeError('RTC topology work overlayId differs from group scope');
  }
  if (envelope.contextId !== toRtcTopologyQueueContextId(work.groupSnapshot.group)) {
    throw new TypeError('RTC topology work context differs from group scope');
  }
  validatePersistedRtcTopologyRevision(work);
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
  if (Object.hasOwn(work, COALESCED_APP_OUTBOX_WORK_FIELD)) {
    validateCoalescedWorkMetadata(work[COALESCED_APP_OUTBOX_WORK_FIELD]);
  } else if (work.kind === 'rtt-refresh') {
    throw new TypeError('RTC topology RTT work coalescing metadata is required');
  }
}

function validateCoalescedWorkMetadata(value: WorkBoundaryValue): void {
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
  if (
    !Array.isArray(metadata.reasons) ||
    metadata.reasons.some((reason) => typeof reason !== 'string' || reason.length === 0)
  ) {
    throw new TypeError('RTC topology coalescing reasons are invalid');
  }
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

function requireWorkString(
  value: WorkBoundaryValue,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} is invalid`);
  }
}

function requireWorkInteger(
  value: WorkBoundaryValue,
  label: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} is invalid`);
  }
}
