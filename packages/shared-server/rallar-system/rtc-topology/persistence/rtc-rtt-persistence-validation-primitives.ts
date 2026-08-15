import { compareRtcTopologyIdentifiers } from '../../rtc-topology-identifiers.ts';
import { rtcTopologySemanticEqual } from '../../rtc-topology-semantic-equality.ts';

export const RTC_RTT_MUTATION_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_RTC_RTT_MUTATION_RETENTION_MS = RTC_RTT_MUTATION_RETENTION_MS;

export function readRtcRttPersistedRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

export function assertExactRtcRttPersistedKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value).sort(compareRtcTopologyIdentifiers);
  const canonical = [...expected].sort(compareRtcTopologyIdentifiers);
  if (!rtcTopologySemanticEqual(keys, canonical)) {
    throw new TypeError('RTC RTT persisted fields are invalid');
  }
}

export function assertNonEmptyRtcRttString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`RTC RTT ${label} is invalid`);
  }
}

export function assertRtcRttSafeInteger(value: unknown, minimum: number, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`RTC RTT ${label} is invalid`);
  }
}

export function validateRtcRttCommandHash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new TypeError('RTC RTT command hash is invalid');
  }
}

export function validateRtcRttFamilyExpiry(
  acceptedAtEpochMs: number,
  physicalExpiry: number,
  authority: string,
): void {
  const expectedExpiry = acceptedAtEpochMs + RTC_RTT_MUTATION_RETENTION_MS;
  if (!Number.isSafeInteger(expectedExpiry)) {
    throw new TypeError(`RTC RTT ${authority} physical expiry overflows retention`);
  }
  if (physicalExpiry !== expectedExpiry) {
    throw new TypeError(`RTC RTT ${authority} physical expiry differs from exact retention`);
  }
}
