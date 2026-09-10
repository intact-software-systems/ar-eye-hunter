import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALRepairAlgo, ALSupersedenceAlgo } from '../../al-contracts/al-policy.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { isNotReadyException } from '../../queuebox/resource-inbox/not-ready-exception.ts';
import type { ResourceInboxResilience } from '../../queuebox/resource-inbox/resource-inbox-resilience.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY, retryAfterAttempt } from '../../queuebox/ResourceInboxRetryPolicy.ts';
import type { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
import { ALWorkHandler, type ALWorkAttemptResult, type ALWorkReadySelection } from '../work/al-work-handler.ts';
import {
    createALWorkQueuePort,
    type ALWorkClaim,
    type ALWorkOutcome,
    type ALWorkQueuePort
} from '../work/al-work-queue-port.ts';
import type {
    ALOutboundAdmissionStore,
    ALOutboundDurableEffect,
    ALOutboundEffectSnapshot,
    ALOutboundPreparedMessageDecoder
} from './al-outbound-admission-store.ts';
import { ALOutboundDispatchAdmission } from './al-outbound-dispatch-admission.ts';
import { ALOutboundRepairAdmission } from './al-outbound-repair-admission.ts';
import {
    AL_OUTBOUND_WORK_LEASE_MS,
    AL_OUTBOUND_WORK_PAGE_SIZE,
    readALOutboundWorkReadyAt,
    readUnleasedALOutboundWorkClaims,
    toALOutboundDequeueWork,
    toALOutboundWorkType
} from './al-outbound-work-entry.ts';
import type { ALOutboundComputedDto } from './compute-al-outbound-dispatch.ts';
import type { ALOutboundControlAdmissionResult } from './control/al-outbound-control-admission.ts';
import { isALOutboundReceiptComplete } from './transition-al-outbound-pending-ack.ts';

export type {
    ALOutboundControlAdmission,
    ALOutboundControlAdmissionResult
} from './control/al-outbound-control-admission.ts';

export type ALOutboundDispatchPhase = 'immediate' | 'dequeue';

export interface ALOutboundSettledSendResult {
    readonly status: 'sent' | 'no-targets' | 'not-ready' | 'failed' | 'cancelled' | 'expired' | 'superseded';
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

export interface ALOutboundDispatchPlan<TPrepared> {
    readonly msg: ALMessage;
    readonly dropReason?: string;
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
export type ALOutboundRuntimeDiagnosticsEvent =
    | Readonly<{
        kind: 'sender-queue-wait';
        senderId: string;
        queued: boolean;
        durationMs: number;
    }>
    | Readonly<{
        kind: 'browser-lock-wait';
        senderId: string;
        lockName: string;
        available: boolean;
        durationMs: number;
    }>
    | Readonly<{
        kind: 'browser-lock-hold';
        senderId: string;
        lockName: string;
        available: boolean;
        durationMs: number;
    }>
    | Readonly<{
        kind: 'effect-drain';
        workerId: string;
        durationMs: number;
        claimedCount: number;
        completedCount: number;
        rescheduledCount: number;
        rejectedCount: number;
    }>;

export type ALOutboundRuntimeDiagnosticsSink = (
    event: ALOutboundRuntimeDiagnosticsEvent
) => void;

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
        /** The runtime owns this cancellation signal; disposal stops remaining local transport work. */
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
    }
}

export class ALOutboundMessageRuntime<TPrepared> {
    private readonly sendAbortController = new AbortController();
    private readonly readyPromise: Promise<void>;
    private readonly dispatchAdmission: ALOutboundDispatchAdmission<TPrepared>;
    private readonly repairAdmission: ALOutboundRepairAdmission<TPrepared>;
    private readonly work: ALWorkHandler;
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
        const controlAdmission = dependencies.admissionStore.createControlAdmission(workPort, dependencies.clock);
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
            dispatchAdmission: this.dispatchAdmission,
            clock: dependencies.clock,
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
            readNextReadyAtMs: (port) => readALOutboundWorkReadyAt(port, this.readNowMs()),
            selectReady: (port, pageSize) => this.selectOutboundWork(port, pageSize),
            runClaim: (claim) => this.runOutboundClaim(claim),
            diagnostics: (event) =>
                this.dependencies.diagnostics?.({
                    kind: 'effect-drain',
                    workerId: event.workerId,
                    durationMs: event.durationMs,
                    claimedCount: event.claimedCount,
                    completedCount: event.completedCount,
                    rescheduledCount: event.rescheduledCount,
                    rejectedCount: event.rejectedCount
                })
        });
    }

    async ready(): Promise<void> {
        await this.readyPromise;

        if (this.disposed) {
            return;
        }

        await this.work.ready();
    }

    /** Runs one work batch to settlement for a caller that owns no engine tick of its own. */
    async drainWork(): Promise<void> {
        await this.ready();
        if (!this.disposed) {
            await this.work.drain();
        }
    }

    dispose(): void {
        this.disposed = true;
        this.work.dispose();
        this.dispatchAdmission.dispose();
        this.sendAbortController.abort();
    }

    get sendSignal(): AbortSignal {
        return this.sendAbortController.signal;
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
            options: { explicitPlan: dispatchPlan !== undefined }
        });
        return {
            status: computed.status,
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
        this.work.committed();
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
        return {
            status: 'skipped',
            message: msg,
            entries: [],
            reason: 'Outbound runtime is disposed.'
        };
    }

    /**
     * Claims what the port offers plus the reservations no timeout can recover. The unleased sweep is an
     * unreserved page read, so two workers may both sweep the same row; every such row is terminal-bound.
     */
    private async selectOutboundWork(
        port: ALWorkQueuePort,
        pageSize: number
    ): Promise<ALWorkReadySelection> {
        const unleased = await readUnleasedALOutboundWorkClaims(port, pageSize, this.readNowMs());
        const claims = await port.claim({ maxCount: pageSize, observedEntries: undefined });
        return { claims: [...unleased, ...claims], nextReadyAtMs: undefined };
    }

    private async runOutboundClaim(claim: ALWorkClaim): Promise<ALWorkAttemptResult> {
        if (this.hasReachedDeadline(claim.entry)) {
            return { status: 'completed' };
        }
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
        if (effect.expireAtTimestamp <= this.readNowMs()) {
            return { status: 'completed' };
        }

        switch (effect.payload.kind) {
            case 'admit-message':
                return await this.admitPendingMessage(effect);
            case 'dequeue-message':
                return await this.admitDequeuedMessage(effect);
            case 'admit-control':
                return await this.repairAdmission.replayControlAdmission(effect.payload);
            case 'send-prepared':
                if (!effect.canonicalMessage) {
                    throw new NonRetryableException('Prepared work has no canonical message');
                }
                return await this.writePreparedMessage(effect.payload, {
                    canonicalMessage: effect.canonicalMessage,
                    signal: this.sendSignal,
                    expiresAtMs: effect.expireAtTimestamp,
                    leaseUntilMs: effect.leaseUntilMs
                }, effect.attempts);
            case 'ack-timeout':
                await this.repairAdmission.retryPendingAck(effect.payload.msgId);
                return { status: 'completed' };
            case 'repair-hint':
                await this.repairAdmission.retransmitFromRepairHint(
                    effect.payload.msgId,
                    effect.payload.request,
                    effect.effectId
                );
                return { status: 'completed' };
            case 'nack-retry':
                await this.repairAdmission.retransmitByMsgId(effect.payload.msgId, {
                    attemptIdentity: effect.effectId
                });
                return { status: 'completed' };
        }
    }

    private async admitDequeuedMessage(effect: ALOutboundEffectSnapshot<TPrepared>): Promise<ALWorkOutcome> {
        const { resilience } = this.dependencies.dequeue;
        if (resilience.isNotAllowedThroughToDequeue()) {
            return { status: 'not-ready', readyAtMs: this.readNowMs() + resilience.toCircuitOpenBackoffMs() };
        }
        const msg = effect.canonicalMessage;
        if (!msg) {
            throw new NonRetryableException('Dequeued work has no message');
        }
        if (await this.dependencies.admissionStore.isMessageSuperseded(msg)) {
            return { status: 'completed' };
        }
        const computed = await this.commitDispatchPlan({
            msg,
            planner: this.dependencies.planDequeuedMessage,
            intent: 'dequeue',
            phase: 'dequeue',
            options: {
                observedOutboxEntry: effect.entry,
                attemptIdentity: JSON.stringify([
                    'queue',
                    effect.attempts,
                    effect.entry.dequeueAudit.startTs?.toString() ?? null
                ])
            }
        });
        if (computed.status === 'expired' || computed.status === 'superseded' || computed.status === 'skipped') {
            return { status: 'completed' };
        }
        if (computed.status === 'failed') {
            throw new NonRetryableException(computed.reason);
        }
        if (computed.status === 'no-route') {
            resilience.failure();
            return { status: 'retry' };
        }
        resilience.success();
        await this.dependencies.afterDequeueAdmission?.(msg, effect.entry);
        return { status: 'completed' };
    }

    private async admitPendingMessage(effect: ALOutboundEffectSnapshot<TPrepared>): Promise<ALWorkOutcome> {
        const pending = effect.payload;
        const msg = effect.canonicalMessage;
        if (pending.kind !== 'admit-message' || !msg) {
            throw new NonRetryableException('Pending work has no canonical admission');
        }
        const authority = await this.dependencies.readPendingAdmissionAuthority?.(msg, pending.preparedMessages) ??
            { status: 'authorized' };
        if (this.disposed || pending.message.expiresAtMs <= this.readNowMs() || authority.status === 'rejected') {
            return { status: 'completed' };
        }
        if (authority.status === 'not-ready') {
            return { status: 'not-ready', readyAtMs: this.readNowMs() + authority.retryAfterMs };
        }
        await this.dispatchAdmission.commit({
            msg,
            planner: () => ({
                msg,
                persist: pending.policy.persist,
                preparedMessages: pending.preparedMessages,
                ackTracking: pending.policy.ackTracking ?? undefined,
                retryTracking: pending.policy.retryTracking ?? undefined,
                repairTracking: pending.policy.repairTracking ?? undefined,
                supersedenceTracking: pending.policy.supersedenceTracking ?? undefined
            }),
            intent: 'enqueue',
            phase: 'immediate',
            options: { pendingAdmission: effect.entry }
        });
        return { status: 'completed' };
    }

    private async writePreparedMessage(
        payload: Extract<ALOutboundDurableEffect<TPrepared>, { kind: 'send-prepared'; }>,
        lifecycle: ALOutboundMessageRuntime.SendLifecycle,
        attempts: number
    ): Promise<ALWorkAttemptResult> {
        if (await this.dependencies.admissionStore.isMessageSuperseded(lifecycle.canonicalMessage)) {
            return { status: 'completed' };
        }
        const receipts = await this.dependencies.admissionStore.readReceiptState(payload.message.msgId);
        if (receipts && isALOutboundReceiptComplete(receipts)) {
            return { status: 'completed' };
        }
        if (
            (lifecycle.expiresAtMs !== undefined && lifecycle.expiresAtMs <= this.readNowMs()) ||
            lifecycle.signal.aborted
        ) {
            return { status: 'completed' };
        }
        const retry = retryAfterAttempt(DEFAULT_RESOURCE_INBOX_RETRY_POLICY, attempts, this.dependencies.random());
        const sendResult = await this.dependencies.sendPreparedMessage(
            payload.prepared,
            payload.phase,
            lifecycle
        );
        if (sendResult.status === 'queued') {
            return {
                status: 'retained',
                settled: sendResult.settled.then((settled) =>
                    computeALOutboundSendDisposition(settled, {
                        observedAtMs: this.readNowMs(),
                        retryDelayMs: retry.delayMs ?? 0,
                        expiresAtMs: lifecycle.expiresAtMs
                    })
                )
            };
        }
        return computeALOutboundSendDisposition(sendResult, {
            observedAtMs: this.readNowMs(),
            retryDelayMs: retry.delayMs ?? 0,
            expiresAtMs: lifecycle.expiresAtMs
        });
    }

    private readNowMs(): number {
        return this.dependencies.clock.nowMs();
    }
}

interface ALOutboundSettlementTiming {
    readonly observedAtMs: number;
    readonly retryDelayMs: number;
    readonly expiresAtMs: number | undefined;
}

function computeALOutboundSendDisposition(
    result: ALOutboundSettledSendResult,
    timing: ALOutboundSettlementTiming
): ALWorkOutcome {
    if (timing.expiresAtMs !== undefined && timing.observedAtMs >= timing.expiresAtMs) {
        return { status: 'completed' };
    }
    if (result.status !== 'not-ready' && result.status !== 'failed') {
        return { status: 'completed' };
    }
    if (result.status === 'failed') {
        return { status: 'retry' };
    }
    const retryAtMs = timing.observedAtMs + Math.max(1, result.retryAfterMs ?? timing.retryDelayMs);
    return {
        status: 'not-ready',
        readyAtMs: timing.expiresAtMs === undefined ? retryAtMs : Math.min(retryAtMs, timing.expiresAtMs)
    };
}
