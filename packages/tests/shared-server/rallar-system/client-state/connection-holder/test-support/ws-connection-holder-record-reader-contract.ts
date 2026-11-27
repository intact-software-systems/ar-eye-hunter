import { expect, type it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { writeWsConnectionHolderReleased } from '@shared-server/rallar-system/client-state/connection-holder/write-ws-connection-holder-released.ts';
import {
    createWsConnectionHolderRecordReader,
    type WsConnectionHolderRecordReader
} from '@shared-server/rallar-system/client-state/connection-holder/ws-connection-holder-record-reader.ts';
import {
    computeWsConnectionHolderRecorded,
    computeWsConnectionHolderReleased,
    type WsConnectionHolderRecord
} from '@shared-server/rallar-system/client-state/connection-holder/ws-connection-holder-record.ts';
import type { ClientAuthorisedWsSessionConnectAppInboxPayload } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts';
import { computeRuntimeStateGuardedBatchWrite } from '@shared-server/runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { writeRuntimeStateGuardedBatch } from '@shared-server/runtime-state/postgres/write-runtime-state-guarded-batch.ts';

const NAMESPACE = 'client-state:ws-connection-holders';

export interface WsConnectionHolderRecordStore {
    readonly sql: PSqlSql;
    close(): Promise<void>;
}

export interface WsConnectionHolderRecordReaderContractInput {
    readonly test: typeof it | typeof it.skip;
    readonly openStore: () => Promise<WsConnectionHolderRecordStore>;
}

interface HolderFixture {
    readonly sql: PSqlSql;
    readonly holderA: string;
    readonly holderB: string;
    readonly expireAtEpochMs: number;
}

/** The record's two reads, as one contract the PGlite and PostgreSQL files both run. */
export function describeWsConnectionHolderRecordReaderContract(
    input: WsConnectionHolderRecordReaderContractInput
): void {
    input.test('pages one holder in key order and reads each generation alone', async () => {
        await withHolderFixture(input, async (fixture) => {
            const { holderA, holderB } = fixture;
            const records = [
                record(fixture, holderA, 's1', 'g1'),
                record(fixture, holderA, 's2', 'g2'),
                record(fixture, holderA, 's3', 'g3'),
                record(fixture, holderB, 's9', 'g9')
            ];
            for (const stored of records.toReversed()) {
                await writeRecord(fixture.sql, stored);
            }
            const reader = createReader(fixture.sql, () => Date.now());

            const firstPage = await reader.readHolderPage({ holderId: holderA, afterKey: null, limit: 2 });
            const secondPage = await reader.readHolderPage({
                holderId: holderA,
                afterKey: firstPage.nextAfterKey,
                limit: 2
            });
            const otherHolder = await reader.readHolderPage({ holderId: holderB, afterKey: null, limit: 2 });

            expect(firstPage.records.map((entry) => entry.record)).toEqual(records.slice(0, 2));
            expect(firstPage.nextAfterKey).toBe(`holder=${holderA}:session=s2:generation=g2`);
            expect(secondPage.records.map((entry) => entry.record)).toEqual(records.slice(2, 3));
            expect(secondPage.nextAfterKey).toBeNull();
            expect(otherHolder.records.map((entry) => entry.key)).toEqual([`holder=${holderB}:session=s9:generation=g9`]);
            expect(otherHolder.nextAfterKey).toBeNull();
            for (const stored of records) {
                const entry = await reader.readGenerationRecord(toGeneration(stored));
                expect(entry?.record).toEqual(stored);
                expect(entry?.key).toBe(
                    `holder=${stored.holderId}:session=${stored.connection.authSession.sessionId}:generation=${stored.connection.generationId}`
                );
                expect(entry?.revision).toBe(0);
            }
        });
    });

    input.test('releases a generation once: the delete at a stale revision conflicts', async () => {
        await withHolderFixture(input, async (fixture) => {
            const kept = record(fixture, fixture.holderA, 's1', 'g1');
            const released = record(fixture, fixture.holderA, 's2', 'g2');
            await writeRecord(fixture.sql, kept);
            await writeRecord(fixture.sql, released);
            const reader = createReader(fixture.sql, () => Date.now());
            const read = await reader.readGenerationRecord(toGeneration(released));
            const release = computeWsConnectionHolderReleased(read);
            if (release === null) {
                throw new Error('Expected a release of the stored record');
            }

            await writeWsConnectionHolderReleased(fixture.sql, release);
            await expect(writeWsConnectionHolderReleased(fixture.sql, release)).rejects.toThrow(
                RuntimeStateWriteConflictError
            );
            expect(await reader.readGenerationRecord(toGeneration(released))).toBeNull();
            expect(
                (await reader.readHolderPage({ holderId: fixture.holderA, afterKey: null, limit: 10 })).records
                    .map((entry) => entry.record)
            ).toEqual([kept]);
        });
    });

    input.test('reads an expired record as absent from both reads', async () => {
        await withHolderFixture(input, async (fixture) => {
            const stored = record(fixture, fixture.holderA, 's1', 'g1');
            await writeRecord(fixture.sql, stored);
            const reader = createReader(fixture.sql, () => fixture.expireAtEpochMs);

            expect(await reader.readGenerationRecord(toGeneration(stored))).toBeNull();
            expect(await reader.readHolderPage({ holderId: fixture.holderA, afterKey: null, limit: 10 })).toEqual({
                records: [],
                nextAfterKey: null
            });
        });
    });

    input.test('fails closed on a row that names another generation or a generation held twice', async () => {
        await withHolderFixture(input, async (fixture) => {
            const repository = new PSqlRuntimeStateRepository(fixture.sql);
            const misplaced = record(fixture, fixture.holderA, 's1', 'g2');
            await repository.upsert({
                namespace: NAMESPACE,
                key: `holder=${fixture.holderA}:session=s1:generation=g1`,
                value: JSON.stringify(misplaced),
                expireAtTimestamp: fixture.expireAtEpochMs
            });
            const twice = record(fixture, fixture.holderA, 's5', 'g5');
            await writeRecord(fixture.sql, twice);
            await writeRecord(fixture.sql, { ...twice, holderId: fixture.holderB });
            const reader = createReader(fixture.sql, () => Date.now());

            await expect(reader.readGenerationRecord({ sessionId: 's1', generationId: 'g1' })).rejects.toThrow(
                'Stored WebSocket connection holder record differs from its canonical slot'
            );
            await expect(reader.readHolderPage({ holderId: fixture.holderA, afterKey: null, limit: 10 })).rejects
                .toThrow('Stored WebSocket connection holder record differs from its canonical slot');
            await expect(reader.readGenerationRecord({ sessionId: 's5', generationId: 'g5' })).rejects.toThrow(
                'A WebSocket connection generation has more than one holder record'
            );
        });
    });
}

function createReader(sql: PSqlSql, nowMs: () => number): WsConnectionHolderRecordReader {
    return createWsConnectionHolderRecordReader({ repository: new PSqlRuntimeStateRepository(sql), nowMs });
}

async function withHolderFixture(
    input: WsConnectionHolderRecordReaderContractInput,
    test: (fixture: HolderFixture) => Promise<void>
): Promise<void> {
    const store = await input.openStore();
    const fixture: HolderFixture = {
        sql: store.sql,
        holderA: crypto.randomUUID(),
        holderB: crypto.randomUUID(),
        expireAtEpochMs: Date.now() + 600_000
    };
    try {
        await test(fixture);
    }
    finally {
        for (const holderId of [fixture.holderA, fixture.holderB]) {
            await store.sql`
                delete from runtime_state_store
                where store_namespace = ${NAMESPACE}
                  and store_key like ${`holder=${holderId}:%`}
            `;
        }
        await store.close();
    }
}

function record(
    fixture: HolderFixture,
    holderId: string,
    sessionId: string,
    generationId: string
): WsConnectionHolderRecord {
    return { version: 1, holderId, connection: connection(sessionId, generationId), expireAtEpochMs: fixture.expireAtEpochMs };
}

function connection(sessionId: string, generationId: string): ClientAuthorisedWsSessionConnectAppInboxPayload {
    return {
        authSession: {
            clientId: 'alice',
            username: 'alice',
            sessionId,
            issuedAtEpochMs: 1_700_000_000_000,
            expiresAtEpochMs: 1_700_000_060_000
        },
        generationId,
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
}

/** Writes the record as a connect does: the computed insert, applied through the guarded batch statement. */
async function writeRecord(sql: PSqlSql, stored: WsConnectionHolderRecord): Promise<void> {
    const insert = computeWsConnectionHolderRecorded({ ...stored, current: null });
    if (insert === null) {
        throw new Error('Expected an insert of an absent record');
    }
    const result = await writeRuntimeStateGuardedBatch(
        sql,
        computeRuntimeStateGuardedBatchWrite({ guard: insert, effects: [] })
    );
    expect(result.guard.status).toBe('applied');
}

function toGeneration(stored: WsConnectionHolderRecord): Readonly<{ sessionId: string; generationId: string; }> {
    return { sessionId: stored.connection.authSession.sessionId, generationId: stored.connection.generationId };
}
