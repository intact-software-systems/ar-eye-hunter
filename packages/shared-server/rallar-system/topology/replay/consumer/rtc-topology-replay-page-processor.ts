import { RtcTopologyDeliveryLeaseLostError } from '../delivery/rtc-topology-delivery-stream-service.ts';
import { RtcTopologyDeliveryCorruptionError } from '../delivery/rtc-topology-delivery-validation.ts';
import type {
    RtcTopologyReplayCursorCasResult,
    RtcTopologyReplayEntryHandler,
    RtcTopologyReplayPageResult,
    RtcTopologyReplayPort
} from './rtc-topology-replay-contracts.ts';
import type { RtcTopologyReplayDiagnosticsSink } from './rtc-topology-replay-diagnostics.ts';

export type RtcTopologyReplayPublisherPageOutcome = 'done' | 'more' | 'failed';

export namespace RtcTopologyReplayPageProcessor {
    export interface Dependencies {
        readonly consumerStreamId: string;
        readonly repository: Pick<RtcTopologyReplayPort, 'compareAndSetCursor'>;
        readonly entryHandler: RtcTopologyReplayEntryHandler;
        readonly hydrateGap: (signal: AbortSignal) => Promise<void>;
        readonly diagnostics?: RtcTopologyReplayDiagnosticsSink;
    }

    export interface Input {
        readonly result: Exclude<RtcTopologyReplayPageResult, Readonly<{ status: 'caught-up'; }>>;
        readonly publisherStreamId: string;
        readonly signal: AbortSignal;
    }
}

export class RtcTopologyReplayPageProcessor {
    readonly #consumerStreamId: string;
    readonly #repository: Pick<RtcTopologyReplayPort, 'compareAndSetCursor'>;
    readonly #entryHandler: RtcTopologyReplayEntryHandler;
    readonly #hydrateGap: (signal: AbortSignal) => Promise<void>;
    readonly #diagnostics: RtcTopologyReplayDiagnosticsSink | undefined;

    constructor(dependencies: RtcTopologyReplayPageProcessor.Dependencies) {
        this.#consumerStreamId = dependencies.consumerStreamId;
        this.#repository = dependencies.repository;
        this.#entryHandler = dependencies.entryHandler;
        this.#hydrateGap = dependencies.hydrateGap;
        this.#diagnostics = dependencies.diagnostics;
    }

    async process(
        input: RtcTopologyReplayPageProcessor.Input
    ): Promise<RtcTopologyReplayPublisherPageOutcome> {
        const { result, publisherStreamId, signal } = input;
        if (result.status === 'gap') {
            this.#diagnostics?.({ kind: 'cursor', outcome: 'gap' });
            return await this.#hydrateAndAdvanceGap({
                publisherStreamId,
                expectedSequence: result.cursorSequence,
                capturedHeadSequence: result.capturedHeadSequence,
                signal
            });
        }

        let lastHandledSequence = result.expectedCursorSequence;
        for (const entry of result.entries) {
            try {
                const handled = await this.#entryHandler.handle(
                    entry,
                    result.databaseNowEpochMs,
                    signal
                );
                if (handled.status !== 'gap') {
                    this.#diagnostics?.({ kind: 'entry', outcome: handled.status });
                }
                if (handled.status === 'send-failed') {
                    await this.#advanceSuccessfulPredecessor({
                        publisherStreamId,
                        expectedSequence: result.expectedCursorSequence,
                        lastHandledSequence
                    });
                    return 'failed';
                }
                if (handled.status === 'gap') {
                    return await this.#processEntryGap({
                        publisherStreamId,
                        expectedSequence: result.expectedCursorSequence,
                        lastHandledSequence,
                        capturedHeadSequence: result.capturedHeadSequence,
                        signal
                    });
                }
                lastHandledSequence = entry.sequence;
            }
            catch (error) {
                if (error instanceof RtcTopologyDeliveryLeaseLostError) {
                    throw error;
                }
                if (error instanceof RtcTopologyDeliveryCorruptionError) {
                    this.#diagnostics?.({ kind: 'entry', outcome: 'corrupt' });
                }
                await this.#advanceSuccessfulPredecessor({
                    publisherStreamId,
                    expectedSequence: result.expectedCursorSequence,
                    lastHandledSequence
                });
                return 'failed';
            }
        }

        const advanced = await this.#advanceSuccessfulPredecessor({
            publisherStreamId,
            expectedSequence: result.expectedCursorSequence,
            lastHandledSequence
        });
        if (!advanced) {
            return 'failed';
        }
        return result.hasMore ? 'more' : 'done';
    }

    async #processEntryGap(
        input: Readonly<{
            publisherStreamId: string;
            expectedSequence: number;
            lastHandledSequence: number;
            capturedHeadSequence: number;
            signal: AbortSignal;
        }>
    ): Promise<RtcTopologyReplayPublisherPageOutcome> {
        this.#diagnostics?.({ kind: 'cursor', outcome: 'gap' });
        const advanced = await this.#advanceSuccessfulPredecessor(input);
        if (!advanced) {
            return 'failed';
        }
        return await this.#hydrateAndAdvanceGap({
            publisherStreamId: input.publisherStreamId,
            expectedSequence: input.lastHandledSequence,
            capturedHeadSequence: input.capturedHeadSequence,
            signal: input.signal
        });
    }

    async #hydrateAndAdvanceGap(
        input: Readonly<{
            publisherStreamId: string;
            expectedSequence: number;
            capturedHeadSequence: number;
            signal: AbortSignal;
        }>
    ): Promise<RtcTopologyReplayPublisherPageOutcome> {
        await this.#hydrateGap(input.signal);
        if (input.capturedHeadSequence === input.expectedSequence) {
            return 'done';
        }
        const advanced = await this.#repository.compareAndSetCursor({
            consumerStreamId: this.#consumerStreamId,
            publisherStreamId: input.publisherStreamId,
            expectedSequence: input.expectedSequence,
            nextSequence: input.capturedHeadSequence
        });
        return this.#cursorAdvanced(advanced) ? 'done' : 'failed';
    }

    async #advanceSuccessfulPredecessor(
        input: Readonly<{
            publisherStreamId: string;
            expectedSequence: number;
            lastHandledSequence: number;
        }>
    ): Promise<boolean> {
        if (input.lastHandledSequence === input.expectedSequence) {
            return true;
        }
        const advanced = await this.#repository.compareAndSetCursor({
            consumerStreamId: this.#consumerStreamId,
            publisherStreamId: input.publisherStreamId,
            expectedSequence: input.expectedSequence,
            nextSequence: input.lastHandledSequence
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
}
