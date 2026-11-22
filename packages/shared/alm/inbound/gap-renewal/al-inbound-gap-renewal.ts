import type { ALOrderingObservation, ALOrderingTrackSnapshot, ALSeqRange } from '../../../al-contracts/al-runtime.ts';
import type { ALWorkOutcome, ALWorkQueuePort } from '../../work/al-work-queue-port.ts';
import type { ALInboundAdmissionStore, ALInboundGapRenewalEffect } from '../al-inbound-admission-store.ts';
import type { ALInboundEffectIntent } from '../al-inbound-effect-intent.ts';
import type { ALInboundMessageRuntime } from '../al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsSink } from '../al-inbound-runtime-diagnostics.ts';
import {
    computeALInboundWorkEntry,
    toALInboundEffectId,
    type ALInboundDurableEffectWrite,
    type ALPersistedInboundEffect
} from '../al-inbound-work-entry.ts';
import {
    prepareALInboundDurableEffect,
    readALInboundEffectFacts,
    type ALInboundEffectFacts,
    type ALInboundEffectPreparationDependencies
} from '../prepare-al-inbound-commit-bundle.ts';
import {
    signALInboundReceiptEffects,
    type ALInboundReceiptProofs
} from '../receipt-proof/sign-al-inbound-receipt-controls.ts';
import {
    computeALGapRenewalDelayMs,
    computeALInboundStillMissingRanges,
    toALInboundGapRenewalEffectId,
    toALInboundWorkEntryDueAt
} from './compute-al-inbound-gap-renewal.ts';

export namespace ALInboundGapRenewal {
    export interface Dependencies {
        readonly admissionStore: Pick<
            ALInboundAdmissionStore,
            'namespace' | 'readOrderingSnapshot' | 'readDeliverySurface'
        >;
        readonly workPort: Pick<ALWorkQueuePort, 'retainIfAbsent'>;
        readonly clock: ALInboundMessageRuntime.Clock;
        readonly effectPreparation: ALInboundEffectPreparationDependencies;
        /** The factor this lane stretches every renewal interval by, drawn once when the lane was built. */
        readonly stretch: number;
        readonly receiptProofs: ALInboundReceiptProofs;
        readonly diagnostics: ALInboundRuntimeDiagnosticsSink | undefined;
        readonly readUpstreamPeerId: ALInboundMessageRuntime.Dependencies['readUpstreamPeerId'];
        readonly isRoutedPeerReady?: ALInboundMessageRuntime.Dependencies['isRoutedPeerReady'];
    }

    export interface Result {
        readonly outcome: ALWorkOutcome;
        /** Rows were retained behind the page the claiming batch read, or found there from a run a lease recovery repeats. */
        readonly wroteWork: boolean;
    }
}

/** What one run of a timer writes, before the counted recipient's NACK is signed. */
interface ALInboundGapRenewalRun {
    readonly effect: ALPersistedInboundEffect;
    readonly payload: ALInboundGapRenewalEffect;
    readonly position: ALOrderingTrackSnapshot;
    readonly missingRanges: readonly ALSeqRange[];
    readonly facts: ALInboundEffectFacts;
    /** The peer this run asks: the one the timer records while it is still routed over, else the upstream peer now. */
    readonly toPeerId: string;
}

const NOTHING_RENEWED: ALInboundGapRenewal.Result = { outcome: { status: 'completed' }, wroteWork: false };

/**
 * Runs one `renew-gap` timer. While some of its range is still missing it asks again, under the timer's number, for
 * exactly that, and arms the next number's timer; once nothing is missing, or the track is gone, it ends and writes
 * nothing. Every row has a fixed id, so a run that a lease recovery repeats finds what the first run wrote.
 */
export class ALInboundGapRenewal {
    private readonly dependencies: ALInboundGapRenewal.Dependencies;

    constructor(dependencies: ALInboundGapRenewal.Dependencies) {
        this.dependencies = dependencies;
    }

    async renew(
        effect: ALPersistedInboundEffect,
        payload: ALInboundGapRenewalEffect
    ): Promise<ALInboundGapRenewal.Result> {
        const { admissionStore, clock, effectPreparation, workPort, receiptProofs, diagnostics } = this.dependencies;
        const nowMs = clock.nowMs();
        const position = await admissionStore.readOrderingSnapshot(payload.trackKey, nowMs);
        const missingRanges = computeALInboundStillMissingRanges(payload.range, position);
        if (position === undefined || missingRanges.length === 0 || effect.expireAtTimestamp <= nowMs) {
            return NOTHING_RENEWED;
        }
        const facts = readALInboundEffectFacts(nowMs, effectPreparation);
        const toPeerId = await this.resolveRenewalPeerId(payload, nowMs);
        const rows = await signALInboundReceiptEffects(
            this.computeRenewalWrites({ effect, payload, position, missingRanges, facts, toPeerId }),
            { namespace: admissionStore.namespace, receiptProofs, diagnostics }
        );
        for (const row of rows) {
            await workPort.retainIfAbsent(row.entry);
        }
        return { outcome: { status: 'completed' }, wroteWork: rows.length > 0 };
    }

    /**
     * The recorded peer while this lane still routes over it, so a reshape's overlap asks the relay that still forwards;
     * once it is gone the track's upstream peer, and with none resolvable the recorded peer again.
     */
    private async resolveRenewalPeerId(payload: ALInboundGapRenewalEffect, nowMs: number): Promise<string> {
        const { admissionStore, isRoutedPeerReady, readUpstreamPeerId } = this.dependencies;
        const surface = await admissionStore.readDeliverySurface(payload.message, nowMs);
        if (surface === undefined || isRoutedPeerReady?.(surface.msg, payload.toPeerId) === true) {
            return payload.toPeerId;
        }
        return readUpstreamPeerId(surface.msg) ?? payload.toPeerId;
    }

    /** The NACK and the repair request, built as an admission builds its own, and the next number's timer. */
    private computeRenewalWrites(run: ALInboundGapRenewalRun): readonly ALInboundDurableEffectWrite[] {
        const { payload, facts } = run;
        const nextDelayMs = computeALGapRenewalDelayMs(payload.requestNumber + 1, this.dependencies.stretch);
        const successor: ALInboundGapRenewalEffect = { ...payload, requestNumber: payload.requestNumber + 1 };
        return [
            this.computeControlWrite(run, 'nack', 0),
            this.computeControlWrite(run, 'repair', 1),
            ...(nextDelayMs === undefined ? [] : [
                toALInboundWorkEntryDueAt(
                    this.computeWrite(run, toALInboundGapRenewalEffectId(successor), successor, false),
                    facts.observedAtEpochMs + nextDelayMs
                )
            ])
        ];
    }

    private computeControlWrite(
        run: ALInboundGapRenewalRun,
        type: 'nack' | 'repair',
        index: number
    ): ALInboundDurableEffectWrite {
        const { effect, payload, facts, toPeerId } = run;
        const { message, range, requestNumber } = payload;
        const control = prepareALInboundDurableEffect({
            payload: toRenewalIntent(run, type),
            facts,
            traceId: payload.traceId,
            originPeerId: message.senderId,
            index,
            carrier: effect.carrier
        });
        const effectId = toALInboundEffectId([
            type,
            message.senderId,
            message.msgId,
            toPeerId,
            'renewal',
            range.from,
            range.to,
            requestNumber
        ]);
        return this.computeWrite(run, effectId, control, type === 'nack' && payload.signsForRecipient);
    }

    private computeWrite(
        run: ALInboundGapRenewalRun,
        effectId: string,
        payload: ALInboundDurableEffectWrite['payload'],
        signsForRecipient: boolean
    ): ALInboundDurableEffectWrite {
        return computeALInboundWorkEntry({
            namespace: this.dependencies.admissionStore.namespace,
            effectId,
            payload,
            observedAtMs: run.facts.observedAtEpochMs,
            expireAtTimestamp: run.effect.expireAtTimestamp,
            carrier: run.effect.carrier,
            signsForRecipient
        });
    }
}

/** A renewal names the arrival the timer records, the track's next expected sequence and only what is missing. */
function toRenewalIntent(run: ALInboundGapRenewalRun, type: 'nack' | 'repair'): ALInboundEffectIntent['payload'] {
    const { payload, position, missingRanges, toPeerId } = run;
    const ordering: ALOrderingObservation = {
        status: 'gap',
        trackKey: payload.trackKey,
        expectedSeq: position.lastContiguousSeq + 1,
        lastContiguousSeq: position.lastContiguousSeq,
        missingRanges,
        releasableSeqs: []
    };
    const request = {
        toPeerId,
        msgId: payload.message.msgId,
        ordering,
        gapRequestNumber: payload.requestNumber
    };
    return type === 'nack'
        ? { kind: 'send-nack', reason: 'gap', ...request }
        : { kind: 'send-repair', reason: 'missing-seq', ...request };
}
