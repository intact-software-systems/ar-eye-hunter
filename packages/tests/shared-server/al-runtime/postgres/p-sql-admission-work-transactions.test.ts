import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import { EntityStatus, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { createPSqlAdmissionTestStorage } from './create-p-sql-admission-test-storage.ts';

describe('AL admission persistence-ready queue work', () => {
    it.each(['insert', 'replace'] as const)('converts caller timestamps before the %s transaction', async (operation) => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const backend = new PSqlAdmissionWorkBackend(sql, 'admission');
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
        const backend = new PSqlAdmissionWorkBackend(sql, 'admission');
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

    it('commits two concurrent writes on disjoint keys, neither fencing the other', async () => {
        const { sql } = await createPSqlAdmissionTestStorage();
        const backend = new PSqlAdmissionWorkBackend(sql, 'admission');

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

function byResourceId(entries: Map<Key, ResourceEntry>): Map<string, ResourceEntry> {
    return new Map([...entries.values()].map((entry) => [entry.key.resourceId, entry]));
}

function toReleaseDelayMs(released: ResourceEntry): number {
    return released.dequeueAudit.endTs!.until(released.dequeueAudit.nextTs!).total({ unit: 'milliseconds' });
}

function createEntry(): ResourceEntry {
    return {
        key: { topicId: 'alm-work', resourceId: 'first', contextId: 'admission' },
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
