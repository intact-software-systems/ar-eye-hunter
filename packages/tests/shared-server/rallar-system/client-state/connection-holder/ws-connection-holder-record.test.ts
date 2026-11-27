import { describe, expect, it } from 'vitest';

import {
    computeWsConnectionHolderRecorded,
    computeWsConnectionHolderReleased,
    decodeWsConnectionHolderRecordEntry,
    toWsConnectionHolderGenerationKeySuffix,
    toWsConnectionHolderKeyPrefix,
    toWsConnectionHolderRecordKey
} from '@shared-server/rallar-system/client-state/connection-holder/ws-connection-holder-record.ts';
import type { ClientAuthorisedWsSessionConnectAppInboxPayload } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts';
import { ClientStateRepositoryInvariantCorruptionError } from '@shared-server/rallar-system/client-state/persistence/client-state-persistence-contracts.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';

const NAMESPACE = 'client-state:ws-connection-holders';
const HOLDER_ID = '00000000-0000-4000-8000-0000000000a1';
const EXPIRE_AT_EPOCH_MS = 1_700_000_090_000;

const CONNECTION: ClientAuthorisedWsSessionConnectAppInboxPayload = {
    authSession: {
        clientId: 'alice',
        username: 'alice',
        sessionId: 'session-1',
        issuedAtEpochMs: 1_700_000_000_000,
        expiresAtEpochMs: 1_700_000_060_000
    },
    generationId: 'generation-1',
    generationStartedAtEpochMs: 1_700_000_001_000,
    scope: { applicationId: 'app', workspaceId: 'default' },
    principalId: 'alice',
    clientInstanceId: 'alice-browser',
    displayName: 'Alice',
    userAgent: null,
    platform: 'web',
    capabilities: [],
    expiresAtEpochMs: 1_700_000_060_000
};

const STORED_VALUE = JSON.stringify({
    version: 1,
    holderId: HOLDER_ID,
    connection: CONNECTION,
    expireAtEpochMs: EXPIRE_AT_EPOCH_MS
});

const STORED_KEY = `holder=${HOLDER_ID}:session=session-1:generation=generation-1`;

describe('the WebSocket connection holder record key', () => {
    it('names the holder first and ends with the session and generation, each part escaped', () => {
        expect(toWsConnectionHolderRecordKey({ holderId: 'h-1', sessionId: 's-1', generationId: 'g-1' }))
            .toBe('holder=h-1:session=s-1:generation=g-1');
        expect(toWsConnectionHolderRecordKey({ holderId: 'a:b', sessionId: 'x=y', generationId: '%3A' }))
            .toBe('holder=a%3Ab:session=x%3Dy:generation=%253A');
        expect(toWsConnectionHolderKeyPrefix('a:b')).toBe('holder=a%3Ab:');
        expect(toWsConnectionHolderGenerationKeySuffix({ sessionId: 'x=y', generationId: '%3A' }))
            .toBe(':session=x%3Dy:generation=%253A');
    });

    it('gives distinct holders, sessions and generations distinct keys, and never a shared prefix or suffix', () => {
        const refs = [
            { holderId: 'h', sessionId: 's', generationId: 'g' },
            { holderId: 'h2', sessionId: 's', generationId: 'g' },
            { holderId: 'h:session=s', sessionId: 's', generationId: 'g' },
            { holderId: 'h', sessionId: 's:generation=g', generationId: 'g' },
            { holderId: 'h', sessionId: 'ps', generationId: 'g' },
            { holderId: 'h', sessionId: 's', generationId: 'xg' },
            { holderId: 'h', sessionId: 's', generationId: '%3A' },
            { holderId: 'h', sessionId: 's', generationId: ':' }
        ];
        const keys = refs.map(toWsConnectionHolderRecordKey);
        expect(new Set(keys).size).toBe(refs.length);

        for (const [index, ref] of refs.entries()) {
            const prefix = toWsConnectionHolderKeyPrefix(ref.holderId);
            const suffix = toWsConnectionHolderGenerationKeySuffix(ref);
            const selectedByPrefix = refs.filter((other, otherIndex) => keys[otherIndex]!.startsWith(prefix) && other.holderId !== ref.holderId);
            const selectedBySuffix = refs.filter((other, otherIndex) =>
                keys[otherIndex]!.endsWith(suffix) &&
                (other.sessionId !== ref.sessionId || other.generationId !== ref.generationId)
            );
            expect(selectedByPrefix, `prefix of ${index}`).toEqual([]);
            expect(selectedBySuffix, `suffix of ${index}`).toEqual([]);
            expect(keys[index]!.startsWith(prefix)).toBe(true);
            expect(keys[index]!.endsWith(suffix)).toBe(true);
        }
    });
});

describe('a stored WebSocket connection holder record', () => {
    it('decodes the row the connect writes, with its key and revision', () => {
        expect(decodeWsConnectionHolderRecordEntry(storedEntry())).toEqual({
            key: STORED_KEY,
            revision: 3,
            record: { version: 1, holderId: HOLDER_ID, connection: CONNECTION, expireAtEpochMs: EXPIRE_AT_EPOCH_MS }
        });
    });

    it('refuses a row whose key and value disagree, whose expiry differs, or whose shape is unknown', () => {
        const value = JSON.parse(STORED_VALUE) as Record<string, unknown>;
        const corrupt: readonly Partial<RuntimeStateEntry>[] = [
            { key: `holder=00000000-0000-4000-8000-0000000000a2:session=session-1:generation=generation-1` },
            { key: `holder=${HOLDER_ID}:session=session-2:generation=generation-1` },
            { key: `holder=${HOLDER_ID}:session=session-1:generation=generation-2` },
            { key: `holder=${HOLDER_ID}:session=session-1` },
            { key: `holder=${HOLDER_ID}:session=session%2D1:generation=generation-1` },
            { expireAtTimestamp: EXPIRE_AT_EPOCH_MS + 1 },
            { value: JSON.stringify({ ...value, version: 2 }) },
            { value: JSON.stringify({ ...value, extra: true }) },
            { value: JSON.stringify({ version: 1, holderId: HOLDER_ID, connection: CONNECTION }) },
            { value: JSON.stringify({ ...value, connection: { ...CONNECTION, generationId: 7 } }) },
            { value: '[]' }
        ];
        for (const fields of corrupt) {
            expect(() => decodeWsConnectionHolderRecordEntry(storedEntry(fields)), JSON.stringify(fields))
                .toThrow(ClientStateRepositoryInvariantCorruptionError);
        }
    });
});

describe('the WebSocket connection holder record computations', () => {
    it('inserts the record where none is live, and writes nothing over the same record', () => {
        const input = { holderId: HOLDER_ID, connection: CONNECTION, expireAtEpochMs: EXPIRE_AT_EPOCH_MS };

        expect(computeWsConnectionHolderRecorded({ ...input, current: null })).toEqual({
            operation: 'insert',
            namespace: NAMESPACE,
            key: STORED_KEY,
            value: STORED_VALUE,
            expireAtTimestamp: EXPIRE_AT_EPOCH_MS
        });
        expect(
            computeWsConnectionHolderRecorded({ ...input, current: decodeWsConnectionHolderRecordEntry(storedEntry()) })
        ).toBeNull();
    });

    it('refuses to record over a live record of the same key that holds another connection', () => {
        const current = decodeWsConnectionHolderRecordEntry(storedEntry());

        expect(() =>
            computeWsConnectionHolderRecorded({
                holderId: HOLDER_ID,
                connection: { ...CONNECTION, displayName: 'Mallory' },
                expireAtEpochMs: EXPIRE_AT_EPOCH_MS,
                current
            })
        ).toThrow(ClientStateRepositoryInvariantCorruptionError);
        expect(() =>
            computeWsConnectionHolderRecorded({
                holderId: HOLDER_ID,
                connection: CONNECTION,
                expireAtEpochMs: EXPIRE_AT_EPOCH_MS + 1,
                current
            })
        ).toThrow(ClientStateRepositoryInvariantCorruptionError);
    });

    it('releases a record by deleting it at the revision that was read, and nothing when none was read', () => {
        expect(computeWsConnectionHolderReleased(null)).toBeNull();
        expect(computeWsConnectionHolderReleased(decodeWsConnectionHolderRecordEntry(storedEntry()))).toEqual({
            operation: 'delete',
            namespace: NAMESPACE,
            key: STORED_KEY,
            expectedRevision: 3
        });
    });
});

function storedEntry(fields: Partial<RuntimeStateEntry> = {}): RuntimeStateEntry {
    return {
        key: STORED_KEY,
        value: STORED_VALUE,
        expireAtTimestamp: EXPIRE_AT_EPOCH_MS,
        updatedTimestamp: '2023-11-14T22:13:20.000Z',
        revision: 3,
        ...fields
    };
}
