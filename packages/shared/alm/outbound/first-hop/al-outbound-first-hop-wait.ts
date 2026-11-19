import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALReceiptMode } from '../../../al-contracts/al-policy.ts';
import type { ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
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
    ALOutboundSettlementEmitter
} from '../al-outbound-message-runtime.ts';
import { toALOutboundWorkKey } from '../al-outbound-work-entry.ts';
import { toALOutboundReceiptExhaustedFact } from '../control/to-al-outbound-receipt-exhausted-fact.ts';
import { toALOutboundSendEffectId } from '../to-al-outbound-effect-id.ts';
import { toALOutboundPreparedFingerprint } from '../to-al-outbound-prepared-fingerprint.ts';
import {
    computeALOutboundFirstHopTimeout,
    toALOutboundFirstHopTimeoutEffect,
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

    /** The message a wait resends: retained, re-planned with its receipt, and before its deadline. */
    export interface LiveMessage<TPrepared> {
        readonly msg: ALMessage;
        readonly plan: ALOutboundDispatchPlan<TPrepared>;
        readonly mode: ALReceiptMode;
        readonly expiresAtMs: number;
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
            attemptRows: wait !== undefined && live !== undefined ? await this.readAttemptRows(wait, live.plan) : [],
            nowMs
        });
        if (wait === undefined || decision.kind === 'ended') {
            return;
        }
        if (live === undefined || decision.kind === 'orphaned') {
            await this.commitWait(read, [{ kind: 'delete-first-hop-wait', msgId }], []);
            return;
        }
        switch (decision.kind) {
            case 'exhausted':
                await this.commitExhausted(read, wait, live);
                return;
            case 'early':
                await this.commitWait(read, [], [toALOutboundFirstHopTimeoutEffect(wait, live.expiresAtMs)]);
                return;
            case 'unwritten':
            case 'resend':
                await this.commitWait(
                    read,
                    [{ kind: 'set-first-hop-wait', snapshot: decision.next, expireAtTimestamp: live.expiresAtMs }],
                    [toALOutboundFirstHopTimeoutEffect(decision.next, live.expiresAtMs)]
                );
                if (decision.kind === 'resend') {
                    await this.resend(live, decision.next);
                }
        }
    }

    /** The send rows of the attempt the wait stands on: one per prepared copy the message is planned with. */
    private async readAttemptRows(
        wait: ALOutboundFirstHopWaitSnapshot,
        plan: ALOutboundDispatchPlan<TPrepared>
    ): Promise<readonly (ResourceEntry | undefined)[]> {
        const { admissionStore } = this.dependencies;
        return await Promise.all(
            plan.preparedMessages.map((prepared, index) =>
                admissionStore.readWork(toALOutboundWorkKey(
                    admissionStore.namespace,
                    toALOutboundSendEffectId({
                        msgId: wait.msgId,
                        phase: wait.phase,
                        attemptIdentity: wait.attemptIdentity,
                        index,
                        preparedFingerprint: toALOutboundPreparedFingerprint(prepared)
                    })
                ))
            )
        );
    }

    /** The wait's end goes in the commit whose success states it, so the fact is stated once across replays. */
    private async commitExhausted(
        read: ALOutboundRepairReadDto<TPrepared>,
        wait: ALOutboundFirstHopWaitSnapshot,
        live: ALOutboundFirstHopWait.LiveMessage<TPrepared>
    ): Promise<void> {
        const status = await this.commitWait(read, [{ kind: 'delete-first-hop-wait', msgId: wait.msgId }], []);
        if (status !== 'committed') {
            return;
        }
        this.dependencies.settlements(toALOutboundReceiptExhaustedFact({
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
        }));
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
        mutations: ALOutboundCommitBundle<TPrepared>['mutations'],
        durableEffects: ALOutboundCommitBundle<TPrepared>['durableEffects']
    ): Promise<'committed' | 'expired' | 'none'> {
        const senderId = read.clientRecord?.senderId;
        if (senderId === undefined) {
            return 'none';
        }
        const status = await this.dependencies.admissionStore.commitBundle({
            senderId,
            expectedVersion: read.clientRecord?.version,
            mutations,
            durableEffects
        });
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
    if (msg === undefined || read.plan === undefined || mode === undefined || expiresAtMs === undefined) {
        return undefined;
    }
    return expiresAtMs > nowMs ? { msg, plan: read.plan, mode, expiresAtMs } : undefined;
}
