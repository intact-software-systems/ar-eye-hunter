import { Temporal } from '@js-temporal/polyfill';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { DequeueController } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import type { QueueBoxResourceEntryRepository, ResourceInboxWorkPage } from '@shared/queuebox/queue-box-types.ts';
import type { DequeueResourceEntryOptions } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus, isExpiredResourceEntry, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { RateLimiter } from '@shared/resilience/Resilience.ts';
import type {
    OnQueuedMessageCallback,
    OnRejectedQueuedMessageCallback
} from '@shared/services/queue-message-callbacks.ts';
import { QueueMessageReader } from './queue-message-reader.ts';

export namespace InboxQueueReader {
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

    private static readonly PRESSURE_WINDOW_MS = 1_000;

    public readonly inbox: QueueBoxResourceEntryRepository;

    constructor(
        inbox: QueueBoxResourceEntryRepository,
        dequeueOptions: DequeueResourceEntryOptions = {}
    ) {
        this.inbox = inbox;
        this.nowEpochMs = dequeueOptions.nowEpochMs ?? Date.now;
        this.pressureRefreshLimiter = RateLimiter.initWithTs(
            InboxQueueReader.PRESSURE_WINDOW_MS,
            1,
            this.nowEpochMs()
        );
        this.reader = new QueueMessageReader(inbox, {
            enqueueType: InboxQueueReader.INBOX_ENQUEUE_TYPE,
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

    async enqueueIfAbsent(message: ALMessage): Promise<ResourceEntry> {
        return await this.reader.enqueueIfAbsent(message);
    }

    async dequeueInbox(typesToDequeue: Set<string>, resilience: ResourceInboxResilience): Promise<void> {
        const isAppInbox = typesToDequeue.size === 1 && typesToDequeue.has(EnqueuedType.APP_INBOX);
        const scope = isAppInbox ? `${EnqueuedType.APP_INBOX}:${resilience.retryPolicy.maxAttempts}` : undefined;
        if (this.pressureScope !== scope) {
            this.pressureScope = scope;
            this.pressureGeneration += 1;
            this.pressureSample = undefined;
            this.pressureCursor = null;
        }
        await this.reader.dequeue(
            typesToDequeue,
            resilience,
            isAppInbox ? () => this.readLaneBudgets(resilience.retryPolicy.maxAttempts) : undefined
        );
    }

    private readLaneBudgets(maxAttempts: number): DequeueController.LaneBudgets {
        const now = this.nowEpochMs();
        const sample = this.pressureSample;
        const retryQuota = sample && now >= sample.observedAt &&
                now - sample.observedAt < InboxQueueReader.PRESSURE_WINDOW_MS
            ? sample.retryQuota
            : 1;
        if (!this.pressureRefresh && this.pressureRefreshLimiter.allowAt(now)) {
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
