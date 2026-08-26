import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import {
    EntityStatus,
    isExpiredResourceEntry,
    NOT_COMPLETED_RETRYABLE_STATUSES,
    toKeyAsString,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

import { FakeRuntimeStateRepository } from '../runtime-state/test-support/fake-runtime-state-repository.ts';

export class ClientExpiryTestResourceInbox extends InMemoryQueueBox {
    private readonly materializations = new Map<string, Promise<ResourceEntry>>();

    async isEntryWithStatus(key: Key, statuses: EntityStatus[]): Promise<boolean> {
        const entry = await this.getItem(key);
        return entry !== undefined && statuses.includes(entry.status);
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

export async function readClientExpiryTestEntries(queue: ClientExpiryTestResourceInbox): Promise<ResourceEntry[]> {
    const entries = await Promise.all((await queue.getAllKeys()).map((key) => queue.getItem(key)));
    return entries.filter((entry): entry is ResourceEntry => entry !== undefined);
}

export function listActiveClientExpiryTestEntries(entries: readonly ResourceEntry[]): ResourceEntry[] {
    return entries.filter((entry) => NOT_COMPLETED_RETRYABLE_STATUSES.has(entry.status));
}

export function readClientExpiryTestEnqueueData<V>(entry: ResourceEntry): V {
    const message = JSON.parse(entry.resource) as { payload: { resource: string; }; };
    return (JSON.parse(message.payload.resource) as { data: V; }).data;
}

export async function createClientExpiryTestIssuedAuthority(
    runtimeRepository: FakeRuntimeStateRepository,
    clientId: string,
    sessionId: string
) {
    const authority = {
        clientId,
        accessToken: `${clientId}-token`,
        username: clientId,
        sessionId,
        issuedAtEpochMs: Date.now() - 1_000,
        expiresAtEpochMs: Date.now() + 60_000
    };
    await new AuthSessionRepository(runtimeRepository).putSession(authority);
    return authority;
}
