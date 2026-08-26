import {
    hashRallarCrdtUpdateEnvelope,
    toRallarCrdtDocumentKey,
    type RallarCrdtDebugBundle,
    type RallarCrdtDocumentRef
} from '@shared/crdt/mod.ts';

import {
    requireEpoch,
    requireExactKeys,
    requireExactOptionalKeys,
    requireOneOf,
    requireString
} from '../../protocol/exact-object-decoding.ts';
import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { decodeExactUpdateEnvelope } from './decode-exact-update-envelope.ts';
import { decodeExactDocumentMetadata } from './decoding/decode-exact-document-metadata.ts';
import { decodeExactDocumentRef } from './decoding/decode-exact-document-ref.ts';
import { decodeExactSnapshotEnvelope } from './decoding/decode-exact-snapshot-envelope.ts';
import { decodeExactTrustedAppendMetadata } from './decoding/decode-exact-trusted-append-metadata.ts';
import { requireCrdtJsonWireObject } from './decoding/require-crdt-json-wire-object.ts';

export function decodeExactDebugBundle(value: unknown): RallarCrdtDebugBundle {
    const bundle = requireCrdtJsonWireObject(
        decodeJsonWireValue(value, 'CRDT debug bundle'),
        'CRDT debug bundle'
    );
    validateExactDebugBundle(bundle);
    return bundle;
}

function validateExactDebugBundle(bundle: JsonWireObject): asserts bundle is JsonWireObject & RallarCrdtDebugBundle {
    const fields = bundle;
    requireExactOptionalKeys({
        value: fields,
        required: [
            'format',
            'exportedAtEpochMs',
            'reason',
            'document',
            'documentKey',
            'records',
            'redaction',
            'integrity'
        ],
        optional: ['metadata', 'snapshot', 'health'],
        label: 'CRDT debug bundle'
    });
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
    value: JsonWireValue | undefined,
    document: RallarCrdtDocumentRef
): readonly JsonWireObject[] {
    if (!isJsonWireArray(value)) {
        throw new TypeError('CRDT debug records are invalid');
    }
    const documentKey = toRallarCrdtDocumentKey(document);
    const records: JsonWireObject[] = [];
    for (const item of value) {
        const record = requireCrdtJsonWireObject(item, 'CRDT debug record');
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
        records.push(record);
    }
    return records;
}

function decodeExactRedaction(value: JsonWireValue | undefined): void {
    const redaction = requireCrdtJsonWireObject(value, 'CRDT debug redaction');
    requireExactOptionalKeys({
        value: redaction,
        required: ['payloadsRedacted'],
        optional: ['sensitiveFields', 'reason'],
        label: 'CRDT debug redaction'
    });
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
    value: JsonWireValue | undefined,
    records: readonly JsonWireObject[]
): void {
    const integrity = requireCrdtJsonWireObject(value, 'CRDT debug bundle integrity');
    requireExactOptionalKeys({
        value: integrity,
        required: ['bundleHash', 'documentRefHash', 'updateHashes', 'updateCount', 'sequenceGaps'],
        optional: ['snapshotHash', 'firstAppendSequence', 'lastAppendSequence'],
        label: 'CRDT debug bundle integrity'
    });
    requireString(integrity.bundleHash, 'debug bundle hash');
    requireString(integrity.documentRefHash, 'debug bundle document ref hash');
    if ('snapshotHash' in integrity) {
        requireString(integrity.snapshotHash, 'debug snapshot hash');
    }
    const updateHashes = requireCrdtJsonWireObject(
        integrity.updateHashes,
        'CRDT debug update hashes'
    );
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

function decodeExactHealth(value: JsonWireValue | undefined): void {
    const health = requireCrdtJsonWireObject(value, 'CRDT debug health');
    const required = [
        'replicaId',
        'pendingUpdateCount',
        'failedPendingUpdateCount',
        'dependencyBlockedUpdateCount',
        'seenUpdateCount'
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
        'liveSyncResponseCount'
    ];
    requireExactOptionalKeys({
        value: health,
        required,
        optional,
        label: 'CRDT debug health'
    });
    requireString(health.replicaId, 'CRDT debug health replicaId');
    for (const field of required.slice(1)) {
        requireEpoch(health[field], `CRDT debug health ${field}`);
    }
    for (
        const field of [
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
            'liveSyncResponseCount'
        ]
    ) {
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
            'CRDT transport strategy'
        );
    }
    if ('lastLiveTransport' in health) {
        requireOneOf(health.lastLiveTransport, ['ws', 'rtc'] as const, 'CRDT last live transport');
    }
    if ('lastLiveSendStatus' in health) {
        requireString(health.lastLiveSendStatus, 'CRDT last live send status');
    }
    if ('quota' in health) {
        const quota = requireCrdtJsonWireObject(health.quota, 'CRDT debug health quota');
        requireExactOptionalKeys({
            value: quota,
            required: [],
            optional: ['usageBytes', 'quotaBytes', 'nearingLimit'],
            label: 'health quota'
        });
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

function decodeSequenceList(value: JsonWireValue | undefined, label: string): void {
    if (
        !isJsonWireArray(value) ||
        value.some((item) => !Number.isSafeInteger(item) || Number(item) < 1) ||
        new Set(value).size !== value.length
    ) {
        throw new TypeError(`${label} is invalid`);
    }
}

function isJsonWireArray(
    value: JsonWireValue | undefined
): value is readonly JsonWireValue[] {
    return Array.isArray(value);
}
