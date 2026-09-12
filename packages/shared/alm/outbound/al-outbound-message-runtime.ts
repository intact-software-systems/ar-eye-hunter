import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALRepairAlgo, ALSupersedenceAlgo } from '../../al-contracts/al-policy.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { isNotReadyException } from '../../queuebox/resource-inbox/not-ready-exception.ts';
import type { ResourceInboxResilience } from '../../queuebox/resource-inbox/resource-inbox-resilience.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import type { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
import type {
    ALDeliveryAdmissionVerdict,
    ALDeliveryCarrier,
    ALDeliverySettlement,
    ALDeliverySettlementSink
} from '../delivery/al-delivery-lifecycle.ts';
import { toALOutboundEnqueueStatus } from '../delivery/to-al-outbound-enqueue-status.ts';
import {
    AL_WORK_READINESS_MEMORY_MS,
    ALWorkHandler,
    type ALWorkAttemptResult,
    type ALWorkDiagnostics,
    type ALWorkReadinessProbeCause,
    type ALWorkReadySelection
} from '../work/al-work-handler.ts';
import {
    createALWorkQueuePort,
    type ALWorkClaim,
    type ALWorkQueuePort
} from '../work/al-work-queue-port.ts';
import type {
    ALOutboundAdmissionStore,
    ALOutboundDurableEffect,
    ALOutboundEffectSnapshot,
    ALOutboundPreparedMessageDecoder
} from './admission/al-outbound-admission-store.ts';
import { ALOutboundDispatchAdmission } from './al-outbound-dispatch-admission.ts';
import { ALOutboundMessageEffects } from './al-outbound-message-effects.ts';
import { ALOutboundRepairAdmission } from './al-outbound-repair-admission.ts';
import { ALOutboundRepairRetransmission } from './al-outbound-repair-retransmission.ts';
import {
    AL_OUTBOUND_WORK_LEASE_MS,
    AL_OUTBOUND_WORK_PAGE_SIZE,
    readALOutboundWorkReadyAt,
    toALOutboundDequeueWork,
    toALOutboundWorkType,
    type ALOutboundDequeueDeferral
} from './al-outbound-work-entry.ts';
import type { ALOutboundComputedDto } from './compute-al-outbound-dispatch.ts';
import type { ALOutboundControlAdmissionResult } from './control/al-outbound-control-admission.ts';

export type {
    ALOutboundControlAdmission,
    ALOutboundControlAdmissionResult
} from './control/al-outbound-control-admission.ts';

export type ALOutboundDispatchPhase = 'immediate' | 'dequeue';

export interface ALOutboundSettledSendResult {
    readonly status: 'sent' | 'no-targets' | 'not-ready' | 'failed' | 'cancelled' | 'expired' | 'superseded';
    /** Whether the carrier handed the bytes to its transport; a refusal before that never did. */
    readonly submissionAttempted: boolean;
    readonly reason?: string;
    readonly retryAfterMs?: number;
}

export type ALOutboundPreparedSendResult =
    | ALOutboundSettledSendResult
    | Readonly<{
        status: 'queued';
        /** The transport retains this attempt until exactly one local terminal outcome. */
        settled: Promise<ALOutboundSettledSendResult>;
    }>;

export interface ALOutboundAckTrackingPlan {
    readonly enabled: boolean;
    readonly timeoutMs: number;
    readonly maxAttempts: number;
    readonly expectedPeerIds: readonly string[];
    readonly mode?: 'merge' | 'replace';
}

export interface ALOutboundRepairTrackingPlan {
    readonly enabled: boolean;
    readonly algo: ALRepairAlgo;
    readonly maxAttempts: number;
}

export interface ALOutboundRetryTrackingPlan {
    readonly enabled: boolean;
    readonly maxAttempts: number;
    readonly retryDelayMs?: number;
}

export interface ALOutboundSupersedenceTrackingPlan {
    readonly enabled: boolean;
    readonly algo: ALSupersedenceAlgo;
    readonly key?: string;
    readonly replacesMsgId?: string;
}

export type ALOutboundRepairTrigger = 'ack-timeout' | 'nack' | 'repair';

export interface ALOutboundRepairRequest {
    readonly trigger: ALOutboundRepairTrigger;
    readonly repair: ALOutboundRepairTrackingPlan;
    readonly requestedByPeerId?: string;
    readonly failedPeerIds: readonly string[];
    readonly orderingTrackKey?: string;
    readonly missingSeqs: readonly number[];
}

/** Why a planner dropped the message. `rtc-room-snapshot-admission.ts` sets its two shared values from `ALMessageDropReasonCode`; `'planner-drop'` covers a drop that fits no other code. */
export type ALOutboundDropReasonCode =
    | 'unauthorized'
    | 'not-yet-in-sync'
    | 'no-route'
    | 'superseded'
    | 'expired'
    | 'duplicate'
    | 'planner-drop';

export interface ALOutboundDispatchPlan<TPrepared> {
    readonly msg: ALMessage;
    readonly dropReason?: string;
    /** Required so every planner states its drop code; `undefined` means the plan is not dropping the message. */
    readonly dropReasonCode: ALOutboundDropReasonCode | undefined;
    readonly persist: boolean;
    readonly preparedMessages: readonly TPrepared[];
    readonly ackTracking?: ALOutboundAckTrackingPlan;
    readonly retryTracking?: ALOutboundRetryTrackingPlan;
    readonly repairTracking?: ALOutboundRepairTrackingPlan;
    readonly supersedenceTracking?: ALOutboundSupersedenceTrackingPlan;
}

export interface ALOutboundRuntimeStores<TPrepared> {
    readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
    readonly workQueue: QueueBoxResourceEntryRepository;
}
/** The call path that asked for a commit, so its wait and its hold are charged to the work behind it. */
export type ALOutboundCommitOrigin = 'send' | 'drain' | 'repair';

/** What the write transaction returned, or that the admission settled before opening one. */
export type ALOutboundCommitBundleOutcome = 'committed' | 'conflict' | 'expired' | 'not-attempted';

export type ALOutboundRuntimeDiagnosticsEvent =
    | Readonly<{
        kind: 'sender-queue-wait';
        senderId: string;
        origin: ALOutboundCommitOrigin;
        queued: boolean;
        /** `none` when this commit found the sender's queue empty. */
        queuedBehindOrigin: ALOutboundCommitOrigin | 'none';
        durationMs: number;
    }>
    | Readonly<{
        kind: 'browser-lock-wait';
        senderId: string;
        origin: ALOutboundCommitOrigin;
        lockName: string;
        available: boolean;
        durationMs: number;
    }>
    | Readonly<{
        kind: 'browser-lock-hold';
        senderId: string;
        origin: ALOutboundCommitOrigin;
        lockName: string;
        available: boolean;
        durationMs: number;
    }>
    | Readonly<{
        kind: 'commit-phases';
        senderId: string;
        /** The message this commit admitted, so one signaling offer can be followed across the phases. */
        msgId: string;
        /** The message's payload type: which lane the commit belongs to (RTC signaling, app traffic, control). */
        typeId: string;
        origin: ALOutboundCommitOrigin;
        readDurationMs: number;
        /** Admission-store round trips observed while this commit's read chain ran. */
        readOperationCount: number;
        commitDurationMs: number;
        commitOutcome: ALOutboundCommitBundleOutcome;
    }>
    | Readonly<{
        kind: 'effect-drain';
        workerId: string;
        durationMs: number;
        claimedCount: number;
        completedCount: number;
        rescheduledCount: number;
        rejectedCount: number;
    }>
    | Readonly<{
        kind: 'readiness-probe';
        workerId: string;
        /** Which invalidation emptied this owner's readiness memory, or that it had none yet. */
        cause: ALWorkReadinessProbeCause;
        /** The answer storage gave: when work is next due, or `none` for no work at all. */
        readyAtMs: number | 'none';
        /** What that storage read cost: the page read the batch behind a "due now" answer then reuses. */
        durationMs: number;
    }>;

export type ALOutboundRuntimeDiagnosticsSink = (
    event: ALOutboundRuntimeDiagnosticsEvent
) => void;

/** Every settlement variant without the two fields the runtime stamps for its owners. */
type ALOutboundUnstampedSettlement<TSettlement> = TSettlement extends ALDeliverySettlement ?
    Omit<TSettlement, 'carrier' | 'atMs'> :
    never;

/** One delivery fact as the owner that observed it states it, before the runtime stamps it. */
export type ALOutboundSettlementFact = ALOutboundUnstampedSettlement<ALDeliverySettlement>;

/**
 * The already-guarded sink an outbound owner states one delivery fact to. The runtime owns the only
 * guard, so a sink that throws never reaches the work that stated the fact.
 */
export type ALOutboundSettlementEmitter = (fact: ALOutboundSettlementFact) => void;

export type ALOutboundEnqueueStatus =
    | 'pending-admission'
    | 'enqueued'
    | 'accepted'
    | 'skipped'
    | 'duplicate'
    | 'superseded'
    | 'expired'
    | 'no-route'
    | 'rate-limited'
    | 'circuit-open'
    | 'failed';

export interface ALOutboundEnqueueResult {
    readonly status: ALOutboundEnqueueStatus;
    readonly verdict: ALDeliveryAdmissionVerdict;
    readonly message: ALMessage;
    readonly entry?: ResourceEntry;
    readonly entries: readonly ResourceEntry[];
    readonly reason?: string;
}

export namespace ALOutboundMessageRuntime {
    export type PendingAdmissionAuthority =
        | Readonly<{ status: 'authorized'; }>
        | Readonly<{ status: 'rejected'; reason: string; }>
        | Readonly<{ status: 'not-ready'; reason: string; retryAfterMs: number; }>;
    export interface SendLifecycle {
        readonly canonicalMessage: ALMessage;
        /** This message's own signal: `cancel(msgId)` aborts it directly; disposal aborts every live one. */
        readonly signal: AbortSignal;
        readonly expiresAtMs: number | undefined;
        readonly leaseUntilMs: number | undefined;
    }

    export interface Clock {
        nowMs(): number;
    }

    export interface BrowserLocks {
        /** Holds the named exclusive lock until the single callback invocation settles. */
        request<T>(name: string, options: Readonly<{ mode: 'exclusive'; }>, callback: () => Promise<T>): Promise<T>;
    }

    export interface Resources<TPrepared> {
        readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
        readonly workQueue: QueueBoxResourceEntryRepository;
        readonly effectWorkerId: string;
        readonly clock: Clock;
        readonly random: () => number;
        readonly queueEngine: InboxOutboxEngine;
        readonly ownsQueueEngine: boolean;
        readonly browserLocks: BrowserLocks | undefined;
    }

    export interface DequeueSource {
        /** Foreign queue types whose rows this owner admits and dispatches. */
        readonly types: ReadonlySet<string>;
        readonly resilience: ResourceInboxResilience;
    }

    export interface Dependencies<TPrepared> extends Resources<TPrepared> {
        /** Which transport this owner drives; every settlement it states is stamped with it. */
        readonly carrier: ALDeliveryCarrier;
        readonly dequeue: DequeueSource;
        readonly readPendingAdmissionAuthority?: (
            msg: ALMessage,
            preparedMessages: readonly TPrepared[]
        ) => Promise<PendingAdmissionAuthority>;
        readonly toOutboxEntry: (msg: ALMessage) => ResourceEntry;
        readonly readMessageFromEntry: (entry: ResourceEntry) => ALMessage;
        readonly planOutgoingMessage: (msg: ALMessage) => ALOutboundDispatchPlan<TPrepared>;
        readonly planDequeuedMessage: (msg: ALMessage) => ALOutboundDispatchPlan<TPrepared>;
        readonly afterDequeueAdmission:
            | ((msg: ALMessage, entry: ResourceEntry) => void | Promise<void>)
            | undefined;
        readonly decodePreparedMessage: ALOutboundPreparedMessageDecoder<TPrepared>;
        readonly sendPreparedMessage: (
            prepared: TPrepared,
            phase: ALOutboundDispatchPhase,
            lifecycle: SendLifecycle
        ) => Promise<ALOutboundPreparedSendResult>;
        readonly planRepairMessage:
            | ((
                msg: ALMessage,
                request: ALOutboundRepairRequest
            ) => Promise<ALOutboundDispatchPlan<TPrepared> | undefined>)
            | undefined;
        readonly diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
        readonly settlements: ALDeliverySettlementSink | undefined;
    }
}

/** What a `cancel` call decided: a message the owner never saw still moves the set and returns `cancelled`. */
export type ALOutboundCancelOutcome = 'cancelled' | 'already-cancelled';

/** One message's live transport controller, shared by its concurrent attempts, and how many hold it open. */
interface ALOutboundLiveSendControl {
    readonly controller: AbortController;
    liveAttempts: number;
}

export class ALOutboundMessageRuntime<TPrepared> {
    private readonly sendAbortController = new AbortController();
    /** Held for the owner's lifetime (README "Transport attempt settlement"): never drained, never persisted. */
    private readonly cancelledMsgIds = new Set<string>();
    private readonly liveMessageSendControllers = new Map<string, ALOutboundLiveSendControl>();
    private readonly readyPromise: Promise<void>;
    private readonly dispatchAdmission: ALOutboundDispatchAdmission<TPrepared>;
    private readonly repairAdmission: ALOutboundRepairAdmission<TPrepared>;
    private readonly repairRetransmission: ALOutboundRepairRetransmission<TPrepared>;
    private readonly work: ALWorkHandler;
    private readonly effects: ALOutboundMessageEffects<TPrepared>;
    private disposed = false;
    private readonly dependencies: ALOutboundMessageRuntime.Dependencies<TPrepared>;

    constructor(dependencies: ALOutboundMessageRuntime.Dependencies<TPrepared>) {
        this.dependencies = dependencies;
        this.readyPromise = dependencies.admissionStore.ready();
        const workPort = createALWorkQueuePort({
            queue: dependencies.workQueue,
            workTypes: new Set([
                toALOutboundWorkType(dependencies.admissionStore.namespace),
                ...dependencies.dequeue.types
            ]),
            leaseMs: AL_OUTBOUND_WORK_LEASE_MS,
            nowMs: () => dependencies.clock.nowMs(),
            random: dependencies.random
        });
        const settlements: ALOutboundSettlementEmitter = (fact) => this.emitSettlement(fact);
        const controlAdmission = dependencies.admissionStore.createControlAdmission(
            workPort,
            dependencies.clock,
            settlements
        );
        this.dispatchAdmission = new ALOutboundDispatchAdmission({
            admissionStore: dependencies.admissionStore,
            workPort,
            toOutboxEntry: dependencies.toOutboxEntry,
            decodePreparedMessage: dependencies.decodePreparedMessage,
            clock: dependencies.clock,
            browserLocks: dependencies.browserLocks,
            diagnostics: dependencies.diagnostics
        });
        this.repairAdmission = new ALOutboundRepairAdmission({
            admissionStore: dependencies.admissionStore,
            controlAdmission,
            clock: dependencies.clock,
            planOutgoingMessage: dependencies.planOutgoingMessage,
            planRepairMessage: dependencies.planRepairMessage
        });
        this.repairRetransmission = new ALOutboundRepairRetransmission({
            admissionStore: dependencies.admissionStore,
            dispatchAdmission: this.dispatchAdmission,
            planOutgoingMessage: dependencies.planOutgoingMessage,
            planRepairMessage: dependencies.planRepairMessage
        });
        this.work = new ALWorkHandler({
            workerId: dependencies.effectWorkerId,
            port: workPort,
            queueEngine: dependencies.queueEngine,
            ownsQueueEngine: dependencies.ownsQueueEngine,
            clock: dependencies.clock,
            pageSize: AL_OUTBOUND_WORK_PAGE_SIZE,
            readNextReadyAtMs: (port) => readALOutboundWorkReadyAt(port, this.readNowMs(), this.readDequeueDeferral()),
            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
            selectReady: (port, pageSize) => this.selectOutboundWork(port, pageSize),
            runClaim: (claim) => this.runOutboundClaim(claim),
            diagnostics: (event) => this.recordWorkDiagnostics(event)
        });
        this.effects = new ALOutboundMessageEffects({
            runtime: dependencies,
            dispatchAdmission: this.dispatchAdmission,
            commitDispatchPlan: (dispatch) => this.commitDispatchPlan(dispatch),
            sendSignal: this.sendAbortController.signal,
            settlements
        });
    }

    async ready(): Promise<void> {
        await this.readyPromise;

        if (this.disposed) {
            return;
        }

        await this.work.ready();
    }

    dispose(): void {
        this.disposed = true;
        this.work.dispose();
        this.dispatchAdmission.dispose();
        // Every live message controller first: disposal ends local transport work, same as cancellation
        // does, but states no `cancelled` fact of its own. Each interrupted attempt still terminates
        // through its own `attempt-settled cancelled` -- the effects layer states it directly when the
        // abort lands before the carrier runs, the carrier's own settlement when it lands during the send.
        for (const live of this.liveMessageSendControllers.values()) {
            live.controller.abort();
        }
        this.sendAbortController.abort();
    }

    get sendSignal(): AbortSignal {
        return this.sendAbortController.signal;
    }

    /**
     * Cancels one message for this owner's lifetime. A message the owner never admitted is still
     * remembered, so a row later claimed for it completes without sending; a message with a live
     * attempt has that attempt's transport signal aborted. Idempotent: only the first call states the
     * `cancelled` settlement.
     */
    cancel(msgId: string): ALOutboundCancelOutcome {
        if (this.cancelledMsgIds.has(msgId)) {
            return 'already-cancelled';
        }
        this.cancelledMsgIds.add(msgId);
        this.liveMessageSendControllers.get(msgId)?.controller.abort();
        this.emitSettlement({ kind: 'cancelled', msgId });
        return 'cancelled';
    }

    async enqueueIfAbsent(
        msg: ALMessage,
        dispatchPlan?: ALOutboundDispatchPlan<TPrepared>
    ): Promise<ALOutboundEnqueueResult> {
        if (this.disposed) {
            return ALOutboundMessageRuntime.toDisposedEnqueueResult(msg);
        }

        await this.ready();
        if (this.disposed) {
            return ALOutboundMessageRuntime.toDisposedEnqueueResult(msg);
        }

        const computed = await this.commitDispatchPlan({
            msg,
            planner: dispatchPlan === undefined
                ? this.dependencies.planOutgoingMessage
                : () => dispatchPlan,
            intent: 'enqueue',
            phase: 'immediate',
            origin: 'send',
            options: { explicitPlan: dispatchPlan !== undefined }
        });
        return {
            status: computed.status,
            verdict: computed.verdict,
            message: computed.msg ?? msg,
            entry: computed.entries[0],
            entries: computed.entries,
            reason: computed.reason
        };
    }

    async acceptControlMessage(msg: ALMessage): Promise<ALOutboundControlAdmissionResult> {
        await this.ready();
        if (this.disposed) {
            return { kind: 'not-handled' };
        }

        const admitted = await this.repairAdmission.acceptControlMessage(msg);
        // A foreign control and a rejected one write nothing, so they owe no batch.
        if (admitted.kind === 'committed' || admitted.kind === 'pending-control') {
            this.work.committed();
        }
        return admitted;
    }

    private async commitDispatchPlan(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>
    ): Promise<ALOutboundComputedDto<TPrepared>> {
        const result = await this.dispatchAdmission.commit(dispatch);

        if (result.committed || result.computed.status === 'pending-admission') {
            this.work.committed();
        }

        return result.computed;
    }

    private static toDisposedEnqueueResult(msg: ALMessage): ALOutboundEnqueueResult {
        const verdict: ALDeliveryAdmissionVerdict = {
            kind: 'skipped',
            reason: 'disposed',
            detail: 'Outbound runtime is disposed.'
        };
        return {
            status: toALOutboundEnqueueStatus(verdict),
            verdict,
            message: msg,
            entries: [],
            reason: 'Outbound runtime is disposed.'
        };
    }

    /** The outbound owner reserves straight from the queue, so it reads no page and observes no row's wait. */
    private async selectOutboundWork(
        port: ALWorkQueuePort,
        pageSize: number
    ): Promise<ALWorkReadySelection> {
        const startedAtMs = this.readNowMs();
        const claims = await port.claim({ maxCount: pageSize, observedEntries: undefined });
        return {
            claims,
            nextReadyAtMs: undefined,
            selectionDurationMs: 0,
            claimDurationMs: Math.max(0, this.readNowMs() - startedAtMs),
            earliestDueAtMs: undefined
        };
    }

    /** An open dequeue circuit must not advertise its rows, or every batch claims and releases them. */
    private readDequeueDeferral(): ALOutboundDequeueDeferral {
        const { types, resilience } = this.dependencies.dequeue;
        return {
            types,
            readyAtMs: resilience.isNotAllowedThroughToDequeue()
                ? this.readNowMs() + resilience.toCircuitOpenBackoffMs()
                : undefined
        };
    }

    private async runOutboundClaim(claim: ALWorkClaim): Promise<ALWorkAttemptResult> {
        try {
            const work = await this.readExpirableOutboundWork(claim.entry);
            return work === undefined ? { status: 'completed' } : await this.runDurableEffect(work);
        }
        catch (error) {
            // A planner that is still waiting for authority owes no attempt: reschedule, never charge it.
            if (error instanceof Error && isNotReadyException(error)) {
                return { status: 'not-ready', readyAtMs: this.readNowMs() + error.delayMs };
            }
            throw error;
        }
    }

    /** A deadline crossed during the read is expiry, not a defect: the work is dropped, not rejected. */
    private async readExpirableOutboundWork(
        entry: ResourceEntry
    ): Promise<ALOutboundEffectSnapshot<TPrepared> | undefined> {
        try {
            return await this.readOutboundWork(entry);
        }
        catch (error) {
            if (this.hasReachedDeadline(entry)) {
                return undefined;
            }
            throw error;
        }
    }

    private hasReachedDeadline(entry: ResourceEntry): boolean {
        return entry.audit.expiryTs.epochMilliseconds <= this.readNowMs();
    }

    private async readOutboundWork(entry: ResourceEntry): Promise<ALOutboundEffectSnapshot<TPrepared>> {
        return this.dependencies.dequeue.types.has(entry.typeId)
            ? toALOutboundDequeueWork(entry, this.dependencies.readMessageFromEntry)
            : await this.dependencies.admissionStore.readWorkSnapshot(entry);
    }

    private async runDurableEffect(
        effect: ALOutboundEffectSnapshot<TPrepared>
    ): Promise<ALWorkAttemptResult> {
        // Before anything else: a cancelled message's remaining work completes silently, of any kind --
        // no `attempt-started`, no `expired`, no repair. A live attempt already past `attempt-started`
        // still terminates its own `attempt-settled cancelled` -- stated by the effects layer if the
        // abort lands before the carrier runs, or by the carrier's own settlement if it lands during it.
        if (this.isCancelledEffect(effect)) {
            return { status: 'completed' };
        }
        if (effect.expireAtTimestamp <= this.readNowMs()) {
            this.emitWorkExpiry(effect);
            return { status: 'completed' };
        }

        switch (effect.payload.kind) {
            case 'admit-message':
                return await this.effects.admitPendingMessage(effect);
            case 'dequeue-message':
                return await this.effects.admitDequeuedMessage(effect);
            case 'admit-control':
                return await this.repairAdmission.replayControlAdmission(effect.payload);
            case 'send-prepared':
                return await this.runPreparedSend(effect, effect.payload);
            case 'ack-timeout':
                await this.repairAdmission.retryPendingAck(effect.payload.msgId);
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
        }
    }

    private isCancelledEffect(effect: ALOutboundEffectSnapshot<TPrepared>): boolean {
        const msgId = resolveALOutboundEffectMsgId(effect);
        return msgId !== undefined && this.cancelledMsgIds.has(msgId);
    }

    /** One attempt on one prepared copy: the attempt is stated before its carrier can settle it. */
    private async runPreparedSend(
        effect: ALOutboundEffectSnapshot<TPrepared>,
        payload: Extract<ALOutboundDurableEffect<TPrepared>, { kind: 'send-prepared'; }>
    ): Promise<ALWorkAttemptResult> {
        const canonicalMessage = effect.canonicalMessage;
        if (!canonicalMessage) {
            throw new NonRetryableException('Prepared work has no canonical message');
        }
        const msgId = canonicalMessage.id.msgId;
        const signal = this.acquireMessageSendSignal(msgId);
        this.emitSettlement({
            kind: 'attempt-started',
            msgId,
            attemptId: effect.effectId
        });
        try {
            const result = await this.effects.writePreparedMessage({
                attemptId: effect.effectId,
                payload,
                lifecycle: {
                    canonicalMessage,
                    signal,
                    expiresAtMs: effect.expireAtTimestamp,
                    leaseUntilMs: effect.leaseUntilMs
                },
                attempts: effect.attempts
            });
            this.releaseMessageSendAttemptWhenSettled(msgId, result);
            return result;
        }
        catch (error) {
            this.releaseMessageSendSignal(msgId);
            throw error;
        }
    }

    /**
     * One controller per message, shared by concurrent attempts on it -- the RTC owner commits one
     * `send-prepared` row per next-hop peer, and `cancel` must abort all of them together.
     */
    private acquireMessageSendSignal(msgId: string): AbortSignal {
        const live = this.liveMessageSendControllers.get(msgId);
        if (live) {
            live.liveAttempts += 1;
            return live.controller.signal;
        }
        const controller = new AbortController();
        this.liveMessageSendControllers.set(msgId, { controller, liveAttempts: 1 });
        return controller.signal;
    }

    /** A retained attempt keeps its message controller open until the transport truly settles it. */
    private releaseMessageSendAttemptWhenSettled(msgId: string, result: ALWorkAttemptResult): void {
        if (result.status !== 'retained') {
            this.releaseMessageSendSignal(msgId);
            return;
        }
        const release = () => this.releaseMessageSendSignal(msgId);
        void result.settled.then(release, release);
    }

    private releaseMessageSendSignal(msgId: string): void {
        const live = this.liveMessageSendControllers.get(msgId);
        if (!live) {
            return;
        }
        live.liveAttempts -= 1;
        if (live.liveAttempts <= 0) {
            this.liveMessageSendControllers.delete(msgId);
        }
    }

    /**
     * Only a row whose own deadline *is* the message deadline may call the message expired. A
     * `send-prepared` or `admit-message` row carries the message's `expiresAtMs` as its queue
     * expiry, and a foreign dequeue row is stamped from the same deadline; every other kind expires
     * on a budget of its own -- an `ack-timeout` on the receipt's retry windows, a `nack-retry` on
     * its schedule -- and says nothing about the message.
     */
    private emitWorkExpiry(effect: ALOutboundEffectSnapshot<TPrepared>): void {
        const msgId = effect.canonicalMessage?.id.msgId;
        if (msgId === undefined || !statesMessageDeadline(effect.payload.kind)) {
            return;
        }
        this.emitSettlement({
            kind: 'expired',
            msgId,
            detail: 'Outbound work reached the message deadline before its attempt ran.'
        });
    }

    /** The one guard over every settlement this owner states: a throwing sink changes no work. */
    private emitSettlement(fact: ALOutboundSettlementFact): void {
        try {
            this.dependencies.settlements?.({
                ...fact,
                carrier: this.dependencies.carrier,
                atMs: this.readNowMs()
            });
        }
        catch (error) {
            console.error('AL outbound delivery settlement sink failed', error);
        }
    }

    /**
     * A probe is reported as it happens rather than folded into the batch: a batch that runs is one
     * of six reasons a probe read storage, and only the reason separates an owner re-reading because
     * it committed from one re-reading because another writer woke every owner on the engine.
     */
    private recordWorkDiagnostics(event: ALWorkDiagnostics): void {
        if (event.kind === 'readiness-probe') {
            this.dependencies.diagnostics?.({
                kind: 'readiness-probe',
                workerId: event.workerId,
                cause: event.cause,
                readyAtMs: event.readyAtMs,
                durationMs: event.durationMs
            });
            return;
        }
        this.dependencies.diagnostics?.({
            kind: 'effect-drain',
            workerId: event.workerId,
            durationMs: event.durationMs,
            claimedCount: event.claimedCount,
            completedCount: event.completedCount,
            rescheduledCount: event.rescheduledCount,
            rejectedCount: event.rejectedCount
        });
    }

    private readNowMs(): number {
        return this.dependencies.clock.nowMs();
    }
}

/** The effect kinds whose queue row expires exactly when the message it carries does. */
function statesMessageDeadline(kind: ALOutboundDurableEffect<unknown>['kind']): boolean {
    return kind === 'send-prepared' || kind === 'admit-message' || kind === 'dequeue-message';
}

/** The message a durable effect names, read from whichever field its own kind carries the id in. */
function resolveALOutboundEffectMsgId<TPrepared>(
    effect: ALOutboundEffectSnapshot<TPrepared>
): string | undefined {
    const { payload } = effect;
    switch (payload.kind) {
        case 'admit-message':
        case 'send-prepared':
            return payload.message.msgId;
        case 'ack-timeout':
        case 'repair-hint':
        case 'nack-retry':
            return payload.msgId;
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
