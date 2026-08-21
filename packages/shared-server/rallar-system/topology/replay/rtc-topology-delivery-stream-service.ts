import type {
    RtcTopologyDeliveryCompactionInput,
    RtcTopologyDeliveryCompactionResult,
    RtcTopologyDeliveryStreamLeaseRenewalInput,
    RtcTopologyDeliveryStreamLeaseRenewalResult,
    RtcTopologyDeliveryStreamRegistrationInput,
    RtcTopologyDeliveryStreamRegistrationResult
} from './rtc-topology-delivery-contracts.ts';
import { validateRtcTopologyDeliveryStreamId } from './rtc-topology-delivery-validation.ts';
import type {
    RtcTopologyReplayCursorRetirementInput,
    RtcTopologyReplayCursorRetirementResult,
    RtcTopologyReplayStreamRetirementInput,
    RtcTopologyReplayStreamRetirementResult
} from './rtc-topology-replay-contracts.ts';
import {
    RTC_TOPOLOGY_REPLAY_COMPACTION_INTERVAL_MS,
    RTC_TOPOLOGY_REPLAY_COMPACTION_PAGE_SIZE,
    RTC_TOPOLOGY_REPLAY_HEARTBEAT_INTERVAL_MS,
    RTC_TOPOLOGY_REPLAY_LEASE_DURATION_MS,
    RTC_TOPOLOGY_REPLAY_RETENTION_MS
} from './rtc-topology-replay-policy.ts';

export interface RtcTopologyDeliveryStreamMaintenancePort {
    registerStream(
        input: RtcTopologyDeliveryStreamRegistrationInput
    ): Promise<RtcTopologyDeliveryStreamRegistrationResult>;
    renewStreamLease(
        input: RtcTopologyDeliveryStreamLeaseRenewalInput
    ): Promise<RtcTopologyDeliveryStreamLeaseRenewalResult>;
    compactExpiredEntries(
        input: RtcTopologyDeliveryCompactionInput
    ): Promise<RtcTopologyDeliveryCompactionResult>;
    retireExpiredConsumerCursors(
        input: RtcTopologyReplayCursorRetirementInput
    ): Promise<RtcTopologyReplayCursorRetirementResult>;
    retireEmptyStreams(
        input: RtcTopologyReplayStreamRetirementInput
    ): Promise<RtcTopologyReplayStreamRetirementResult>;
}

export interface RtcTopologyDeliveryStreamScheduler {
    repeat(task: () => Promise<void>, intervalMs: number): () => void;
}

export class RtcTopologyDeliveryLeaseLostError extends Error {
    readonly code = 'rtc-topology-delivery-lease-lost';

    constructor(message: string) {
        super(message);
        this.name = 'RtcTopologyDeliveryLeaseLostError';
    }
}

interface RtcTopologyDeliveryStreamServiceOptions {
    readonly streamId: string;
    readonly repository: RtcTopologyDeliveryStreamMaintenancePort;
    readonly scheduler?: RtcTopologyDeliveryStreamScheduler;
    readonly onHealthFailure: (error: Error) => void;
    readonly onCompactionFailure?: (error: Error) => void;
}

export class RtcTopologyDeliveryStreamService {
    readonly #streamId: string;
    readonly #repository: RtcTopologyDeliveryStreamMaintenancePort;
    readonly #scheduler: RtcTopologyDeliveryStreamScheduler;
    readonly #onHealthFailure: (error: Error) => void;
    readonly #onCompactionFailure: (error: Error) => void;
    #startPromise: Promise<void> | undefined;
    #stops: Array<() => void> = [];
    #stopped = false;
    #heartbeatRunning = false;
    #compactionRunning = false;

    constructor(options: RtcTopologyDeliveryStreamServiceOptions) {
        validateRtcTopologyDeliveryStreamId(options.streamId);
        this.#streamId = options.streamId;
        this.#repository = options.repository;
        this.#scheduler = options.scheduler ?? intervalScheduler;
        this.#onHealthFailure = options.onHealthFailure;
        this.#onCompactionFailure = options.onCompactionFailure ?? (() => undefined);
    }

    start(): Promise<void> {
        this.#startPromise ??= this.#registerAndSchedule();
        return this.#startPromise;
    }

    stop(): void {
        if (this.#stopped) {
            return;
        }
        this.#stopped = true;
        const stops = this.#stops;
        this.#stops = [];
        for (const stop of stops) {
            stop();
        }
    }

    async #registerAndSchedule(): Promise<void> {
        const registration = await this.#repository.registerStream({
            streamId: this.#streamId,
            leaseDurationMs: RTC_TOPOLOGY_REPLAY_LEASE_DURATION_MS
        });
        if (registration.status === 'conflict') {
            throw new RtcTopologyDeliveryLeaseLostError(
                `RTC topology delivery stream ${this.#streamId} is already registered`
            );
        }
        if (this.#stopped) {
            return;
        }

        this.#stops.push(
            this.#scheduler.repeat(
                async () => await this.#runHeartbeat(),
                RTC_TOPOLOGY_REPLAY_HEARTBEAT_INTERVAL_MS
            ),
            this.#scheduler.repeat(
                async () => await this.#runCompaction(),
                RTC_TOPOLOGY_REPLAY_COMPACTION_INTERVAL_MS
            )
        );
    }

    async #runHeartbeat(): Promise<void> {
        if (this.#stopped || this.#heartbeatRunning) {
            return;
        }
        this.#heartbeatRunning = true;
        try {
            const renewal = await this.#repository.renewStreamLease({
                streamId: this.#streamId,
                leaseDurationMs: RTC_TOPOLOGY_REPLAY_LEASE_DURATION_MS
            });
            if (renewal.status === 'lease-lost') {
                const error = new RtcTopologyDeliveryLeaseLostError(
                    `RTC topology delivery stream ${this.#streamId} lost its lease`
                );
                this.stop();
                this.#onHealthFailure(error);
            }
        }
        catch (error) {
            this.#onHealthFailure(
                error instanceof Error
                    ? error
                    : new Error('RTC topology delivery heartbeat failed', { cause: error })
            );
        }
        finally {
            this.#heartbeatRunning = false;
        }
    }

    async #runCompaction(): Promise<void> {
        if (this.#stopped || this.#compactionRunning) {
            return;
        }
        this.#compactionRunning = true;
        try {
            await this.#repository.compactExpiredEntries({
                pageSize: RTC_TOPOLOGY_REPLAY_COMPACTION_PAGE_SIZE
            });
            await this.#repository.retireExpiredConsumerCursors({
                retentionMs: RTC_TOPOLOGY_REPLAY_RETENTION_MS,
                pageSize: RTC_TOPOLOGY_REPLAY_COMPACTION_PAGE_SIZE
            });
            await this.#repository.retireEmptyStreams({
                pageSize: RTC_TOPOLOGY_REPLAY_COMPACTION_PAGE_SIZE
            });
        }
        catch (error) {
            this.#onCompactionFailure(
                error instanceof Error
                    ? error
                    : new Error('RTC topology delivery compaction failed', { cause: error })
            );
        }
        finally {
            this.#compactionRunning = false;
        }
    }
}

const intervalScheduler: RtcTopologyDeliveryStreamScheduler = {
    repeat: (task, intervalMs) => {
        const timer = setInterval(() => {
            void task();
        }, intervalMs);
        return () => clearInterval(timer);
    }
};
