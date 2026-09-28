// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import {
    planALMessageHandling,
    type ALMessageHandlingPlan,
    type ALMessagePlanningObservations
} from '@shared/al-contracts/al-policy.ts';
import {
    createDefaultIndexedDbALInboundRuntimeStores,
    createDefaultIndexedDbALOutboundRuntimeStores,
    createVolatileALInboundRuntimeStores,
    createVolatileALOutboundRuntimeStores
} from '@shared/alm/al-runtime-stores.ts';
import {
    ALInboundMessageRuntime,
    type ALVolatileInboundRuntimeStores
} from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { toALInboundWorkType } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import {
    AL_ADMISSION_SCHEMA_ID,
    AL_ADMISSION_WORK_STORE_NAME,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import type { ALVolatileOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { NOT_COMPLETED_RETRYABLE_STATUSES, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import {
    createOutboundTestRuntimeFor,
    enqueueOutboundOrThrow,
    runOutboundWorkTask
} from './outbound-runtime-test-fixture.ts';
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
 *
 * `AL_ADMISSION` moved from 101,570 bytes for one reason: F2c gives every admission row its own
 * `revision` field, which the per-row fence compares in place of the deleted store-global scalar.
 *
 * S3a: these are the durable opt-in's figures; the volatile default adds 0 rows.
 */
const EXPECTED_BYTES_BY_TOPIC = {
    AL_OUTBOUND: 1_813_460,
    AL_OUTBOUND_MESSAGE: 1_743_590,
    AL_ADMISSION: 104_300,
    AL_OUTBOUND_IDENTITY: 69_760
} as const;
const EXPECTED_TOTAL_BYTES = 3_728_380;
const BYTES_TOLERANCE = 0.02;

/**
 * The inbound leg of the same workload on its own store set. Every admitted message keeps its
 * canonical envelope and its settled delivery work; the canonical row now dies with that work
 * rather than at a provenance lifetime of its own, so a change to either must move these figures.
 *
 * S3a: these are the durable opt-in's figures; the volatile default adds 0 rows.
 */
const EXPECTED_INBOUND_BYTES_BY_TOPIC = {
    AL_ADMISSION: 1_764_355,
    AL_INBOUND: 61_512
} as const;
const EXPECTED_INBOUND_TOTAL_BYTES = 1_825_867;

const SNAPSHOT_PATH = 'tmp/perf/alm-storage-snapshot.json';
const DB_NAME = 'rallar-alm-storage-snapshot';
const INBOUND_DB_NAME = 'rallar-alm-storage-snapshot-inbound';
const SELF_PEER_ID = 'self';
const INBOUND_SETTLE_ATTEMPT_LIMIT = 500;
const ADMISSION_STORE_NAME = IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME;
const NAMESPACE = 'snapshot';
const INBOUND_NAMESPACE = `${NAMESPACE}-inbound`;
/** Admission metadata rows carry no queue key, so the report groups them under their own name. */
const ADMISSION_TOPIC_ID = 'AL_ADMISSION';

interface StoredSnapshotRow {
    readonly topicId: string;
    readonly status: string;
    readonly bytes: number;
}

interface ALStorageLeg {
    readonly rowsByStatus: Readonly<Record<string, number>>;
    readonly bytesByTopic: Readonly<Record<string, number>>;
}

/** The rows the same workload adds to IndexedDB when it takes the volatile default (D55). */
interface ALVolatileStorageLeg {
    readonly outboundRowsAdded: number;
    readonly inboundRowsAdded: number;
}

interface ALStorageSnapshot extends ALStorageLeg {
    readonly workload: typeof WORKLOAD;
    readonly inbound: ALStorageLeg;
    readonly volatile: ALVolatileStorageLeg;
    readonly measuredAt: string;
}

describe('ALM browser storage snapshot', () => {
    it('records what the standard superseding workload leaves in IndexedDB', async () => {
        await sendOutboundWorkload(undefined);
        await admitInboundWorkload(undefined);
        const durable = await readALStorageSnapshot();

        // The same workload once more over the same IndexedDB pairs, taking the volatile default.
        await sendOutboundWorkload(
            createVolatileALOutboundRuntimeStores<OutboundTestPayload>({ decodePrepared: decodeOutboundTestPayload })
        );
        await admitInboundWorkload(createVolatileALInboundRuntimeStores({ namespace: `${INBOUND_NAMESPACE}-volatile` }));
        const afterVolatile = await readALStorageSnapshot();
        expect(afterVolatile.rowsByStatus, 'the volatile outbound workload adds no IndexedDB row')
            .toEqual(durable.rowsByStatus);
        expect(afterVolatile.inbound.rowsByStatus, 'the volatile inbound workload adds no IndexedDB row')
            .toEqual(durable.inbound.rowsByStatus);
        expectBytesWithinBand(sumTopicBytes(afterVolatile), sumTopicBytes(durable), 'outbound total after volatile');
        expectBytesWithinBand(
            sumTopicBytes(afterVolatile.inbound),
            sumTopicBytes(durable.inbound),
            'inbound total after volatile'
        );
        const snapshot: ALStorageSnapshot = {
            ...durable,
            volatile: {
                outboundRowsAdded: countRows(afterVolatile) - countRows(durable),
                inboundRowsAdded: countRows(afterVolatile.inbound) - countRows(durable.inbound)
            }
        };
        writeALStorageSnapshot(snapshot);

        expect(readWrittenSnapshotKeys()).toEqual([
            'bytesByTopic',
            'inbound',
            'measuredAt',
            'rowsByStatus',
            'volatile',
            'workload'
        ]);
        expect(snapshot.volatile).toEqual({ outboundRowsAdded: 0, inboundRowsAdded: 0 });
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
            expectBytesWithinBand(snapshot.bytesByTopic[topicId], expected, `outbound ${topicId}`);
        }
        expectBytesWithinBand(sumTopicBytes(snapshot), EXPECTED_TOTAL_BYTES, 'outbound total');

        // The inbound leg admitted the same workload: one canonical envelope and one settled
        // delivery row per message, with no supersedence track to retain predecessors.
        expect(snapshot.inbound.rowsByStatus).toEqual({ COMPLETED: messageCount });
        expect(Object.keys(snapshot.inbound.bytesByTopic).toSorted()).toEqual([
            ADMISSION_TOPIC_ID,
            'AL_INBOUND'
        ]);
        for (const [topicId, expected] of Object.entries(EXPECTED_INBOUND_BYTES_BY_TOPIC)) {
            expectBytesWithinBand(snapshot.inbound.bytesByTopic[topicId], expected, `inbound ${topicId}`);
        }
        expectBytesWithinBand(sumTopicBytes(snapshot.inbound), EXPECTED_INBOUND_TOTAL_BYTES, 'inbound total');
    }, 120_000);
});

/**
 * The standard outbound workload over the snapshot's IndexedDB pair. With a memory pair beside it, every
 * update takes the volatile default under its own msgId and the durable pair should see none of it.
 */
async function sendOutboundWorkload(
    volatileStores: ALVolatileOutboundRuntimeStores<OutboundTestPayload> | undefined
): Promise<void> {
    const runtime = createOutboundTestRuntimeFor<OutboundTestPayload>({
        stores: createDefaultIndexedDbALOutboundRuntimeStores<OutboundTestPayload>({
            dbName: DB_NAME,
            namespace: NAMESPACE,
            canonicalScope: NAMESPACE,
            decodePrepared: decodeOutboundTestPayload
        }),
        volatileStores,
        decodePreparedMessage: decodeOutboundTestPayload,
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            persist: volatileStores === undefined,
            preparedMessages: [{ message: JSON.stringify(msg) }],
            supersedenceTracking: { enabled: true, algo: 'latest-wins', key: toSupersedenceKey(msg) }
        }),
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
    try {
        await runtime.ready();
        for (const payloadBytes of WORKLOAD.payloadBytes) {
            for (let update = 0; update < WORKLOAD.updateCount; update += 1) {
                for (const peerId of WORKLOAD.recipientPeerIds) {
                    await enqueueOutboundOrThrow(
                        runtime,
                        toVolatileIdentity(createUpdate({ payloadBytes, update, peerId }), volatileStores)
                    );
                }
            }
        }
        await runOutboundWorkTask(runtime);
        if (volatileStores !== undefined) {
            await settleWork(volatileStores.workQueue, () => true);
        }
    }
    finally {
        runtime.dispose();
    }
}

function toVolatileIdentity(msg: ALMessage, volatileStores: object | undefined): ALMessage {
    return volatileStores === undefined ? msg : { ...msg, id: { ...msg.id, msgId: `${msg.id.msgId}-volatile` } };
}

function sumTopicBytes(leg: ALStorageLeg): number {
    return Object.values(leg.bytesByTopic).reduce((total, bytes) => total + bytes, 0);
}

function countRows(leg: ALStorageLeg): number {
    return Object.values(leg.rowsByStatus).reduce((total, rows) => total + rows, 0);
}

/** A footprint regression has to move these figures deliberately, not drift into them. */
function expectBytesWithinBand(actual: number | undefined, expected: number, topic: string): void {
    const measured = actual ?? 0;
    const band = `${topic}: measured ${measured} bytes against ${expected} +/- ${BYTES_TOLERANCE * 100}%`;
    expect(measured, band).toBeGreaterThanOrEqual(Math.floor(expected * (1 - BYTES_TOLERANCE)));
    expect(measured, band).toBeLessThanOrEqual(Math.ceil(expected * (1 + BYTES_TOLERANCE)));
}

/** The same updates seen from the other side: each recipient peer is the sender, this peer the target. */
function createInboundUpdate(
    input: Readonly<{ payloadBytes: number; update: number; peerId: string; }>
): ALMessage {
    return newALUnicastMessage(
        input.peerId,
        { topicId: 'snapshot', resourceId: `size-${input.payloadBytes}`, contextId: 'conversation-1' },
        SELF_PEER_ID,
        'snapshot.update.v1',
        toPayloadResource(input.payloadBytes, input.update),
        { ttlMs: 300_000 }
    );
}

/** With a memory pair beside the IndexedDB pair, the messages request no durability and take the volatile lane. */
async function admitInboundWorkload(volatileStores: ALVolatileInboundRuntimeStores | undefined): Promise<void> {
    const stores = createDefaultIndexedDbALInboundRuntimeStores({
        dbName: INBOUND_DB_NAME,
        namespace: INBOUND_NAMESPACE
    });
    const runtime = new ALInboundMessageRuntime({
        carrier: 'ws',
        ...createDefaultALInboundRuntimeResources({
            selfPeerId: SELF_PEER_ID,
            toInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'inbox'),
            stores,
            volatileStores
        }),
        planIncomingMessage: (msg, source, observations) => planInboundMessage(msg, source, observations),
        dispatchInboxEntry: async (entry) => {
            decodePersistedALMessage(entry.resource);
        },
        sendControlMessages: async () => {},
        diagnostics: undefined
    });
    try {
        await runtime.ready();
        for (const payloadBytes of WORKLOAD.payloadBytes) {
            for (let update = 0; update < WORKLOAD.updateCount; update += 1) {
                for (const peerId of WORKLOAD.recipientPeerIds) {
                    await runtime.admitIncomingMessage(
                        toVolatileIdentity(createInboundUpdate({ payloadBytes, update, peerId }), volatileStores),
                        {
                            kind: 'ws-client',
                            peerId,
                            authenticatedScope: { applicationId: 'app-1', workspaceId: 'workspace-1' }
                        }
                    );
                }
            }
        }
        const settled = volatileStores ?? stores;
        const typeId = toALInboundWorkType(settled.admissionStore.namespace, 'ws');
        await settleWork(settled.workQueue, (entry) => entry.typeId === typeId);
    }
    finally {
        runtime.dispose();
    }
}

function planInboundMessage(
    msg: ALMessage,
    source: ALInboundMessageRuntime.Source,
    observations: ALMessagePlanningObservations
): ALMessageHandlingPlan {
    return planALMessageHandling(msg, {
        ...observations,
        selfPeerId: SELF_PEER_ID,
        fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId
    });
}

/** A worker that owns its own engine runs on its own schedule, so the snapshot waits for its rows to reach a terminal status. */
async function settleWork(
    workQueue: QueueBoxResourceEntryRepository,
    isOwned: (entry: ResourceEntry) => boolean
): Promise<void> {
    for (let attempt = 0; attempt < INBOUND_SETTLE_ATTEMPT_LIMIT; attempt += 1) {
        if (!await hasPendingWork(workQueue, isOwned)) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(await hasPendingWork(workQueue, isOwned)).toBe(false);
}

async function hasPendingWork(
    workQueue: QueueBoxResourceEntryRepository,
    isOwned: (entry: ResourceEntry) => boolean
): Promise<boolean> {
    const entries = await Promise.all((await workQueue.getAllKeys()).map((key) => workQueue.getItem(key)));
    return entries.some((entry) => entry !== undefined && isOwned(entry) && NOT_COMPLETED_RETRYABLE_STATUSES.has(entry.status));
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

async function readALStorageSnapshot(): Promise<Omit<ALStorageSnapshot, 'volatile'>> {
    const db = await openIndexedDbAdmissionDatabase({
        dbName: DB_NAME,
        storeName: ADMISSION_STORE_NAME,
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {}
    });
    try {
        return {
            workload: WORKLOAD,
            ...await readALStorageLeg(db),
            inbound: await readInboundALStorageLeg(),
            measuredAt: readCommit()
        };
    }
    finally {
        db.close();
    }
}

async function readInboundALStorageLeg(): Promise<ALStorageLeg> {
    const db = await openIndexedDbAdmissionDatabase({
        dbName: INBOUND_DB_NAME,
        storeName: ADMISSION_STORE_NAME,
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {}
    });
    try {
        return await readALStorageLeg(db);
    }
    finally {
        db.close();
    }
}

async function readALStorageLeg(db: IDBDatabase): Promise<ALStorageLeg> {
    const work = await readStoredRows(db, AL_ADMISSION_WORK_STORE_NAME);
    const admission = await readStoredRows(db, ADMISSION_STORE_NAME);
    return {
        rowsByStatus: countRowsByStatus(work),
        bytesByTopic: { ...sumBytesByTopic(work), [ADMISSION_TOPIC_ID]: sumBytes(admission) }
    };
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
        status: 'status' in value && typeof value.status === 'string' ? value.status : 'missing',
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

/**
 * The commit only labels an artifact a caller explicitly asked for; the test path never shells out,
 * so a run in a worktree or a detached checkout costs nothing and cannot fail on git.
 */
function readCommit(): string {
    return process.env['RALLAR_ALM_SNAPSHOT_COMMIT'] ?? 'unrecorded';
}

function repositoryRoot(): string {
    return path.resolve(import.meta.dirname, '../../../..');
}
