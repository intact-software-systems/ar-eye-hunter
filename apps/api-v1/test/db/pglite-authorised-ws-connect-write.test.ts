import { Temporal } from '@js-temporal/polyfill';
import assert from 'node:assert/strict';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxInvariantCorruptionError } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { WS_AUTH_TICKETS_NAMESPACE } from '@shared-server/rallar-system/auth/persistence/auth-storage-keys.ts';
import type { ClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import type { AuthorisedWsClientMutationResult } from '@shared-server/rallar-system/client-state/inbox/client-state-inbox-result-codec.ts';
import { writeClientRuntimeBatch } from '@shared-server/rallar-system/client-state/mutation/write-client-mutation.ts';
import {
    toClientSnapshotProvenanceEffect,
    type ClientSnapshotProvenanceInsert
} from '@shared-server/rallar-system/client-state/persistence/client-snapshot-provenance.ts';
import { CLIENT_STATE_PRINCIPALS_NAMESPACE } from '@shared-server/rallar-system/client-state/persistence/client-state-runtime-namespaces.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { WS_OUTBOX_PROVENANCE_NAMESPACE } from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { computeRuntimeStateGuardedBatchWrite } from '@shared-server/runtime-state/guarded-batch/compute-runtime-state-guarded-batch-write.ts';
import type { RuntimeStateGuardedBatchEffect } from '@shared-server/runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { putAuthorisedWsTestTicket } from '../../../../packages/tests/shared-server/rallar-system/client-state/authorised-ws-test-ticket.ts';
import { TEST_DISCONNECTED_SESSION_RETENTION_MS } from '../../../../packages/tests/shared-server/rallar-system/client-state/test-disconnected-session-retention.ts';
import type { PGliteSql } from '../../src/db/pglite-sql-adapter.ts';
import { createApiV1TestQueueResilience } from '../api-v1-test-queue-resilience.ts';
import { FUTURE_MS, withPGliteSql } from './pglite-auth-test-harness.ts';

const SESSION: IssuedAuthSession = {
    clientId: 'player',
    username: 'player',
    sessionId: 'player-session',
    accessToken: 'player-token',
    issuedAtEpochMs: Date.now() - 1_000,
    expiresAtEpochMs: FUTURE_MS
};

interface ConnectWriteFixture {
    readonly sql: PGliteSql;
    readonly reader: InboxQueueReader;
    readonly transactions: RallarTimingEvent[];
    /** Runs once, after the next connect's own state read and before its transaction. */
    interfereAfterNextRead(write: () => Promise<void>): void;
    startConnect(generationId: string, connectedAtEpochMs?: number): Promise<StartedConnect>;
}

interface StartedConnect {
    readonly key: Key;
    readonly result: Promise<AuthorisedWsClientMutationResult | undefined>;
}

interface DurableFootprint {
    readonly runtimeRows: readonly string[];
    readonly clientEvents: number;
    readonly wsOutboxRows: number;
}

async function createConnectWriteFixture(sql: PGliteSql): Promise<ConnectWriteFixture> {
    const runtime = new PSqlRuntimeStateRepository(sql);
    const resourceInbox = createPSqlResourceInboxRepository(sql, () => new Date());
    const reader = new InboxQueueReader(new PSqlQueueBox(resourceInbox, Temporal.Now.instant), {
        newLaneConcurrency: 1
    });
    const sessions = new AuthSessionRepository(runtime);
    await sessions.putSession(SESSION);
    const transactions: RallarTimingEvent[] = [];
    const clientState = createClientStateService({
        runtimeRepository: runtime,
        clientStateEventStore: new PSqlClientStateEventRepository(sql),
        serviceId: 'connect-write'
    });
    let interference: (() => Promise<void>) | undefined;
    const interferingClientState: ClientStateService = {
        ...clientState,
        readAuthorisedWsConnect: async (input) => {
            const read = await clientState.readAuthorisedWsConnect(input);
            const write = interference;
            interference = undefined;
            await write?.();
            return read;
        }
    };
    const client = new AppClientInboxService({
        inboxQueueReader: reader,
        resourceInboxRepository: resourceInbox.entries,
        resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
        database: sql,
        clientStateService: interferingClientState
    }, {
        serviceId: 'connect-write',
        disconnectedSessionRetentionMs: TEST_DISCONNECTED_SESSION_RETENTION_MS,
        timing: (event) => {
            if (event.component === 'app-inbox-phase' && event.operation === 'transaction') {
                transactions.push(event);
            }
        },
        options: { waitMaxElapsedMsecs: 5_000, waitRetryIntervalMsecs: 1, waitMaxRetryIntervalMsecs: 4, waitJitterRatio: 0 }
    });
    return {
        sql,
        reader,
        transactions,
        interfereAfterNextRead: (write) => {
            interference = write;
        },
        startConnect: async (generationId, connectedAtEpochMs = Date.now()) => {
            const ticketDigest = await putAuthorisedWsTestTicket(sessions, SESSION, `${generationId}-ticket`);
            const result = client.writeAuthorisedWsClientConnect({
                authSession: SESSION,
                generationId,
                ticketDigest,
                input: { applicationId: 'app-1', workspaceId: 'default', connectedAtEpochMs }
            }).then((written) => written.right);
            return { key: await waitForQueuedConnect(sql, generationId), result };
        }
    };
}

async function waitForQueuedConnect(sql: PGliteSql, generationId: string): Promise<Key> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const [row] = await sql<{ topic: string; resource: string; context: string; }[]>`
            select ri_topic_id as topic, ri_resource_id as resource, fk_ext_bank_id as context from resource_inbox
            where ri_type_id = 'APP_INBOX' and ri_resource like ${`%${generationId}%`}
        `;
        if (row !== undefined) {
            return { topicId: row.topic, resourceId: row.resource, contextId: row.context };
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error(`The ${generationId} connect was not queued`);
}

async function dequeueOnce(fixture: ConnectWriteFixture): Promise<void> {
    await fixture.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createApiV1TestQueueResilience());
}

async function connectApplied(
    fixture: ConnectWriteFixture,
    generationId: string,
    connectedAtEpochMs = Date.now()
): Promise<void> {
    const started = await fixture.startConnect(generationId, connectedAtEpochMs);
    await dequeueOnce(fixture);
    assert.equal((await started.result)?.status, 'ok');
}

async function readDurableFootprint(sql: PGliteSql): Promise<DurableFootprint> {
    const runtimeRows = await sql<{ row: string; }[]>`
        select store_namespace || '|' || store_key || '|' || revision::text as row from runtime_state_store
        order by store_namespace, store_key
    `;
    const [events] = await sql<{ count: string; }[]>`select count(*)::text as count from client_state_events`;
    const [outbox] = await sql<{ count: string; }[]>`
        select count(*)::text as count from resource_inbox where ri_type_id = 'WS_OUTBOX'
    `;
    return {
        runtimeRows: runtimeRows.map(({ row }) => row),
        clientEvents: Number(events?.count),
        wsOutboxRows: Number(outbox?.count)
    };
}

function readLastTransaction(fixture: ConnectWriteFixture): RallarTimingEvent {
    const transaction = fixture.transactions.at(-1);
    assert.ok(transaction, 'expected a timed AppInbox transaction');
    return transaction;
}

function readConflictedTransaction(fixture: ConnectWriteFixture): RallarTimingEvent {
    const conflicted = fixture.transactions.filter((transaction) => transaction.status === 'error');
    assert.equal(conflicted.length, 1, 'expected exactly one failed AppInbox transaction');
    return conflicted[0]!;
}

Deno.test('an applied authorised connect writes its runtime rows, ticket and lifecycle in one guarded batch', async () => {
    await withPGliteSql(async (sql) => {
        const fixture = await createConnectWriteFixture(sql);

        await connectApplied(fixture, 'generation-first');
        const first = readLastTransaction(fixture);
        await connectApplied(fixture, 'generation-second');
        const second = readLastTransaction(fixture);

        console.info(`Authorised connect transaction statements: first ${first.details?.statements}, next ${second.details?.statements}`);
        // One guarded batch, one event, one insert per outbox page, and the two completion statements.
        assert.ok(Number(first.details?.statements) <= 7, `first connect issued ${first.details?.statements}`);
        assert.ok(Number(second.details?.statements) <= 7, `next connect issued ${second.details?.statements}`);
        assert.deepEqual(
            await sql<{ count: string; }[]>`
                select count(*)::text as count from runtime_state_store where store_namespace = ${WS_AUTH_TICKETS_NAMESPACE}
            `,
            [{ count: '0' }]
        );
    });
});

interface GuardConflictCase {
    readonly generationId: string;
    readonly connectedAtEpochMs: number;
    /** The concurrent write that lands between the attempt's read and its transaction. */
    readonly interfere: () => Promise<void>;
}

interface GuardConflictOutcome {
    readonly conflicted: RallarTimingEvent;
    readonly beforeWrite: DurableFootprint | undefined;
    readonly afterRollback: DurableFootprint | undefined;
    readonly retried: AuthorisedWsClientMutationResult | undefined;
}

/** Records the durable rows after the interfering write and again when the retry reads, i.e. after the rollback. */
async function runGuardConflict(fixture: ConnectWriteFixture, input: GuardConflictCase): Promise<GuardConflictOutcome> {
    let beforeWrite: DurableFootprint | undefined;
    let afterRollback: DurableFootprint | undefined;
    fixture.interfereAfterNextRead(async () => {
        await input.interfere();
        beforeWrite = await readDurableFootprint(fixture.sql);
        fixture.interfereAfterNextRead(async () => {
            afterRollback = await readDurableFootprint(fixture.sql);
        });
    });
    const started = await fixture.startConnect(input.generationId, input.connectedAtEpochMs);
    let settled = false;
    const retried = started.result.finally(() => {
        settled = true;
    });
    while (!settled) {
        await dequeueOnce(fixture);
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return { conflicted: readConflictedTransaction(fixture), beforeWrite, afterRollback, retried: await retried };
}

Deno.test('a stale principal revision rolls the whole connect transaction back as a typed conflict at its first statement', async () => {
    await withPGliteSql(async (sql) => {
        const fixture = await createConnectWriteFixture(sql);
        await connectApplied(fixture, 'generation-first');

        const outcome = await runGuardConflict(fixture, {
            generationId: 'generation-second',
            connectedAtEpochMs: Date.now(),
            interfere: async () => {
                await sql`
                    update runtime_state_store set revision = revision + 1
                    where store_namespace = ${CLIENT_STATE_PRINCIPALS_NAMESPACE}
                `;
            }
        });

        assert.equal(outcome.conflicted.error?.name, 'RuntimeStateWriteConflictError');
        assert.equal(outcome.conflicted.details?.statements, 1, 'the guarded batch is the only statement of the conflicted attempt');
        assert.ok(outcome.beforeWrite);
        assert.deepEqual(outcome.afterRollback, outcome.beforeWrite);
        assert.equal(outcome.retried?.status, 'ok');
    });
});

Deno.test('a superseded connect whose ticket was spent after its read rolls back on the ticket guard and is then rejected', async () => {
    await withPGliteSql(async (sql) => {
        const fixture = await createConnectWriteFixture(sql);
        const newerStartedAtEpochMs = Date.now();
        await connectApplied(fixture, 'generation-newer', newerStartedAtEpochMs);

        // An older generation cannot replace the live one: the principal is not written, so the ticket guards the write.
        const outcome = await runGuardConflict(fixture, {
            generationId: 'generation-older',
            connectedAtEpochMs: newerStartedAtEpochMs - 10_000,
            interfere: async () => {
                await sql`delete from runtime_state_store where store_namespace = ${WS_AUTH_TICKETS_NAMESPACE}`;
            }
        });

        assert.equal(outcome.conflicted.error?.name, 'RuntimeStateWriteConflictError');
        assert.equal(outcome.conflicted.details?.statements, 1);
        assert.ok(outcome.beforeWrite);
        assert.deepEqual(outcome.afterRollback, outcome.beforeWrite);
        assert.equal(outcome.retried?.status, 'ticket-rejected');
    });
});

const PROOF: ClientSnapshotProvenanceInsert = {
    queueKey: { topicId: 'ws-outbox', resourceId: 'proof-page', contextId: 'player' },
    namespace: WS_OUTBOX_PROVENANCE_NAMESPACE,
    key: 'proof-page',
    value: '{"proof":true}',
    expiresAt: '2100-01-01T00:00:00Z'
};

async function writeProofBatch(sql: PGliteSql, effects: readonly RuntimeStateGuardedBatchEffect[]): Promise<void> {
    await sql.begin(async (transaction) =>
        await writeClientRuntimeBatch(
            transaction,
            computeRuntimeStateGuardedBatchWrite({
                guard: {
                    operation: 'insert',
                    namespace: CLIENT_STATE_PRINCIPALS_NAMESPACE,
                    key: 'proof-principal',
                    value: '{}',
                    expireAtTimestamp: FUTURE_MS
                },
                effects: [toClientSnapshotProvenanceEffect(PROOF), ...effects]
            }),
            [PROOF]
        )
    );
}

Deno.test('a snapshot proof that collides inside the batch is the corruption its standalone insert reports, and a conflict takes precedence', async () => {
    await withPGliteSql(async (sql) => {
        const runtime = new PSqlRuntimeStateRepository(sql);
        await runtime.upsert(WS_OUTBOX_PROVENANCE_NAMESPACE, PROOF.key, 'an earlier proof', FUTURE_MS);

        await assert.rejects(
            writeProofBatch(sql, []),
            (error) => error instanceof ResourceInboxInvariantCorruptionError && error.message.includes('provenance')
        );
        await assert.rejects(
            writeProofBatch(sql, [{
                effectId: 'stale',
                operation: 'update',
                namespace: 'client-state:sessions',
                key: 'missing-session',
                expectedRevision: 3,
                value: '{}',
                expireAtTimestamp: FUTURE_MS
            }]),
            RuntimeStateWriteConflictError
        );
        assert.equal(await runtime.findEntry(CLIENT_STATE_PRINCIPALS_NAMESPACE, 'proof-principal'), undefined);
    });
});
