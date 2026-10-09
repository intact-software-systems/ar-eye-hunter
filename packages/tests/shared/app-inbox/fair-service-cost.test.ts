// @vitest-environment happy-dom

import 'fake-indexeddb/auto';

import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { EnqueuedType } from '@shared/api/api-config.ts';
import { createCountingIndexedDbOperationObserver, type IndexedDbOperationCounts } from '@shared/persistence/indexed-db-operation-observer.ts';
import type { DequeueController } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { IndexedDbQueueBox } from '@shared/queuebox/indexed-db-queue-box.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { QueueMessageReader } from '@shared/services/queue-message-reader.ts';

import { createQueueMessage, createQueueResilience, seedRetry } from './fair-service-fixture.ts';

const ARMS = ['current1000', 'fixed1', 'adaptive', 'fixedRetry2'] as const;

function fixedBudgets(retryQuota: number): DequeueController.LaneBudgets {
    return {
        FINALIZATION: { maxToReserve: 1, maxNumToDequeue: 1 },
        NEW: { maxToReserve: 1, maxNumToDequeue: 1 },
        FAIRNESS: { maxToReserve: 1, maxNumToDequeue: 1 },
        RETRY: { maxToReserve: 1, maxNumToDequeue: retryQuota },
        TIMEOUT: { maxToReserve: 1, maxNumToDequeue: 1 }
    };
}

namespace QueueComparison {
    export interface Result {
        readonly arm: typeof ARMS[number];
        readonly passes: number;
        readonly retryCompletionPass: number;
        readonly completed: readonly string[];
        readonly counts: IndexedDbOperationCounts;
    }
}

class QueueComparison {
    private now = Date.now();
    private readonly observer = createCountingIndexedDbOperationObserver();
    private readonly queue = new IndexedDbQueueBox({
        dbName: `fair-service-${crypto.randomUUID()}`,
        observer: this.observer,
        now: () => Temporal.Instant.fromEpochMilliseconds(this.now)
    });
    private readonly options = { nowEpochMs: () => this.now };
    private readonly reader = new InboxQueueReader(this.queue, this.options);
    private readonly genericReader = new QueueMessageReader(this.queue, {
        enqueueType: EnqueuedType.APP_INBOX,
        dequeueOptions: this.options
    });
    private readonly resilience = createQueueResilience();
    private readonly completed: string[] = [];
    private readonly entries: ResourceEntry[] = [];
    private passes = 0;
    private retryCompletionPass = 0;
    private readonly arm: typeof ARMS[number];
    private readonly recurring: boolean;

    constructor(arm: typeof ARMS[number], recurring: boolean) {
        this.arm = arm;
        this.recurring = recurring;
        const callback = { onMessage: async (message: ReturnType<typeof createQueueMessage>) => this.onMessage(message) };
        this.reader.onInboxMessageDo('test.fair-service', callback);
        this.genericReader.onMessageDo('test.fair-service', callback);
    }

    async run(): Promise<QueueComparison.Result> {
        if (!this.recurring) {
            await this.seedBacklog();
        }
        this.observer.reset();
        while (this.completed.length < 24 && this.passes < 30) {
            if (this.recurring) {
                await this.seedRound();
            }
            await this.dequeuePass();
        }
        const counts = this.observer.getCounts();
        await this.verifyDurable(24);
        return { arm: this.arm, passes: this.passes, retryCompletionPass: this.retryCompletionPass, completed: this.completed, counts };
    }

    async runReturnAfterDisappearance(): Promise<QueueComparison.Result> {
        // Establish pressure through completed work; no cached value is injected.
        await this.run();
        this.observer.reset();
        this.now += 2_000;
        await this.dequeuePass();
        for (const suffix of ['a', 'b']) {
            this.entries.push(await seedRetry(this.queue, `retry-return-${suffix}`));
            this.entries.push(await this.reader.enqueueIfAbsent(createQueueMessage(`new-return-${suffix}`)));
        }
        this.now += 2;
        while (this.completed.length < 28 && this.passes < 40) {
            await this.dequeuePass();
        }
        const counts = this.observer.getCounts();
        await this.verifyDurable(28);
        return { arm: this.arm, passes: this.passes, retryCompletionPass: this.retryCompletionPass, completed: this.completed, counts };
    }

    private async dequeuePass(): Promise<void> {
        this.passes += 1;
        if (this.arm === 'adaptive') {
            await this.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, this.resilience);
        }
        else {
            await this.genericReader.dequeue(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                this.resilience,
                this.arm === 'current1000' ? undefined : () => fixedBudgets(this.arm === 'fixedRetry2' ? 2 : 1)
            );
        }
    }

    private async onMessage(message: ReturnType<typeof createQueueMessage>): Promise<void> {
        this.completed.push(message.route.resourceId);
        if (this.completed.filter((id) => id.startsWith('retry')).length === 12) {
            this.retryCompletionPass ||= this.passes;
        }
        if (!this.recurring && message.route.resourceId.startsWith('new') && this.entries.length < 24) {
            this.entries.push(await this.reader.enqueueIfAbsent(createQueueMessage(`new-${this.entries.length - 12}`)));
        }
    }

    private async seedBacklog(): Promise<void> {
        for (let index = 0; index < 12; index += 1) {
            this.entries.push(await seedRetry(this.queue, `retry-${index}`));
        }
        this.entries.push(await this.reader.enqueueIfAbsent(createQueueMessage('new-0')));
        this.now += 2;
    }

    private async seedRound(): Promise<void> {
        this.entries.push(await seedRetry(this.queue, `retry-${this.passes}`));
        this.entries.push(await this.reader.enqueueIfAbsent(createQueueMessage(`new-${this.passes}`)));
        this.now += 2;
    }

    private async verifyDurable(expectedCount: number): Promise<void> {
        const durable = await Promise.all(this.entries.map((entry) => this.queue.getItem(entry.key)));
        expect(durable).toHaveLength(expectedCount);
        expect(durable.every((entry) => entry?.status === EntityStatus.COMPLETED)).toBe(true);
        expect(
            durable.filter((entry) => entry?.key.resourceId.startsWith('retry'))
                .every((entry) => entry?.dequeueAudit.attempts === 2)
        ).toBe(true);
        expect(
            durable.filter((entry) => entry?.key.resourceId.startsWith('new'))
                .every((entry) => entry?.dequeueAudit.attempts === 1)
        ).toBe(true);
    }
}

describe('AppInbox four-arm durable-work comparison', () => {
    it('refreshes after disappearance and completes returning retries behind cached zero pressure', async () => {
        const results = [];
        for (const arm of ARMS) {
            results.push(await new QueueComparison(arm, false).runReturnAfterDisappearance());
        }
        process.stdout.write(`RETURN_COMPARISON ${JSON.stringify(results)}\n`);
        const adaptive = results[2]!;
        expect(adaptive.completed.slice(-4)).toEqual(['new-return-a', 'retry-return-a', 'new-return-b', 'retry-return-b']);
        expect(adaptive.counts.byKind['work-page']).toBe(1);
        for (const result of results) {
            expect(result.completed).toHaveLength(28);
        }
    });

    it('amortizes observation cost across recurring singleton retry rounds compared with fixed RETRY two', async () => {
        const results = [];
        for (const arm of ARMS) {
            results.push(await new QueueComparison(arm, true).run());
        }
        process.stdout.write(`SINGLETON_COMPARISON ${JSON.stringify(results)}\n`);
        const adaptive = results[2]!;
        const fixedTwo = results[3]!;
        expect(adaptive.completed).toEqual(fixedTwo.completed);
        expect(adaptive.passes).toBe(fixedTwo.passes);
        expect(adaptive.counts.byKind['work-page']).toBe(1);
        expect(adaptive.counts.total).toBeLessThan(fixedTwo.counts.total);
    });

    it('bounds NEW service while retry backlog catches up, exposing the adaptive cold-start pass', async () => {
        const results = [];
        for (const arm of ARMS) {
            results.push(await new QueueComparison(arm, false).run());
        }
        process.stdout.write(`BACKLOG_COMPARISON ${JSON.stringify(results)}\n`);
        expect(results[0]!.completed.slice(0, 12).every((id) => id.startsWith('new'))).toBe(true);
        for (const result of results.slice(1)) {
            expect(result.completed.slice(0, 2)).toEqual(['new-0', 'retry-0']);
        }
        expect(results[2]!.retryCompletionPass).toBeLessThan(results[1]!.retryCompletionPass);
        expect(results[2]!.retryCompletionPass).toBe(results[3]!.retryCompletionPass + 1);
    });
});
