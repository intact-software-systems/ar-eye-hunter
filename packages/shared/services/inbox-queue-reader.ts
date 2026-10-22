import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { DequeueController } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { DequeueLaneFlight } from '@shared/queuebox/dequeue/dequeue-lane-flight.ts';
import type {
    QueueBoxResourceEntryRepository,
    QueueBoxWrittenIfAbsent,
    ResourceInboxWorkPage
} from '@shared/queuebox/queue-box-types.ts';
import type { DequeueResourceEntryOptions } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceInboxAttempt } from '@shared/queuebox/resource-inbox/resource-inbox-attempt-telemetry.ts';
import type { ResourceInboxCompletionNotifications } from '@shared/queuebox/resource-inbox/resource-inbox-completion-notifications.ts';
import type { ResourceInboxHandlerOutcome } from '@shared/queuebox/resource-inbox/resource-inbox-handler-outcome.ts';
import type { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import {
    EntityStatus,
    isExpiredResourceEntry,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { RateLimiter } from '@shared/resilience/Resilience.ts';
import type {
    OnQueuedMessageCallback,
    OnRejectedQueuedMessageCallback
} from '@shared/services/queue-message-callbacks.ts';

import { INBOX_OUTBOX_ENGINE_MAX_IDLE_MS } from './inbox-outbox-engine.ts';
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
        /**
         * How many distinct-context heads one NEW round reserves in one claim and runs together, from one to the
         * contexts a pass serves. Rows of one context never run together: a context with a row in flight, or one a
         * draining pass already served, has no head to claim.
         */
        readonly newLaneConcurrency: number;
        /**
         * The claimed rows an AppInbox flight holds across passes, from the lane's concurrency to
         * `MAX_NEW_LANE_HELD_ROWS`: a pass tops the flight up and returns while its rows compute, release and settle,
         * and every lane's claims join it. Absent, each pass drains what it claimed before it resolves.
         */
        readonly newLaneHeldRows?: number;
        /**
         * Told of every row the AppInbox flight takes, so the owner of the passes joins and wakes on them; required with
         * `newLaneHeldRows`, and absent only for a reader whose passes drain what they claim.
         */
        readonly flightEntryListener?: FlightEntryListener;
    }

    /**
     * Told of each row the flight takes; the promise resolves once the row is released or its release failed. A release
     * error is rethrown by the next pass instead, or taken by an owner that runs no further pass, so it is reported once.
     */
    export type FlightEntryListener = (settlement: Promise<void>) => void;

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
    /**
     * The contexts one draining pass serves, each its oldest entry once. A NEW round claims up to the lane's concurrency
     * of these heads at once rather than all of them, so a peer instance can take the other heads meanwhile.
     */
    public static readonly NEW_CONTEXTS_PER_PASS = 8;
    public static readonly MAX_NEW_LANE_HELD_ROWS = 64;
    public static readonly LANE_BUDGET_POLICIES: readonly InboxQueueReader.LaneBudgetPolicy[] = [
        'drain',
        'fixed-one',
        'adaptive-retry',
        'fixed-retry-two'
    ];

    private readonly reader: QueueMessageReader;
    private readonly laneBudgetPolicy: InboxQueueReader.LaneBudgetPolicy;
    private readonly newLaneConcurrency: number;
    private readonly newLaneHeldRows: number | undefined;
    private readonly flight:
        | DequeueLaneFlight<Key, ResourceInboxAttempt, ResourceInboxHandlerOutcome | undefined>
        | undefined;
    private readonly flightEntryListener: InboxQueueReader.FlightEntryListener | undefined;
    /**
     * Set by a top-up that claimed nothing while rows were in flight and neither a row settled nor another writer's row
     * was announced meanwhile; the next settlement or announcement clears it. The wait ends at the engine's idle ceiling
     * at the latest, since a retry coming due, a peer's lease running out or a finalization row settles nothing here.
     */
    private flightSettlementWaitEndMs: number | undefined;
    private flightSettlementCount = 0;
    private externalWriteCount = 0;
    /** The dequeue clock that stamps each claim's selection. */
    public readonly nowEpochMs: () => number;
    private readonly pressureRefreshLimiter: RateLimiter;
    private pressureScope: string | undefined;
    private pressureGeneration = 0;
    private pressureCursor: ResourceInboxWorkPage.Cursor | null = null;
    private pressureSample: InboxQueueReader.PressureSample | undefined;
    private pressureRefresh: Promise<void> | undefined;

    private static readonly PRESSURE_WINDOW_MS = 1_000;

    public readonly completionNotifications: ResourceInboxCompletionNotifications | undefined;
    public readonly inbox: QueueBoxResourceEntryRepository;

    constructor(
        inbox: QueueBoxResourceEntryRepository,
        dequeueOptions: InboxQueueReader.Options,
        creationNow: QueueBoxUtilities.CreationClock = Temporal.Now.instant
    ) {
        this.completionNotifications = dequeueOptions.completionNotifications;
        this.inbox = inbox;
        this.laneBudgetPolicy = dequeueOptions.laneBudgetPolicy;
        this.newLaneConcurrency = requireNewLaneConcurrency(dequeueOptions.newLaneConcurrency);
        this.newLaneHeldRows = dequeueOptions.newLaneHeldRows === undefined
            ? undefined
            : requireNewLaneHeldRows(dequeueOptions.newLaneHeldRows, this.newLaneConcurrency);
        this.nowEpochMs = dequeueOptions.nowEpochMs ?? Date.now;
        this.flightEntryListener = dequeueOptions.flightEntryListener;
        if (this.newLaneHeldRows !== undefined && this.flightEntryListener === undefined) {
            throw new TypeError('An AppInbox standing flight requires a flight entry listener');
        }
        this.flight = this.newLaneHeldRows === undefined
            ? undefined
            : new DequeueLaneFlight({
                maxConcurrentComputes: this.newLaneConcurrency,
                maxUnreleased: this.newLaneHeldRows,
                keyedChainsFirst: true,
                toExclusionKey: dequeueOptions.toComputeExclusionKey,
                releaseFailureClock: this.nowEpochMs,
                retainSettlement: (settlement) => this.retainFlightSettlement(settlement)
            });
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

    onDequeuePassDo(observer: QueueMessageReader.DequeuePassObserver): void {
        this.reader.onDequeuePassDo(observer);
    }

    /**
     * Whether an AppInbox pass would claim nothing until a row in flight settles: the flight holds its bound, or the
     * last top-up claimed nothing while rows were in flight, so what work there is belongs to their contexts.
     */
    isAwaitingFlightSettlement(): boolean {
        return this.flight !== undefined &&
            (this.flight.getFreePlaceCount() === 0 || this.getFlightSettlementWaitEndMs() !== undefined);
    }

    /** Whether a row's release failed since the last pass: the next pass rethrows that error before it claims anything. */
    hasFlightErrorToRethrow(): boolean {
        return this.flight?.isStopped() ?? false;
    }

    /** Takes the release error the next pass would rethrow, for an owner that runs no further pass. */
    takeFlightErrorToRethrow(): Error | undefined {
        return this.flight?.takeFirstError();
    }

    /** When the wait of a top-up that claimed nothing ends without a settlement; undefined when no such wait holds. */
    getFlightSettlementWaitEndMs(): number | undefined {
        const waitEndMs = this.flightSettlementWaitEndMs;
        return waitEndMs !== undefined && this.nowEpochMs() < waitEndMs ? waitEndMs : undefined;
    }

    /**
     * A writer this reader does not own may have queued a row of a context with nothing in flight, so the next pass is
     * worth its probe again; a full flight still waits for a settlement.
     */
    resetFlightSettlementWait(): void {
        this.externalWriteCount += 1;
        this.flightSettlementWaitEndMs = undefined;
    }

    /** One storage read naming the lanes the next pass may claim from; the engine's work probe for this queue. */
    async readWorkAdvertisement(
        typesToDequeue: Set<string>,
        resilience: ResourceInboxResilience
    ): Promise<DequeueController.WorkAdvertisement> {
        return await this.reader.readWorkAdvertisement(typesToDequeue, resilience);
    }

    async enqueueIfAbsent(message: ALMessage): Promise<ResourceEntry> {
        return (await this.writeIfAbsent(message)).entry;
    }

    async writeIfAbsent(message: ALMessage): Promise<QueueBoxWrittenIfAbsent> {
        return await this.reader.writeIfAbsent(message);
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
        const standingFlight = isAppInbox ? this.flight : undefined;
        const settlementCountAtStart = this.flightSettlementCount;
        const externalWriteCountAtStart = this.externalWriteCount;
        const claimedCount = await this.reader.dequeue({
            typesToDequeue,
            resilience,
            // A budgeted AppInbox pass claims context heads; any other type set keeps draining in queue order.
            newLaneClaimOrder: isAppInbox ? 'oldest-per-context' : 'queue',
            readLaneBudgets: isAppInbox
                ? () => this.readLaneBudgets(resilience.retryPolicy.maxAttempts, workAdvertisement)
                : undefined,
            workAdvertisement,
            standingFlight
        });
        if (standingFlight !== undefined) {
            const awaitsSettlement = claimedCount === 0 && standingFlight.getUnreleasedCount() > 0 &&
                this.flightSettlementCount === settlementCountAtStart &&
                this.externalWriteCount === externalWriteCountAtStart;
            this.flightSettlementWaitEndMs = awaitsSettlement
                ? this.nowEpochMs() + INBOX_OUTBOX_ENGINE_MAX_IDLE_MS
                : undefined;
        }
        return claimedCount;
    }

    private retainFlightSettlement(settlement: Promise<void>): void {
        this.flightEntryListener?.(settlement.then(() => {
            this.flightSettlementCount += 1;
            this.flightSettlementWaitEndMs = undefined;
        }));
    }

    private readLaneBudgets(
        maxAttempts: number,
        workAdvertisement: DequeueController.WorkAdvertisement | undefined
    ): DequeueController.LaneBudgets {
        const retryQuota = this.readRetryQuota(maxAttempts, workAdvertisement);
        // Only NEW heads are of distinct contexts; every other lane may hold two rows of one context, so they run in turn.
        // A standing flight computes every lane's rows under its own bounds, and a top-up may fill all of its places.
        return {
            FINALIZATION: { maxToReserve: 1, maxNumToDequeue: 1, maxConcurrentComputes: 1 },
            NEW: {
                maxToReserve: this.newLaneConcurrency,
                maxNumToDequeue: this.newLaneHeldRows ?? InboxQueueReader.NEW_CONTEXTS_PER_PASS,
                maxConcurrentComputes: this.newLaneConcurrency
            },
            FAIRNESS: { maxToReserve: 1, maxNumToDequeue: 1, maxConcurrentComputes: 1 },
            // One claim for the whole quota: a short claim ends the lane without a second, empty reservation.
            RETRY: { maxToReserve: retryQuota, maxNumToDequeue: retryQuota, maxConcurrentComputes: 1 },
            TIMEOUT: { maxToReserve: 1, maxNumToDequeue: 1, maxConcurrentComputes: 1 }
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

function requireNewLaneHeldRows(newLaneHeldRows: number, newLaneConcurrency: number): number {
    if (
        !Number.isSafeInteger(newLaneHeldRows) || newLaneHeldRows < newLaneConcurrency ||
        newLaneHeldRows > InboxQueueReader.MAX_NEW_LANE_HELD_ROWS
    ) {
        throw new RangeError(
            'AppInbox NEW lane held rows must be an integer from the lane concurrency to the largest flight'
        );
    }
    return newLaneHeldRows;
}

function requireNewLaneConcurrency(newLaneConcurrency: number): number {
    if (
        !Number.isSafeInteger(newLaneConcurrency) || newLaneConcurrency < 1 ||
        newLaneConcurrency > InboxQueueReader.NEW_CONTEXTS_PER_PASS
    ) {
        throw new RangeError('AppInbox NEW lane concurrency must be an integer from 1 to the contexts a pass serves');
    }
    return newLaneConcurrency;
}
