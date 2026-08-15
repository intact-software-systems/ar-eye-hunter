import { RtcTopologyRepositoryInvariantCorruptionError } from '../../rtc-topology-errors.ts';
import { compareRtcTopologyIdentifiers } from '../../rtc-topology-identifiers.ts';

export function toRtcRttMeasurementStorageKey(left: string, right: string): string {
  const [from, to] = sortRtcRttSessionPair(left, right);
  return `from=${encodeURIComponent(from)}:to=${encodeURIComponent(to)}`;
}

export function decodeRtcRttMeasurementStorageKey(storageKey: string): readonly [string, string] {
  const parts = storageKey.split(':');
  if (parts.length !== 2 || !parts[0]!.startsWith('from=') || !parts[1]!.startsWith('to=')) {
    throw storageKeyCorruption(storageKey, 'RTC RTT measurement key has invalid shape');
  }
  let from: string;
  let to: string;
  try {
    from = decodeURIComponent(parts[0]!.slice('from='.length));
    to = decodeURIComponent(parts[1]!.slice('to='.length));
  } catch {
    throw storageKeyCorruption(storageKey, 'RTC RTT measurement key encoding is invalid');
  }
  if (
    from.length === 0 ||
    to.length === 0 ||
    compareRtcTopologyIdentifiers(from, to) >= 0 ||
    toRtcRttMeasurementStorageKey(from, to) !== storageKey
  ) {
    throw storageKeyCorruption(storageKey, 'RTC RTT measurement key is not canonical');
  }
  return [from, to];
}

export function toRtcRttEndpointAdmissionStorageKey(endpointId: string): string {
  return `endpoint=${encodeURIComponent(endpointId)}`;
}

export function decodeRtcRttEndpointAdmissionStorageKey(storageKey: string): string {
  if (!storageKey.startsWith('endpoint=')) {
    throw storageKeyCorruption(storageKey, 'RTC RTT endpoint key has invalid shape');
  }
  let endpointId: string;
  try {
    endpointId = decodeURIComponent(storageKey.slice('endpoint='.length));
  } catch {
    throw storageKeyCorruption(storageKey, 'RTC RTT endpoint key encoding is invalid');
  }
  if (endpointId.length === 0 || toRtcRttEndpointAdmissionStorageKey(endpointId) !== storageKey) {
    throw storageKeyCorruption(storageKey, 'RTC RTT endpoint key is not canonical');
  }
  return endpointId;
}

export function sortRtcRttSessionPair(left: string, right: string): readonly [string, string] {
  return compareRtcTopologyIdentifiers(left, right) <= 0 ? [left, right] : [right, left];
}

function storageKeyCorruption(
  storageKey: string,
  message: string,
): RtcTopologyRepositoryInvariantCorruptionError {
  return new RtcTopologyRepositoryInvariantCorruptionError(storageKey, message);
}
