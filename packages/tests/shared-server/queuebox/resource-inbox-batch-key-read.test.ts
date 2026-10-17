import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';

import { PSqlResourceInboxEntryRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import {
    createResourceInboxTestStorage,
    recordResourceInboxStatements,
    seedResourceInboxRow,
    type ResourceInboxTestStorage
} from './resource-inbox-test-storage.ts';

let storage: ResourceInboxTestStorage | undefined;

afterEach(async () => {
    await storage?.close();
    storage = undefined;
});

describe('resource inbox batch key read', () => {
    it('answers several keys with one statement, each in its own place, absent and expired rows as undefined', async () => {
        storage = await createResourceInboxTestStorage('batch_key_read');
        const live = await seedResourceInboxRow(storage.sql, { resourceId: 'live', status: EntityStatus.RESERVED, attempts: 1, startedAgoSeconds: 1 });
        const expired = await seedResourceInboxRow(storage.sql, { resourceId: 'expired', status: EntityStatus.NEW, expired: true });
        const other = await seedResourceInboxRow(storage.sql, { resourceId: 'other', status: EntityStatus.NEW });
        const missing = { ...live, resourceId: 'missing' };
        const recorded: string[] = [];
        const entries = new PSqlResourceInboxEntryRepository(recordResourceInboxStatements(storage.sql, recorded), () => new Date());

        const found = await entries.findByKeys([other, missing, expired, live]);

        expect(recorded).toHaveLength(1);
        expect(found.map((entry) => entry?.key.resourceId)).toEqual(['other', undefined, undefined, 'live']);
        expect(found[3]).toEqual(await entries.findByKey(live));
    });
});
