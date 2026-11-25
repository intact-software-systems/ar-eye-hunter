import { LatestRepository } from '../../../cache/LatestRepository.ts';
import { IndexedDbQueueWriteConflictError } from '../../../queuebox/indexed-db-queue-write-conflict-error.ts';
import { EntityStatus, toKeyAsString, type ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
import { ExclusionKeyedAdmission } from '../../../resilience/exclusion-keyed-admission.ts';
import { RetryableConflictError } from '../../../resilience/try-with-policy.ts';
import { DEFAULT_AL_REPOSITORY_TTL_MS } from '../../ALStoreRetention.ts';
import type { ALWorkAttemptResult } from '../../work/al-work-handler.ts';
import type { ALWorkClaim, ALWorkOutcome, ALWorkQueuePort } from '../../work/al-work-queue-port.ts';
import { AL_WORK_UNDESCRIBED_COMMIT, type ALWorkCommittedRows } from '../../work/al-work-readiness-memory.ts';
import type { ALOutboundAdmissionStore, ALOutboundDurableEffect } from '../admission/al-outbound-admission-store.ts';
import { toALOutboundMessageReference } from '../al-outbound-canonical-message.ts';
import { toALOutboundPendingAdmissionId } from '../al-outbound-pending-admission.ts';
import {
    computeALOutboundWorkEntry,
    isPendingALOutboundWork,
    resolveALOutboundWorkReadyAt,
    toALOutboundWorkKey
} from '../al-outbound-work-entry.ts';
import type { ALOutboundComputedDto } from '../compute-al-outbound-dispatch.ts';
import type { ALOutboundEndedReason } from '../lane/al-outbound-send-controls.ts';
import { toALOutboundEndMessageEffectId } from '../to-al-outbound-effect-id.ts';
import { writeALOutboundMessageEnd, type ALOutboundMessageEndOutcome } from './write-al-outbound-message-end.ts';

export namespace ALOutboundLaneMessageEnd {
    export interface Input<TPrepared> {
        readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
        /** The lane's own work port: the retained admission is completed and the end is retained through it. */
        readonly workPort: ALWorkQueuePort;
        readonly nowMs: () => number;
        /** Announces the work rows an end wrote, as the lane announces a commit's. */
        readonly announce: (rows: ALWorkCommittedRows) => void;
    }

    /** An admission this page retained as `admit-message` work, which a cancel of its message completes. */
    export interface RetainedAdmission {
        readonly effectId: string;
        readonly expiresAtMs: number;
    }

    /** The `end-message` effect: the message and the retained admission its run completes first. */
    export type EndMessage = Extract<ALOutboundDurableEffect<never>, { kind: 'end-message'; }>;

    /**
     * What the end did to its message's retained admission: there was none left, it completed it, or another claim or
     * the row's retry schedule held it until `readyAtMs`.
     */
    export type AdmissionEnd =
        | Readonly<{ kind: 'none' | 'completed'; }>
        | Readonly<{ kind: 'held'; readyAtMs: number; }>;
}

/**
 * Ends the messages a page cancelled or handed over, in one lane's store. An end whose commit conflicts, or whose
 * retained admission another claim holds, is retained as an `end-message` row that names that admission; the owner
 * of the session's work runs it in any tab, and the queue redelivers what it cannot finish yet (D750, D751). The
 * page's own ends of one message run one after another, so they never conflict with each other.
 */
export class ALOutboundLaneMessageEnd<TPrepared> {
    /** The `end-message` row is due before every other row, so a batch ends the message before it claims a copy. */
    private static readonly END_MESSAGE_DUE_AT_MS = 0;
    private static readonly NO_ADMISSION_END: ALOutboundLaneMessageEnd.AdmissionEnd = { kind: 'none' };
    private readonly input: ALOutboundLaneMessageEnd.Input<TPrepared>;
    private readonly writes = new ExclusionKeyedAdmission({
        maxConcurrent: Number.MAX_SAFE_INTEGER,
        keyedChainsFirst: false
    });
    /** Bounded as the send controls' ended ids are; it serves a cancel's first attempt only (D751). */
    private readonly retainedAdmissions = new LatestRepository<string, ALOutboundLaneMessageEnd.RetainedAdmission>({
        ttlMs: DEFAULT_AL_REPOSITORY_TTL_MS
    });

    constructor(input: ALOutboundLaneMessageEnd.Input<TPrepared>) {
        this.input = input;
    }

    /** An admission that answered `pending` left its `admit-message` row; the page remembers it for a cancel. */
    rememberRetainedAdmission(computed: ALOutboundComputedDto<TPrepared>): void {
        const [canonicalEntry] = computed.entries;
        if (computed.verdict.kind !== 'pending' || computed.msg === undefined || canonicalEntry === undefined) {
            return;
        }
        const reference = toALOutboundMessageReference(
            this.input.admissionStore.canonicalScope,
            canonicalEntry,
            computed.msg
        );
        this.retainedAdmissions.acceptAt({
            key: reference.msgId,
            value: { effectId: toALOutboundPendingAdmissionId(reference), expiresAtMs: reference.expiresAtMs },
            nowEpochMs: this.input.nowMs()
        });
    }

    /** A lane holds a message for its end when it stored the message or remembers its retained admission. */
    async holdsMessage(msgId: string): Promise<boolean> {
        return this.retainedAdmissions.readAt(msgId, this.input.nowMs()) !== undefined ||
            await this.input.admissionStore.hasSentMessageAdmission(msgId);
    }

    /** Ends the message, and announces the work rows the end wrote: a retained end, or a completed admission. */
    async end(msgId: string, endedReason: ALOutboundEndedReason): Promise<void> {
        const written = await this.writes.admit(msgId, async () => {
            const retained = this.retainedAdmissions.readAt(msgId, this.input.nowMs());
            const admissionEnd = await this.completeAdmission(retained?.effectId ?? null);
            if (admissionEnd.kind !== 'held') {
                this.retainedAdmissions.delete(msgId);
            }
            const outcome = await writeALOutboundMessageEnd(this.input.admissionStore, msgId, endedReason);
            const owed = toOwedEnd(outcome, admissionEnd, retained);
            if (owed !== undefined) {
                return await this.retainEnd(
                    { kind: 'end-message', msgId, endedReason, admissionEffectId: owed.admissionEffectId },
                    owed.expiresAtMs
                );
            }
            return admissionEnd.kind === 'completed' ? AL_WORK_UNDESCRIBED_COMMIT : undefined;
        });
        if (written !== undefined) {
            this.input.announce(written);
        }
    }

    /**
     * The `end-message` effect, in whichever tab owns the work: the admission it names first, then the stored row. An
     * admission a claim or its retry schedule still holds waits until it can be claimed; a conflict is redelivered.
     */
    async runEnd(end: ALOutboundLaneMessageEnd.EndMessage): Promise<ALWorkAttemptResult> {
        return await this.writes.admit(end.msgId, async (): Promise<ALWorkAttemptResult> => {
            const admissionEnd = await this.completeAdmission(end.admissionEffectId);
            if (admissionEnd.kind === 'held') {
                return { status: 'not-ready', readyAtMs: admissionEnd.readyAtMs };
            }
            const outcome = await writeALOutboundMessageEnd(this.input.admissionStore, end.msgId, end.endedReason);
            if (outcome.kind === 'conflict') {
                throw new RetryableConflictError('Outbound message end commit conflict');
            }
            return { status: 'completed' };
        });
    }

    /**
     * A retained admission's replay admits nothing while its message's end is retained: the end may have found the
     * admission held by this very batch, which reserved both rows before it ran either.
     */
    async runAdmissionUnlessEnding(msgId: string, admit: () => Promise<ALWorkOutcome>): Promise<ALWorkOutcome> {
        const end = await this.input.workPort.readEntry(
            toALOutboundWorkKey(this.input.admissionStore.namespace, toALOutboundEndMessageEffectId(msgId))
        );
        return end !== undefined && end.status !== EntityStatus.NON_RETRYABLE ? { status: 'completed' } : await admit();
    }

    /**
     * Completes the retained admission before the stored row's end, so a replay either finds its row completed and
     * admits nothing, or committed first and left the stored row that end marks. A row that is gone was replayed or
     * expired.
     */
    private async completeAdmission(effectId: string | null): Promise<ALOutboundLaneMessageEnd.AdmissionEnd> {
        if (effectId === null) {
            return ALOutboundLaneMessageEnd.NO_ADMISSION_END;
        }
        const { workPort } = this.input;
        const entry = await workPort.readEntry(toALOutboundWorkKey(this.input.admissionStore.namespace, effectId));
        if (entry === undefined || !isPendingALOutboundWork(entry)) {
            return ALOutboundLaneMessageEnd.NO_ADMISSION_END;
        }
        const claim = await this.claimAdmission(entry);
        if (claim === undefined) {
            return { kind: 'held', readyAtMs: resolveALOutboundWorkReadyAt(entry) };
        }
        await workPort.releaseAll([{ claim, outcome: { status: 'completed' } }]);
        return { kind: 'completed' };
    }

    /** A row another claim reserved first, reserves under this one, or that is not due yet, is not this end's to take. */
    private async claimAdmission(entry: ResourceEntry): Promise<ALWorkClaim | undefined> {
        try {
            return (await this.input.workPort.claimObserved([entry]))[0];
        }
        catch (error) {
            if (error instanceof IndexedDbQueueWriteConflictError) {
                return undefined;
            }
            throw error;
        }
    }

    /** Unfenced and written once: a second retain of the same end finds the first row and writes nothing. */
    private async retainEnd(
        end: ALOutboundLaneMessageEnd.EndMessage,
        expiresAtMs: number
    ): Promise<ALWorkCommittedRows> {
        const { workPort, admissionStore } = this.input;
        const effectId = toALOutboundEndMessageEffectId(end.msgId);
        await workPort.retainIfAbsent(computeALOutboundWorkEntry({
            namespace: admissionStore.namespace,
            effectId,
            payload: end,
            observedAtMs: this.input.nowMs(),
            retryAtMs: ALOutboundLaneMessageEnd.END_MESSAGE_DUE_AT_MS,
            expireAtTimestamp: expiresAtMs
        }));
        return {
            dueByMs: ALOutboundLaneMessageEnd.END_MESSAGE_DUE_AT_MS,
            writtenKeys: [toKeyAsString(toALOutboundWorkKey(admissionStore.namespace, effectId))]
        };
    }
}

/** An end still owed, with the admission its run must complete first, or undefined when none is owed. */
interface ALOutboundOwedMessageEnd {
    readonly expiresAtMs: number;
    readonly admissionEffectId: string | null;
}

/**
 * The commit conflicted, or a claim or the retry schedule held the retained admission, which its replay may still
 * admit: the end is owed, naming that admission. A conflict means the stored row existed, which a replay writes in the
 * commit that completes its admission row, so no admission is held then.
 */
function toOwedEnd(
    outcome: ALOutboundMessageEndOutcome,
    admissionEnd: ALOutboundLaneMessageEnd.AdmissionEnd,
    retained: ALOutboundLaneMessageEnd.RetainedAdmission | undefined
): ALOutboundOwedMessageEnd | undefined {
    if (admissionEnd.kind === 'held' && retained !== undefined) {
        return { expiresAtMs: retained.expiresAtMs, admissionEffectId: retained.effectId };
    }
    return outcome.kind === 'conflict' ? { expiresAtMs: outcome.expiresAtMs, admissionEffectId: null } : undefined;
}
