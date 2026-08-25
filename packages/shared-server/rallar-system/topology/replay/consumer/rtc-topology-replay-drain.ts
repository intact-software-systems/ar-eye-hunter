import { RtcTopologyDeliveryLeaseLostError } from '../delivery/rtc-topology-delivery-stream-service.ts';
import type { RtcTopologyReplayPort, RtcTopologyReplayServicePolicy } from './rtc-topology-replay-contracts.ts';
import type { RtcTopologyReplayDiagnosticsSink } from './rtc-topology-replay-diagnostics.ts';
import { RtcTopologyReplayPageProcessor } from './rtc-topology-replay-page-processor.ts';
import { rotateRtcTopologyReplayPublishers } from './rtc-topology-replay-scheduler.ts';

export type RtcTopologyReplayDrainTurnOutcome = 'caught-up' | 'more' | 'failed';

interface MutableRtcTopologyReplayDrainObservation {
    pageCount: number;
    entryCount: number;
    maxLagEntries: number;
}

export namespace RtcTopologyReplayDrain {
    export interface Dependencies {
        readonly consumerStreamId: string;
        readonly repository: Pick<RtcTopologyReplayPort, 'discoverPublishers' | 'capturePage'>;
        readonly pageProcessor: RtcTopologyReplayPageProcessor;
        readonly policy: RtcTopologyReplayServicePolicy;
        readonly diagnostics?: RtcTopologyReplayDiagnosticsSink;
    }
}

export class RtcTopologyReplayDrain {
    readonly #consumerStreamId: string;
    readonly #repository: Pick<RtcTopologyReplayPort, 'discoverPublishers' | 'capturePage'>;
    readonly #pageProcessor: RtcTopologyReplayPageProcessor;
    readonly #policy: RtcTopologyReplayServicePolicy;
    readonly #diagnostics: RtcTopologyReplayDiagnosticsSink | undefined;
    #rotation = 0;

    constructor(dependencies: RtcTopologyReplayDrain.Dependencies) {
        this.#consumerStreamId = dependencies.consumerStreamId;
        this.#repository = dependencies.repository;
        this.#pageProcessor = dependencies.pageProcessor;
        this.#policy = dependencies.policy;
        this.#diagnostics = dependencies.diagnostics;
    }

    async runTurn(signal: AbortSignal): Promise<RtcTopologyReplayDrainTurnOutcome> {
        const startedAt = performance.now();
        const observation: MutableRtcTopologyReplayDrainObservation = {
            pageCount: 0,
            entryCount: 0,
            maxLagEntries: 0
        };
        try {
            const outcome = await this.#drainPublishers(observation, signal);
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

    async #drainPublishers(
        observation: MutableRtcTopologyReplayDrainObservation,
        signal: AbortSignal
    ): Promise<RtcTopologyReplayDrainTurnOutcome> {
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
        let candidates: readonly string[] = ordered.map((snapshot) => snapshot.publisherStreamId);
        let failed = false;

        while (candidates.length > 0 && !signal.aborted) {
            const round = await this.#drainPublisherRound(candidates, observation, signal);
            candidates = round.remainingPublisherStreamIds;
            failed ||= round.failed;
            if (this.#turnLimitReached(observation)) {
                break;
            }
        }
        if (candidates.length > 0) {
            return 'more';
        }
        return failed ? 'failed' : 'caught-up';
    }

    async #drainPublisherRound(
        publisherStreamIds: readonly string[],
        observation: MutableRtcTopologyReplayDrainObservation,
        signal: AbortSignal
    ): Promise<Readonly<{ remainingPublisherStreamIds: readonly string[]; failed: boolean; }>> {
        const remainingPublisherStreamIds: string[] = [];
        let failed = false;
        for (let index = 0; index < publisherStreamIds.length; index += 1) {
            if (this.#turnLimitReached(observation)) {
                remainingPublisherStreamIds.push(...publisherStreamIds.slice(index));
                break;
            }
            const publisherStreamId = publisherStreamIds[index]!;
            const result = await this.#repository.capturePage({
                consumerStreamId: this.#consumerStreamId,
                publisherStreamId,
                pageSize: this.#policy.pageSize
            });
            if (result.status === 'caught-up') {
                continue;
            }
            observation.pageCount += 1;
            if (result.status === 'page') {
                observation.entryCount += result.entries.length;
            }
            const outcome = await this.#pageProcessor.process({
                result,
                publisherStreamId,
                signal
            });
            if (outcome === 'more') {
                remainingPublisherStreamIds.push(publisherStreamId);
            }
            if (outcome === 'failed') {
                failed = true;
            }
        }
        return { remainingPublisherStreamIds, failed };
    }

    #turnLimitReached(observation: MutableRtcTopologyReplayDrainObservation): boolean {
        return (
            observation.pageCount >= this.#policy.maxPagesPerTurn ||
            observation.entryCount >= this.#policy.maxEntriesPerTurn
        );
    }

    #recordDrain(
        outcome: 'caught-up' | 'yielded' | 'failed' | 'lease-lost',
        durationMs: number,
        observation: MutableRtcTopologyReplayDrainObservation
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
}
