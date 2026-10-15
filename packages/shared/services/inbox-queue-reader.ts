import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { DequeueController } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import type { QueueBoxResourceEntryRepository, ResourceInboxWorkPage } from '@shared/queuebox/queue-box-types.ts';
import type { DequeueResourceEntryOptions } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceInboxCompletionNotifications } from '@shared/queuebox/resource-inbox/resource-inbox-completion-notifications.ts';
import type { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import {
    EntityStatus,
    isExpiredResourceEntry,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { RateLimiter } from '@shared/resilience/Resilience.ts';
import type {
    OnQueuedMessageCallback,
    OnRejectedQueuedMessageCallback
} from '@shared/services/queue-message-callbacks.ts';

import type { QueueBoxUtilities } from './queue-box-utilities.ts';
import { QueueMessageReader } from './queue-message-reader.ts';

export namespace InboxQueueReader {
    /**
     * How many due retries one AppInbox pass serves: up to the drain limit, one, one or two by the observed retry
     * pressure, or two. Every other lane's budget is the same under each policy.
     */
    export type LaneBudgetPolicy = 'drain' | 'fixed-one' | 'adaptive-retry' | 'fixed-retry-two';

    export interface Options extends DequeueResourceEntryOptions {
        readonly laneBudgetPolicy: LaneBudgetPolicy;
    }

    export interface PressureSample {
        readonly observedAt: number;
        readonly retryQuota: number;
    }

    export interface PressureObservation {
        readonly generation: number;
        readonly maxAttempts: number;
        readonly observedAt: number;
    }
}

export class InboxQueueReader {
    public static readonly INBOX_ENQUEUE_TYPE = EnqueuedType.APP_INBOX;
    public static readonly INBOX_DEQUEUE_TYPES = new Set<string>([
        this.INBOX_ENQUEUE_TYPE
    ]);
    public static readonly LANE_BUDGET_POLICIES: readonly InboxQueueReader.LaneBudgetPolicy[] = [
        'drain',
        'fixed-one',
        'adaptive-retry',
        'fixed-retry-two'
    ];
    public static readonly DEFAULT_LANE_BUDGET_POLICY: InboxQueueReader.LaneBudgetPolicy = 'adaptive-retry';

    private readonly reader: QueueMessageReader;
    private readonly laneBudgetPolicy: InboxQueueReader.LaneBudgetPolicy;
    private readonly nowEpochMs: () => number;
    private readonly pressureRefreshLimiter: RateLimiter;
    private pressureScope: string | undefined;
    private pressureGeneration = 0;
    private pressureCursor: ResourceInboxWorkPage.Cursor | null = null;
    private pressureSample: InboxQueueReader.PressureSample | undefined;
    private pressureRefresh: Promise<void> | undefined;

    private static readonly PRESSURE_WINDOW_MS = 1_000;
    /** One NEW round claims at most this many contexts' oldest entries; the pass serves them one after another. */
    private static readonly NEW_CONTEXTS_PER_PASS = 8;

    public readonly completionNotifications: ResourceInboxCompletionNotifications | undefined;
    public readonly inbox: QueueBoxResourceEntryRepository;

    constructor(
        inbox: QueueBoxResourceEntryRepository,
        dequeueOptions: InboxQueueReader.Options = { laneBudgetPolicy: InboxQueueReader.DEFAULT_LANE_BUDGET_POLICY },
        creationNow: QueueBoxUtilities.CreationClock = Temporal.Now.instant
    ) {
        this.completionNotifications = dequeueOptions.completionNotifications;
        this.inbox = inbox;
        this.laneBudgetPolicy = dequeueOptions.laneBudgetPolicy;
        this.nowEpochMs = dequeueOptions.nowEpochMs ?? Date.now;
        this.pressureRefreshLimiter = RateLimiter.initWithTs(
            InboxQueueReader.PRESSURE_WINDOW_MS,
            1,
            this.nowEpochMs()
        );
        this.reader = new QueueMessageReader(inbox, {
            enqueueType: InboxQueueReader.INBOX_ENQUEUE_TYPE,
            creationNow,
            dequeueOptions: { ...dequeueOptions, newLaneClaimOrder: 'oldest-per-context' }
        });
    }

    onInboxMessageDo(type: string, callback: OnQueuedMessageCallback): this {
        this.reader.onMessageDo(type, callback);
        return this;
    }

    removeInboxMessageCallback(type: string): boolean {
        return this.reader.removeMessageCallback(type);
    }

    onRejectedInboxMessageDo(callback: OnRejectedQueuedMessageCallback): void {
        this.reader.onRejectedMessageDo(callback);
    }

    onDequeuePassDo(observer: QueueMessageReader.DequeuePassObserver): void {
        this.reader.onDequeuePassDo(observer);
    }

    /** One storage read naming the lanes the next pass may claim from; the engine's work probe for this queue. */
    async readWorkAdvertisement(
        typesToDequeue: Set<string>,
        resilience: ResourceInboxResilience
    ): Promise<DequeueController.WorkAdvertisement> {
        return await this.reader.readWorkAdvertisement(typesToDequeue, resilience);
    }

    async enqueueIfAbsent(message: ALMessage): Promise<ResourceEntry> {
        return await this.reader.enqueueIfAbsent(message);
    }

    /** Resolves with the number of entries this invocation claimed; a preceding probe limits the lanes it offers. */
    async dequeueInbox(
        typesToDequeue: Set<string>,
        resilience: ResourceInboxResilience,
        workAdvertisement?: DequeueController.WorkAdvertisement
    ): Promise<number> {
        const isAppInbox = typesToDequeue.size === 1 && typesToDequeue.has(EnqueuedType.APP_INBOX);
        const scope = isAppInbox ? `${EnqueuedType.APP_INBOX}:${resilience.retryPolicy.maxAttempts}` : undefined;
        if (this.pressureScope !== scope) {
            this.pressureScope = scope;
            this.pressureGeneration += 1;
            this.pressureSample = undefined;
            this.pressureCursor = null;
        }
        return await this.reader.dequeue({
            typesToDequeue,
            resilience,
            readLaneBudgets: isAppInbox
                ? () => this.readLaneBudgets(resilience.retryPolicy.maxAttempts, workAdvertisement)
                : undefined,
            workAdvertisement
        });
    }

    private readLaneBudgets(
        maxAttempts: number,
        workAdvertisement: DequeueController.WorkAdvertisement | undefined
    ): DequeueController.LaneBudgets {
        return {
            FINALIZATION: { maxToReserve: 1, maxNumToDequeue: 1 },
            NEW: {
                maxToReserve: InboxQueueReader.NEW_CONTEXTS_PER_PASS,
                maxNumToDequeue: InboxQueueReader.NEW_CONTEXTS_PER_PASS
            },
            FAIRNESS: { maxToReserve: 1, maxNumToDequeue: 1 },
            RETRY: { maxToReserve: 1, maxNumToDequeue: this.readRetryQuota(maxAttempts, workAdvertisement) },
            TIMEOUT: { maxToReserve: 1, maxNumToDequeue: 1 }
        };
    }

    private readRetryQuota(
        maxAttempts: number,
        workAdvertisement: DequeueController.WorkAdvertisement | undefined
    ): number {
        switch (this.laneBudgetPolicy) {
            case 'drain':
                return DequeueController.DEFAULT_MAX_NUM_TO_DEQUEUE;
            case 'fixed-one':
                return 1;
            case 'fixed-retry-two':
                return 2;
            case 'adaptive-retry':
                return this.readAdaptiveRetryQuota(maxAttempts, workAdvertisement);
        }
    }

    /** A probe that advertised no due retry makes a pressure page read pointless: it would observe none. */
    private readAdaptiveRetryQuota(
        maxAttempts: number,
        workAdvertisement: DequeueController.WorkAdvertisement | undefined
    ): number {
        const now = this.nowEpochMs();
        const sample = this.pressureSample;
        const retryQuota = sample && now >= sample.observedAt &&
                now - sample.observedAt < InboxQueueReader.PRESSURE_WINDOW_MS
            ? sample.retryQuota
            : 1;
        const retryAdvertised = workAdvertisement === undefined || workAdvertisement.RETRY;
        if (retryAdvertised && !this.pressureRefresh && this.pressureRefreshLimiter.allowAt(now)) {
            this.pressureRefresh = this.refreshRetryPressure({
                generation: this.pressureGeneration,
                maxAttempts,
                observedAt: now
            })
                .finally(() => {
                    this.pressureRefresh = undefined;
                });
        }
        return retryQuota;
    }

    private async refreshRetryPressure(observation: InboxQueueReader.PressureObservation): Promise<void> {
        const { generation, maxAttempts, observedAt } = observation;
        try {
            const page = await this.inbox.readWorkPage({
                typeId: EnqueuedType.APP_INBOX,
                status: EntityStatus.RETRY,
                maxToRead: 2,
                cursor: this.pressureCursor
            });
            const now = Temporal.Instant.fromEpochMilliseconds(observedAt);
            const eligible = page.entries.filter((entry) =>
                entry.typeId === EnqueuedType.APP_INBOX && entry.status === EntityStatus.RETRY &&
                !isExpiredResourceEntry(entry, now) && entry.dequeueAudit.attempts < maxAttempts &&
                entry.dequeueAudit.nextTs !== undefined && Temporal.Instant.compare(entry.dequeueAudit.nextTs, now) <= 0
            );
            if (generation === this.pressureGeneration) {
                this.pressureCursor = page.nextCursor;
                // A page is a lower bound, never proof that the lane is empty.
                this.pressureSample = { observedAt, retryQuota: eligible.length >= 2 ? 2 : 1 };
            }
        }
        catch (error) {
            if (generation === this.pressureGeneration) {
                this.pressureSample = undefined;
            }
            console.warn('AppInbox retry pressure observation failed', error);
        }
    }
}
