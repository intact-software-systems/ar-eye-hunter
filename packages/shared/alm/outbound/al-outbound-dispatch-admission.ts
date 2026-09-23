import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { RetryableConflictError } from '../../resilience/TryWith.ts';
import type { ALDeliveryAdmissionVerdict } from '../delivery/al-delivery-lifecycle.ts';
import type { ALWorkQueuePort } from '../work/al-work-queue-port.ts';
import type {
    ALOutboundAdmissionStore,
    ALOutboundCommitBundle,
    ALOutboundPreparedMessageDecoder
} from './admission/al-outbound-admission-store.ts';
import { captureALOutboundPolicy } from './admission/al-outbound-admission-validation.ts';
import { toALOutboundCanonicalKey } from './al-outbound-canonical-message.ts';
import { toALOutboundMessageReference } from './al-outbound-canonical-message.ts';
import { ALOutboundCommitPhases } from './al-outbound-commit-phases.ts';
import type {
    ALOutboundCommitOrigin,
    ALOutboundDispatchPhase,
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundRuntimeDiagnosticsEvent,
    ALOutboundRuntimeDiagnosticsSink,
    ALOutboundSettlementEmitter
} from './al-outbound-message-runtime.ts';
import {
    readALOutboundPendingDispatch,
    type ALOutboundPendingDispatchVerdict
} from './al-outbound-pending-admission.ts';
import {
    computeALOutboundDispatch,
    toALOutboundSupersededMsgIds,
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
        readonly origin: ALOutboundCommitOrigin;
        readonly options: ALOutboundCommitDispatchOptions;
    }

    /** One sender's serialized commit chain, and the origin of the commit currently at its end. */
    export interface SenderCommitQueue {
        readonly tail: Promise<void>;
        readonly origin: ALOutboundCommitOrigin;
    }

    export interface HeldCommitLock {
        readonly senderId: string;
        readonly origin: ALOutboundCommitOrigin;
        readonly lockName: string;
        readonly available: boolean;
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
        readonly settlements: ALOutboundSettlementEmitter;
    }
}

/** What one dispatch decided before its write: a result already, or a bundle its commit writes. */
type ALOutboundDispatchDecision<TPrepared> =
    | Readonly<{ kind: 'settled'; result: ALOutboundDispatchAdmission.Result<TPrepared>; }>
    | ALOutboundCommitDecision<TPrepared>;

interface ALOutboundCommitDecision<TPrepared> {
    readonly kind: 'commit';
    readonly input: ComputeALOutboundDispatchInput<TPrepared>;
    readonly computed: ALOutboundComputedDto<TPrepared>;
    readonly bundle: ALOutboundCommitBundle<TPrepared>;
}

/** One dispatch of a group, with the phases its one `commit-phases` event reports. */
interface ALOutboundGroupMember<TPrepared> {
    readonly dispatch: ALOutboundDispatchAdmission.Input<TPrepared>;
    readonly phases: ALOutboundCommitPhases;
}

/** Owns the sender-serialized optimistic read/compute/commit boundary, before durable effects run. */
export class ALOutboundDispatchAdmission<TPrepared> {
    private readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
    private readonly commitQueuesBySenderId = new Map<string, ALOutboundDispatchAdmission.SenderCommitQueue>();
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
        const phases = this.createCommitPhases(dispatch);
        try {
            return await this.commitWithPhases(dispatch, phases);
        }
        finally {
            this.emitDiagnostics(phases.toEvent());
        }
    }

    /**
     * The dispatches of one sender under one queue slot, one lock and one version fence. When a member
     * settles before its write (it fails validation, finds its pending admission, has nothing to
     * commit), the store answers the group with anything but `committed`, or the group attempt throws,
     * every member commits again alone, one after another: a fresh read, compute and conflict
     * handling, as a single send gets. Each member keeps its own answer there.
     */
    async commitAll(
        dispatches: readonly ALOutboundDispatchAdmission.Input<TPrepared>[]
    ): Promise<readonly ALOutboundDispatchAdmission.Result<TPrepared>[]> {
        if (dispatches.length < 2) {
            return await Promise.all(dispatches.map((dispatch) => this.commit(dispatch)));
        }
        const members = dispatches.map((dispatch) => ({ dispatch, phases: this.createCommitPhases(dispatch) }));
        try {
            // A throw is a fallback signal too: each member meets its cause again alone, as its own.
            const grouped = await this.withSenderCommitQueue(dispatches[0]!, () => this.commitGroupOnce(members))
                .catch(() => undefined);
            return grouped ?? await this.commitEachAlone(members);
        }
        finally {
            for (const { phases } of members) {
                this.emitDiagnostics(phases.toEvent());
            }
        }
    }

    private createCommitPhases(dispatch: ALOutboundDispatchAdmission.Input<TPrepared>): ALOutboundCommitPhases {
        return new ALOutboundCommitPhases({
            senderId: dispatch.msg.id.senderId,
            msgId: dispatch.msg.id.msgId,
            typeId: dispatch.msg.payload.typeId,
            origin: dispatch.origin,
            nowMs: () => this.readNowMs(),
            getReadOperationCount: () => this.admissionStore.getReadOperationCount()
        });
    }

    private async commitWithPhases(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>,
        phases: ALOutboundCommitPhases
    ): Promise<ALOutboundDispatchAdmission.Result<TPrepared>> {
        try {
            return await this.withSenderCommitQueue(
                dispatch,
                () => this.commitDispatchOnce(dispatch, phases)
            );
        }
        catch (error) {
            if (!(error instanceof NonRetryableException) || dispatch.intent !== 'enqueue') {
                throw error;
            }
            return {
                computed: toALOutboundVerdictComputed(
                    { kind: 'failed', detail: error.message },
                    { msg: dispatch.msg, reason: error.message, entries: [] }
                ),
                committed: false
            };
        }
    }

    /**
     * Every member commits, whatever an earlier one answered. A member whose single commit would throw
     * does not stop the members after it: the first such throw is rethrown once every member ran, so
     * the caller still sees it and the own write of each member has already landed.
     */
    private async commitEachAlone(
        members: readonly ALOutboundGroupMember<TPrepared>[]
    ): Promise<readonly ALOutboundDispatchAdmission.Result<TPrepared>[]> {
        const outcomes: Promise<ALOutboundDispatchAdmission.Result<TPrepared>>[] = [];
        for (const { dispatch, phases } of members) {
            const outcome = this.commitWithPhases(dispatch, phases);
            outcomes.push(outcome);
            await outcome.catch(() => undefined);
        }
        return await Promise.all(outcomes);
    }

    /** The results of the group, or `undefined` when every member must commit alone instead. */
    private async commitGroupOnce(
        members: readonly ALOutboundGroupMember<TPrepared>[]
    ): Promise<readonly ALOutboundDispatchAdmission.Result<TPrepared>[] | undefined> {
        const decisions = await this.readGroupDecisions(members);
        if (decisions === undefined || !hasOneALOutboundSenderVersion(decisions)) {
            return undefined;
        }
        const written = this.admissionStore.commitBundles(decisions.map((decision) => decision.bundle));
        const statuses = await Promise.all(members.map(({ phases }) => phases.withCommitPhase(() => written)));
        if (statuses.some((status) => status !== 'committed')) {
            return undefined;
        }
        return decisions.map((decision, index) => {
            const result = this.toCommitResult('committed', {
                computed: decision.computed,
                msg: decision.input.read.msg,
                intent: members[index]!.dispatch.intent
            });
            this.emitSupersededSettlements(result);
            return result;
        });
    }

    /** Every decision of the group, read under its lock; `undefined` once one of them settles before a write. */
    private async readGroupDecisions(
        members: readonly ALOutboundGroupMember<TPrepared>[]
    ): Promise<readonly ALOutboundCommitDecision<TPrepared>[] | undefined> {
        const decisions: ALOutboundCommitDecision<TPrepared>[] = [];
        for (const { dispatch, phases } of members) {
            const decision = await this.readDispatchDecision(dispatch, phases);
            if (decision.kind === 'settled') {
                return undefined;
            }
            decisions.push(decision);
        }
        return decisions;
    }

    private async commitDispatchOnce(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>,
        phases: ALOutboundCommitPhases
    ): Promise<ALOutboundDispatchAdmission.Result<TPrepared>> {
        const decision = await this.readDispatchDecision(dispatch, phases);
        if (decision.kind === 'settled') {
            return decision.result;
        }

        const { input, computed, bundle } = decision;
        const status = await phases.withCommitPhase(() => this.admissionStore.commitBundle(bundle));
        if (status === 'conflict' && dispatch.intent === 'enqueue' && !dispatch.options.pendingAdmission) {
            return await this.retainPendingDispatch(input, computed);
        }
        if (status === 'conflict' && dispatch.options.pendingAdmission) {
            throw new RetryableConflictError('Outbound pending admission commit conflict');
        }
        const result = this.toCommitResult(status, { computed, msg: input.read.msg, intent: dispatch.intent });
        this.emitSupersededSettlements(result);
        return result;
    }

    /** Everything one dispatch decides before its write: the read, its retained pending admission, compute and validate. */
    private async readDispatchDecision(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>,
        phases: ALOutboundCommitPhases
    ): Promise<ALOutboundDispatchDecision<TPrepared>> {
        if (this.disposed) {
            return { kind: 'settled', result: ALOutboundDispatchAdmission.toDisposedResult() };
        }
        const input = await phases.withReadPhase(() => this.readDispatch(dispatch));
        const pending = await phases.withReadPhase(() => this.readPendingDispatch(input));
        if (pending) {
            return toALOutboundSettledDecision(pending.verdict, {
                msg: input.read.msg,
                entries: pending.entries,
                reason: pending.reason
            });
        }

        const computed = computeALOutboundDispatch(input);
        const issues = validateALOutboundDispatch(input.read, computed).left;
        if (issues) {
            const reason = issues.map((issue) => issue.message).join('; ');
            if (dispatch.intent !== 'enqueue') {
                throw new NonRetryableException(reason);
            }
            return toALOutboundSettledDecision({ kind: 'failed', detail: reason }, {
                msg: input.read.msg,
                reason,
                entries: []
            });
        }
        this.logDispatchDecision(computed, input.read.plan);
        if (!computed.bundle) {
            return { kind: 'settled', result: { computed, committed: false } };
        }
        if (this.disposed) {
            return { kind: 'settled', result: ALOutboundDispatchAdmission.toDisposedResult() };
        }
        return { kind: 'commit', input, computed, bundle: computed.bundle };
    }

    private async readPendingDispatch(
        input: ComputeALOutboundDispatchInput<TPrepared>
    ): Promise<ALOutboundPendingDispatchVerdict | undefined> {
        return await readALOutboundPendingDispatch({
            namespace: this.admissionStore.namespace,
            canonicalScope: this.admissionStore.canonicalScope,
            workPort: this.dependencies.workPort,
            decodePrepared: this.dependencies.decodePreparedMessage,
            nowMs: () => this.readNowMs(),
            dispatch: input
        });
    }

    /** Stated from the replacement's own commit, so the predecessor never waits on its next attempt. */
    private emitSupersededSettlements(result: ALOutboundDispatchAdmission.Result<TPrepared>): void {
        const { bundle, msg } = result.computed;
        if (!result.committed || !bundle || !msg) {
            return;
        }
        for (const msgId of toALOutboundSupersededMsgIds(bundle)) {
            this.dependencies.settlements({
                kind: 'superseded',
                msgId,
                replacementMsgId: msg.id.msgId,
                detail: 'A newer message replaced this one at its admission.'
            });
        }
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
            computed: toALOutboundVerdictComputed(
                { kind: 'pending' },
                { msg: input.read.msg, entries: [canonicalEntry] }
            ),
            committed: false
        };
    }

    private toCommitResult(
        status: 'committed' | 'conflict' | 'expired',
        { computed, msg, intent }: ALOutboundDispatchAdmission.CommitResultInput<TPrepared>
    ): ALOutboundDispatchAdmission.Result<TPrepared> {
        if (status === 'expired') {
            const reason = 'Message expired before commit';
            return {
                computed: toALOutboundVerdictComputed({ kind: 'expired', detail: reason }, {
                    msg,
                    reason,
                    entries: []
                }),
                committed: false
            };
        }
        if (status === 'conflict') {
            if (intent === 'enqueue') {
                const reason = 'Outbound commit conflict';
                return {
                    computed: toALOutboundVerdictComputed({ kind: 'failed', detail: reason }, {
                        msg,
                        reason,
                        entries: []
                    }),
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
        if (
            computed.verdict.kind === 'superseded' ||
            (computed.verdict.kind === 'unroutable' && computed.verdict.reason === 'no-route')
        ) {
            console.warn(computed.reason);
        }
    }

    private static toDisposedResult<TPrepared>(): ALOutboundDispatchAdmission.Result<TPrepared> {
        const reason = 'Outbound runtime is disposed.';
        return {
            computed: toALOutboundVerdictComputed(
                { kind: 'skipped', reason: 'disposed', detail: reason },
                { reason, entries: [] }
            ),
            committed: false
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
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>,
        task: () => Promise<T>
    ): Promise<T> {
        const senderId = dispatch.msg.id.senderId;
        const origin = dispatch.origin;
        const existing = this.commitQueuesBySenderId.get(senderId);
        const previous = existing?.tail ?? Promise.resolve();
        const waitStartedAtMs = this.readNowMs();
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.catch(() => undefined).then(() => gate);
        this.commitQueuesBySenderId.set(senderId, { tail, origin });

        await previous.catch(() => undefined);
        this.emitDiagnostics({
            kind: 'sender-queue-wait',
            senderId,
            origin,
            queued: existing !== undefined,
            queuedBehindOrigin: existing?.origin ?? 'none',
            durationMs: this.elapsedSince(waitStartedAtMs)
        });

        try {
            return await this.withCrossContextCommitLock(senderId, origin, task);
        }
        finally {
            release?.();
            if (this.commitQueuesBySenderId.get(senderId)?.tail === tail) {
                this.commitQueuesBySenderId.delete(senderId);
            }
        }
    }

    private async withCrossContextCommitLock<T>(
        senderId: string,
        origin: ALOutboundCommitOrigin,
        task: () => Promise<T>
    ): Promise<T> {
        const lockName = `rallar:al-outbound-commit:${senderId}`;
        const locks = this.dependencies.browserLocks;
        if (!locks) {
            this.emitDiagnostics({
                kind: 'browser-lock-wait',
                senderId,
                origin,
                lockName,
                available: false,
                durationMs: 0
            });
            return await this.withHeldCommitLock({ senderId, origin, lockName, available: false }, task);
        }

        const waitStartedAtMs = this.readNowMs();
        return await locks.request(
            lockName,
            { mode: 'exclusive' },
            async () => {
                this.emitDiagnostics({
                    kind: 'browser-lock-wait',
                    senderId,
                    origin,
                    lockName,
                    available: true,
                    durationMs: this.elapsedSince(waitStartedAtMs)
                });
                return await this.withHeldCommitLock({ senderId, origin, lockName, available: true }, task);
            }
        );
    }

    private async withHeldCommitLock<T>(
        held: ALOutboundDispatchAdmission.HeldCommitLock,
        task: () => Promise<T>
    ): Promise<T> {
        const holdStartedAtMs = this.readNowMs();
        try {
            return await task();
        }
        finally {
            this.emitDiagnostics({
                kind: 'browser-lock-hold',
                ...held,
                durationMs: this.elapsedSince(holdStartedAtMs)
            });
        }
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

function toALOutboundSettledDecision<TPrepared>(
    verdict: ALDeliveryAdmissionVerdict,
    fields: Readonly<{ msg?: ALMessage; reason?: string; entries: readonly ResourceEntry[]; }>
): ALOutboundDispatchDecision<TPrepared> {
    return { kind: 'settled', result: { computed: toALOutboundVerdictComputed(verdict, fields), committed: false } };
}

function toALOutboundVerdictComputed<TPrepared>(
    verdict: ALDeliveryAdmissionVerdict,
    fields: Readonly<{ msg?: ALMessage; reason?: string; entries: readonly ResourceEntry[]; }>
): ALOutboundComputedDto<TPrepared> {
    return { ...fields, verdict };
}

/** Members read the version of the sender one after another, so a version that moved between them splits the group. */
function hasOneALOutboundSenderVersion<TPrepared>(decisions: readonly ALOutboundCommitDecision<TPrepared>[]): boolean {
    const [first] = decisions;
    return decisions.every(({ bundle }) =>
        bundle.senderId === first?.bundle.senderId && bundle.expectedVersion === first.bundle.expectedVersion
    );
}
