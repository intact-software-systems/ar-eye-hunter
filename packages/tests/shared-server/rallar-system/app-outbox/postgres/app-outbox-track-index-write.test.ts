import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { ResourceInboxInvariantCorruptionError } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import {
    computeAppOutboxInsert,
    computeOrderedWsOutboxInsert,
    writeAppOutboxInserts,
    type AppOutboxInsert
} from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import type { AppOutboxTrackIndexRow } from '@shared-server/rallar-system/app-outbox/app-outbox-track-index.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PGliteSql } from '../../../../../../apps/api-v1/src/db/pglite-sql-adapter.ts';
import { createResourceInboxTestStorage, recordResourceInboxStatements } from '../../../queuebox/resource-inbox-test-storage.ts';
import { createTrackIndexTestEntry, TRACK_INDEX_NAMESPACE } from '../app-outbox-track-index-fixture.ts';

interface StoredTrackIndexRow {
    readonly store_value: string;
    readonly expire_at_ts: Date | string;
    readonly revision: number | string;
}

async function createStorage(): Promise<PSqlSql> {
    const storage = await createResourceInboxTestStorage('app_outbox_track_index');
    onTestFinished(() => storage.close());
    return storage.sql;
}

function createEntry(typeId: string, resourceId: string, seq: number | undefined): ResourceEntry {
    const expiresAt = Temporal.Now.instant().add({ minutes: 10 });
    return createTrackIndexTestEntry({ typeId, resourceId, seq, expiresAt });
}

function computeOrdered(): AppOutboxInsert & { readonly trackIndex: AppOutboxTrackIndexRow; } {
    const computed = computeOrderedWsOutboxInsert({
        entry: createEntry(EnqueuedType.WS_OUTBOX, 'round-2', 2),
        admissionNamespace: TRACK_INDEX_NAMESPACE
    });
    return { ...computed, trackIndex: computed.trackIndex! };
}

/** The in-transaction statements PGlite runs from here on; undefined on the PostgreSQL backend, which has no census. */
function countInTransactionStatements(sql: PSqlSql): (() => number) | undefined {
    if (!('raw' in sql)) {
        return undefined;
    }
    const raw = (sql as PGliteSql).raw;
    let inTransaction = 0;
    const transaction = raw.transaction.bind(raw);
    vi.spyOn(raw, 'transaction').mockImplementation((callback) =>
        transaction((tx) => {
            const txQuery = tx.query.bind(tx);
            return callback(Object.assign(Object.create(tx), {
                query: (...args: Parameters<typeof tx.query>) => {
                    inTransaction += 1;
                    return txQuery(...args);
                }
            }));
        })
    );
    return () => inTransaction;
}

async function readTrackIndexRow(sql: PSqlSql, row: AppOutboxTrackIndexRow): Promise<StoredTrackIndexRow | undefined> {
    const rows = await sql<StoredTrackIndexRow[]>`
        select store_value, expire_at_ts, revision from runtime_state_store
        where store_namespace = ${row.namespace} and store_key = ${row.key}`;
    return rows[0];
}

async function countOutboxRows(sql: PSqlSql, resourceId: string): Promise<number> {
    const rows = await sql<Array<{ count: number | string; }>>`
        select count(*) as count from resource_inbox where ri_resource_id = ${resourceId}`;
    return Number(rows[0]!.count);
}

async function seedTrackIndexRow(sql: PSqlSql, row: AppOutboxTrackIndexRow, msgId: string, live: boolean): Promise<void> {
    await sql`insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts, updated_ts, revision)
        values (${row.namespace}, ${row.key}, ${JSON.stringify(msgId)},
                now() + (${live ? 1 : -1} * interval '1 hour'), now(), 0)`;
}

describe('the app outbox writer with a track index row', () => {
    it('writes the outbox row and its index row in one statement of one transaction', async () => {
        const sql = await createStorage();
        const computed = computeOrdered();
        const recorded: string[] = [];
        const counted = countInTransactionStatements(sql);

        await recordResourceInboxStatements(sql, recorded).begin((tx) => writeAppOutboxInserts(tx, [computed]));

        const stored = await readTrackIndexRow(sql, computed.trackIndex);
        expect(stored?.store_value).toBe(JSON.stringify(computed.trackIndex.msgId));
        expect(new Date(stored!.expire_at_ts).getTime()).toBe(computed.entry.audit.expiryTs.epochMilliseconds);
        expect(Number(stored!.revision)).toBe(0);
        expect(await countOutboxRows(sql, computed.entry.key.resourceId)).toBe(1);
        expect(recorded.filter((statement) => statement !== 'begin' && statement !== 'commit')).toHaveLength(1);
        expect(counted?.() ?? 1).toBe(1);
    });

    it('rolls the whole transaction back on a live index row under the same track and sequence', async () => {
        const sql = await createStorage();
        const computed = computeOrdered();
        await seedTrackIndexRow(sql, computed.trackIndex, 'other-msg', true);

        await expect(sql.begin((tx) => writeAppOutboxInserts(tx, [computed])))
            .rejects.toThrow(ResourceInboxInvariantCorruptionError);

        const stored = await readTrackIndexRow(sql, computed.trackIndex);
        expect(stored?.store_value).toBe(JSON.stringify('other-msg'));
        expect(Number(stored!.revision)).toBe(0);
        expect(await countOutboxRows(sql, computed.entry.key.resourceId)).toBe(0);
    });

    it('writes over an expired index row', async () => {
        const sql = await createStorage();
        const computed = computeOrdered();
        await seedTrackIndexRow(sql, computed.trackIndex, 'other-msg', false);

        await sql.begin((tx) => writeAppOutboxInserts(tx, [computed]));

        const stored = await readTrackIndexRow(sql, computed.trackIndex);
        expect(stored?.store_value).toBe(JSON.stringify(computed.trackIndex.msgId));
        expect(Number(stored!.revision)).toBe(1);
    });

    it('refuses a batch naming one track index row twice before any statement', async () => {
        const sql = await createStorage();
        const computed = computeOrdered();
        const twin = { ...computeOrdered(), entry: { ...computed.entry, key: { ...computed.entry.key, resourceId: 'round-2b' } } };
        const recorded: string[] = [];

        await expect(recordResourceInboxStatements(sql, recorded).begin((tx) => writeAppOutboxInserts(tx, [computed, twin])))
            .rejects.toThrow(ResourceInboxInvariantCorruptionError);

        expect(recorded).toEqual(['begin']);
        expect(await readTrackIndexRow(sql, computed.trackIndex)).toBeUndefined();
    });

    it('leaves an APP_OUTBOX batch\'s statement as it was', async () => {
        const sql = await createStorage();
        const computed = [
            computeAppOutboxInsert(createEntry(EnqueuedType.APP_OUTBOX, 'work-1', undefined)),
            computeAppOutboxInsert(createEntry(EnqueuedType.APP_OUTBOX, 'work-2', undefined))
        ];
        const recorded: string[] = [];
        const counted = countInTransactionStatements(sql);

        await recordResourceInboxStatements(sql, recorded).begin((tx) => writeAppOutboxInserts(tx, computed));

        const statements = recorded.filter((statement) => statement !== 'begin' && statement !== 'commit');
        expect(statements).toHaveLength(1);
        expect(statements[0]).toMatch(/^insert into resource_inbox /u);
        expect(statements[0]).not.toContain('runtime_state_store');
        expect(counted?.() ?? 1).toBe(1);
    });
});
