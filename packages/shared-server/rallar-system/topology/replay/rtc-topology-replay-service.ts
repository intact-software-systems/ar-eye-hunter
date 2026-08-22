import type { RtcTopologyDeliveryLogEntry } from './rtc-topology-delivery-contracts.ts';
import { RtcTopologyDeliveryLeaseLostError } from './rtc-topology-delivery-stream-service.ts';
import { RtcTopologyDeliveryCorruptionError } from './rtc-topology-delivery-validation.ts';
import type {
    RtcTopologyReplayConsumerInput,
    RtcTopologyReplayCursorCasInput,
    RtcTopologyReplayCursorCasResult,
    RtcTopologyReplayCursorSnapshot,
    RtcTopologyReplayPageInput,
    RtcTopologyReplayPageResult
} from './rtc-topology-replay-contracts.ts';
import type {
    RtcTopologyReplayDiagnosticsSink,
    RtcTopologyReplayWakeSource
} from './rtc-topology-replay-diagnostics.ts';
import {
    defaultRtcTopologyReplayScheduler,
    rotateRtcTopologyReplayPublishers,
    type RtcTopologyReplayServiceScheduler
} from './rtc-topology-replay-scheduler.ts';

export type { RtcTopologyReplayWakeSource } from './rtc-topology-replay-diagnostics.ts';
export type {
    RtcTopologyReplayServiceScheduler
} from './rtc-topology-replay-scheduler.ts';

export type RtcTopologyReplayEntryHandlingResult = Readonly<{
    status: 'delivered' | 'current-repair' | 'no-local-recipient' | 'send-failed' | 'gap';
}>;

export interface RtcTopologyReplayEntryHandler {
    handle(
        entry: RtcTopologyDeliveryLogEntry,
        databaseNowEpochMs: number,
        signal: AbortSignal
    ): Promise<RtcTopologyReplayEntryHandlingResult>;
}

export interface RtcTopologyReplayPort {
    initializeConsumer(
        input: RtcTopologyReplayConsumerInput
    ): Promise<readonly RtcTopologyReplayCursorSnapshot[]>;
    discoverPublishers(
        input: RtcTopologyReplayConsumerInput
    ): Promise<readonly RtcTopologyReplayCursorSnapshot[]>;
    capturePage(input: RtcTopologyReplayPageInput): Promise<RtcTopologyReplayPageResult>;
    compareAndSetCursor(
        input: RtcTopologyReplayCursorCasInput
    ): Promise<RtcTopologyReplayCursorCasResult>;
}

export interface RtcTopologyReplayServicePolicy {
    readonly antiEntropyIntervalMs: number;
    readonly pageSize: number;
    readonly maxPagesPerTurn: number;
    readonly maxEntriesPerTurn: number;
}

interface RtcTopologyReplayServiceOptions {
    readonly consumerStreamId: string;
    readonly repository: RtcTopologyReplayPort;
    readonly entryHandler: RtcTopologyReplayEntryHandler;
    readonly hydrateGap: (signal: AbortSignal) => Promise<void>;
    readonly policy: RtcTopologyReplayServicePolicy;
    readonly scheduler?: RtcTopologyReplayServiceScheduler;
    readonly onHealthFailure: (error: Error) => void;
    readonly diagnostics?: RtcTopologyReplayDiagnosticsSink;
}

type PublisherPageOutcome = 'done' | 'more' | 'failed';
type DrainTurnOutcome = 'caught-up' | 'more' | 'failed';

interface MutableDrainObservation {
    pageCount: number;
    entryCount: number;
    maxLagEntries: number;
}

export class RtcTopologyReplayService {
    readonly #consumerStreamId: string;
    readonly #repository: RtcTopologyReplayPort;
    readonly #entryHandler: RtcTopologyReplayEntryHandler;
    readonly #hydrateGap: (signal: AbortSignal) => Promise<void>;
    readonly #policy: RtcTopologyReplayServicePolicy;
    readonly #scheduler: RtcTopologyReplayServiceScheduler;
    readonly #onHealthFailure: (error: Error) => void;
    readonly #diagnostics: RtcTopologyReplayDiagnosticsSink | undefined;
    readonly #abort = new AbortController();
    #startPromise: Promise<void> | undefined;
    #runPromise: Promise<void> | undefined;
    #cancelPoll: (() => void) | undefined;
    #wakePending = false;
    #initialized = false;
    #rotation = 0;
    #stopped = false;

    constructor(options: RtcTopologyReplayServiceOptions) {
        this.#consumerStreamId = options.consumerStreamId;
        this.#repository = options.repository;
        this.#entryHandler = options.entryHandler;
        this.#hydrateGap = options.hydrateGap;
        this.#policy = options.policy;
        this.#scheduler = options.scheduler ?? defaultRtcTopologyReplayScheduler;
        this.#onHealthFailure = options.onHealthFailure;
        this.#diagnostics = options.diagnostics;
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
        const outcome = await this.#runDrainTurn();
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
                const outcome = await this.#runDrainTurn();
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

    async #runDrainTurn(): Promise<DrainTurnOutcome> {
        const startedAt = performance.now();
        const observation: MutableDrainObservation = {
            pageCount: 0,
            entryCount: 0,
            maxLagEntries: 0
        };
        try {
            const outcome = await this.#drainTurn(observation);
            this.#recordDrain(
                outcome === 'more' ? 'yielded' : outcome,
                performance.now() - startedAt,
                observation
            );
            return outcome;
        }
        catch (error) {
            this.#recordDrain(
                error instanceof RtcTopologyDeliveryLeaseLostError ? 'lease-lost' : 'failed',
                performance.now() - startedAt,
                observation
            );
            throw error;
        }
    }

    async #drainTurn(observation: MutableDrainObservation): Promise<DrainTurnOutcome> {
        const snapshots = await this.#repository.discoverPublishers({
            consumerStreamId: this.#consumerStreamId
        });
        if (snapshots.length === 0) {
            return 'caught-up';
        }
        observation.maxLagEntries = Math.max(
            ...snapshots.map((snapshot) => snapshot.headSequence - snapshot.lastProcessedSequence)
        );
        const ordered = rotateRtcTopologyReplayPublishers(snapshots, this.#rotation);
        this.#rotation = (this.#rotation + 1) % snapshots.length;
        let candidates = ordered.map((snapshot) => snapshot.publisherStreamId);
        let pageCount = 0;
        let entryCount = 0;
        let failed = false;

        while (candidates.length > 0 && !this.#stopped) {
            const nextRound: string[] = [];
            for (let index = 0; index < candidates.length; index += 1) {
                if (
                    pageCount >= this.#policy.maxPagesPerTurn ||
                    entryCount >= this.#policy.maxEntriesPerTurn
                ) {
                    nextRound.push(...candidates.slice(index));
                    break;
                }
                const result = await this.#repository.capturePage({
                    consumerStreamId: this.#consumerStreamId,
                    publisherStreamId: candidates[index]!,
                    pageSize: this.#policy.pageSize
                });
                if (result.status === 'caught-up') {
                    continue;
                }
                pageCount += 1;
                if (result.status === 'page') {
                    entryCount += result.entries.length;
                }
                observation.pageCount = pageCount;
                observation.entryCount = entryCount;
                const outcome = await this.#handlePublisherPage(result, candidates[index]!);
                if (outcome === 'more') {
                    nextRound.push(candidates[index]!);
                }
                if (outcome === 'failed') {
                    failed = true;
                }
            }
            candidates = nextRound;
            if (
                pageCount >= this.#policy.maxPagesPerTurn ||
                entryCount >= this.#policy.maxEntriesPerTurn
            ) {
                break;
            }
        }
        if (candidates.length > 0) {
            return 'more';
        }
        return failed ? 'failed' : 'caught-up';
    }

    async #handlePublisherPage(
        result: Exclude<RtcTopologyReplayPageResult, Readonly<{ status: 'caught-up'; }>>,
        publisherStreamId: string
    ): Promise<PublisherPageOutcome> {
        if (result.status === 'gap') {
            this.#diagnostics?.({ kind: 'cursor', outcome: 'gap' });
            return await this.#hydrateAndAdvanceGap(
                publisherStreamId,
                result.cursorSequence,
                result.capturedHeadSequence
            );
        }

        let lastHandledSequence = result.expectedCursorSequence;
        for (const entry of result.entries) {
            let handled: RtcTopologyReplayEntryHandlingResult;
            try {
                handled = await this.#entryHandler.handle(
                    entry,
                    result.databaseNowEpochMs,
                    this.#abort.signal
                );
            }
            catch (error) {
                if (error instanceof RtcTopologyDeliveryLeaseLostError) {
                    throw error;
                }
                if (error instanceof RtcTopologyDeliveryCorruptionError) {
                    this.#diagnostics?.({ kind: 'entry', outcome: 'corrupt' });
                }
                await this.#advanceSuccessfulPredecessor(
                    publisherStreamId,
                    result.expectedCursorSequence,
                    lastHandledSequence
                );
                return 'failed';
            }
            if (handled.status !== 'gap') {
                this.#diagnostics?.({ kind: 'entry', outcome: handled.status });
            }
            if (handled.status === 'send-failed') {
                await this.#advanceSuccessfulPredecessor(
                    publisherStreamId,
                    result.expectedCursorSequence,
                    lastHandledSequence
                );
                return 'failed';
            }
            if (handled.status === 'gap') {
                this.#diagnostics?.({ kind: 'cursor', outcome: 'gap' });
                const advanced = await this.#advanceSuccessfulPredecessor(
                    publisherStreamId,
                    result.expectedCursorSequence,
                    lastHandledSequence
                );
                if (!advanced) {
                    return 'failed';
                }
                return await this.#hydrateAndAdvanceGap(
                    publisherStreamId,
                    lastHandledSequence,
                    result.capturedHeadSequence
                );
            }
            lastHandledSequence = entry.sequence;
        }

        const advanced = await this.#advanceSuccessfulPredecessor(
            publisherStreamId,
            result.expectedCursorSequence,
            lastHandledSequence
        );
        if (!advanced) {
            return 'failed';
        }
        return result.hasMore ? 'more' : 'done';
    }

    async #hydrateAndAdvanceGap(
        publisherStreamId: string,
        expectedSequence: number,
        capturedHeadSequence: number
    ): Promise<PublisherPageOutcome> {
        await this.#hydrateGap(this.#abort.signal);
        if (capturedHeadSequence === expectedSequence) {
            return 'done';
        }
        const advanced = await this.#repository.compareAndSetCursor({
            consumerStreamId: this.#consumerStreamId,
            publisherStreamId,
            expectedSequence,
            nextSequence: capturedHeadSequence
        });
        return this.#cursorAdvanced(advanced) ? 'done' : 'failed';
    }

    async #advanceSuccessfulPredecessor(
        publisherStreamId: string,
        expectedSequence: number,
        lastHandledSequence: number
    ): Promise<boolean> {
        if (lastHandledSequence === expectedSequence) {
            return true;
        }
        const advanced = await this.#repository.compareAndSetCursor({
            consumerStreamId: this.#consumerStreamId,
            publisherStreamId,
            expectedSequence,
            nextSequence: lastHandledSequence
        });
        return this.#cursorAdvanced(advanced);
    }

    #cursorAdvanced(result: RtcTopologyReplayCursorCasResult): boolean {
        if (result.status === 'advanced') {
            this.#diagnostics?.({ kind: 'cursor', outcome: 'advanced' });
            return true;
        }
        if (result.status === 'conflict') {
            this.#diagnostics?.({ kind: 'cursor', outcome: 'conflict' });
            return false;
        }
        this.#diagnostics?.({ kind: 'entry', outcome: 'corrupt' });
        throw new RtcTopologyDeliveryCorruptionError(
            `RTC topology replay consumer ${this.#consumerStreamId} lost a durable cursor`
        );
    }

    #recordDrain(
        outcome: 'caught-up' | 'yielded' | 'failed' | 'lease-lost',
        durationMs: number,
        observation: MutableDrainObservation
    ): void {
        this.#diagnostics?.({
            kind: 'drain',
            outcome,
            durationMs,
            pageCount: observation.pageCount,
            entryCount: observation.entryCount,
            maxLagEntries: observation.maxLagEntries
        });
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
