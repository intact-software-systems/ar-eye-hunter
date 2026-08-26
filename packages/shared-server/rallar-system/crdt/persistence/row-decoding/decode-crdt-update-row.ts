import {
    hashRallarCrdtUpdateEnvelope,
    toRallarCrdtDocumentKey,
    type RallarCrdtDocumentRef,
    type RallarCrdtDurableUpdateRecord
} from '@shared/crdt/mod.ts';

import { decodeJsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { decodeExactUpdateEnvelope } from '../../mutation/decode-exact-update-envelope.ts';
import { decodeExactTrustedAppendMetadata } from '../../mutation/decoding/decode-exact-trusted-append-metadata.ts';
import { decodeCrdtRowJson } from './decode-crdt-row-json.ts';

export interface CrdtUpdateRow {
    readonly document_key: string;
    readonly update_id: string;
    readonly append_sequence: number | string;
    readonly update_envelope: string;
    readonly accepted_update_hash: string;
    readonly actor_id: string | null;
    readonly principal_id: string | null;
    readonly session_id: string | null;
    readonly server_id: string | null;
    readonly authorization_scope: string;
    readonly accepted_at_ts: Date | string;
}

export interface DecodeCrdtUpdateRowInput {
    readonly row: CrdtUpdateRow;
    readonly document: RallarCrdtDocumentRef;
}

export function decodeCrdtUpdateRow(
    input: DecodeCrdtUpdateRowInput
): RallarCrdtDurableUpdateRecord {
    const { row, document } = input;
    const update = decodeExactUpdateEnvelope(
        decodeCrdtRowJson(row.update_envelope, 'CRDT persisted update envelope')
    );
    const expectedDocumentKey = toRallarCrdtDocumentKey(document);
    const appendSequence = Number(row.append_sequence);
    const acceptedAtEpochMs = new Date(row.accepted_at_ts).getTime();
    if (
        row.document_key !== expectedDocumentKey ||
        row.update_id !== update.updateId ||
        toRallarCrdtDocumentKey(update.document) !== expectedDocumentKey ||
        hashRallarCrdtUpdateEnvelope(update) !== row.accepted_update_hash ||
        row.actor_id === null ||
        row.principal_id === null ||
        row.session_id === null ||
        row.server_id === null ||
        !Number.isSafeInteger(appendSequence) ||
        appendSequence <= 0 ||
        !Number.isSafeInteger(acceptedAtEpochMs) ||
        acceptedAtEpochMs < 0 ||
        row.authorization_scope !== document.scope
    ) {
        throw new TypeError('CRDT persisted update identity is corrupt');
    }
    const append = decodeExactTrustedAppendMetadata(
        decodeJsonWireValue(
            {
                appendSequence,
                acceptedAtEpochMs,
                actorId: row.actor_id,
                principalId: row.principal_id,
                sessionId: row.session_id,
                serverId: row.server_id,
                authorizationScope: row.authorization_scope,
                acceptedUpdateHash: row.accepted_update_hash
            },
            'CRDT persisted trusted append metadata'
        )
    );
    return {
        document,
        documentKey: row.document_key,
        update,
        append
    };
}
