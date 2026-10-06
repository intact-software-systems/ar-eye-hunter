import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALMessageRejection } from '../../../al-contracts/al-message-persistence-validation.ts';
import { NonRetryableException } from '../../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { Either } from '../../../resilience/Either.ts';
import type { ALStoreDurability } from '../../al-runtime-stores.ts';
import { AL_VOLATILE_STORE_EVICTION_INTERVAL_MS } from '../../ALStoreRetention.ts';
import { ALStorageReadiness } from '../../storage/al-storage-readiness.ts';
import type { ALStorageRecoveryReporter } from '../../storage/al-storage-recovery-reporter.ts';
import {
    toALDurableWorkLaneOwnership,
    type ALDurableWorkOwnership
} from '../../work/al-durable-work-ownership.ts';
import {
    AL_WORK_PROBE_EVERY_ROUND,
    ALWorkHandler,
    type ALWorkBatchDiagnostics,
    type ALWorkDiagnostics,
    type ALWorkReadySelection
} from '../../work/al-work-handler.ts';
import {
    createALWorkQueuePort,
    type ALWorkClaim,
    type ALWorkOutcome,
    type ALWorkQueuePort
} from '../../work/al-work-queue-port.ts';
import { AL_WORK_UNDESCRIBED_COMMIT } from '../../work/al-work-readiness-memory.ts';
import type { ALInboundPlanner } from '../al-inbound-admission-store.ts';
import { ALInboundAdmittedDelivery } from '../al-inbound-admitted-delivery.ts';
import { ALInboundMessageAdmission } from '../al-inbound-message-admission.ts';
import type { ALInboundMessageRuntime, ALInboundRuntimeStores } from '../al-inbound-message-runtime.ts';
import type { ALInboundPendingAdmission } from '../al-inbound-pending-admission.ts';
import { toALInboundClaimIdentity, type ALInboundDeferredEffect } from '../al-inbound-runtime-diagnostics.ts';
import {
    AL_INBOUND_WORK_LEASE_MS,
    assertALInboundWorkCarrier,
    decodeALInboundWorkEntry,
    resolveALInboundWorkDueAtMs,
    toALInboundWorkType,
    type ALPersistedInboundEffect
} from '../al-inbound-work-entry.ts';
import {
    ALInboundControlAdmission,
    type ALInboundControlAdmissionResult,
    type ALInboundPendingControl
} from '../control/al-inbound-control-admission.ts';
import {
    AL_INBOUND_WORK_PAGE_SIZE,
    createALInboundWorkSelector,
    type ALInboundClaimedControlSend,
    type ALInboundWorkSelector
} from '../read-al-inbound-work-selection.ts';

/**
 * How many empty rotation rounds one liveness event stands for. The rotation runs a batch every
 * engine round it still owes a page, so this is roughly one event every few seconds of scanning --
 * enough to separate a rotation that keeps finding nothing from one that stopped running, and far
 * too rare to bring back the per-round cost the empty batches were suppressed for.
 */
export const AL_INBOUND_ROTATION_ALIVE_EVERY_ROUNDS = 64;

export namespace ALInboundStoreLane {
    export interface Input {
        /** Named on every diagnostic this lane states. */
        readonly lane: ALStoreDurability;
        readonly stores: ALInboundRuntimeStores;
        readonly workerId: string;
        /** The memory pair's sweep; undefined for a lane over a durable pair. */
        readonly evictExpired: (() => void) | undefined;
        /** The session ownership the durable lane's work runs under; undefined for the volatile lane, which owns its memory pair. */
        readonly durableWorkOwnership: ALDurableWorkOwnership | undefined;
        readonly runtime: ALInboundMessageRuntime.Dependencies;
    }
}

/**
 * One store pair of the inbound owner and the work that runs over it: data and control admission, the
 * rotation that delivers what they committed, and its diagnostics. A lane over the memory pair sweeps
 * its own expired rows on its work round.
 */
export class ALInboundStoreLane {
    private readonly input: ALInboundStoreLane.Input;
    private readonly dependencies: ALInboundMessageRuntime.Dependencies;
    private readonly readiness: ALStorageReadiness;
    private readonly admission: ALInboundMessageAdmission;
    private readonly controlAdmission: ALInboundControlAdmission;
    private readonly delivery: ALInboundAdmittedDelivery;
    private readonly workSelector: ALInboundWorkSelector;
    private readonly work: ALWorkHandler;
    private readonly storageRecovery: ALStorageRecoveryReporter | undefined;
    private readonly removeForeignCommitListener: (() => void) | undefined;
    private nextEvictionAtMs = Number.NEGATIVE_INFINITY;
    private emptyRoundCount = 0;
    private emptyRoundsFromMs: number | undefined;
    private longestEmptyRoundMs = 0;
    private deferredRoundCount = 0;
    private latestDeferred: readonly ALInboundDeferredEffect[] = [];
    /** The effects the running batch has started, in run order: only this owner holds them decoded. */
    private batchRunOrder: ALInboundBatchRunOrder | undefined;
    private controlRound: ALInboundControlSendRound | undefined;
    private disposed = false;

    constructor(input: ALInboundStoreLane.Input) {
        this.input = input;
        this.dependencies = toALInboundLaneDependencies(input);
        const workPort = createALInboundLaneWorkPort(this.dependencies);
        this.admission = new ALInboundMessageAdmission({ ...this.dependencies, workPort });
        this.controlAdmission = createALInboundLaneControlAdmission(this.dependencies, workPort);
        this.delivery = new ALInboundAdmittedDelivery(this.dependencies);
        const workType = toALInboundWorkType(input.stores.admissionStore.namespace, input.runtime.carrier);
        this.storageRecovery = input.stores.createStorageRecovery?.({
            name: input.runtime.carrier,
            workTypeId: workType
        });
        this.workSelector = createALInboundWorkSelector({
            delivery: this.delivery,
            namespace: input.stores.admissionStore.namespace,
            nowMs: () => this.readNowMs()
        });
        this.work = this.createWorkHandler(workPort, workType);
        this.removeForeignCommitListener = input.durableWorkOwnership?.onForeignCommit(
            workType,
            () => this.applyForeignCommit()
        );
        this.readiness = new ALStorageReadiness({
            openStores: () => input.stores.admissionStore.ready(),
            startWork: () => this.work.ready(),
            storageHealth: input.stores.storageHealth
        });
    }

    async ready(): Promise<ALStorageReadiness.Outcome> {
        return await this.readiness.ready();
    }

    dispose(): void {
        this.disposed = true;
        this.removeForeignCommitListener?.();
        this.admission.dispose();
        this.work.dispose();
        this.delivery.dispose();
    }

    /** Another runtime of the session admitted to this lane's work type; inbound commits name no rows. */
    applyForeignCommit(): void {
        this.commitWork();
    }

    /** A message its store cannot persist is not admitted: it wrote nothing, and its sender's receipt retries it. */
    async admitData(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source,
        planIncomingMessage: ALInboundPlanner
    ): Promise<Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>> {
        return await this.readiness.runStoreOperation(
            () => this.admitDataInStore(msg, source, planIncomingMessage),
            () => Either.ofRight({ kind: 'not-admitted', reason: 'storage-unavailable' })
        );
    }

    private async admitDataInStore(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source,
        planIncomingMessage: ALInboundPlanner
    ): Promise<Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>> {
        const attempt = await this.admission.attempt(msg, source, planIncomingMessage);
        if (attempt.left) {
            return Either.ofLeft(attempt.left);
        }
        const result = attempt.right!;
        if (result.kind === 'conflict') {
            return Either.ofRight(await this.retainConflictedAdmission(result.pending));
        }
        if (result.wroteWork) {
            this.input.stores.storageHealth?.recordRecoveryPoint(this.readNowMs());
            this.commitWork();
        }
        return Either.ofRight(result.acceptance);
    }

    /** A message its ingress authority cannot judge yet, retained for the replay to re-authorize. */
    async retainData(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source,
        planIncomingMessage: ALInboundPlanner
    ): Promise<ALInboundMessageRuntime.Acceptance> {
        return await this.readiness.runStoreOperation(
            async () =>
                this.announceRetention(await this.admission.retainIncomingMessage(msg, source, planIncomingMessage)),
            () => ({ kind: 'not-admitted', reason: 'storage-unavailable' })
        );
    }

    /**
     * A control the lane does not handle or rejects has nothing for the worker to claim; retained work
     * and a commit, which always relays at least the recipient the acknowledgement names, announce one.
     */
    async admitControl(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source
    ): Promise<ALInboundControlAdmissionResult> {
        const admitted = await this.readiness.runStoreOperation(
            () => this.controlAdmission.admit(msg, source),
            (unavailable): ALInboundControlAdmissionResult => ({ kind: 'storage-unavailable', ...unavailable })
        );
        if (admitted.kind === 'pending-control' || admitted.kind === 'committed') {
            this.commitWork();
        }
        return admitted;
    }

    /**
     * Only a retention that left a claimable row is announced — `pending-admission`, whether this call
     * wrote the row or found one a previous attempt wrote. A conflict the plan does not retain never
     * reaches retention; a message past its deadline is rejected before the write, or as a row written
     * already expired; and a row in a terminal status holds no work for the worker.
     */
    private async retainConflictedAdmission(
        pending: ALInboundPendingAdmission | undefined
    ): Promise<ALInboundMessageRuntime.Acceptance> {
        if (pending === undefined) {
            return { kind: 'not-admitted', reason: 'conflict' };
        }
        return this.announceRetention(await this.admission.retainPending(pending));
    }

    private announceRetention(acceptance: ALInboundMessageRuntime.Acceptance): ALInboundMessageRuntime.Acceptance {
        if (acceptance.kind === 'pending-admission') {
            this.commitWork();
        }
        return acceptance;
    }

    private commitWork(): void {
        this.workSelector.requestHeadRead();
        this.work.committed(AL_WORK_UNDESCRIBED_COMMIT);
    }

    /**
     * A head read a commit was owed can become due at a rotation read, when the commit landed during
     * the head batch before it. Announcing it here gives it the batch this batch's end runs.
     */
    private async selectInboundWork(port: ALWorkQueuePort, pageSize: number): Promise<ALWorkReadySelection> {
        this.evictWhenDue();
        const selection = await this.workSelector.selectReady(port, pageSize);
        if (this.workSelector.isHeadReadPending()) {
            this.work.committed(AL_WORK_UNDESCRIBED_COMMIT);
        }
        return selection;
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

    /**
     * A batch is relayed when it touched work; a probe is not relayed at all. The rotation's probe
     * reads a page every engine round by construction, and in the conformance lane every relayed
     * event is a round trip out of the page, so one event per round roughly doubled that page's
     * traffic and with it its measured per-operation cost -- 8.2 to 20.9 ms/op -- which delayed RTC
     * signaling far enough that the delivery baseline received nothing and the lane failed.
     * Suppressed, the same cell passes at 10-13 ms/op (12.6 measured on the full lane here, 10.3 on
     * the rtc-only run that isolated this relay). The probe's own `durationMs` is still measured and
     * the outbound owners, whose probes are the invalidations they can name, still report theirs.
     */
    private recordWorkDiagnostics(event: ALWorkDiagnostics): void {
        if (event.kind === 'work-batch') {
            this.storageRecovery?.reportFirstBatch(event.claimedCount);
            this.recordWorkBatch(event);
        }
    }

    /**
     * The rotation runs a batch every engine round, so an empty one is its normal resting state: it
     * claimed nothing, ran nothing and released nothing, and every number it could carry was already
     * decided by the probe that preceded it. It is suppressed for the same reason the probe is, and
     * `rotation-alive` below is what keeps a silent rotation distinguishable from a stopped one.
     */
    private recordWorkBatch(event: ALWorkBatchDiagnostics): void {
        const runOrder = this.batchRunOrder;
        this.batchRunOrder = undefined;
        if (event.claimedCount === 0 && event.rejectedCount === 0) {
            this.recordEmptyRotationRound(event);
            return;
        }
        this.dependencies.diagnostics?.({
            kind: 'effect-drain',
            lane: this.input.lane,
            workerId: event.workerId,
            durationMs: event.durationMs,
            claimedCount: event.claimedCount,
            completedCount: event.completedCount,
            rescheduledCount: event.rescheduledCount,
            rejectedCount: event.rejectedCount,
            selectionDurationMs: event.selectionDurationMs,
            claimDurationMs: event.claimDurationMs,
            runDurationMs: event.runDurationMs,
            releaseDurationMs: event.releaseDurationMs,
            queueWaitMs: event.queueWaitMs,
            startedAtMs: event.startedAtMs,
            claimedEffectIds: runOrder?.batchStartedAtMs === event.startedAtMs ? runOrder.effectIds : [],
            deferred: toOldestFirstALInboundDeferredEffects(this.workSelector.getUnreservedDue())
        });
    }

    /**
     * Suppressing the empty rounds left the rotation itself unobservable: a committed admission that
     * no drain follows reads the same whether no consumer is registered for its typeId or the
     * rotation stopped running. One event per `AL_INBOUND_ROTATION_ALIVE_EVERY_ROUNDS` of them says
     * which, and carries the wall time they spanned so a slowed rotation reads as a long gap. A due row
     * those rounds held back rides on the same event rather than one of its own, because one event per
     * round is exactly the relay cost the suppression removed.
     */
    private recordEmptyRotationRound(event: ALWorkBatchDiagnostics): void {
        const nowMs = this.readNowMs();
        this.emptyRoundCount += 1;
        this.emptyRoundsFromMs ??= nowMs - event.durationMs;
        this.longestEmptyRoundMs = Math.max(this.longestEmptyRoundMs, event.durationMs);
        const unreservedDue = this.workSelector.getUnreservedDue();
        if (unreservedDue.length > 0) {
            this.deferredRoundCount += 1;
            this.latestDeferred = toOldestFirstALInboundDeferredEffects(unreservedDue);
        }
        if (this.emptyRoundCount < AL_INBOUND_ROTATION_ALIVE_EVERY_ROUNDS) {
            return;
        }
        this.dependencies.diagnostics?.({
            kind: 'rotation-alive',
            lane: this.input.lane,
            workerId: event.workerId,
            emptyRoundCount: this.emptyRoundCount,
            durationMs: Math.max(0, nowMs - this.emptyRoundsFromMs),
            longestRoundMs: this.longestEmptyRoundMs,
            deferredRoundCount: this.deferredRoundCount,
            latestDeferred: this.latestDeferred
        });
        this.emptyRoundCount = 0;
        this.emptyRoundsFromMs = undefined;
        this.longestEmptyRoundMs = 0;
        this.deferredRoundCount = 0;
        this.latestDeferred = [];
    }

    /**
     * One claim, timed and named: the batch above reports the whole drain, and a drain that crawls is
     * only readable once each claim says which message it ran and how long that one took. A row that
     * cannot be decoded, and a claim that throws, name no payload here; the batch still counts them.
     */
    private async runInboundClaim(claim: ALWorkClaim, batchStartedAtMs: number): Promise<ALWorkOutcome> {
        const effect = decodeALInboundWorkEntry(claim.entry, this.input.stores.admissionStore.namespace);
        assertALInboundWorkCarrier(effect, this.dependencies.carrier);
        this.recordClaimStarted(batchStartedAtMs, effect.effectId);
        const startedAtMs = this.readNowMs();
        const outcome = await this.runInboundEffect(effect);
        this.recordClaimSettled({
            claim,
            effect,
            outcome,
            durationMs: Math.max(0, this.readNowMs() - startedAtMs),
            batchStartedAtMs,
            startedAtMs
        });
        return outcome;
    }

    /** A batch runs its claims one after another under one start, so a new start is a new batch. */
    private recordClaimStarted(batchStartedAtMs: number, effectId: string): void {
        if (this.batchRunOrder?.batchStartedAtMs !== batchStartedAtMs) {
            this.batchRunOrder = { batchStartedAtMs, effectIds: [] };
        }
        this.batchRunOrder.effectIds.push(effectId);
    }

    private recordClaimSettled(settled: ALInboundClaimSettlement): void {
        const dueAtMs = resolveALInboundWorkDueAtMs(settled.claim.entry);
        this.dependencies.diagnostics?.({
            kind: 'claim-settled',
            lane: this.input.lane,
            workerId: this.input.workerId,
            effectId: settled.effect.effectId,
            ...toALInboundClaimIdentity(settled.effect.payload),
            payloadKind: settled.effect.payload.kind,
            durationMs: settled.durationMs,
            attempts: settled.claim.attempts,
            outcome: settled.outcome.status,
            queueWaitMs: Math.max(0, settled.batchStartedAtMs - dueAtMs),
            dueAtMs,
            batchStartedAtMs: settled.batchStartedAtMs,
            startedAtMs: settled.startedAtMs
        });
    }

    /**
     * A replay commits inside the batch that claimed it, so the work it wrote is behind the page that
     * batch already read. Announcing it here gives that work a head read in the batch this batch's
     * end runs, instead of the next round the rotation happens to reach.
     */
    private async runInboundEffect(effect: ALPersistedInboundEffect): Promise<ALWorkOutcome> {
        const payload = effect.payload;
        if (payload.kind === 'admit-message') {
            const replayed = await this.admission.replay(payload);
            if (replayed.wroteWork) {
                this.commitWork();
            }
            return toALInboundReplayOutcome(replayed.outcome, this.readNowMs());
        }
        if (payload.kind === 'admit-control') {
            return await this.replayControl(payload);
        }
        if (payload.kind === 'send-control') {
            return await this.sendControlInRound(effect, payload.msg);
        }
        return {
            status: await this.delivery.deliver(effect, this.workSelector.getDeliveryObservation(effect.effectId))
        };
    }

    /**
     * The first control claim of a batch sends every control message that batch reserved, and the
     * rest await that one send. The round is the array the selection returned, so a retried row in a later
     * batch never joins a finished round, and a claim absent from the selected batch sends
     * alone. A round that throws sends the message of each claim alone too, so each claim settles on its
     * own message: the outbound admission is idempotent, so a message the round already admitted
     * answers `duplicate`.
     */
    private async sendControlInRound(effect: ALPersistedInboundEffect, msg: ALMessage): Promise<ALWorkOutcome> {
        if (this.disposed) {
            return { status: 'retry' };
        }
        if (effect.expireAtTimestamp <= this.readNowMs()) {
            throw new NonRetryableException('Inbound work expired before delivery');
        }
        const sends = this.workSelector.getClaimedControlSends();
        if (!sends.some((send) => send.effectId === effect.effectId)) {
            await this.dependencies.sendControlMessages([msg]);
            return { status: 'completed' };
        }
        if (this.controlRound?.sends !== sends) {
            this.controlRound = { sends, sent: this.dependencies.sendControlMessages(sends.map((send) => send.msg)) };
        }
        try {
            await this.controlRound.sent;
        }
        catch {
            await this.dependencies.sendControlMessages([msg]);
        }
        return { status: 'completed' };
    }

    /**
     * A storage failure retries this claim once; the inbound admission is already committed, so the retry completes
     * without a second hand-over, and the receipt timeout and the peer's re-ACK heal it.
     */
    private async replayControl(payload: ALInboundPendingControl): Promise<ALWorkOutcome> {
        const replayed = await this.controlAdmission.replay(payload);
        if (replayed.wroteWork) {
            this.commitWork();
        }
        if (replayed.acceptance === undefined || this.disposed) {
            return replayed.outcome;
        }
        const handedOver = await this.dependencies.onControlMessage?.(payload.msg, replayed.acceptance);
        return handedOver?.kind === 'storage-unavailable' ? { status: 'retry' } : replayed.outcome;
    }

    private createWorkHandler(workPort: ALWorkQueuePort, workType: string): ALWorkHandler {
        const { input, dependencies } = this;
        return new ALWorkHandler({
            workerId: input.workerId,
            port: workPort,
            queueEngine: dependencies.queueEngine,
            ownsQueueEngine: dependencies.ownsQueueEngine,
            clock: dependencies.clock,
            pageSize: AL_INBOUND_WORK_PAGE_SIZE,
            // The rotation answers readiness: work the eligibility rules defer must not report as due.
            readNextReadyAtMs: (port) =>
                this.readiness.readOpenedStore(() => this.workSelector.readNextReadyAtMs(port), undefined),
            // The rotation advances one status per probe, so an answer of its own never stands.
            readinessMemoryMs: AL_WORK_PROBE_EVERY_ROUND,
            selectReady: (port, pageSize) => this.selectInboundWork(port, pageSize),
            runClaim: (claim, batchStartedAtMs) => this.runInboundClaim(claim, batchStartedAtMs),
            diagnostics: (event) => this.recordWorkDiagnostics(event),
            storageHealth: input.stores.storageHealth,
            durableOwnership: toALDurableWorkLaneOwnership(input.durableWorkOwnership, workType)
        });
    }

    private readNowMs(): number {
        return this.dependencies.clock.nowMs();
    }
}

/** The one grouped send the control claims of a batch share, keyed by the array their selection returned. */
interface ALInboundControlSendRound {
    readonly sends: readonly ALInboundClaimedControlSend[];
    readonly sent: Promise<void>;
}

/** One settled claim's measurements, so the event that reports them is built from one input. */
interface ALInboundClaimSettlement {
    readonly claim: ALWorkClaim;
    readonly effect: ALPersistedInboundEffect;
    readonly outcome: ALWorkOutcome;
    readonly durationMs: number;
    readonly batchStartedAtMs: number;
    readonly startedAtMs: number;
}

interface ALInboundBatchRunOrder {
    readonly batchStartedAtMs: number;
    readonly effectIds: string[];
}

/** The runtime's dependencies over this lane's own store pair and worker. */
function toALInboundLaneDependencies(input: ALInboundStoreLane.Input): ALInboundMessageRuntime.Dependencies {
    return {
        ...input.runtime,
        admissionStore: input.stores.admissionStore,
        workQueue: input.stores.workQueue,
        effectWorkerId: input.workerId
    };
}

/** The lane claims only its carrier's rows of its own store pair. */
function createALInboundLaneWorkPort(dependencies: ALInboundMessageRuntime.Dependencies): ALWorkQueuePort {
    return createALWorkQueuePort({
        queue: dependencies.workQueue,
        workTypes: new Set([toALInboundWorkType(dependencies.admissionStore.namespace, dependencies.carrier)]),
        leaseMs: AL_INBOUND_WORK_LEASE_MS,
        nowMs: () => dependencies.clock.nowMs(),
        random: dependencies.random,
        // The rotation's probe has no lease clamp: a limited sweep would run empty batches until it reopened.
        leaseRecovery: { kind: 'every-batch' }
    });
}

function createALInboundLaneControlAdmission(
    dependencies: ALInboundMessageRuntime.Dependencies,
    workPort: ALWorkQueuePort
): ALInboundControlAdmission {
    return new ALInboundControlAdmission({
        admissionStore: dependencies.admissionStore,
        port: workPort,
        clock: dependencies.clock,
        newControlId: dependencies.effectPreparation.newControlId,
        retention: dependencies.admissionStore.retention
    });
}

function toOldestFirstALInboundDeferredEffects(
    deferred: readonly ALInboundDeferredEffect[]
): readonly ALInboundDeferredEffect[] {
    return [...deferred].sort((left, right) => left.dueAtMs - right.dueAtMs);
}

function toALInboundReplayOutcome(
    outcome: ALInboundMessageAdmission.ReplayOutcome,
    nowMs: number
): ALWorkOutcome {
    if (typeof outcome === 'string') {
        return { status: outcome };
    }
    return outcome.kind === 'not-ready'
        ? { status: 'not-ready', readyAtMs: nowMs + outcome.retryAfterMs }
        : { status: 'non-retryable' };
}
