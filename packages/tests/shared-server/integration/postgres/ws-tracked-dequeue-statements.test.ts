import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it
} from 'vitest';

import { createPSqlALOutboundRuntimeStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { computeWsOutboxInsert, writeAppOutboxInserts } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import {
    WsOutboxProvenanceReader,
    type WsOutboxProvenanceFacts
} from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { newALBroadcastMessage, newALEventRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { toALOutboundAdmissionNamespace } from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundDequeuedAdmission } from '@shared/alm/outbound/lane/al-outbound-dequeued-admission.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../../../shared/websocket/test-web-socket.ts';
import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import {
    recordPostgresStatements,
    type PostgresStatementLog,
    type RecordedPostgresStatement
} from './test-support/record-postgres-statements.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

type PredecessorState = 'all-settled' | 'nearest-unstored' | 'none-stored';

interface TrackedDequeueCell {
    readonly label: string;
    readonly state: PredecessorState;
    /** Every row's sequence on the track, ascending; the last is the measured row. */
    readonly seqs: readonly number[];
}

interface TrackedDequeueCellReport {
    readonly depth: number;
    readonly state: string;
    readonly listRowCount: number;
    readonly frontReads: number;
    readonly frontStatements: number;
    readonly holds: number;
    readonly dequeueStatements: number;
    readonly recheckStatements: number;
    readonly frontMs: number;
}

const CELLS: readonly TrackedDequeueCell[] = [
    { label: 'all-settled', state: 'all-settled', seqs: toContiguousSeqs(1) },
    ...[8, 64].flatMap((depth) =>
        (['all-settled', 'nearest-unstored', 'none-stored'] as const).map((state) => ({
            label: state,
            state,
            seqs: toContiguousSeqs(depth)
        }))
    ),
    { label: 'non-contiguous', state: 'all-settled', seqs: Array.from({ length: 64 }, (_seq, k) => 1 + 3 * k) }
];

// A WS lane claims every WS_OUTBOX row of its database, so each cell runs on an API schema of its own.
describe('Postgres tracked WS dequeue statements', () => {
    for (const cell of CELLS) {
        postgresIt(`reports the dequeue cost of a tracked row at depth ${cell.seqs.length}, ${cell.label}`, async () => {
            const storage = await createResourceInboxTestStorage('ws_tracked', 4);
            try {
                const { report, recheckCalls } = await measureTrackedDequeue(storage.sql, cell);
                console.info(`6b-cell ${JSON.stringify(report)}`);
                // The track's prefix list returns the measured row's own index row beside its predecessors'.
                expect(report.listRowCount).toBe(cell.seqs.length === 1 ? 0 : cell.seqs.length);
                expect(report.frontReads).toBe(toExpectedFrontReads(cell));
                if (cell.state === 'all-settled') {
                    expect(report.holds).toBe(0);
                }
                else {
                    expect(report.holds).toBeGreaterThanOrEqual(1);
                }
                // The dequeue of a non-frozen row runs no re-check today.
                expect(recheckCalls).toBe(0);
            }
            finally {
                await storage.close();
            }
        }, 120_000);
    }
});

function toContiguousSeqs(depth: number): readonly number[] {
    return Array.from({ length: depth }, (_seq, index) => index + 1);
}

/** The own row, the list and the predecessors read down to the first settled one; a first sequence reads nothing. */
function toExpectedFrontReads(cell: TrackedDequeueCell): number {
    const depth = cell.seqs.length;
    if (depth === 1) {
        return 0;
    }
    return { 'all-settled': 3, 'nearest-unstored': 4, 'none-stored': 2 + (depth - 1) }[cell.state];
}

const WS_SCOPE = { applicationId: 'tracked-dequeue-test', workspaceId: 'workspace' };
const GROUP = { ...WS_SCOPE, groupId: 'room' };

interface TrackedDequeueMeasurement {
    readonly report: TrackedDequeueCellReport;
    readonly recheckCalls: number;
}

/** Writes the cell's predecessors, then dequeues its last row and reports what that dequeue cost. */
async function measureTrackedDequeue(sql: PSqlSql, cell: TrackedDequeueCell): Promise<TrackedDequeueMeasurement> {
    const runId = crypto.randomUUID();
    const log: PostgresStatementLog = { statements: [], transactions: 0 };
    const recorded = recordPostgresStatements(sql, log, null);
    const lane = createTrackedDequeueLane(recorded, runId, log);
    try {
        const rows = cell.seqs.map((seq) => createTrackedRow(runId, seq));
        const measured = rows.at(-1)!;
        const unstored = await writePredecessors(lane, cell.state, rows.slice(0, -1));
        const trackKey = toALOrderingTrackKey(measured.message)!;
        const listed = await lane.stores.admissionStore.listOrderingMessages(trackKey);
        expect(listed.map(({ seq }) => seq)).toEqual(cell.seqs.slice(0, -1));

        lane.probe.measure(measured.message.id.msgId, () => writeTrackIndexEnds(lane.stores, trackKey, unstored));
        await writeTrackedRows(lane, [measured], 'queued');
        await expect.poll(() => lane.probe.completed(), { timeout: 60_000 }).toBe(true);
        await lane.probe.released();
        return {
            report: toCellReport(cell, lane.probe.admissions(), log.statements),
            recheckCalls: lane.recheckCalls()
        };
    }
    finally {
        await lane.dispose();
    }
}

interface TrackedRow {
    readonly message: ALMessage;
    readonly entry: ResourceEntry;
}

function createTrackedRow(runId: string, seq: number): TrackedRow {
    const msgId = crypto.randomUUID();
    const broadcast = newALBroadcastMessage(
        'server',
        newALEventRoute('room.round.event', GROUP.groupId, msgId),
        'room',
        'round.event.v1',
        {},
        { groupRef: GROUP, ttlMs: 60_000, recipientPeerIds: ['peer'] }
    );
    const message: ALMessage = {
        ...broadcast,
        id: { ...broadcast.id, msgId },
        ordering: { orderingKey: `track-${runId}`, epoch: 1, seq }
    };
    return { message, entry: QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX, Temporal.Now.instant()) };
}

/**
 * The cell's predecessors as its state names them, returning the ones written without a stored row: those keep only
 * their index row, since their outbox row is deleted before any dequeue sees it.
 */
async function writePredecessors(
    lane: TrackedDequeueLane,
    state: PredecessorState,
    predecessors: readonly TrackedRow[]
): Promise<readonly TrackedRow[]> {
    const settledCount = { 'all-settled': predecessors.length, 'nearest-unstored': predecessors.length - 1, 'none-stored': 0 }[state];
    const settled = predecessors.slice(0, Math.max(0, settledCount));
    const unstored = predecessors.slice(settled.length);
    if (settled.length > 0) {
        await writeTrackedRows(lane, settled, 'queued');
        await expect.poll(() => readCompletedCount(lane.stores, settled), { timeout: 90_000 }).toBe(settled.length);
    }
    if (unstored.length > 0) {
        await writeTrackedRows(lane, unstored, 'index-only');
    }
    return unstored;
}

/** Each row through the production writer, its outbox row, index row and proof in one statement. */
async function writeTrackedRows(
    lane: TrackedDequeueLane,
    rows: readonly TrackedRow[],
    kept: 'queued' | 'index-only'
): Promise<void> {
    const inserts = rows.map(({ message, entry }) =>
        computeWsOutboxInsert({ entry, admissionNamespace: lane.admissionNamespace, provenance: toRoomProvenance(message, entry) })
    );
    await lane.sql.begin(async (transaction) => {
        await writeAppOutboxInserts(transaction, inserts);
        for (const { message } of kept === 'index-only' ? rows : []) {
            await transaction`delete from resource_inbox where ri_resource_id = ${message.id.msgId}`;
        }
    });
    if (kept === 'queued') {
        lane.engine.wakeAfterExternalWrite(new Set([EnqueuedType.WS_OUTBOX]));
    }
}

function toRoomProvenance(message: ALMessage, entry: ResourceEntry): WsOutboxProvenanceFacts {
    return {
        message,
        producerKind: 'room-application',
        target: { kind: 'scoped-room-broadcast', groupRef: GROUP, admittedAudience: ['peer'] },
        expiresAtMs: entry.audit.expiryTs.epochMilliseconds
    };
}

async function readCompletedCount(
    stores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>,
    rows: readonly TrackedRow[]
): Promise<number> {
    const items = await Promise.all(rows.map(({ entry }) => stores.workQueue.getItem(entry.key)));
    return items.filter((item) => item?.status === EntityStatus.COMPLETED).length;
}

/**
 * Ends every unstored predecessor's index row, the nearest last: the held row's re-check reads only the nearest, so
 * it is released once no lower sequence is left to hold it again.
 */
async function writeTrackIndexEnds(
    stores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>,
    trackKey: string,
    unstored: readonly TrackedRow[]
): Promise<void> {
    for (const { message } of unstored) {
        const answer = await stores.admissionStore.commitOrderingMessageEnd({
            trackKey,
            seq: message.ordering!.seq!,
            msgId: message.id.msgId
        });
        expect(answer).toBe('deleted');
    }
}

/** The store reads, statements and clock at one admission stage of the measured row. */
interface StageMark {
    readonly stage: ALOutboundDequeuedAdmission.TimingStage;
    readonly outcome: string | undefined;
    readonly reads: number;
    readonly statements: number;
    readonly atMs: number;
}

/** One dequeue of the measured row, from its `admission-start`. */
type AdmissionMarks = StageMark[];

interface TrackedDequeueProbe {
    readonly sink: ALOutboundDequeuedAdmission.TimingSink;
    /** Measures the row `msgId` from its next dequeue on; `release` runs once, at its first held front. */
    measure(msgId: string, release: () => Promise<void>): void;
    completed(): boolean;
    released(): Promise<void>;
    admissions(): readonly AdmissionMarks[];
}

const MEASURED_STAGES: ReadonlySet<ALOutboundDequeuedAdmission.TimingStage> = new Set([
    'admission-start',
    'pending-authority-read-start',
    'pending-authority-read-end',
    'admission-end'
]);

function createTrackedDequeueProbe(log: PostgresStatementLog, readReadCount: () => number): TrackedDequeueProbe {
    const admissions: AdmissionMarks[] = [];
    let measured: Readonly<{ msgId: string; release: () => Promise<void>; }> | undefined;
    let release: Promise<void> | undefined;
    let completed = false;
    return {
        sink: (observation) => {
            if (observation.kind === 'attempt-settled') {
                const msgId = observation.settlement.claim.entry.key.resourceId;
                completed ||= msgId === measured?.msgId && observation.outcome === 'completed';
                return;
            }
            if (
                observation.kind !== 'admission-stage' || !MEASURED_STAGES.has(observation.stage) ||
                observation.member.effect.entry.key.resourceId !== measured?.msgId
            ) {
                return;
            }
            const mark = {
                stage: observation.stage,
                outcome: observation.outcome,
                reads: readReadCount(),
                statements: log.statements.length,
                atMs: performance.now()
            };
            if (mark.stage === 'admission-start') {
                admissions.push([]);
            }
            admissions.at(-1)?.push(mark);
            if (mark.stage === 'pending-authority-read-end' && mark.outcome !== 'ready' && release === undefined) {
                release = measured.release();
            }
        },
        measure: (msgId, onHeld) => {
            measured = { msgId, release: onHeld };
        },
        completed: () => completed,
        released: async () => await release,
        admissions: () => admissions
    };
}

const PREFIX_LIST_MARKER = 'and store_key collate "c" >= ?';

/**
 * The front and the prefix list are the row's first dequeue; the dequeue statements are those of the dequeue that
 * completed it, which is the first one too unless a predecessor held it.
 */
function toCellReport(
    cell: TrackedDequeueCell,
    admissions: readonly AdmissionMarks[],
    statements: readonly RecordedPostgresStatement[]
): TrackedDequeueCellReport {
    const first = admissions[0]!;
    const completing = admissions.at(-1)!;
    const frontStart = toStageMark(first, 'admission-start');
    const frontEnd = toStageMark(first, 'pending-authority-read-end');
    const front = statements.slice(frontStart.statements, frontEnd.statements);
    return {
        depth: cell.seqs.length,
        state: cell.label,
        listRowCount: front.find(({ text }) => text.includes(PREFIX_LIST_MARKER))?.rowCount ?? 0,
        frontReads: frontEnd.reads - frontStart.reads,
        frontStatements: front.length,
        holds: admissions.filter((marks) => toStageMark(marks, 'pending-authority-read-end').outcome !== 'ready').length,
        dequeueStatements: toStageMark(completing, 'admission-end').statements - toStageMark(completing, 'admission-start').statements,
        recheckStatements: 0,
        frontMs: Math.round((frontEnd.atMs - frontStart.atMs) * 100) / 100
    };
}

function toStageMark(marks: AdmissionMarks, stage: ALOutboundDequeuedAdmission.TimingStage): StageMark {
    const mark = marks.find((candidate) => candidate.stage === stage);
    if (mark === undefined) {
        throw new TypeError(`The measured dequeue recorded no ${stage}`);
    }
    return mark;
}

interface TrackedDequeueLane {
    readonly sql: PSqlSql;
    readonly admissionNamespace: string;
    readonly stores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
    readonly engine: InboxOutboxEngine;
    readonly probe: TrackedDequeueProbe;
    recheckCalls(): number;
    dispose(): Promise<void>;
}

/** A running WS server whose outbound lane, producer proofs and cluster NOTIFYs all run on one recorded client. */
function createTrackedDequeueLane(sql: PSqlSql, runId: string, log: PostgresStatementLog): TrackedDequeueLane {
    const repository = new PSqlRuntimeStateRepository(sql);
    const storesNamespace = `ws-tracked-dequeue-${runId}`;
    const stores = createPSqlALOutboundRuntimeStores({
        repository,
        namespace: storesNamespace,
        nowMs: Date.now,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: undefined,
        decodePrepared: decodeWsQueueBoxServerPreparedMessage
    });
    const proofs = new WsOutboxProvenanceReader({ repository, nowMs: Date.now, readPrincipalSessionIds: async () => [] });
    const socket = new JsonWebSocketServer();
    const native = new TestWebSocket('ws://peer');
    native.open();
    socket.addConnection(new ConnectionContext({ id: 'peer', socket: native }));
    const engine = new InboxOutboxEngine();
    const probe = createTrackedDequeueProbe(log, () => stores.admissionStore.getReadOperationCount());
    let recheckCalls = 0;
    const service = createDefaultWsQueueBoxServerService({
        name: 'server',
        inboundVolatileStores: undefined,
        socket,
        outbox: stores.workQueue,
        outboundStores: stores,
        queueEngine: engine,
        dequeueTiming: probe.sink,
        targetResolver: { requiresFrozenAudience: () => false, resolveBroadcastRecipients: () => [{ peerId: 'peer', connectionId: 'peer' }] },
        readAuthenticatedConnectionScope: () => ({ scope: WS_SCOPE, expiresAtEpochMs: Date.now() + 30_000 }),
        readProducerProvenance: (message, entry) => proofs.readProducerProvenance(message, entry),
        filterEligibleCapturedSessionIds: async ({ candidateSessionIds }) => {
            recheckCalls += 1;
            return candidateSessionIds;
        }
    });
    void installQueueBoxPubSubBridge({
        wsQBoxServerService: service,
        channel: 'ws-tracked-dequeue-statements',
        publisherId: 'server',
        bridge: {
            publish: async (channel) => {
                await sql`select pg_notify(${channel}, ${runId})`;
            },
            subscribe: async () => undefined
        }
    });
    engine.start();
    return {
        sql,
        admissionNamespace: toALOutboundAdmissionNamespace(storesNamespace),
        stores,
        engine,
        probe,
        recheckCalls: () => recheckCalls,
        dispose: async () => {
            await Promise.all([service.dispose(), engine.stop()]);
        }
    };
}
