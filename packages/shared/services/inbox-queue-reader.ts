import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { DequeueController } from '@shared/queuebox/dequeue/dequeue-controller.ts';
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
     * The lifecycle of one engine pass over this queue: a probe, then the pass it advertised, with the
     * handler of every claimed entry. One observer at a time; the owner measures what it will at each step.
     */
    export interface DequeuePassObserver extends QueueBoxUtilities.DequeueHandlerObserver {
        onProbeStarted(): void;
        onProbeFinished(advertisedLanes: DequeueController.WorkAdvertisement): void;
        onPassStarted(): void;
        onPassFinished(): void;
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

    private readonly reader: QueueMessageReader;
    private readonly nowEpochMs: () => number;
    private readonly pressureRefreshLimiter: RateLimiter;
    private pressureScope: string | undefined;
    private pressureGeneration = 0;
    private pressureCursor: ResourceInboxWorkPage.Cursor | null = null;
    private pressureSample: InboxQueueReader.PressureSample | undefined;
    private pressureRefresh: Promise<void> | undefined;
    private dequeuePassObserver: InboxQueueReader.DequeuePassObserver | undefined;

    private static readonly PRESSURE_WINDOW_MS = 1_000;

    public readonly completionNotifications: ResourceInboxCompletionNotifications | undefined;
    public readonly inbox: QueueBoxResourceEntryRepository;

    constructor(
        inbox: QueueBoxResourceEntryRepository,
        dequeueOptions: DequeueResourceEntryOptions = {},
        creationNow: QueueBoxUtilities.CreationClock = Temporal.Now.instant
    ) {
        this.completionNotifications = dequeueOptions.completionNotifications;
        this.inbox = inbox;
        this.nowEpochMs = dequeueOptions.nowEpochMs ?? Date.now;
        this.pressureRefreshLimiter = RateLimiter.initWithTs(
            InboxQueueReader.PRESSURE_WINDOW_MS,
            1,
            this.nowEpochMs()
        );
        this.reader = new QueueMessageReader(inbox, {
            enqueueType: InboxQueueReader.INBOX_ENQUEUE_TYPE,
            creationNow,
            dequeueOptions
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

    onDequeuePassDo(observer: InboxQueueReader.DequeuePassObserver): void {
        this.dequeuePassObserver = observer;
    }

    /** One storage read naming the lanes the next pass may claim from; the engine's work probe for this queue. */
    async readWorkAdvertisement(
        typesToDequeue: Set<string>,
        resilience: ResourceInboxResilience
    ): Promise<DequeueController.WorkAdvertisement> {
        this.dequeuePassObserver?.onProbeStarted();
        const advertisedLanes = await this.inbox.readWorkAdvertisement(
            typesToDequeue,
            resilience.toWorkAdvertisementOptions()
        );
        this.dequeuePassObserver?.onProbeFinished(advertisedLanes);
        return advertisedLanes;
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
        const observer = this.dequeuePassObserver;
        observer?.onPassStarted();
        try {
            return await this.reader.dequeue({
                typesToDequeue,
                resilience,
                readLaneBudgets: isAppInbox
                    ? () => this.readLaneBudgets(resilience.retryPolicy.maxAttempts, workAdvertisement)
                    : undefined,
                workAdvertisement,
                handlerObserver: observer
            });
        }
        finally {
            observer?.onPassFinished();
        }
    }

    /** A probe that advertised no due retry makes a pressure page read pointless: it would observe none. */
    private readLaneBudgets(
        maxAttempts: number,
        workAdvertisement: DequeueController.WorkAdvertisement | undefined
    ): DequeueController.LaneBudgets {
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
        return {
            FINALIZATION: { maxToReserve: 1, maxNumToDequeue: 1 },
            NEW: { maxToReserve: 1, maxNumToDequeue: 1 },
            FAIRNESS: { maxToReserve: 1, maxNumToDequeue: 1 },
            RETRY: { maxToReserve: 1, maxNumToDequeue: retryQuota },
            TIMEOUT: { maxToReserve: 1, maxNumToDequeue: 1 }
        };
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
