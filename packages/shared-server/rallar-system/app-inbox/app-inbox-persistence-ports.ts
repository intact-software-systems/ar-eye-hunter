import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { ResourceInboxStatusAndAttempts } from '../../queuebox/postgres/resource-inbox-row-codec.ts';

export interface AppInboxEntryRepository {
    readStatusAndAttempts(key: Key): Promise<ResourceInboxStatusAndAttempts | undefined>;
    tryWriteIfAbsentOrReplaceExpired(entry: ResourceEntry): Promise<ResourceEntry | null>;
    replaceIfObserved(
        expected: ResourceEntry,
        replacement: ResourceEntry
    ): Promise<ResourceEntry | null>;
    writeMaterializedIfAbsentOrReplaceExpired(
        placeholder: ResourceEntry,
        materialize: () => Promise<ResourceEntry>
    ): Promise<ResourceEntry>;
}

export interface AppInboxResultRepository {
    replace(entry: ResourceEntry): Promise<ResourceEntry>;
    findByKey(key: Key): Promise<ResourceEntry | undefined>;
}
