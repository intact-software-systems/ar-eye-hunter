import {
  hashRallarCrdtUpdateEnvelope,
  type RallarCrdtDebugBundle,
  type RallarCrdtDocumentRef,
  toRallarCrdtDocumentKey,
} from '@shared/crdt/mod.ts';
import {
  requireEpoch,
  requireExactKeys,
  requireExactOptionalKeys,
  requireOneOf,
  requireRecord,
  requireString,
} from '../../services/exact-object-codec.ts';
import {
  decodeExactDocumentMetadata,
  decodeExactDocumentRef,
  decodeExactSnapshotEnvelope,
  decodeExactTrustedAppendMetadata,
} from './crdt-mutation-value-codec.ts';
import { decodeExactUpdateEnvelope } from './crdt-update-exact-codec.ts';

export function decodeExactDebugBundle(value: unknown): RallarCrdtDebugBundle {
  const bundle = requireRecord(value, 'CRDT debug bundle');
  requireExactOptionalKeys(
    bundle,
    [
      'format',
      'exportedAtEpochMs',
      'reason',
      'document',
      'documentKey',
      'records',
      'redaction',
      'integrity',
    ],
    ['metadata', 'snapshot', 'health'],
    'CRDT debug bundle',
  );
  if (bundle.format !== 'rallar.crdt.debug-bundle.v1') {
    throw new TypeError('CRDT debug bundle format is invalid');
  }
  requireEpoch(bundle.exportedAtEpochMs, 'debug bundle exportedAtEpochMs');
  requireString(bundle.reason, 'debug bundle reason');
  const document = decodeExactDocumentRef(bundle.document, 'CRDT debug bundle document');
  requireString(bundle.documentKey, 'debug bundle documentKey');
  if (bundle.documentKey !== toRallarCrdtDocumentKey(document)) {
    throw new TypeError('CRDT debug bundle document key differs from document');
  }
  if ('metadata' in bundle) decodeExactDocumentMetadata(bundle.metadata);
  if ('snapshot' in bundle) decodeExactSnapshotEnvelope(bundle.snapshot);
  const records = decodeExactRecords(bundle.records, document);
  decodeExactRedaction(bundle.redaction);
  if ('health' in bundle) decodeExactHealth(bundle.health);
  decodeExactBundleIntegrity(bundle.integrity, records);
  return bundle as unknown as RallarCrdtDebugBundle;
}

function decodeExactRecords(
  value: unknown,
  document: RallarCrdtDocumentRef,
): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new TypeError('CRDT debug records are invalid');
  const documentKey = toRallarCrdtDocumentKey(document);
  return value.map((item) => {
    const record = requireRecord(item, 'CRDT debug record');
    requireExactKeys(record, ['document', 'documentKey', 'update', 'append'], 'CRDT debug record');
    const recordDocument = decodeExactDocumentRef(record.document, 'CRDT debug record document');
    const update = decodeExactUpdateEnvelope(record.update);
    const append = decodeExactTrustedAppendMetadata(record.append);
    if (
      record.documentKey !== documentKey ||
      toRallarCrdtDocumentKey(recordDocument) !== documentKey ||
      toRallarCrdtDocumentKey(update.document) !== documentKey ||
      append.acceptedUpdateHash !== hashRallarCrdtUpdateEnvelope(update)
    )
      throw new TypeError('CRDT debug record identity is invalid');
    return record;
  });
}

function decodeExactRedaction(value: unknown): void {
  const redaction = requireRecord(value, 'CRDT debug redaction');
  requireExactOptionalKeys(
    redaction,
    ['payloadsRedacted'],
    ['sensitiveFields', 'reason'],
    'CRDT debug redaction',
  );
  if (typeof redaction.payloadsRedacted !== 'boolean') {
    throw new TypeError('CRDT debug redaction flag is invalid');
  }
  if (
    'sensitiveFields' in redaction &&
    (!Array.isArray(redaction.sensitiveFields) ||
      redaction.sensitiveFields.some((field) => typeof field !== 'string' || !field))
  )
    throw new TypeError('CRDT debug sensitive fields are invalid');
  if ('reason' in redaction) requireString(redaction.reason, 'CRDT debug redaction reason');
}

function decodeExactBundleIntegrity(
  value: unknown,
  records: readonly Record<string, unknown>[],
): void {
  const integrity = requireRecord(value, 'CRDT debug bundle integrity');
  requireExactOptionalKeys(
    integrity,
    ['bundleHash', 'documentRefHash', 'updateHashes', 'updateCount', 'sequenceGaps'],
    ['snapshotHash', 'firstAppendSequence', 'lastAppendSequence'],
    'CRDT debug bundle integrity',
  );
  requireString(integrity.bundleHash, 'debug bundle hash');
  requireString(integrity.documentRefHash, 'debug bundle document ref hash');
  if ('snapshotHash' in integrity) requireString(integrity.snapshotHash, 'debug snapshot hash');
  const updateHashes = requireRecord(integrity.updateHashes, 'CRDT debug update hashes');
  for (const hash of Object.values(updateHashes)) requireString(hash, 'CRDT debug update hash');
  requireEpoch(integrity.updateCount, 'debug update count');
  if (integrity.updateCount !== records.length) {
    throw new TypeError('CRDT debug update count differs from records');
  }
  decodeSequenceList(integrity.sequenceGaps, 'CRDT debug sequence gaps');
  if ('firstAppendSequence' in integrity) {
    requireEpoch(integrity.firstAppendSequence, 'debug first append sequence');
  }
  if ('lastAppendSequence' in integrity) {
    requireEpoch(integrity.lastAppendSequence, 'debug last append sequence');
  }
}

function decodeExactHealth(value: unknown): void {
  const health = requireRecord(value, 'CRDT debug health');
  const required = [
    'replicaId',
    'pendingUpdateCount',
    'failedPendingUpdateCount',
    'dependencyBlockedUpdateCount',
    'seenUpdateCount',
  ];
  const optional = [
    'lastServerAppendSequence',
    'lastServerAckAtEpochMs',
    'lastSyncError',
    'snapshotAgeMs',
    'updateLogLag',
    'quota',
    'replayDurationMs',
    'corruptLocalArtifactCount',
    'transportStrategy',
    'lastLiveTransport',
    'lastLiveSendStatus',
    'liveSentUpdateCount',
    'liveReceivedUpdateCount',
    'liveDuplicateUpdateCount',
    'liveRejectedUpdateCount',
    'liveDependencyBlockedUpdateCount',
    'liveRetriedUpdateCount',
    'liveSyncRequestCount',
    'liveSyncResponseCount',
  ];
  requireExactOptionalKeys(health, required, optional, 'CRDT debug health');
  requireString(health.replicaId, 'CRDT debug health replicaId');
  for (const field of required.slice(1)) requireEpoch(health[field], `CRDT debug health ${field}`);
  if ('lastLiveTransport' in health) {
    requireOneOf(health.lastLiveTransport, ['ws', 'rtc'] as const, 'CRDT last live transport');
  }
  if ('quota' in health) {
    const quota = requireRecord(health.quota, 'CRDT debug health quota');
    requireExactOptionalKeys(
      quota,
      [],
      ['usageBytes', 'quotaBytes', 'nearingLimit'],
      'health quota',
    );
  }
}

function decodeSequenceList(value: unknown, label: string): void {
  if (
    !Array.isArray(value) ||
    value.some((item) => !Number.isSafeInteger(item) || item < 1) ||
    new Set(value).size !== value.length
  )
    throw new TypeError(`${label} is invalid`);
}
