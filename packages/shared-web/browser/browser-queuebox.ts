import { BROWSER_AL_RUNTIME_DB_NAME } from './browser-al-runtime-stores.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/IndexedDbQueueBox.ts';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { QueueBoxResourceEntryRepository } from '@shared/queuebox/QueueBoxTypes.ts';

export function createBrowserQueueBox(name: string): QueueBoxResourceEntryRepository {
    if (IndexedDbQueueBox.isSupported()) {
        return new IndexedDbQueueBox({
            dbName: BROWSER_AL_RUNTIME_DB_NAME,
            storeName: `queuebox:${name}`,
        });
    }

    return new InMemoryQueueBox();
}
