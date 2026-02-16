/// <reference lib="deno.unstable" />
import {QueueBoxResourceEntryRepository} from "@shared/queuebox/QueueBoxTypes.ts";
import {RateLimiter} from "@shared/resilience/Resilience.ts";
import {EntityStatus, Key, ResourceEntry} from "@shared/queuebox/ResourceEntry.ts";
import {getKv} from "../utils/kv.ts";

const kv: Deno.Kv = await getKv()

export class KVQueueBox implements QueueBoxResourceEntryRepository {

    async isAnyEntryToLock(typeIds: Set<string>, checkTimeout: RateLimiter, checkFailed: RateLimiter): Promise<boolean> {
        const {done} = await kv.list({prefix: typeIds.values().toArray()}, {limit: 1}).next();

        return !done;
    }

    async enqueue(resourceEntry: ResourceEntry): Promise<ResourceEntry> {
        await kv.set(KVQueueBox.toKvKey(resourceEntry), resourceEntry)

        return resourceEntry
    }

    async enqueueIfAbsent(resourceEntry: ResourceEntry): Promise<ResourceEntry> {
        await kv.set(KVQueueBox.toKvKey(resourceEntry), resourceEntry)

        return resourceEntry
    }

    async releaseEntries(resources: ResourceEntry[], entityStatus: EntityStatus, exponentialBackoffSteps?: Temporal.TimeUnit): Promise<Map<Key, ResourceEntry>> {

        for (const entry of resources) {
            if (entry?.db?.id) {

                const key = KVQueueBox.toKvKey(entry)

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

        return new Map(resources.map(e => [e.key, e]))
    }

    async reserveTimeoutEntries(typeIds: Set<string>, maxToReserve: number, timeSinceStartTs: Temporal.Duration): Promise<Map<Key, ResourceEntry>> {
        return await this.reserveEntries(typeIds, new Set([EntityStatus.NEW]), maxToReserve);
    }

    async reserveEntries(typeIds: Set<string>, statusIds: Set<EntityStatus>, maxToReserve: number): Promise<Map<Key, ResourceEntry>> {
        const next = await kv.list({prefix: typeIds.values().toArray()}, {limit: 1}).next();

        if (next.done || !next.value) {
            return new Map<Key, ResourceEntry>();
        }

        const foundEntry = next.value.value as ResourceEntry;

        const entry: ResourceEntry = {
            ...foundEntry,
            db: {
                id: next.value.versionstamp
            }
        }

        return new Map<Key, ResourceEntry>([[entry.key, entry]])
    }

    static toKvKey(entry: ResourceEntry): Deno.KvKey {
        return [entry.typeId, entry.key.contextId, entry.key.topicId, entry.key.resourceId]
    }
}