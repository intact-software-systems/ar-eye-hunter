import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { isALControlTypeId, type ALControlAcceptance } from '../../al-contracts/al-control.ts';
import { decodeALMessageValue, type ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import { type ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { Either } from '../../resilience/Either.ts';
import type { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
import {
    AL_WORK_PROBE_EVERY_ROUND,
    ALWorkHandler,
    type ALWorkBatchDiagnostics,
    type ALWorkDiagnostics
} from '../work/al-work-handler.ts';
import { createALWorkQueuePort, type ALWorkClaim, type ALWorkOutcome } from '../work/al-work-queue-port.ts';
import type {
    ALInboundAdmissionStore,
    ALInboundPlanner,
    ALPersistedInboundEffect
} from './al-inbound-admission-store.ts';
import { ALInboundAdmittedDelivery } from './al-inbound-admitted-delivery.ts';
import { ALInboundMessageAdmission } from './al-inbound-message-admission.ts';
import type { ALInboundPendingAdmission } from './al-inbound-pending-admission.ts';
import {
    toALInboundAdmissionDiagnostics,
    toALInboundClaimIdentity,
    type ALInboundRuntimeDiagnosticsSink
} from './al-inbound-runtime-diagnostics.ts';
import {
    AL_INBOUND_WORK_LEASE_MS,
    decodeALInboundWorkEntry,
    resolveALInboundWorkDueAtMs,
    toALInboundWorkType
} from './al-inbound-work-entry.ts';
import { ALInboundControlAdmission } from './control/al-inbound-control-admission.ts';
import {
    type ALInboundEffectPreparationDependencies
} from './prepare-al-inbound-commit-bundle.ts';
import {
    AL_INBOUND_WORK_PAGE_SIZE,
    createALInboundWorkSelector,
    type ALInboundWorkSelector
} from './read-al-inbound-work-selection.ts';
import { validateALInboundMessage } from './validate-al-inbound-message.ts';

export interface ALInboundRuntimeStores {
    readonly admissionStore: ALInboundAdmissionStore;
    readonly workQueue: QueueBoxResourceEntryRepository;
}

export namespace ALInboundMessageRuntime {
    export type Source =
        | { readonly kind: 'rtc-peer'; readonly peerId: string; }
        | { readonly kind: 'ws-client'; readonly peerId: string; readonly groupRecipientPeerIds?: readonly string[]; }
        | { readonly kind: 'trusted-server'; };

    export type Acceptance =
        | { readonly kind: 'admitted' | 'duplicate' | 'resync-required' | 'disposed' | 'pending-admission'; }
        | { readonly kind: 'not-admitted'; readonly reason: string; }
        | { readonly kind: 'control'; readonly handled: boolean; };

    export type PendingAuthority =
        | { readonly kind: 'authorized'; readonly source: Source; }
        | { readonly kind: 'retry'; readonly retryAfterMs: number; }
        | { readonly kind: 'rejected'; };

    export interface Clock {
        nowMs(): number;
    }

    export interface Resources {
        readonly admissionStore: ALInboundAdmissionStore;
        readonly workQueue: QueueBoxResourceEntryRepository;
        readonly effectPreparation: ALInboundEffectPreparationDependencies;
        readonly effectWorkerId: string;
        readonly clock: Clock;
        readonly random: () => number;
        readonly queueEngine: InboxOutboxEngine;
        readonly ownsQueueEngine: boolean;
    }

    export interface Dependencies extends Resources {
        readonly planIncomingMessage: ALInboundPlanner;
        /** Rechecks asynchronous ingress authority before pending data enters conditional admission. */
        readonly readPendingAdmissionAuthority?: (msg: ALMessage, source: Source) => Promise<PendingAuthority>;
        readonly dispatchInboxEntry: (
            entry: ResourceEntry,
            plan: ALMessageHandlingPlan,
            source: Source
        ) => Promise<void | 'completed' | 'retry'>;
        /** Absence means the supplied dispatcher is ready for every local message. */
        readonly canDispatchMessage?: (msg: ALMessage) => boolean;
        readonly sendControlMessage: (msg: ALMessage) => Promise<void>;
        readonly onControlMessage?: (msg: ALMessage, acceptance: ALControlAcceptance) => Promise<void>;
        readonly forwardMessage?: (
            msg: ALMessage,
            fromPeerId: string,
            plan: ALMessageHandlingPlan
        ) => Promise<void | 'completed' | 'retry'>;
        /** Absence means the configured transport can forward every message. */
        readonly canForwardMessage?: (msg: ALMessage) => boolean;
        readonly diagnostics: ALInboundRuntimeDiagnosticsSink | undefined;
    }
}

/**
 * How many empty rotation rounds one liveness event stands for. The rotation runs a batch every
 * engine round it still owes a page, so this is roughly one event every few seconds of scanning --
 * enough to separate a rotation that keeps finding nothing from one that stopped running, and far
 * too rare to bring back the per-round cost the empty batches were suppressed for.
 */
export const AL_INBOUND_ROTATION_ALIVE_EVERY_ROUNDS = 64;

export class ALInboundMessageRuntime {
    private readonly admissionStore: ALInboundAdmissionStore;
    private readonly readyPromise: Promise<void>;

    private readonly admission: ALInboundMessageAdmission;
    private readonly controlAdmission: ALInboundControlAdmission;
    private readonly delivery: ALInboundAdmittedDelivery;
    private readonly workSelector: ALInboundWorkSelector;
    private readonly work: ALWorkHandler;
    private emptyRoundCount = 0;
    private emptyRoundsFromMs: number | undefined;
    private longestEmptyRoundMs = 0;
    private disposed = false;

    private readonly dependencies: ALInboundMessageRuntime.Dependencies;

    constructor(dependencies: ALInboundMessageRuntime.Dependencies) {
        this.dependencies = dependencies;
        this.admissionStore = dependencies.admissionStore;
        this.readyPromise = this.admissionStore.ready();
        const workPort = createALWorkQueuePort({
            queue: dependencies.workQueue,
            workTypes: new Set([toALInboundWorkType(this.admissionStore.namespace)]),
            leaseMs: AL_INBOUND_WORK_LEASE_MS,
            nowMs: () => dependencies.clock.nowMs(),
            random: dependencies.random
        });
        this.admission = new ALInboundMessageAdmission({ ...dependencies, workPort });
        this.controlAdmission = new ALInboundControlAdmission({
            admissionStore: this.admissionStore,
            port: workPort,
            clock: dependencies.clock,
            newControlId: dependencies.effectPreparation.newControlId,
            retention: this.admissionStore.retention
        });
        this.delivery = new ALInboundAdmittedDelivery(dependencies);
        this.workSelector = createALInboundWorkSelector({
            delivery: this.delivery,
            namespace: this.admissionStore.namespace,
            nowMs: () => dependencies.clock.nowMs()
        });
        this.work = new ALWorkHandler({
            workerId: dependencies.effectWorkerId,
            port: workPort,
            queueEngine: dependencies.queueEngine,
            ownsQueueEngine: dependencies.ownsQueueEngine,
            clock: dependencies.clock,
            pageSize: AL_INBOUND_WORK_PAGE_SIZE,
            // The rotation answers readiness: work the eligibility rules defer must not report as due.
            readNextReadyAtMs: (port) => this.workSelector.readNextReadyAtMs(port),
            // The rotation advances one status per probe, so an answer of its own never stands.
            readinessMemoryMs: AL_WORK_PROBE_EVERY_ROUND,
            selectReady: (port, pageSize) => this.workSelector.selectReady(port, pageSize),
            runClaim: (claim, batchStartedAtMs) => this.runInboundClaim(claim, batchStartedAtMs),
            diagnostics: (event) => this.recordWorkDiagnostics(event)
        });
        if (dependencies.ownsQueueEngine) {
            void this.ready().catch((error) => console.error('Inbound QueueBox startup failed', error));
        }
    }

    async ready(): Promise<void> {
        await this.readyPromise;

        await this.work.ready();
    }

    dispose(): void {
        this.disposed = true;
        this.admission.dispose();
        this.work.dispose();
        this.delivery.dispose();
    }

    async admitIncomingMessage(
        value: unknown,
        source: ALInboundMessageRuntime.Source,
        planIncomingMessage: ALInboundPlanner = this.dependencies.planIncomingMessage
    ): Promise<Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>> {
        if (this.disposed) {
            return Either.ofRight({ kind: 'disposed' });
        }
        const decoded = decodeALMessageValue(value);
        if (decoded.left) {
            return Either.ofLeft(decoded.left);
        }
        const msg = decoded.right!;
        const admitted = await this.admitDecodedMessage(msg, source, planIncomingMessage);
        this.recordAdmissionOutcome(msg, admitted);
        return admitted;
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
        if (event.claimedCount === 0 && event.rejectedCount === 0) {
            this.recordEmptyRotationRound(event);
            return;
        }
        this.dependencies.diagnostics?.({
            kind: 'effect-drain',
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
            queueWaitMs: event.queueWaitMs
        });
    }

    /**
     * Suppressing the empty rounds left the rotation itself unobservable: a committed admission that
     * no drain follows reads the same whether no consumer is registered for its typeId or the
     * rotation stopped running. One event per `AL_INBOUND_ROTATION_ALIVE_EVERY_ROUNDS` of them says
     * which, and carries the wall time they spanned so a slowed rotation reads as a long gap.
     */
    private recordEmptyRotationRound(event: ALWorkBatchDiagnostics): void {
        const nowMs = this.dependencies.clock.nowMs();
        this.emptyRoundCount += 1;
        this.emptyRoundsFromMs ??= nowMs - event.durationMs;
        this.longestEmptyRoundMs = Math.max(this.longestEmptyRoundMs, event.durationMs);
        if (this.emptyRoundCount < AL_INBOUND_ROTATION_ALIVE_EVERY_ROUNDS) {
            return;
        }
        this.dependencies.diagnostics?.({
            kind: 'rotation-alive',
            workerId: event.workerId,
            emptyRoundCount: this.emptyRoundCount,
            durationMs: Math.max(0, nowMs - this.emptyRoundsFromMs),
            longestRoundMs: this.longestEmptyRoundMs
        });
        this.emptyRoundCount = 0;
        this.emptyRoundsFromMs = undefined;
        this.longestEmptyRoundMs = 0;
    }

    /** A value that never decoded has no identity to record; every identity that does gets one event. */
    private recordAdmissionOutcome(
        msg: ALMessage,
        admitted: Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>
    ): void {
        this.dependencies.diagnostics?.({
            kind: 'admission-outcome',
            workerId: this.dependencies.effectWorkerId,
            msgId: msg.id.msgId,
            typeId: msg.payload.typeId,
            ...toALInboundAdmissionDiagnostics(admitted)
        });
    }

    private async admitDecodedMessage(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source,
        planIncomingMessage: ALInboundPlanner
    ): Promise<Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>> {
        const validated = validateALInboundMessage(msg, source, this.dependencies.effectPreparation.selfPeerId);
        if (validated.left) {
            return Either.ofLeft(validated.left);
        }
        await this.ready();
        if (this.disposed) {
            return Either.ofRight({ kind: 'disposed' });
        }
        if (isALControlTypeId(msg.payload.typeId)) {
            return Either.ofRight(await this.admitControlMessage(msg));
        }
        const attempt = await this.admission.attempt(msg, source, planIncomingMessage);
        if (attempt.left) {
            return Either.ofLeft(attempt.left);
        }
        const result = attempt.right!;
        if (result.kind === 'conflict') {
            return Either.ofRight(await this.retainConflictedAdmission(result.pending));
        }
        if (result.wroteWork) {
            this.commitWork();
        }
        return Either.ofRight(result.acceptance);
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
        const acceptance = await this.admission.retainPending(pending);
        if (acceptance.kind === 'pending-admission') {
            this.commitWork();
        }
        return acceptance;
    }

    private async admitControlMessage(msg: ALMessage): Promise<ALInboundMessageRuntime.Acceptance> {
        const admitted = await this.controlAdmission.admit(msg);
        // A control the runtime does not handle or rejects, and one whose commit wrote no work row,
        // have nothing for the worker to claim; only retained work and a written row announce one.
        if (admitted.kind === 'pending-control' || (admitted.kind === 'committed' && admitted.wroteWork)) {
            this.commitWork();
        }
        if (admitted.kind === 'pending-control') {
            return { kind: 'pending-admission' };
        }
        const acceptance: ALControlAcceptance = admitted.kind === 'committed'
            ? admitted.acceptance
            : { handled: false, completedPendingAcks: [] };
        if (!this.disposed) {
            await this.dependencies.onControlMessage?.(msg, acceptance);
        }
        return { kind: 'control', handled: acceptance.handled };
    }

    /** A commit lands behind the running rotation; the worker restarts it and never waits for delivery. */
    private commitWork(): void {
        this.workSelector.restartScan();
        this.work.committed();
    }

    /**
     * One claim, timed and named: the batch above reports the whole drain, and a drain that crawls is
     * only readable once each claim says which message it ran and how long that one took. A row that
     * cannot be decoded, and a claim that throws, name no payload here; the batch still counts them.
     */
    private async runInboundClaim(claim: ALWorkClaim, batchStartedAtMs: number): Promise<ALWorkOutcome> {
        const effect = decodeALInboundWorkEntry(claim.entry, this.admissionStore.namespace);
        const startedAtMs = this.dependencies.clock.nowMs();
        const outcome = await this.runInboundEffect(effect);
        this.recordClaimSettled({
            claim,
            effect,
            outcome,
            durationMs: Math.max(0, this.dependencies.clock.nowMs() - startedAtMs),
            batchStartedAtMs
        });
        return outcome;
    }

    private recordClaimSettled(settled: ALInboundClaimSettlement): void {
        this.dependencies.diagnostics?.({
            kind: 'claim-settled',
            workerId: this.dependencies.effectWorkerId,
            ...toALInboundClaimIdentity(settled.effect.payload),
            payloadKind: settled.effect.payload.kind,
            durationMs: settled.durationMs,
            attempts: settled.claim.attempts,
            outcome: settled.outcome.status,
            queueWaitMs: Math.max(
                0,
                settled.batchStartedAtMs - resolveALInboundWorkDueAtMs(settled.claim.entry)
            )
        });
    }

    /**
     * A replay commits inside the batch that claimed it, so the work it wrote is behind the page that
     * batch already read. Announcing it here is what gives that work the batch this batch's end runs,
     * instead of the next round the rotation happens to reach.
     */
    private async runInboundEffect(effect: ALPersistedInboundEffect): Promise<ALWorkOutcome> {
        const payload = effect.payload;
        if (payload.kind === 'admit-message') {
            const replayed = await this.admission.replay(payload);
            if (replayed.wroteWork) {
                this.commitWork();
            }
            return toALInboundReplayOutcome(replayed.outcome, this.dependencies.clock.nowMs());
        }
        if (payload.kind === 'admit-control') {
            const replayed = await this.controlAdmission.replay(payload);
            if (replayed.wroteWork) {
                this.commitWork();
            }
            if (replayed.acceptance !== undefined && !this.disposed) {
                await this.dependencies.onControlMessage?.(payload.msg, replayed.acceptance);
            }
            return replayed.outcome;
        }
        return {
            status: await this.delivery.deliver(effect, this.workSelector.getDeliveryObservation(effect.effectId))
        };
    }
}

/** One settled claim's measurements, so the event that reports them is built from one input. */
interface ALInboundClaimSettlement {
    readonly claim: ALWorkClaim;
    readonly effect: ALPersistedInboundEffect;
    readonly outcome: ALWorkOutcome;
    readonly durationMs: number;
    readonly batchStartedAtMs: number;
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
