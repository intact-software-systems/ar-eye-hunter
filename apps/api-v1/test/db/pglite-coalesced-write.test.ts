import { Temporal } from '@js-temporal/polyfill';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPostgresTimestampWithoutTimeZoneTextType } from '@shared-server/postgres/postgres-timestamp-without-time-zone.ts';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { toApiV1PostgresClient } from '../../src/db/api-v1-database-lifecycle.ts';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { computeCoalescedAppOutboxWork, writeCoalescedAppOutboxWork } from '@shared-server/rallar-system/app-outbox/coalesced-app-outbox-work.ts';
import { computeCoalescedRtcTopologyGroupRevisionWork } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { withPGliteSql } from './pglite-auth-test-harness.ts';
import { advanceCoalescedGeneration, topologyGroupSnapshotWithSessionIds } from './pglite-topology-test-runtime.ts';

function initialEntry(groupId: string): ResourceEntry {
    const groupRef = { applicationId: 'prepared-coalescing', workspaceId: 'transactions', groupId };
    return computeCoalescedRtcTopologyGroupRevisionWork({
        aggregateRef: groupRef,
        groupSnapshot: topologyGroupSnapshotWithSessionIds(groupRef, ['session-a'], 500),
        requestedAtEpochMs: 500,
        expireAtEpochMs: Date.parse('9999-12-31T23:59:59Z'),
        timing: { window: { debounceMs: 0, maxWaitMs: null }, replanNotBeforeEpochMs: null },
        senderId: 'rallar-server',
        origin: 'automatic',
        previousEntry: null
    }).entryWrite.entry;
}

for (const terminal of [false, true]) {
    for (const miss of [false, true]) {
        Deno.test(`prepared ${terminal ? 'finished' : 'pending'} coalesced write preserves durable ${miss ? 'miss/successor' : 'replacement'}`, async () => {
            await withCoalescedSql(async (sql) => {
                const repository = createPSqlResourceInboxRepository(sql, () => new Date());
                const expected: ResourceEntry = {
                    ...initialEntry(`${terminal}-${miss}`),
                    status: terminal ? EntityStatus.COMPLETED : EntityStatus.RETRY,
                    dequeueAudit: {
                        attempts: 2,
                        startTs: Temporal.Instant.from('2026-01-01T00:00:00.000001Z'),
                        endTs: Temporal.Instant.from('2026-01-01T00:00:00.000002Z')
                    }
                };
                await repository.entries.write(expected);
                const next: ResourceEntry = {
                    ...advanceCoalescedGeneration(expected, 2),
                    status: EntityStatus.RETRY,
                    audit: { ...expected.audit, expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.123456Z') },
                    dequeueAudit: {
                        attempts: terminal ? 0 : 2,
                        nextTs: Temporal.Instant.from('2026-01-02T03:04:05.123456Z')
                    }
                };
                const successor = { ...next, key: { ...next.key, resourceId: `${next.key.resourceId}:successor` } };
                const computed = computeCoalescedAppOutboxWork(expected, next, successor);
                if (miss) {
                    await sql`update resource_inbox set ri_status = ${EntityStatus.RESERVED}
                        where ri_resource_id = ${expected.key.resourceId}`;
                }
                await sql.begin(async (transaction) => {
                    const original = Temporal.Instant.prototype.toString;
                    Temporal.Instant.prototype.toString = () => {
                        throw new Error('Caller timestamp serialized inside transaction');
                    };
                    try {
                        await writeCoalescedAppOutboxWork(transaction, computed);
                    }
                    finally {
                        Temporal.Instant.prototype.toString = original;
                    }
                });
                const head = await repository.entries.findAnyByKey(expected.key);
                assert.ok(head);
                const storedSuccessor = await repository.entries.findAnyByKey(successor.key);
                if (miss) {
                    assert.equal(head.resource, expected.resource);
                    assert.equal(head.status, EntityStatus.RESERVED);
                    assert.equal(head.dequeueAudit.attempts, 2);
                    assert.equal(storedSuccessor?.resource, successor.resource);
                    assert.equal(storedSuccessor?.dequeueAudit.nextTs?.toString(), '2026-01-02T03:04:05.123456Z');
                }
                else {
                    assert.equal(head.resource, next.resource);
                    assert.equal(head.status, EntityStatus.RETRY);
                    assert.equal(head.dequeueAudit.attempts, terminal ? 0 : 2);
                    assert.equal(head.dequeueAudit.nextTs?.toString(), '2026-01-02T03:04:05.123456Z');
                    assert.equal(head.audit.expiryTs.toString(), terminal ? next.audit.expiryTs.toString() : expected.audit.expiryTs.toString());
                    assert.equal(head.dequeueAudit.startTs?.toString(), terminal ? undefined : expected.dequeueAudit.startTs?.toString());
                    assert.equal(head.dequeueAudit.endTs?.toString(), terminal ? undefined : expected.dequeueAudit.endTs?.toString());
                    assert.equal(storedSuccessor, null);
                }
            });
        });
    }
}

Deno.test('invalid coalesced replacement identity and lifecycle fail before transaction entry', () => {
    const expected = initialEntry('invalid');
    const next = advanceCoalescedGeneration(expected, 2);
    const successor = { ...next, key: { ...next.key, resourceId: `${next.key.resourceId}:successor` } };
    const invalid: readonly ResourceEntry[] = [
        { ...next, key: { ...next.key, contextId: 'other' } },
        { ...next, typeId: 'other' },
        { ...next, status: EntityStatus.RESERVED },
        { ...next, dequeueAudit: { attempts: 1 } }
    ];
    for (const candidate of invalid) {
        assert.throws(() => computeCoalescedAppOutboxWork(expected, candidate, successor));
    }
});

Deno.test('coalesced writes preserve computed snapshots and PostgreSQL rollback', async () => {
    await withCoalescedSql(async (sql) => {
        const repository = createPSqlResourceInboxRepository(sql, () => new Date());
        const expected = initialEntry('rollback');
        await repository.entries.write(expected);
        const next = advanceCoalescedGeneration(expected, 2);
        const successor = { ...next, key: { ...next.key, resourceId: `${next.key.resourceId}:successor` } };
        const computed = computeCoalescedAppOutboxWork(expected, next, successor);
        const key = { ...expected.key };
        const original = expected.resource;
        assert.equal(Reflect.set(expected.key, 'contextId', 'caller-mutated-context'), true);
        assert.equal(Reflect.set(next, 'resource', 'caller-mutated-content'), true);
        await assert.rejects(async () => {
            await sql.begin(async (transaction) => {
                await writeCoalescedAppOutboxWork(transaction, computed);
                throw new Error('Later effect failed');
            });
        }, /Later effect failed/);
        assert.equal((await repository.entries.findAnyByKey(key))?.resource, original);
        await sql.begin((transaction) => writeCoalescedAppOutboxWork(transaction, computed));
        assert.equal((await repository.entries.findAnyByKey(key))?.resource, computed.entryWrite.entry.resource);
        assert.equal(await repository.entries.findAnyByKey(successor.key), null);
    });
});

Deno.test('pending coalesced guards preserve changed content, type, and attempts and write the successor', async () => {
    await withCoalescedSql(async (sql) => {
        const repository = createPSqlResourceInboxRepository(sql, () => new Date());
        for (const changed of ['content', 'type', 'attempts'] as const) {
            const expected = initialEntry(changed);
            await repository.entries.write(expected);
            const next = advanceCoalescedGeneration(expected, 2);
            const successor = { ...next, key: { ...next.key, resourceId: `${next.key.resourceId}:successor` } };
            const computed = computeCoalescedAppOutboxWork(expected, next, successor);
            if (changed === 'content') {
                await sql`update resource_inbox set ri_resource = ${advanceCoalescedGeneration(expected, 3).resource}
                    where ri_resource_id = ${expected.key.resourceId} and fk_ext_bank_id = ${expected.key.contextId}`;
            }
            else if (changed === 'type') {
                await sql`update resource_inbox set ri_type_id = 'changed-type'
                    where ri_resource_id = ${expected.key.resourceId} and fk_ext_bank_id = ${expected.key.contextId}`;
            }
            else {
                await sql`update resource_inbox set ri_attempts = 1
                    where ri_resource_id = ${expected.key.resourceId} and fk_ext_bank_id = ${expected.key.contextId}`;
            }
            const before = await repository.entries.findAnyByKey(expected.key);
            assert.ok(before);
            await sql.begin((transaction) => writeCoalescedAppOutboxWork(transaction, computed));
            const after = await repository.entries.findAnyByKey(expected.key);
            assert.deepEqual(after, before);
            assert.equal((await repository.entries.findAnyByKey(successor.key))?.resource, successor.resource);
            await assert.rejects(
                () => sql.begin((transaction) => writeCoalescedAppOutboxWork(transaction, computed)),
                /App outbox insert did not create exactly one row/
            );
            assert.deepEqual(await repository.entries.findAnyByKey(expected.key), before);
        }
    });
});

async function withCoalescedSql(run: (sql: PSqlSql) => Promise<void>): Promise<void> {
    const databaseUrl = Deno.env.get('RALLAR_COALESCED_POSTGRES_URL');
    if (!databaseUrl) {
        await withPGliteSql(run);
        return;
    }
    const sql = toApiV1PostgresClient(postgres(databaseUrl, {
        max: 1,
        types: { timestampWithoutTimeZone: createPostgresTimestampWithoutTimeZoneTextType() }
    }));
    try {
        await run(sql);
    }
    finally {
        await sql.end();
    }
}
