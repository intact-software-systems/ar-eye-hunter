import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALOrderingObservation, ALOrderingTrackSnapshot, ALSeqRange } from '../../../al-contracts/al-runtime.ts';
import type { ALWorkOutcome, ALWorkQueuePort } from '../../work/al-work-queue-port.ts';
import { recordALInboundOrderingPosition } from '../admission/record-al-inbound-ordering-position.ts';
import type { ALOrderingObserver } from '../admission/resolve-al-ordering-observer-role.ts';
import type {
    ALInboundAdmissionStore,
    ALInboundCommitBundle,
    ALInboundGapRenewalEffect,
    ALInboundOrderingTrackRead,
    ALInboundPlanner
} from '../al-inbound-admission-store.ts';
import { toALInboundMessageReference } from '../al-inbound-canonical-message.ts';
import { shouldRetryALInboundDelivery, type ALInboundEffectIntent } from '../al-inbound-effect-intent.ts';
import type { ALInboundMessageRuntime } from '../al-inbound-message-runtime.ts';
import { computeALInboundStoredPlanningObservations } from '../al-inbound-planner-snapshot.ts';
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
import { computeALOrderingHeldEntry, type ALOrderingHeldEntry } from './compute-al-ordering-held-entry.ts';

export namespace ALInboundGapRenewal {
    export interface Dependencies {
        readonly admissionStore: Pick<
            ALInboundAdmissionStore,
            | 'namespace'
            | 'readOrderingSnapshot'
            | 'readOrderingTrack'
            | 'readDeliverySurface'
            | 'readIncomingMessage'
            | 'commitBundle'
        >;
        /** Which tracks the runtime observes, as its admissions read them. */
        readonly orderingObserver: ALOrderingObserver;
        /** Plans a bounded hold's lowest copy as the copy it enters at, as the runtime plans every admission. */
        readonly planIncomingMessage: ALInboundPlanner;
        /** Awaited on the copy before it is planned, as the runtime verifies every message object it plans; absent as there. */
        readonly verifyPublicationProof?: ALInboundMessageRuntime.Dependencies['verifyPublicationProof'];
        readonly workPort: Pick<ALWorkQueuePort, 'retainIfAbsent'>;
        readonly clock: ALInboundMessageRuntime.Clock;
        readonly effectPreparation: ALInboundEffectPreparationDependencies;
        /** The factor this lane stretches every renewal interval by, drawn once when the lane was built. */
        readonly stretch: number;
        readonly receiptProofs: ALInboundReceiptProofs;
        readonly diagnostics: ALInboundRuntimeDiagnosticsSink | undefined;
        /** The lane's worker id, named on the position event a hold's end states. */
        readonly effectWorkerId: string;
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
const HELD_END_COMMITTED: ALInboundGapRenewal.Result = { outcome: { status: 'completed' }, wroteWork: true };

/**
 * Runs one `renew-gap` timer. While some of its range is still missing it asks again, under the timer's number, for
 * exactly that, and arms the next number's timer; once nothing is missing, or the track is gone, it ends and writes
 * nothing. The last timer of a held start range ends the bounded hold instead of asking, on a track that delivered
 * nothing, since the request before it went unanswered for its whole interval; it reads the track by its key, not the
 * copy the timer names, which is retained only for its own lifetime. An end that does not commit runs again. Every row
 * has a fixed id, so a run that a lease recovery repeats finds what the first run wrote.
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
        if (lastTimer && payload.heldStart && position.lastContiguousSeq === 0) {
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
     * Ends the bounded hold from the track alone, read by its key: with no live copy the track passes its buffered
     * sequences; otherwise the end reads the lowest live copy's admission surface and enters there. A commit refused as
     * a conflict or for an expired copy runs the timer again. `undefined` when the track keeps today's behaviour, so the
     * last request goes out as before.
     */
    private async endHold(
        payload: ALInboundGapRenewalEffect,
        facts: ALInboundEffectFacts
    ): Promise<ALInboundGapRenewal.Result | undefined> {
        const { trackKey, message } = payload;
        const track = await this.dependencies.admissionStore.readOrderingTrack({
            trackKey,
            message,
            nowMs: facts.observedAtEpochMs
        });
        const [lowest] = track.observations.ordering?.buffered ?? [];
        if (lowest !== undefined) {
            return await this.enterHeldTrack(payload, lowest.msg, facts);
        }
        const entry = this.computeHeldEntry(payload, track);
        return entry?.kind === 'passed'
            ? await this.commitHoldEnd(computeALInboundPassedTrack(track, entry))
            : undefined;
    }

    /**
     * Reads the lowest live copy, planned as it was admitted, with the track's live copies, and enters there, stating
     * that copy's `ordering-position` after the commit as an entered admission states its own.
     */
    private async enterHeldTrack(
        payload: ALInboundGapRenewalEffect,
        lowest: ALMessage,
        facts: ALInboundEffectFacts
    ): Promise<ALInboundGapRenewal.Result | undefined> {
        const { admissionStore, effectPreparation, orderingObserver, planIncomingMessage } = this.dependencies;
        const nowMs = facts.observedAtEpochMs;
        const surface = await admissionStore.readDeliverySurface(toALInboundMessageReference(lowest), nowMs);
        if (surface === undefined) {
            return HELD_ENTRY_RETRIED;
        }
        // A carrier that signs its copies reads the proof verdict of the very object it plans; every plan below is of it.
        await this.dependencies.verifyPublicationProof?.(surface.msg);
        const read = await admissionStore.readIncomingMessage({
            msg: surface.msg,
            source: surface.source,
            nowMs,
            prePlan: planIncomingMessage(
                surface.msg,
                surface.source,
                computeALInboundStoredPlanningObservations(surface)
            ),
            selfPeerId: effectPreparation.selfPeerId,
            orderingObserver
        });
        const entry = this.computeHeldEntry(payload, read);
        // The commit is guarded by this copy's read: a lower copy buffered since the track's read waits for the next run.
        if (entry?.kind !== 'entered' || entry.msg.id.msgId !== surface.msg.id.msgId) {
            return entry === undefined ? undefined : HELD_ENTRY_RETRIED;
        }
        const plan = planIncomingMessage(surface.msg, read.source, { nowMs, orderingObservation: entry.observation });
        // As an admission writes no position for a dropped plan, a copy the end may not deliver commits nothing.
        const dropped = [read.prePlan, plan].find((candidate) => candidate.dropReason !== undefined);
        if (dropped !== undefined) {
            return shouldRetryALInboundDelivery(dropped) ? HELD_ENTRY_RETRIED : undefined;
        }
        const held = computeALInboundHeldTrackEntry({ read, entry, plan, facts });
        const ended = await this.commitHoldEnd(held.bundle);
        if (ended === HELD_END_COMMITTED) {
            recordALInboundOrderingPosition(this.dependencies.diagnostics, {
                workerId: this.dependencies.effectWorkerId,
                ...held.entered
            });
        }
        return ended;
    }

    /** The one held-entry rule, over the track as a read found it. */
    private computeHeldEntry(
        payload: ALInboundGapRenewalEffect,
        read: ALInboundOrderingTrackRead
    ): ALOrderingHeldEntry | undefined {
        const ordering = read.observations.ordering;
        return computeALOrderingHeldEntry({
            trackKey: payload.trackKey,
            heldStart: payload.heldStart,
            selfPeerId: this.dependencies.effectPreparation.selfPeerId,
            snapshot: ordering?.snapshot,
            live: ordering?.buffered.map((buffered) => buffered.msg) ?? [],
            nowMs: read.nowMs,
            trackTtlMs: read.orderingTrackTtlMs
        });
    }

    /** A copy that expired between the read and the commit is no longer live when the timer runs again. */
    private async commitHoldEnd(bundle: ALInboundCommitBundle): Promise<ALInboundGapRenewal.Result> {
        const status = await this.dependencies.admissionStore.commitBundle(bundle);
        return status === 'committed' ? HELD_END_COMMITTED : HELD_ENTRY_RETRIED;
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
