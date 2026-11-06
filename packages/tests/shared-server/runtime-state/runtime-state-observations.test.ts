import { computeRuntimeStateObservations } from '@shared-server/runtime-state/observation/runtime-state-observation.ts';
import { readRuntimeStateObservationsCurrent } from '@shared-server/runtime-state/postgres/read-runtime-state-observations-current.ts';
import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import { expect, it } from 'vitest';
import { createResourceInboxTestStorage, type ResourceInboxTestStorage } from '../queuebox/resource-inbox-test-storage.ts';

const LIVE_EXPIRY = Date.parse('9999-01-01T00:00:00.000Z');

it('holds an observation while revision, value and expiry are unchanged, and never rewrites the row', async () => {
    const storage = await createResourceInboxTestStorage('runtime_state_observations');
    try {
        await insertRow(storage, 'issued', LIVE_EXPIRY);
        const entry = await readEntry(storage);
        const observed = computeRuntimeStateObservations([{ namespace: 'observed', key: 'session', entry }]);
        expect(await readRuntimeStateObservationsCurrent(storage.sql, observed)).toBe(true);
        expect(await readEntry(storage)).toEqual(entry);
        await storage.sql`update runtime_state_store set store_value = 'revoked', revision = revision + 1
            where store_namespace = 'observed' and store_key = 'session'`;
        expect(await readRuntimeStateObservationsCurrent(storage.sql, observed)).toBe(false);
    }
    finally {
        await storage.close();
    }
});

it('treats a missing or expired row as the same absence and an inserted live row as a change', async () => {
    const storage = await createResourceInboxTestStorage('runtime_state_observed_absence');
    try {
        const absent = computeRuntimeStateObservations([{ namespace: 'observed', key: 'session', entry: null }]);
        expect(await readRuntimeStateObservationsCurrent(storage.sql, absent)).toBe(true);
        await insertRow(storage, 'expired', Date.now() - 1000);
        expect(await readRuntimeStateObservationsCurrent(storage.sql, absent)).toBe(true);
        await storage.sql`delete from runtime_state_store where store_namespace = 'observed'`;
        await insertRow(storage, 'issued', LIVE_EXPIRY);
        expect(await readRuntimeStateObservationsCurrent(storage.sql, absent)).toBe(false);
        expect(() =>
            computeRuntimeStateObservations([
                { namespace: 'observed', key: 'session', entry: null },
                { namespace: 'observed', key: 'session', entry: null }
            ])
        ).toThrow(TypeError);
    }
    finally {
        await storage.close();
    }
});

async function insertRow(storage: ResourceInboxTestStorage, value: string, expireAtEpochMs: number): Promise<void> {
    await storage.sql`insert into runtime_state_store(store_namespace, store_key, store_value, expire_at_ts, updated_ts, revision)
        values ('observed', 'session', ${value}, ${new Date(expireAtEpochMs).toISOString()}::timestamptz, now(), 0)`;
}

async function readEntry(storage: ResourceInboxTestStorage): Promise<RuntimeStateEntry> {
    const [row] = await storage.sql<{ store_value: string; expire_at_ts: Date; revision: number | string; }[]>`
        select store_value, expire_at_ts, revision from runtime_state_store
        where store_namespace = 'observed' and store_key = 'session'`;
    return {
        key: 'session',
        value: row.store_value,
        expireAtTimestamp: new Date(row.expire_at_ts).getTime(),
        updatedTimestamp: '',
        revision: Number(row.revision)
    };
}
