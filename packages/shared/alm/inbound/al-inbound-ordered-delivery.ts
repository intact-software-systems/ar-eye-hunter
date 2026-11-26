import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { resolveALMessageExpireAtMs, type ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import { toALOrderingTrackKey, type ALOrderingObservation } from '../../al-contracts/al-runtime.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { computeALInboundDeliveryCompletion } from './admission/al-inbound-delivery-progress.ts';
import {
    computeALInboundBufferedRelease,
    type ALInboundBufferedRelease
} from './admission/compute-al-inbound-admission.ts';
import { retryALInboundLostWrite } from './admission/retry-al-inbound-lost-write.ts';
import { validateALInboundCommitBundle } from './admission/validate-al-inbound-commit-bundle.ts';
import type { ALInboundBufferedReleaseReadDto, ALInboundCommitBundle } from './al-inbound-admission-store.ts';
import { shouldRetryALInboundDelivery, type ALInboundEffectIntent } from './al-inbound-effect-intent.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';
import {
    computeALInboundBufferedReleasePlanningObservations,
    computeALInboundPredecessorReadiness
} from './al-inbound-planner-snapshot.ts';
import { toALInboundResyncCursor } from './al-inbound-resync-required.ts';
import { isAuthorizedStoredWsClientDelivery, toALDeliveryCarrier } from './al-inbound-source-validation.ts';
import {
    prepareALInboundCommitBundle,
    readALInboundEffectFacts
} from './prepare-al-inbound-commit-bundle.ts';
import { resolveALInboundSignFailurePolicy } from './receipt-proof/is-al-inbound-recipient-receipt.ts';
import { signALInboundReceiptControls } from './receipt-proof/sign-al-inbound-receipt-controls.ts';

/** One completion attempt: `conflict` when its write lost, so the next attempt reads and decides again. */
type ALInboundCompletionAttempt = 'completed' | 'retry' | 'conflict';

export namespace ALInboundOrderedDelivery {
    export type Readiness =
        | { readonly kind: 'ready' | 'waiting' | 'completed'; }
        | { readonly kind: 'resync-required'; readonly completedThrough: number; };

    export interface Dependencies extends
        Pick<
            ALInboundMessageRuntime.Dependencies,
            | 'admissionStore'
            | 'planIncomingMessage'
            | 'verifyPublicationProof'
            | 'clock'
            | 'effectPreparation'
            | 'readGapNackRelayHops'
            | 'onResyncRequired'
            | 'receiptProofs'
            | 'diagnostics'
        > {
        readonly signal: AbortSignal;
    }

    export interface ReleaseInput {
        readonly trackKey: string;
        readonly seq: number;
        readonly effectId: string;
    }

    export type ReleaseResult = 'completed' | 'retry' | NonNullable<ALInboundBufferedRelease['localDelivery']>;
}

/** Owns the retained ordering facts that authorize release, resynchronization, and completion. */
export class ALInboundOrderedDelivery {
    private readonly dependencies: ALInboundOrderedDelivery.Dependencies;

    constructor(dependencies: ALInboundOrderedDelivery.Dependencies) {
        this.dependencies = dependencies;
    }

    async release(input: ALInboundOrderedDelivery.ReleaseInput): Promise<ALInboundOrderedDelivery.ReleaseResult> {
        return await this.releaseOnce(input);
    }

    /** One fresh read of the slot and the track's progress, the decision, and the write when the release needs one. */
    private async releaseOnce(
        input: ALInboundOrderedDelivery.ReleaseInput
    ): Promise<ALInboundOrderedDelivery.ReleaseResult> {
        const { trackKey, seq, effectId } = input;
        const read = await this.dependencies.admissionStore.readBufferedRelease({
            trackKey,
            seq,
            nowMs: this.dependencies.clock.nowMs()
        });
        if (!read) {
            return await this.confirmCompletion(trackKey, seq);
        }
        const plan = await this.planRelease(read, effectId);
        const readiness = await this.readiness(read.snapshot.msg);
        if (shouldRetryALInboundDelivery(plan) || readiness.kind === 'waiting') {
            return 'retry';
        }
        if (readiness.kind === 'completed') {
            return 'completed';
        }
        if (readiness.kind === 'resync-required') {
            return await this.reject(read.snapshot.msg, readiness.completedThrough);
        }
        if (plan.dropReason || !plan.localDelivery.enabled) {
            return await this.complete(read.snapshot.msg);
        }
        return await this.commitRelease(read, plan);
    }

    /** The plan of a slot this work still owns, under its stored scope, before the message expired. */
    private async planRelease(read: ALInboundBufferedReleaseReadDto, effectId: string): Promise<ALMessageHandlingPlan> {
        if (read.snapshot.delivery?.effectId !== effectId) {
            throw new NonRetryableException('Inbound work no longer owns its buffered message');
        }
        if (!isAuthorizedStoredWsClientDelivery(read.snapshot.msg, read.source)) {
            throw new NonRetryableException('Stored WS client scope does not authorize buffered delivery');
        }
        await this.dependencies.verifyPublicationProof?.(read.snapshot.msg);
        const plan = this.dependencies.planIncomingMessage(
            read.snapshot.msg,
            read.source,
            computeALInboundBufferedReleasePlanningObservations(read)
        );
        const expiresAtMs = resolveALMessageExpireAtMs(read.snapshot.msg, plan.effective);
        if (expiresAtMs !== undefined && expiresAtMs <= this.dependencies.clock.nowMs()) {
            throw new NonRetryableException('Inbound buffered message expired before delivery');
        }
        return plan;
    }

    /** The release's one conditional write; the delivery it answers is dispatched only once it committed. */
    private async commitRelease(
        read: ALInboundBufferedReleaseReadDto,
        plan: ALMessageHandlingPlan
    ): Promise<ALInboundOrderedDelivery.ReleaseResult> {
        const facts = readALInboundEffectFacts(
            read.nowMs,
            this.dependencies.effectPreparation,
            () => this.dependencies.readGapNackRelayHops(read.snapshot.msg, [])
        );
        const computed = computeALInboundBufferedRelease({ read, plan, facts });
        const validated = validateALInboundCommitBundle(computed, read.namespace);
        if (validated.left) {
            throw new NonRetryableException(validated.left.message);
        }
        const signed = await this.signReceiptControls(validated.right!, read.namespace, read.snapshot.msg);
        if (this.dependencies.signal.aborted) {
            return 'retry';
        }
        const status = await this.dependencies.admissionStore.commitBundle(signed);
        if (status === 'conflict' || this.dependencies.signal.aborted) {
            return 'retry';
        }
        const delivery = computed.localDelivery;
        if (delivery === undefined) {
            return await this.complete(read.snapshot.msg);
        }
        return delivery;
    }

    async readiness(msg: ALMessage): Promise<ALInboundOrderedDelivery.Readiness> {
        const seq = msg.ordering?.seq;
        const trackKey = toALOrderingTrackKey(msg);
        if (seq === undefined || trackKey === undefined) {
            return { kind: 'ready' };
        }
        const read = await this.dependencies.admissionStore.readOrderedDelivery(trackKey, seq);
        return computeALInboundPredecessorReadiness({
            orderedDelivery: read,
            seq
        });
    }

    async reject(msg: ALMessage, completedThrough: number): Promise<'retry'> {
        const trackKey = toALOrderingTrackKey(msg);
        const seq = msg.ordering?.seq;
        if (trackKey === undefined || seq === undefined) {
            throw new NonRetryableException('Inbound message cannot be delivered');
        }
        const read = await this.dependencies.admissionStore.readBufferedRelease({
            trackKey,
            seq,
            nowMs: this.dependencies.clock.nowMs()
        });
        if (read === undefined) {
            throw new NonRetryableException('Inbound ordered delivery requires resynchronization');
        }
        if ((read.observations.deliveryProgress?.value?.completedThrough ?? 0) !== completedThrough) {
            return 'retry';
        }
        const ordering: ALOrderingObservation = {
            status: 'resync-required',
            trackKey,
            seq,
            missingRanges: [],
            releasableSeqs: []
        };
        const computed = prepareALInboundCommitBundle({
            read,
            facts: readALInboundEffectFacts(
                read.nowMs,
                this.dependencies.effectPreparation,
                () => this.dependencies.readGapNackRelayHops(msg, [])
            ),
            mutations: [],
            effects: [toResyncRequiredNackEffect(msg, read, ordering)]
        });
        const validated = validateALInboundCommitBundle(computed, read.namespace);
        if (validated.left) {
            throw new NonRetryableException(validated.left.message);
        }
        const signed = await this.signReceiptControls(validated.right!, read.namespace, msg);
        if (
            this.dependencies.signal.aborted ||
            await this.dependencies.admissionStore.commitBundle(signed) === 'conflict'
        ) {
            return 'retry';
        }
        this.recordResyncRequired(msg, read, {
            ...ordering,
            lastContiguousSeq: completedThrough,
            expectedSeq: completedThrough + 1
        });
        throw new NonRetryableException('Inbound ordered delivery requires resynchronization');
    }

    private async signReceiptControls(
        bundle: ALInboundCommitBundle,
        namespace: string,
        msg: ALMessage
    ): Promise<ALInboundCommitBundle> {
        return await signALInboundReceiptControls({
            bundle,
            namespace,
            receiptProofs: this.dependencies.receiptProofs,
            signFailure: resolveALInboundSignFailurePolicy(msg),
            diagnostics: this.dependencies.diagnostics
        });
    }

    /** After the NACK commits, so the owner is told of a resynchronization the sender is already told of. */
    private recordResyncRequired(
        msg: ALMessage,
        read: ALInboundBufferedReleaseReadDto,
        observation: ALOrderingObservation
    ): void {
        const cursor = toALInboundResyncCursor({ msg, observation, carrier: toALDeliveryCarrier(read.source) });
        if (cursor !== undefined) {
            this.dependencies.onResyncRequired?.({ msg, cursor });
        }
    }

    /**
     * A completion runs after the application was handed the message, so a write that lost reads and decides again
     * rather than send the work back to be dispatched again.
     *
     * Hands the work back (`retry`) when every attempt's write lost or the shutdown signal aborted it; after a dispatch,
     * the application is then handed the message again. It also hands the work back when the predecessor has not
     * completed, which no dispatch can precede: only a dropped plan or a disabled local delivery, which hand the
     * application nothing, reach that answer. An attempt ends in a `NonRetryableException` when the slot holds another
     * message, when the progress row is gone, or when the slot is gone and the position has not moved past the message.
     */
    async complete(msg: ALMessage): Promise<'completed' | 'retry'> {
        const trackKey = toALOrderingTrackKey(msg);
        const seq = msg.ordering?.seq;
        if (trackKey === undefined || seq === undefined) {
            return 'completed';
        }
        const completed = await retryALInboundLostWrite({
            attempt: () => this.completeOnce(msg, trackKey, seq),
            isLostWrite: (attempt) => attempt === 'conflict'
        });
        return completed === 'conflict' ? 'retry' : completed;
    }

    /** One fresh read of the slot and the progress, its decision, and its write. */
    private async completeOnce(msg: ALMessage, trackKey: string, seq: number): Promise<ALInboundCompletionAttempt> {
        const read = await this.dependencies.admissionStore.readBufferedRelease({
            trackKey,
            seq,
            nowMs: this.dependencies.clock.nowMs()
        });
        if (!read) {
            return await this.confirmCompletion(trackKey, seq);
        }
        if (read.snapshot.msg.id.msgId !== msg.id.msgId || read.snapshot.msg.id.senderId !== msg.id.senderId) {
            throw new NonRetryableException('Inbound delivery no longer owns its buffered message');
        }
        const progress = read.observations.deliveryProgress?.value;
        if (progress === undefined) {
            throw new NonRetryableException('Inbound ordered delivery lost its retained progress');
        }
        if (seq <= progress.completedThrough) {
            return 'completed';
        }
        const completes = computeALInboundDeliveryCompletion({
            completedThrough: progress.completedThrough,
            seq,
            observation: read.snapshot.plan.orderingRuntime,
            completesThrough: read.snapshot.completesThrough
        });
        if (completes === undefined || this.dependencies.signal.aborted) {
            return 'retry';
        }
        const status = await this.dependencies.admissionStore.commitDeliveryCompletion({
            trackKey,
            seq,
            observedSlot: read.snapshot,
            observedProgress: progress
        });
        return status === 'conflict' ? 'conflict' : 'completed';
    }

    private async confirmCompletion(trackKey: string, seq: number): Promise<'completed'> {
        const progress = await this.dependencies.admissionStore.readOrderedDelivery(trackKey, seq);
        if (seq <= progress.completedThrough) {
            return 'completed';
        }
        throw new NonRetryableException('Inbound buffered message is missing without durable completion evidence');
    }
}

/** The NACK the rejection commits, so the sender learns the receiver can no longer order this track. */
function toResyncRequiredNackEffect(
    msg: ALMessage,
    read: ALInboundBufferedReleaseReadDto,
    ordering: ALOrderingObservation
): ALInboundEffectIntent {
    return {
        effectId: `resync:${encodeURIComponent(msg.id.senderId)}:${encodeURIComponent(msg.id.msgId)}`,
        expireAtTimestamp: read.nowMs + read.retention.durableEffectTtlMs,
        carrier: toALDeliveryCarrier(read.source),
        payload: {
            kind: 'send-nack',
            toPeerId: read.source.kind === 'trusted-server' ? msg.id.senderId : read.source.peerId,
            msgId: msg.id.msgId,
            reason: 'resync-required',
            ordering,
            gapRequestNumber: undefined
        }
    };
}
