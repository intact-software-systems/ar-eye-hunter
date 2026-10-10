import { Temporal } from '@js-temporal/polyfill';

import type { ResourceInboxStatusAndAttempts } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import {
    isExpiredResourceEntry,
    toKeyAsString,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';

const RESOURCE_INBOX_ENTRY_EVENT = 'resource-inbox-entry';
const RESOURCE_INBOX_ENTRY_WAIT_TIMEOUT_MS = 2_000;

export class TestResourceInbox extends InMemoryQueueBox {
    private readonly materializations = new Map<string, Promise<ResourceEntry>>();
    private readonly entryEvents = new EventTarget();
    private nextMaterializationGate: Promise<void> | undefined;
    private readonly observeNow: () => Temporal.Instant;

    constructor(
        entries: Map<Key, ResourceEntry> = new Map(),
        now: () => Temporal.Instant = Temporal.Now.instant
    ) {
        super(entries, now);
        this.observeNow = now;
    }

    override async getItem(key: Key): Promise<ResourceEntry | undefined> {
        const entry = this.peek(toKeyAsString(key));
        if (entry !== undefined && isExpiredResourceEntry(entry, this.observeNow())) {
            await this.removeItem(key);
            return undefined;
        }
        return entry;
    }

    override async deleteExpired(): Promise<number> {
        const now = this.observeNow();
        let removed = 0;
        for (const key of this.peekKeys()) {
            const entry = this.peek(key);
            if (entry !== undefined && isExpiredResourceEntry(entry, now)) {
                await this.removeItem(entry.key);
                removed += 1;
            }
        }
        return removed;
    }

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

    async readStatusAndAttempts(key: Key): Promise<ResourceInboxStatusAndAttempts | undefined> {
        const entry = await this.getItem(key);
        return entry === undefined ? undefined : { status: entry.status, attempts: entry.dequeueAudit.attempts };
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
        if (existing !== undefined) {
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
    private readonly now: () => Temporal.Instant;

    constructor(now: () => Temporal.Instant = Temporal.Now.instant) {
        this.now = now;
    }

    async replace(entry: ResourceEntry): Promise<ResourceEntry> {
        this.data.set(toKeyAsString(entry.key), entry);
        return entry;
    }

    async findByKey(key: Key): Promise<ResourceEntry | undefined> {
        const entry = this.data.get(toKeyAsString(key));
        return entry === undefined || isExpiredResourceEntry(entry, this.now()) ? undefined : entry;
    }

    async writeIfAbsentOrReplaceExpired(entry: ResourceEntry): Promise<ResourceEntry> {
        const key = toKeyAsString(entry.key);
        const existing = this.data.get(key);
        if (existing !== undefined && !isExpiredResourceEntry(existing, this.now())) {
            return existing;
        }
        this.data.set(key, entry);
        return entry;
    }

    allEntries(): ResourceEntry[] {
        return [...this.data.values()];
    }
}

export function createAppInboxTestResilience(firstRetryDelayMs?: number): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
        initialRate: 1,
        maxRate: 10,
        concurrencyIncreaseStep: 1,
        concurrencyReduceStep: 1,
        retryPolicy: firstRetryDelayMs === undefined ? undefined : {
            maxAttempts: 20,
            delaysAfterAttemptMs: [firstRetryDelayMs],
            maxDelayMs: firstRetryDelayMs,
            jitterRatio: 0,
            staleDueThresholdMs: 30_000
        }
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
