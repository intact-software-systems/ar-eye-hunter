/// <reference lib="deno.unstable" />
import { QueueBoxResourceEntryRepository } from '@shared/queuebox/QueueBoxTypes.ts';
import type { PersistenceSetItemOptions } from '@shared/persistence/PersistenceProvider.ts';
import { RateLimiter } from '@shared/resilience/Resilience.ts';
import {
    EntityStatus,
    FAILED_STATUS,
    isExpiredResourceEntry,
    Key,
    NEW_AND_RETRY_STATUSES,
    ResourceEntry,
    TIMEOUT_ON_NON_RESPONSIVE_ENTRY,
} from '@shared/queuebox/ResourceEntry.ts';
import { getKv } from '../db/kv.ts';

const kv: Deno.Kv = await getKv();

export class KVQueueBox implements QueueBoxResourceEntryRepository {

    cleanup(): void {
        void this.deleteExpired().catch((error) => {
            console.error('Failed to cleanup expired KV queue rows', error);
        });
    }

    async isAnyEntryToLock(typeIds: Set<string>, checkTimeout: RateLimiter, checkFailed: RateLimiter): Promise<boolean> {
        let hasFailed = false;
        let hasTimedOutReserved = false;
        const now = Temporal.Now.instant();

        for await (const item of kv.list<ResourceEntry>({ prefix: [] })) {
            const entry = await this.toLiveEntry(item);
            if (!entry || !typeIds.has(entry.typeId)) {
                continue;
            }

            if (NEW_AND_RETRY_STATUSES.has(entry.status)) {
                return true;
            }

            if (FAILED_STATUS.has(entry.status)) {
                hasFailed = true;
            }

            if (this.isReservedEntryTimedOut(entry, TIMEOUT_ON_NON_RESPONSIVE_ENTRY, now)) {
                hasTimedOutReserved = true;
            }
        }

        const isFailedEntryToLock = hasFailed
            ? await RateLimiter.tryToExecuteOrDefault(checkFailed, async () => true, false)
            : false;
        const isTimedOutEntryToLock = hasTimedOutReserved
            ? await RateLimiter.tryToExecuteOrDefault(checkTimeout, async () => true, false)
            : false;

        return isFailedEntryToLock || isTimedOutEntryToLock;
    }

    async enqueue(resourceEntry: ResourceEntry): Promise<ResourceEntry> {
        await this.persistEntry(resourceEntry);

        return resourceEntry;
    }

    async enqueueIfAbsent(resourceEntry: ResourceEntry): Promise<ResourceEntry> {
        const existing = await this.findItem(resourceEntry.key);
        if (existing) {
            return existing.entry;
        }

        await this.persistEntry(resourceEntry);

        return resourceEntry;
    }

    async releaseEntries(resources: ResourceEntry[], entityStatus: EntityStatus, exponentialBackoffSteps?: Temporal.TimeUnit): Promise<Map<Key, ResourceEntry>> {

        for (const entry of resources) {
            if (entry?.db?.id) {

                const key = KVQueueBox.toKvKey(entry);

                await kv.atomic()
                    .check({
                            key: key,
                            versionstamp: entry?.db?.id || null
                        }
                    )
                    .delete(key)
                    .commit();
            }
        }

        return new Map(resources.map(e => [e.key, e]));
    }

    async reserveTimeoutEntries(typeIds: Set<string>, maxToReserve: number, timeSinceStartTs: Temporal.Duration): Promise<Map<Key, ResourceEntry>> {
        const timedOut = new Map<Key, ResourceEntry>();
        const now = Temporal.Now.instant();

        for await (const item of kv.list<ResourceEntry>({ prefix: [] })) {
            const entry = await this.toLiveEntry(item);
            if (!entry || !typeIds.has(entry.typeId)) {
                continue;
            }

            if (!this.isReservedEntryTimedOut(entry, timeSinceStartTs, now)) {
                continue;
            }

            timedOut.set(entry.key, {
                ...entry,
                db: {
                    id: item.versionstamp,
                },
            });
            if (timedOut.size >= maxToReserve) {
                break;
            }
        }

        return timedOut;
    }

    async reserveEntries(typeIds: Set<string>, statusIds: Set<EntityStatus>, maxToReserve: number): Promise<Map<Key, ResourceEntry>> {
        const foundEntries = new Map<Key, ResourceEntry>();

        for await (const item of kv.list<ResourceEntry>({ prefix: [] })) {
            const entry = await this.toLiveEntry(item);
            if (!entry || !typeIds.has(entry.typeId) || !statusIds.has(entry.status)) {
                continue;
            }

            foundEntries.set(entry.key, {
                ...entry,
                db: {
                    id: item.versionstamp,
                },
            });
            if (foundEntries.size >= maxToReserve) {
                break;
            }
        }

        return foundEntries;
    }

    async getItem(key: Key): Promise<ResourceEntry | undefined> {
        return (await this.findItem(key))?.entry;
    }

    async setItem(
        key: Key,
        value: ResourceEntry,
        _options: PersistenceSetItemOptions,
    ): Promise<void> {
        await this.persistEntry({
            ...value,
            key,
        });
    }

    async removeItem(key: Key): Promise<void> {
        for await (const item of kv.list<ResourceEntry>({ prefix: [] })) {
            if (KVQueueBox.isSameKey(item.value.key, key)) {
                await kv.delete(item.key);
            }
        }
    }

    async getAllKeys(): Promise<Key[]> {
        const keys = new Map<string, Key>();

        for await (const item of kv.list<ResourceEntry>({ prefix: [] })) {
            const entry = await this.toLiveEntry(item);
            if (!entry) {
                continue;
            }

            const key = entry.key;
            keys.set(`${key.topicId}/${key.resourceId}/${key.contextId}`, key);
        }

        return [...keys.values()];
    }

    async deleteExpired(): Promise<number> {
        let deleted = 0;

        for await (const item of kv.list<ResourceEntry>({ prefix: [] })) {
            if (!isExpiredResourceEntry(item.value)) {
                continue;
            }

            await kv.delete(item.key);
            deleted += 1;
        }

        return deleted;
    }

    static toKvKey(entry: ResourceEntry): Deno.KvKey {
        return [entry.typeId, entry.key.contextId, entry.key.topicId, entry.key.resourceId];
    }

    private static isSameKey(left: Key, right: Key): boolean {
        return left.topicId === right.topicId &&
            left.resourceId === right.resourceId &&
            left.contextId === right.contextId;
    }

    private async persistEntry(entry: ResourceEntry): Promise<void> {
        await this.removeItem(entry.key);
        await kv.set(KVQueueBox.toKvKey(entry), entry);
    }

    private async findItem(
        key: Key,
    ): Promise<Readonly<{ entry: ResourceEntry; kvKey: Deno.KvKey; versionstamp: string }> | undefined> {
        for await (const item of kv.list<ResourceEntry>({ prefix: [] })) {
            if (!KVQueueBox.isSameKey(item.value.key, key)) {
                continue;
            }

            const entry = await this.toLiveEntry(item);
            if (!entry) {
                return undefined;
            }

            return {
                entry,
                kvKey: item.key,
                versionstamp: item.versionstamp,
            };
        }

        return undefined;
    }

    private async toLiveEntry(
        item: Readonly<{ key: Deno.KvKey; value: ResourceEntry; versionstamp: string }>,
    ): Promise<ResourceEntry | undefined> {
        if (!isExpiredResourceEntry(item.value)) {
            return item.value;
        }

        await kv.delete(item.key);
        return undefined;
    }

    private isReservedEntryTimedOut(
        entry: ResourceEntry,
        duration: Temporal.Duration,
        now: Temporal.Instant,
    ): boolean {
        if (entry.status !== EntityStatus.RESERVED || !entry.dequeueAudit.startTs) {
            return false;
        }

        return Temporal.Instant.compare(
            now,
            entry.dequeueAudit.startTs.add(duration),
        ) >= 0;
    }
}
