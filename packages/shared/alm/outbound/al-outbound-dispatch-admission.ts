import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { RetryableConflictError, RetryPolicies, tryWithPolicy } from '../../resilience/TryWith.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type {
    ALOutboundAdmissionStore,
    ALOutboundCommitBundle,
    ALOutboundPreparedMessageDecoder
} from './al-outbound-admission-store.ts';
import type {
    ALOutboundDispatchPhase,
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundRuntimeDiagnosticsEvent,
    ALOutboundRuntimeDiagnosticsSink
} from './al-outbound-message-runtime.ts';
import {
    computeALOutboundDispatch,
    type ALOutboundCommitDispatchOptions,
    type ALOutboundComputedDto,
    type ALOutboundComputeDependencies,
    type ALOutboundComputeIntent
} from './compute-al-outbound-dispatch.ts';

export namespace ALOutboundDispatchAdmission {
    export interface Result<TPrepared> {
        readonly computed: ALOutboundComputedDto<TPrepared>;
        readonly committed: boolean;
    }

    export interface Input<TPrepared> {
        readonly msg: ALMessage;
        readonly planner: (msg: ALMessage) => ALOutboundDispatchPlan<TPrepared>;
        readonly intent: ALOutboundComputeIntent;
        readonly phase: ALOutboundDispatchPhase;
        readonly options: ALOutboundCommitDispatchOptions<TPrepared>;
    }

    export interface Dependencies<TPrepared> {
        readonly admissionStore: ALOutboundAdmissionStore;
        readonly toOutboxEntry: (msg: ALMessage) => ResourceEntry;
        readonly canFallback: boolean;
        readonly decodePreparedMessage: ALOutboundPreparedMessageDecoder<TPrepared>;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly browserLocks: ALOutboundMessageRuntime.BrowserLocks | undefined;
        readonly diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
    }
}

/** Owns the sender-serialized optimistic read/compute/commit boundary, before durable effects run. */
export class ALOutboundDispatchAdmission<TPrepared> {
    private static readonly MAX_COMMIT_ATTEMPTS = 10;
    private static readonly COMMIT_RETRY_INTERVAL_MSECS = 10;
    private static readonly COMMIT_MAX_RETRY_INTERVAL_MSECS = 50;
    private static readonly COMMIT_MAX_ELAPSED_MSECS = 500;
    static readonly COMMIT_RETRY_POLICY = RetryPolicies
        .optimisticCommit('al-outbound-commit')
        .maxAttempts(ALOutboundDispatchAdmission.MAX_COMMIT_ATTEMPTS)
        .retryIntervalMsecs(ALOutboundDispatchAdmission.COMMIT_RETRY_INTERVAL_MSECS)
        .maxRetryIntervalMsecs(
            ALOutboundDispatchAdmission.COMMIT_MAX_RETRY_INTERVAL_MSECS
        )
        .maxElapsedMsecs(ALOutboundDispatchAdmission.COMMIT_MAX_ELAPSED_MSECS);

    private readonly admissionStore: ALOutboundAdmissionStore;
    private readonly commitQueuesBySenderId = new Map<string, Promise<void>>();
    private disposed = false;
    private readonly dependencies: ALOutboundDispatchAdmission.Dependencies<TPrepared>;

    constructor(dependencies: ALOutboundDispatchAdmission.Dependencies<TPrepared>) {
        this.dependencies = dependencies;
        this.admissionStore = dependencies.admissionStore;
    }

    dispose(): void {
        this.disposed = true;
    }

    async commit(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>
    ): Promise<ALOutboundDispatchAdmission.Result<TPrepared>> {
        return await this.withSenderCommitQueue(
            dispatch.msg.id.senderId,
            () => this.commitDispatchPlanWithRetryNow(dispatch)
        );
    }

    private async commitDispatchPlanWithRetryNow(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>
    ): Promise<ALOutboundDispatchAdmission.Result<TPrepared>> {
        try {
            return await tryWithPolicy<ALOutboundDispatchAdmission.Result<TPrepared>>(
                () => this.commitDispatchOnce(dispatch),
                ALOutboundDispatchAdmission.COMMIT_RETRY_POLICY
            );
        }
        catch (error) {
            if (error instanceof ALAdmissionCorruptionError) {
                throw error;
            }
            throw new Error(
                `Failed to commit outbound message after retries: ${dispatch.msg.id.msgId}`,
                { cause: error }
            );
        }
    }

    private async commitDispatchOnce(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>
    ): Promise<ALOutboundDispatchAdmission.Result<TPrepared>> {
        if (this.disposed) {
            return { computed: ALOutboundDispatchAdmission.toDisposedComputed(), committed: false };
        }

        const read = await this.admissionStore.readOutgoingMessage(dispatch.msg, dispatch.planner);
        if (this.disposed) {
            return { computed: ALOutboundDispatchAdmission.toDisposedComputed(), committed: false };
        }

        const computed = computeALOutboundDispatch({
            read,
            dependencies: this.toComputeDependencies(),
            intent: dispatch.intent,
            phase: dispatch.phase,
            options: dispatch.options
        });
        this.logDispatchDecision(computed, read.plan);
        if (!computed.bundle) {
            return { computed, committed: false };
        }
        if (this.disposed) {
            return { computed: ALOutboundDispatchAdmission.toDisposedComputed(), committed: false };
        }

        const status = await this.admissionStore.commitBundle(
            this.toRuntimeClockedBundle(computed.bundle),
            this.dependencies.decodePreparedMessage
        );
        if (status === 'conflict') {
            throw new RetryableConflictError('Outbound commit conflict');
        }

        return { computed, committed: true };
    }

    private logDispatchDecision(
        computed: ALOutboundComputedDto<TPrepared>,
        plan: ALOutboundDispatchPlan<TPrepared>
    ): void {
        if (plan.dropReason) {
            if (!plan.dropReason.includes('Skipping')) {
                console.warn(`Skipping outbound dispatch: ${plan.dropReason}`);
            }
            return;
        }
        if (computed.status === 'superseded' || computed.status === 'no-route') {
            console.warn(computed.reason);
        }
    }

    private static toDisposedComputed<TPrepared>(): ALOutboundComputedDto<TPrepared> {
        return {
            status: 'skipped',
            entries: [],
            reason: 'Outbound runtime is disposed.'
        };
    }

    private toRuntimeClockedBundle(
        bundle: ALOutboundCommitBundle<TPrepared>
    ): ALOutboundCommitBundle<TPrepared> {
        if (bundle.durableEffects.length === 0) {
            return bundle;
        }

        const nowMs = this.readNowMs();
        return {
            ...bundle,
            durableEffects: bundle.durableEffects.map((effect) =>
                effect.retryAtMs === undefined
                    ? { ...effect, retryAtMs: nowMs }
                    : effect
            )
        };
    }

    private async withSenderCommitQueue<T>(
        senderId: string,
        task: () => Promise<T>
    ): Promise<T> {
        const existing = this.commitQueuesBySenderId.get(senderId);
        const previous = existing ?? Promise.resolve();
        const waitStartedAtMs = this.readNowMs();
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.catch(() => undefined).then(() => gate);
        this.commitQueuesBySenderId.set(senderId, tail);

        await previous.catch(() => undefined);
        this.emitDiagnostics({
            kind: 'sender-queue-wait',
            senderId,
            queued: existing !== undefined,
            durationMs: this.elapsedSince(waitStartedAtMs)
        });

        try {
            return await this.withCrossContextCommitLock(senderId, task);
        }
        finally {
            release?.();
            if (this.commitQueuesBySenderId.get(senderId) === tail) {
                this.commitQueuesBySenderId.delete(senderId);
            }
        }
    }

    private async withCrossContextCommitLock<T>(
        senderId: string,
        task: () => Promise<T>
    ): Promise<T> {
        const lockName = `rallar:al-outbound-commit:${senderId}`;
        const locks = this.dependencies.browserLocks;
        if (!locks) {
            this.emitDiagnostics({
                kind: 'browser-lock-wait',
                senderId,
                lockName,
                available: false,
                durationMs: 0
            });
            const holdStartedAtMs = this.readNowMs();
            try {
                return await task();
            }
            finally {
                this.emitDiagnostics({
                    kind: 'browser-lock-hold',
                    senderId,
                    lockName,
                    available: false,
                    durationMs: this.elapsedSince(holdStartedAtMs)
                });
            }
        }

        const waitStartedAtMs = this.readNowMs();
        return await locks.request(
            lockName,
            { mode: 'exclusive' },
            async () => {
                this.emitDiagnostics({
                    kind: 'browser-lock-wait',
                    senderId,
                    lockName,
                    available: true,
                    durationMs: this.elapsedSince(waitStartedAtMs)
                });
                const holdStartedAtMs = this.readNowMs();
                try {
                    return await task();
                }
                finally {
                    this.emitDiagnostics({
                        kind: 'browser-lock-hold',
                        senderId,
                        lockName,
                        available: true,
                        durationMs: this.elapsedSince(holdStartedAtMs)
                    });
                }
            }
        );
    }

    private readNowMs(): number {
        return this.dependencies.clock.nowMs();
    }

    private elapsedSince(startedAtMs: number): number {
        return Math.max(0, this.readNowMs() - startedAtMs);
    }

    private emitDiagnostics(event: ALOutboundRuntimeDiagnosticsEvent): void {
        try {
            this.dependencies.diagnostics?.(event);
        }
        catch (error) {
            console.error('AL outbound runtime diagnostics sink failed', error);
        }
    }

    private toComputeDependencies(): ALOutboundComputeDependencies {
        return {
            toOutboxEntry: this.dependencies.toOutboxEntry,
            canFallback: this.dependencies.canFallback
        };
    }
}
