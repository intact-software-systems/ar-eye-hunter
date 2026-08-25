import { Temporal } from '@js-temporal/polyfill';

import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, isExpiredResourceEntry, toKeyAsString, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';

const RESOURCE_INBOX_ENTRY_EVENT = 'resource-inbox-entry';
const RESOURCE_INBOX_ENTRY_WAIT_TIMEOUT_MS = 2_000;

export class TestResourceInbox extends InMemoryQueueBox {
    private readonly materializations = new Map<string, Promise<ResourceEntry>>();
    private readonly entryEvents = new EventTarget();
    private nextMaterializationGate: Promise<void> | undefined;

    delayNextMaterializationUntil(gate: Promise<void>): void {
        this.nextMaterializationGate = gate;
    }

    async waitForEntryCount(
        minimumEntries = 1,
        timeoutMs = RESOURCE_INBOX_ENTRY_WAIT_TIMEOUT_MS
    ): Promise<void> {
        const waitAbort = new AbortController();
        const timeout = rejectResourceInboxEntryWaitAfter(
            waitAbort.signal,
            timeoutMs,
            minimumEntries
        );
        try {
            while (true) {
                const entryWritten = new Promise<void>((resolve) => {
                    this.entryEvents.addEventListener(
                        RESOURCE_INBOX_ENTRY_EVENT,
                        () => resolve(),
                        { once: true, signal: waitAbort.signal }
                    );
                });
                if ((await this.getAllKeys()).length >= minimumEntries) {
                    return;
                }
                await Promise.race([entryWritten, timeout]);
            }
        }
        finally {
            waitAbort.abort();
        }
    }

    async isEntryWithStatus(key: Key, statuses: EntityStatus[]): Promise<boolean> {
        const entry = await this.getItem(key);
        return entry !== undefined && statuses.includes(entry.status);
    }

    override async enqueueIfAbsent(entry: ResourceEntry): Promise<ResourceEntry> {
        const enqueued = await super.enqueueIfAbsent(entry);
        this.entryEvents.dispatchEvent(new Event(RESOURCE_INBOX_ENTRY_EVENT));
        return enqueued;
    }

    async findAllByTopicAndResourceId(
        topicId: string,
        resourceId: string
    ): Promise<readonly ResourceEntry[]> {
        return (await this.readEntries()).filter(
            (entry) =>
                !isExpiredResourceEntry(entry) &&
                entry.key.topicId === topicId &&
                entry.key.resourceId === resourceId
        );
    }

    async readEntries(): Promise<ResourceEntry[]> {
        const entries = await Promise.all(
            (await this.getAllKeys()).map((key) => this.getItem(key))
        );
        return entries.filter((entry): entry is ResourceEntry => entry !== undefined);
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
        const gate = this.nextMaterializationGate;
        this.nextMaterializationGate = undefined;
        if (gate !== undefined) {
            await gate;
        }
        const materialized = await materialize();
        const entry = { ...placeholder, resource: materialized.resource };
        return await this.enqueueIfAbsent(entry);
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

    allEntries(): ResourceEntry[] {
        return [...this.data.values()];
    }
}

export function createAppInboxTestResilience(firstRetryDelayMs?: number): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    const resilienceArguments = [
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1
    ] as const;
    if (firstRetryDelayMs === undefined) {
        return ResilienceDto.toResilienceDto(...resilienceArguments);
    }
    return ResilienceDto.toResilienceDto(...resilienceArguments, 10, {
        maxAttempts: 20,
        delaysAfterAttemptMs: [firstRetryDelayMs],
        maxDelayMs: firstRetryDelayMs,
        jitterRatio: 0,
        staleDueThresholdMs: 30_000
    });
}

function rejectResourceInboxEntryWaitAfter(
    abortSignal: AbortSignal,
    timeoutMs: number,
    minimumEntries: number
): Promise<never> {
    return new Promise((_, reject) => {
        const timeout = setTimeout(
            () =>
                reject(
                    new Error(
                        `ResourceInbox test queue did not reach ${minimumEntries} entries`
                    )
                ),
            timeoutMs
        );
        abortSignal.addEventListener('abort', () => clearTimeout(timeout), { once: true });
    });
}
