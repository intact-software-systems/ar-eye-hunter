import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import { RetryableConflictError } from '../../resilience/TryWith.ts';
import type { ALWorkQueuePort } from '../work/al-work-queue-port.ts';
import type {
    ALOutboundAdmissionStore,
    ALOutboundPreparedMessageDecoder
} from './admission/al-outbound-admission-store.ts';
import { captureALOutboundPolicy } from './admission/al-outbound-admission-validation.ts';
import { toALOutboundCanonicalKey } from './al-outbound-canonical-message.ts';
import { toALOutboundMessageReference } from './al-outbound-canonical-message.ts';
import type {
    ALOutboundDispatchPhase,
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundRuntimeDiagnosticsEvent,
    ALOutboundRuntimeDiagnosticsSink
} from './al-outbound-message-runtime.ts';
import { toALOutboundPendingAdmissionId } from './al-outbound-pending-admission.ts';
import {
    decodeALOutboundWorkEntry,
    isPendingALOutboundWork,
    toALOutboundWorkKey
} from './al-outbound-work-entry.ts';
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
        readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
        readonly workPort: ALWorkQueuePort;
        readonly toOutboxEntry: (msg: ALMessage) => ResourceEntry;
        readonly decodePreparedMessage: ALOutboundPreparedMessageDecoder<TPrepared>;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly browserLocks: ALOutboundMessageRuntime.BrowserLocks | undefined;
        readonly diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
    }
}

/** Owns the sender-serialized optimistic read/compute/commit boundary, before durable effects run. */
export class ALOutboundDispatchAdmission<TPrepared> {
    private readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
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

        const pending = await this.readPendingDispatch(input);
        if (pending) {
            return pending;
        }

        const computed = computeALOutboundDispatch(input);
        const issues = validateALOutboundDispatch(input.read, computed).left;
        if (issues) {
            if (dispatch.intent !== 'enqueue') {
                throw new NonRetryableException(issues.map((issue) => issue.message).join('; '));
            }
            return {
                computed: {
                    msg: input.read.msg,
                    status: 'failed',
                    reason: issues.map((issue) => issue.message).join('; '),
                    entries: []
                },
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

        const status = await this.admissionStore.commitBundle(computed.bundle);
        if (status === 'conflict' && dispatch.intent === 'enqueue' && !dispatch.options.pendingAdmission) {
            return await this.retainPendingDispatch(input, computed);
        }
        if (status === 'conflict' && dispatch.options.pendingAdmission) {
            throw new RetryableConflictError('Outbound pending admission commit conflict');
        }
        return this.toCommitResult(status, { computed, msg: input.read.msg, intent: dispatch.intent });
    }

    private async retainPendingDispatch(
        input: ComputeALOutboundDispatchInput<TPrepared>,
        computed: ALOutboundComputedDto<TPrepared>
    ): Promise<ALOutboundDispatchAdmission.Result<TPrepared>> {
        const canonicalEntry = computed.bundle?.canonicalEntry;
        if (!canonicalEntry) {
            throw new NonRetryableException('Pending admission requires its validated canonical candidate');
        }
        const status = await this.admissionStore.retainPendingAdmission({
            canonicalEntry,
            creationExpiry: input.read.creationExpiry,
            payload: {
                kind: 'admit-message',
                message: toALOutboundMessageReference(
                    this.admissionStore.canonicalScope,
                    canonicalEntry,
                    input.read.msg
                ),
                policy: captureALOutboundPolicy(input.read.plan),
                preparedMessages: input.read.plan.preparedMessages
            }
        });
        if (status !== 'pending') {
            return this.toCommitResult(status, { computed, msg: input.read.msg, intent: 'enqueue' });
        }
        return {
            computed: { msg: input.read.msg, status: 'pending-admission', entries: [canonicalEntry] },
            committed: false
        };
    }

    private async readPendingDispatch(
        input: ComputeALOutboundDispatchInput<TPrepared>
    ): Promise<ALOutboundDispatchAdmission.Result<TPrepared> | undefined> {
        if (
            input.intent !== 'enqueue' || input.options.pendingAdmission || !input.read.canonicalEntry ||
            input.read.sentSnapshot
        ) {
            return undefined;
        }
        const reference = toALOutboundMessageReference(
            this.admissionStore.canonicalScope,
            input.outboxEntry,
            input.read.msg
        );
        const key = toALOutboundWorkKey(this.admissionStore.namespace, toALOutboundPendingAdmissionId(reference));
        const entry = await this.dependencies.workPort.readEntry(key);
        if (!entry || reference.expiresAtMs <= this.readNowMs()) {
            return undefined;
        }
        const pending = decodeALOutboundWorkEntry(entry, this.admissionStore.namespace, {
            decodePrepared: this.dependencies.decodePreparedMessage,
            message: input.read.msg
        }).payload;
        if (
            pending.kind !== 'admit-message' || !jsonEquals(pending.message, reference) ||
            (input.options.explicitPlan && (!jsonEquals(pending.policy, captureALOutboundPolicy(input.read.plan)) ||
                !jsonEquals(pending.preparedMessages, input.read.plan.preparedMessages)))
        ) {
            throw new NonRetryableException('Pending outbound admission differs from the supplied captured plan');
        }
        return {
            computed: {
                msg: input.read.msg,
                status: isPendingALOutboundWork(entry) ? 'pending-admission' : 'skipped',
                entries: [input.outboxEntry],
                reason: isPendingALOutboundWork(entry) ? undefined : 'Pending admission has already terminated'
            },
            committed: false
        };
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
        const read = await this.admissionStore.readOutgoingMessage({
            msg: dispatch.msg,
            planner: dispatch.planner,
            observedCanonicalEntry: dispatch.options.observedOutboxEntry,
            intent: dispatch.intent
        });
        const entry = read.canonicalEntry ?? this.dependencies.toOutboxEntry(read.msg);
        return {
            read,
            outboxEntry: {
                ...entry,
                key: read.canonicalEntry?.key ?? read.sentSnapshot?.outboxKey ??
                    toALOutboundCanonicalKey(this.admissionStore.canonicalScope, read.msg)
            },
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
