import { NonRetryableException } from '../../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { isNotReadyException } from '../../../queuebox/resource-inbox/not-ready-exception.ts';
import type { Key, ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
import { BoundedConcurrencyAdmission } from '../../../resilience/bounded-concurrency-admission.ts';
import type { ALStoreDurability } from '../../al-runtime-stores.ts';
import type { ALDeliveryAdmissionVerdict } from '../../delivery/al-delivery-lifecycle.ts';
import type { ALWorkAttemptResult, ALWorkBatchDiagnostics } from '../../work/al-work-handler.ts';
import type { ALWorkClaim, ALWorkOutcome } from '../../work/al-work-queue-port.ts';
import type {
    ALOutboundAdmissionStore,
    ALOutboundEffectSnapshot
} from '../admission/al-outbound-admission-store.ts';
import type { ALOutboundDispatchAdmission } from '../al-outbound-dispatch-admission.ts';
import type {
    ALOutboundDequeueAuthority,
    ALOutboundMessageRuntime,
    ALOutboundSettlementEmitter
} from '../al-outbound-message-runtime.ts';
import type { ALOutboundComputedDto } from '../compute-al-outbound-dispatch.ts';
import type { ALOutboundReceiptWorkEvidence } from './al-outbound-receipt-observation.ts';
import { readALOutboundDequeueWait } from './read-al-outbound-dequeue-wait.ts';
import { recordALOutboundDequeueTiming } from './record-al-outbound-dequeue-timing.ts';
import {
    recordALOutboundClaimAdmissionVerdict,
    type ALOutboundClaimAttemptSettlement,
    type ALOutboundClaimObservation
} from './settle-al-outbound-claim.ts';

/** How many rows of one dequeued batch read at once, against the server's pool of five connections. */
export const AL_OUTBOUND_DEQUEUED_READ_CONCURRENCY = 2;

export namespace ALOutboundDequeuedAdmission {
    export type TimingStage =
        | 'reservation-return'
        | 'admission-start'
        | 'pending-authority-read-start'
        | 'pending-authority-read-end'
        | 'authority-read-start'
        | 'authority-read-end'
        | 'admission-read-end'
        | 'admission-commit-start'
        | 'admission-commit-end'
        | 'ordered-dispatch-start'
        | 'admission-end'
        | 'attempt-settled';

    export interface TimingEvent {
        readonly stage: TimingStage;
        readonly lane?: ALStoreDurability;
        readonly workerId?: string;
        readonly batchStartedAtMs?: number;
        readonly key: Key;
        readonly attempts: number;
        readonly claimStartedAtEpochMs: number | undefined;
        readonly batchIndex: number;
        readonly publicationKey?: Key;
        readonly outcome?: string;
        readonly verdict?: ALDeliveryAdmissionVerdict['kind'];
        readonly reason?: string;
    }

    /** The claimed row identity and position required by server timing translation. */
    export interface TimingMember {
        readonly effect: Readonly<{ entry: ResourceEntry; attempts: number; }>;
        readonly batchIndex: number;
    }

    /** Source facts cross the optional port; only the server timing owner constructs log details. */
    export type TimingObservation =
        | Readonly<{ kind: 'work-batch'; lane: ALStoreDurability; batch: ALWorkBatchDiagnostics; }>
        | Readonly<{
            kind: 'admission-group';
            lane: ALStoreDurability;
            entry: ResourceEntry;
            memberCount: number;
            startedAtMs: number;
            decisionDurationMs: number;
            bundleDurationMs: number;
            outcome: 'not-attempted' | 'committed' | 'conflict' | 'expired' | 'error';
        }>
        | Readonly<{
            kind: 'reservation-returns';
            lane: ALStoreDurability;
            workerId: string;
            batchStartedAtMs: number;
            claims: readonly ALWorkClaim[];
            dequeueTypes: ReadonlySet<string>;
        }>
        | Readonly<{
            kind: 'admission-stage';
            stage: TimingStage;
            member: TimingMember;
            outcome?: string;
            publicationKey?: Key;
        }>
        | Readonly<{
            kind: 'attempt-settled';
            settlement: ALOutboundClaimAttemptSettlement;
            outcome: string;
        }>;

    export type TimingSink = (observation: TimingObservation) => void;

    export interface Dependencies<TPrepared> {
        readonly runtime: ALOutboundMessageRuntime.Dependencies<TPrepared>;
        /** The store of the lane these rows admit through. */
        readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
        /** One sender's dispatches under one fence when they can share it; each keeps its own answer. */
        readonly commitDispatchPlans: (
            dispatches: readonly ALOutboundDispatchAdmission.Input<TPrepared>[]
        ) => Promise<readonly PromiseSettledResult<ALOutboundComputedDto<TPrepared>>[]>;
        /** Aborts with the runtime, so an aborted signal is exactly a disposed runtime. */
        readonly sendSignal: AbortSignal;
        readonly settlements: ALOutboundSettlementEmitter;
        readonly timing: TimingSink | undefined;
    }

    /** One dequeued row of a batch, with the evidence its attempt records. */
    export interface Member<TPrepared> {
        readonly effect: ALOutboundEffectSnapshot<TPrepared>;
        readonly evidence: ALOutboundReceiptWorkEvidence | undefined;
        readonly observation: ALOutboundClaimObservation;
        readonly batchIndex: number;
    }
}

/** Admits foreign queue rows as outbound messages: one row alone, or the rows of one batch together. */
export class ALOutboundDequeuedAdmission<TPrepared> {
    private readonly dependencies: ALOutboundDequeuedAdmission.Dependencies<TPrepared>;

    constructor(dependencies: ALOutboundDequeuedAdmission.Dependencies<TPrepared>) {
        this.dependencies = dependencies;
    }

    /** One dequeued row admitted on its own: a batch of one. */
    async admitDequeuedMessage(
        effect: ALOutboundEffectSnapshot<TPrepared>,
        evidence: ALOutboundReceiptWorkEvidence | undefined,
        observation: ALOutboundClaimObservation
    ): Promise<ALWorkAttemptResult> {
        const [attempt] = this.admitDequeuedMessages([{ effect, evidence, observation, batchIndex: 0 }]);
        return await attempt!;
    }

    /**
     * The dequeued rows of one batch: each passes its gate and reads its decision surface, the rows of one
     * sender commit under one fence (each alone when they cannot share it), then each row's after-admission
     * effect runs in row order. Every row keeps its own attempt and its own breaker charge, exactly as alone.
     * The rows read two at a time: a batch reading at once holds the server's whole small pool, and one at a time
     * would give up the shared statements of reads issued in one turn.
     */
    admitDequeuedMessages(
        members: readonly ALOutboundDequeuedAdmission.Member<TPrepared>[]
    ): readonly Promise<ALWorkAttemptResult>[] {
        const reading = new BoundedConcurrencyAdmission({ maxConcurrent: AL_OUTBOUND_DEQUEUED_READ_CONCURRENCY });
        const fronts = members.map((member) => reading.admit(() => this.readDequeuedFront(member)));
        const reads = members.map((member, index) =>
            fronts[index]!.then((settled) =>
                settled === undefined
                    ? reading.admit(() => this.readDequeuedDispatch(member))
                    : undefined
            )
        );
        const commits = this.commitDequeuedDispatches(reads, members);
        let previous: Promise<void> = Promise.resolve();
        return members.map((member, index) => {
            const attempt = previous.then(async () => {
                try {
                    const front = await fronts[index]!;
                    const outcome = front !== undefined
                        ? front
                        : await this.chargeDequeued(() =>
                            this.finishDequeuedAdmission({ member, read: reads[index]!, commits, index })
                        );
                    this.recordTiming(member, 'admission-end', outcome.status);
                    return outcome;
                }
                catch (error) {
                    this.recordTiming(member, 'admission-end', 'error');
                    throw error;
                }
            });
            previous = attempt.then(() => undefined, () => undefined);
            return attempt;
        });
    }

    /** The gate and the authority wait: an outcome they decide is never a breaker charge. */
    private async readDequeuedFront(
        member: ALOutboundDequeuedAdmission.Member<TPrepared>
    ): Promise<ALWorkAttemptResult | undefined> {
        this.recordTiming(member, 'admission-start');
        member.evidence?.recordStage('dequeue-gate');
        const { resilience } = this.dependencies.runtime.dequeue;
        if (resilience.isNotAllowedThroughToDequeue()) {
            return { status: 'not-ready', readyAtMs: this.readNowMs() + resilience.toCircuitOpenBackoffMs() };
        }
        this.recordTiming(member, 'pending-authority-read-start');
        try {
            const result = await readALOutboundDequeueWait({
                effect: member.effect,
                readAuthority: this.dependencies.runtime.readPendingAdmissionAuthority,
                settlements: this.dependencies.settlements,
                clock: this.dependencies.runtime.clock,
                signal: this.dependencies.sendSignal
            });
            this.recordTiming(member, 'pending-authority-read-end', result?.status ?? 'ready');
            return result;
        }
        catch (error) {
            this.recordTiming(member, 'pending-authority-read-end', 'error');
            throw error;
        }
    }

    private async readDequeuedDispatch(
        member: ALOutboundDequeuedAdmission.Member<TPrepared>
    ): Promise<ALOutboundDequeuedRead<TPrepared>> {
        const { effect, evidence } = member;
        const runtime = this.dependencies.runtime;
        const msg = effect.canonicalMessage;
        if (!msg) {
            throw new NonRetryableException('Dequeued work has no message');
        }
        evidence?.recordStage('dequeue-authority');
        let dequeueAuthority: ALOutboundDequeueAuthority | undefined;
        if (runtime.readDequeueAuthority !== undefined) {
            this.recordTiming(member, 'authority-read-start');
            try {
                dequeueAuthority = await runtime.readDequeueAuthority(msg, effect.entry);
                this.recordTiming(member, 'authority-read-end', 'ok');
            }
            catch (error) {
                this.recordTiming(member, 'authority-read-end', 'error');
                throw error;
            }
        }
        evidence?.recordStage('dequeue-supersedence');
        if (await this.dependencies.admissionStore.isMessageSuperseded(msg)) {
            this.recordTiming(member, 'admission-read-end', 'superseded');
            return { kind: 'superseded' };
        }
        this.recordTiming(member, 'admission-read-end', 'dispatch');
        evidence?.recordStage('dequeue-commit');
        return {
            kind: 'dispatch',
            dispatch: {
                msg,
                dequeueAuthority,
                planner: runtime.planDequeuedMessage,
                intent: 'dequeue',
                phase: 'dequeue',
                origin: 'drain',
                options: {
                    observedOutboxEntry: effect.entry,
                    claimedOutboxEntry: effect.entry,
                    attemptIdentity: JSON.stringify([
                        'queue',
                        effect.attempts,
                        effect.entry.dequeueAudit.startTs?.toString() ?? null
                    ])
                }
            }
        };
    }

    /** Every row's read settles first; then each sender's dispatches commit together, in row order. */
    private async commitDequeuedDispatches(
        reads: readonly Promise<ALOutboundDequeuedRead<TPrepared> | undefined>[],
        members: readonly ALOutboundDequeuedAdmission.Member<TPrepared>[]
    ): Promise<readonly (PromiseSettledResult<ALOutboundComputedDto<TPrepared>> | undefined)[]> {
        const dispatches = (await Promise.allSettled(reads)).map((read) =>
            read.status === 'fulfilled' && read.value?.kind === 'dispatch' ? read.value.dispatch : undefined
        );
        const indexesBySender = new Map<string, number[]>();
        dispatches.forEach((dispatch, index) => {
            if (dispatch !== undefined) {
                const senderId = dispatch.msg.id.senderId;
                indexesBySender.set(senderId, [...(indexesBySender.get(senderId) ?? []), index]);
            }
        });
        const commits: (PromiseSettledResult<ALOutboundComputedDto<TPrepared>> | undefined)[] = dispatches.map(
            () => undefined
        );
        await Promise.all([...indexesBySender.values()].map(async (indexes) => {
            for (const index of indexes) {
                this.recordTiming(members[index]!, 'admission-commit-start');
            }
            try {
                const settled = await this.dependencies.commitDispatchPlans(indexes.map((index) => dispatches[index]!));
                indexes.forEach((index, position) => {
                    commits[index] = settled[position];
                    const result = settled[position];
                    this.recordTiming(
                        members[index]!,
                        'admission-commit-end',
                        result?.status ?? 'missing'
                    );
                });
            }
            catch (error) {
                for (const index of indexes) {
                    this.recordTiming(members[index]!, 'admission-commit-end', 'error');
                }
                throw error;
            }
        }));
        return commits;
    }

    private async finishDequeuedAdmission(input: ALOutboundDequeuedFinishInput<TPrepared>): Promise<ALWorkOutcome> {
        const { member, read, commits, index } = input;
        const admission = await read;
        if (admission?.kind !== 'dispatch') {
            return { status: 'completed' };
        }
        const commit = (await commits)[index];
        if (commit === undefined) {
            throw new TypeError('A dequeued dispatch reached no commit');
        }
        if (commit.status === 'rejected') {
            throw commit.reason;
        }
        const computed = commit.value;
        member.evidence?.recordAdmission(computed.verdict.kind);
        recordALOutboundClaimAdmissionVerdict(member.observation, computed.verdict);
        if (computed.verdict.kind === 'unroutable' && computed.verdict.reason === 'no-route') {
            return { status: 'retry' };
        }
        const [entry] = computed.entries;
        if (computed.msg && entry) {
            member.evidence?.recordStage('dequeue-after-admission');
            this.recordOrderedDispatchStart(member, entry.key, computed.verdict.kind);
            await this.dependencies.runtime.afterDequeueAdmission?.(computed.msg, entry);
        }
        return { status: 'completed' };
    }

    private recordTiming(
        member: ALOutboundDequeuedAdmission.Member<TPrepared>,
        stage: ALOutboundDequeuedAdmission.TimingStage,
        outcome?: string
    ): void {
        const sink = this.dependencies.timing;
        if (sink === undefined) {
            return;
        }
        recordALOutboundDequeueTiming(sink, {
            kind: 'admission-stage',
            stage,
            member,
            outcome
        });
    }

    private recordOrderedDispatchStart(
        member: ALOutboundDequeuedAdmission.Member<TPrepared>,
        publicationKey: Key,
        outcome: string
    ): void {
        const sink = this.dependencies.timing;
        if (sink === undefined) {
            return;
        }
        recordALOutboundDequeueTiming(sink, {
            kind: 'admission-stage',
            stage: 'ordered-dispatch-start',
            member,
            outcome,
            publicationKey
        });
    }

    /**
     * The breaker's whole accounting for one admitted row: the work handler turns a rejection and a thrown
     * store error alike into an outcome, so an attempt that never returns still owes a charge. A typed
     * `retry` (no current route for the row) is an expected outcome and charges nothing.
     */
    private async chargeDequeued(run: () => Promise<ALWorkOutcome>): Promise<ALWorkOutcome> {
        const { resilience } = this.dependencies.runtime.dequeue;
        try {
            const outcome = await run();
            if (outcome.status !== 'retry') {
                resilience.success();
            }
            return outcome;
        }
        catch (error) {
            if (!(error instanceof Error && isNotReadyException(error))) {
                resilience.failure();
            }
            throw error;
        }
    }

    private readNowMs(): number {
        return this.dependencies.runtime.clock.nowMs();
    }
}

/** What a dequeued row's read decided: superseded already, or the dispatch it commits. */
type ALOutboundDequeuedRead<TPrepared> =
    | Readonly<{ kind: 'superseded'; }>
    | Readonly<{ kind: 'dispatch'; dispatch: ALOutboundDispatchAdmission.Input<TPrepared>; }>;

interface ALOutboundDequeuedFinishInput<TPrepared> {
    readonly member: ALOutboundDequeuedAdmission.Member<TPrepared>;
    readonly read: Promise<ALOutboundDequeuedRead<TPrepared> | undefined>;
    readonly commits: Promise<readonly (PromiseSettledResult<ALOutboundComputedDto<TPrepared>> | undefined)[]>;
    readonly index: number;
}
