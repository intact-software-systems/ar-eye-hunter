import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { ResourceInboxInvariantCorruptionError } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import {
    computeAppOutboxInsert,
    computeWsOutboxInsert,
    writeAppOutboxInsertIfAbsent,
    writeAppOutboxInserts,
    type AppOutboxInsert
} from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import type { AppOutboxSidecarRow } from '@shared-server/rallar-system/app-outbox/app-outbox-sidecar.ts';
import { computeWsOutboxProvenanceRecord } from '@shared-server/rallar-system/websocket/outbox/ws-outbox-provenance.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { PGliteSql } from '../../../../../../apps/api-v1/src/db/pglite-sql-adapter.ts';
import { recordPGliteStatements } from '../../../al-runtime/postgres/record-p-glite-statements.ts';
import { createResourceInboxTestStorage, recordResourceInboxStatements } from '../../../queuebox/resource-inbox-test-storage.ts';
import {
    createTrackIndexTestEntry,
    toTrackIndexTestMessage,
    toTrackIndexTestProvenanceFacts,
    TRACK_INDEX_NAMESPACE
} from '../app-outbox-track-index-fixture.ts';

interface StoredSidecarRow {
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

function computeOrdered(): AppOutboxInsert & { readonly trackIndex: AppOutboxSidecarRow; } {
    const computed = computeWsOutboxInsert({
        entry: createEntry(EnqueuedType.WS_OUTBOX, 'round-2', 2),
        admissionNamespace: TRACK_INDEX_NAMESPACE,
        provenance: null
    });
    return { ...computed, trackIndex: computed.trackIndex! };
}

function computeProved(seq: number | undefined): AppOutboxInsert & { readonly provenance: AppOutboxSidecarRow; } {
    const entry = createEntry(EnqueuedType.WS_OUTBOX, `proved-${seq ?? 'none'}`, seq);
    const computed = computeWsOutboxInsert({
        entry,
        admissionNamespace: TRACK_INDEX_NAMESPACE,
        provenance: toTrackIndexTestProvenanceFacts(entry)
    });
    return { ...computed, provenance: computed.provenance! };
}

function toProofValue(computed: AppOutboxInsert): string {
    return computeWsOutboxProvenanceRecord({ entry: computed.entry, ...toTrackIndexTestProvenanceFacts(computed.entry) }).value;
}

/** The in-transaction statements PGlite runs from here on; undefined on the PostgreSQL backend, which has no census. */
function countInTransactionStatements(sql: PSqlSql): (() => number) | undefined {
    if (!('raw' in sql)) {
        return undefined;
    }
    const recorded = recordPGliteStatements((sql as PGliteSql).raw);
    return () => recorded.inTransaction().length;
}

async function readSidecarRow(sql: PSqlSql, row: AppOutboxSidecarRow): Promise<StoredSidecarRow | undefined> {
    const rows = await sql<StoredSidecarRow[]>`
        select store_value, expire_at_ts, revision from runtime_state_store
        where store_namespace = ${row.namespace} and store_key = ${row.key}`;
    return rows[0];
}

async function countOutboxRows(sql: PSqlSql, resourceId: string): Promise<number> {
    const rows = await sql<Array<{ count: number | string; }>>`
        select count(*) as count from resource_inbox where ri_resource_id = ${resourceId}`;
    return Number(rows[0]!.count);
}

async function seedSidecarRow(sql: PSqlSql, row: AppOutboxSidecarRow, value: string, live: boolean): Promise<void> {
    await sql`insert into runtime_state_store (store_namespace, store_key, store_value, expire_at_ts, updated_ts, revision)
        values (${row.namespace}, ${row.key}, ${value},
                now() + (${live ? 1 : -1} * interval '1 hour'), now(), 0)`;
}

describe('the app outbox writer with a track index row', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('writes the outbox row and its index row in one statement of one transaction', async () => {
        const sql = await createStorage();
        const computed = computeOrdered();
        const recorded: string[] = [];
        const counted = countInTransactionStatements(sql);

        await recordResourceInboxStatements(sql, recorded).begin((tx) => writeAppOutboxInserts(tx, [computed]));

        const stored = await readSidecarRow(sql, computed.trackIndex);
        expect(stored?.store_value).toBe(JSON.stringify(toTrackIndexTestMessage(computed.entry).id.msgId));
        expect(new Date(stored!.expire_at_ts).getTime()).toBe(computed.entry.audit.expiryTs.epochMilliseconds);
        expect(Number(stored!.revision)).toBe(0);
        expect(await countOutboxRows(sql, computed.entry.key.resourceId)).toBe(1);
        expect(recorded.filter((statement) => statement !== 'begin' && statement !== 'commit')).toHaveLength(1);
        if (counted !== undefined) {
            expect(counted()).toBe(1);
        }
    });

    it('rolls the whole transaction back on a live index row under the same track and sequence', async () => {
        const sql = await createStorage();
        const computed = computeOrdered();
        await seedSidecarRow(sql, computed.trackIndex, JSON.stringify('other-msg'), true);

        await expect(sql.begin((tx) => writeAppOutboxInserts(tx, [computed])))
            .rejects.toThrow(ResourceInboxInvariantCorruptionError);

        const stored = await readSidecarRow(sql, computed.trackIndex);
        expect(stored?.store_value).toBe(JSON.stringify('other-msg'));
        expect(Number(stored!.revision)).toBe(0);
        expect(await countOutboxRows(sql, computed.entry.key.resourceId)).toBe(0);
    });

    it('writes over an expired index row', async () => {
        const sql = await createStorage();
        const computed = computeOrdered();
        await seedSidecarRow(sql, computed.trackIndex, JSON.stringify('other-msg'), false);

        await sql.begin((tx) => writeAppOutboxInserts(tx, [computed]));

        const stored = await readSidecarRow(sql, computed.trackIndex);
        expect(stored?.store_value).toBe(JSON.stringify(toTrackIndexTestMessage(computed.entry).id.msgId));
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
        expect(await readSidecarRow(sql, computed.trackIndex)).toBeUndefined();
    });

    it('refuses to write an ordered WS row if-absent, before any statement', async () => {
        const sql = await createStorage();
        const recorded: string[] = [];

        await expect(recordResourceInboxStatements(sql, recorded).begin((tx) => writeAppOutboxInsertIfAbsent(tx, computeOrdered())))
            .rejects.toThrow(TypeError);

        expect(recorded).toEqual(['begin']);
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
        if (counted !== undefined) {
            expect(counted()).toBe(1);
        }
    });

    it('writes an unordered WS row and its proof row in one statement of one transaction', async () => {
        const sql = await createStorage();
        const computed = computeProved(undefined);
        const recorded: string[] = [];
        const counted = countInTransactionStatements(sql);

        await recordResourceInboxStatements(sql, recorded).begin((tx) => writeAppOutboxInserts(tx, [computed]));

        const stored = await readSidecarRow(sql, computed.provenance);
        expect(stored?.store_value).toBe(toProofValue(computed));
        expect(new Date(stored!.expire_at_ts).getTime()).toBe(computed.entry.audit.expiryTs.epochMilliseconds);
        expect(Number(stored!.revision)).toBe(0);
        expect(await countOutboxRows(sql, computed.entry.key.resourceId)).toBe(1);
        expect(recorded.filter((statement) => statement !== 'begin' && statement !== 'commit')).toHaveLength(1);
        if (counted !== undefined) {
            expect(counted()).toBe(1);
        }
    });

    it('writes an ordered WS row, its index row and its proof row in one statement', async () => {
        const sql = await createStorage();
        const computed = computeProved(2);
        const recorded: string[] = [];
        const counted = countInTransactionStatements(sql);

        await recordResourceInboxStatements(sql, recorded).begin((tx) => writeAppOutboxInserts(tx, [computed]));

        expect((await readSidecarRow(sql, computed.trackIndex!))?.store_value)
            .toBe(JSON.stringify(toTrackIndexTestMessage(computed.entry).id.msgId));
        expect((await readSidecarRow(sql, computed.provenance))?.store_value).toBe(toProofValue(computed));
        expect(await countOutboxRows(sql, computed.entry.key.resourceId)).toBe(1);
        expect(recorded.filter((statement) => statement !== 'begin' && statement !== 'commit')).toHaveLength(1);
        if (counted !== undefined) {
            expect(counted()).toBe(1);
        }
    });

    it('rolls the whole transaction back on a live proof row under the key', async () => {
        const sql = await createStorage();
        const computed = computeProved(undefined);
        await seedSidecarRow(sql, computed.provenance, '{"other":true}', true);

        const write = sql.begin((tx) => writeAppOutboxInserts(tx, [computed]));
        await expect(write).rejects.toThrow(ResourceInboxInvariantCorruptionError);
        await expect(write).rejects.toThrow('App outbox provenance did not create exactly one row');

        const stored = await readSidecarRow(sql, computed.provenance);
        expect(stored?.store_value).toBe('{"other":true}');
        expect(Number(stored!.revision)).toBe(0);
        expect(await countOutboxRows(sql, computed.entry.key.resourceId)).toBe(0);
    });

    it('writes over an expired proof row at revision 1', async () => {
        const sql = await createStorage();
        const computed = computeProved(undefined);
        await seedSidecarRow(sql, computed.provenance, '{"other":true}', false);

        await sql.begin((tx) => writeAppOutboxInserts(tx, [computed]));

        const stored = await readSidecarRow(sql, computed.provenance);
        expect(stored?.store_value).toBe(toProofValue(computed));
        expect(Number(stored!.revision)).toBe(1);
    });

    it('refuses a batch naming one proof key twice before any statement', async () => {
        const sql = await createStorage();
        const computed = computeProved(undefined);
        const twin = { ...computed, entry: { ...computed.entry, resource: '{"other":true}' } };
        const recorded: string[] = [];

        const write = recordResourceInboxStatements(sql, recorded).begin((tx) => writeAppOutboxInserts(tx, [computed, twin]));
        await expect(write).rejects.toThrow(ResourceInboxInvariantCorruptionError);
        await expect(write).rejects.toThrow('App outbox batch names one provenance row twice');

        expect(recorded).toEqual(['begin']);
        expect(await readSidecarRow(sql, computed.provenance)).toBeUndefined();
        expect(await countOutboxRows(sql, computed.entry.key.resourceId)).toBe(0);
    });

    it('refuses to write a proved WS row if-absent, before any statement', async () => {
        const sql = await createStorage();
        const recorded: string[] = [];

        await expect(
            recordResourceInboxStatements(sql, recorded).begin((tx) => writeAppOutboxInsertIfAbsent(tx, computeProved(undefined)))
        ).rejects.toThrow(new TypeError('A proved WS outbox row is not written if-absent'));

        expect(recorded).toEqual(['begin']);
    });
});
