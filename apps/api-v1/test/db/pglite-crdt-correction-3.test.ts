import assert from 'node:assert/strict';
import { Temporal } from '@js-temporal/polyfill';
import { PSqlAdminOperationsPruner } from '@shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts';
import { PSqlAdminPruneExpiredRepository } from '@shared-server/postgres/admin-operations/PSqlAdminPruneExpiredRepository.ts';
import { PSqlQueueBox } from '@shared-server/postgres/queuebox/PSqlQueueBox.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import { ResourceInboxResultsRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import {
    createAdminPruneAggregate,
    toAdminPruneAggregateEntry,
} from '@shared-server/rallar-system/admin-operations/admin-prune-progress.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { toResilienceDto } from '../../src/middleware-resilience.ts';
import {
    createApiCrdtInboxService,
} from '../../src/services/create-api-crdt-inbox-service.ts';
import {
    createConfiguredApiMutationInboxFactories,
    readConfiguredCrdtPolicies,
} from '../../src/services/create-api-mutation-inbox-factories.ts';
import {
    readPGliteDatabaseEpochMs,
    createResourceEntry,
    waitForPGliteQueueRow,
    withPGliteSql,
} from './pglite-auth-test-harness.ts';
import {
    appendCommand,
    queueNow,
    update,
    withCompetingWrite,
} from './pglite-crdt-correction-3-fixtures.ts';

Deno.test('configured production factory keeps absent CRDT policy undefined and denies writes', async () => {
    const previous = Deno.env.get('RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON');
    Deno.env.delete('RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON');
    try {
        assert.equal(readConfiguredCrdtPolicies(), undefined);
        await withPGliteSql(async (sql) => {
            const now = await queueNow(sql);
            const resourceInbox = new ResourceInboxRepository(sql);
            const queue = new PSqlQueueBox(resourceInbox);
            const factories = createConfiguredApiMutationInboxFactories({
                resourceInboxRepository: resourceInbox,
                resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
                database: sql,
                serviceId: 'server-1',
                timing: undefined,
                options: { nowEpochMs: () => now },
                readSession: (sessionId: string) => Promise.resolve({
                    clientId: 'client-1',
                    username: 'principal-1',
                    sessionId,
                    expiresAtEpochMs: now + 60_000,
                }),
                authorizeDocument: () => Promise.resolve({
                    allowed: true,
                    code: 'allowed',
                }),
            } as never);
            const service = factories.createAppCrdtInboxService({
                inboxQueueReader: new InboxQueueReader(queue),
                outboxQueueReader: new OutboxQueueReader(queue),
                appInboxResilience: toResilienceDto(),
                wakeQueueEngine: () => undefined,
            });
            const read = await service.mutationService.read(
                await appendCommand(now, 'default-deny', 'default-deny-update'),
            );

            assert.equal(read.featureDecision.allowed, false);
        });
    } finally {
        if (previous === undefined) Deno.env.delete('RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON');
        else Deno.env.set('RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON', previous);
    }
});

Deno.test('configured CRDT policy parser accepts only the authoritative rollout vocabulary', () => {
    const previous = Deno.env.get('RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON');
    try {
        for (const rollout of [
            'disabled',
            'experimental-local',
            'experimental-live',
            'durable-beta',
            'production',
        ]) {
            Deno.env.set('RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON', JSON.stringify([{
                documentType: 'checklist',
                rollout,
            }]));
            assert.equal(readConfiguredCrdtPolicies()?.[0]?.rollout, rollout);
        }
        for (const rollout of ['experimental', 'beta', 'durable_beta']) {
            Deno.env.set('RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON', JSON.stringify([{
                documentType: 'checklist',
                rollout,
            }]));
            assert.throws(() => readConfiguredCrdtPolicies(), /policy|rollout|invalid/i);
        }
    } finally {
        if (previous === undefined) Deno.env.delete('RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON');
        else Deno.env.set('RALLAR_CRDT_DOCUMENT_TYPE_POLICIES_JSON', previous);
    }
});

Deno.test('compatible migration normalizes legacy revision and nullable snapshot reason', async () => {
    await withPGliteSql(async (sql) => {
        const documentKey = 'legacy-document';
        await sql`alter table crdt_snapshots alter column reason drop not null`;
        await sql`
            insert into crdt_documents (
                document_key, application_id, workspace_id, document_scope,
                document_type, document_id, document_ref, document_revision
            ) values (
                ${documentKey}, 'app-1', null, 'app', 'checklist', 'legacy',
                ${JSON.stringify({
                    applicationId: 'app-1',
                    scope: 'app',
                    documentType: 'checklist',
                    documentId: 'legacy',
                })}, 0
            )
        `;
        await sql`
            insert into crdt_snapshots (
                document_key, snapshot_id, append_sequence, snapshot_envelope, reason
            ) values (
                ${documentKey}, 'legacy-snapshot', 0, ${JSON.stringify({ legacy: true })}, null
            )
        `;
        const migration = await Deno.readTextFile(new URL(
            '../../prisma/migrations/20260723170000_crdt_trusted_identity_required/migration.sql',
            import.meta.url,
        ));
        await sql.exec(migration);

        const [row] = await sql<{
            document_revision: string | number;
            reason: string | null;
            reason_nullable: string;
        }[]>`
            select d.document_revision, s.reason,
                   c.is_nullable as reason_nullable
            from crdt_documents d
            join crdt_snapshots s on s.document_key = d.document_key
            join information_schema.columns c
              on c.table_name = 'crdt_snapshots' and c.column_name = 'reason'
            where d.document_key = ${documentKey}
        `;
        assert.equal(Number(row?.document_revision), 1);
        assert.equal(row?.reason, 'legacy-import');
        assert.equal(row?.reason_nullable, 'NO');
    });
});

Deno.test('initial prune statistics use the command capture cutoff instead of database now', async () => {
    await withPGliteSql(async (sql) => {
        const databaseNow = await readPGliteDatabaseEpochMs(sql);
        await new ResourceInboxResultsRepository(sql).writeIfAbsentOrReplaceExpired(
            createResourceEntry('resource-1', {
                topicId: 'topic-1',
                contextId: 'context-1',
                expiryTs: Temporal.Instant.fromEpochMilliseconds(databaseNow - 1_000),
            }),
        );
        const pruner = new PSqlAdminOperationsPruner(sql);

        assert.equal(await pruner.countExpired('resource-inbox-results', {
            cutoffEpochMs: databaseNow - 10_000,
        } as never), 0);
    });
});

Deno.test('prune progress renews physical and JSON aggregate expiry together', async () => {
    await withPGliteSql(async (sql) => {
        const now = await queueNow(sql);
        const current = createAdminPruneAggregate({
            jobId: 'prune-physical-expiry',
            generatedAtEpochMs: now,
            expireAtEpochMs: now + 60_000,
            serverId: 'server-1',
            requestedBy: 'admin-1',
            requestedSessionId: 'session-1',
            categories: ['runtime-state'],
            expiredRows: { 'runtime-state': 1 },
        });
        const currentEntry = toAdminPruneAggregateEntry(current);
        await new ResourceInboxResultsRepository(sql)
            .writeIfAbsentOrReplaceExpired(currentEntry);
        const renewed = {
            ...current,
            revision: 1,
            expireAtEpochMs: now + 120_000,
        };
        const successor = toAdminPruneAggregateEntry(renewed);
        await sql.begin(async (transaction) => {
            await new PSqlAdminPruneExpiredRepository(sql, 'server-1').writeProgress(
                transaction,
                {
                    kind: 'page',
                    jobId: current.jobId,
                    category: 'runtime-state',
                    rowIds: [],
                    deletedRows: 0,
                    next: null,
                    expectedAggregate: currentEntry.resource,
                    aggregateSuccessor: successor,
                    finishedAtEpochMs: now + 1,
                },
            );
        });
        const [stored] = await sql<{
            ris_resource: string;
            expire_epoch_ms: string | number;
        }[]>`
            select ris_resource,
                   floor(extract(epoch from expire_ts) * 1000)::bigint as expire_epoch_ms
            from resource_inbox_results
            where ris_topic_id = ${successor.key.topicId}
              and ris_resource_id = ${successor.key.resourceId}
              and fk_ext_bank_id = ${successor.key.contextId}
        `;

        assert.equal(JSON.parse(stored!.ris_resource).expireAtEpochMs, renewed.expireAtEpochMs);
        assert.equal(Number(stored!.expire_epoch_ms), renewed.expireAtEpochMs);
    });
});

Deno.test('real SQL CAS conflict retries from revoked room membership and commits no owner effect', async () => {
    await withPGliteSql(async (sql) => {
        const now = await queueNow(sql);
        let membershipAllowed = true;
        let documentAuthorityReads = 0;
        const database = withCompetingWrite(sql, now, () => {
            membershipAllowed = false;
        });
        const resourceInbox = new ResourceInboxRepository(sql);
        const service = createApiCrdtInboxService({
            inboxQueueReader: new InboxQueueReader(new PSqlQueueBox(resourceInbox)),
            resourceInboxRepository: resourceInbox,
            resourceInboxResultsRepository: new ResourceInboxResultsRepository(sql),
            database,
            serviceId: 'server-1',
            options: { nowEpochMs: () => now },
            currentAuthority: {
                readSession: (sessionId: string) => Promise.resolve({
                    clientId: 'client-1',
                    username: 'principal-1',
                    sessionId,
                    expiresAtEpochMs: now + 60_000,
                }),
                adminClientIds: ['admin'],
                authorizeDocument: () => {
                    documentAuthorityReads += 1;
                    return Promise.resolve({
                        allowed: membershipAllowed,
                        code: membershipAllowed ? 'allowed' : 'authorization-scope-denied',
                    });
                },
            } as never,
            policies: [{ documentType: 'checklist', rollout: 'production' }],
        });
        await service.createAndEnqueueAppend({
            update: update('owner-update', now - 1_000),
            deliveryId: 'owner-delivery',
            actor: {
                actorId: 'client-1',
                principalId: 'principal-1',
                sessionId: 'session-1',
                serverId: 'server-1',
            },
            responseAudience: {
                kind: 'room',
                senderSessionId: 'session-1',
                topicId: 'room.crdt',
                contextId: 'group-1',
            },
            capturedAtEpochMs: now,
            expireAtEpochMs: now + 60_000,
        });
        await waitForPGliteQueueRow(sql, 'APP_INBOX', 'NEW');
        await service.inbox.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            toResilienceDto(),
        );

        const [counts] = await sql<{
            updates: string;
            owner_updates: string;
            outbox: string;
        }[]>`
            select
                (select count(*) from crdt_updates)::text as updates,
                (select count(*) from crdt_updates where update_id = 'owner-update')::text
                    as owner_updates,
                (select count(*) from resource_inbox where ri_type_id = 'WS_OUTBOX')::text
                    as outbox
        `;
        assert.deepEqual(counts, { updates: '1', owner_updates: '0', outbox: '0' });
        assert.equal(documentAuthorityReads, 2);
        const [completion] = await sql<{ ris_resource: string }[]>`
            select ris_resource from resource_inbox_results
            where ris_topic_id = 'app-inbox.crdt-state'
              and ris_resource_id = 'owner-delivery'
        `;
        assert.equal(JSON.parse(completion!.ris_resource).code, 'authorization-scope-denied');
    });
});
