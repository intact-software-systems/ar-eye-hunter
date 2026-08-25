import {
    toRallarCrdtDocumentKey,
    type RallarCrdtDocumentMetadata,
    type RallarCrdtDocumentRef,
    type RallarCrdtQuotaPolicy,
    type RallarCrdtRetentionPolicy
} from '@shared/crdt/mod.ts';

import { requireOneOf } from '../../../protocol/exact-object-decoding.ts';
import { decodeJsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { decodeExactDocumentMetadata } from '../../mutation/decoding/decode-exact-document-metadata.ts';
import { decodeExactDocumentRef } from '../../mutation/decoding/decode-exact-document-ref.ts';
import { decodeExactProjectionIds } from '../../mutation/decoding/decode-exact-projection-ids.ts';
import { decodeExactQuotaPolicy } from '../../mutation/decoding/decode-exact-quota-policy.ts';
import { decodeExactRetentionPolicy } from '../../mutation/decoding/decode-exact-retention-policy.ts';
import { decodeCrdtRowJson } from './decode-crdt-row-json.ts';

export interface CrdtDocumentRow {
    readonly document_key: string;
    readonly application_id: string;
    readonly workspace_id: string | null;
    readonly document_scope: string;
    readonly document_type: string;
    readonly document_id: string;
    readonly document_ref: string;
    readonly document_revision: number | string;
    readonly lifecycle: string;
    readonly created_at_ts: Date | string;
    readonly updated_at_ts: Date | string;
    readonly archived_at_ts: Date | string | null;
    readonly destroyed_at_ts: Date | string | null;
    readonly last_append_sequence: number | string;
    readonly update_count: number | string;
    readonly snapshot_count: number | string;
    readonly stored_update_bytes: number | string;
    readonly retention_policy: string | null;
    readonly quota_policy: string | null;
    readonly projection_ids: string | null;
}

export interface DecodeCrdtDocumentRowInput {
    readonly row: CrdtDocumentRow;
    readonly expectedDocumentKey: string;
    readonly expectedDocument: RallarCrdtDocumentRef;
}

export function decodeCrdtDocumentRow(
    input: DecodeCrdtDocumentRowInput
): RallarCrdtDocumentMetadata {
    const { row, expectedDocumentKey, expectedDocument } = input;
    const document = decodeExactDocumentRef(
        decodeCrdtRowJson(row.document_ref, 'CRDT persisted document identity'),
        'CRDT persisted document identity'
    );
    if (
        row.document_key !== expectedDocumentKey ||
        toRallarCrdtDocumentKey(document) !== row.document_key ||
        toRallarCrdtDocumentKey(expectedDocument) !== row.document_key ||
        row.application_id !== document.applicationId ||
        row.workspace_id !== (document.workspaceId ?? null) ||
        row.document_scope !== document.scope ||
        row.document_type !== document.documentType ||
        row.document_id !== document.documentId
    ) {
        throw new TypeError('CRDT persisted document identity is corrupt');
    }
    const documentRevision = decodePositiveRowInteger(
        row.document_revision,
        'CRDT persisted document revision'
    );
    const lastAppendSequence = decodeNonNegativeRowInteger(
        row.last_append_sequence,
        'CRDT persisted last append sequence'
    );
    const updateCount = decodeNonNegativeRowInteger(
        row.update_count,
        'CRDT persisted update count'
    );
    const snapshotCount = decodeNonNegativeRowInteger(
        row.snapshot_count,
        'CRDT persisted snapshot count'
    );
    const storedUpdateBytes = decodeNonNegativeRowInteger(
        row.stored_update_bytes,
        'CRDT persisted update bytes'
    );
    const lifecycle = requireOneOf(
        row.lifecycle,
        ['active', 'archived', 'destroyed', 'quarantined'] as const,
        'CRDT persisted lifecycle'
    );
    const createdAtEpochMs = decodeRowEpoch(row.created_at_ts, 'CRDT persisted creation time');
    const updatedAtEpochMs = decodeRowEpoch(row.updated_at_ts, 'CRDT persisted update time');
    const archivedAtEpochMs = decodeNullableRowEpoch(
        row.archived_at_ts,
        'CRDT persisted archive time'
    );
    const destroyedAtEpochMs = decodeNullableRowEpoch(
        row.destroyed_at_ts,
        'CRDT persisted destruction time'
    );
    const retention = decodeStoredRetentionPolicy(row.retention_policy);
    const quota = decodeStoredQuotaPolicy(row.quota_policy);
    const projectionIds = decodeStoredProjectionIds(row.projection_ids);
    try {
        return decodeExactDocumentMetadata(
            decodeJsonWireValue(
                {
                    document,
                    documentKey: row.document_key,
                    documentRevision,
                    lifecycle,
                    createdAtEpochMs,
                    updatedAtEpochMs,
                    archivedAtEpochMs,
                    destroyedAtEpochMs,
                    lastAppendSequence,
                    updateCount,
                    snapshotCount,
                    storedUpdateBytes,
                    retention,
                    quota,
                    projectionIds
                },
                'CRDT persisted document metadata'
            )
        );
    }
    catch {
        throw new TypeError('CRDT persisted document metadata is corrupt');
    }
}

export function decodeStoredCrdtDocumentRow(
    row: CrdtDocumentRow
): RallarCrdtDocumentMetadata {
    const document = decodeExactDocumentRef(
        decodeCrdtRowJson(row.document_ref, 'CRDT persisted document identity'),
        'CRDT persisted document identity'
    );
    return decodeCrdtDocumentRow({
        row,
        expectedDocumentKey: row.document_key,
        expectedDocument: document
    });
}

function decodeStoredRetentionPolicy(value: string | null): RallarCrdtRetentionPolicy | null {
    if (value === null) {
        return null;
    }
    try {
        return decodeExactRetentionPolicy(decodeCrdtRowJson(value, 'CRDT persisted retention policy'));
    }
    catch {
        throw new TypeError('CRDT persisted retention policy is corrupt');
    }
}

function decodeStoredQuotaPolicy(value: string | null): RallarCrdtQuotaPolicy | null {
    if (value === null) {
        return null;
    }
    try {
        return decodeExactQuotaPolicy(decodeCrdtRowJson(value, 'CRDT persisted quota policy'));
    }
    catch {
        throw new TypeError('CRDT persisted quota policy is corrupt');
    }
}

function decodeStoredProjectionIds(value: string | null): readonly string[] {
    if (value === null) {
        throw new TypeError('CRDT persisted projection IDs are corrupt');
    }
    try {
        return decodeExactProjectionIds(decodeCrdtRowJson(value, 'CRDT persisted projection IDs'));
    }
    catch {
        throw new TypeError('CRDT persisted projection IDs are corrupt');
    }
}

function decodePositiveRowInteger(value: number | string, label: string): number {
    const integer = decodeNonNegativeRowInteger(value, label);
    if (integer === 0) {
        throw new TypeError(`${label} is corrupt`);
    }
    return integer;
}

function decodeNonNegativeRowInteger(value: number | string, label: string): number {
    const integer = Number(value);
    if (!Number.isSafeInteger(integer) || integer < 0) {
        throw new TypeError(`${label} is corrupt`);
    }
    return integer;
}

function decodeRowEpoch(value: Date | string, label: string): number {
    const epochMs = new Date(value).getTime();
    if (!Number.isSafeInteger(epochMs) || epochMs < 0) {
        throw new TypeError(`${label} is corrupt`);
    }
    return epochMs;
}

function decodeNullableRowEpoch(value: Date | string | null, label: string): number | null {
    return value === null ? null : decodeRowEpoch(value, label);
}
