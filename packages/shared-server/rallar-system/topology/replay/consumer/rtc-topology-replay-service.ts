import { RtcTopologyDeliveryLeaseLostError } from '../delivery/rtc-topology-delivery-stream-service.ts';
import type {
    RtcTopologyReplayEntryHandler,
    RtcTopologyReplayPort,
    RtcTopologyReplayServicePolicy
} from './rtc-topology-replay-contracts.ts';
import type {
    RtcTopologyReplayDiagnosticsSink,
    RtcTopologyReplayWakeSource
} from './rtc-topology-replay-diagnostics.ts';
import { RtcTopologyReplayDrain } from './rtc-topology-replay-drain.ts';
import { RtcTopologyReplayPageProcessor } from './rtc-topology-replay-page-processor.ts';
import {
    defaultRtcTopologyReplayScheduler,
    type RtcTopologyReplayServiceScheduler
} from './rtc-topology-replay-scheduler.ts';

export namespace RtcTopologyReplayService {
    export interface Dependencies {
        readonly consumerStreamId: string;
        readonly repository: RtcTopologyReplayPort;
        readonly entryHandler: RtcTopologyReplayEntryHandler;
        readonly hydrateGap: (signal: AbortSignal) => Promise<void>;
        readonly policy: RtcTopologyReplayServicePolicy;
        readonly scheduler?: RtcTopologyReplayServiceScheduler;
        readonly onHealthFailure: (error: Error) => void;
        readonly diagnostics?: RtcTopologyReplayDiagnosticsSink;
    }
}

export class RtcTopologyReplayService {
    readonly #consumerStreamId: string;
    readonly #repository: RtcTopologyReplayPort;
    readonly #policy: RtcTopologyReplayServicePolicy;
    readonly #scheduler: RtcTopologyReplayServiceScheduler;
    readonly #onHealthFailure: (error: Error) => void;
    readonly #diagnostics: RtcTopologyReplayDiagnosticsSink | undefined;
    readonly #drain: RtcTopologyReplayDrain;
    readonly #abort = new AbortController();
    #startPromise: Promise<void> | undefined;
    #runPromise: Promise<void> | undefined;
    #cancelPoll: (() => void) | undefined;
    #wakePending = false;
    #initialized = false;
    #stopped = false;

    constructor(dependencies: RtcTopologyReplayService.Dependencies) {
        this.#consumerStreamId = dependencies.consumerStreamId;
        this.#repository = dependencies.repository;
        this.#policy = dependencies.policy;
        this.#scheduler = dependencies.scheduler ?? defaultRtcTopologyReplayScheduler;
        this.#onHealthFailure = dependencies.onHealthFailure;
        this.#diagnostics = dependencies.diagnostics;
        const pageProcessor = new RtcTopologyReplayPageProcessor({
            consumerStreamId: dependencies.consumerStreamId,
            repository: dependencies.repository,
            entryHandler: dependencies.entryHandler,
            hydrateGap: dependencies.hydrateGap,
            diagnostics: dependencies.diagnostics
        });
        this.#drain = new RtcTopologyReplayDrain({
            consumerStreamId: dependencies.consumerStreamId,
            repository: dependencies.repository,
            pageProcessor,
            policy: dependencies.policy,
            diagnostics: dependencies.diagnostics
        });
    }

    start(): Promise<void> {
        if (this.#stopped) {
            this.#startPromise ??= Promise.resolve();
            return this.#startPromise;
        }
        if (!this.#startPromise) {
            this.#diagnostics?.({ kind: 'wake', source: 'startup' });
        }
        this.#startPromise ??= this.#initialize();
        return this.#startPromise;
    }

    wake(source: RtcTopologyReplayWakeSource): void {
        if (this.#stopped) {
            return;
        }
        this.#diagnostics?.({ kind: 'wake', source });
        this.#wakePending = true;
        this.#ensureRun();
    }

    async whenIdle(): Promise<void> {
        while (this.#runPromise) {
            await this.#runPromise;
        }
    }

    async stop(): Promise<void> {
        if (!this.#stopped) {
            this.#stopped = true;
            this.#wakePending = false;
            this.#abort.abort();
            this.#cancelPoll?.();
            this.#cancelPoll = undefined;
        }
        await this.whenIdle();
    }

    async #initialize(): Promise<void> {
        await this.#repository.initializeConsumer({ consumerStreamId: this.#consumerStreamId });
        if (this.#stopped) {
            return;
        }
        this.#cancelPoll = this.#scheduler.repeat(
            () => this.wake('poll'),
            this.#policy.antiEntropyIntervalMs
        );
        const outcome = await this.#drain.runTurn(this.#abort.signal);
        this.#initialized = true;
        if (outcome === 'more') {
            this.#wakePending = true;
        }
        if (this.#wakePending) {
            this.#ensureRun();
        }
    }

    #ensureRun(): void {
        if (this.#runPromise || this.#stopped || !this.#initialized) {
            return;
        }
        this.#runPromise = this.#runRequestedTurns().finally(() => {
            this.#runPromise = undefined;
            if (this.#wakePending && !this.#stopped) {
                this.#ensureRun();
            }
        });
    }

    async #runRequestedTurns(): Promise<void> {
        while (this.#wakePending && !this.#stopped) {
            this.#wakePending = false;
            try {
                const outcome = await this.#drain.runTurn(this.#abort.signal);
                if (outcome === 'more' && !this.#stopped) {
                    this.#wakePending = true;
                    await this.#scheduler.yield();
                }
            }
            catch (error) {
                if (error instanceof RtcTopologyDeliveryLeaseLostError) {
                    this.#stopAfterLeaseLoss(error);
                    return;
                }
            }
        }
    }

    #stopAfterLeaseLoss(error: RtcTopologyDeliveryLeaseLostError): void {
        this.#stopped = true;
        this.#wakePending = false;
        this.#abort.abort();
        this.#cancelPoll?.();
        this.#cancelPoll = undefined;
        this.#onHealthFailure(error);
    }
}
