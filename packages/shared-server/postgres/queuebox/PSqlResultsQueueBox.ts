import { EnqueueBoxResourceEntryRepository } from '@shared/queuebox/QueueBoxTypes.ts';
import { isExpiredResourceEntry, Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    ResourceInboxResultsRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';

export class PSqlResultsQueueBox implements EnqueueBoxResourceEntryRepository {
    public readonly repo: ResourceInboxResultsRepository;

    constructor(
        repo: ResourceInboxResultsRepository,
    ) {
        this.repo = repo;
    }

    cleanup(): void {
        void this.deleteExpired().catch((error) => {
            console.error('Failed to cleanup expired resource_inbox rows', error);
        });
    }

    async enqueue(resourceEntry: ResourceEntry): Promise<ResourceEntry | undefined> {
        return this.enqueueIfAbsent(resourceEntry);
    }

    async enqueueIfAbsent(resourceEntry: ResourceEntry): Promise<ResourceEntry> {
        return await this.repo.begin(
            async (txRepo: ResourceInboxResultsRepository) => {
                return await txRepo.writeIfAbsentOrReplaceExpired(resourceEntry);
            },
        );
    }

    async enqueueIf(
        resourceEntry: ResourceEntry,
        enqueueIt: (existing: ResourceEntry) => boolean,
    ): Promise<ResourceEntry | undefined> {
        return await this.repo.begin(
            async (txRepo: ResourceInboxResultsRepository) => {
                const previous = await txRepo.findAnyByKey(resourceEntry.key);
                if (!previous || isExpiredResourceEntry(previous)) {
                    await txRepo.replace(resourceEntry);
                    return undefined;
                }

                if (enqueueIt(previous)) {
                    await txRepo.replace(resourceEntry);
                }

                return previous;
            },
        );
    }

    async enqueueOrUpdate(
        resourceEntry: ResourceEntry,
        updateExisting: (existing: ResourceEntry) => ResourceEntry | undefined,
    ) {
        return await this.repo.begin(
            async (txRepo: ResourceInboxResultsRepository) => {
                const previous = await txRepo.findAnyByKey(resourceEntry.key);
                if (!previous || isExpiredResourceEntry(previous)) {
                    await txRepo.replace(resourceEntry);
                    return {
                        action: 'inserted' as const,
                        entry: resourceEntry,
                        previous: undefined,
                    };
                }

                const updated = updateExisting(previous);
                if (!updated) {
                    return {
                        action: 'unchanged' as const,
                        entry: previous,
                        previous,
                    };
                }

                await txRepo.replace(updated);
                return {
                    action: 'updated' as const,
                    entry: updated,
                    previous,
                };
            },
        );
    }

    async findByKey(key: Key): Promise<ResourceEntry | undefined> {
        return await this.repo.findByKey(key) ?? undefined;
    }

    async deleteExpired(): Promise<number> {
        return await this.repo.deleteExpired();
    }
}
