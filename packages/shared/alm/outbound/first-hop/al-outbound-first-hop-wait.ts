import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALReceiptMode } from '../../../al-contracts/al-policy.ts';
import { RetryableConflictError } from '../../../resilience/try-with-policy.ts';
import type {
    ALOutboundAdmissionStore,
    ALOutboundCommitBundle,
    ALOutboundPlanner,
    ALOutboundRepairReadDto
} from '../admission/al-outbound-admission-store.ts';
import type { ALOutboundDispatchAdmission } from '../al-outbound-dispatch-admission.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundMessageRuntime,
    ALOutboundSettlementEmitter,
    ALOutboundSettlementFact
} from '../al-outbound-message-runtime.ts';
import { readALOutboundSendAttemptHeld } from '../attempt-deadline/read-al-outbound-send-attempt-held.ts';
import { toALOutboundAdmissionVerdict } from '../compute-al-outbound-dispatch.ts';
import { resolveALOutboundReplanRefusalSettlement } from '../control/resolve-al-outbound-replan-refusal-settlement.ts';
import { toALOutboundReceiptExhaustedFact } from '../control/to-al-outbound-receipt-exhausted-fact.ts';
import { toALOutboundReadMessageEndBundle } from '../message-end/to-al-outbound-message-end-bundle.ts';
import {
    computeALOutboundFirstHopTimeout,
    toALOutboundFirstHopTimeoutEffect,
    type ALOutboundFirstHopTimeoutDecision,
    type ALOutboundFirstHopWaitSnapshot
} from './compute-al-outbound-first-hop-wait.ts';

export namespace ALOutboundFirstHopWait {
    export interface Dependencies<TPrepared> {
        readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
        readonly dispatchAdmission: ALOutboundDispatchAdmission<TPrepared>;
        readonly clock: ALOutboundMessageRuntime.Clock;
        readonly planOutgoingMessage: ALOutboundPlanner<TPrepared>;
        /** The lane's guarded emitter: where a wait whose retries ran out states its receipt exhausted. */
        readonly settlements: ALOutboundSettlementEmitter;
    }

    /** The message a wait resends: retained, not ended, re-planned with its receipt, and before its deadline. */
    export interface LiveMessage<TPrepared> {
        readonly msg: ALMessage;
        readonly plan: ALOutboundDispatchPlan<TPrepared>;
        readonly mode: ALReceiptMode;
        readonly expiresAtMs: number;
    }

    /** A deadline of a live message's wait, and what it decided. */
    export interface LiveTimeout<TPrepared> {
        readonly wait: ALOutboundFirstHopWaitSnapshot;
        readonly live: LiveMessage<TPrepared>;
        readonly decision: ALOutboundFirstHopTimeoutDecision;
    }
}

/**
 * Runs a first-hop deadline. A resend is two commits, each fenced on the sender's version: the wait's next attempt and
 * its timer, then the dispatch that writes the frame. A crash between them spends one attempt that wrote no frame.
 */
export class ALOutboundFirstHopWait<TPrepared> {
    private readonly dependencies: ALOutboundFirstHopWait.Dependencies<TPrepared>;

    constructor(dependencies: ALOutboundFirstHopWait.Dependencies<TPrepared>) {
        this.dependencies = dependencies;
    }

    async retry(msgId: string): Promise<void> {
        const { admissionStore, clock, planOutgoingMessage } = this.dependencies;
        const read = await admissionStore.readRepairMessage(msgId, planOutgoingMessage);
        const wait = read.firstHopWait;
        const nowMs = clock.nowMs();
        const live = toLiveMessage(read, nowMs);
        const decision = computeALOutboundFirstHopTimeout({
            wait,
            messageLive: live !== undefined,
            attemptHeld: wait !== undefined && live !== undefined &&
                await readALOutboundSendAttemptHeld(admissionStore, {
                    ...wait,
                    preparedMessages: live.plan.preparedMessages
                }),
            replanRefusal: live && resolveALOutboundReplanRefusalSettlement(
                live.msg,
                toALOutboundAdmissionVerdict(live.plan),
                'first-hop-timeout'
            ),
            nowMs
        });
        if (wait === undefined || decision.kind === 'ended') {
            return;
        }
        if (live === undefined || decision.kind === 'orphaned') {
            await this.commitOrphanedWait(read, msgId);
            return;
        }
        await this.commitDecision(read, { wait, live, decision });
    }

    private async commitDecision(
        read: ALOutboundRepairReadDto<TPrepared>,
        timeout: ALOutboundFirstHopWait.LiveTimeout<TPrepared>
    ): Promise<void> {
        const { wait, live, decision } = timeout;
        switch (decision.kind) {
            case 'refused':
                await this.commitEnd(read, live, decision.refusal);
                return;
            case 'exhausted':
                await this.commitEnd(read, live, toFirstHopExhaustedFact(wait, live));
                return;
            case 'early':
                await this.commitWait(read, live, [], [toALOutboundFirstHopTimeoutEffect(wait, live.expiresAtMs)]);
                return;
            case 'unwritten':
            case 'resend': {
                const status = await this.commitWait(
                    read,
                    live,
                    [{ kind: 'set-first-hop-wait', snapshot: decision.next, expireAtTimestamp: live.expiresAtMs }],
                    [toALOutboundFirstHopTimeoutEffect(decision.next, live.expiresAtMs)]
                );
                if (decision.kind === 'resend' && status === 'committed') {
                    await this.resend(live, decision.next);
                }
            }
        }
    }

    /** The message ends in the commit whose success states it, so the fact is stated once across replays and reloads. */
    private async commitEnd(
        read: ALOutboundRepairReadDto<TPrepared>,
        live: ALOutboundFirstHopWait.LiveMessage<TPrepared>,
        fact: ALOutboundSettlementFact
    ): Promise<void> {
        const end = toALOutboundReadMessageEndBundle<TPrepared>(live.msg, read);
        if (await this.commitBundle(end) === 'committed') {
            this.dependencies.settlements(fact);
        }
    }

    /**
     * A wait whose message is gone, or ended in a commit that did not read the wait, has nothing left to resend;
     * without a sender record nothing fences its end.
     */
    private async commitOrphanedWait(read: ALOutboundRepairReadDto<TPrepared>, msgId: string): Promise<void> {
        if (read.clientRecord === undefined) {
            return;
        }
        await this.commitBundle({
            senderId: read.clientRecord.senderId,
            expectedVersion: read.clientRecord.version,
            mutations: [{ kind: 'delete-first-hop-wait', msgId }],
            durableEffects: [],
            endedTimeoutEffectIds: []
        });
    }

    private async resend(
        live: ALOutboundFirstHopWait.LiveMessage<TPrepared>,
        next: ALOutboundFirstHopWaitSnapshot
    ): Promise<void> {
        const { plan } = live;
        await this.dependencies.dispatchAdmission.commit({
            msg: live.msg,
            batchPredecessorSeqs: [],
            planner: () => plan,
            intent: 'repair',
            phase: 'immediate',
            origin: 'repair',
            options: { attemptIdentity: next.attemptIdentity }
        });
    }

    /** A commit fenced on the sender version the read saw; a conflict retries the deadline from a fresh read. */
    private async commitWait(
        read: ALOutboundRepairReadDto<TPrepared>,
        live: ALOutboundFirstHopWait.LiveMessage<TPrepared>,
        mutations: ALOutboundCommitBundle<TPrepared>['mutations'],
        durableEffects: ALOutboundCommitBundle<TPrepared>['durableEffects']
    ): Promise<'committed' | 'expired'> {
        return await this.commitBundle({
            senderId: live.msg.id.senderId,
            expectedVersion: read.clientRecord?.version,
            mutations,
            durableEffects,
            endedTimeoutEffectIds: []
        });
    }

    private async commitBundle(bundle: ALOutboundCommitBundle<TPrepared>): Promise<'committed' | 'expired'> {
        const status = await this.dependencies.admissionStore.commitBundle(bundle);
        if (status === 'conflict') {
            throw new RetryableConflictError('Outbound first-hop wait commit conflict');
        }
        return status;
    }
}

function toLiveMessage<TPrepared>(
    read: ALOutboundRepairReadDto<TPrepared>,
    nowMs: number
): ALOutboundFirstHopWait.LiveMessage<TPrepared> | undefined {
    const msg = read.sentSnapshot?.msg;
    const mode = read.plan?.ackTracking?.mode;
    const expiresAtMs = read.storedMessage?.reference.expiresAtMs;
    if (
        msg === undefined || read.plan === undefined || mode === undefined || expiresAtMs === undefined ||
        read.storedMessage?.ended
    ) {
        return undefined;
    }
    return expiresAtMs > nowMs ? { msg, plan: read.plan, mode, expiresAtMs } : undefined;
}

function toFirstHopExhaustedFact<TPrepared>(
    wait: ALOutboundFirstHopWaitSnapshot,
    live: ALOutboundFirstHopWait.LiveMessage<TPrepared>
): ALOutboundSettlementFact {
    return toALOutboundReceiptExhaustedFact({
        receipt: {
            msgId: wait.msgId,
            mode: live.mode,
            expectedPeerIds: [],
            ackedPeerIds: [],
            outsideAudiencePeerIds: []
        },
        exhaustion: { cause: 'budget' },
        detail: `The first hop did not answer after ${wait.attempts} of ${wait.maxAttempts} retries.`,
        traceId: live.msg.id.traceId
    });
}
