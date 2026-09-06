import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALRepairAlgo, ALSupersedenceAlgo } from '../../al-contracts/al-policy.ts';
import type { ResilienceDto } from '../../queuebox/DequeueResourceEntryController.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '../../services/QueueBoxUtilities.ts';
import type {
    ALOutboundAdmissionStore,
    ALOutboundPreparedMessageDecoder,
    ALPersistedOutboundEffect
} from './al-outbound-admission-store.ts';
import { ALOutboundDispatchAdmission } from './al-outbound-dispatch-admission.ts';
import {
    ALOutboundEffectDrain,
    computeALOutboundEffectRetryDelayMs,
    type ALOutboundEffectDisposition,
    type ALOutboundEffectRunResult
} from './al-outbound-effect-drain.ts';
import { ALOutboundRepairAdmission } from './al-outbound-repair-admission.ts';
import type { ALOutboundComputedDto } from './compute-al-outbound-dispatch.ts';

export type ALOutboundDispatchPhase = 'immediate' | 'dequeue';

export interface ALOutboundSettledSendResult {
    readonly status: 'sent' | 'no-targets' | 'not-ready' | 'cancelled' | 'expired' | 'superseded';
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

    export interface Scheduler {
        /** Runs the callback once after the delay; cancellation prevents a pending invocation. */
        schedule(callback: () => void, delayMs: number): () => void;
    }

    export interface BrowserLocks {
        /** Holds the named exclusive lock until the single callback invocation settles. */
        request<T>(name: string, options: Readonly<{ mode: 'exclusive'; }>, callback: () => Promise<T>): Promise<T>;
    }

    export interface Resources {
        readonly admissionStore: ALOutboundAdmissionStore;
        readonly effectWorkerId: string;
        readonly clock: Clock;
        readonly scheduler: Scheduler;
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
        readonly onFallbackDequeue: ((msg: ALMessage, entry: ResourceEntry) => Promise<void>) | undefined;
        readonly diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
    }
}

export class ALOutboundMessageRuntime<TPrepared> {
    private readonly sendAbortController = new AbortController();
    private readonly readyPromise: Promise<void>;
    private readonly dispatchAdmission: ALOutboundDispatchAdmission<TPrepared>;
    private readonly repairAdmission: ALOutboundRepairAdmission<TPrepared>;
    private readonly effectDrain: ALOutboundEffectDrain<TPrepared>;
    private disposed = false;
    private readonly dependencies: ALOutboundMessageRuntime.Dependencies<TPrepared>;

    constructor(dependencies: ALOutboundMessageRuntime.Dependencies<TPrepared>) {
        this.dependencies = dependencies;
        this.readyPromise = dependencies.admissionStore.ready();
        this.dispatchAdmission = new ALOutboundDispatchAdmission({
            admissionStore: dependencies.admissionStore,
            toOutboxEntry: dependencies.toOutboxEntry,
            canFallback: dependencies.onFallbackDequeue !== undefined,
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
        this.effectDrain = new ALOutboundEffectDrain({
            admissionStore: dependencies.admissionStore,
            effectWorkerId: dependencies.effectWorkerId,
            clock: dependencies.clock,
            scheduler: dependencies.scheduler,
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

        await this.effectDrain.ready();
    }

    dispose(): void {
        this.disposed = true;
        this.effectDrain.dispose();
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
            message: msg,
            entry: computed.entries[0],
            entries: computed.entries,
            reason: computed.reason
        };
    }

    async dequeue(
        typesToDequeue: Set<string>,
        resilience: ResilienceDto
    ): Promise<void> {
        if (this.disposed) {
            return;
        }
        await this.ready();
        if (this.disposed) {
            return;
        }
        await QueueBoxUtilities.defaultDequeue(
            this.dependencies.outbox,
            typesToDequeue,
            resilience,
            async (entry) => {
                const msg = this.dependencies.readMessageFromEntry(entry);
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
                        fallbackEntry: entry
                    }
                });
                if (computed.status === 'no-route' && !clusterPublished) {
                    throw new Error(computed.reason);
                }
            }
        );
    }

    async acceptControlMessage(msg: ALMessage): Promise<boolean> {
        await this.ready();
        if (this.disposed) {
            return false;
        }

        const acceptance = await this.repairAdmission.acceptControlMessage(msg);
        if (!acceptance.handled) {
            return false;
        }

        if (acceptance.retryAtMs !== undefined) {
            this.effectDrain.scheduleAt(acceptance.retryAtMs);
        }
        await this.effectDrain.requestCommittedDrain();
        return true;
    }

    private async commitDispatchPlan(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>
    ): Promise<ALOutboundComputedDto<TPrepared>> {
        const result = await this.dispatchAdmission.commit(dispatch);

        if (result.committed) {
            await this.effectDrain.drainCommitted();
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
        effect: ALPersistedOutboundEffect<TPrepared>
    ): Promise<ALOutboundEffectRunResult> {
        if (effect.expireAtTimestamp <= this.readNowMs()) {
            return { status: 'completed' };
        }

        switch (effect.payload.kind) {
            case 'send-prepared': {
                const sendResult = await this.dependencies.sendPreparedMessage(
                    effect.payload.prepared,
                    effect.payload.phase,
                    {
                        signal: this.sendSignal,
                        expiresAtMs: effect.expireAtTimestamp,
                        leaseUntilMs: effect.leaseUntilMs
                    }
                );
                if (sendResult.status === 'queued') {
                    return {
                        status: 'retained',
                        settled: sendResult.settled.then((settled) =>
                            computeALOutboundSendDisposition(settled, this.readNowMs(), effect.attempts)
                        )
                    };
                }
                return computeALOutboundSendDisposition(sendResult, this.readNowMs(), effect.attempts);
            }
            case 'enqueue-outbox':
                if (effect.payload.replaceExisting) {
                    await this.dependencies.outbox.enqueue(effect.payload.entry);
                    return { status: 'completed' };
                }

                await this.dependencies.outbox.enqueueIfAbsent(effect.payload.entry);
                return { status: 'completed' };
            case 'fallback-dispatch':
                if (this.dependencies.onFallbackDequeue) {
                    await this.dependencies.onFallbackDequeue(effect.payload.msg, effect.payload.entry);
                }
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

    private readNowMs(): number {
        return this.dependencies.clock.nowMs();
    }
}

function computeALOutboundSendDisposition(
    result: ALOutboundSettledSendResult,
    observedAtMs: number,
    attempts: number
): ALOutboundEffectDisposition {
    return result.status === 'not-ready'
        ? {
            status: 'reschedule',
            readyAtMs: observedAtMs + Math.max(0, result.retryAfterMs ?? computeALOutboundEffectRetryDelayMs(attempts)),
            reason: result.reason ?? 'Prepared outbound transport is not ready.'
        }
        : { status: 'completed' };
}
