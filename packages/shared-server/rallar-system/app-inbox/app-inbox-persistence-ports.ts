import type { EntityStatus, Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

export interface AppInboxEntryRepository {
    isEntryWithStatus(key: Key, statuses: EntityStatus[]): Promise<boolean>;
    writeMaterializedIfAbsentOrReplaceExpired(
        placeholder: ResourceEntry,
        materialize: () => Promise<ResourceEntry>
    ): Promise<ResourceEntry>;
}

export interface AppInboxResultRepository {
    replace(entry: ResourceEntry): Promise<ResourceEntry>;
    findByKey(key: Key): Promise<ResourceEntry | undefined>;
}
