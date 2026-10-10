import type { ResourceInboxStatusAndAttempts } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { isExpiredResourceEntry, toKeyAsString, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

export class TestResourceInbox extends InMemoryQueueBox {
    private readonly materializations = new Map<string, Promise<ResourceEntry>>();

    async readStatusAndAttempts(key: Key): Promise<ResourceInboxStatusAndAttempts | undefined> {
        const entry = await this.getItem(key);
        return entry === undefined ? undefined : { status: entry.status, attempts: entry.dequeueAudit.attempts };
    }

    async writeMaterializedIfAbsentOrReplaceExpired(
        placeholder: ResourceEntry,
        materialize: () => Promise<ResourceEntry>
    ): Promise<ResourceEntry> {
        const key = toKeyAsString(placeholder.key);
        const active = this.materializations.get(key);
        if (active !== undefined) {
            return await active;
        }
        const pending = this.materializeEntry(placeholder, materialize);
        this.materializations.set(key, pending);
        try {
            return await pending;
        }
        finally {
            this.materializations.delete(key);
        }
    }

    private async materializeEntry(
        placeholder: ResourceEntry,
        materialize: () => Promise<ResourceEntry>
    ): Promise<ResourceEntry> {
        const existing = await this.getItem(placeholder.key);
        if (existing !== undefined && !isExpiredResourceEntry(existing)) {
            return existing;
        }
        const materialized = await materialize();
        return await this.enqueueIfAbsent({ ...placeholder, resource: materialized.resource });
    }
}

export class TestResourceInboxResults {
    private readonly data = new Map<string, ResourceEntry>();

    async replace(entry: ResourceEntry): Promise<ResourceEntry> {
        this.data.set(toKeyAsString(entry.key), entry);
        return entry;
    }

    async findByKey(key: Key): Promise<ResourceEntry | undefined> {
        const entry = this.data.get(toKeyAsString(key));
        return entry === undefined || isExpiredResourceEntry(entry) ? undefined : entry;
    }
}
