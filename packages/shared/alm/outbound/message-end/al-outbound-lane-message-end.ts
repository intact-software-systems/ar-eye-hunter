import { LatestRepository } from '../../../cache/LatestRepository.ts';
import { IndexedDbQueueWriteConflictError } from '../../../queuebox/indexed-db-queue-write-conflict-error.ts';
import { toKeyAsString, type Key, type ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
import { ExclusionKeyedAdmission } from '../../../resilience/exclusion-keyed-admission.ts';
import { RetryableConflictError } from '../../../resilience/try-with-policy.ts';
import { DEFAULT_AL_REPOSITORY_TTL_MS } from '../../ALStoreRetention.ts';
import type { ALWorkAttemptResult } from '../../work/al-work-handler.ts';
import type { ALWorkClaim, ALWorkQueuePort } from '../../work/al-work-queue-port.ts';
import { AL_WORK_UNDESCRIBED_COMMIT, type ALWorkCommittedRows } from '../../work/al-work-readiness-memory.ts';
import type { ALOutboundAdmissionStore } from '../admission/al-outbound-admission-store.ts';
import { toALOutboundMessageReference } from '../al-outbound-canonical-message.ts';
import { toALOutboundPendingAdmissionId } from '../al-outbound-pending-admission.ts';
import { computeALOutboundWorkEntry, isPendingALOutboundWork, toALOutboundWorkKey } from '../al-outbound-work-entry.ts';
import type { ALOutboundComputedDto } from '../compute-al-outbound-dispatch.ts';
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
        readonly key: Key;
        readonly expiresAtMs: number;
    }

    /** What the end did to its message's retained admission: nothing was retained, it was completed, or a run held it. */
    export type RetainedAdmissionEnd = 'none' | 'completed' | 'in-flight';
}

/**
 * Ends the messages a page cancelled or handed over, in one lane's store. An end whose commit conflicts is retained as
 * an `end-message` row, which the owner of the session's work runs; that run's conflict is redelivered by the queue
 * (D750). The page's own ends of one message run one after another, so they never conflict with each other.
 */
export class ALOutboundLaneMessageEnd<TPrepared> {
    /** The `end-message` row is due before every other row, so a batch ends the message before it claims a copy. */
    private static readonly END_MESSAGE_DUE_AT_MS = 0;
    private readonly input: ALOutboundLaneMessageEnd.Input<TPrepared>;
    private readonly writes = new ExclusionKeyedAdmission({
        maxConcurrent: Number.MAX_SAFE_INTEGER,
        keyedChainsFirst: false
    });
    /** Bounded as the send controls' ended ids are: only the page that enqueued a message can cancel it (D751). */
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
        const { admissionStore } = this.input;
        const reference = toALOutboundMessageReference(admissionStore.canonicalScope, canonicalEntry, computed.msg);
        this.retainedAdmissions.acceptAt({
            key: reference.msgId,
            value: {
                key: toALOutboundWorkKey(admissionStore.namespace, toALOutboundPendingAdmissionId(reference)),
                expiresAtMs: reference.expiresAtMs
            },
            nowEpochMs: this.input.nowMs()
        });
    }

    /** Ends the message, and announces the work rows the end wrote: a retained end, or a completed admission. */
    async end(msgId: string): Promise<void> {
        const written = await this.writes.admit(msgId, async () => {
            const retained = this.retainedAdmissions.readAt(msgId, this.input.nowMs());
            const admissionEnd = await this.completeRetainedAdmission(msgId, retained);
            const outcome = await writeALOutboundMessageEnd(this.input.admissionStore, msgId);
            const expiresAtMs = toRetainedEndExpiresAtMs(outcome, admissionEnd, retained);
            if (expiresAtMs !== undefined) {
                return await this.retainEnd(msgId, expiresAtMs);
            }
            return admissionEnd === 'completed' ? AL_WORK_UNDESCRIBED_COMMIT : undefined;
        });
        if (written !== undefined) {
            this.input.announce(written);
        }
    }

    /** The `end-message` effect: the same end, whose conflict the queue redelivers. */
    async runEnd(msgId: string): Promise<ALWorkAttemptResult> {
        return await this.writes.admit(msgId, async () => {
            const retained = this.retainedAdmissions.readAt(msgId, this.input.nowMs());
            const admissionEnd = await this.completeRetainedAdmission(msgId, retained);
            const outcome = await writeALOutboundMessageEnd(this.input.admissionStore, msgId);
            if (toRetainedEndExpiresAtMs(outcome, admissionEnd, retained) !== undefined) {
                throw new RetryableConflictError('Outbound message end commit conflict');
            }
            return { status: 'completed' };
        });
    }

    /**
     * Completes the retained admission before the stored row's end, so a replay either finds its row completed and
     * admits nothing, or committed first and left the stored row that end marks. A replay that holds the row is
     * left to finish.
     */
    private async completeRetainedAdmission(
        msgId: string,
        retained: ALOutboundLaneMessageEnd.RetainedAdmission | undefined
    ): Promise<ALOutboundLaneMessageEnd.RetainedAdmissionEnd> {
        if (retained === undefined) {
            return 'none';
        }
        const { workPort } = this.input;
        const entry = await workPort.readEntry(retained.key);
        if (entry === undefined || !isPendingALOutboundWork(entry)) {
            this.retainedAdmissions.delete(msgId);
            return 'none';
        }
        const claim = await this.claimRetainedAdmission(entry);
        if (claim === undefined) {
            return 'in-flight';
        }
        await workPort.releaseAll([{ claim, outcome: { status: 'completed' } }]);
        this.retainedAdmissions.delete(msgId);
        return 'completed';
    }

    /** A row another claim reserved first, or reserves under this one, is that claim's to finish. */
    private async claimRetainedAdmission(entry: ResourceEntry): Promise<ALWorkClaim | undefined> {
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
    private async retainEnd(msgId: string, expiresAtMs: number): Promise<ALWorkCommittedRows> {
        const { workPort, admissionStore } = this.input;
        const effectId = toALOutboundEndMessageEffectId(msgId);
        await workPort.retainIfAbsent(computeALOutboundWorkEntry({
            namespace: admissionStore.namespace,
            effectId,
            payload: { kind: 'end-message', msgId },
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

/**
 * The deadline of an end still owed, or undefined when none is: the commit conflicted, or a replay held the retained
 * admission while no stored row was there to end, which that replay may still write.
 */
function toRetainedEndExpiresAtMs(
    outcome: ALOutboundMessageEndOutcome,
    admissionEnd: ALOutboundLaneMessageEnd.RetainedAdmissionEnd,
    retained: ALOutboundLaneMessageEnd.RetainedAdmission | undefined
): number | undefined {
    if (outcome.kind === 'conflict') {
        return outcome.expiresAtMs;
    }
    return admissionEnd === 'in-flight' && outcome.kind === 'nothing-to-end' ? retained?.expiresAtMs : undefined;
}
