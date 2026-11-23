import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodeALControlMessage } from '../../al-contracts/al-control.ts';
import {
    isALFreezeOfMessage,
    resolveALFrozenMulticastAudience
} from '../../al-contracts/al-frozen-multicast-audience.ts';
import {
    decodePersistedALMessageRow,
    toChangedALMessageRow
} from '../../al-contracts/al-message-persistence-validation.ts';
import type { ALStoreDurability } from '../../al-contracts/al-policy.ts';
import { toALMessageTrace } from '../../al-contracts/trace/to-al-message-trace.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { NotReadyException } from '../../queuebox/resource-inbox/not-ready-exception.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { toError } from '../../resilience/to-error.ts';
import { RetryableConflictError, TryWithExhaustedError, TryWithPolicy } from '../../resilience/try-with-policy.ts';
import { decodeALAdmissionValue } from '../al-admission-decoder.ts';
import type { ALDeliveryAdmissionVerdict } from '../delivery/al-delivery-lifecycle.ts';
import { toALStorageUnavailable } from '../storage/al-storage-unavailable.ts';
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
import { toALOutboundRequestComparableMessage } from './admission/to-al-outbound-request-comparable-message.ts';
import { toALOutboundCanonicalKey, toALOutboundMessageReference } from './al-outbound-canonical-message.ts';
import { ALOutboundCommitPhases } from './al-outbound-commit-phases.ts';
import {
    writeALOutboundRuntimeDiagnostic,
    type ALOutboundCommitOrigin,
    type ALOutboundDequeueAuthority,
    type ALOutboundDispatchPhase,
    type ALOutboundDispatchPlan,
    type ALOutboundMessageRuntime,
    type ALOutboundRuntimeDiagnosticsSink,
    type ALOutboundSettlementEmitter
} from './al-outbound-message-runtime.ts';
import {
    readALOutboundPendingDispatch,
    type ALOutboundPendingDispatchVerdict
} from './al-outbound-pending-admission.ts';
import {
    computeALOutboundDispatch,
    toALOutboundCommitSettlements,
    type ALOutboundCommitDispatchOptions,
    type ALOutboundComputedDto,
    type ALOutboundComputeIntent,
    type ComputeALOutboundDispatchInput
} from './compute-al-outbound-dispatch.ts';
import { AL_OUTBOUND_COMMIT_ATTEMPTS } from './control/al-outbound-control-admission.ts';
import type { ALOutboundDequeuedAdmission } from './lane/al-outbound-dequeued-admission.ts';
import {
    computeALOutboundGroupChainedReads,
    isALOutboundLeftBehindPredecessor,
    toALOutboundFollowerOrder,
    toALOutboundGroupPositionWrites,
    toALOutboundLeftBehindPredecessors
} from './lane/compute-al-outbound-group-sent-positions.ts';
import { recordALOutboundDequeueTiming } from './lane/record-al-outbound-dequeue-timing.ts';
import { toALOutboundAttemptIdentity } from './to-al-outbound-effect-id.ts';
import { validateALOutboundDispatch } from './validate-al-outbound-dispatch.ts';

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

/** One commit attempt's answer: its result, or the decision whose write lost the sender-version fence. */
type ALOutboundDispatchAttempt<TPrepared> =
    | Readonly<{ kind: 'settled'; result: ALOutboundDispatchAdmission.Result<TPrepared>; }>
    | Readonly<{ kind: 'conflict'; decision: ALOutboundCommitDecision<TPrepared>; }>;

/** The write of `decision` lost the sender-version fence to another commit of its sender. */
class ALOutboundDispatchConflict<TPrepared> extends RetryableConflictError {
    readonly decision: ALOutboundCommitDecision<TPrepared>;

    constructor(decision: ALOutboundCommitDecision<TPrepared>) {
        super('Outbound commit conflict');
        this.decision = decision;
    }
}

/**
 * Every commit of a sender is fenced on one sender version and nothing serializes them, so a commit whose write lost
 * that fence to another commit reads, decides and writes again, `AL_OUTBOUND_COMMIT_ATTEMPTS` attempts in all.
 * Contention costs a fresh read, never a wait for another commit's read. The first retry runs at once: a lost fence
 * means the winner has committed, so the fresh read sees it. A second loss is sustained contention, and the last attempt
 * first waits 10 ms with half of it jittered, so commits that keep meeting spread apart. Past the bound the request is
 * retained as a pending admission the durable worker replays, or the claim is left to its work retry, so contention
 * never live-locks a sender: a commit makes at most three reads and three writes and waits at most 15 ms.
 */
const AL_OUTBOUND_COMMIT_CONFLICT_RETRY = TryWithPolicy.defaults()
    .label('outbound commit conflict')
    .maxAttempts(AL_OUTBOUND_COMMIT_ATTEMPTS)
    .retryIntervalMsecs(5)
    .backoffFactor(2)
    .jitterRatio(0.5)
    .retryIf((error) => error instanceof ALOutboundDispatchConflict)
    .waitBeforeRetry(({ attempt, delayMsecs }) =>
        attempt === 1 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, delayMsecs))
    );

/** A row left behind its batch predecessor is due again at the next pass, where it joins or waits for it. */
const AL_OUTBOUND_LEFT_BEHIND_RETRY_MS = 1;

/** One dispatch of a group, with the phases its one `commit-phases` event reports. */
interface ALOutboundGroupMember<TPrepared> {
    readonly dispatch: ALOutboundDispatchAdmission.Input<TPrepared>;
    readonly phases: ALOutboundCommitPhases;
}

export namespace ALOutboundDispatchAdmission {
    export interface Result<TPrepared> {
        readonly computed: ALOutboundComputedDto<TPrepared>;
        readonly committed: boolean;
    }

    export interface Input<TPrepared> {
        readonly msg: ALMessage;
        readonly dequeueAuthority?: ALOutboundDequeueAuthority;
        /** The pending lower sequences its batch claimed a dequeued row is admitted behind; empty for every other admission. */
        readonly batchPredecessorSeqs: readonly number[];
        readonly planner: ALOutboundPlanner<TPrepared>;
        readonly intent: ALOutboundComputeIntent;
        readonly phase: ALOutboundDispatchPhase;
        readonly origin: ALOutboundCommitOrigin;
        readonly options: ALOutboundCommitDispatchOptions;
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
        readonly toOutboxEntry: (msg: ALMessage) => ResourceEntry;
        readonly decodePreparedMessage: ALOutboundPreparedMessageDecoder<TPrepared>;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
        readonly dequeueTiming?: ALOutboundDequeuedAdmission.TimingSink;
        /** The carrier's signer of a first admission's frame; `undefined` commits the frame as read. */
        readonly signAdmittedMessage: ALOutboundMessageRuntime.Dependencies<TPrepared>['signAdmittedMessage'];
        readonly settlements: ALOutboundSettlementEmitter;
    }
}

/** Owns optimistic read/compute/commit: the sender-version fence alone orders a sender's commits, and a lost fence is a fresh attempt. */
export class ALOutboundDispatchAdmission<TPrepared> {
    private readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
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
            writeALOutboundRuntimeDiagnostic(this.dependencies.diagnostics, phases.toEvent());
        }
    }

    /**
     * The dispatches of one sender under one version fence. When a member
     * settles before its write (it fails validation, finds its pending admission, has nothing to
     * commit), the store answers the group with anything but `committed`, or the group attempt throws,
     * every member commits again alone, one after another: a fresh read, compute and conflict
     * handling, as a single send gets. Each member keeps its own answer there. A dispatch that follows its batch
     * predecessor commits only behind it, so its positions are recorded in sequence order: whether in the group or
     * alone, it is left to the next pass when its predecessor did not reach the commit ahead of it. The members of a
     * track that holds a follower commit by ascending sequence, so their sends are written in that order too.
     */
    async commitAll(
        dispatches: readonly ALOutboundDispatchAdmission.Input<TPrepared>[]
    ): Promise<readonly ALOutboundDispatchAdmission.Result<TPrepared>[]> {
        // The first member that threw is rethrown once every member ran, so the own write of each has landed.
        return (await this.commitAllSettled(dispatches)).map((outcome) => {
            if (outcome.status === 'rejected') {
                throw outcome.reason;
            }
            return outcome.value;
        });
    }

    /** `commitAll` with each member's own answer: a member whose single commit threw rejects alone. */
    async commitAllSettled(
        dispatches: readonly ALOutboundDispatchAdmission.Input<TPrepared>[]
    ): Promise<readonly PromiseSettledResult<ALOutboundDispatchAdmission.Result<TPrepared>>[]> {
        const left = toALOutboundLeftBehindPredecessors(dispatches);
        const committing = toALOutboundFollowerOrder(
            dispatches.filter((dispatch) => !left.has(dispatch)),
            (dispatch) => dispatch
        );
        const settled = await this.commitAdmittedSettled(committing);
        return dispatches.map((dispatch) =>
            left.has(dispatch)
                ? toALOutboundLeftBehindPredecessorOutcome<TPrepared>()
                : settled[committing.indexOf(dispatch)]!
        );
    }

    private async commitAdmittedSettled(
        dispatches: readonly ALOutboundDispatchAdmission.Input<TPrepared>[]
    ): Promise<readonly PromiseSettledResult<ALOutboundDispatchAdmission.Result<TPrepared>>[]> {
        if (dispatches.length < 2) {
            return await Promise.allSettled(dispatches.map((dispatch) => this.commit(dispatch)));
        }
        const members = dispatches.map((dispatch) => ({ dispatch, phases: this.createCommitPhases(dispatch) }));
        try {
            const grouped = await this.commitGroupOnce(members)
                .catch((error) => {
                    console.warn('AL outbound group commit threw; its members commit alone', error);
                    return undefined;
                });
            return grouped?.map((value) => ({ status: 'fulfilled', value })) ?? await this.commitEachAlone(members);
        }
        finally {
            for (const { phases } of members) {
                writeALOutboundRuntimeDiagnostic(this.dependencies.diagnostics, phases.toEvent());
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
            trace: toALMessageTrace(dispatch.msg),
            nowMs: () => this.readNowMs(),
            getReadOperationCount: () => this.admissionStore.getReadOperationCount()
        });
    }

    private async commitWithPhases(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>,
        phases: ALOutboundCommitPhases
    ): Promise<ALOutboundDispatchAdmission.Result<TPrepared>> {
        try {
            return await this.commitDispatch(dispatch, phases);
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
     * Every member commits alone, one after another in the order given (a follower after its predecessor), whatever
     * an earlier one answered; each keeps its own answer. A member that follows its batch predecessor commits only
     * once its predecessor committed.
     */
    private async commitEachAlone(
        members: readonly ALOutboundGroupMember<TPrepared>[]
    ): Promise<readonly PromiseSettledResult<ALOutboundDispatchAdmission.Result<TPrepared>>[]> {
        const outcomes: PromiseSettledResult<ALOutboundDispatchAdmission.Result<TPrepared>>[] = [];
        const committed: ALMessage[] = [];
        for (const { dispatch, phases } of members) {
            const [outcome] = isALOutboundLeftBehindPredecessor(dispatch, committed)
                ? [toALOutboundLeftBehindPredecessorOutcome<TPrepared>()]
                : await Promise.allSettled([this.commitWithPhases(dispatch, phases)]);
            if (outcome!.status === 'fulfilled' && outcome!.value.committed) {
                committed.push(dispatch.msg);
            }
            outcomes.push(outcome!);
        }
        return outcomes;
    }

    /** The results of the group, or `undefined` when every member must commit alone instead. */
    private async commitGroupOnce(
        members: readonly ALOutboundGroupMember<TPrepared>[]
    ): Promise<readonly ALOutboundDispatchAdmission.Result<TPrepared>[] | undefined> {
        const timing = this.dependencies.dequeueTiming;
        const entry = timing === undefined ? undefined : members[0]?.dispatch.options.claimedOutboxEntry;
        const startedAtMs = timing === undefined ? 0 : this.readNowMs();
        let decisionEndedAtMs: number | undefined;
        let bundleEndedAtMs: number | undefined;
        let outcome: 'not-attempted' | 'committed' | 'conflict' | 'expired' | 'error' = 'error';
        try {
            const decisions = await this.readGroupDecisions(members);
            decisionEndedAtMs = timing === undefined ? 0 : this.readNowMs();
            if (decisions === undefined || !hasOneALOutboundSenderVersion(decisions)) {
                outcome = 'not-attempted';
                return undefined;
            }
            const written = this.admissionStore.commitBundles(decisions.map((decision) => decision.bundle));
            const statuses = await Promise.all(members.map(({ phases }) => phases.withCommitPhase(() => written)));
            bundleEndedAtMs = timing === undefined ? 0 : this.readNowMs();
            outcome = statuses[0]!;
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
        finally {
            if (timing !== undefined && entry !== undefined) {
                const endedAtMs = bundleEndedAtMs ?? this.readNowMs();
                recordALOutboundDequeueTiming(timing, {
                    kind: 'admission-group',
                    lane: this.dependencies.lane,
                    entry,
                    memberCount: members.length,
                    startedAtMs,
                    decisionDurationMs: Math.max(0, (decisionEndedAtMs ?? endedAtMs) - startedAtMs),
                    bundleDurationMs: decisionEndedAtMs === undefined || outcome === 'not-attempted'
                        ? 0
                        : Math.max(0, endedAtMs - decisionEndedAtMs),
                    outcome
                });
            }
        }
    }

    /**
     * Every member reads in the same turn, so a backend that batches one turn's reads answers the whole group in one
     * statement per store on its own connection. All reads settle before a group write or fresh single-member
     * fallback may start. Members that record positions on one track decide on chained reads and write each
     * position row once, as one-by-one commits would; a group that cannot chain commits its members alone.
     */
    private async readGroupDecisions(
        members: readonly ALOutboundGroupMember<TPrepared>[]
    ): Promise<readonly ALOutboundCommitDecision<TPrepared>[] | undefined> {
        const reads = toALOutboundGroupSettledValues(
            await Promise.allSettled(
                members.map(({ dispatch, phases }) => this.readMemberDispatchRead(dispatch, phases))
            )
        );
        const read = reads.filter((member): member is ALOutboundMessageReadDto<TPrepared> => member !== undefined);
        const chained = read.length === reads.length ? computeALOutboundGroupChainedReads(read) : undefined;
        if (chained === undefined) {
            return undefined;
        }
        const decided = toALOutboundGroupSettledValues(
            await Promise.allSettled(
                members.map(({ dispatch, phases }, index) =>
                    phases.withReadPhase(() =>
                        this.readDispatchDecision(
                            dispatch,
                            this.toDispatchInput(dispatch, chained[index]!, this.readNowMs())
                        )
                    )
                )
            )
        );
        const decisions = decided.flatMap((decision) => decision.kind === 'commit' ? [decision] : []);
        if (decisions.length < decided.length) {
            return undefined;
        }
        const bundles = toALOutboundGroupPositionWrites(decisions.map((decision) => decision.bundle));
        return decisions.map((decision, index) => ({
            ...decision,
            bundle: bundles[index]!,
            computed: { ...decision.computed, bundle: bundles[index]! }
        }));
    }

    /** One group member's read, signed when its admission signs; undefined once the owner is disposed. */
    private async readMemberDispatchRead(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>,
        phases: ALOutboundCommitPhases
    ): Promise<ALOutboundMessageReadDto<TPrepared> | undefined> {
        if (this.disposed) {
            return undefined;
        }
        return await phases.withReadPhase(async () =>
            await this.signAdmittedRead(
                await this.admissionStore.readOutgoingMessage(this.toOutgoingReadInput(dispatch))
            )
        );
    }

    /** Attempts until a write lands or the bound is spent; a conflict past the bound settles as one always has. */
    private async commitDispatch(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>,
        phases: ALOutboundCommitPhases
    ): Promise<ALOutboundDispatchAdmission.Result<TPrepared>> {
        try {
            return await AL_OUTBOUND_COMMIT_CONFLICT_RETRY.run(async () => {
                const attempt = await this.commitDispatchOnce(dispatch, phases);
                if (attempt.kind === 'conflict') {
                    throw new ALOutboundDispatchConflict(attempt.decision);
                }
                return attempt.result;
            });
        }
        catch (error) {
            const cause = error instanceof TryWithExhaustedError ? error.cause : error;
            if (!(cause instanceof ALOutboundDispatchConflict)) {
                throw cause;
            }
            return await this.settleCommitConflict(
                dispatch,
                cause.decision as ALOutboundCommitDecision<TPrepared>,
                phases
            );
        }
    }

    private async commitDispatchOnce(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>,
        phases: ALOutboundCommitPhases
    ): Promise<ALOutboundDispatchAttempt<TPrepared>> {
        const { decision, observation } = await this.readObservedDispatchDecision(dispatch, phases);
        if (decision.kind === 'settled') {
            return { kind: 'settled', result: await this.toStoredDuplicateResult(decision.result) };
        }

        const { input, computed, bundle } = decision;
        const status = await phases.withCommitPhase(() => this.admissionStore.commitBundle(bundle, observation));
        if (status === 'conflict') {
            return { kind: 'conflict', decision };
        }
        const result = this.toCommitResult(status, { computed, msg: input.read.msg, intent: dispatch.intent });
        this.emitCommitSettlements(result, input);
        return { kind: 'settled', result };
    }

    /**
     * A send whose every attempt lost the fence retains its request for the durable worker to replay; a replay, a
     * control hand-off whose retention failed, and every other intent leave the retry to their caller.
     */
    private async settleCommitConflict(
        dispatch: ALOutboundDispatchAdmission.Input<TPrepared>,
        { input, computed }: ALOutboundCommitDecision<TPrepared>,
        phases: ALOutboundCommitPhases
    ): Promise<ALOutboundDispatchAdmission.Result<TPrepared>> {
        if (dispatch.intent === 'enqueue' && !dispatch.options.pendingAdmission) {
            const retained = await this.retainPendingDispatch(input, computed, phases);
            if (this.isInitialControlHandoff(dispatch) && retained.computed.verdict.kind === 'failed') {
                throw new RetryableConflictError('Outbound control handoff conflict');
            }
            return retained;
        }
        if (dispatch.options.pendingAdmission) {
            throw new RetryableConflictError('Outbound pending admission commit conflict');
        }
        return this.toCommitResult('conflict', { computed, msg: input.read.msg, intent: dispatch.intent });
    }

    /**
     * A duplicate answers with its canonical row as stored now, never with the message its read planned and signed.
     * Nothing orders a replay behind another commit of its sender (ruling 22): it may have read the row before a
     * freezing dequeue stored the row's proof, and its own sign then lost to that one.
     */
    private async toStoredDuplicateResult(
        result: ALOutboundDispatchAdmission.Result<TPrepared>
    ): Promise<ALOutboundDispatchAdmission.Result<TPrepared>> {
        const [entry] = result.computed.entries;
        if (result.computed.verdict.kind !== 'duplicate' || entry === undefined) {
            return result;
        }
        const stored = await this.admissionStore.readWork(entry.key);
        return stored === undefined
            ? result
            : { ...result, computed: { ...result.computed, msg: decodePersistedALMessageRow(stored) } };
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
                async (read) => {
                    const signed = await this.signAdmittedRead(read);
                    return await this.readDispatchDecision(
                        dispatch,
                        this.toDispatchInput(dispatch, signed, this.readNowMs())
                    );
                }
            )
        );
    }

    /**
     * Every dispatch that plans to send asks the carrier's signer, which decides alone and returns a frame that needs
     * no new proof as it is: a first admission signs its frame after the read stamped it, and a held row is signed at
     * the dispatch that first freezes its audience, so the canonical row every later stage resends already carries the
     * proof (D519, D756). A dropping plan, and a read whose row already carries its stored proof, sign nothing. A signer's refusal is the plan's `unsupported` drop of the
     * request: the sequence and record this read added belong to positions it never committed, so a carrier that takes
     * the refusal over gets the request alone, and a held row's dequeue ends it as any `unsupported` plan there does.
     */
    private async signAdmittedRead(
        read: ALOutboundMessageReadDto<TPrepared>
    ): Promise<ALOutboundMessageReadDto<TPrepared>> {
        const sign = this.dependencies.signAdmittedMessage;
        if (sign === undefined || read.plan.dropReasonCode !== undefined || read.msg.proof !== undefined) {
            return read;
        }
        return (await sign(read.msg)).fold(
            (detail): ALOutboundMessageReadDto<TPrepared> => {
                const requested = toALOutboundRequestedMessage(read);
                return {
                    ...read,
                    msg: requested,
                    orderingHead: undefined,
                    sentPositions: undefined,
                    plan: {
                        msg: requested,
                        dropReason: detail,
                        dropReasonCode: 'unsupported',
                        lane: 'volatile',
                        preparedMessages: []
                    }
                };
            },
            (msg) => ({ ...read, msg, plan: { ...read.plan, msg } })
        );
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
            admissionStore: this.admissionStore,
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
        // A replay whose admission added to its request replaces the request its retained canonical row holds; a plan
        // that froze a held row's audience replaces the row.
        const entry = !hasALOutboundAdmissionAdditions(read) && read.canonicalEntry &&
                !isALOutboundCanonicalRowFrozenBy(read.canonicalEntry, read.msg)
            ? read.canonicalEntry
            : this.dependencies.toOutboxEntry(read.msg);
        return {
            read,
            outboxEntry: toChangedALMessageRow(entry, {
                key: read.canonicalEntry?.key ?? read.sentSnapshot?.outboxKey ??
                    toALOutboundCanonicalKey(this.admissionStore.canonicalScope, read.msg)
            }),
            dispatchAtMs,
            intent: dispatch.intent,
            phase: dispatch.phase,
            options: dispatch.options
        };
    }

    private readNowMs(): number {
        return this.dependencies.clock.nowMs();
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

export function isALOutboundCanonicalRowFrozenBy(canonicalEntry: ResourceEntry, msg: ALMessage): boolean {
    if (resolveALFrozenMulticastAudience(msg.targets) === undefined) {
        return false;
    }
    const canonical = decodeALAdmissionValue(
        canonicalEntry.resource,
        JSON.stringify(canonicalEntry.key),
        () => decodePersistedALMessageRow(canonicalEntry)
    );
    return isALFreezeOfMessage(canonical, msg);
}

/**
 * The message as its sender asked for it: what this admission added -- a minted sequence, a recorded record, a proof
 * -- is not part of it until a commit lands.
 */
function toALOutboundRequestedMessage<TPrepared>(read: ALOutboundMessageReadDto<TPrepared>): ALMessage {
    return hasALOutboundAdmissionAdditions(read)
        ? toALOutboundRequestComparableMessage(read.originalMsg, read.msg)
        : read.msg;
}

/**
 * Whether a first admission added to its request: it minted a sequence, stamped a record or signed the frame. A
 * recording that stamps nothing, a dequeue's, adds nothing to the message: its copy stays the row as admitted.
 */
function hasALOutboundAdmissionAdditions<TPrepared>(read: ALOutboundMessageReadDto<TPrepared>): boolean {
    const { originalMsg, msg } = read;
    return read.storedMessage === undefined && (
        (originalMsg.ordering?.seq === undefined && msg.ordering?.seq !== undefined) ||
        (originalMsg.ordering?.priorSeqByRecipient === undefined && msg.ordering?.priorSeqByRecipient !== undefined) ||
        (originalMsg.proof === undefined && msg.proof !== undefined)
    );
}

/** Each member's value in member order; the first member that threw rethrows, as a lone commit would. */
function toALOutboundGroupSettledValues<T>(settled: readonly PromiseSettledResult<T>[]): readonly T[] {
    return settled.map((outcome) => {
        if (outcome.status === 'rejected') {
            throw toError(outcome.reason);
        }
        return outcome.value;
    });
}

/** Independent reads must agree on the sender version before their bundles can share one commit fence. */
function hasOneALOutboundSenderVersion<TPrepared>(decisions: readonly ALOutboundCommitDecision<TPrepared>[]): boolean {
    const [first] = decisions;
    return decisions.every(({ bundle }) =>
        bundle.senderId === first?.bundle.senderId && bundle.expectedVersion === first.bundle.expectedVersion
    );
}

/** A row left behind its batch predecessor: not ready, so its claim is due again at the next pass, uncharged. */
function toALOutboundLeftBehindPredecessorOutcome<TPrepared>(): PromiseSettledResult<
    ALOutboundDispatchAdmission.Result<TPrepared>
> {
    return {
        status: 'rejected',
        reason: new NotReadyException(
            AL_OUTBOUND_LEFT_BEHIND_RETRY_MS,
            'Outbound row follows its batch predecessor, which did not commit ahead of it'
        )
    };
}
