import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
  compareRtcTopologyIdentifiers,
  toCanonicalRtcTopologyGroupIdentity,
} from '../../rtc-topology-identifiers.ts';
import { toRtcRttMutationReceiptId } from '../mutation/rtc-rtt-mutation-identifiers.ts';
import {
  assertExactRtcRttPersistedKeys,
  assertNonEmptyRtcRttString,
  assertRtcRttSafeInteger,
  readRtcRttPersistedRecord,
  validateRtcRttCommandHash,
  validateRtcRttFamilyExpiry,
} from './rtc-rtt-persistence-validation-primitives.ts';

export {
  DEFAULT_RTC_RTT_MUTATION_RETENTION_MS,
  RTC_RTT_MUTATION_RETENTION_MS,
} from './rtc-rtt-persistence-validation-primitives.ts';

type RtcRttMutationReceiptContract = Readonly<{
  receiptId: string;
  commandId: string;
  requestId: string;
  sessionIdFrom: string;
  sessionIdTo: string;
  aggregateRef: Readonly<{ sessionIdFrom: string; sessionIdTo: string }>;
  measurementVersion: number;
  affectedGroupRefs: readonly GroupRef[];
  acceptedAtEpochMs: number;
  outcome: 'accepted';
  attemptCount: number;
  acceptedStorageRevision: number;
  eventId: null;
  outboxIds: readonly string[];
  commandHash: string;
}>;

type RtcRttEndpointAdmissionContract = Readonly<{
  endpointId: string;
  peers: readonly Readonly<{
    peerSessionId: string;
    expiresAtEpochMs: number;
  }>[];
  version: number;
  updatedAtEpochMs: number;
}>;

export function validateRtcRttMutationReceipt(
  value: unknown,
  physicalExpiry?: number,
): asserts value is RtcRttMutationReceiptContract {
  const receipt = readRtcRttPersistedRecord(value, 'RTC RTT receipt');
  assertExactRtcRttPersistedKeys(receipt, [
    'receiptId',
    'commandId',
    'requestId',
    'sessionIdFrom',
    'sessionIdTo',
    'aggregateRef',
    'measurementVersion',
    'affectedGroupRefs',
    'acceptedAtEpochMs',
    'outcome',
    'attemptCount',
    'acceptedStorageRevision',
    'eventId',
    'outboxIds',
    'commandHash',
  ]);
  assertNonEmptyRtcRttString(receipt.receiptId, 'receipt id');
  assertNonEmptyRtcRttString(receipt.commandId, 'receipt command id');
  assertNonEmptyRtcRttString(receipt.requestId, 'receipt request id');
  assertNonEmptyRtcRttString(receipt.sessionIdFrom, 'receipt source session');
  assertNonEmptyRtcRttString(receipt.sessionIdTo, 'receipt target session');
  if (receipt.sessionIdFrom === receipt.sessionIdTo) {
    throw new TypeError('RTC RTT receipt pair is invalid');
  }
  const aggregateRef = readRtcRttPersistedRecord(receipt.aggregateRef, 'receipt aggregate ref');
  assertExactRtcRttPersistedKeys(aggregateRef, ['sessionIdFrom', 'sessionIdTo']);
  if (
    aggregateRef.sessionIdFrom !== receipt.sessionIdFrom ||
    aggregateRef.sessionIdTo !== receipt.sessionIdTo
  ) {
    throw new TypeError('RTC RTT receipt aggregate ref is invalid');
  }
  assertRtcRttSafeInteger(receipt.measurementVersion, 1, 'receipt measurement version');
  assertRtcRttSafeInteger(receipt.acceptedAtEpochMs, 0, 'receipt accepted time');
  if (receipt.outcome !== 'accepted') {
    throw new TypeError('RTC RTT receipt outcome is invalid');
  }
  assertRtcRttSafeInteger(receipt.attemptCount, 1, 'receipt attempt count');
  assertRtcRttSafeInteger(receipt.acceptedStorageRevision, 0, 'receipt accepted storage revision');
  if (receipt.eventId !== null) {
    throw new TypeError('RTC RTT receipt event id must be null');
  }
  if (
    !Array.isArray(receipt.outboxIds) ||
    receipt.outboxIds.some((outboxId) => typeof outboxId !== 'string' || outboxId.length === 0)
  ) {
    throw new TypeError('RTC RTT receipt outbox ids are invalid');
  }
  validateRtcRttCommandHash(receipt.commandHash);
  if (
    receipt.commandId !== receipt.receiptId ||
    receipt.requestId !== receipt.receiptId ||
    receipt.receiptId !==
      toRtcRttMutationReceiptId({
        sessionIdFrom: receipt.sessionIdFrom as string,
        sessionIdTo: receipt.sessionIdTo as string,
        version: receipt.measurementVersion as number,
      })
  ) {
    throw new TypeError('RTC RTT receipt identity is invalid');
  }
  if (!Array.isArray(receipt.affectedGroupRefs) || receipt.affectedGroupRefs.length === 0) {
    throw new TypeError('RTC RTT receipt affected group refs are invalid');
  }
  let previousIdentity: string | undefined;
  for (const valueRef of receipt.affectedGroupRefs) {
    validateCanonicalGroupRef(valueRef);
    const identity = toCanonicalRtcTopologyGroupIdentity(valueRef);
    if (
      previousIdentity !== undefined &&
      compareRtcTopologyIdentifiers(previousIdentity, identity) >= 0
    ) {
      throw new TypeError('RTC RTT receipt affected group refs are not canonical');
    }
    previousIdentity = identity;
  }
  if (physicalExpiry !== undefined) {
    validateRtcRttFamilyExpiry(receipt.acceptedAtEpochMs as number, physicalExpiry, 'receipt');
  }
}

export function validateRtcRttMeasurement(value: unknown): asserts value is RttMeasurementInfo {
  const measurement = readRtcRttPersistedRecord(value, 'RTC RTT measurement');
  assertExactRtcRttPersistedKeys(measurement, [
    'sessionIdFrom',
    'sessionIdTo',
    'rttMs',
    'createdAtEpochMs',
    'version',
  ]);
  assertNonEmptyRtcRttString(measurement.sessionIdFrom, 'measurement source session');
  assertNonEmptyRtcRttString(measurement.sessionIdTo, 'measurement target session');
  if (measurement.sessionIdFrom === measurement.sessionIdTo) {
    throw new TypeError('RTC RTT measurement pair is invalid');
  }
  if (
    typeof measurement.rttMs !== 'number' ||
    !Number.isFinite(measurement.rttMs) ||
    measurement.rttMs <= 0
  ) {
    throw new TypeError('RTC RTT measurement duration is invalid');
  }
  assertRtcRttSafeInteger(measurement.createdAtEpochMs, 0, 'measurement creation time');
  assertRtcRttSafeInteger(measurement.version, 1, 'measurement version');
}

export function validateRtcRttEndpointAdmission(
  value: unknown,
  expectedEndpointId: string,
  physicalExpiry: number,
): asserts value is RtcRttEndpointAdmissionContract {
  const admission = readRtcRttPersistedRecord(value, 'RTC RTT endpoint admission');
  assertExactRtcRttPersistedKeys(admission, ['endpointId', 'peers', 'version', 'updatedAtEpochMs']);
  if (admission.endpointId !== expectedEndpointId) {
    throw new TypeError('RTC RTT endpoint admission identity is invalid');
  }
  assertRtcRttSafeInteger(admission.version, 1, 'endpoint admission version');
  assertRtcRttSafeInteger(admission.updatedAtEpochMs, 0, 'endpoint admission update time');
  if (!Array.isArray(admission.peers) || admission.peers.length === 0) {
    throw new TypeError('RTC RTT endpoint admission peers are invalid');
  }
  let previous: string | undefined;
  let latestExpiry = 0;
  for (const rawPeer of admission.peers) {
    const peer = readRtcRttPersistedRecord(rawPeer, 'RTC RTT endpoint peer');
    assertExactRtcRttPersistedKeys(peer, ['peerSessionId', 'expiresAtEpochMs']);
    assertNonEmptyRtcRttString(peer.peerSessionId, 'endpoint peer id');
    assertRtcRttSafeInteger(
      peer.expiresAtEpochMs,
      (admission.updatedAtEpochMs as number) + 1,
      'endpoint peer expiry',
    );
    if (
      peer.peerSessionId === expectedEndpointId ||
      (previous !== undefined && compareRtcTopologyIdentifiers(previous, peer.peerSessionId) >= 0)
    ) {
      throw new TypeError('RTC RTT endpoint peers are not canonical');
    }
    previous = peer.peerSessionId;
    latestExpiry = Math.max(latestExpiry, peer.expiresAtEpochMs as number);
  }
  if (physicalExpiry !== latestExpiry) {
    throw new TypeError('RTC RTT endpoint physical expiry differs from leases');
  }
}

export function validateRtcRttEndpointAdmissionCandidateVersion(
  domainVersion: number,
  expectedRevision: number | null,
): void {
  assertRtcRttSafeInteger(domainVersion, 1, 'endpoint admission version');
  validateExpectedRevision(expectedRevision, 'endpoint');
  const requiredVersion = expectedRevision === null ? 1 : expectedRevision + 2;
  if (!Number.isSafeInteger(requiredVersion) || domainVersion !== requiredVersion) {
    throw new TypeError('RTC RTT endpoint admission version differs from storage guard');
  }
}

export function validateRtcRttEndpointAdmissionPersistedVersion(
  domainVersion: number,
  storageRevision: number,
): void {
  assertRtcRttSafeInteger(domainVersion, 1, 'endpoint admission version');
  if (
    !Number.isSafeInteger(storageRevision) ||
    Object.is(storageRevision, -0) ||
    storageRevision < 0
  ) {
    throw new TypeError('RTC RTT endpoint storage revision is invalid');
  }
  const requiredVersion = storageRevision + 1;
  if (!Number.isSafeInteger(requiredVersion) || domainVersion !== requiredVersion) {
    throw new TypeError('RTC RTT persisted endpoint version differs from storage revision');
  }
}

function validateCanonicalGroupRef(value: unknown): asserts value is GroupRef {
  const ref = readRtcRttPersistedRecord(value, 'RTC RTT receipt group ref');
  assertExactRtcRttPersistedKeys(
    ref,
    ref.workspaceId === undefined
      ? ['applicationId', 'groupId']
      : ['applicationId', 'workspaceId', 'groupId'],
  );
  assertNonEmptyRtcRttString(ref.applicationId, 'group application id');
  assertNonEmptyRtcRttString(ref.groupId, 'group id');
  if (ref.workspaceId !== undefined) {
    assertNonEmptyRtcRttString(ref.workspaceId, 'group workspace id');
  }
}

function validateExpectedRevision(
  value: unknown,
  authority: string,
): asserts value is number | null {
  if (value === null) return;
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    (value as number) < 0 ||
    (value as number) >= Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError(`RTC RTT ${authority} expected revision is invalid`);
  }
}
