import { Temporal } from '@js-temporal/polyfill';
import { PSqlResourceInboxEntryRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { readExactRecord } from '@shared-server/rallar-system/admin-operations/inbox/admin-prune-command-codec.ts';
import {
    decodeAdminPruneOutboxMessage,
    toAdminPruneOutbox,
    type AdminPruneOutboxMessage,
    type AdminPrunePageWork
} from '@shared-server/rallar-system/admin-operations/prune/admin-prune-page-codec.ts';
import { decodeJsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import assert from 'node:assert/strict';
import type { PGliteSql } from '../../../src/db/pglite-sql-adapter.ts';
import { withUtcPGliteSql } from '../../db/pglite-auth-test-harness.ts';
import { RealEngineAdminPruneFixture } from './admin-prune-real-engine-fixture.ts';

interface StoredPage {
    readonly rowId: string;
    readonly resourceId: string;
    readonly topicId: string;
    readonly contextId: string;
    readonly typeId: string;
    readonly resource: string;
    readonly metadata: string;
}

interface UnrepresentableJsonFixture {
    readonly name: string;
    readonly resource: string;
}

const UNREPRESENTABLE_JSON: readonly UnrepresentableJsonFixture[] = [
    { name: 'escaped null', resource: '{"unsupported":"\\u0000"}' },
    { name: 'unpaired surrogate', resource: '{"unsupported":"\\ud800"}' },
    { name: 'numeric overflow', resource: '{"unsupported":1e1000000}' }
];

for (const boundary of ['outer', 'payload']) {
    for (const fixture of UNREPRESENTABLE_JSON) {
        Deno.test('admin page JSONB conversion preserves ' + boundary + ' ' + fixture.name, async () => {
            await withUtcPGliteSql(async (sql) => {
                const repository = new PSqlResourceInboxEntryRepository(sql);
                await repository.write(createLegacyEntry(EntityStatus.NEW));
                await repository.write(createLegacyEntry(EntityStatus.RETRY));
                const pages = await readPages(sql);
                const [corrupt, valid] = pages;
                assert.ok(corrupt && valid);
                const canonical = decodePersistedALMessage(toAdminPruneOutbox(migrationWork('NEW'), 'server-1').resource);
                const resource = boundary === 'outer'
                    ? fixture.resource
                    : toLegacyEnvelope({
                        ...canonical,
                        payload: { ...canonical.payload, resource: fixture.resource }
                    });
                await replaceResource(sql, corrupt.rowId, resource);
                const before = await readPages(sql);

                await applyMigration(sql);

                const after = await readPages(sql);
                assert.deepEqual(after.find((row) => row.rowId === corrupt.rowId), before[0]);
                const migrated = after.find((row) => row.rowId === valid.rowId);
                assert.ok(migrated);
                assert.equal(migrated.metadata, valid.metadata);
                assert.equal(decodeStoredPage(migrated).work.jobId, 'RETRY');
                assert.equal(decodePersistedALMessage(migrated.resource).payload.resource, legacyPayload(valid.resource));
                await applyMigration(sql);
                assert.deepEqual(await readPages(sql), after);
            });
        });
    }
}

Deno.test('admin page migration preserves a completed real job, receipt, aggregate, and payload bytes', async () => {
    await withUtcPGliteSql(async (sql) => {
        const fixture = await RealEngineAdminPruneFixture.create(sql);
        fixture.start();
        try {
            const result = await fixture.prune();
            assert.equal(result.right?.status, 'completed');
        }
        finally {
            await fixture.stopAndDrain();
        }
        const pages = await readPages(sql);
        const page = pages.find((row) => row.topicId === 'rallar.admin.prune-expired');
        assert.ok(page);
        const canonical = decodePersistedALMessage(page.resource);
        const receiptAndAggregate = await readResults(sql);
        assert.ok(receiptAndAggregate.length >= 2);
        await replaceResource(sql, page.rowId, toLegacyEnvelope(canonical));
        const before = await readPages(sql);

        await applyMigration(sql);

        const after = await readPages(sql);
        const migrated = after.find((row) => row.rowId === page.rowId);
        assert.ok(migrated);
        assert.deepEqual(decodePersistedALMessage(migrated.resource), canonical);
        assert.equal(decodePersistedALMessage(migrated.resource).payload.resource, canonical.payload.resource);
        assert.deepEqual(decodeStoredPage(migrated), decodeStoredPage(page));
        assert.deepEqual(after.map((row) => row.metadata), before.map((row) => row.metadata));
        assert.deepEqual(await readResults(sql), receiptAndAggregate);
        await applyMigration(sql);
        assert.deepEqual(await readPages(sql), after);
        assert.deepEqual(await readResults(sql), receiptAndAggregate);
    });
});

Deno.test('admin page migration preserves pending, reserved, terminal, and expired queue history', async () => {
    await withUtcPGliteSql(async (sql) => {
        const repository = new PSqlResourceInboxEntryRepository(sql);
        for (const status of Object.values(EntityStatus)) {
            await repository.write(createLegacyEntry(status));
        }
        const before = await readPages(sql);

        await applyMigration(sql);

        const after = await readPages(sql);
        assert.equal(after.length, Object.values(EntityStatus).length);
        assert.deepEqual(after.map((row) => row.metadata), before.map((row) => row.metadata));
        for (const page of after) {
            const original = before.find((row) => row.rowId === page.rowId);
            assert.ok(original);
            const message = decodePersistedALMessage(page.resource);
            assert.deepEqual(message.targets, { mode: 'broadcast', scope: 'all' });
            assert.equal(message.payload.resource, legacyPayload(original.resource));
            assert.equal(decodeStoredPage(page).work.expireAtEpochMs, 1_700_000_060_000);
        }
        await applyMigration(sql);
        assert.deepEqual(await readPages(sql), after);
    });
});

Deno.test('admin page migration leaves malformed, misrouted, other-scope, and unrelated envelopes untouched', async () => {
    await withUtcPGliteSql(async (sql) => {
        const repository = new PSqlResourceInboxEntryRepository(sql);
        const entry = createLegacyEntry(EntityStatus.NEW);
        await repository.write(entry);
        const [page] = await readPages(sql);
        assert.ok(page);
        const canonical = decodePersistedALMessage(toAdminPruneOutbox(migrationWork('NEW'), 'server-1').resource);
        const legacyTargets = { mode: 'all', scope: 'global' };
        const malformed = [
            '{not-json',
            '[]',
            JSON.stringify({ ...canonical, targets: legacyTargets, unexpected: true }),
            JSON.stringify({ ...canonical, targets: { mode: 'all', scope: 'room' } }),
            JSON.stringify({ ...canonical, targets: { ...legacyTargets, unexpected: true } }),
            JSON.stringify({ ...canonical, targets: legacyTargets, route: { ...canonical.route, contextId: 'other-job' } }),
            JSON.stringify({ ...canonical, targets: legacyTargets, id: { ...canonical.id, msgId: 'other-page' } }),
            JSON.stringify({ ...canonical, targets: legacyTargets, payload: { ...canonical.payload, typeId: 'OTHER' } }),
            JSON.stringify({ ...canonical, targets: legacyTargets, payload: { ...canonical.payload, resource: '{bad' } }),
            JSON.stringify({ ...canonical, targets: legacyTargets, payload: { ...canonical.payload, resource: '[]' } }),
            JSON.stringify({ ...canonical, targets: legacyTargets, payload: { ...canonical.payload, resource: '{}' } })
        ];
        for (const resource of malformed) {
            await replaceResource(sql, page.rowId, resource);
            const before = await readPages(sql);
            await applyMigration(sql);
            assert.deepEqual(await readPages(sql), before);
        }
        await replaceResource(sql, page.rowId, entry.resource);
        await sql`update resource_inbox set ri_type_id = 'WS_OUTBOX' where ri_row_id = ${page.rowId}`;
        const otherType = await readPages(sql);
        await applyMigration(sql);
        assert.deepEqual(await readPages(sql), otherType);
        await sql`update resource_inbox set ri_type_id = 'APP_OUTBOX', ri_topic_id = 'another-topic'
            where ri_row_id = ${page.rowId}`;
        const otherTopic = await readPages(sql);
        await applyMigration(sql);
        assert.deepEqual(await readPages(sql), otherTopic);
    });
});

function migrationWork(jobId: string): AdminPrunePageWork {
    return {
        kind: 'page',
        jobId,
        category: 'runtime-state',
        requestedBy: 'admin-1',
        requestedSessionId: 'admin-session-1',
        capturedAtEpochMs: 1_700_000_000_000,
        expireAtEpochMs: 1_700_000_060_000,
        pageSize: 2,
        afterCursor: null,
        pageIndex: 0,
        appData: null
    };
}

function createLegacyEntry(status: EntityStatus): ResourceEntry {
    const work = migrationWork(status);
    const entry = toAdminPruneOutbox(work, 'server-1');
    const message = decodePersistedALMessage(entry.resource);
    return {
        ...entry,
        resource: toLegacyEnvelope({ ...message, payload: { ...message.payload, resource: JSON.stringify(work, null, 2) } }),
        status,
        dequeueAudit: {
            attempts: status === EntityStatus.NEW ? 0 : 3,
            startTs: status === EntityStatus.NEW ? undefined : Temporal.Instant.fromEpochMilliseconds(1_700_000_001_000),
            endTs: status === EntityStatus.NEW || status === EntityStatus.RESERVED
                ? undefined
                : Temporal.Instant.fromEpochMilliseconds(1_700_000_002_000),
            nextTs: status === EntityStatus.RETRY ? Temporal.Instant.fromEpochMilliseconds(1_700_000_003_000) : undefined
        }
    };
}

function toLegacyEnvelope(message: ALMessage): string {
    return JSON.stringify({ ...message, targets: { mode: 'all', scope: 'global' } });
}

function legacyPayload(resource: string): string {
    const value = readExactRecord(decodeJsonWireValue(JSON.parse(resource), 'legacy fixture'), [
        'id',
        'route',
        'targets',
        'constraints',
        'payload',
        'audit'
    ], 'legacy fixture');
    const payload = readExactRecord(value.payload, ['typeId', 'contentType', 'resource'], 'legacy payload');
    assert.ok(typeof payload.resource === 'string');
    return payload.resource;
}

function decodeStoredPage(page: StoredPage): AdminPruneOutboxMessage {
    return decodeAdminPruneOutboxMessage({
        key: { resourceId: page.resourceId, topicId: page.topicId, contextId: page.contextId },
        resource: page.resource,
        typeId: page.typeId
    });
}

async function readPages(sql: PGliteSql): Promise<readonly StoredPage[]> {
    return await sql<StoredPage[]>`
        select ri_row_id::text as "rowId", ri_resource_id as "resourceId", ri_topic_id as "topicId",
            fk_ext_bank_id as "contextId", ri_type_id as "typeId", ri_resource as resource,
            (to_jsonb(page) - 'ri_resource')::text as metadata
        from resource_inbox page order by ri_row_id
    `;
}

async function readResults(sql: PGliteSql): Promise<readonly string[]> {
    const rows = await sql<{ resource: string; }[]>`
        select to_jsonb(result)::text as resource from resource_inbox_results result order by ris_row_id
    `;
    return rows.map((row) => row.resource);
}

async function replaceResource(sql: PGliteSql, rowId: string, resource: string): Promise<void> {
    await sql`update resource_inbox set ri_resource = ${resource} where ri_row_id = ${rowId}`;
}

async function applyMigration(sql: PGliteSql): Promise<void> {
    const migration = await Deno.readTextFile(
        new URL(
            '../../../prisma/migrations/20260831160000_admin_prune_canonical_outbox_targets/migration.sql',
            import.meta.url
        )
    );
    await sql.exec(migration);
}
