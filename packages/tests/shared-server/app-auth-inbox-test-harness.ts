import { Temporal } from '@js-temporal/polyfill';
import { InMemoryQueueBox } from '@shared/queuebox/InMemoryQueueBox.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/Resilience.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import {
    EntityStatus,
    isExpiredResourceEntry,
    type Key,
    type ResourceEntry,
    toKeyAsString,
} from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { AppAuthInboxService } from '@shared-server/rallar-system/services/AppAuthInboxService.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/services/auth-credential-issuer.ts';
import { createAuthMutationService } from '@shared-server/rallar-system/services/auth-state-mutations.ts';
import type { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';
import { createAppInboxTestDatabase } from './app-inbox-test-database.ts';

export class TestResourceInbox extends InMemoryQueueBox {
    async isEntryWithStatus(key: Key, statuses: EntityStatus[]): Promise<boolean> {
        const entry = await this.getItem(key);
        return entry !== undefined && statuses.includes(entry.status);
    }
}

export class TestResourceInboxResults {
    private readonly data = new Map<string, ResourceEntry>();

    replace(entry: ResourceEntry): Promise<ResourceEntry> {
        this.data.set(toKeyAsString(entry.key), entry);
        return Promise.resolve(entry);
    }

    findByKey(key: Key): Promise<ResourceEntry | undefined> {
        const entry = this.data.get(toKeyAsString(key));
        return Promise.resolve(
            entry === undefined || isExpiredResourceEntry(entry) ? undefined : entry,
        );
    }

    allEntries(): ResourceEntry[] {
        return [...this.data.values()];
    }
}

export function createAuthInboxTestHarness(
    runtime: FakeRuntimeStateRepository,
    serviceId = 'auth-test-service',
): Readonly<{
    queue: TestResourceInbox;
    results: TestResourceInboxResults;
    reader: InboxQueueReader;
    service: AppAuthInboxService;
}> {
    const queue = new TestResourceInbox();
    const results = new TestResourceInboxResults();
    const reader = new InboxQueueReader(queue);
    const service = new AppAuthInboxService(
        reader,
        queue as never,
        results as never,
        createAppInboxTestDatabase(queue, results, { runtimeRepository: runtime }),
        createAuthMutationService({ runtimeRepository: runtime, serviceId }),
        createHmacAuthCredentialIssuer(`${serviceId}-secret-0123456789abcdef`),
        serviceId,
    );
    return { queue, results, reader, service };
}

export function createAuthInboxTestResilience(firstRetryDelayMs?: number): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    const args = [
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1,
    ] as const;
    if (firstRetryDelayMs === undefined) {
        return ResilienceDto.toResilienceDto(...args);
    }
    return ResilienceDto.toResilienceDto(...args, 10, {
        maxAttempts: 20,
        delaysAfterAttemptMs: [firstRetryDelayMs],
        maxDelayMs: firstRetryDelayMs,
        jitterRatio: 0,
        staleDueThresholdMs: 30_000,
    });
}

export async function readEntries(queue: InMemoryQueueBox): Promise<ResourceEntry[]> {
    const entries = await Promise.all(
        (await queue.getAllKeys()).map((key) => queue.getItem(key)),
    );
    return entries.filter((entry): entry is ResourceEntry => entry !== undefined);
}

export async function waitForAuthInboxEntry(
    queue: InMemoryQueueBox,
    minimumEntries = 1,
): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if ((await queue.getAllKeys()).length >= minimumEntries) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('Auth AppInbox test entry was not enqueued');
}

export async function runAuthInboxCommand<R>(
    pending: Promise<{ readonly left?: unknown; readonly right?: R }>,
    queue: InMemoryQueueBox,
    reader: InboxQueueReader,
    minimumEntries = 1,
): Promise<{ readonly left?: unknown; readonly right?: R }> {
    await waitForAuthInboxEntry(queue, minimumEntries);
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createAuthInboxTestResilience(),
    );
    return await pending;
}

export const createResilience = createAuthInboxTestResilience;
export const waitForQueuedEntry = waitForAuthInboxEntry;
export const runAuthCommand = runAuthInboxCommand;
