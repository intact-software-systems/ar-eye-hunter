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
import { decodeExactUpdateEnvelope } from './decode-exact-update-envelope.ts';

export function decodeExactDebugBundle(value: unknown): RallarCrdtDebugBundle {
  const bundle = requireRecord(value, 'CRDT debug bundle');
  validateExactDebugBundle(bundle);
  return bundle;
}

function validateExactDebugBundle(bundle: object): asserts bundle is RallarCrdtDebugBundle {
  const fields = requireRecord(bundle, 'CRDT debug bundle');
  requireExactOptionalKeys(
    fields,
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
  if (fields.format !== 'rallar.crdt.debug-bundle.v1') {
    throw new TypeError('CRDT debug bundle format is invalid');
  }
  requireEpoch(fields.exportedAtEpochMs, 'debug bundle exportedAtEpochMs');
  requireString(fields.reason, 'debug bundle reason');
  const document = decodeExactDocumentRef(fields.document, 'CRDT debug bundle document');
  requireString(fields.documentKey, 'debug bundle documentKey');
  if (fields.documentKey !== toRallarCrdtDocumentKey(document)) {
    throw new TypeError('CRDT debug bundle document key differs from document');
  }
  if ('metadata' in fields) {
    decodeExactDocumentMetadata(fields.metadata);
  }
  if ('snapshot' in fields) {
    decodeExactSnapshotEnvelope(fields.snapshot);
  }
  const records = decodeExactRecords(fields.records, document);
  decodeExactRedaction(fields.redaction);
  if ('health' in fields) {
    decodeExactHealth(fields.health);
  }
  decodeExactBundleIntegrity(fields.integrity, records);
}

function decodeExactRecords(
  value: unknown,
  document: RallarCrdtDocumentRef,
): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new TypeError('CRDT debug records are invalid');
  }
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
    ) {
      throw new TypeError('CRDT debug record identity is invalid');
    }
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
  ) {
    throw new TypeError('CRDT debug sensitive fields are invalid');
  }
  if ('reason' in redaction) {
    requireString(redaction.reason, 'CRDT debug redaction reason');
  }
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
  if ('snapshotHash' in integrity) {
    requireString(integrity.snapshotHash, 'debug snapshot hash');
  }
  const updateHashes = requireRecord(integrity.updateHashes, 'CRDT debug update hashes');
  for (const hash of Object.values(updateHashes)) {
    requireString(hash, 'CRDT debug update hash');
  }
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
  for (const field of required.slice(1)) {
    requireEpoch(health[field], `CRDT debug health ${field}`);
  }
  for (const field of [
    'lastServerAppendSequence',
    'lastServerAckAtEpochMs',
    'snapshotAgeMs',
    'updateLogLag',
    'replayDurationMs',
    'corruptLocalArtifactCount',
    'liveSentUpdateCount',
    'liveReceivedUpdateCount',
    'liveDuplicateUpdateCount',
    'liveRejectedUpdateCount',
    'liveDependencyBlockedUpdateCount',
    'liveRetriedUpdateCount',
    'liveSyncRequestCount',
    'liveSyncResponseCount',
  ]) {
    if (field in health) {
      requireEpoch(health[field], `CRDT debug health ${field}`);
    }
  }
  if ('lastSyncError' in health) {
    requireString(health.lastSyncError, 'CRDT last sync error');
  }
  if ('transportStrategy' in health) {
    requireOneOf(
      health.transportStrategy,
      ['local-only', 'ws', 'rtc', 'ws-then-rtc', 'rtc-with-ws-fallback'] as const,
      'CRDT transport strategy',
    );
  }
  if ('lastLiveTransport' in health) {
    requireOneOf(health.lastLiveTransport, ['ws', 'rtc'] as const, 'CRDT last live transport');
  }
  if ('lastLiveSendStatus' in health) {
    requireString(health.lastLiveSendStatus, 'CRDT last live send status');
  }
  if ('quota' in health) {
    const quota = requireRecord(health.quota, 'CRDT debug health quota');
    requireExactOptionalKeys(
      quota,
      [],
      ['usageBytes', 'quotaBytes', 'nearingLimit'],
      'health quota',
    );
    if ('usageBytes' in quota) {
      requireEpoch(quota.usageBytes, 'CRDT health quota usageBytes');
    }
    if ('quotaBytes' in quota) {
      requireEpoch(quota.quotaBytes, 'CRDT health quota quotaBytes');
    }
    if ('nearingLimit' in quota && typeof quota.nearingLimit !== 'boolean') {
      throw new TypeError('CRDT health quota nearingLimit is invalid');
    }
  }
}

function decodeSequenceList(value: unknown, label: string): void {
  if (
    !Array.isArray(value) ||
    value.some((item) => !Number.isSafeInteger(item) || item < 1) ||
    new Set(value).size !== value.length
  ) {
    throw new TypeError(`${label} is invalid`);
  }
}
