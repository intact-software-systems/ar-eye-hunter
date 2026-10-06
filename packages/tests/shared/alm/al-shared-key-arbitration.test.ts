import '../../setup-browser-indexeddb.ts';

import {
    describe,
    expect,
    it,
    onTestFinished
} from 'vitest';

import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import type { ALAdmissionWorkBackend } from '@shared/alm/al-admission-work-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { computeALInboundAdmission } from '@shared/alm/inbound/admission/compute-al-inbound-admission.ts';
import {
    createALInboundAdmissionStore,
    type ALInboundAdmissionStore,
    type ALInboundCommitBundle
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { computeALInboundPlanningObservations } from '@shared/alm/inbound/al-inbound-planner-snapshot.ts';
import { toALInboundMessageOwnerKey } from '@shared/alm/inbound/al-inbound-source-validation.ts';
import { readALInboundEffectFacts } from '@shared/alm/inbound/prepare-al-inbound-commit-bundle.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import type { IndexedDbAdmissionStoredRow } from '@shared/alm/indexed-db-admission-row.ts';
import {
    AL_ADMISSION_SCHEMA_ID,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import {
    toALOutboundSentMessageKey,
    toALOutboundSupersedenceLatestKey,
    toALOutboundVersionKey
} from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
import {
    createALOutboundAdmissionStore,
    type ALOutboundAdmissionStore,
    type ALOutboundCommitBundle,
    type ALOutboundPlanner
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { computeALOutboundDispatch, type ALOutboundComputedDto } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { readIndexedDbRequest } from '@shared/persistence/indexed-db-request.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import { createPSqlAdmissionTestStorage } from '../../shared-server/al-runtime/postgres/create-p-sql-admission-test-storage.ts';
import {
    computeOutboundTestAdmission,
    createOutboundCanonicalEntry,
    createOutboundMessage
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

const ADMISSION_STORE_NAME = 'admission';
const ABSENT_ROW = 'absent';

type ArbitrationStorage = 'memory' | 'indexeddb' | 'pglite';

type CommitOutcome = 'committed' | 'conflict' | 'expired';

interface ArbitrationFixture {
    readonly namespace: string;
    readonly backend: ALAdmissionWorkBackend;
    /**
     * The row at one key exactly as the backend holds it, or `ABSENT_ROW`: IndexedDB and PostgreSQL
     * rows carry the revision their commits fence on, the memory backend holds the stored value
     * alone, so an unchanged witness is an unchanged row on every backend.
     */
    readonly readRow: (key: string) => Promise<string>;
}

/**
 * A reads, B reads, B commits, A commits. `arbitratedKey` is the key both decisions write and whose
 * guard decides the schedule; `keyOnlyAWrites` is one A alone would write, so its absence after the
 * schedule is the proof A wrote nothing.
 */
interface StaleReadThenSequentialCommitSchedule<TDecision> {
    readonly fixture: ArbitrationFixture;
    readonly arbitratedKey: string;
    readonly keyOnlyAWrites: string;
    readonly readA: () => Promise<TDecision>;
    readonly readB: () => Promise<TDecision>;
    readonly commitB: (decision: TDecision) => Promise<CommitOutcome>;
    readonly commitA: (decision: TDecision) => Promise<CommitOutcome>;
}

describe.each(['memory', 'indexeddb', 'pglite'] as const)('shared-key arbitration over %s', (storage) => {
    it('decides on the inbound dedup key: one semantic key, two senders', async () => {
        const fixture = await createArbitrationFixture(storage);
        const store = createInboundStore(fixture);
        const dedup = { algo: 'semantic-key' as const, opts: { semanticKey: 'same-command' } };
        const first = createInboundMessage('sender-a', 1, 'first-topic');
        const second = createInboundMessage('sender-b', 2, 'second-topic');
        const a = { ...first, qos: { ...first.qos, dedup } };
        const b = { ...second, qos: { ...second.qos, dedup } };

        await runStaleReadThenSequentialCommit({
            fixture,
            arbitratedKey: `${fixture.namespace}:dedup:${toInboundDedupKey(a)}`,
            keyOnlyAWrites: toALInboundMessageOwnerKey(fixture.namespace, a.id.msgId, a.id.senderId),
            readA: () => readInboundDecision(store, a),
            readB: () => readInboundDecision(store, b),
            commitB: (decision) => store.commitBundle(decision.bundle),
            commitA: (decision) => store.commitBundle(decision.bundle)
        });

        expect((await readInboundDecision(store, a)).plan.dropReason).toContain('Duplicate message');
    });

    it('decides on the inbound supersedence latest: one supersedence key, two senders', async () => {
        const fixture = await createArbitrationFixture(storage);
        const store = createInboundStore(fixture);
        const a = createInboundMessage('sender-a', 1, 'shared-topic');
        const b = createInboundMessage('sender-b', 2, 'shared-topic');

        await runStaleReadThenSequentialCommit({
            fixture,
            arbitratedKey: `${fixture.namespace}:supersedence:latest:shared-topic`,
            keyOnlyAWrites: toALInboundMessageOwnerKey(fixture.namespace, a.id.msgId, a.id.senderId),
            readA: () => readInboundDecision(store, a),
            readB: () => readInboundDecision(store, b),
            commitB: (decision) => store.commitBundle(decision.bundle),
            commitA: (decision) => store.commitBundle(decision.bundle)
        });

        expect((await readInboundDecision(store, a)).plan.supersedence.status).toBe('superseded');
    });

    it('decides on the inbound ordering track: one track, two sequences', async () => {
        const fixture = await createArbitrationFixture(storage);
        const store = createInboundStore(fixture);
        const a = { ...createInboundMessage('same-sender', 1, 'first-topic'), ordering: { orderingKey: 'ordered', seq: 1 } };
        const b = { ...createInboundMessage('same-sender', 2, 'second-topic'), ordering: { orderingKey: 'ordered', seq: 2 } };

        await runStaleReadThenSequentialCommit({
            fixture,
            arbitratedKey: `${fixture.namespace}:ordering:${toALOrderingTrackKey(a)}`,
            keyOnlyAWrites: toALInboundMessageOwnerKey(fixture.namespace, a.id.msgId, a.id.senderId),
            readA: () => readInboundDecision(store, a),
            readB: () => readInboundDecision(store, b),
            commitB: (decision) => store.commitBundle(decision.bundle),
            commitA: (decision) => store.commitBundle(decision.bundle)
        });

        const recomputed = await readInboundDecision(store, a);
        expect(recomputed.plan.orderingRuntime.releasableSeqs).toEqual([2]);
        expect(await store.commitBundle(recomputed.bundle)).toBe('committed');
    });

    it('decides on the outbound supersedence latest: one supersedence key, two senders', async () => {
        const fixture = await createArbitrationFixture(storage);
        const store = await createOutboundStore(fixture);
        const a = createSupersedingOutboundMessage('sender-a', 1);
        const b = createSupersedingOutboundMessage('sender-b', 2);

        await runStaleReadThenSequentialCommit({
            fixture,
            arbitratedKey: toALOutboundSupersedenceLatestKey(fixture.namespace, 'shared-topic'),
            keyOnlyAWrites: toALOutboundSentMessageKey(fixture.namespace, a.id.msgId),
            readA: () => readSupersedingOutboundBundle(store, a),
            readB: () => readSupersedingOutboundBundle(store, b),
            commitB: (bundle) => store.commitBundle(bundle),
            commitA: (bundle) => store.commitBundle(bundle)
        });

        expect((await readSupersedingOutboundDecision(store, a)).verdict.kind).toBe('superseded');
        expect((await store.readSentMessage(b.id.msgId))?.msg).toEqual(b);
    });

    it('decides on the outbound sender version: one sender, two messages', async () => {
        const fixture = await createArbitrationFixture(storage);
        const store = await createOutboundStore(fixture);
        const a = createOutboundMessage('version-loser');
        const b = createOutboundMessage('version-winner');

        await runStaleReadThenSequentialCommit({
            fixture,
            arbitratedKey: toALOutboundVersionKey(fixture.namespace, a.id.senderId),
            keyOnlyAWrites: toALOutboundSentMessageKey(fixture.namespace, a.id.msgId),
            readA: () => computeOutboundTestAdmission(store, a, OUTBOUND_ONE_COPY_PLANNER),
            readB: () => computeOutboundTestAdmission(store, b, OUTBOUND_ONE_COPY_PLANNER),
            commitB: (bundle) => store.commitBundle(bundle),
            commitA: (bundle) => store.commitBundle(bundle)
        });

        expect(await store.commitBundle(await computeOutboundTestAdmission(store, a, OUTBOUND_ONE_COPY_PLANNER))).toBe('committed');
        expect((await store.readSentMessage(a.id.msgId))?.msg).toEqual(a);
    });
});

async function runStaleReadThenSequentialCommit<TDecision>(
    schedule: StaleReadThenSequentialCommitSchedule<TDecision>
): Promise<void> {
    const { fixture, arbitratedKey, keyOnlyAWrites } = schedule;
    const decisionA = await schedule.readA();
    const decisionB = await schedule.readB();

    expect(await schedule.commitB(decisionB)).toBe('committed');
    const arbitratedRow = await fixture.readRow(arbitratedKey);
    expect(arbitratedRow).not.toBe(ABSENT_ROW);
    expect(await schedule.commitA(decisionA)).toBe('conflict');

    expect(await fixture.readRow(arbitratedKey)).toBe(arbitratedRow);
    expect(await fixture.readRow(keyOnlyAWrites)).toBe(ABSENT_ROW);
}

async function createArbitrationFixture(storage: ArbitrationStorage): Promise<ArbitrationFixture> {
    const namespace = `arbitration-${crypto.randomUUID()}`;
    switch (storage) {
        case 'memory':
            return createMemoryArbitrationFixture(namespace);
        case 'indexeddb':
            return createIndexedDbArbitrationFixture(namespace);
        case 'pglite':
            return await createPGliteArbitrationFixture(namespace);
    }
}

function createMemoryArbitrationFixture(namespace: string): ArbitrationFixture {
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
    return { namespace, backend, readRow: async (key) => toRowWitness(backend.peek(key)) };
}

function createIndexedDbArbitrationFixture(namespace: string): ArbitrationFixture {
    onTestFinished(() => deleteIndexedDbDatabase(namespace));
    const backend = new IndexedDbAdmissionBackend({
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {},
        dbName: namespace,
        storeName: ADMISSION_STORE_NAME,
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer: createPassThroughIndexedDbOperationObserver()
    });
    return { namespace, backend, readRow: (key) => readIndexedDbRow(namespace, key) };
}

async function createPGliteArbitrationFixture(namespace: string): Promise<ArbitrationFixture> {
    const { sql, repository } = await createPSqlAdmissionTestStorage();
    return {
        namespace,
        backend: new PSqlAdmissionWorkBackend(sql, namespace),
        readRow: async (key) => toRowWitness(await repository.findEntry(namespace, key))
    };
}

async function readIndexedDbRow(dbName: string, key: string): Promise<string> {
    const db = await openIndexedDbAdmissionDatabase({
        dbName,
        storeName: ADMISSION_STORE_NAME,
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {}
    });
    try {
        const row: IndexedDbAdmissionStoredRow | undefined = await readIndexedDbRequest(
            db.transaction(ADMISSION_STORE_NAME, 'readonly').objectStore(ADMISSION_STORE_NAME).get(key)
        );
        return toRowWitness(row);
    }
    finally {
        db.close();
    }
}

function deleteIndexedDbDatabase(dbName: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const deletion = indexedDB.deleteDatabase(dbName);
        deletion.onsuccess = () => resolve();
        deletion.onerror = () => reject(deletion.error);
        deletion.onblocked = () => reject(new Error('Owned admission database deletion is blocked'));
    });
}

function toRowWitness(row: object | undefined): string {
    return row === undefined ? ABSENT_ROW : JSON.stringify(row);
}

function createInboundStore(fixture: ArbitrationFixture): ALInboundAdmissionStore {
    return createALInboundAdmissionStore({
        nowMs: Date.now,
        namespace: fixture.namespace,
        backend: fixture.backend,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
}

function createInboundMessage(senderId: string, version: number, supersedenceKey: string): ALMessage {
    const message = newALUnicastMessage(
        senderId,
        { topicId: 'latest-values', resourceId: crypto.randomUUID(), contextId: 'receiver' },
        'receiver',
        'latest-value.v1',
        { version },
        {
            qos: {
                delivery: { algo: 'best-effort' },
                ack: { algo: 'none' },
                durability: { algo: 'volatile' },
                supersedence: { algo: 'latest-wins', opts: { supersedenceKey } }
            }
        }
    );
    const createdTs = Date.now() - 1_000 + version;
    return { ...message, id: { ...message.id, ts: createdTs }, audit: { ...message.audit, createdTs } };
}

function toInboundDedupKey(message: ALMessage): string {
    return planALMessageHandling(message, toInboundPlanningContext(message, Date.now())).dedupKey;
}

function toInboundPlanningContext(message: ALMessage, nowMs: number) {
    return { selfPeerId: 'receiver', fromPeerId: message.id.senderId, nowMs };
}

interface InboundDecision {
    readonly plan: ReturnType<typeof planALMessageHandling>;
    readonly bundle: ALInboundCommitBundle;
}

async function readInboundDecision(store: ALInboundAdmissionStore, message: ALMessage): Promise<InboundDecision> {
    const nowMs = Date.now();
    const context = toInboundPlanningContext(message, nowMs);
    const read = await store.readIncomingMessage({
        msg: message,
        source: {
            kind: 'ws-client',
            peerId: message.id.senderId,
            authenticatedScope: { applicationId: 'app', workspaceId: 'workspace' }
        },
        nowMs,
        prePlan: planALMessageHandling(message, context)
    });
    const plan = planALMessageHandling(message, { ...context, ...computeALInboundPlanningObservations(read) });
    const facts = readALInboundEffectFacts(nowMs, {
        newControlId: crypto.randomUUID.bind(crypto),
        selfPeerId: 'receiver',
        createInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'inbox')
    });
    return {
        plan,
        bundle: computeALInboundAdmission({ read, plan, facts, canForward: false, recordedParentPresent: true })
    };
}

async function createOutboundStore(fixture: ArbitrationFixture): Promise<ALOutboundAdmissionStore<OutboundTestPayload>> {
    const store = createALOutboundAdmissionStore({
        nowMs: Date.now,
        canonicalScope: fixture.namespace,
        namespace: fixture.namespace,
        decodePrepared: decodeOutboundTestPayload,
        backend: fixture.backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    await store.ready();
    return store;
}

/** One volatile copy per message, so the sent-message row is the write a losing sender must not land. */
const OUTBOUND_ONE_COPY_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg) => ({
    msg,
    dropReasonCode: undefined,
    lane: 'volatile',
    preparedMessages: [{ text: msg.id.msgId }]
});

function createSupersedingOutboundMessage(senderId: string, sequence: number): ALMessage {
    const message = createOutboundMessage(`superseding-${sequence}`);
    return { ...message, id: { ...message.id, senderId }, ordering: { orderingKey: 'shared-topic', seq: sequence } };
}

async function readSupersedingOutboundDecision(
    store: ALOutboundAdmissionStore<OutboundTestPayload>,
    message: ALMessage
): Promise<ALOutboundComputedDto<OutboundTestPayload>> {
    const read = await store.readOutgoingMessage({
        msg: message,
        planner: (msg, authority) => ({
            ...OUTBOUND_ONE_COPY_PLANNER(msg, authority),
            supersedenceTracking: { enabled: true, algo: 'latest-wins', key: 'shared-topic' }
        }),
        observedCanonicalEntry: undefined,
        intent: 'enqueue'
    });
    return computeALOutboundDispatch({
        read,
        outboxEntry: createOutboundCanonicalEntry(store, read.msg),
        dispatchAtMs: Date.now(),
        intent: 'enqueue',
        phase: 'immediate',
        options: {}
    });
}

async function readSupersedingOutboundBundle(
    store: ALOutboundAdmissionStore<OutboundTestPayload>,
    message: ALMessage
): Promise<ALOutboundCommitBundle<OutboundTestPayload>> {
    const decision = await readSupersedingOutboundDecision(store, message);
    if (decision.bundle === undefined) {
        throw new Error(`Expected an outbound admission, received ${decision.verdict.kind}`);
    }
    return decision.bundle;
}
