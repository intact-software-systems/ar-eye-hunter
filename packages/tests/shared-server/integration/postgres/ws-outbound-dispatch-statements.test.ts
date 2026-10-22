import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { createPSqlALOutboundRuntimeStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import {
    computeWsOutboxProvenanceDigest,
    toWsOutboxProvenanceKey,
    WS_OUTBOX_PROVENANCE_NAMESPACE,
    WsOutboxProvenanceReader,
    type WsOutboxProvenance
} from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundCapturedPolicy } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { AL_OUTBOUND_WORK_PAGE_SIZE } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import type { ALOutboundDequeuedAdmission } from '@shared/alm/outbound/lane/al-outbound-dequeued-admission.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
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

// A WS lane claims every WS_OUTBOX row of its database, so the test runs on the API schema of its own.
describe('Postgres WS outbound dispatch statements', () => {
    // Re-reading each row's captured policy (its stored row, then its identity row) after the NOTIFY cost 48 sequential
    // statements per full page of one sender; the policy its commit wrote is in hand, so only the NOTIFYs remain.
    postgresIt('publishes a dequeued page with one autocommit NOTIFY per row and no read back, each before its send', async () => {
        const storage = await createResourceInboxTestStorage('ws_dispatch', 4);
        try {
            await measurePageDispatch(storage.sql, crypto.randomUUID());
        }
        finally {
            await storage.close();
        }
    }, 60_000);
});

const WS_SCOPE = { applicationId: 'dispatch-statements-test', workspaceId: 'workspace' };

/** Dispatches one page of raw WS rows from one sender and checks the statements between its commit and its release. */
async function measurePageDispatch(sql: PSqlSql, runId: string): Promise<void> {
    const log: PostgresStatementLog = { statements: [], transactions: 0 };
    const recorded = recordPostgresStatements(sql, log, null);
    const lane = createWsDispatchLane(recorded, runId, log);
    try {
        const rows = await writeProvedWsRows(recorded, runId);
        for (const row of rows) {
            await lane.stores.workQueue.enqueue(row);
        }

        await lane.engine.executeOnce();
        await expect.poll(() => lane.dispatch.settled(), { timeout: 45_000 }).toBe(true);

        const dispatched = lane.dispatch.statements(log.statements);
        expect(dispatched.map(({ text }) => text), dispatched.map(({ text }) => text.slice(0, 80)).join('\n'))
            .toEqual(rows.map(() => 'select pg_notify(?, ?)'));
        expect(dispatched.filter(({ transaction }) => transaction === null)).toHaveLength(rows.length);
        expect(lane.effects).toEqual(rows.flatMap((row) => [`notify:${row.key.resourceId}`, `send:${row.key.resourceId}`]));
        expect(lane.native.sent).toHaveLength(rows.length);
        for (const { message, entry, committedPolicy } of lane.policies) {
            expect(committedPolicy).toEqual(await lane.stores.admissionStore.readCapturedPolicy(message, entry));
        }
        expect(lane.policies).toHaveLength(rows.length);
    }
    finally {
        await lane.dispose();
    }
}

interface HandedPolicy {
    readonly message: ALMessage;
    readonly entry: ResourceEntry;
    readonly committedPolicy: ALOutboundCapturedPolicy | undefined;
}

/** The statements of one page's dispatch: after its last commit answered and before its last attempt settled. */
interface DispatchWindow {
    readonly sink: ALOutboundDequeuedAdmission.TimingSink;
    settled(): boolean;
    statements(all: readonly RecordedPostgresStatement[]): readonly RecordedPostgresStatement[];
}

function createDispatchWindow(log: PostgresStatementLog): DispatchWindow {
    let commitEnds = 0;
    let attemptsSettled = 0;
    let start: number | undefined;
    let end: number | undefined;
    return {
        sink: (observation) => {
            if (observation.kind === 'admission-stage' && observation.stage === 'admission-commit-end') {
                commitEnds += 1;
                start = commitEnds === AL_OUTBOUND_WORK_PAGE_SIZE ? log.statements.length : start;
            }
            if (observation.kind === 'attempt-settled') {
                attemptsSettled += 1;
                end = attemptsSettled === AL_OUTBOUND_WORK_PAGE_SIZE ? log.statements.length : end;
            }
        },
        settled: () => end !== undefined,
        statements: (all) => all.slice(start, end)
    };
}

interface WsDispatchLane {
    readonly stores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
    readonly engine: InboxOutboxEngine;
    readonly native: TestWebSocket;
    readonly dispatch: DispatchWindow;
    readonly effects: readonly string[];
    readonly policies: readonly HandedPolicy[];
    dispose(): Promise<void>;
}

/** A WS server whose outbound lane, producer proofs and cluster NOTIFYs all run on one recorded Postgres client. */
function createWsDispatchLane(sql: PSqlSql, runId: string, log: PostgresStatementLog): WsDispatchLane {
    const repository = new PSqlRuntimeStateRepository(sql);
    const stores = createPSqlALOutboundRuntimeStores({
        repository,
        namespace: `ws-dispatch-statements-${runId}`,
        nowMs: Date.now,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: undefined,
        decodePrepared: decodeWsQueueBoxServerPreparedMessage
    });
    const proofs = new WsOutboxProvenanceReader({ repository, nowMs: Date.now });
    const socket = new JsonWebSocketServer();
    const native = new TestWebSocket('ws://peer');
    native.open();
    socket.addConnection(new ConnectionContext({ id: 'peer', socket: native }));
    const engine = new InboxOutboxEngine();
    const dispatch = createDispatchWindow(log);
    const service = createDefaultWsQueueBoxServerService({
        name: 'server',
        inboundVolatileStores: undefined,
        socket,
        outbox: stores.workQueue,
        outboundStores: stores,
        queueEngine: engine,
        dequeueTiming: dispatch.sink,
        targetResolver: { resolveBroadcastRecipients: () => [{ peerId: 'peer', connectionId: 'peer' }] },
        readAuthenticatedConnectionScope: () => ({ scope: WS_SCOPE, expiresAtEpochMs: Date.now() + 30_000 }),
        readProducerProvenance: (message, entry) => proofs.readProducerProvenance(message, entry)
    });
    const effects: string[] = [];
    const policies: HandedPolicy[] = [];
    const readCapturedPolicy = service.readCapturedPolicy.bind(service);
    vi.spyOn(service, 'readCapturedPolicy').mockImplementation(async (message, entry, committedPolicy) => {
        policies.push({ message, entry, committedPolicy });
        return await readCapturedPolicy(message, entry, committedPolicy);
    });
    const sendToTargetsWithResult = service.sendToTargetsWithResult.bind(service);
    vi.spyOn(service, 'sendToTargetsWithResult').mockImplementation((input) => {
        effects.push(`send:${input.message.route.resourceId}`);
        return sendToTargetsWithResult(input);
    });
    void installQueueBoxPubSubBridge({
        wsQBoxServerService: service,
        channel: 'ws-dispatch-statements',
        publisherId: 'server',
        bridge: {
            publish: async (channel, notice) => {
                effects.push(`notify:${notice.key.resourceId}`);
                await sql`select pg_notify(${channel}, ${runId})`;
            },
            subscribe: async () => undefined
        }
    });
    return {
        stores,
        engine,
        native,
        dispatch,
        effects,
        policies,
        dispose: async () => {
            vi.restoreAllMocks();
            await Promise.all([service.dispose(), engine.stop()]);
        }
    };
}

/** One page of raw WS rows to one connected peer, each with the producer proof its dequeue verifies. */
async function writeProvedWsRows(sql: PSqlSql, runId: string): Promise<ResourceEntry[]> {
    const repository = new PSqlRuntimeStateRepository(sql);
    const rows: ResourceEntry[] = [];
    for (let index = 0; index < AL_OUTBOUND_WORK_PAGE_SIZE; index += 1) {
        const message = newALUnicastMessage(
            'server',
            { topicId: 'snapshot', resourceId: `page-${runId}-${index}`, contextId: `request-${index % 4}` },
            'peer',
            'snapshot.v1',
            {},
            { ttlMs: 30_000, qos: { durability: { algo: 'local-outbox' } } }
        );
        const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX, Temporal.Now.instant());
        const facts: Omit<WsOutboxProvenance, 'digest'> = {
            version: 1,
            producerKind: 'state-sync',
            queueKey: entry.key,
            typeId: entry.typeId,
            messageId: message.id.msgId,
            senderId: message.id.senderId,
            expiresAtMs: entry.audit.expiryTs.epochMilliseconds,
            target: { kind: 'scoped-unicast', peerId: 'peer', scope: WS_SCOPE, admittedAudience: ['peer'] }
        };
        const proof = { ...facts, digest: computeWsOutboxProvenanceDigest(entry, facts) };
        await repository.upsert(
            WS_OUTBOX_PROVENANCE_NAMESPACE,
            toWsOutboxProvenanceKey(entry.key),
            JSON.stringify(proof),
            proof.expiresAtMs
        );
        rows.push(entry);
    }
    return rows;
}
