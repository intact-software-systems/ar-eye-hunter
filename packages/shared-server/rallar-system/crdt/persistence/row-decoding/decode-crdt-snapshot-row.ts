import {
    toRallarCrdtDocumentKey,
    type RallarCrdtDocumentRef
} from '@shared/crdt/mod.ts';

import type { CrdtCanonicalSnapshotEnvelope } from '../../mutation/crdt-mutation-contracts.ts';
import { decodeExactSnapshotEnvelope } from '../../mutation/decoding/decode-exact-snapshot-envelope.ts';
import {
    requireCrdtCanonicalSnapshotReason,
    toCrdtCanonicalSnapshotEnvelope
} from '../../mutation/to-crdt-canonical-snapshot.ts';
import { decodeCrdtRowJson } from './decode-crdt-row-json.ts';

export interface CrdtSnapshotRow {
    readonly document_key: string;
    readonly snapshot_id: string;
    readonly append_sequence: number | string;
    readonly snapshot_envelope: string;
    readonly created_at_ts: Date | string;
    readonly reason: string;
    readonly snapshot_bytes: number | string;
    readonly snapshot_count: number | string;
}

export interface DecodeCrdtSnapshotRowInput {
    readonly row: CrdtSnapshotRow;
    readonly expectedDocumentKey: string;
    readonly expectedDocument: RallarCrdtDocumentRef;
    readonly lastAppendSequence: number;
}

export function decodeCrdtSnapshotRow(
    input: DecodeCrdtSnapshotRowInput
): CrdtCanonicalSnapshotEnvelope {
    const { row, expectedDocumentKey, expectedDocument, lastAppendSequence } = input;
    const decodedSnapshot = decodeExactSnapshotEnvelope(
        decodeCrdtRowJson(row.snapshot_envelope, 'CRDT persisted snapshot envelope')
    );
    const snapshotReason = decodedSnapshot.metadata.reason;
    requireCrdtCanonicalSnapshotReason(snapshotReason);
    const snapshot = toCrdtCanonicalSnapshotEnvelope(decodedSnapshot, snapshotReason);
    const appendSequence = Number(row.append_sequence);
    const snapshotBytes = Number(row.snapshot_bytes);
    const snapshotCount = Number(row.snapshot_count);
    if (
        row.document_key !== expectedDocumentKey ||
        row.snapshot_id !== snapshot.snapshotId ||
        !Number.isSafeInteger(appendSequence) ||
        appendSequence < 0 ||
        appendSequence > lastAppendSequence ||
        new Date(row.created_at_ts).getTime() !== snapshot.createdAtEpochMs ||
        row.reason !== snapshotReason ||
        toRallarCrdtDocumentKey(snapshot.document) !== expectedDocumentKey ||
        toRallarCrdtDocumentKey(expectedDocument) !== expectedDocumentKey ||
        !Number.isSafeInteger(snapshotBytes) ||
        snapshotBytes < 0 ||
        !Number.isSafeInteger(snapshotCount) ||
        snapshotCount < 1
    ) {
        throw new TypeError('CRDT persisted snapshot identity is corrupt');
    }
    return snapshot;
}
