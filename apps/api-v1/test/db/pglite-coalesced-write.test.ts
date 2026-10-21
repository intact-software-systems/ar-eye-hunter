import { Temporal } from '@js-temporal/polyfill';
import assert from 'node:assert/strict';
import postgres from 'postgres';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPostgresTimestampWithoutTimeZoneTextType } from '@shared-server/postgres/postgres-timestamp-without-time-zone.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { computeCoalescedAppOutboxWork, writeCoalescedAppOutboxWork } from '@shared-server/rallar-system/app-outbox/coalesced-app-outbox-work.ts';
import { computeCoalescedRtcTopologyGroupRevisionWork } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import { computeResourceInboxRelease } from '@shared/queuebox/compute-resource-inbox-release.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { toApiV1PostgresClient } from '../../src/db/api-v1-database-lifecycle.ts';
import { withPGliteSql } from './pglite-auth-test-harness.ts';
import { advanceCoalescedGeneration, topologyGroupSnapshotWithSessionIds } from './pglite-topology-test-runtime.ts';

function computeInitialCoalescedEntry(groupId: string): ResourceEntry {
    const groupRef = { applicationId: 'prepared-coalescing', workspaceId: 'transactions', groupId };
    return computeCoalescedRtcTopologyGroupRevisionWork({
        aggregateRef: groupRef,
        groupSnapshot: topologyGroupSnapshotWithSessionIds(groupRef, ['session-a'], 500),
        requestedAtEpochMs: 500,
        expireAtEpochMs: Date.parse('9999-12-31T23:59:59Z'),
        timing: { window: { debounceMs: 0, maxWaitMs: 0 }, replanNotBeforeEpochMs: null, expectedMembersArrived: false },
        senderId: 'rallar-server',
        origin: 'automatic',
        previousEntry: null
    }).entryWrite.entry;
}

function computeAttemptedCoalescedEntry(groupId: string, terminal: boolean): ResourceEntry {
    const reserved: ResourceEntry = {
        ...computeInitialCoalescedEntry(groupId),
        status: EntityStatus.RESERVED,
        dequeueAudit: {
            attempts: 2,
            startTs: Temporal.Instant.from('2026-01-01T00:00:00.000001Z')
        }
    };
    return computeResourceInboxRelease(
        reserved,
        terminal ? { status: EntityStatus.COMPLETED, delayMs: null } : { status: EntityStatus.RETRY, delayMs: 1 },
        Temporal.Instant.from('2026-01-01T00:00:00.000002Z')
    );
}

for (const terminal of [false, true]) {
    for (const miss of [false, true]) {
        Deno.test(`prepared ${terminal ? 'finished' : 'pending'} coalesced write preserves durable ${miss ? 'miss/successor' : 'replacement'}`, async () => {
            await withCoalescedSql(async (sql) => {
                const repository = createPSqlResourceInboxRepository(sql, () => new Date());
                const expected = computeAttemptedCoalescedEntry(`${terminal}-${miss}`, terminal);
                await repository.entries.write(expected);
                const next: ResourceEntry = {
                    ...advanceCoalescedGeneration(expected, 2),
                    status: EntityStatus.RETRY,
                    audit: { ...expected.audit, expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.123456Z') },
                    dequeueAudit: {
                        ...(terminal ? {} : expected.dequeueAudit),
                        attempts: terminal ? 0 : 2,
                        nextTs: Temporal.Instant.from('2026-01-02T03:04:05.123456Z')
                    }
                };
                const successor = { ...next, key: { ...next.key, resourceId: `${next.key.resourceId}:successor` } };
                const computed = computeCoalescedAppOutboxWork(expected, next, successor);
                if (miss) {
                    const reserved = (await repository.reservations.startProcessingEntity(expected)).right;
                    assert.ok(reserved);
                    assert.equal(reserved.status, EntityStatus.RESERVED);
                    assert.equal(reserved.dequeueAudit.attempts, 3);
                    assert.ok(reserved.dequeueAudit.startTs);
                    assert.equal(reserved.dequeueAudit.endTs, undefined);
                    assert.equal(reserved.dequeueAudit.nextTs, undefined);
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
                    assert.equal(head.dequeueAudit.attempts, 3);
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
    const expected = computeInitialCoalescedEntry('invalid');
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
        const expected = computeInitialCoalescedEntry('rollback');
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
            const expected = changed === 'attempts'
                ? computeAttemptedCoalescedEntry(changed, false)
                : computeInitialCoalescedEntry(changed);
            await repository.entries.write(expected);
            const next = advanceCoalescedGeneration(expected, 2);
            const successor = { ...next, key: { ...next.key, resourceId: `${next.key.resourceId}:successor` } };
            const computed = computeCoalescedAppOutboxWork(expected, next, successor);
            const changedResource = changed === 'content' ? advanceCoalescedGeneration(expected, 3).resource : expected.resource;
            if (changed === 'content') {
                await sql`update resource_inbox set ri_resource = ${changedResource}
                    where ri_resource_id = ${expected.key.resourceId} and fk_ext_bank_id = ${expected.key.contextId}`;
            }
            else if (changed === 'type') {
                await sql`update resource_inbox set ri_type_id = 'changed-type'
                    where ri_resource_id = ${expected.key.resourceId} and fk_ext_bank_id = ${expected.key.contextId}`;
            }
            else {
                await sql`update resource_inbox set ri_attempts = 3
                    where ri_resource_id = ${expected.key.resourceId} and fk_ext_bank_id = ${expected.key.contextId}`;
            }
            const before = await repository.entries.findAnyByKey(expected.key);
            assert.ok(before);
            assert.equal(before.status, expected.status);
            assert.equal(before.resource, changedResource);
            assert.equal(before.typeId, changed === 'type' ? 'changed-type' : expected.typeId);
            assert.equal(before.dequeueAudit.attempts, changed === 'attempts' ? 3 : 0);
            assert.equal(before.dequeueAudit.startTs?.toString(), expected.dequeueAudit.startTs?.toString());
            assert.equal(before.dequeueAudit.endTs?.toString(), expected.dequeueAudit.endTs?.toString());
            assert.equal(before.dequeueAudit.nextTs?.toString(), expected.dequeueAudit.nextTs?.toString());
            await sql.begin((transaction) => writeCoalescedAppOutboxWork(transaction, computed));
            const after = await repository.entries.findAnyByKey(expected.key);
            assert.deepEqual(after, before);
            assert.equal((await repository.entries.findAnyByKey(successor.key))?.resource, successor.resource);
            const repeated = await sql.begin((transaction) => writeCoalescedAppOutboxWork(transaction, computed));
            assert.equal(repeated, 'successor-present');
            assert.equal((await repository.entries.findAnyByKey(successor.key))?.resource, successor.resource);
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
