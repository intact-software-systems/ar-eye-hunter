import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodeALControlMessage } from '../../al-contracts/al-control.ts';
import { toALSequenceMintComparableMessage } from '../../al-contracts/al-runtime.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { toError } from '../../resilience/to-error.ts';
import { RetryableConflictError } from '../../resilience/TryWith.ts';
import type { ALStoreDurability } from '../al-runtime-stores.ts';
import type { ALDeliveryAdmissionVerdict } from '../delivery/al-delivery-lifecycle.ts';
import { toALOutboundCommitLockName, type ALBrowserLocks } from '../storage/al-browser-locks.ts';
import { toALStorageUnavailable } from '../storage/al-storage-unavailable.ts';
import type { ALWorkQueuePort } from '../work/al-work-queue-port.ts';
import type {
    ALOutboundAdmissionStore,
    ALOutboundCommitBundle,
    ALOutboundMessageReadDto,
    ALOutboundObservedDecision,
    ALOutboundOutgoingReadInput,
    ALOutboundPlanner,
    ALOutboundPreparedMessageDecoder
} from './admission/al-outbound-admission-store.ts';
import { captureALOutboundPolicy } from './admission/al-outbound-admission-validation.ts';
import { toALOutboundCanonicalKey } from './al-outbound-canonical-message.ts';
import { toALOutboundMessageReference } from './al-outbound-canonical-message.ts';
import { ALOutboundCommitPhases } from './al-outbound-commit-phases.ts';
import type {
    ALOutboundCommitOrigin,
    ALOutboundDequeueAuthority,
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
    toALOutboundAttemptIdentity,
    toALOutboundCommitSettlements,
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
        readonly dequeueAuthority?: ALOutboundDequeueAuthority;
        readonly planner: ALOutboundPlanner<TPrepared>;
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
        /** The store pair this admission commits to, named on its commit-phases diagnostic. */
        readonly lane: ALStoreDurability;
        readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
        readonly workPort: ALWorkQueuePort;
        readonly toOutboxEntry: (msg: ALMessage) => ResourceEntry;
        readonly decodePreparedMessage: ALOutboundPreparedMessageDecoder<TPrepared>;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly browserLocks: ALBrowserLocks | undefined;
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

/** Owns optimistic read/compute/commit; ordinary data serializes by sender, while initial controls bypass that wait. */
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
     * The dispatches of one sender under one version fence. Ordinary data also holds one queue slot
     * and browser lock; canonical initial controls use the same optimistic fence without those waits. When a member
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
            const controls = dispatches.filter((dispatch) => this.isInitialControlHandoff(dispatch));
            if (controls.length > 0 && controls.length !== dispatches.length) {
                return await this.commitEachAlone(members);
            }
            const attempt = controls.length === dispatches.length
                ? this.commitGroupOnce(members)
                : this.withSenderCommitQueue(dispatches[0]!, () => this.commitGroupOnce(members));
            const grouped = await attempt
                .catch((error) => {
                    console.warn('AL outbound group commit threw; its members commit alone', error);
                    return undefined;
                });
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
            lane: this.dependencies.lane,
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
            if (this.isInitialControlHandoff(dispatch)) {
                return await this.commitDispatchOnce(dispatch, phases);
            }
            return await this.withSenderCommitQueue(
                dispatch,
                () => this.commitDispatchOnce(dispatch, phases)
            );
        }
        catch (error) {
            const verdict = dispatch.intent === 'enqueue' ? toALOutboundThrownVerdict(toError(error)) : undefined;
            if (verdict === undefined) {
                throw error;
            }
            return {
                computed: toALOutboundVerdictComputed(verdict, {
                    msg: dispatch.msg,
                    reason: verdict.detail,
                    entries: []
                }),
                committed: false
            };
        }
    }

    /**
     * Every member commits, whatever an earlier one answered. A member whose single commit would throw
     * does not stop the members after it: the first such throw is rethrown once every member ran, so
     * the caller still sees it and the own write of each member has already landed. The caller owes
     * the owner its wake for those writes on the rethrow too.
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
            this.emitCommitSettlements(result, decision.input);
            return result;
        });
    }

    /** Every optimistic group decision; `undefined` once one member settles before a write. */
    private async readGroupDecisions(
        members: readonly ALOutboundGroupMember<TPrepared>[]
    ): Promise<readonly ALOutboundCommitDecision<TPrepared>[] | undefined> {
        const decisions: ALOutboundCommitDecision<TPrepared>[] = [];
        for (const { dispatch, phases } of members) {
            const decision = await this.readMemberDispatchDecision(dispatch, phases);
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
        const { decision, observation } = await this.readObservedDispatchDecision(dispatch, phases);
        if (decision.kind === 'settled') {
            return decision.result;
        }

        const { input, computed, bundle } = decision;
        const status = await phases.withCommitPhase(() => this.admissionStore.commitBundle(bundle, observation));
        if (status === 'conflict' && dispatch.intent === 'enqueue' && !dispatch.options.pendingAdmission) {
            const retained = await this.retainPendingDispatch(input, computed, phases);
            if (this.isInitialControlHandoff(dispatch) && retained.computed.verdict.kind === 'failed') {
                throw new RetryableConflictError('Outbound control handoff conflict');
            }
            return retained;
        }
        if (status === 'conflict' && dispatch.options.pendingAdmission) {
            throw new RetryableConflictError('Outbound pending admission commit conflict');
        }
        const result = this.toCommitResult(status, { computed, msg: input.read.msg, intent: dispatch.intent });
        this.emitCommitSettlements(result, input);
        return result;
    }

    /** A single send decides inside its decision read, so that read also holds what its commit fences. */
    private async readObservedDispatchDecision(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>,
        phases: ALOutboundCommitPhases
    ): Promise<ALOutboundObservedDecision<TPrepared, ALOutboundDispatchDecision<TPrepared>>> {
        if (this.disposed) {
            return {
                decision: { kind: 'settled', result: ALOutboundDispatchAdmission.toDisposedResult() },
                observation: undefined
            };
        }
        return await phases.withReadPhase(() =>
            this.admissionStore.readOutgoingDecision(
                this.toOutgoingReadInput(dispatch),
                (read) => this.readDispatchDecision(dispatch, this.toDispatchInput(dispatch, read, this.readNowMs()))
            )
        );
    }

    /** One group member's decision; the group reads the observation of every bundle in its own commit. */
    private async readMemberDispatchDecision(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>,
        phases: ALOutboundCommitPhases
    ): Promise<ALOutboundDispatchDecision<TPrepared>> {
        if (this.disposed) {
            return { kind: 'settled', result: ALOutboundDispatchAdmission.toDisposedResult() };
        }
        return await phases.withReadPhase(async () => {
            const read = await this.admissionStore.readOutgoingMessage(this.toOutgoingReadInput(dispatch));
            return await this.readDispatchDecision(dispatch, this.toDispatchInput(dispatch, read, this.readNowMs()));
        });
    }

    /** Everything one dispatch decides on its read: its retained pending admission (read), compute and validate. */
    private async readDispatchDecision(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>,
        input: ComputeALOutboundDispatchInput<TPrepared>
    ): Promise<ALOutboundDispatchDecision<TPrepared>> {
        const pending = await this.readPendingDispatch(input);
        if (pending) {
            return toALOutboundSettledDecision(pending.verdict, {
                msg: toALOutboundRequestedMessage(input.read),
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

    /**
     * The facts a committed admission states at once, before any attempt runs. Stated from the commit of
     * the replacement, a superseded predecessor never waits on its next attempt.
     */
    private emitCommitSettlements(
        result: ALOutboundDispatchAdmission.Result<TPrepared>,
        input: ComputeALOutboundDispatchInput<TPrepared>
    ): void {
        const { bundle, msg } = result.computed;
        if (!result.committed || !bundle || !msg) {
            return;
        }
        for (
            const fact of toALOutboundCommitSettlements({ bundle, msg, read: input.read, intent: input.intent })
        ) {
            this.dependencies.settlements(fact);
        }
    }

    private async retainPendingDispatch(
        input: ComputeALOutboundDispatchInput<TPrepared>,
        computed: ALOutboundComputedDto<TPrepared>,
        phases: ALOutboundCommitPhases
    ): Promise<ALOutboundDispatchAdmission.Result<TPrepared>> {
        const candidate = computed.bundle?.canonicalEntry;
        if (!candidate) {
            throw new NonRetryableException('Pending admission requires its validated canonical candidate');
        }
        // The sequence belongs to the attempt that commits: a retained admission keeps the request, and its
        // replay mints when it commits.
        const requested = toALOutboundRequestedMessage(input.read);
        const canonicalEntry = { ...candidate, resource: this.dependencies.toOutboxEntry(requested).resource };
        const status = await phases.withCommitPhase(async () => {
            const retained = await this.admissionStore.retainPendingAdmission({
                canonicalEntry,
                creationExpiry: input.read.creationExpiry,
                payload: {
                    kind: 'admit-message',
                    message: toALOutboundMessageReference(
                        this.admissionStore.canonicalScope,
                        canonicalEntry,
                        requested
                    ),
                    policy: captureALOutboundPolicy(input.read.plan),
                    preparedMessages: input.read.plan.preparedMessages
                }
            });
            return retained === 'pending' ? 'committed' : retained;
        });
        if (status !== 'committed') {
            return this.toCommitResult(status, { computed, msg: requested, intent: 'enqueue' });
        }
        return {
            computed: toALOutboundVerdictComputed(
                { kind: 'pending' },
                { msg: requested, entries: [canonicalEntry] }
            ),
            committed: false
        };
    }

    private isInitialControlHandoff(dispatch: ALOutboundDispatchAdmission.Input<TPrepared>): boolean {
        return dispatch.intent === 'enqueue' && dispatch.origin === 'send' &&
            decodeALControlMessage(dispatch.msg).right !== undefined;
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

    private toOutgoingReadInput(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>
    ): ALOutboundOutgoingReadInput<TPrepared> {
        return {
            msg: dispatch.msg,
            planner: dispatch.planner,
            observedCanonicalEntry: dispatch.options.observedOutboxEntry,
            dequeueAuthority: dispatch.dequeueAuthority,
            intent: dispatch.intent,
            repairAttempt: dispatch.options.repairBudget === undefined
                ? undefined
                : { attemptIdentity: toALOutboundAttemptIdentity(dispatch.options), phase: dispatch.phase }
        };
    }

    private toDispatchInput(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>,
        read: ALOutboundMessageReadDto<TPrepared>,
        dispatchAtMs: number
    ): ComputeALOutboundDispatchInput<TPrepared> {
        // A replay that minted replaces the request its retained canonical row holds.
        const entry = read.orderingHead === undefined && read.canonicalEntry
            ? read.canonicalEntry
            : this.dependencies.toOutboxEntry(read.msg);
        return {
            read,
            outboxEntry: {
                ...entry,
                key: read.canonicalEntry?.key ?? read.sentSnapshot?.outboxKey ??
                    toALOutboundCanonicalKey(this.admissionStore.canonicalScope, read.msg)
            },
            dispatchAtMs,
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
        const lockName = toALOutboundCommitLockName(senderId);
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

type ALOutboundThrownVerdict = Extract<
    ALDeliveryAdmissionVerdict,
    Readonly<{ kind: 'failed' | 'storage-unavailable'; }>
>;

/** A send whose commit threw for a non-retryable reason or for its storage settles typed; anything else throws. */
function toALOutboundThrownVerdict(error: Error): ALOutboundThrownVerdict | undefined {
    if (error instanceof NonRetryableException) {
        return { kind: 'failed', detail: error.message };
    }
    const unavailable = toALStorageUnavailable(error);
    return unavailable === undefined ? undefined : { kind: 'storage-unavailable', ...unavailable };
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
    return { ...fields, verdict, trackedReceiptAlgo: 'none' };
}

/** The message as its sender asked for it: a sequence this read minted is not part of it until a commit lands. */
function toALOutboundRequestedMessage<TPrepared>(read: ALOutboundMessageReadDto<TPrepared>): ALMessage {
    return read.orderingHead === undefined ? read.msg : toALSequenceMintComparableMessage(read.originalMsg, read.msg);
}

/** Members read the version of the sender one after another, so a version that moved between them splits the group. */
function hasOneALOutboundSenderVersion<TPrepared>(decisions: readonly ALOutboundCommitDecision<TPrepared>[]): boolean {
    const [first] = decisions;
    return decisions.every(({ bundle }) =>
        bundle.senderId === first?.bundle.senderId && bundle.expectedVersion === first.bundle.expectedVersion
    );
}
