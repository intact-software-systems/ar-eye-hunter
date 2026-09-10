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

const SNAPSHOT_PATH = 'tmp/perf/alm-storage-snapshot.json';
const DB_NAME = 'rallar-alm-storage-snapshot';
const ADMISSION_STORE_NAME = IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME;
const NAMESPACE = 'snapshot';

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

        const written: unknown = JSON.parse(readFileSync(path.join(repositoryRoot(), SNAPSHOT_PATH), 'utf8'));
        expect(Object.keys(written as object).toSorted()).toEqual([
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
            'AL_ADMISSION',
            'AL_OUTBOUND',
            'AL_OUTBOUND_IDENTITY',
            'AL_OUTBOUND_MESSAGE'
        ]);
    }, 120_000);
});

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
            bytesByTopic: { ...sumBytesByTopic(work), AL_ADMISSION: sumBytes(admission) },
            measuredAt: readCommit()
        };
    }
    finally {
        db.close();
    }
}

function readStoredRows(db: IDBDatabase, storeName: string): Promise<readonly Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
        const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result as readonly Record<string, unknown>[]);
        request.onerror = () => reject(request.error ?? new Error(`Cannot read ${storeName}`));
    });
}

function countRowsByStatus(rows: readonly Record<string, unknown>[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const row of rows) {
        const status = typeof row['status'] === 'string' ? row['status'] : 'unknown';
        counts[status] = (counts[status] ?? 0) + 1;
    }
    return counts;
}

function sumBytesByTopic(rows: readonly Record<string, unknown>[]): Record<string, number> {
    const bytes: Record<string, number> = {};
    for (const row of rows) {
        const topic = toTopicId(row['keyString']);
        bytes[topic] = (bytes[topic] ?? 0) + toRowBytes(row);
    }
    return bytes;
}

function sumBytes(rows: readonly Record<string, unknown>[]): number {
    return rows.reduce((total, row) => total + toRowBytes(row), 0);
}

/** Every stored queue key is `topicId/resourceId/contextId`; the topic is what the report groups by. */
function toTopicId(keyString: unknown): string {
    return typeof keyString === 'string' ? keyString.split('/')[0] ?? 'unknown' : 'unknown';
}

function toRowBytes(row: Record<string, unknown>): number {
    return new TextEncoder().encode(JSON.stringify(row)).byteLength;
}

function writeALStorageSnapshot(snapshot: ALStorageSnapshot): void {
    const target = path.join(repositoryRoot(), SNAPSHOT_PATH);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(snapshot, undefined, 4)}\n`);
}

function readCommit(): string {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot(), encoding: 'utf8' }).trim();
}

function repositoryRoot(): string {
    return process.cwd();
}
