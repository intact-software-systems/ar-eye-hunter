import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import {
  EntityStatus,
  isExpiredResourceEntry,
  type Key,
  NOT_COMPLETED_RETRYABLE_STATUSES,
  type ResourceEntry,
  toKeyAsString,
} from '@shared/queuebox/ResourceEntry.ts';
// prettier-ignore
import {
  AuthSessionRepository,
} from '@shared-server/rallar-system/repositories/AuthSessionRepository.ts';

import { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';

export class ClientExpiryTestResourceInbox extends InMemoryQueueBox {
  async isEntryWithStatus(key: Key, statuses: EntityStatus[]): Promise<boolean> {
    const entry = await this.getItem(key);
    return entry !== undefined && statuses.includes(entry.status);
  }
}

export class ClientExpiryTestResourceInboxResults {
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

export async function readClientExpiryTestEntries(
  queue: ClientExpiryTestResourceInbox,
): Promise<ResourceEntry[]> {
  const entries = await Promise.all((await queue.getAllKeys()).map((key) => queue.getItem(key)));
  return entries.filter((entry): entry is ResourceEntry => entry !== undefined);
}

export function listActiveClientExpiryTestEntries(
  entries: readonly ResourceEntry[],
): ResourceEntry[] {
  return entries.filter((entry) => NOT_COMPLETED_RETRYABLE_STATUSES.has(entry.status));
}

export function readClientExpiryTestEnqueueData<V>(entry: ResourceEntry): V {
  const message = JSON.parse(entry.resource) as { payload: { resource: string } };
  return (JSON.parse(message.payload.resource) as { data: V }).data;
}

export async function createClientExpiryTestIssuedAuthority(
  runtimeRepository: FakeRuntimeStateRepository,
  clientId: string,
  sessionId: string,
) {
  const authority = {
    clientId,
    accessToken: `${clientId}-token`,
    username: clientId,
    sessionId,
    issuedAtEpochMs: Date.now() - 1_000,
    expiresAtEpochMs: Date.now() + 60_000,
  };
  await new AuthSessionRepository(runtimeRepository).putSession(authority);
  return authority;
}
