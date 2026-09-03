import assert from 'node:assert/strict';

import { createApiV1TestPGliteDatabaseLifecycle } from './api-v1-test-pglite-database.ts';

const MIGRATION_URL = new URL(
    '../../prisma/migrations/20260902150000_coalesced_work_window_anchor/migration.sql',
    import.meta.url
);

/** The coalescing metadata as stored, before and after the anchor existed. */
interface StoredCoalescedWork {
    readonly generation: number;
    readonly requestedAtEpochMs: number;
    readonly windowOpenedAtEpochMs?: number;
    readonly dueAtEpochMs: number;
    readonly reasons: readonly string[];
}

function toStoredMessage(coalescedWork: StoredCoalescedWork | null): string {
    const envelope = {
        type: 'RTC_TOPOLOGY_RECOMPUTE',
        topicId: 'app-outbox.rtc-topology',
        resourceId: 'overlay:group-revision',
        contextId: 'room',
        senderId: 'server-1',
        data: coalescedWork === null
            ? { kind: 'group-revision', overlayId: 'overlay' }
            : { kind: 'group-revision', overlayId: 'overlay', __rallarCoalescedWork: coalescedWork }
    };
    return JSON.stringify({
        id: { v: 2, msgId: 'overlay:group-revision:g1', ts: 1_000, senderId: 'server-1' },
        payload: { typeId: 'RTC_TOPOLOGY_RECOMPUTE', contentType: 'application/json', resource: JSON.stringify(envelope) }
    });
}

function readCoalescedWork(storedMessage: string): StoredCoalescedWork | undefined {
    const message = JSON.parse(storedMessage);
    return JSON.parse(message.payload.resource).data.__rallarCoalescedWork;
}

Deno.test('the window-anchor migration backfills coalesced rows written before the anchor existed', async () => {
    const lifecycle = await createApiV1TestPGliteDatabaseLifecycle();
    try {
        const sql = lifecycle.database;
        const rows = [
            ['legacy', toStoredMessage({ generation: 3, requestedAtEpochMs: 1_800, dueAtEpochMs: 2_300, reasons: ['group-revision'] })],
            [
                'anchored',
                toStoredMessage({ generation: 1, requestedAtEpochMs: 1_000, windowOpenedAtEpochMs: 900, dueAtEpochMs: 1_500, reasons: ['group-revision'] })
            ],
            ['plain', toStoredMessage(null)]
        ] as const;
        for (const [resourceId, resource] of rows) {
            await sql`
                insert into resource_inbox (
                    ri_resource_id, ri_topic_id, ri_resource, ri_type_id, ri_status, fk_ext_bank_id,
                    system_date, created_by, created_ts, ri_attempts, expire_ts
                ) values (
                    ${resourceId}, 'app-outbox.rtc-topology', ${resource}, 'APP_OUTBOX', 'RETRY', 'room',
                    '2026-09-02', 'server-1', '2026-09-02 15:00:00', 0, '2026-09-03 15:00:00'
                )
            `;
        }

        await sql.exec(await Deno.readTextFile(MIGRATION_URL));

        const stored = await sql<{ ri_resource_id: string; ri_resource: string; }[]>`
            select ri_resource_id, ri_resource from resource_inbox order by ri_resource_id
        `;
        const byId = new Map(stored.map((row) => [row.ri_resource_id, readCoalescedWork(row.ri_resource)]));
        assert.deepEqual(byId.get('legacy'), {
            generation: 3,
            requestedAtEpochMs: 1_800,
            windowOpenedAtEpochMs: 1_800,
            dueAtEpochMs: 2_300,
            reasons: ['group-revision']
        });
        assert.equal(byId.get('anchored')?.windowOpenedAtEpochMs, 900);
        assert.equal(byId.get('plain'), undefined);
    }
    finally {
        await lifecycle.close();
    }
});
