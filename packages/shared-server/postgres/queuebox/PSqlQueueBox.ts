import { QueueBoxResourceEntryRepository } from '@shared/queuebox/QueueBoxTypes.ts';
import type { PersistenceSetItemOptions } from '@shared/persistence/PersistenceProvider.ts';
import { RateLimiter } from '@shared/resilience/Resilience.ts';
import {
    EntityStatus,
    FAILED_STATUS,
    Key,
    NEW_AND_RETRY_STATUSES,
    ResourceEntry,
    TIMEOUT_ON_NON_RESPONSIVE_ENTRY,
    toUpdatedResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { ResourceInboxRepository } from '../resource-inbox/ResourceInboxRepository.ts';

export class PSqlQueueBox implements QueueBoxResourceEntryRepository {

    constructor(
        public readonly repo: ResourceInboxRepository
    ) {
    }

    cleanup(): void {
        void this.deleteExpired().catch((error) => {
            console.error('Failed to cleanup expired resource_inbox rows', error);
        });
    }

    async isAnyEntryToLock(typeIds: Set<string>, checkTimeout: RateLimiter, checkFailed: RateLimiter): Promise<boolean> {

        const isFailedEntryToLock: boolean =
            await RateLimiter.tryToExecuteOrDefault(
                checkFailed,
                async () =>
                    await this.repo.isEntriesToLock(
                        typeIds,
                        FAILED_STATUS
                    ),
                false
            );

        const isTimedOutReservedEntryToLock: boolean =
            await RateLimiter.tryToExecuteOrDefault(
                checkTimeout,
                async () =>
                    await this.repo.isTimeoutOnReservedEntries(
                        typeIds,
                        TIMEOUT_ON_NON_RESPONSIVE_ENTRY
                    ),
                false
            );

        const isNewAndRetryEntryToLock: boolean =
            await this.repo.isEntriesToLock(
                typeIds,
                NEW_AND_RETRY_STATUSES
            );

        return isNewAndRetryEntryToLock || isTimedOutReservedEntryToLock || isFailedEntryToLock;
    }

    async reserveEntries(typeIds: Set<string>, statusIds: Set<EntityStatus>, maxToReserve: number): Promise<Map<Key, ResourceEntry>> {
        return await this.repo.begin(
            async (txRepo: ResourceInboxRepository) => {

                const foundEntries = await txRepo.findEntriesSkipLocked(typeIds, statusIds, maxToReserve);

                const reservedEntries = new Map<Key, ResourceEntry>();

                for (const e of foundEntries.values()) {
                    const reserved = await txRepo.startProcessingEntity(e);
                    reserved.fold(
                        () => undefined,
                        (entry) => {
                            reservedEntries.set(e.key, entry);
                            return undefined;
                        },
                    );
                }

                return reservedEntries;
            });
    }

    async reserveTimeoutEntries(typeIds: Set<string>, maxToReserve: number, timeSinceStartTs: Temporal.Duration): Promise<Map<Key, ResourceEntry>> {
        return await this.repo.begin(
            async (txRepo: ResourceInboxRepository) => {

                const foundEntries = await txRepo.findTimedOutReservedEntriesSkipLocked(typeIds, timeSinceStartTs.total({ unit: 'milliseconds' }), maxToReserve);

                const reservedEntries = new Map<Key, ResourceEntry>();

                for (const e of foundEntries.values()) {
                    const reserved = await txRepo.startProcessingEntity(e);
                    reserved.fold(
                        () => undefined,
                        (entry) => {
                            reservedEntries.set(e.key, entry);
                            return undefined;
                        },
                    );
                }

                return reservedEntries;
            });
    }

    async releaseEntries(resources: ResourceEntry[], entityStatus: EntityStatus, exponentialBackoffSteps?: Temporal.TimeUnit): Promise<Map<Key, ResourceEntry>> {
        return await this.repo.begin(
            async (txRepo: ResourceInboxRepository) => {

                const releasedEntries = new Map<Key, ResourceEntry>();

                for (const entry of resources) {

                    const backoff =
                        exponentialBackoffSteps
                            ? PSqlQueueBox.toBackoff(exponentialBackoffSteps, entry.dequeueAudit.attempts)
                            : undefined;

                    const updated = await txRepo.updateResourceEntry(entry.key, entityStatus, backoff ? backoff.total({ unit: 'milliseconds' }) : undefined);
                    if (updated <= 0 && Temporal.Instant.compare(Temporal.Now.instant(), entry.audit.expiryTs) < 0) {
                        throw new Error('Entry was not updated in updateResourceEntry ' + JSON.stringify(entry.key));
                    }

                    releasedEntries.set(
                        entry.key,
                        toUpdatedResourceEntry(
                            entry,
                            entityStatus,
                            Temporal.Now.instant(),
                            backoff
                                ? Temporal.Now.instant().add(backoff)
                                : undefined
                        )
                    );
                }

                return releasedEntries;
            });
    }


    static toBackoff(exponentialBackoffSteps: Temporal.TimeUnit, attempts: number) {
        switch (exponentialBackoffSteps) {
            case 'hour':
                return Temporal.Duration.from({ hours: Math.pow(2, attempts) });
            case 'minute':
                return Temporal.Duration.from({ minutes: Math.pow(2, attempts) });
            case 'second':
                return Temporal.Duration.from({ seconds: Math.pow(2, attempts) });
            case 'millisecond':
            case 'microsecond':
            case 'nanosecond':
                return Temporal.Duration.from({ milliseconds: Math.pow(2, attempts) });
        }
    }

    async enqueue(resourceEntry: ResourceEntry): Promise<ResourceEntry | undefined> {
        return await this.repo.begin(
            async (txRepo: ResourceInboxRepository) => {
                const previous = await txRepo.findAnyByKey(resourceEntry.key);
                await txRepo.replace(resourceEntry);

                return previous ?? undefined;
            }
        );
    }

    async enqueueIfAbsent(resourceEntry: ResourceEntry): Promise<ResourceEntry> {
        return await this.repo.begin(
            async (txRepo: ResourceInboxRepository) => {
                return await txRepo.writeIfAbsentOrReplaceExpired(resourceEntry);
            }
        );
    }

    async getItem(key: Key): Promise<ResourceEntry | undefined> {
        return await this.repo.findByKey(key) ?? undefined;
    }

    async setItem(
        key: Key,
        value: ResourceEntry,
        _options: PersistenceSetItemOptions,
    ): Promise<void> {
        await this.repo.upsert({
            ...value,
            key,
        });
    }

    async removeItem(key: Key): Promise<void> {
        await this.repo.deleteByKey(key);
    }

    async getAllKeys(): Promise<Key[]> {
        return await this.repo.findAllKeys();
    }

    async deleteExpired(): Promise<number> {
        return await this.repo.deleteExpired();
    }
}
