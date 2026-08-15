import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { JsonWireValue } from '../../services/mutation-command-identity.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/RuntimeStateJsonStore.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/RuntimeStateRepository.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '../../rtc-topology-errors.ts';
import type {
  RtcRttEndpointAdmission,
  RtcRttMutationReceipt,
} from './rtc-rtt-persistence-contracts.ts';
import {
  validateRtcRttEndpointAdmission,
  validateRtcRttEndpointAdmissionPersistedVersion,
  validateRtcRttMeasurement,
  validateRtcRttMutationReceipt,
} from './rtc-rtt-persistence-validation.ts';
import {
  decodeRtcRttEndpointAdmissionStorageKey,
  decodeRtcRttMeasurementStorageKey,
  sortRtcRttSessionPair,
} from './rtc-rtt-storage-keys.ts';

interface ReadLiveRtcRttMeasurementEntryInput {
  readonly entry: RuntimeStateEntry;
  readonly nowEpochMs: number;
  readonly trustedSessionIdA?: string;
  readonly trustedSessionIdB?: string;
}

export function readLiveRtcRttMeasurementEntry(
  input: ReadLiveRtcRttMeasurementEntryInput,
): RuntimeStateEntryValue<RttMeasurementInfo> | undefined {
  const { entry, nowEpochMs, trustedSessionIdA, trustedSessionIdB } = input;
  const decoded = decodeRtcRttMeasurementStorageKey(entry.key);
  if (trustedSessionIdA !== undefined && trustedSessionIdB !== undefined) {
    const trusted = sortRtcRttSessionPair(trustedSessionIdA, trustedSessionIdB);
    if (decoded[0] !== trusted[0] || decoded[1] !== trusted[1]) {
      throw rttCorruption(entry.key, 'RTC RTT key differs from requested pair');
    }
  }
  const value = parseValue(entry) as RttMeasurementInfo;
  try {
    validateRtcRttMeasurement(value);
  } catch (error) {
    throw rttCorruption(
      entry.key,
      error instanceof Error ? error.message : 'RTC RTT value is invalid',
    );
  }
  const storedPair = sortRtcRttSessionPair(value.sessionIdFrom, value.sessionIdTo);
  if (storedPair[0] !== decoded[0] || storedPair[1] !== decoded[1]) {
    throw rttCorruption(entry.key, 'RTC RTT value differs from physical pair');
  }
  return liveEntry(entry, value, nowEpochMs);
}

export function readLiveRtcRttEndpointAdmissionEntry(
  entry: RuntimeStateEntry,
  nowEpochMs: number,
  trustedEndpointId?: string,
): RuntimeStateEntryValue<RtcRttEndpointAdmission> | undefined {
  const endpointId = decodeRtcRttEndpointAdmissionStorageKey(entry.key);
  if (trustedEndpointId !== undefined && endpointId !== trustedEndpointId) {
    throw rttCorruption(entry.key, 'RTC RTT endpoint differs from requested slot');
  }
  const value = parseValue(entry) as RtcRttEndpointAdmission;
  try {
    validateRtcRttEndpointAdmission(value, endpointId, entry.expireAtTimestamp);
    validateRtcRttEndpointAdmissionPersistedVersion(value.version, entry.revision);
  } catch (error) {
    throw rttCorruption(
      entry.key,
      error instanceof Error ? error.message : 'RTC RTT admission is invalid',
    );
  }
  return liveEntry(entry, value, nowEpochMs);
}

export function readLiveRtcRttReceiptEntry(
  entry: RuntimeStateEntry,
  nowEpochMs: number,
  trustedReceiptId?: string,
): RuntimeStateEntryValue<RtcRttMutationReceipt> | undefined {
  const receipt = readRtcRttReceiptEntry(entry, trustedReceiptId);
  return entry.expireAtTimestamp > nowEpochMs ? receipt : undefined;
}

export function readRtcRttReceiptEntry(
  entry: RuntimeStateEntry,
  trustedReceiptId?: string,
): RuntimeStateEntryValue<RtcRttMutationReceipt> {
  if (trustedReceiptId !== undefined && entry.key !== trustedReceiptId) {
    throw rttCorruption(entry.key, 'RTC RTT receipt differs from trusted slot');
  }
  let value: RtcRttMutationReceipt;
  try {
    value = parseValue(entry) as RtcRttMutationReceipt;
    validateRtcRttMutationReceipt(value, entry.expireAtTimestamp);
  } catch (error) {
    throw rttCorruption(entry.key, error instanceof Error ? error.message : 'Invalid RTT receipt');
  }
  if (value.receiptId !== entry.key) {
    throw rttCorruption(entry.key, 'RTC RTT receipt differs from physical key');
  }
  return { entry, value };
}

function liveEntry<T>(
  entry: RuntimeStateEntry,
  value: T,
  nowEpochMs: number,
): RuntimeStateEntryValue<T> | undefined {
  return entry.expireAtTimestamp > nowEpochMs ? { entry, value } : undefined;
}

function parseValue(entry: RuntimeStateEntry): JsonWireValue {
  try {
    return JSON.parse(entry.value) as JsonWireValue;
  } catch (error) {
    throw rttCorruption(
      entry.key,
      error instanceof Error ? error.message : 'RTC RTT JSON is invalid',
    );
  }
}

function rttCorruption(
  storageKey: string,
  message: string,
): RtcTopologyRepositoryInvariantCorruptionError {
  return new RtcTopologyRepositoryInvariantCorruptionError(storageKey, message);
}
