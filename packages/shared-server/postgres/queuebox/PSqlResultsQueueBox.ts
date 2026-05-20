import { EnqueueBoxResourceEntryRepository } from '@shared/queuebox/QueueBoxTypes.ts';
import { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
  ResourceInboxResultsRepository,
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';

export class PSqlResultsQueueBox implements EnqueueBoxResourceEntryRepository {
  constructor(
    public readonly repo: ResourceInboxResultsRepository,
  ) {
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

  async findByKey(key: Key): Promise<ResourceEntry | undefined> {
    return await this.repo.findByKey(key) ?? undefined;
  }

  async deleteExpired(): Promise<number> {
    return await this.repo.deleteExpired();
  }
}
