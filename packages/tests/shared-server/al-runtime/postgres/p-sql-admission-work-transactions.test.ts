import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import type { PSqlParameter } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlResourceInboxEntryReader } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-reader.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import {
    EntityStatus,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

import { createPSqlAdmissionTestStorage, type PSqlAdmissionTestStorage } from './create-p-sql-admission-test-storage.ts';

describe('AL admission persistence-ready queue work', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each(['insert', 'replace'] as const)('converts caller timestamps before the %s transaction', async (operation) => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const backend = new PSqlAdmissionWorkBackend({ sql, namespace: 'admission', nowMs: Date.now });
        const entry = createEntry();
        if (operation === 'replace') {
            await backend.workQueue.enqueue({ ...entry, resource: 'previous' });
        }
        let transactionActive = false;
        const begin = sql.begin.bind(sql);
        vi.spyOn(sql, 'begin').mockImplementation(async (write) => {
            transactionActive = true;
            try {
                return await begin(write);
            }
            finally {
                transactionActive = false;
            }
        });
        const createdTimestamp = entry.audit.createdTs.toString();
        const expiryTimestamp = entry.audit.expiryTs.toString();
        vi.spyOn(entry.audit.createdTs, 'toString').mockImplementation(() => {
            if (transactionActive) {
                throw new Error('Caller timestamp converted inside transaction');
            }
            return createdTimestamp;
        });
        vi.spyOn(entry.audit.expiryTs, 'toString').mockImplementation(() => {
            if (transactionActive) {
                throw new Error('Caller expiry converted inside transaction');
            }
            return expiryTimestamp;
        });

        await backend.write(async (write) => {
            await write.readWork(entry.key);
            await write.set('admitted', 'accepted');
            write.writeWork(entry);
        });

        expect(await backend.read('admitted', (value) => value)).toBe('accepted');
        expect(await backend.workQueue.getItem(entry.key)).toMatchObject({
            resource: 'computed message',
            status: EntityStatus.NEW,
            dequeueAudit: { attempts: 0 }
        });
        expect(entry.resource).toBe('computed message');
        expect(entry.db).toBeUndefined();
    });

    it('commits one mixed release batch in one transaction, each entry on its own disposition', async () => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const backend = new PSqlAdmissionWorkBackend({ sql, namespace: 'admission', nowMs: Date.now });
        for (const resourceId of ['mixed-completed', 'mixed-retry', 'mixed-not-ready']) {
            await backend.workQueue.enqueue({ ...createEntry(), key: { topicId: 'alm-work', resourceId, contextId: 'admission' } });
        }
        const reserved = byResourceId(
            await backend.workQueue.reserveEntries({
                typeIds: new Set(['alm-work']),
                statusIds: new Set([EntityStatus.NEW]),
                reservationInput: 3
            })
        );
        const begin = vi.spyOn(sql, 'begin');

        const released = byResourceId(
            await backend.workQueue.releaseEntries([
                {
                    entry: reserved.get('mixed-completed')!,
                    disposition: { status: EntityStatus.COMPLETED, delayMs: null }
                },
                { entry: reserved.get('mixed-retry')!, disposition: { status: EntityStatus.RETRY, delayMs: 37 } },
                {
                    entry: reserved.get('mixed-not-ready')!,
                    disposition: { status: EntityStatus.RETRY, delayMs: 5_000, reason: 'not-ready' }
                }
            ])
        );

        expect(begin).toHaveBeenCalledTimes(1);
        expect(released.get('mixed-completed')).toMatchObject({ status: EntityStatus.COMPLETED });
        expect(released.get('mixed-retry')).toMatchObject({ status: EntityStatus.RETRY });
        expect(released.get('mixed-not-ready')).toMatchObject({ status: EntityStatus.RETRY });
        expect(toReleaseDelayMs(released.get('mixed-retry')!)).toBe(37);
        expect(toReleaseDelayMs(released.get('mixed-not-ready')!)).toBe(5_000);
        // A terminal release leaves no next attempt at all, so the batch cannot have shared one disposition.
        expect(released.get('mixed-completed')!.dequeueAudit.nextTs).toBeUndefined();
    });

    it.each(['held', 'rewritten'] as const)(
        'fences a commit on a %s claimed row without reading it again',
        async (use) => {
            const { sql } = await createPSqlAdmissionTestStorage();
            const backend = new PSqlAdmissionWorkBackend({ sql, namespace: 'admission', nowMs: Date.now });
            const claimed = await claimEntry(backend);
            const findByKey = vi.spyOn(PSqlResourceInboxEntryReader.prototype, 'findByKey');
            const findByKeys = vi.spyOn(PSqlResourceInboxEntryReader.prototype, 'findByKeys');

            await backend.write(async (write) => {
                expect(await write.readClaimedWork(claimed)).toEqual(claimed);
                await write.set('admitted', 'accepted');
                if (use === 'rewritten') {
                    write.writeWork({ ...claimed, resource: 'frozen message' });
                }
            });

            expect(findByKey).not.toHaveBeenCalled();
            expect(findByKeys).not.toHaveBeenCalled();
            expect(await backend.read('admitted', (value) => value)).toBe('accepted');
            expect((await backend.workQueue.getItem(claimed.key))?.resource)
                .toBe(use === 'rewritten' ? 'frozen message' : 'computed message');
        }
    );

    it.each(['held', 'rewritten'] as const)(
        'conflicts the whole commit when a %s claimed row moved after its claim',
        async (use) => {
            const { sql } = await createPSqlAdmissionTestStorage();
            const backend = new PSqlAdmissionWorkBackend({ sql, namespace: 'admission', nowMs: Date.now });
            const claimed = await claimEntry(backend);
            // Another owner's claim after a lease expiry moves exactly the attempt columns.
            await sql`update resource_inbox set ri_attempts = ri_attempts + 1 where ri_resource_id = ${claimed.key.resourceId}`;

            await expect(backend.write(async (write) => {
                await write.readClaimedWork(claimed);
                await write.set('admitted', 'accepted');
                if (use === 'rewritten') {
                    write.writeWork({ ...claimed, resource: 'frozen message' });
                }
            })).rejects.toBeInstanceOf(ALAdmissionBackendConflictError);

            expect(await backend.read('admitted', (value) => value)).toBeUndefined();
            expect((await backend.workQueue.getItem(claimed.key))?.resource).toBe('computed message');
        }
    );

    it('writes the named fence first and every other state row as its effect, in one statement', async () => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const backend = new PSqlAdmissionWorkBackend({ sql, namespace: 'admission', nowMs: Date.now });
        await backend.write(async (write) => await write.set('version', 0));
        const statements = recordPGliteTransactionStatements(sql.raw);

        await backend.write(async (write) => {
            await write.set('effect:a', 'a');
            await write.setFence('version', 1);
            await write.set('effect:b', 'b');
        });

        const stateWrites = statements().filter(({ query }) => query.includes('runtime_state_store'));
        expect(stateWrites).toHaveLength(1);
        expect(statements()[0]).toBe(stateWrites[0]);
        expect(stateWrites[0]!.params[0]).toMatchObject({ operation: 'update', key: 'version', expectedRevision: 0 });
        expect(await backend.read('version', (value) => value)).toBe(1);
        expect(await backend.read('effect:a', (value) => value)).toBe('a');
        expect(await backend.read('effect:b', (value) => value)).toBe('b');
    });

    it('rejects a commit whose named fence writes no row instead of fencing it on another row', async () => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const backend = new PSqlAdmissionWorkBackend({ sql, namespace: 'admission', nowMs: Date.now });

        await expect(backend.write(async (write) => {
            await write.setFence('version', 1, Date.now() - 1);
            await write.set('effect:a', 'a');
        })).rejects.toThrow('The fence of an admission commit writes no row');

        expect(await backend.read('effect:a', (value) => value)).toBeUndefined();
    });

    it('writes none of a commit whose fence moved after the commit read it', async () => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const backend = new PSqlAdmissionWorkBackend({ sql, namespace: 'admission', nowMs: Date.now });
        await backend.write(async (write) => await write.set('version', 0));
        const entry = createEntry();

        await expect(backend.write(async (write) => {
            await write.read('version', (value) => value);
            await write.readWork(entry.key);
            // Another commit of the same sender lands between this commit's read and its write.
            await sql`update runtime_state_store set revision = revision + 1 where store_key = 'version'`;
            await write.set('effect:a', 'a');
            await write.setFence('version', 1);
            write.writeWork(entry);
        })).rejects.toBeInstanceOf(ALAdmissionBackendConflictError);

        expect(await backend.read('version', (value) => value)).toBe(0);
        expect(await backend.read('effect:a', (value) => value)).toBeUndefined();
        expect(await backend.workQueue.getItem(entry.key)).toBeUndefined();
    });

    it('holds every claimed row and inserts every new row of a commit in one statement each', async () => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const backend = new PSqlAdmissionWorkBackend({ sql, namespace: 'admission', nowMs: Date.now });
        const claimed = await claimEntries(backend, ['held-1', 'held-2', 'held-3']);
        const inserted = ['new-1', 'new-2', 'new-3'].map(createEntryOf);
        const statements = recordPGliteTransactionStatements(sql.raw);

        await backend.write(async (write) => {
            await Promise.all(claimed.map((entry) => write.readClaimedWork(entry)));
            await Promise.all(inserted.map((entry) => write.readWork(entry.key)));
            await write.setFence('version', 1);
            inserted.forEach((entry) => write.writeWork(entry));
        });

        expect(statements().map(({ query }) => toStatementKind(query))).toEqual(['state', 'hold', 'insert']);
        for (const entry of inserted) {
            expect(await backend.workQueue.getItem(entry.key)).toMatchObject({ resource: 'computed message' });
        }
    });

    it('conflicts the whole commit when one of several held claimed rows moved after its claim', async () => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const backend = new PSqlAdmissionWorkBackend({ sql, namespace: 'admission', nowMs: Date.now });
        const claimed = await claimEntries(backend, ['held-1', 'held-2', 'held-3']);
        await sql`update resource_inbox set ri_attempts = ri_attempts + 1 where ri_resource_id = 'held-2'`;

        await expect(backend.write(async (write) => {
            await Promise.all(claimed.map((entry) => write.readClaimedWork(entry)));
            await write.setFence('version', 1);
        })).rejects.toBeInstanceOf(ALAdmissionBackendConflictError);

        expect(await backend.read('version', (value) => value)).toBeUndefined();
    });

    it('replaces an expired row in place of a new one, and conflicts on a live row written since the read', async () => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const backend = new PSqlAdmissionWorkBackend({ sql, namespace: 'admission', nowMs: Date.now });
        const expired = createEntryOf('expired');
        await backend.workQueue.enqueue({
            ...expired,
            resource: 'expired message',
            audit: { ...expired.audit, expiryTs: Temporal.Instant.from('2000-01-01T00:00:00Z') }
        });
        const raced = createEntryOf('raced');

        await backend.write(async (write) => {
            expect(await write.readWork(expired.key)).toBeUndefined();
            write.writeWork(expired);
        });
        await expect(backend.write(async (write) => {
            await write.readWork(raced.key);
            await backend.workQueue.enqueue({ ...raced, resource: 'racing message' });
            await write.set('effect:a', 'a');
            write.writeWork(raced);
        })).rejects.toBeInstanceOf(ALAdmissionBackendConflictError);

        expect((await backend.workQueue.getItem(expired.key))?.resource).toBe('computed message');
        expect((await backend.workQueue.getItem(raced.key))?.resource).toBe('racing message');
        expect(await backend.read('effect:a', (value) => value)).toBeUndefined();
    });

    it('commits two concurrent writes on disjoint keys, neither fencing the other', async () => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const backend = new PSqlAdmissionWorkBackend({ sql, namespace: 'admission', nowMs: Date.now });

        await Promise.all([
            backend.write(async (write) => {
                await write.read('admitted:first', (value) => value);
                await write.set('admitted:first', 'first');
            }),
            backend.write(async (write) => {
                await write.read('admitted:second', (value) => value);
                await write.set('admitted:second', 'second');
            })
        ]);

        expect(await backend.read('admitted:first', (value) => value)).toBe('first');
        expect(await backend.read('admitted:second', (value) => value)).toBe('second');
    });
});

interface PGliteTransactionStatement {
    readonly query: string;
    readonly params: readonly PSqlParameter[];
}

/** Every statement PGlite runs inside a transaction, with its parameters, in the order it ran. */
function recordPGliteTransactionStatements(raw: PSqlAdmissionTestStorage['sql']['raw']): () => readonly PGliteTransactionStatement[] {
    const statements: PGliteTransactionStatement[] = [];
    const transaction = raw.transaction.bind(raw);
    vi.spyOn(raw, 'transaction').mockImplementation((callback) =>
        transaction((tx) => {
            const txQuery = tx.query.bind(tx);
            return callback(Object.assign(Object.create(tx), {
                query: (...args: Parameters<typeof tx.query>) => {
                    statements.push({ query: args[0], params: args[1] ?? [] });
                    return txQuery(...args);
                }
            }));
        })
    );
    return () => statements;
}

function toStatementKind(query: string): string {
    if (query.includes('runtime_state_store')) {
        return 'state';
    }
    return /^\s*insert into resource_inbox/u.test(query) ? 'insert' : /for update/u.test(query) ? 'hold' : query;
}

async function claimEntries(backend: PSqlAdmissionWorkBackend, resourceIds: readonly string[]): Promise<ResourceEntry[]> {
    for (const resourceId of resourceIds) {
        await backend.workQueue.enqueue(createEntryOf(resourceId));
    }
    const claimed = [...(await backend.workQueue.reserveEntries({
        typeIds: new Set(['alm-work']),
        statusIds: new Set([EntityStatus.NEW]),
        reservationInput: resourceIds.length
    })).values()];
    if (claimed.length !== resourceIds.length) {
        throw new Error('Expected every enqueued entry to be claimed');
    }
    return claimed;
}

async function claimEntry(backend: PSqlAdmissionWorkBackend): Promise<ResourceEntry> {
    await backend.workQueue.enqueue(createEntry());
    const [claimed] = (await backend.workQueue.reserveEntries({
        typeIds: new Set(['alm-work']),
        statusIds: new Set([EntityStatus.NEW]),
        reservationInput: 1
    })).values();
    if (claimed === undefined) {
        throw new Error('Expected the enqueued entry to be claimed');
    }
    return claimed;
}

function byResourceId(entries: Map<Key, ResourceEntry>): Map<string, ResourceEntry> {
    return new Map([...entries.values()].map((entry) => [entry.key.resourceId, entry]));
}

function toReleaseDelayMs(released: ResourceEntry): number {
    return released.dequeueAudit.endTs!.until(released.dequeueAudit.nextTs!).total({ unit: 'milliseconds' });
}

function createEntry(): ResourceEntry {
    return createEntryOf('first');
}

function createEntryOf(resourceId: string): ResourceEntry {
    return {
        key: { topicId: 'alm-work', resourceId, contextId: 'admission' },
        typeId: 'alm-work',
        resource: 'computed message',
        status: EntityStatus.NEW,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'sender',
            createdTs: Temporal.PlainDateTime.from('2026-09-06T12:00:00'),
            expiryTs: Temporal.Instant.from('2099-01-01T00:00:00Z')
        },
        dequeueAudit: { attempts: 0 }
    };
}
