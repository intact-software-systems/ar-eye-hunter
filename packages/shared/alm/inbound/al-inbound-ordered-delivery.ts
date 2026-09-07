import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    decodePersistedALMessage,
    type ALMessageRejection
} from '../../al-contracts/al-message-persistence-validation.ts';
import { resolveALMessageExpireAtMs } from '../../al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '../../al-contracts/al-runtime.ts';
import { NonRetryableException } from '../../queuebox/DequeueResourceEntryController.ts';
import { isKeysEqual } from '../../queuebox/ResourceEntry.ts';
import { jsonEquals } from '../../repository/state-utils.ts';
import { Either } from '../../resilience/Either.ts';
import {
    decodeALAdmissionResourceEntry,
    encodeALAdmissionResourceEntry
} from '../al-admission-resource-entry-validation.ts';
import { shouldRetryALInboundDelivery } from './al-inbound-effect-intent.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';
import {
    computeALInboundBufferedReleasePlanningObservations,
    computeALInboundPredecessorReadiness
} from './al-inbound-planner-snapshot.ts';
import { computeALInboundBufferedRelease, type ALInboundBufferedRelease } from './compute-al-inbound-admission.ts';
import { prepareALInboundCommitBundle, readALInboundEffectFacts } from './prepare-al-inbound-commit-bundle.ts';
import { validateALInboundCommitBundle } from './validate-al-inbound-commit-bundle.ts';

export namespace ALInboundOrderedDelivery {
    export type Readiness =
        | { readonly kind: 'ready' | 'waiting' | 'completed'; }
        | { readonly kind: 'resync-required'; readonly completedThrough: number; };

    export interface Dependencies
        extends
            Pick<
                ALInboundMessageRuntime.Dependencies,
                'admissionStore' | 'planIncomingMessage' | 'clock' | 'effectPreparation'
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
        const { trackKey, seq, effectId } = input;
        const read = await this.dependencies.admissionStore.readBufferedRelease({
            trackKey,
            seq,
            nowMs: this.dependencies.clock.nowMs()
        });
        if (!read) {
            return await this.confirmCompletion(trackKey, seq);
        }
        if (read.snapshot.delivery?.effectId !== effectId) {
            throw new NonRetryableException('Inbound work no longer owns its buffered message');
        }
        const plan = this.dependencies.planIncomingMessage(
            read.snapshot.msg,
            read.source,
            computeALInboundBufferedReleasePlanningObservations(read)
        );
        const expiresAtMs = resolveALMessageExpireAtMs(read.snapshot.msg, plan.effective);
        if (expiresAtMs !== undefined && expiresAtMs <= this.dependencies.clock.nowMs()) {
            throw new NonRetryableException('Inbound buffered message expired before delivery');
        }
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
        const facts = readALInboundEffectFacts(read.snapshot.msg, read.nowMs, this.dependencies.effectPreparation);
        const computed = computeALInboundBufferedRelease({ read, plan, facts });
        const validated = validateALInboundBufferedRelease(computed, read.namespace);
        if (validated.left) {
            throw new NonRetryableException(validated.left.message);
        }
        if (this.dependencies.signal.aborted) {
            return 'retry';
        }
        const status = await this.dependencies.admissionStore.commitBundle(validated.right!);
        if (status === 'conflict' || this.dependencies.signal.aborted) {
            return 'retry';
        }
        const delivery = validated.right!.localDelivery;
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
        const facts = readALInboundEffectFacts(msg, read.nowMs, this.dependencies.effectPreparation);
        const computed = prepareALInboundCommitBundle({
            read,
            facts,
            mutations: [],
            effects: [{
                effectId: `resync:${encodeURIComponent(msg.id.senderId)}:${encodeURIComponent(msg.id.msgId)}`,
                expireAtTimestamp: read.nowMs + read.retention.durableEffectTtlMs,
                payload: {
                    kind: 'send-nack',
                    toPeerId: read.source.kind === 'trusted-server' ? msg.id.senderId : read.source.peerId,
                    msgId: msg.id.msgId,
                    reason: 'resync-required',
                    ordering: { status: 'resync-required', trackKey, seq, missingSeqs: [], releasableSeqs: [] }
                }
            }]
        });
        const validated = validateALInboundCommitBundle(computed, read.namespace);
        if (validated.left) {
            throw new NonRetryableException(validated.left.message);
        }
        if (
            this.dependencies.signal.aborted ||
            await this.dependencies.admissionStore.commitBundle(validated.right!) === 'conflict'
        ) {
            return 'retry';
        }
        throw new NonRetryableException('Inbound ordered delivery requires resynchronization');
    }

    async complete(msg: ALMessage): Promise<'completed' | 'retry'> {
        const trackKey = toALOrderingTrackKey(msg);
        const seq = msg.ordering?.seq;
        if (trackKey === undefined || seq === undefined) {
            return 'completed';
        }
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
        const completedThrough = progress.completedThrough;
        if (seq <= completedThrough) {
            return 'completed';
        }
        if (seq !== completedThrough + 1 || this.dependencies.signal.aborted) {
            return 'retry';
        }
        const status = await this.dependencies.admissionStore.commitMutations({
            senderId: msg.id.senderId,
            observations: read.observations,
            mutations: [
                {
                    kind: 'set-delivery-progress',
                    trackKey,
                    value: {
                        completedThrough: seq,
                        expireAtTimestamp: progress.expireAtTimestamp
                    }
                },
                { kind: 'delete-buffered', trackKey, seq }
            ]
        });
        return status === 'conflict' ? 'retry' : 'completed';
    }

    private async confirmCompletion(trackKey: string, seq: number): Promise<'completed'> {
        const progress = await this.dependencies.admissionStore.readOrderedDelivery(trackKey, seq);
        if (seq <= progress.completedThrough) {
            return 'completed';
        }
        throw new NonRetryableException('Inbound buffered message is missing without durable completion evidence');
    }
}

function validateALInboundBufferedRelease(
    candidate: ALInboundBufferedRelease,
    namespace: string
): Either<ALMessageRejection, ALInboundBufferedRelease> {
    const bundle = validateALInboundCommitBundle(candidate, namespace);
    if (bundle.left) {
        return Either.ofLeft(bundle.left);
    }
    const delivery = candidate.localDelivery;
    if (delivery !== undefined) {
        try {
            const entry = decodeALAdmissionResourceEntry(encodeALAdmissionResourceEntry(delivery.entry));
            const msg = decodePersistedALMessage(entry.resource);
            const owner = candidate.mutations.find((mutation) => mutation.kind === 'set-msg-owner');
            if (
                !isKeysEqual(entry.key, msg.route) || !jsonEquals(msg, candidate.observations.buffered?.msg) ||
                owner === undefined || owner.expireAtTimestamp < entry.audit.expiryTs.epochMilliseconds
            ) {
                return Either.ofLeft({
                    code: 'malformed',
                    message: 'Buffered delivery differs from its admitted message or retention'
                });
            }
        }
        catch {
            return Either.ofLeft({ code: 'malformed', message: 'Buffered delivery entry is malformed' });
        }
    }
    return Either.ofRight(candidate);
}
