import type { ALOrderingObservation, ALOrderingTrackSnapshot, ALSeqRange } from '../../../al-contracts/al-runtime.ts';
import type { ALWorkOutcome, ALWorkQueuePort } from '../../work/al-work-queue-port.ts';
import type { ALOrderingObserver } from '../admission/resolve-al-ordering-observer-role.ts';
import type {
    ALInboundAdmissionStore,
    ALInboundGapRenewalEffect,
    ALInboundPlanner
} from '../al-inbound-admission-store.ts';
import type { ALInboundEffectIntent } from '../al-inbound-effect-intent.ts';
import type { ALInboundMessageRuntime } from '../al-inbound-message-runtime.ts';
import {
    computeALInboundHeldOrderingEntry,
    computeALInboundStoredPlanningObservations
} from '../al-inbound-planner-snapshot.ts';
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
import { computeALInboundHeldTrackEntry, computeALInboundPassedTrack } from './compute-al-inbound-held-track-entry.ts';

export namespace ALInboundGapRenewal {
    export interface Dependencies {
        readonly admissionStore: Pick<
            ALInboundAdmissionStore,
            'namespace' | 'readOrderingSnapshot' | 'readDeliverySurface' | 'readIncomingMessage' | 'commitBundle'
        >;
        /** Which tracks the runtime observes, as its admissions read them. */
        readonly orderingObserver: ALOrderingObserver;
        /** Plans a bounded hold's lowest copy as the copy it enters at, as the runtime plans every admission. */
        readonly planIncomingMessage: ALInboundPlanner;
        readonly workPort: Pick<ALWorkQueuePort, 'retainIfAbsent'>;
        readonly clock: ALInboundMessageRuntime.Clock;
        readonly effectPreparation: ALInboundEffectPreparationDependencies;
        /** The factor this lane stretches every renewal interval by, drawn once when the lane was built. */
        readonly stretch: number;
        readonly receiptProofs: ALInboundReceiptProofs;
        readonly diagnostics: ALInboundRuntimeDiagnosticsSink | undefined;
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
}

const NOTHING_RENEWED: ALInboundGapRenewal.Result = { outcome: { status: 'completed' }, wroteWork: false };
const HELD_ENTRY_RETRIED: ALInboundGapRenewal.Result = { outcome: { status: 'retry' }, wroteWork: false };

/**
 * Runs one `renew-gap` timer. While some of its range is still missing it asks again, under the timer's number, for
 * exactly that, and arms the next number's timer; once nothing is missing, or the track is gone, it ends and writes
 * nothing. The last timer of a held start range ends the bounded hold instead of asking, on a track that delivered
 * nothing, since the request before it went unanswered for its whole interval; an end that does not commit for an
 * expired copy leaves the request to go out as before. Every row has a fixed id, so a run that a lease recovery repeats finds what the first run wrote.
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
        const lastTimer =
            computeALGapRenewalDelayMs(payload.requestNumber + 1, this.dependencies.stretch) === undefined;
        if (lastTimer && position.lastContiguousSeq === 0) {
            const ended = await this.endHold(payload, facts);
            if (ended !== undefined) {
                return ended;
            }
        }
        const rows = await signALInboundReceiptEffects(
            this.computeRenewalWrites({ effect, payload, position, missingRanges, facts }),
            { namespace: admissionStore.namespace, receiptProofs, diagnostics }
        );
        for (const row of rows) {
            await workPort.retainIfAbsent(row.entry);
        }
        return { outcome: { status: 'completed' }, wroteWork: rows.length > 0 };
    }

    /**
     * Reads the copy that revealed the range, planned as it was admitted, with the track's live copies, and commits the
     * bounded hold's end there. `undefined` when the track keeps today's behaviour or the end could not commit for an
     * expired copy, so the last request goes out as before.
     */
    private async endHold(
        payload: ALInboundGapRenewalEffect,
        facts: ALInboundEffectFacts
    ): Promise<ALInboundGapRenewal.Result | undefined> {
        const { admissionStore, effectPreparation, orderingObserver, planIncomingMessage } = this.dependencies;
        const nowMs = facts.observedAtEpochMs;
        const revealing = await admissionStore.readDeliverySurface(payload.message, nowMs);
        if (revealing === undefined) {
            return undefined;
        }
        const read = await admissionStore.readIncomingMessage({
            msg: revealing.msg,
            source: revealing.source,
            nowMs,
            prePlan: planIncomingMessage(
                revealing.msg,
                revealing.source,
                computeALInboundStoredPlanningObservations(revealing)
            ),
            selfPeerId: effectPreparation.selfPeerId,
            orderingObserver
        });
        const entry = computeALInboundHeldOrderingEntry(read, payload.range);
        if (entry === undefined) {
            return undefined;
        }
        const status = await admissionStore.commitBundle(
            entry.kind === 'passed' ? computeALInboundPassedTrack(read, entry) : computeALInboundHeldTrackEntry({
                read,
                entry,
                plan: planIncomingMessage(entry.msg, read.source, { nowMs, orderingObservation: entry.observation }),
                facts
            })
        );
        if (status === 'conflict') {
            return HELD_ENTRY_RETRIED;
        }
        return status === 'committed' ? { outcome: { status: 'completed' }, wroteWork: true } : undefined;
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
        const { effect, payload, facts } = run;
        const { message, toPeerId, range, requestNumber } = payload;
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
    const { payload, position, missingRanges } = run;
    const ordering: ALOrderingObservation = {
        status: 'gap',
        trackKey: payload.trackKey,
        expectedSeq: position.lastContiguousSeq + 1,
        lastContiguousSeq: position.lastContiguousSeq,
        missingRanges,
        releasableSeqs: []
    };
    const request = {
        toPeerId: payload.toPeerId,
        msgId: payload.message.msgId,
        ordering,
        gapRequestNumber: payload.requestNumber
    };
    return type === 'nack'
        ? { kind: 'send-nack', reason: 'gap', ...request }
        : { kind: 'send-repair', reason: 'missing-seq', ...request };
}
