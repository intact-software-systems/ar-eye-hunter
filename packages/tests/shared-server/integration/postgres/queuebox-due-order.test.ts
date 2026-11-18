import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe } from 'vitest';

import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';

import { describeQueueDueOrderContract } from '../../../shared/queuebox/queue-due-order-contract.ts';
import { createResourceInboxTestStorage, type ResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';

const openStorages: ResourceInboxTestStorage[] = [];

afterEach(async () => {
    await Promise.all(openStorages.splice(0).map(async (storage) => await storage.close()));
});

describe.skipIf(process.env.RALLAR_POSTGRES_INTEGRATION !== '1')('Postgres QueueBox due order', () => {
    describeQueueDueOrderContract('PostgreSQL', async () => {
        const storage = await createResourceInboxTestStorage('queuebox_due_order', 1, 'postgres');
        openStorages.push(storage);
        return new PSqlQueueBox(createPSqlResourceInboxRepository(storage.sql, () => new Date()), Temporal.Now.instant);
    });
});
