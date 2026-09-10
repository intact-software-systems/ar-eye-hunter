// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { createDefaultIndexedDbALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import {
    AL_ADMISSION_SCHEMA_ID,
    AL_ADMISSION_WORK_STORE_NAME,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';
import { createOutboundTestRuntimeFor, enqueueOutboundOrThrow } from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

/** The standard workload the ALM storage snapshot reports: eight superseding updates per recipient. */
const WORKLOAD = {
    updateCount: 8,
    recipientPeerIds: ['peer-1', 'peer-2', 'peer-3'],
    payloadBytes: [128, 4 * 1024, 64 * 1024]
} as const;

/**
 * The resident serialized bytes both object stores hold once the whole workload has run. This is not
 * comparable to the 47,465-byte figure in #521, which measured one readback. Supersedence retains
 * all eight updates per recipient per size until their deadline, so the store keeps 216 rows (72
 * messages x 3) and every payload, not the three latest. The band is the run-to-run spread of
 * identity and timestamp digits: the readback serializes each row without whitespace, so nothing
 * else moves.
 */
const EXPECTED_BYTES_BY_TOPIC = {
    AL_OUTBOUND: 1_813_460,
    AL_OUTBOUND_MESSAGE: 1_743_590,
    AL_ADMISSION: 101_570,
    AL_OUTBOUND_IDENTITY: 69_760
} as const;
const EXPECTED_TOTAL_BYTES = 3_728_380;
const BYTES_TOLERANCE = 0.02;

const SNAPSHOT_PATH = 'tmp/perf/alm-storage-snapshot.json';
const DB_NAME = 'rallar-alm-storage-snapshot';
const ADMISSION_STORE_NAME = IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME;
const NAMESPACE = 'snapshot';
/** Admission metadata rows carry no queue key, so the report groups them under their own name. */
const ADMISSION_TOPIC_ID = 'AL_ADMISSION';

interface StoredSnapshotRow {
    readonly topicId: string;
    readonly status: string;
    readonly bytes: number;
}

interface ALStorageSnapshot {
    readonly workload: typeof WORKLOAD;
    readonly rowsByStatus: Readonly<Record<string, number>>;
    readonly bytesByTopic: Readonly<Record<string, number>>;
    readonly measuredAt: string;
}

describe('ALM browser storage snapshot', () => {
    it('records what the standard superseding workload leaves in IndexedDB', async () => {
        const stores = createDefaultIndexedDbALOutboundRuntimeStores<OutboundTestPayload>({
            dbName: DB_NAME,
            namespace: NAMESPACE,
            canonicalScope: NAMESPACE,
            decodePrepared: decodeOutboundTestPayload
        });
        const runtime = createOutboundTestRuntimeFor<OutboundTestPayload>({
            stores,
            decodePreparedMessage: decodeOutboundTestPayload,
            planOutgoingMessage: (msg) => ({
                msg,
                persist: true,
                preparedMessages: [{ message: JSON.stringify(msg) }],
                supersedenceTracking: {
                    enabled: true,
                    algo: 'latest-wins',
                    key: toSupersedenceKey(msg)
                }
            }),
            sendPreparedMessage: async () => ({ status: 'sent' })
        });
        await runtime.ready();

        for (const payloadBytes of WORKLOAD.payloadBytes) {
            for (let update = 0; update < WORKLOAD.updateCount; update += 1) {
                for (const peerId of WORKLOAD.recipientPeerIds) {
                    await enqueueOutboundOrThrow(runtime, createUpdate({ payloadBytes, update, peerId }));
                }
            }
        }
        await runtime.drainWork();

        const snapshot = await readALStorageSnapshot();
        writeALStorageSnapshot(snapshot);

        expect(readWrittenSnapshotKeys()).toEqual([
            'bytesByTopic',
            'measuredAt',
            'rowsByStatus',
            'workload'
        ]);
        // Every admitted message retains three rows until its deadline -- its canonical envelope,
        // that envelope's identity fact, and the settled send work -- and supersedence does not
        // delete a predecessor's envelope. A change to either fact must move this snapshot.
        const messageCount = WORKLOAD.updateCount * WORKLOAD.recipientPeerIds.length *
            WORKLOAD.payloadBytes.length;
        expect(snapshot.rowsByStatus).toEqual({ COMPLETED: messageCount * 3 });
        expect(Object.keys(snapshot.bytesByTopic).toSorted()).toEqual([
            ADMISSION_TOPIC_ID,
            'AL_OUTBOUND',
            'AL_OUTBOUND_IDENTITY',
            'AL_OUTBOUND_MESSAGE'
        ]);
        for (const [topicId, expected] of Object.entries(EXPECTED_BYTES_BY_TOPIC)) {
            expectBytesWithinBand(snapshot.bytesByTopic[topicId], expected);
        }
        expectBytesWithinBand(
            Object.values(snapshot.bytesByTopic).reduce((total, bytes) => total + bytes, 0),
            EXPECTED_TOTAL_BYTES
        );
    }, 120_000);
});

/** A footprint regression has to move these figures deliberately, not drift into them. */
function expectBytesWithinBand(actual: number | undefined, expected: number): void {
    expect(actual ?? 0).toBeGreaterThanOrEqual(Math.floor(expected * (1 - BYTES_TOLERANCE)));
    expect(actual ?? 0).toBeLessThanOrEqual(Math.ceil(expected * (1 + BYTES_TOLERANCE)));
}

function toSupersedenceKey(msg: ALMessage): string {
    return `${msg.route.resourceId}:${msg.targets?.mode === 'unicast' ? msg.targets.toPeerId : 'all'}`;
}

/** `{"text":"..."}` is 11 bytes of ASCII JSON around the filler, so each tier is exact at the wire. */
function toPayloadResource(payloadBytes: number, update: number): Readonly<{ text: string; }> {
    const marker = `u${update}-`;
    return { text: `${marker}${'x'.repeat(Math.max(0, payloadBytes - 11 - marker.length))}` };
}

function createUpdate(input: Readonly<{ payloadBytes: number; update: number; peerId: string; }>): ALMessage {
    return newALUnicastMessage(
        'self',
        { topicId: 'snapshot', resourceId: `size-${input.payloadBytes}`, contextId: 'conversation-1' },
        input.peerId,
        'snapshot.update.v1',
        toPayloadResource(input.payloadBytes, input.update),
        { ttlMs: 300_000 }
    );
}

async function readALStorageSnapshot(): Promise<ALStorageSnapshot> {
    const db = await openIndexedDbAdmissionDatabase({
        dbName: DB_NAME,
        storeName: ADMISSION_STORE_NAME,
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {}
    });
    try {
        const work = await readStoredRows(db, AL_ADMISSION_WORK_STORE_NAME);
        const admission = await readStoredRows(db, ADMISSION_STORE_NAME);
        return {
            workload: WORKLOAD,
            rowsByStatus: countRowsByStatus(work),
            bytesByTopic: { ...sumBytesByTopic(work), [ADMISSION_TOPIC_ID]: sumBytes(admission) },
            measuredAt: readCommit()
        };
    }
    finally {
        db.close();
    }
}

function readStoredRows(db: IDBDatabase, storeName: string): Promise<readonly StoredSnapshotRow[]> {
    return new Promise((resolve, reject) => {
        const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result.map(decodeStoredSnapshotRow));
        request.onerror = () => reject(request.error ?? new Error(`Cannot read ${storeName}`));
    });
}

/**
 * The stored row is whatever its owner wrote. Only its queue key, its status and its serialized size
 * are reported, and every stored queue key is `topicId/resourceId/contextId`.
 */
function decodeStoredSnapshotRow(value: unknown): StoredSnapshotRow {
    if (typeof value !== 'object' || value === null) {
        throw new TypeError('Stored ALM row must be an object');
    }
    const keyString = 'keyString' in value && typeof value.keyString === 'string' ? value.keyString : '';
    return {
        topicId: keyString.split('/')[0] ?? ADMISSION_TOPIC_ID,
        status: 'status' in value && typeof value.status === 'string' ? value.status : 'unknown',
        bytes: new TextEncoder().encode(JSON.stringify(value)).byteLength
    };
}

function countRowsByStatus(rows: readonly StoredSnapshotRow[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const row of rows) {
        counts[row.status] = (counts[row.status] ?? 0) + 1;
    }
    return counts;
}

function sumBytesByTopic(rows: readonly StoredSnapshotRow[]): Record<string, number> {
    const bytes: Record<string, number> = {};
    for (const row of rows) {
        bytes[row.topicId] = (bytes[row.topicId] ?? 0) + row.bytes;
    }
    return bytes;
}

function sumBytes(rows: readonly StoredSnapshotRow[]): number {
    return rows.reduce((total, row) => total + row.bytes, 0);
}

function writeALStorageSnapshot(snapshot: ALStorageSnapshot): void {
    const target = path.join(repositoryRoot(), SNAPSHOT_PATH);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(snapshot, undefined, 4)}\n`);
}

function readWrittenSnapshotKeys(): readonly string[] {
    const written: object = JSON.parse(readFileSync(path.join(repositoryRoot(), SNAPSHOT_PATH), 'utf8'));
    return Object.keys(written).toSorted();
}

function readCommit(): string {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot(), encoding: 'utf8' }).trim();
}

function repositoryRoot(): string {
    return process.cwd();
}
