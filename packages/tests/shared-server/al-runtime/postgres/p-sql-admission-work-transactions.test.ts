import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';

import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

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
});

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
