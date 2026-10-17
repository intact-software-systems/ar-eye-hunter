import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { hasAdvertisedDequeueWork } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createQueueMessage, createQueueResilience, seedRetry } from '../../shared/app-inbox/fair-service-fixture.ts';
import {
    createResourceInboxTestStorage,
    recordResourceInboxStatements,
    seedResourceInboxRow,
    type ResourceInboxTestStorage
} from './resource-inbox-test-storage.ts';

const ARMS = InboxQueueReader.LANE_BUDGET_POLICIES;
const WORKLOADS = ['backlog', 'recurring', 'return-after-disappearance', 'partial-page'] as const;
/** Longer than the 1 ms retry delay `seedRetry` releases with, measured on the database clock. */
const RETRY_DUE_WAIT_MS = 5;

type Workload = typeof WORKLOADS[number];

namespace LanePolicyArm {
    export interface Result {
        readonly workload: Workload;
        readonly arm: InboxQueueReader.LaneBudgetPolicy;
        readonly passes: number;
        readonly probes: number;
        readonly retryCompletionPass: number;
        readonly statements: number;
        readonly executorWaitMs: number | undefined;
        readonly workPages: number;
        readonly completed: readonly string[];
    }
}

/** One storage per arm and workload; every pass is a probe and the pass it advertised, as the engine registration runs them. */
class LanePolicyArm {
    private now = Date.now();
    private readonly statements: string[] = [];
    private readonly storage: ResourceInboxTestStorage;
    private readonly queue: PSqlQueueBox;
    private readonly reader: InboxQueueReader;
    private readonly resilience = createQueueResilience();
    private readonly completed: string[] = [];
    private readonly entries: ResourceEntry[] = [];
    private readonly workload: Workload;
    private readonly arm: InboxQueueReader.LaneBudgetPolicy;
    private passes = 0;
    private probes = 0;
    private retryCompletionPass = 0;

    private constructor(storage: ResourceInboxTestStorage, arm: InboxQueueReader.LaneBudgetPolicy, workload: Workload) {
        this.storage = storage;
        this.arm = arm;
        this.workload = workload;
        this.queue = new PSqlQueueBox(
            createPSqlResourceInboxRepository(recordResourceInboxStatements(storage.sql, this.statements), () => new Date()),
            Temporal.Now.instant
        );
        this.reader = new InboxQueueReader(this.queue, { laneBudgetPolicy: arm, newLaneConcurrency: 1, nowEpochMs: () => this.now });
        this.reader.onInboxMessageDo('test.fair-service', { onMessage: async (message: ALMessage) => await this.onMessage(message) });
    }

    static async run(arm: InboxQueueReader.LaneBudgetPolicy, workload: Workload): Promise<LanePolicyArm.Result> {
        const storage = await createResourceInboxTestStorage('app_inbox_lane_policy_arms');
        openStorages.push(storage);
        return await new LanePolicyArm(storage, arm, workload).run();
    }

    private async run(): Promise<LanePolicyArm.Result> {
        switch (this.workload) {
            case 'backlog':
                await this.seedBacklog();
                return await this.measure(24, async () => await this.drain(24));
            case 'partial-page':
                await this.seedIneligibleRetries();
                await this.seedBacklog();
                return await this.measure(24, async () => await this.drain(24));
            case 'recurring':
                return await this.measure(24, async () => {
                    while (this.completed.length < 24 && this.passes < 40) {
                        await this.seedRound();
                        await this.pass();
                    }
                });
            case 'return-after-disappearance':
                await this.seedBacklog();
                await this.drain(24);
                return await this.measure(28, async () => {
                    this.now += 2_000;
                    await this.pass();
                    for (const suffix of ['a', 'b']) {
                        this.entries.push(await seedRetry(this.queue, `retry-return-${suffix}`));
                        this.entries.push(await this.reader.enqueueIfAbsent(createQueueMessage(`new-return-${suffix}`)));
                    }
                    await this.waitForRetriesDue();
                    await this.drain(28);
                });
        }
    }

    private async measure(expectedCount: number, action: () => Promise<void>): Promise<LanePolicyArm.Result> {
        const workPages = vi.spyOn(this.queue, 'readWorkPage');
        const passesBefore = this.passes;
        const probesBefore = this.probes;
        const countersBefore = this.storage.sql.getExecutorCounters?.();
        this.statements.length = 0;
        await action();
        const countersAfter = this.storage.sql.getExecutorCounters?.();
        const statements = this.statements.filter((statement) => statement !== 'begin' && statement !== 'commit').length;
        const result: LanePolicyArm.Result = {
            workload: this.workload,
            arm: this.arm,
            passes: this.passes - passesBefore,
            probes: this.probes - probesBefore,
            retryCompletionPass: this.retryCompletionPass,
            statements,
            executorWaitMs: countersBefore && countersAfter
                ? Math.round((countersAfter.executorWaitMs - countersBefore.executorWaitMs) * 10) / 10
                : undefined,
            workPages: workPages.mock.calls.length,
            completed: [...this.completed]
        };
        await this.verifyDurable(expectedCount);
        return result;
    }

    private async drain(expectedCount: number): Promise<void> {
        while (this.completed.length < expectedCount && this.probes < 120) {
            await this.pass();
        }
    }

    private async pass(): Promise<void> {
        this.probes += 1;
        const advertisement = await this.reader.readWorkAdvertisement(InboxQueueReader.INBOX_DEQUEUE_TYPES, this.resilience);
        if (!hasAdvertisedDequeueWork(advertisement)) {
            await this.waitForRetriesDue();
            return;
        }
        this.passes += 1;
        await this.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, this.resilience, advertisement);
        this.now += 2;
    }

    private async onMessage(message: ALMessage): Promise<void> {
        this.completed.push(message.route.resourceId);
        if (this.completed.filter((id) => id.startsWith('retry-') && !id.startsWith('retry-return')).length === 12) {
            this.retryCompletionPass ||= this.passes;
        }
        const isBacklog = this.workload !== 'recurring';
        if (isBacklog && /^new-\d+$/u.test(message.route.resourceId) && this.entries.length < 24) {
            this.entries.push(await this.reader.enqueueIfAbsent(createQueueMessage(`new-${this.entries.length - 12}`)));
        }
    }

    private async seedBacklog(): Promise<void> {
        for (let index = 0; index < 12; index += 1) {
            this.entries.push(await seedRetry(this.queue, `retry-${index}`));
        }
        this.entries.push(await this.reader.enqueueIfAbsent(createQueueMessage('new-0')));
        await this.waitForRetriesDue();
    }

    private async seedRound(): Promise<void> {
        this.entries.push(await seedRetry(this.queue, `retry-${this.passes}`));
        this.entries.push(await this.reader.enqueueIfAbsent(createQueueMessage(`new-${this.passes}`)));
        await this.waitForRetriesDue();
    }

    /**
     * Retry due times are database instants; the reader's clock, which the pressure page compares them with, moves to
     * the wall clock past them and otherwise only as the workload moves it.
     */
    private async waitForRetriesDue(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DUE_WAIT_MS));
        this.now = Math.max(this.now, Date.now());
    }

    /** RETRY rows the pressure page reads ahead of the due backlog but no lane may claim: a page of them observes no pressure. */
    private async seedIneligibleRetries(): Promise<void> {
        const sql: PSqlSql = this.storage.sql;
        const lifecycle = { status: EntityStatus.RETRY, attempts: 1, startedAgoSeconds: 5, endedAgoSeconds: 4 } as const;
        await seedResourceInboxRow(sql, { ...lifecycle, resourceId: 'future-retry', nextInSeconds: 600 });
        await seedResourceInboxRow(sql, { ...lifecycle, resourceId: 'expired-retry', nextInSeconds: -1, expired: true });
        await seedResourceInboxRow(sql, {
            ...lifecycle,
            resourceId: 'exhausted-retry',
            nextInSeconds: -1,
            attempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        });
        await seedResourceInboxRow(sql, { ...lifecycle, resourceId: 'future-retry-2', nextInSeconds: 600 });
    }

    private async verifyDurable(expectedCount: number): Promise<void> {
        const durable = await Promise.all(this.entries.map((entry) => this.queue.getItem(entry.key)));
        expect(durable).toHaveLength(expectedCount);
        expect(durable.every((entry) => entry?.status === EntityStatus.COMPLETED), `${this.arm} ${this.workload} completes everything`)
            .toBe(true);
        expect(durable.filter((entry) => entry?.key.resourceId.startsWith('retry')).every((entry) => entry?.dequeueAudit.attempts === 2))
            .toBe(true);
        expect(durable.filter((entry) => entry?.key.resourceId.startsWith('new')).every((entry) => entry?.dequeueAudit.attempts === 1))
            .toBe(true);
    }
}

const openStorages: ResourceInboxTestStorage[] = [];

afterEach(async () => {
    await Promise.all(openStorages.splice(0).map(async (storage) => await storage.close()));
});

function toTable(results: readonly LanePolicyArm.Result[]): string {
    const header = '| workload | arm | passes | probes | retry-completion pass | statements | executor wait ms | work pages |';
    const rows = results.map((result) =>
        `| ${result.workload} | ${result.arm} | ${result.passes} | ${result.probes} | ${result.retryCompletionPass} | ` +
        `${result.statements} | ${result.executorWaitMs ?? 'n/a'} | ${result.workPages} |`
    );
    return [header, '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |', ...rows].join('\n');
}

function toVerdict(results: readonly LanePolicyArm.Result[]): string {
    return WORKLOADS.map((workload) => {
        const adaptive = results.find((result) => result.workload === workload && result.arm === 'adaptive-retry')!;
        const fixedTwo = results.find((result) => result.workload === workload && result.arm === 'fixed-retry-two')!;
        return `${workload}: adaptive - fixed-retry-two = ${adaptive.statements - fixedTwo.statements} statements, ` +
            `${adaptive.passes - fixedTwo.passes} passes`;
    }).join('; ');
}

describe('AppInbox lane budget policy arms on the production storage', () => {
    it('serves equal durable work under every policy and reports the adaptive arm against fixed RETRY two', async () => {
        const results: LanePolicyArm.Result[] = [];
        for (const workload of WORKLOADS) {
            for (const arm of ARMS) {
                results.push(await LanePolicyArm.run(arm, workload));
            }
        }
        const verdict = toVerdict(results);
        process.stdout.write(`LANE_POLICY_ARMS\n${toTable(results)}\nVERDICT ${verdict}\n`);

        for (const workload of WORKLOADS) {
            const arms = results.filter((result) => result.workload === workload);
            const completedSets = arms.map((result) => [...result.completed].sort());
            expect(new Set(completedSets.map((set) => set.join(','))).size, `${workload}: ${verdict}`).toBe(1);
        }
        const backlog = (arm: InboxQueueReader.LaneBudgetPolicy) => results.find((result) => result.workload === 'backlog' && result.arm === arm)!;
        expect(backlog('adaptive-retry').retryCompletionPass, `cold-start penalty; ${verdict}`)
            .toBe(backlog('fixed-retry-two').retryCompletionPass + 1);
        expect(backlog('adaptive-retry').retryCompletionPass).toBeLessThan(backlog('fixed-one').retryCompletionPass);
        const recurring = (arm: InboxQueueReader.LaneBudgetPolicy) => results.find((result) => result.workload === 'recurring' && result.arm === arm)!;
        expect(recurring('adaptive-retry').completed, verdict).toEqual(recurring('fixed-retry-two').completed);
    }, 600_000);
});
