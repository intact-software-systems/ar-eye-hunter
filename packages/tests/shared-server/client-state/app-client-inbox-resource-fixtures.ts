import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import {
  EntityStatus,
  isExpiredResourceEntry,
  type Key,
  type ResourceEntry,
  toKeyAsString,
} from '@shared/queuebox/ResourceEntry.ts';

export class TestResourceInbox extends InMemoryQueueBox {
  async isEntryWithStatus(key: Key, statuses: EntityStatus[]): Promise<boolean> {
    const entry = await this.getItem(key);
    return entry !== undefined && statuses.includes(entry.status);
  }
}

export class TestResourceInboxResults {
  private readonly data = new Map<string, ResourceEntry>();

  async replace(entry: ResourceEntry): Promise<ResourceEntry> {
    this.data.set(toKeyAsString(entry.key), entry);
    return entry;
  }

  async writeIfAbsentOrReplaceExpired(entry: ResourceEntry): Promise<ResourceEntry> {
    const key = toKeyAsString(entry.key);
    const existing = this.data.get(key);
    if (existing !== undefined && !isExpiredResourceEntry(existing)) {
      return existing;
    }

    this.data.set(key, entry);
    return entry;
  }

  async findByKey(key: Key): Promise<ResourceEntry | undefined> {
    const entry = this.data.get(toKeyAsString(key));
    return entry === undefined || isExpiredResourceEntry(entry) ? undefined : entry;
  }
}
