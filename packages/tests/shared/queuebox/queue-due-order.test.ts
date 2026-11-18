import 'fake-indexeddb/auto';

import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';

import { describeQueueDueOrderContract } from './queue-due-order-contract.ts';

describeQueueDueOrderContract('memory', async () => new InMemoryQueueBox());

describeQueueDueOrderContract('IndexedDB', async () =>
    new IndexedDbQueueBox({
        dbName: `queue-due-order-${crypto.randomUUID()}`,
        storeName: IndexedDbQueueBox.DEFAULT_STORE_NAME,
        observer: createPassThroughIndexedDbOperationObserver()
    }));
