import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { ResourceInboxStatusAndAttempts } from '../../queuebox/postgres/resource-inbox-row-codec.ts';

export interface AppInboxEntryRepository {
    readStatusAndAttempts(key: Key): Promise<ResourceInboxStatusAndAttempts | undefined>;
    tryWriteIfAbsentOrReplaceExpired(entry: ResourceEntry): Promise<ResourceEntry | null>;
    replaceIfObserved(
        expected: ResourceEntry,
        replacement: ResourceEntry
    ): Promise<ResourceEntry | null>;
    /**
     * Reserves one absent/expired placeholder and invokes the winning materializer once, without a local retry.
     * A losing or active replay returns the retained row without invoking it. The bounded materializer may
     * construct its canonical envelope (IDs, clock, serialization); it owns no I/O, scheduling or retry.
     * Only its resource replaces the placeholder: queue identity, audit and attempts remain those reserved.
     * Materialization/identity/replacement failure rolls the placeholder back; resolution follows commit.
     */
    writeMaterializedIfAbsentOrReplaceExpired(
        placeholder: ResourceEntry,
        materialize: () => Promise<ResourceEntry>
    ): Promise<ResourceEntry>;
}

export interface AppInboxResultRepository {
    replace(entry: ResourceEntry): Promise<ResourceEntry>;
    findByKey(key: Key): Promise<ResourceEntry | undefined>;
}
