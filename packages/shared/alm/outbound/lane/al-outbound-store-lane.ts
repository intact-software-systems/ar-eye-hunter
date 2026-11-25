import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { AL_CONTROL_RECEIPT_TYPE_ID } from '../../../al-contracts/al-control-type-ids.ts';
import type { ALStoreDurability } from '../../../al-contracts/al-policy.ts';
import type { Unsubscribe } from '../../../cache/RepositoryInterfaces.ts';
import { NonRetryableException } from '../../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
import { AL_VOLATILE_STORE_EVICTION_INTERVAL_MS } from '../../ALStoreRetention.ts';
import type { ALCheckpointPort } from '../../checkpoint/al-checkpoint.ts';
import type { ALDeliveryAdmissionVerdict } from '../../delivery/al-delivery-lifecycle.ts';
import { ALStorageReadiness } from '../../storage/al-storage-readiness.ts';
import {
    toALDurableWorkLaneOwnership,
    type ALDurableWorkOwnership
} from '../../work/al-durable-work-ownership.ts';
import type { ALWorkObservationDeferral } from '../../work/al-work-handler.ts';
import {
    AL_WORK_READINESS_MEMORY_MS,
    ALWorkHandler,
    type ALWorkAttemptResult,
    type ALWorkBatchDiagnostics,
    type ALWorkDiagnostics,
    type ALWorkReadySelection
} from '../../work/al-work-handler.ts';
import {
    computeALWorkLeaseSweepState,
    createLimitedALWorkLeaseRecovery,
    type ALWorkLeaseRecovery
} from '../../work/al-work-lease-recovery.ts';
import {
    createALWorkQueuePort,
    type ALWorkClaim,
    type ALWorkQueuePort
} from '../../work/al-work-queue-port.ts';
import { AL_WORK_UNDESCRIBED_COMMIT, type ALWorkCommittedRows } from '../../work/al-work-readiness-memory.ts';
import type {
    ALOutboundDurableEffect,
    ALOutboundEffectSnapshot
} from '../admission/al-outbound-admission-store.ts';
import { ALOutboundDispatchAdmission } from '../al-outbound-dispatch-admission.ts';
import { ALOutboundMessageEffects } from '../al-outbound-message-effects.ts';
import type {
    ALOutboundMessageRuntime,
    ALOutboundRuntimeStores,
    ALOutboundSettlementEmitter,
    ALOutboundSettlementFact
} from '../al-outbound-message-runtime.ts';
import { toALOutboundPendingControlId } from '../al-outbound-pending-admission.ts';
import { ALOutboundRepairAdmission } from '../al-outbound-repair-admission.ts';
import { ALOutboundRepairRetransmission } from '../al-outbound-repair-retransmission.ts';
import {
    AL_OUTBOUND_WORK_LEASE_MS,
    AL_OUTBOUND_WORK_PAGE_SIZE,
    readALOutboundWorkReadyAt,
    toALOutboundDequeueWork,
    toALOutboundWorkKey,
    toALOutboundWorkType,
    type ALOutboundDequeueDeferral,
    type ALOutboundWorkDeferral
} from '../al-outbound-work-entry.ts';
import type { ALOutboundControlSource } from '../compute-al-outbound-control-admission.ts';
import type { ALOutboundComputedDto } from '../compute-al-outbound-dispatch.ts';
import {
    AL_OUTBOUND_COMMIT_ATTEMPTS,
    type ALOutboundControlAdmission
} from '../control/al-outbound-control-admission.ts';
import { ALOutboundReceiptAdmission } from '../control/al-outbound-receipt-admission.ts';
import type { ALOutboundControlAdmissionResult } from '../control/read-al-outbound-recipient-proof.ts';
import { ALOutboundFirstHopWait } from '../first-hop/al-outbound-first-hop-wait.ts';
import { ALOutboundLaneMessageEnd } from '../message-end/al-outbound-lane-message-end.ts';
import type { ALOutboundCanonicalHandoff } from './al-outbound-canonical-handoff.ts';
import { ALOutboundDequeuedAdmission } from './al-outbound-dequeued-admission.ts';
import type { ALOutboundReceiptWorkEvidence } from './al-outbound-receipt-observation.ts';
import type { ALOutboundEndedReason, ALOutboundSendControls } from './al-outbound-send-controls.ts';
import { computeALOutboundSettledCommittedRows } from './compute-al-outbound-settled-committed-rows.ts';
import { recordALOutboundDequeueTiming } from './record-al-outbound-dequeue-timing.ts';
import { runALOutboundDequeueClaimGroup } from './run-al-outbound-dequeue-claim-group.ts';
import {
    createALOutboundClaimEvidence,
    createALOutboundClaimObservation,
    recordALOutboundClaimTerminalReason,
    settleALOutboundClaim,
    type ALOutboundClaimAttemptSettlement,
    type ALOutboundClaimObservation,
    type ALOutboundClaimRun
} from './settle-al-outbound-claim.ts';
import { toALOutboundWorkDiagnostic } from './to-al-outbound-work-diagnostic.ts';

export namespace ALOutboundStoreLane {
    export interface Input<TPrepared> {
        /** Named on every diagnostic this lane states. */
        readonly lane: ALStoreDurability;
        readonly stores: ALOutboundRuntimeStores<TPrepared>;
        readonly workerId: string;
        /** Foreign queue rows only the durable lane admits; the volatile lane names none. */
        readonly dequeueTypes: ReadonlySet<string>;
        /** The session ownership the durable lane's work runs under; undefined for the volatile lane, which owns its memory pair. */
        readonly durableWorkOwnership: ALDurableWorkOwnership | undefined;
        /** The memory pair's sweep; undefined for a lane over a durable pair. */
        readonly evictExpired: (() => void) | undefined;
        /** What saves and restores the checkpoint lane's memory pair; undefined for every other lane. */
        readonly checkpoint: ALCheckpointPort | undefined;
        /** What this lane's commits hand its own claims; the memory pair's lane reads memory and has none. */
        readonly canonicalHandoff: ALOutboundCanonicalHandoff | undefined;
        readonly runtime: ALOutboundMessageRuntime.Dependencies<TPrepared>;
        readonly sendControls: ALOutboundSendControls;
        readonly settlements: ALOutboundSettlementEmitter;
    }
}

/**
 * One store pair of an outbound owner and the work that runs over it: admission, controls, receipts and
 * the owner's engine task. A lane over a memory pair sweeps its own expired rows on its work round. The
 * volatile lane persists nothing, so no admission it states is durable; the checkpoint lane's admission
 * is durable only in the runtime that saves its checkpoint.
 */
export class ALOutboundStoreLane<TPrepared> {
    private readonly input: ALOutboundStoreLane.Input<TPrepared>;
    private readonly readiness: ALStorageReadiness;
    private readonly dispatchAdmission: ALOutboundDispatchAdmission<TPrepared>;
    private readonly repairAdmission: ALOutboundRepairAdmission<TPrepared>;
    private readonly firstHopWait: ALOutboundFirstHopWait<TPrepared>;
    private readonly receiptAdmission: ALOutboundReceiptAdmission<TPrepared>;
    private readonly repairRetransmission: ALOutboundRepairRetransmission<TPrepared>;
    private readonly work: ALWorkHandler;
    /** The sweep limiter pair this lane's work port spends and its readiness scan peeks. */
    private readonly leaseRecovery: ALWorkLeaseRecovery;
    private readonly effects: ALOutboundMessageEffects<TPrepared>;
    private readonly dequeuedAdmission: ALOutboundDequeuedAdmission<TPrepared>;
    private readonly removeStorageResetListener: (() => void) | undefined;
    private readonly removeForeignCommitListener: (() => void) | undefined;
    private readonly takeOverSubscription: Unsubscribe | undefined;
    private readonly messageEnd: ALOutboundLaneMessageEnd<TPrepared>;
    private nextEvictionAtMs = Number.NEGATIVE_INFINITY;
    private disposed = false;
    /** The running batch's settled claims; its selection empties it, so a batch that never ended leaves nothing here. */
    private claimRuns: ALOutboundClaimRun[] = [];

    constructor(input: ALOutboundStoreLane.Input<TPrepared>) {
        this.input = input;
        const { stores, runtime } = input;
        this.leaseRecovery = createLimitedALWorkLeaseRecovery(AL_OUTBOUND_WORK_LEASE_MS, runtime.workClock.nowMs());
        const workPort = createALOutboundLaneWorkPort(input, this.leaseRecovery);
        const settlements: ALOutboundSettlementEmitter = (fact) => input.settlements(this.toStoreFact(fact));
        const admissions = createALOutboundLaneAdmissions(input, workPort, settlements);
        this.dispatchAdmission = admissions.dispatchAdmission;
        this.repairAdmission = admissions.repairAdmission;
        this.firstHopWait = admissions.firstHopWait;
        this.receiptAdmission = admissions.receiptAdmission;
        this.repairRetransmission = admissions.repairRetransmission;
        const workType = toALOutboundWorkType(stores.admissionStore.namespace);
        this.work = this.createWorkHandler(workPort, workType);
        this.messageEnd = new ALOutboundLaneMessageEnd({
            admissionStore: stores.admissionStore,
            workPort,
            nowMs: () => runtime.workClock.nowMs(),
            announce: (rows) => this.work.committed(rows)
        });
        this.removeForeignCommitListener = input.durableWorkOwnership?.onForeignCommit(
            workType,
            (rows) => this.applyForeignCommit(rows)
        );
        this.readiness = new ALStorageReadiness({
            openStores: () => this.openStores(),
            startWork: () => this.work.ready(),
            storageHealth: stores.storageHealth
        });
        this.takeOverSubscription = input.checkpoint?.onTakenOverDo(
            () => this.work.committed(AL_WORK_UNDESCRIBED_COMMIT)
        );
        this.effects = new ALOutboundMessageEffects({
            runtime,
            admissionStore: stores.admissionStore,
            dispatchAdmission: this.dispatchAdmission,
            sendSignal: input.sendControls.signal,
            settlements
        });
        this.dequeuedAdmission = new ALOutboundDequeuedAdmission({
            runtime,
            admissionStore: stores.admissionStore,
            commitDispatchPlans: (dispatches) => this.commitAllSettled(dispatches),
            sendSignal: input.sendControls.signal,
            settlements,
            timing: runtime.dequeueTiming
        });
        const { canonicalHandoff } = input;
        this.removeStorageResetListener = canonicalHandoff === undefined
            ? undefined
            : stores.storageResets?.add(() => canonicalHandoff.clear());
    }

    async ready(): Promise<ALStorageReadiness.Outcome> {
        return await this.readiness.ready();
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        const workDisposed = this.work.dispose();
        this.dispatchAdmission.dispose();
        this.removeStorageResetListener?.();
        this.removeForeignCommitListener?.();
        this.takeOverSubscription?.unsubscribe();
        this.input.canonicalHandoff?.clear();
        const outcomes = await Promise.allSettled([workDisposed, this.readiness.dispose()]);
        outcomes.push(...await Promise.allSettled([this.input.checkpoint?.dispose()]));
        const failure = outcomes.find((outcome) => outcome.status === 'rejected');
        if (failure?.status === 'rejected') {
            throw failure.reason;
        }
    }

    flushCheckpoint(): void {
        this.input.checkpoint?.flush();
    }

    /** The checkpoint's restore runs before the lane's first work batch, which then claims what it loaded. */
    private async openStores(): Promise<void> {
        await this.input.stores.admissionStore.ready();
        await this.input.checkpoint?.restore();
    }

    /** Rows another runtime of the session committed to this lane's work type, for this owner to run. */
    applyForeignCommit(rows: ALWorkCommittedRows): void {
        this.work.committed(rows);
    }

    /** Whether this lane holds the message an end must reach: stored, or retained by this page as an admission. */
    async holdsMessageForEnd(msgId: string): Promise<boolean> {
        return await this.messageEnd.holdsMessage(msgId);
    }

    /** A memory read on the volatile lane: whether this lane admitted the message. */
    async ownsMessage(msgId: string): Promise<boolean> {
        return await this.input.stores.admissionStore.hasSentMessageAdmission(msgId);
    }

    async commit(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>
    ): Promise<ALOutboundComputedDto<TPrepared>> {
        const [computed] = await this.commitAll([dispatch]);
        return computed!;
    }

    /** Members of one sender group may commit separately; results stay in dispatch order, with a wake after writes or before rethrow. */
    async commitAll(
        dispatches: readonly ALOutboundDispatchAdmission.Input<TPrepared>[]
    ): Promise<readonly ALOutboundComputedDto<TPrepared>[]> {
        return (await this.commitAllSettled(dispatches)).map((outcome) => {
            if (outcome.status === 'rejected') {
                throw outcome.reason;
            }
            return outcome.value;
        });
    }

    /** `commitAll` with each member's own answer, so one member's throw fails that member alone. */
    private async commitAllSettled(
        dispatches: readonly ALOutboundDispatchAdmission.Input<TPrepared>[]
    ): Promise<readonly PromiseSettledResult<ALOutboundComputedDto<TPrepared>>[]> {
        const outcomes = await this.readiness.runStoreOperation(
            () => this.dispatchAdmission.commitAllSettled(dispatches)
        ).catch((error) => {
            this.work.committed(AL_WORK_UNDESCRIBED_COMMIT);
            throw error;
        });
        for (const outcome of outcomes) {
            if (outcome.status === 'fulfilled') {
                this.setCanonicalHandoff(outcome.value);
                this.recordStorageHealth(outcome.value);
                this.messageEnd.rememberRetainedAdmission(outcome.value.computed);
            }
        }
        const committedRows = computeALOutboundSettledCommittedRows(
            this.input.stores.admissionStore.namespace,
            outcomes
        );
        if (committedRows !== undefined) {
            this.work.committed(committedRows);
        }
        return outcomes.map((outcome) =>
            outcome.status === 'fulfilled'
                ? { status: 'fulfilled', value: this.toStoreComputed(outcome.value.computed) }
                : outcome
        );
    }

    /** Before the wake: the batch it starts claims what this commit wrote and finds its canonical row here. */
    private setCanonicalHandoff(result: ALOutboundDispatchAdmission.Result<TPrepared>): void {
        // A commit that resolves after dispose must not refill what dispose cleared.
        if (!this.disposed && result.committed && result.computed.bundle !== undefined) {
            this.input.canonicalHandoff?.setCommitted(result.computed.bundle, this.input.runtime.workClock.nowMs());
        }
    }

    /** A committed send is a recovery point; a send its store refused is its failure. */
    private recordStorageHealth(result: ALOutboundDispatchAdmission.Result<TPrepared>): void {
        const { storageHealth } = this.input.stores;
        const { verdict } = result.computed;
        if (verdict.kind === 'storage-unavailable') {
            storageHealth?.recordFailure({ cause: verdict.cause, detail: verdict.detail });
        }
        else if (result.committed) {
            storageHealth?.recordRecoveryPoint(this.input.runtime.workClock.nowMs());
        }
    }

    /** A control its store cannot persist wrote nothing; its caller decides between a retry and not handled. */
    async acceptControlMessage(
        msg: ALMessage,
        source: ALOutboundControlSource
    ): Promise<ALOutboundControlAdmissionResult> {
        const admitted = await this.readiness.runStoreOperation(
            () => this.repairAdmission.acceptControlMessage(msg, source),
            (unavailable): ALOutboundControlAdmissionResult => ({ kind: 'storage-unavailable', ...unavailable })
        );
        // A foreign control and a rejected one write nothing, so they owe no batch.
        if (admitted.kind === 'committed') {
            this.work.committed(AL_WORK_UNDESCRIBED_COMMIT);
        }
        else if (admitted.kind === 'pending-control') {
            this.expeditePendingControl(msg);
        }
        return admitted;
    }

    async acceptReceipt(control: ALMessage): Promise<ALOutboundControlAdmissionResult> {
        const admitted = await this.readiness.runStoreOperation(
            () => this.receiptAdmission.admit(control),
            (unavailable): ALOutboundControlAdmissionResult => ({ kind: 'storage-unavailable', ...unavailable })
        );
        if (admitted.kind === 'pending-control') {
            this.expeditePendingControl(control);
        }
        return admitted;
    }

    /**
     * A control whose commit lost to this owner's own writes is replayed ahead of the running batch's remaining
     * claims, and again while its replays keep losing, `AL_OUTBOUND_COMMIT_ATTEMPTS` runs in all: those
     * claims are the writes it lost to, and a page of them can outlast the deadline it answers.
     */
    private expeditePendingControl(control: ALMessage): void {
        const { namespace } = this.input.stores.admissionStore;
        this.work.expedite(
            [toALOutboundWorkKey(namespace, toALOutboundPendingControlId(control))],
            AL_OUTBOUND_COMMIT_ATTEMPTS
        );
        // Harmless when the batch claims the row: the follow-up batch this owes finds it gone, a readiness probe.
        this.work.committed(AL_WORK_UNDESCRIBED_COMMIT);
    }

    /**
     * Ends a cancelled or handed-over message in this lane's store and states nothing. An end whose commit conflicts
     * is retained as work, announced as a commit's rows are; a store that cannot end it records that failure.
     */
    async endMessage(msgId: string, endedReason: ALOutboundEndedReason): Promise<void> {
        await this.readiness.runStoreOperation(() => this.messageEnd.end(msgId, endedReason), () => undefined);
    }

    /** What the admission states, as this lane's store holds it: nothing on the memory pair survives the document. */
    private toStoreComputed(computed: ALOutboundComputedDto<TPrepared>): ALOutboundComputedDto<TPrepared> {
        return { ...computed, verdict: this.toStoreVerdict(computed.verdict) };
    }

    private toStoreFact(fact: ALOutboundSettlementFact): ALOutboundSettlementFact {
        return fact.kind === 'admission' ? { ...fact, verdict: this.toStoreVerdict(fact.verdict) } : fact;
    }

    /** Only the durable lane's admission, and the checkpoint lane's where this runtime saves it, is durable. */
    private toStoreVerdict(verdict: ALDeliveryAdmissionVerdict): ALDeliveryAdmissionVerdict {
        const durable = this.input.checkpoint?.isOwned() ?? this.input.lane === 'durable';
        return verdict.kind === 'admitted' && !durable ? { ...verdict, durable: false } : verdict;
    }

    /** The outbound owner reserves straight from the queue, so it reads no page and observes no row's wait. */
    private async selectOutboundWork(
        port: ALWorkQueuePort,
        pageSize: number,
        batchStartedAtMs: number
    ): Promise<ALWorkReadySelection> {
        this.evictWhenDue();
        this.claimRuns = [];
        const startedAtMs = this.input.runtime.workClock.nowMs();
        const claims = await port.claim({ maxCount: pageSize, observedEntries: undefined });
        const claimDurationMs = Math.max(0, this.input.runtime.workClock.nowMs() - startedAtMs);
        if (this.input.runtime.dequeueTiming !== undefined) {
            recordALOutboundDequeueTiming(this.input.runtime.dequeueTiming, {
                kind: 'reservation-returns',
                lane: this.input.lane,
                workerId: this.input.workerId,
                batchStartedAtMs,
                claims,
                dequeueTypes: this.input.dequeueTypes
            });
        }
        return {
            claims,
            nextReadyAtMs: undefined,
            selectionDurationMs: 0,
            claimDurationMs,
            earliestDueAtMs: undefined
        };
    }

    /** The memory pair has no eviction loop of its own: its round sweeps it, at most once per interval. */
    private evictWhenDue(): void {
        const nowMs = this.readNowMs();
        if (this.input.evictExpired === undefined || nowMs < this.nextEvictionAtMs) {
            return;
        }
        this.nextEvictionAtMs = nowMs + AL_VOLATILE_STORE_EVICTION_INTERVAL_MS;
        this.input.evictExpired();
    }

    private async readNextReadyAtMs(port: ALWorkQueuePort, nowMs: number): Promise<number | undefined> {
        return await readALOutboundWorkReadyAt(port, nowMs, this.getWorkDeferral(nowMs));
    }

    private getWorkDeferral(nowMs: number): ALOutboundWorkDeferral {
        return {
            dequeue: this.getDequeueDeferral(nowMs),
            leaseSweeps: computeALWorkLeaseSweepState(this.leaseRecovery, nowMs)
        };
    }

    /** An open dequeue circuit must not advertise its rows, or every batch claims and releases them. */
    private getDequeueDeferral(nowMs: number): ALOutboundDequeueDeferral {
        const { resilience } = this.input.runtime.dequeue;
        return {
            types: this.input.dequeueTypes,
            readyAtMs: resilience.isNotAllowedThroughToDequeue()
                ? nowMs + resilience.toCircuitOpenBackoffMs()
                : undefined
        };
    }

    private async runOutboundClaim(
        claim: ALWorkClaim,
        batchStartedAtMs: number,
        deferObservation?: ALWorkObservationDeferral
    ): Promise<ALWorkAttemptResult> {
        const observed = createALOutboundClaimObservation(
            claim,
            this.input.runtime.dequeueTiming,
            this.input.dequeueTypes
        );
        const attempt = (async (): Promise<ALWorkAttemptResult> => {
            const work = await this.readExpirableOutboundWork(claim.entry, observed);
            if (work === undefined) {
                recordALOutboundClaimTerminalReason(observed, 'expired');
                return { status: 'completed' };
            }
            observed.evidence = this.createClaimEvidence(work, batchStartedAtMs, deferObservation);
            observed.work = { effectId: work.effectId, payloadKind: work.payload.kind };
            if (commitsALOutboundWorkOutsideLane(work.payload.kind)) {
                this.work.claimCommitted();
            }
            return await this.runDurableEffect(work, observed, deferObservation);
        })();
        return await this.settleOutboundClaim({ attempt, observed, claim, batchIndex: 0 });
    }

    /** A selection's dequeued rows admit as one group; every other claim runs alone through `runOutboundClaim`. */
    private runDequeueClaimGroup(
        claims: readonly ALWorkClaim[],
        batchStartedAtMs: number,
        deferObservation: ALWorkObservationDeferral | undefined
    ): ReadonlyMap<ALWorkClaim, Promise<ALWorkAttemptResult>> {
        return runALOutboundDequeueClaimGroup<TPrepared>({
            claims: claims.filter((claim) => this.input.dequeueTypes.has(claim.entry.typeId)),
            readWork: (claim) => toALOutboundDequeueWork(claim.entry, this.input.runtime.readMessageFromEntry),
            timing: this.input.runtime.dequeueTiming,
            hasReachedDeadline: (claim) => this.hasReachedDeadline(claim.entry),
            createEvidence: (work) => this.createClaimEvidence(work, batchStartedAtMs, deferObservation),
            readSettledBeforeEffect: (work, observed) => this.readSettledBeforeEffect(work, observed),
            admit: (members) => this.dequeuedAdmission.admitDequeuedMessages(members),
            settle: (settlement) => this.settleOutboundClaim(settlement)
        });
    }

    private createClaimEvidence(
        work: ALOutboundEffectSnapshot<TPrepared>,
        batchStartedAtMs: number,
        deferObservation: ALWorkObservationDeferral | undefined
    ): ALOutboundReceiptWorkEvidence | undefined {
        return createALOutboundClaimEvidence(this.input.runtime.receiptWorkCapture, {
            effect: work,
            workerId: this.input.workerId,
            batchStartedAtMs,
            deferObservation
        });
    }

    private async settleOutboundClaim(settlement: ALOutboundClaimAttemptSettlement): Promise<ALWorkAttemptResult> {
        const settled = await settleALOutboundClaim({
            ...settlement,
            claimRun: this.work.getClaimRun(settlement.claim.entry.key),
            capture: this.input.runtime.receiptWorkCapture,
            readNowMs: () => this.input.runtime.workClock.nowMs(),
            timed: this.input.runtime.diagnostics !== undefined
        });
        this.claimRuns.push(...settled.runs);
        return settled.outcome;
    }

    /** A deadline crossed during the read is expiry, not a defect: the work is dropped, not rejected. */
    private async readExpirableOutboundWork(
        entry: ResourceEntry,
        observed: ALOutboundClaimObservation
    ): Promise<ALOutboundEffectSnapshot<TPrepared> | undefined> {
        try {
            return await this.readOutboundWork(entry);
        }
        catch (error) {
            if (this.hasReachedDeadline(entry)) {
                return undefined;
            }
            recordALOutboundClaimTerminalReason(observed, 'decode-failed');
            throw error;
        }
    }

    private hasReachedDeadline(entry: ResourceEntry): boolean {
        return entry.audit.expiryTs.epochMilliseconds <= this.readNowMs();
    }

    private async readOutboundWork(entry: ResourceEntry): Promise<ALOutboundEffectSnapshot<TPrepared>> {
        return this.input.dequeueTypes.has(entry.typeId)
            ? toALOutboundDequeueWork(entry, this.input.runtime.readMessageFromEntry)
            : await this.input.stores.admissionStore.readWorkSnapshot(
                entry,
                this.input.canonicalHandoff?.takeCanonical(entry.key, this.input.runtime.workClock.nowMs())
            );
    }

    private async runDurableEffect(
        effect: ALOutboundEffectSnapshot<TPrepared>,
        observed: ALOutboundClaimObservation,
        deferObservation: ALWorkObservationDeferral | undefined
    ): Promise<ALWorkAttemptResult> {
        const evidence = observed.evidence;
        // Before anything else: a cancelled or handed-over message's remaining work completes silently, of any kind --
        // no `attempt-started`, no `expired`, no repair. A live attempt already past `attempt-started`
        // still terminates its own `attempt-settled cancelled` -- stated by the effects layer if the
        // abort lands before the carrier runs, or by the carrier's own settlement if it lands during it.
        const settled = this.readSettledBeforeEffect(effect, observed);
        if (settled !== undefined) {
            return settled;
        }
        switch (effect.payload.kind) {
            case 'admit-message':
                return await this.messageEnd.runAdmissionUnlessEnding(
                    effect.payload.message.msgId,
                    () => this.effects.admitPendingMessage(effect, evidence)
                );
            case 'dequeue-message':
                return await this.dequeuedAdmission.admitDequeuedMessage(effect, evidence, observed);
            case 'admit-control':
                return await this.replayControlAdmission(effect, effect.payload);
            case 'send-prepared':
                evidence?.recordStage('send');
                return await this.runPreparedSend(effect, effect.payload, deferObservation);
            case 'ack-timeout':
                await this.repairAdmission.retryPendingAck(effect.payload.msgId);
                return { status: 'completed' };
            case 'first-hop-timeout':
                await this.firstHopWait.retry(effect.payload.msgId);
                return { status: 'completed' };
            case 'repair-hint':
                await this.repairRetransmission.retransmitFromRepairHint(
                    effect.payload.msgId,
                    effect.payload.request,
                    effect.effectId
                );
                return { status: 'completed' };
            case 'nack-retry':
                await this.repairRetransmission.retransmitByMsgId(effect.payload.msgId, {
                    attemptIdentity: effect.effectId
                });
                return { status: 'completed' };
            case 'end-message':
                return await this.messageEnd.runEnd(effect.payload);
        }
    }

    /** A parked control's replay states its verdict with the run of the claim that replays it. */
    private async replayControlAdmission(
        effect: ALOutboundEffectSnapshot<TPrepared>,
        payload: Extract<ALOutboundDurableEffect<TPrepared>, { kind: 'admit-control'; }>
    ): Promise<ALWorkAttemptResult> {
        const claimRun = this.work.getClaimRun(effect.entry.key);
        return payload.msg.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID
            ? await this.receiptAdmission.replay(payload, claimRun)
            : await this.repairAdmission.replayControlAdmission(payload, claimRun);
    }

    private readSettledBeforeEffect(
        effect: ALOutboundEffectSnapshot<TPrepared>,
        observed: ALOutboundClaimObservation
    ): ALWorkAttemptResult | undefined {
        const msgId = resolveALOutboundEffectMsgId(effect);
        const endedReason = msgId === undefined ? undefined : this.input.sendControls.readEndedReason(msgId);
        if (endedReason !== undefined) {
            recordALOutboundClaimTerminalReason(observed, endedReason);
            observed.evidence?.recordStage('ended');
            return { status: 'completed' };
        }
        if (effect.expireAtTimestamp <= this.readNowMs()) {
            recordALOutboundClaimTerminalReason(observed, 'expired');
            observed.evidence?.recordStage('expired');
            this.emitWorkExpiry(effect);
            return { status: 'completed' };
        }
        return undefined;
    }

    /** One attempt on one prepared copy: the attempt is stated before its carrier can settle it. */
    private async runPreparedSend(
        effect: ALOutboundEffectSnapshot<TPrepared>,
        payload: Extract<ALOutboundDurableEffect<TPrepared>, { kind: 'send-prepared'; }>,
        deferReceiptObservation: ALWorkObservationDeferral | undefined
    ): Promise<ALWorkAttemptResult> {
        const canonicalMessage = effect.canonicalMessage;
        if (!canonicalMessage) {
            throw new NonRetryableException('Prepared work has no canonical message');
        }
        const msgId = canonicalMessage.id.msgId;
        const { sendControls } = this.input;
        const signal = sendControls.acquire(msgId);
        this.input.settlements({
            kind: 'attempt-started',
            msgId,
            traceId: canonicalMessage.id.traceId,
            attemptId: effect.effectId
        });
        try {
            const result = await this.effects.writePreparedMessage({
                attemptId: effect.effectId,
                payload,
                lifecycle: {
                    canonicalMessage,
                    sentPositions: payload.sentPositions,
                    deferReceiptObservation,
                    signal,
                    expiresAtMs: effect.expireAtTimestamp,
                    leaseUntilMs: effect.leaseUntilMs
                },
                attempts: effect.attempts
            });
            sendControls.releaseWhenSettled(msgId, result);
            return result;
        }
        catch (error) {
            sendControls.release(msgId);
            throw error;
        }
    }

    /**
     * Message admission and transmission work may state message expiry: `send-prepared`,
     * `admit-message` and foreign dequeue rows carry the message's original deadline. Receipt and
     * repair work do not themselves state message expiry, including `ack-timeout` work retained
     * until that same deadline so unspent retries survive downtime.
     */
    private emitWorkExpiry(effect: ALOutboundEffectSnapshot<TPrepared>): void {
        const id = effect.canonicalMessage?.id;
        if (id === undefined || !statesMessageDeadline(effect.payload.kind)) {
            return;
        }
        this.input.settlements({
            kind: 'expired',
            msgId: id.msgId,
            traceId: id.traceId,
            detail: 'Outbound work reached the message deadline before its attempt ran.'
        });
    }

    /**
     * A probe is reported as it happens rather than folded into the batch: a batch that runs is one
     * of six reasons a probe read storage, and only the reason separates an owner re-reading because
     * it committed from one re-reading because another writer woke every owner on the engine. Only a
     * drained batch reports the store's recovery and the server's dequeue timing: an aborted or failed
     * batch's counts describe no rows it settled.
     */
    private recordWorkDiagnostics(event: ALWorkDiagnostics): void {
        if (event.kind === 'work-batch' && event.end === 'drained') {
            this.recordDrainedBatch(event);
        }
        this.input.runtime.diagnostics?.(toALOutboundWorkDiagnostic(event, this.input.lane, this.claimRuns));
    }

    private recordDrainedBatch(event: ALWorkBatchDiagnostics): void {
        this.input.stores.storageRecovery?.reportFirstBatch(event.claimedCount);
        if (this.input.runtime.dequeueTiming !== undefined) {
            recordALOutboundDequeueTiming(this.input.runtime.dequeueTiming, {
                kind: 'work-batch',
                lane: this.input.lane,
                batch: event
            });
        }
    }

    private createWorkHandler(workPort: ALWorkQueuePort, workType: string): ALWorkHandler {
        const { stores, runtime } = this.input;
        return new ALWorkHandler({
            workerId: this.input.workerId,
            port: workPort,
            queueEngine: runtime.queueEngine,
            ownsQueueEngine: runtime.ownsQueueEngine,
            clock: runtime.workClock,
            pageSize: AL_OUTBOUND_WORK_PAGE_SIZE,
            readNextReadyAtMs: (port, nowMs) =>
                this.readiness.readOpenedStore(() => this.readNextReadyAtMs(port, nowMs), undefined),
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            selectReady: (port, pageSize, batchStartedAtMs) =>
                this.selectOutboundWork(port, pageSize, batchStartedAtMs),
            claimSuccessor: undefined,
            batchObservations: runtime.receiptWorkCapture?.batchObservations,
            runClaim: (claim, batchStartedAtMs, deferObservation) =>
                this.runOutboundClaim(claim, batchStartedAtMs, deferObservation),
            runClaimGroup: (claims, batchStartedAtMs, deferObservation) =>
                this.runDequeueClaimGroup(claims, batchStartedAtMs, deferObservation),
            diagnostics: (event) => this.recordWorkDiagnostics(event),
            storageHealth: stores.storageHealth,
            durableOwnership: toALDurableWorkLaneOwnership(this.input.durableWorkOwnership, workType)
        });
    }

    private readNowMs(): number {
        return this.input.runtime.clock.nowMs();
    }
}

/** The admissions one lane runs over its own store pair and work port. */
interface ALOutboundLaneAdmissions<TPrepared> {
    readonly dispatchAdmission: ALOutboundDispatchAdmission<TPrepared>;
    readonly repairAdmission: ALOutboundRepairAdmission<TPrepared>;
    readonly firstHopWait: ALOutboundFirstHopWait<TPrepared>;
    readonly receiptAdmission: ALOutboundReceiptAdmission<TPrepared>;
    readonly repairRetransmission: ALOutboundRepairRetransmission<TPrepared>;
}

/**
 * The lane's own work types, plus the foreign dequeue rows only the durable lane admits. Each lane sweeps
 * on its own limiters, so the volatile lane never spends the durable lane's allowance.
 */
function createALOutboundLaneWorkPort<TPrepared>(
    input: ALOutboundStoreLane.Input<TPrepared>,
    leaseRecovery: ALWorkLeaseRecovery
): ALWorkQueuePort {
    const { stores, runtime } = input;
    return createALWorkQueuePort({
        queue: stores.workQueue,
        workTypes: new Set([toALOutboundWorkType(stores.admissionStore.namespace), ...input.dequeueTypes]),
        leaseMs: AL_OUTBOUND_WORK_LEASE_MS,
        nowMs: () => runtime.workClock.nowMs(),
        random: runtime.random,
        leaseRecovery
    });
}

function createALOutboundLaneAdmissions<TPrepared>(
    input: ALOutboundStoreLane.Input<TPrepared>,
    workPort: ALWorkQueuePort,
    settlements: ALOutboundSettlementEmitter
): ALOutboundLaneAdmissions<TPrepared> {
    const { stores, runtime } = input;
    const dispatchAdmission = new ALOutboundDispatchAdmission({
        lane: input.lane,
        admissionStore: stores.admissionStore,
        toOutboxEntry: runtime.toOutboxEntry,
        decodePreparedMessage: runtime.decodePreparedMessage,
        clock: runtime.clock,
        diagnostics: runtime.diagnostics,
        dequeueTiming: runtime.dequeueTiming,
        signAdmittedMessage: runtime.signAdmittedMessage,
        settlements
    });
    const controlAdmission = stores.admissionStore.createControlAdmission({
        port: workPort,
        clock: runtime.clock,
        settlements,
        carrier: runtime.carrier,
        hopPeerIds: runtime.hopPeerIds,
        recipientAuthentication: runtime.recipientAuthentication
    });
    return {
        dispatchAdmission,
        repairAdmission: createALOutboundLaneRepairAdmission(input, controlAdmission, settlements),
        firstHopWait: createALOutboundLaneFirstHopWait(input, dispatchAdmission, settlements),
        receiptAdmission: createALOutboundLaneReceiptAdmission(input, controlAdmission, settlements),
        repairRetransmission: new ALOutboundRepairRetransmission({
            admissionStore: stores.admissionStore,
            dispatchAdmission,
            planOutgoingMessage: runtime.planOutgoingMessage,
            planRepairMessage: runtime.planRepairMessage,
            hopPeerIds: runtime.hopPeerIds,
            settlements
        })
    };
}

/** Peer controls commit through the lane's own control admission, the one its receipts are retained beside. */
function createALOutboundLaneRepairAdmission<TPrepared>(
    input: ALOutboundStoreLane.Input<TPrepared>,
    controlAdmission: ALOutboundControlAdmission<TPrepared>,
    settlements: ALOutboundSettlementEmitter
): ALOutboundRepairAdmission<TPrepared> {
    const { stores, runtime } = input;
    return new ALOutboundRepairAdmission({
        admissionStore: stores.admissionStore,
        controlAdmission,
        clock: runtime.clock,
        planOutgoingMessage: runtime.planOutgoingMessage,
        planRepairMessage: runtime.planRepairMessage,
        hopPeerIds: runtime.hopPeerIds,
        diagnostics: runtime.diagnostics,
        settlements
    });
}

/** A first-hop deadline resends through the lane's own dispatch admission, as a repair does. */
function createALOutboundLaneFirstHopWait<TPrepared>(
    input: ALOutboundStoreLane.Input<TPrepared>,
    dispatchAdmission: ALOutboundDispatchAdmission<TPrepared>,
    settlements: ALOutboundSettlementEmitter
): ALOutboundFirstHopWait<TPrepared> {
    return new ALOutboundFirstHopWait({
        admissionStore: input.stores.admissionStore,
        dispatchAdmission,
        clock: input.runtime.clock,
        planOutgoingMessage: input.runtime.planOutgoingMessage,
        settlements
    });
}

/** Server receipts that keep conflicting wait as work beside the peer controls of the same control admission. */
function createALOutboundLaneReceiptAdmission<TPrepared>(
    input: ALOutboundStoreLane.Input<TPrepared>,
    controlAdmission: ALOutboundControlAdmission<TPrepared>,
    settlements: ALOutboundSettlementEmitter
): ALOutboundReceiptAdmission<TPrepared> {
    return new ALOutboundReceiptAdmission({
        admissionStore: input.stores.admissionStore,
        clock: input.runtime.clock,
        settlements,
        diagnostics: input.runtime.diagnostics,
        pendingControls: controlAdmission
    });
}

/**
 * The effect kinds whose claim may commit work rows without the lane's own commit, which announces
 * what it writes: a receipt timeout attempt writes the next timeout and a repair hint, a first-hop
 * timeout its next timeout and the resend's fresh dispatch, a repair or retry commits a fresh dispatch,
 * a retained admission commits its message, and a replayed control its repair and retry schedule.
 */
function commitsALOutboundWorkOutsideLane<TPrepared>(kind: ALOutboundDurableEffect<TPrepared>['kind']): boolean {
    return kind !== 'send-prepared' && kind !== 'dequeue-message';
}

/** The message admission and transmission kinds that may state message expiry. */
function statesMessageDeadline<TPrepared>(kind: ALOutboundDurableEffect<TPrepared>['kind']): boolean {
    return kind === 'send-prepared' || kind === 'admit-message' || kind === 'dequeue-message';
}

/** The message a durable effect names to the page's ended-message guard, read from the field its kind carries it in. */
function resolveALOutboundEffectMsgId<TPrepared>(
    effect: ALOutboundEffectSnapshot<TPrepared>
): string | undefined {
    const { payload } = effect;
    switch (payload.kind) {
        case 'admit-message':
        case 'send-prepared':
            return payload.message.msgId;
        case 'ack-timeout':
        case 'first-hop-timeout':
        case 'repair-hint':
        case 'nack-retry':
            return payload.msgId;
        // The end of a message the page ended is the one effect of it that still runs: the page's guard skips it.
        case 'end-message':
            return undefined;
        case 'admit-control':
            return payload.msg.id.msgId;
        case 'dequeue-message':
            return effect.canonicalMessage?.id.msgId;
    }
    // `noImplicitReturns` is off: without this, a payload kind missing a case above would compile
    // silently and fall through returning `undefined`, escaping cancellation instead of failing the build.
    // The switch narrows `payload` itself exhaustively, not `payload.kind` -- assign `payload` here.
    const exhaustivePayload: never = payload;
    return exhaustivePayload;
}
