import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodeALMessageValue, type ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import { resolveALMessageExpireAtMs, type ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { NOT_COMPLETED_RETRYABLE_STATUSES } from '../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import { Either } from '../../resilience/Either.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type { ALWorkQueuePort } from '../work/al-work-queue-port.ts';
import type { ALInboundPlanner } from './al-inbound-admission-store.ts';
import { toALInboundMessageWithDeadline } from './al-inbound-message-deadline.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';
import { toALInboundPendingAdmissionId, type ALInboundPendingAdmission } from './al-inbound-pending-admission.ts';
import { computeALInboundPlanningObservations } from './al-inbound-planner-snapshot.ts';
import { computeALInboundWorkEntry, decodeALInboundWorkEntry } from './al-inbound-work-entry.ts';
import { computeALInboundAdmission } from './compute-al-inbound-admission.ts';
import { readALInboundEffectFacts } from './prepare-al-inbound-commit-bundle.ts';
import { validateALInboundCommitBundle } from './validate-al-inbound-commit-bundle.ts';
import { validateALInboundMessage } from './validate-al-inbound-message.ts';

export namespace ALInboundMessageAdmission {
    export interface Dependencies extends
        Pick<
            ALInboundMessageRuntime.Dependencies,
            | 'admissionStore'
            | 'clock'
            | 'effectPreparation'
            | 'planIncomingMessage'
            | 'forwardMessage'
            | 'canForwardMessage'
            | 'readPendingAdmissionAuthority'
        > {
        readonly workPort: ALWorkQueuePort;
    }

    export type ReplayResult = 'completed' | 'retry' | { readonly kind: 'not-ready'; readonly retryAfterMs: number; };

    export type Attempt =
        | { readonly kind: 'completed'; readonly acceptance: ALInboundMessageRuntime.Acceptance; }
        | { readonly kind: 'conflict'; readonly pending: ALInboundPendingAdmission | undefined; };
}

/** One conditional admission per call; the existing QueueBox worker owns retries. */
export class ALInboundMessageAdmission {
    private readonly dependencies: ALInboundMessageAdmission.Dependencies;
    private readonly shutdown = new AbortController();

    constructor(dependencies: ALInboundMessageAdmission.Dependencies) {
        this.dependencies = dependencies;
    }

    dispose(): void {
        this.shutdown.abort();
    }

    async attempt(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source,
        planner: ALInboundPlanner
    ): Promise<Either<ALMessageRejection, ALInboundMessageAdmission.Attempt>> {
        const { admissionStore, clock, effectPreparation } = this.dependencies;
        const nowMs = clock.nowMs();
        const prePlan = planner(msg, source, { nowMs });
        const initialDeadline = resolveALMessageExpireAtMs(msg, prePlan.effective);
        const admitted = initialDeadline === undefined ? msg : toALInboundMessageWithDeadline(msg, initialDeadline);
        const decoded = decodeALMessageValue(admitted);
        if (decoded.left) {
            return Either.ofLeft(decoded.left);
        }
        const facts = readALInboundEffectFacts(nowMs, effectPreparation);
        const read = await admissionStore.readIncomingMessage({ msg: admitted, source, nowMs, prePlan });
        if (this.shutdown.signal.aborted) {
            return Either.ofRight({ kind: 'completed', acceptance: { kind: 'disposed' } });
        }
        const plan = planner(admitted, source, computeALInboundPlanningObservations(read));
        const deadline = resolveALMessageExpireAtMs(admitted, plan.effective) ??
            nowMs + read.retention.durableEffectTtlMs;
        if (deadline <= clock.nowMs()) {
            return Either.ofRight({ kind: 'completed', acceptance: { kind: 'not-admitted', reason: 'expired' } });
        }
        const canForward = !plan.dropReason && this.dependencies.forwardMessage !== undefined &&
            (this.dependencies.canForwardMessage?.(admitted) ?? true);
        const computed = computeALInboundAdmission({ read, plan, canForward, facts });
        const validated = validateALInboundCommitBundle(computed, read.namespace);
        if (validated.left) {
            return Either.ofLeft(validated.left);
        }
        const status = await admissionStore.commitBundle(validated.right!);
        if (status === 'expired') {
            return Either.ofRight({ kind: 'completed', acceptance: { kind: 'not-admitted', reason: 'expired' } });
        }
        if (status === 'conflict') {
            return Either.ofRight({
                kind: 'conflict',
                pending: plan.dropReason ? undefined : {
                    kind: 'admit-message',
                    msg: toALInboundMessageWithDeadline(admitted, deadline),
                    source
                }
            });
        }
        return Either.ofRight({ kind: 'completed', acceptance: toAdmissionAcceptance(plan) });
    }

    async retainPending(pending: ALInboundPendingAdmission): Promise<ALInboundMessageRuntime.Acceptance> {
        const { admissionStore, clock } = this.dependencies;
        const deadline = pending.msg.constraints!.expiresAtMs!;
        if (deadline <= clock.nowMs()) {
            return { kind: 'not-admitted', reason: 'expired' };
        }
        const work = computeALInboundWorkEntry({
            namespace: admissionStore.namespace,
            effectId: toALInboundPendingAdmissionId(pending.msg),
            payload: pending,
            observedAtMs: clock.nowMs(),
            expireAtTimestamp: deadline
        });
        decodeALInboundWorkEntry(work.entry, admissionStore.namespace);
        const observed = await this.dependencies.workPort.retainIfAbsent(work.entry);
        const stored = decodeALInboundWorkEntry(observed, admissionStore.namespace);
        if (!jsonEquals(stored.payload, pending) || stored.expireAtTimestamp !== deadline) {
            throw new ALAdmissionCorruptionError(
                JSON.stringify(observed.key),
                new TypeError('Pending inbound admission differs from its immutable message or source')
            );
        }
        if (deadline <= clock.nowMs()) {
            return { kind: 'not-admitted', reason: 'expired' };
        }
        return NOT_COMPLETED_RETRYABLE_STATUSES.has(observed.status)
            ? { kind: 'pending-admission' }
            : { kind: 'not-admitted', reason: 'pending admission has terminated' };
    }

    async replay(pending: ALInboundPendingAdmission): Promise<ALInboundMessageAdmission.ReplayResult> {
        const authority = await this.dependencies.readPendingAdmissionAuthority?.(pending.msg, pending.source) ??
            { kind: 'authorized', source: pending.source };
        if (pending.msg.constraints!.expiresAtMs! <= this.dependencies.clock.nowMs()) {
            return 'completed';
        }
        if (authority.kind !== 'authorized') {
            return authority.kind === 'retry'
                ? { kind: 'not-ready', retryAfterMs: authority.retryAfterMs }
                : 'completed';
        }
        const validation = validateALInboundMessage(
            pending.msg,
            authority.source,
            this.dependencies.effectPreparation.selfPeerId
        );
        if (validation.left) {
            throw new NonRetryableException(validation.left.message);
        }
        const result = await this.attempt(pending.msg, authority.source, this.dependencies.planIncomingMessage);
        if (result.left) {
            throw new NonRetryableException(result.left.message);
        }
        return result.right!.kind === 'conflict' || this.shutdown.signal.aborted ? 'retry' : 'completed';
    }
}

function toAdmissionAcceptance(plan: ALMessageHandlingPlan): ALInboundMessageRuntime.Acceptance {
    if (plan.orderingRuntime.status === 'resync-required') {
        return { kind: 'resync-required' };
    }
    if (plan.dropReason?.startsWith('Duplicate message')) {
        return { kind: 'duplicate' };
    }
    return plan.dropReason ? { kind: 'not-admitted', reason: plan.dropReason } : { kind: 'admitted' };
}
