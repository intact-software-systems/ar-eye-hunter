import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { runInPSqlTransaction } from '@shared-server/postgres/run-in-p-sql-transaction.ts';
import { ResourceInboxInvariantCorruptionError } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import {
    computeWsOutboxInsert,
    writeAppOutboxInserts,
    type AppOutboxInsert
} from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import {
    toWsOutboxProvenanceKey,
    WS_OUTBOX_PROVENANCE_NAMESPACE,
    type WsOutboxProvenance,
    type WsOutboxProvenanceFacts
} from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { createTrackIndexTestEntry, toTrackIndexTestMessage } from '../../rallar-system/app-outbox/app-outbox-track-index-fixture.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresClient,
    requirePostgresDatabaseUrl,
    withPostgresClients
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

const SCOPE = { applicationId: 'relic', workspaceId: 'workspace' };
const ROOM = { ...SCOPE, groupId: 'game-1' };
const PRINCIPAL = { ...SCOPE, principalId: 'principal-1' };

type ToProducerFacts = (entry: ResourceEntry) => WsOutboxProvenanceFacts;

/** Each WS-outbox producer's proof facts, as its compute names them for one outbox row. */
const PRODUCERS: readonly (readonly [string, ToProducerFacts])[] = [
    [
        'auth logout',
        (entry) =>
            toFacts(entry, 'auth-session-invalidation', {
                kind: 'exact-invalidated-session',
                sessionInvalidation: {
                    kind: 'auth-session-invalidation',
                    sessionId: 'session-1',
                    requestId: 'logout-1',
                    invalidatedAtMs: 1,
                    issuedAtMs: 1,
                    expiresAtMs: entry.audit.expiryTs.epochMilliseconds
                },
                admittedAudience: ['session-1']
            })
    ],
    [
        'client snapshot',
        (entry) => toFacts(entry, 'state-sync', { kind: 'scoped-unicast', peerId: 'session-1', scope: SCOPE, admittedAudience: ['session-1'] })
    ],
    [
        'CRDT',
        (entry) =>
            toFacts(entry, 'crdt', {
                kind: 'scoped-principal-unicast',
                peerId: PRINCIPAL.principalId,
                principalRef: PRINCIPAL,
                admittedAudience: ['session-1']
            })
    ],
    [
        'group delta',
        (entry) => toFacts(entry, 'state-sync', { kind: 'scoped-room-broadcast', groupRef: ROOM, admittedAudience: ['session-1'] })
    ],
    [
        'RTC topology',
        (entry) => toFacts(entry, 'rtc-topology', { kind: 'scoped-room-broadcast', groupRef: ROOM, admittedAudience: ['session-1'] })
    ],
    [
        'Relic',
        (entry) =>
            toFacts(entry, 'room-application', {
                kind: 'scoped-principal-broadcast',
                principalRef: PRINCIPAL,
                admittedAudience: ['session-1']
            })
    ]
];

describe.each(PRODUCERS)(
    'Postgres %s proof facts, hand-built per producer kind, prove the shared outbox writer\'s expired-row rule',
    (_producer, toProducerFacts) => {
        postgresIt('writes a proof over an expired row and proof, one revision past it, and still refuses a live one', async () => {
            await withProofSql(async (sql, runId) => {
                const entry = createTrackIndexTestEntry({
                    typeId: EnqueuedType.WS_OUTBOX,
                    resourceId: `provenance-${runId}`,
                    seq: undefined,
                    expiresAt: Temporal.Now.instant().add({ minutes: 10 })
                });
                const proofKey = toWsOutboxProvenanceKey(entry.key);
                const first = toInsert(entry, toProducerFacts);
                await writeProved(sql, first);
                await expireOutboxRow(sql, entry);
                await sql`update runtime_state_store set expire_at_ts = now() - interval '1 minute' where store_key = ${proofKey}`;

                const replayEntry = { ...entry, audit: { ...entry.audit, createdTs: entry.audit.createdTs.add({ seconds: 1 }) } };
                const replay = toInsert(replayEntry, toProducerFacts);
                await writeProved(sql, replay);
                expect(await readProof(sql, proofKey)).toEqual({ value: replay.provenance?.value, revision: 1 });
                expect(replay.provenance?.value).not.toBe(first.provenance?.value);

                const live = writeProved(sql, toInsert(entry, toProducerFacts));
                await expect(live).rejects.toBeInstanceOf(ResourceInboxInvariantCorruptionError);
                await expect(live).rejects.toThrow('App outbox insert did not create exactly one row');

                await expireOutboxRow(sql, entry);
                await expect(writeProved(sql, toInsert(entry, toProducerFacts)))
                    .rejects.toThrow('App outbox provenance did not create exactly one row');
                expect(await readProof(sql, proofKey)).toEqual({ value: replay.provenance?.value, revision: 1 });
            });
        }, 60_000);
    }
);

function toFacts(
    entry: ResourceEntry,
    producerKind: WsOutboxProvenance['producerKind'],
    target: WsOutboxProvenance['target']
): WsOutboxProvenanceFacts {
    return { message: toTrackIndexTestMessage(entry), producerKind, target, expiresAtMs: entry.audit.expiryTs.epochMilliseconds };
}

function toInsert(entry: ResourceEntry, toProducerFacts: ToProducerFacts): AppOutboxInsert {
    return computeWsOutboxInsert({ entry, admissionNamespace: null, provenance: toProducerFacts(entry) });
}

async function writeProved(sql: PSqlSql, insert: AppOutboxInsert): Promise<void> {
    await runInPSqlTransaction(sql, async (transaction) => await writeAppOutboxInserts(transaction, [insert]));
}

async function expireOutboxRow(sql: PSqlSql, entry: ResourceEntry): Promise<void> {
    await sql`
        update resource_inbox set expire_ts = now() at time zone 'UTC' - interval '1 minute'
        where ri_resource_id = ${entry.key.resourceId}
    `;
}

async function withProofSql(run: (sql: PSqlSql, runId: string) => Promise<void>): Promise<void> {
    await withPostgresClients({
        namespace: null,
        clientCount: 1,
        createClient: async () => await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl(), 2)
    }, async (clients) => {
        const sql = requirePostgresClient(clients, 0);
        const runId = crypto.randomUUID();
        try {
            await run(sql, runId);
        }
        finally {
            await sql`delete from resource_inbox where ri_resource_id like ${`%${runId}%`}`;
            await sql`delete from runtime_state_store where store_key like ${`%${runId}%`}`;
        }
    });
}

async function readProof(sql: PSqlSql, key: string): Promise<Readonly<{ value: string; revision: number; }> | undefined> {
    const [row] = await sql<{ value: string; revision: number; }[]>`
        select store_value as value, revision::int as revision
        from runtime_state_store
        where store_namespace = ${WS_OUTBOX_PROVENANCE_NAMESPACE} and store_key = ${key}
    `;
    return row;
}
