import type {
    RtcTopologyReplayCursorRetirementInput,
    RtcTopologyReplayCursorRetirementResult,
    RtcTopologyReplayStreamRetirementInput,
    RtcTopologyReplayStreamRetirementResult
} from '../consumer/rtc-topology-replay-contracts.ts';
import type {
    RtcTopologyDeliveryCompactionInput,
    RtcTopologyDeliveryCompactionResult,
    RtcTopologyDeliveryStreamLeaseRenewalInput,
    RtcTopologyDeliveryStreamLeaseRenewalResult,
    RtcTopologyDeliveryStreamRegistrationInput,
    RtcTopologyDeliveryStreamRegistrationResult
} from './rtc-topology-delivery-contracts.ts';
import { assertRtcTopologyDeliveryStreamId } from './rtc-topology-delivery-validation.ts';
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

export interface RtcTopologyDeliveryStreamPolicy {
    readonly heartbeatIntervalMs: number;
    readonly leaseDurationMs: number;
    readonly compactionIntervalMs: number;
    readonly compactionPageSize: number;
    readonly consumerRetentionMs: number;
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
    readonly policy: RtcTopologyDeliveryStreamPolicy;
    readonly scheduler?: RtcTopologyDeliveryStreamScheduler;
    readonly onHealthFailure: (error: Error) => void;
    readonly onCompactionFailure?: (error: Error) => void;
}

export class RtcTopologyDeliveryStreamService {
    readonly #streamId: string;
    readonly #repository: RtcTopologyDeliveryStreamMaintenancePort;
    readonly #policy: RtcTopologyDeliveryStreamPolicy;
    readonly #scheduler: RtcTopologyDeliveryStreamScheduler;
    readonly #onHealthFailure: (error: Error) => void;
    readonly #onCompactionFailure: (error: Error) => void;
    #startPromise: Promise<void> | undefined;
    #stops: Array<() => void> = [];
    #stopped = false;
    #heartbeatRunning = false;
    #compactionRunning = false;

    constructor(options: RtcTopologyDeliveryStreamServiceOptions) {
        assertRtcTopologyDeliveryStreamId(options.streamId);
        this.#streamId = options.streamId;
        this.#repository = options.repository;
        this.#policy = options.policy;
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
            leaseDurationMs: this.#policy.leaseDurationMs
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
                this.#policy.heartbeatIntervalMs
            ),
            this.#scheduler.repeat(
                async () => await this.#runCompaction(),
                this.#policy.compactionIntervalMs
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
                leaseDurationMs: this.#policy.leaseDurationMs
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
                pageSize: this.#policy.compactionPageSize
            });
            await this.#repository.retireExpiredConsumerCursors({
                retentionMs: this.#policy.consumerRetentionMs,
                pageSize: this.#policy.compactionPageSize
            });
            await this.#repository.retireEmptyStreams({
                pageSize: this.#policy.compactionPageSize
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
