// @vitest-environment happy-dom

import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it
} from 'vitest';

import { toPSqlReservationObservations } from '@shared-server/queuebox/postgres/to-p-sql-reservation-observations.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { IndexedDbConnection, openIndexedDbWithStores } from '@shared/persistence/open-indexed-db.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { toIndexedDbQueueStoreDefinition } from '@shared/queuebox/indexed-db-queue-box-store.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import {
    resolveResourceInboxReservationObservation,
    type ResourceInboxReservationObservation
} from '@shared/queuebox/resource-inbox/resource-inbox-reservation-observation.ts';
import { EntityStatus, toKeyAsString, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import '../setup-browser-indexeddb.ts';

const entry: ResourceEntry = {
    key: { topicId: 'topic', resourceId: 'resource', contextId: 'context' },
    typeId: 'APP_INBOX',
    resource: '{}',
    status: EntityStatus.RESERVED,
    dequeueAudit: { attempts: 2, startTs: Temporal.Instant.from('2026-01-01T00:00:00Z') },
    audit: {
        date: Temporal.PlainTime.from('00:00'),
        createdBy: 'test',
        createdTs: Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
        expiryTs: Temporal.Instant.from('2027-01-01T00:00:00Z')
    }
};
const observation: ResourceInboxReservationObservation = {
    key: { ...entry.key },
    reservationAttempt: 2,
    availability: 'available',
    boundary: 'postgres-update-returning',
    association: 'physical-key-and-reservation-attempt',
    previousPersistedRetryDelayUs: 5_000_000,
    dueToReservationObservationUs: -1
};

describe('retry observation decoding and association', () => {
    it.each(['NaN', 'Infinity', '1.2', '9007199254740992', '-9007199254740992', '', null, undefined])(
        'marks invalid numeric transport %s unavailable without changing the authoritative entry',
        (value) => {
            const result = toPSqlReservationObservations([{
                entry,
                selectedStatus: 'RETRY',
                selectedEndTs: '2026-01-01 00:00:00',
                selectedNextTs: '2026-01-01 00:00:01',
                previousPersistedRetryDelayUs: '1',
                dueToReservationObservationUs: value
            }]);
            expect(result).toMatchObject([{ availability: 'unavailable', reason: 'invalid-observation', reservationAttempt: 2 }]);
            expect(entry.status).toBe(EntityStatus.RESERVED);
        }
    );
    it.each(['-9007199254740991', '9007199254740991', '-1', '0', '1'])(
        'retains signed safe integer transport %s',
        (value) => {
            expect(
                toPSqlReservationObservations([{
                    entry,
                    selectedStatus: 'RETRY',
                    selectedEndTs: '2026-01-01 00:00:00',
                    selectedNextTs: '2026-01-01 00:00:01',
                    previousPersistedRetryDelayUs: value,
                    dueToReservationObservationUs: value
                }])
            )
                .toMatchObject([{ availability: 'available', previousPersistedRetryDelayUs: Number(value), dueToReservationObservationUs: Number(value) }]);
        }
    );
    it.each([
        [],
        [observation, observation],
        [{ ...observation, reservationAttempt: 1 }],
        [{ ...observation, key: { ...entry.key, contextId: 'other' } }]
    ].map((observations) => ({ observations })))('never guesses missing, duplicate or foreign invocation facts', ({ observations }) => {
        expect(resolveResourceInboxReservationObservation(entry, observations)).toMatchObject({ availability: 'unavailable', reason: 'invalid-observation' });
    });
    it('matches copied physical keys and keeps independent invocation results', () => {
        expect(resolveResourceInboxReservationObservation(entry, [observation])).toEqual(observation);
        expect(resolveResourceInboxReservationObservation(entry, [{ ...observation, dueToReservationObservationUs: 2 }]))
            .toMatchObject({ dueToReservationObservationUs: 2 });
        expect(resolveResourceInboxReservationObservation(entry, [observation])).toMatchObject({ dueToReservationObservationUs: -1 });
    });
    it('reports a non-PostgreSQL capture unavailable while preserving its normal claim', async () => {
        const queued = { ...entry, status: EntityStatus.NEW, dequeueAudit: { attempts: 0 } };
        const queue = new InMemoryQueueBox(new Map([[entry.key, queued]]), () => Temporal.Instant.from('2026-01-01T00:00:01Z'));
        const result = await queue.reserveEntries({
            typeIds: new Set(['APP_INBOX']),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 1,
            reservationObservation: 'postgres-ordinary-retry-v1'
        });
        expect([...result.entries.values()]).toMatchObject([{ status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } }]);
        expect(result.observations).toMatchObject([{ availability: 'unavailable', reason: 'unsupported-backend' }]);
    });
    it('reports IndexedDB capture unsupported after the same committed claim', async () => {
        const dbName = `retry-observation-${crypto.randomUUID()}`;
        const connection = new IndexedDbConnection(() => openIndexedDbWithStores(dbName, [toIndexedDbQueueStoreDefinition('entries')]));
        const queue = new IndexedDbQueueBox({
            connection,
            storeName: 'entries',
            observer: createPassThroughIndexedDbOperationObserver(),
            now: () => Temporal.Instant.from('2026-01-01T00:00:01Z')
        });
        try {
            await queue.enqueue({ ...entry, status: EntityStatus.NEW, dequeueAudit: { attempts: 0 } });
            const result = await queue.reserveEntries({
                typeIds: new Set(['APP_INBOX']),
                statusIds: new Set([EntityStatus.NEW]),
                reservationInput: 1,
                reservationObservation: 'postgres-ordinary-retry-v1'
            });
            expect([...result.entries.values()]).toMatchObject([{ status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } }]);
            expect(result.observations).toMatchObject([{ availability: 'unavailable', reason: 'unsupported-backend' }]);
            expect(await queue.getItem(entry.key)).toMatchObject({ status: EntityStatus.RESERVED });
        }
        finally {
            await connection.close();
        }
    });

    it('does not invent rollback or successful evidence for a partially failed in-memory call', async () => {
        const first = { ...entry, status: EntityStatus.NEW, dequeueAudit: { attempts: 0 } };
        const second = { ...first, key: { ...first.key, resourceId: 'second' } };
        const queue = new InMemoryQueueBox(new Map([[first.key, first], [second.key, second]]), () => Temporal.Instant.from('2026-01-01T00:00:01Z'));
        // The selection fails once the store has reserved the first row, whatever lookups the claim made before that.
        class FailingStatusSelection extends Set<EntityStatus> {
            override has(status: EntityStatus): boolean {
                if (queue.peek(toKeyAsString(first.key))?.status === EntityStatus.RESERVED) {
                    throw new Error('selection failed');
                }
                return super.has(status);
            }
        }
        await expect(
            queue.reserveEntries({
                typeIds: new Set(['APP_INBOX']),
                statusIds: new FailingStatusSelection([EntityStatus.NEW]),
                reservationInput: 2,
                reservationObservation: 'postgres-ordinary-retry-v1'
            })
        ).rejects.toThrow('selection failed');
        expect(await queue.getItem(first.key)).toMatchObject({ status: EntityStatus.RESERVED });
        expect(await queue.getItem(second.key)).toMatchObject({ status: EntityStatus.NEW });
    });
});
