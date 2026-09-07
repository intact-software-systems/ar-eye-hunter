import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALRepairAlgo, ALSupersedenceAlgo } from '../../al-contracts/al-policy.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceInboxResilience } from '../../queuebox/resource-inbox/resource-inbox-resilience.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY, retryAfterAttempt } from '../../queuebox/ResourceInboxRetryPolicy.ts';
import type { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '../../services/queue-box-utilities.ts';
import type {
    ALOutboundAdmissionStore,
    ALOutboundDurableEffect,
    ALOutboundEffectSnapshot,
    ALOutboundPreparedMessageDecoder
} from './al-outbound-admission-store.ts';
import { ALOutboundDispatchAdmission } from './al-outbound-dispatch-admission.ts';
import { ALOutboundRepairAdmission } from './al-outbound-repair-admission.ts';
import {
    ALOutboundWorkHandler,
    type ALOutboundWorkAttemptResult,
    type ALOutboundWorkDisposition
} from './al-outbound-work-handler.ts';
import type { ALOutboundComputedDto } from './compute-al-outbound-dispatch.ts';
import { isALOutboundReceiptComplete } from './transition-al-outbound-pending-ack.ts';

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

export interface ALOutboundRuntimeStores {
    readonly admissionStore: ALOutboundAdmissionStore;
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
        skippedExpiredCount: number;
    }>;

export type ALOutboundRuntimeDiagnosticsSink = (
    event: ALOutboundRuntimeDiagnosticsEvent
) => void;

export type ALOutboundEnqueueStatus =
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
    export interface SendLifecycle {
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

    export interface Resources {
        readonly admissionStore: ALOutboundAdmissionStore;
        readonly effectWorkerId: string;
        readonly clock: Clock;
        readonly queueEngine: InboxOutboxEngine;
        readonly ownsQueueEngine: boolean;
        readonly browserLocks: BrowserLocks | undefined;
    }

    export interface Dependencies<TPrepared> extends Resources {
        readonly outbox: QueueBoxResourceEntryRepository;
        readonly toOutboxEntry: (msg: ALMessage) => ResourceEntry;
        readonly readMessageFromEntry: (entry: ResourceEntry) => ALMessage;
        readonly planOutgoingMessage: (msg: ALMessage) => ALOutboundDispatchPlan<TPrepared>;
        readonly planDequeuedMessage: (msg: ALMessage) => ALOutboundDispatchPlan<TPrepared>;
        readonly beforeDequeueDispatch:
            | ((msg: ALMessage, entry: ResourceEntry) => boolean | Promise<boolean>)
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
    private readonly workHandler: ALOutboundWorkHandler<TPrepared>;
    private disposed = false;
    private readonly dependencies: ALOutboundMessageRuntime.Dependencies<TPrepared>;

    constructor(dependencies: ALOutboundMessageRuntime.Dependencies<TPrepared>) {
        this.dependencies = dependencies;
        this.readyPromise = dependencies.admissionStore.ready();
        this.dispatchAdmission = new ALOutboundDispatchAdmission({
            admissionStore: dependencies.admissionStore,
            toOutboxEntry: dependencies.toOutboxEntry,
            decodePreparedMessage: dependencies.decodePreparedMessage,
            clock: dependencies.clock,
            browserLocks: dependencies.browserLocks,
            diagnostics: dependencies.diagnostics
        });
        this.repairAdmission = new ALOutboundRepairAdmission({
            admissionStore: dependencies.admissionStore,
            dispatchAdmission: this.dispatchAdmission,
            clock: dependencies.clock,
            decodePreparedMessage: dependencies.decodePreparedMessage,
            planOutgoingMessage: dependencies.planOutgoingMessage,
            planRepairMessage: dependencies.planRepairMessage
        });
        this.workHandler = new ALOutboundWorkHandler({
            admissionStore: dependencies.admissionStore,
            effectWorkerId: dependencies.effectWorkerId,
            clock: dependencies.clock,
            queueEngine: dependencies.queueEngine,
            ownsQueueEngine: dependencies.ownsQueueEngine,
            decodePreparedMessage: dependencies.decodePreparedMessage,
            diagnostics: dependencies.diagnostics,
            runEffect: (effect) => this.runDurableEffect(effect)
        });
    }

    async ready(): Promise<void> {
        await this.readyPromise;

        if (this.disposed) {
            return;
        }

        await this.workHandler.ready();
    }

    dispose(): void {
        this.disposed = true;
        this.workHandler.dispose();
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
            options: {}
        });
        return {
            status: computed.status,
            message: computed.msg ?? msg,
            entry: computed.entries[0],
            entries: computed.entries,
            reason: computed.reason
        };
    }

    async dequeue(
        typesToDequeue: Set<string>,
        resilience: ResourceInboxResilience
    ): Promise<void> {
        if (this.disposed) {
            return;
        }
        await this.ready();
        if (this.disposed) {
            return;
        }
        await QueueBoxUtilities.defaultDequeue(
            {
                qbox: this.dependencies.outbox,
                typesToDequeue: typesToDequeue,
                resilience: resilience,
                onDequeuedDo: async (entry) => {
                    const msg = this.readQueuedMessage(entry);
                    const clusterDispatch = this.dependencies.beforeDequeueDispatch?.(msg, entry);
                    const clusterPublished = clusterDispatch === undefined || typeof clusterDispatch === 'boolean'
                        ? clusterDispatch ?? false
                        : await clusterDispatch;
                    const computed = await this.commitDispatchPlan({
                        msg,
                        planner: this.dependencies.planDequeuedMessage,
                        intent: 'dequeue',
                        phase: 'dequeue',
                        options: {
                            observedOutboxEntry: entry
                        }
                    });
                    if (computed.status === 'failed' || (computed.status === 'no-route' && !clusterPublished)) {
                        if (computed.status === 'failed') {
                            throw new NonRetryableException(computed.reason);
                        }
                        throw new Error(computed.reason);
                    }
                },
                options: {}
            }
        );
    }

    private readQueuedMessage(entry: ResourceEntry): ALMessage {
        try {
            return this.dependencies.readMessageFromEntry(entry);
        }
        catch (error) {
            if (error instanceof TypeError) {
                throw new NonRetryableException(error.message);
            }
            throw error;
        }
    }

    async acceptControlMessage(msg: ALMessage): Promise<boolean> {
        await this.ready();
        if (this.disposed) {
            return false;
        }

        const acceptance = await this.repairAdmission.acceptControlMessage(msg);
        if (!acceptance) {
            return false;
        }

        await this.workHandler.requestCommitted();
        return true;
    }

    private async commitDispatchPlan(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>
    ): Promise<ALOutboundComputedDto<TPrepared>> {
        const result = await this.dispatchAdmission.commit(dispatch);

        if (result.committed) {
            await this.workHandler.processCommitted();
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

    private async runDurableEffect(
        effect: ALOutboundEffectSnapshot<TPrepared>
    ): Promise<ALOutboundWorkAttemptResult> {
        if (effect.expireAtTimestamp <= this.readNowMs()) {
            return { status: 'completed' };
        }

        switch (effect.payload.kind) {
            case 'send-prepared':
                return await this.writePreparedMessage(effect.payload, {
                    signal: this.sendSignal,
                    expiresAtMs: effect.expireAtTimestamp,
                    leaseUntilMs: effect.leaseUntilMs
                }, effect.attempts);
            case 'enqueue-outbox':
                if (effect.payload.replaceExisting) {
                    await this.dependencies.outbox.enqueue(effect.payload.entry);
                    return { status: 'completed' };
                }

                await this.dependencies.outbox.enqueueIfAbsent(effect.payload.entry);
                return { status: 'completed' };
            case 'ack-timeout':
                await this.repairAdmission.handlePendingAckTimeout(effect.payload.msgId);
                return { status: 'completed' };
            case 'repair-hint':
                await this.repairAdmission.executeRepairFromHint(
                    effect.payload.msgId,
                    effect.payload.request
                );
                return { status: 'completed' };
            case 'nack-retry':
                await this.repairAdmission.retransmitByMsgId(effect.payload.msgId, {
                    replaceExistingOutbox: true
                });
                return { status: 'completed' };
        }
    }

    private async writePreparedMessage(
        payload: Extract<ALOutboundDurableEffect<TPrepared>, { kind: 'send-prepared'; }>,
        lifecycle: ALOutboundMessageRuntime.SendLifecycle,
        attempts: number
    ): Promise<ALOutboundWorkAttemptResult> {
        const receipts = await this.dependencies.admissionStore.readReceiptState(payload.msg.id.msgId);
        if (receipts && isALOutboundReceiptComplete(receipts)) {
            return { status: 'completed' };
        }
        if (
            (lifecycle.expiresAtMs !== undefined && lifecycle.expiresAtMs <= this.readNowMs()) ||
            lifecycle.signal.aborted
        ) {
            return { status: 'completed' };
        }
        const retry = retryAfterAttempt(DEFAULT_RESOURCE_INBOX_RETRY_POLICY, attempts, Math.random());
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
): ALOutboundWorkDisposition {
    if (timing.expiresAtMs !== undefined && timing.observedAtMs >= timing.expiresAtMs) {
        return { status: 'completed' };
    }
    if (result.status !== 'not-ready' && result.status !== 'failed') {
        return { status: 'completed' };
    }
    const retryAtMs = timing.observedAtMs + Math.max(1, result.retryAfterMs ?? timing.retryDelayMs);
    return {
        status: result.status === 'not-ready' ? 'not-ready' : 'reschedule',
        readyAtMs: result.status === 'not-ready' && timing.expiresAtMs !== undefined
            ? Math.min(retryAtMs, timing.expiresAtMs)
            : retryAtMs
    };
}
