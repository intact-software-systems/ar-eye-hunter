import { requireEpoch, requireExactKeys, requireRecord, requireString } from '@shared/api/exact-object-decoding.ts';
import { computeRuntimeStateGuardedBatchWrite } from '../../../runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type {
    RuntimeStateGuardedBatchInsert,
    RuntimeStateGuardedBatchWrite
} from '../../../runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { RuntimeStateEntry } from '../../../runtime-state/runtime-state-repository.ts';
import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import type { ClientAuthorisedWsSessionConnectAppInboxPayload } from '../inbox/app-client-inbox-contracts.ts';
import { decodeClientAuthorisedWsSessionConnectAppInboxPayload } from '../inbox/client-state-inbox-command-codec.ts';
import {
    ClientStateRepositoryInvariantCorruptionError,
    withClientStateRepositoryInvariantError
} from '../persistence/client-state-persistence-contracts.ts';
import { CLIENT_STATE_WS_CONNECTION_HOLDERS_NAMESPACE } from '../persistence/client-state-runtime-namespaces.ts';
import {
    decodeClientStateStorageKey,
    encodeClientStateStorageKeyPart,
    readDecodedClientStateStorageKeyPart
} from '../persistence/client-state-storage-key-codec.ts';

/** One socket generation and the process that holds it: the connection payload the process keeps in memory. */
export interface WsConnectionHolderRecord {
    readonly version: 1;
    readonly holderId: string;
    readonly connection: ClientAuthorisedWsSessionConnectAppInboxPayload;
    readonly expireAtEpochMs: number;
}

export interface WsConnectionHolderGenerationRef {
    readonly sessionId: string;
    readonly generationId: string;
}

export interface WsConnectionHolderRecordRef extends WsConnectionHolderGenerationRef {
    readonly holderId: string;
}

/** A live stored record with the key and revision a conditional delete of it names. */
export interface WsConnectionHolderRecordEntry {
    readonly key: string;
    readonly revision: number;
    readonly record: WsConnectionHolderRecord;
}

export interface ComputeWsConnectionHolderRecordedInput {
    readonly holderId: string;
    readonly connection: ClientAuthorisedWsSessionConnectAppInboxPayload;
    readonly expireAtEpochMs: number;
    /** The live record under the generation's key for this holder, as the connect read it. */
    readonly current: WsConnectionHolderRecordEntry | null;
}

const RECORD_FIELDS = ['version', 'holderId', 'connection', 'expireAtEpochMs'];

/** The holder comes first so that one holder's records are one key range; the key ends with its generation. */
export function toWsConnectionHolderRecordKey(ref: WsConnectionHolderRecordRef): string {
    return [toHolderKeyPart(ref.holderId), ...toGenerationKeyParts(ref)].join(':');
}

export function toWsConnectionHolderKeyPrefix(holderId: string): string {
    return `${toHolderKeyPart(holderId)}:`;
}

export function toWsConnectionHolderGenerationKeySuffix(ref: WsConnectionHolderGenerationRef): string {
    return `:${toGenerationKeyParts(ref).join(':')}`;
}

/** A stored row whose key, value and expiry do not name one record is corruption, never a miss. */
export function decodeWsConnectionHolderRecordEntry(entry: RuntimeStateEntry): WsConnectionHolderRecordEntry {
    return withClientStateRepositoryInvariantError(entry.key, () => {
        const keyParts = decodeClientStateStorageKey(entry.key, ['holder', 'session', 'generation']);
        const record = decodeWsConnectionHolderRecord(JSON.parse(entry.value) as JsonWireValue);
        if (
            record.holderId !== readDecodedClientStateStorageKeyPart(keyParts, 0) ||
            record.connection.authSession.sessionId !== readDecodedClientStateStorageKeyPart(keyParts, 1) ||
            record.connection.generationId !== readDecodedClientStateStorageKeyPart(keyParts, 2) ||
            record.expireAtEpochMs !== entry.expireAtTimestamp
        ) {
            throw new TypeError('Stored WebSocket connection holder record differs from its canonical slot');
        }
        return { key: entry.key, revision: entry.revision, record };
    });
}

/**
 * The record a completed connect writes as one more effect of its batch: an insert where none is live, nothing
 * where the same record already is. Another record under the same key is corruption.
 */
export function computeWsConnectionHolderRecorded(
    input: ComputeWsConnectionHolderRecordedInput
): RuntimeStateGuardedBatchInsert | null {
    const record: WsConnectionHolderRecord = {
        version: 1,
        holderId: input.holderId,
        connection: input.connection,
        expireAtEpochMs: input.expireAtEpochMs
    };
    const key = toWsConnectionHolderRecordKey({
        holderId: record.holderId,
        sessionId: record.connection.authSession.sessionId,
        generationId: record.connection.generationId
    });
    const value = JSON.stringify(record);
    if (input.current === null) {
        return {
            operation: 'insert',
            namespace: CLIENT_STATE_WS_CONNECTION_HOLDERS_NAMESPACE,
            key,
            value,
            expireAtTimestamp: record.expireAtEpochMs
        };
    }
    if (input.current.key !== key || JSON.stringify(input.current.record) !== value) {
        throw new ClientStateRepositoryInvariantCorruptionError(
            input.current.key,
            'A live WebSocket connection holder record names another connection'
        );
    }
    return null;
}

/** A disconnect deletes the record it read at that revision, so a concurrent writer conflicts instead of losing. */
export function computeWsConnectionHolderReleased(
    current: WsConnectionHolderRecordEntry | null
): RuntimeStateGuardedBatchWrite | null {
    if (current === null) {
        return null;
    }
    return computeRuntimeStateGuardedBatchWrite({
        guard: {
            operation: 'delete',
            namespace: CLIENT_STATE_WS_CONNECTION_HOLDERS_NAMESPACE,
            key: current.key,
            expectedRevision: current.revision
        },
        effects: []
    });
}

function toHolderKeyPart(holderId: string): string {
    return `holder=${encodeClientStateStorageKeyPart(holderId)}`;
}

function toGenerationKeyParts(ref: WsConnectionHolderGenerationRef): readonly string[] {
    return [
        `session=${encodeClientStateStorageKeyPart(ref.sessionId)}`,
        `generation=${encodeClientStateStorageKeyPart(ref.generationId)}`
    ];
}

function decodeWsConnectionHolderRecord(value: JsonWireValue): WsConnectionHolderRecord {
    const stored = requireRecord(value, 'WebSocket connection holder record');
    requireExactKeys(stored, RECORD_FIELDS, 'WebSocket connection holder record');
    if (stored.version !== 1) {
        throw new TypeError('WebSocket connection holder record version is unknown');
    }
    requireString(stored.holderId, 'WebSocket connection holder id');
    requireEpoch(stored.expireAtEpochMs, 'WebSocket connection holder record expiry');
    return {
        version: 1,
        holderId: stored.holderId,
        connection: decodeClientAuthorisedWsSessionConnectAppInboxPayload(stored.connection as JsonWireValue),
        expireAtEpochMs: stored.expireAtEpochMs
    };
}
