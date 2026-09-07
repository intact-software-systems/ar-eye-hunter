import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { RetryableConflictError } from '../../resilience/TryWith.ts';
import type {
    ALOutboundAdmissionStore,
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
    type ALOutboundComputeIntent,
    type ComputeALOutboundDispatchInput
} from './compute-al-outbound-dispatch.ts';
import { validateALOutboundDispatch } from './validate-al-outbound-dispatch.ts';

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
        readonly options: ALOutboundCommitDispatchOptions;
    }

    export interface CommitResultInput<TPrepared> {
        readonly computed: ALOutboundComputedDto<TPrepared>;
        readonly msg: ALMessage;
        readonly intent: ALOutboundComputeIntent;
    }

    export interface Dependencies<TPrepared> {
        readonly admissionStore: ALOutboundAdmissionStore;
        readonly toOutboxEntry: (msg: ALMessage) => ResourceEntry;
        readonly decodePreparedMessage: ALOutboundPreparedMessageDecoder<TPrepared>;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly browserLocks: ALOutboundMessageRuntime.BrowserLocks | undefined;
        readonly diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
    }
}

/** Owns the sender-serialized optimistic read/compute/commit boundary, before durable effects run. */
export class ALOutboundDispatchAdmission<TPrepared> {
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
        try {
            return await this.withSenderCommitQueue(
                dispatch.msg.id.senderId,
                () => this.commitDispatchOnce(dispatch)
            );
        }
        catch (error) {
            if (!(error instanceof NonRetryableException) || dispatch.intent !== 'enqueue') {
                throw error;
            }
            return {
                computed: { msg: dispatch.msg, status: 'failed', reason: error.message, entries: [] },
                committed: false
            };
        }
    }

    private async commitDispatchOnce(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>
    ): Promise<ALOutboundDispatchAdmission.Result<TPrepared>> {
        if (this.disposed) {
            return { computed: ALOutboundDispatchAdmission.toDisposedComputed(), committed: false };
        }

        const input = await this.readDispatch(dispatch);
        if (this.disposed) {
            return { computed: ALOutboundDispatchAdmission.toDisposedComputed(), committed: false };
        }

        const computed = computeALOutboundDispatch(input);
        const validated = validateALOutboundDispatch(input.read, computed);
        if (validated.left) {
            if (dispatch.intent !== 'enqueue') {
                throw new NonRetryableException(validated.left.message);
            }
            return {
                computed: { msg: input.read.msg, status: 'failed', reason: validated.left.message, entries: [] },
                committed: false
            };
        }
        this.logDispatchDecision(computed, input.read.plan);
        if (!computed.bundle) {
            return { computed, committed: false };
        }
        if (this.disposed) {
            return { computed: ALOutboundDispatchAdmission.toDisposedComputed(), committed: false };
        }

        const status = await this.admissionStore.commitBundle(
            computed.bundle,
            this.dependencies.decodePreparedMessage
        );
        return this.toCommitResult(status, { computed, msg: input.read.msg, intent: dispatch.intent });
    }

    private toCommitResult(
        status: 'committed' | 'conflict' | 'expired',
        { computed, msg, intent }: ALOutboundDispatchAdmission.CommitResultInput<TPrepared>
    ): ALOutboundDispatchAdmission.Result<TPrepared> {
        if (status === 'expired') {
            return {
                computed: {
                    msg: msg,
                    status: 'expired',
                    reason: 'Message expired before commit',
                    entries: []
                },
                committed: false
            };
        }
        if (status === 'conflict') {
            if (intent === 'enqueue') {
                return {
                    computed: {
                        msg: msg,
                        status: 'failed',
                        reason: 'Outbound commit conflict',
                        entries: []
                    },
                    committed: false
                };
            }
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

    private async readDispatch(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>
    ): Promise<ComputeALOutboundDispatchInput<TPrepared>> {
        const read = await this.admissionStore.readOutgoingMessage(dispatch.msg, dispatch.planner);
        const needsEntry = !read.plan.dropReason && (read.sentSnapshot?.outboxKey !== undefined ||
            read.plan.persist || read.plan.preparedMessages.length === 0);
        return {
            read,
            outboxEntry: needsEntry
                ? dispatch.options.observedOutboxEntry ?? this.dependencies.toOutboxEntry(read.msg)
                : undefined,
            dispatchAtMs: this.readNowMs(),
            intent: dispatch.intent,
            phase: dispatch.phase,
            options: dispatch.options
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
}
