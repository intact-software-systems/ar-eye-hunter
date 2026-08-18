const schema = 'rallar.rtc-baseline.writer-lock.v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type MetadataJsonValue =
  null | boolean | number | string | readonly MetadataJsonValue[] | MetadataJsonObject;

interface MetadataJsonObject {
  readonly [key: string]: MetadataJsonValue;
}

interface OwnerFields {
  readonly ownerToken: string;
  readonly hostname: string;
  readonly processId: number;
  readonly createdAtUtc: string;
}

export interface RtcBaselineOwnedWriterLockMetadata {
  readonly schema: typeof schema;
  readonly state: 'owned';
  readonly ownerToken: string;
  readonly hostname: string;
  readonly processId: number;
  readonly createdAtUtc: string;
}

interface RtcBaselineReleasedWriterLockMetadata {
  readonly schema: typeof schema;
  readonly state: 'released';
  readonly ownerToken: string;
  readonly hostname: string;
  readonly processId: number;
  readonly createdAtUtc: string;
  readonly releasedAtUtc: string;
}

export type RtcBaselineWriterLockMetadata =
  | RtcBaselineOwnedWriterLockMetadata
  | RtcBaselineReleasedWriterLockMetadata;

function isMetadataJsonObject(value: MetadataJsonValue): value is MetadataJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUtcTimestamp(value: MetadataJsonValue): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function hasOwnerFields(value: MetadataJsonObject): value is MetadataJsonObject & OwnerFields {
  return (
    typeof value.ownerToken === 'string' &&
    value.ownerToken.length > 0 &&
    typeof value.hostname === 'string' &&
    value.hostname.length > 0 &&
    Number.isSafeInteger(value.processId) &&
    Number(value.processId) > 0 &&
    isUtcTimestamp(value.createdAtUtc)
  );
}

function hasOnlyKeys(value: MetadataJsonObject, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function decodeRtcBaselineWriterLockMetadata(
  bytes: Uint8Array,
): RtcBaselineWriterLockMetadata | null {
  let value: MetadataJsonValue;
  try {
    value = JSON.parse(decoder.decode(bytes)) as MetadataJsonValue;
  } catch {
    return null;
  }
  if (!isMetadataJsonObject(value) || value.schema !== schema || !hasOwnerFields(value)) {
    return null;
  }
  if (value.state === 'owned') {
    const keys = ['createdAtUtc', 'hostname', 'ownerToken', 'processId', 'schema', 'state'];
    return hasOnlyKeys(value, keys)
      ? {
          schema,
          state: 'owned',
          ownerToken: value.ownerToken,
          hostname: value.hostname,
          processId: value.processId,
          createdAtUtc: value.createdAtUtc,
        }
      : null;
  }
  if (value.state === 'released') {
    const keys = [
      'createdAtUtc',
      'hostname',
      'ownerToken',
      'processId',
      'releasedAtUtc',
      'schema',
      'state',
    ];
    if (!hasOnlyKeys(value, keys) || !isUtcTimestamp(value.releasedAtUtc)) return null;
    return {
      schema,
      state: 'released',
      ownerToken: value.ownerToken,
      hostname: value.hostname,
      processId: value.processId,
      createdAtUtc: value.createdAtUtc,
      releasedAtUtc: value.releasedAtUtc,
    };
  }
  return null;
}

export function encodeRtcBaselineWriterLockMetadata(
  metadata: RtcBaselineWriterLockMetadata,
): Uint8Array {
  return encoder.encode(`${JSON.stringify(metadata)}\n`);
}

export function createRtcBaselineOwnedWriterLockMetadata(input: {
  readonly ownerToken: string;
  readonly hostname: string;
  readonly processId: number;
  readonly createdAtUtc: string;
}): RtcBaselineOwnedWriterLockMetadata {
  return {
    schema,
    state: 'owned',
    ownerToken: input.ownerToken,
    hostname: input.hostname,
    processId: input.processId,
    createdAtUtc: input.createdAtUtc,
  };
}
