import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type {
    ALInboundAdmissionStore,
    ALPersistedInboundEffect
} from './al-inbound-admission-store.ts';
import type { ALInboundMessageReference } from './al-inbound-canonical-message.ts';
import { shouldRetryALInboundDelivery } from './al-inbound-effect-intent.ts';
import { toALInboundDispatchEntry } from './al-inbound-message-deadline.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';
import { ALInboundOrderedDelivery } from './al-inbound-ordered-delivery.ts';
import {
    computeALInboundBufferedReleasePlanningObservations,
    computeALInboundStoredPlanningObservations
} from './al-inbound-planner-snapshot.ts';

export namespace ALInboundAdmittedDelivery {
    export interface Dependencies extends
        Pick<
            ALInboundMessageRuntime.Dependencies,
            | 'admissionStore'
            | 'planIncomingMessage'
            | 'dispatchInboxEntry'
            | 'canDispatchMessage'
            | 'sendControlMessage'
            | 'forwardMessage'
            | 'clock'
            | 'effectPreparation'
        > {}
}

/** The stored surface one eligibility read decided on, so the delivery that follows reads none of it again. */
export interface ALInboundDeliveryObservation {
    readonly msg: ALMessage;
    readonly source: ALInboundMessageRuntime.Source;
    readonly plan: ALMessageHandlingPlan;
}

export interface ALInboundDeliveryReadiness {
    readonly ready: boolean;
    /**
     * What the read observed, for the delivery that follows it. A row the read defers is never
     * delivered and so carries nothing, and neither does one whose eligibility the read settled
     * without a stored surface of its own.
     */
    readonly observed: ALInboundDeliveryObservation | undefined;
}

const NOT_READY: ALInboundDeliveryReadiness = { ready: false, observed: undefined };
const READY_WITHOUT_OBSERVATION: ALInboundDeliveryReadiness = { ready: true, observed: undefined };

export class ALInboundAdmittedDelivery {
    private readonly dependencies: ALInboundAdmittedDelivery.Dependencies;
    private readonly admissionStore: ALInboundAdmissionStore;
    private readonly shutdown = new AbortController();
    private readonly orderedDelivery: ALInboundOrderedDelivery;

    constructor(dependencies: ALInboundAdmittedDelivery.Dependencies) {
        this.dependencies = dependencies;
        this.admissionStore = dependencies.admissionStore;
        this.orderedDelivery = new ALInboundOrderedDelivery({
            admissionStore: dependencies.admissionStore,
            planIncomingMessage: dependencies.planIncomingMessage,
            clock: dependencies.clock,
            effectPreparation: dependencies.effectPreparation,
            signal: this.shutdown.signal
        });
    }

    dispose(): void {
        this.shutdown.abort();
    }

    async readReadiness(effect: ALPersistedInboundEffect, nowMs: number): Promise<ALInboundDeliveryReadiness> {
        if (this.shutdown.signal.aborted) {
            return NOT_READY;
        }
        const payload = effect.payload;
        if (payload.kind === 'send-control' || payload.kind === 'admit-message' || payload.kind === 'admit-control') {
            return READY_WITHOUT_OBSERVATION;
        }
        if (payload.kind === 'release-buffered') {
            return await this.readBufferedReleaseReadiness(payload.trackKey, payload.seq, nowMs);
        }
        const observed = await this.readStoredDeliveryObservation(payload.message, nowMs);
        if (shouldRetryALInboundDelivery(observed.plan)) {
            return NOT_READY;
        }
        if (payload.kind === 'forward-message' || await this.isLocalDeliveryReady(observed.msg, observed.plan)) {
            return { ready: true, observed };
        }
        return NOT_READY;
    }

    /** A release reads its own buffered surface at delivery, so its eligibility carries nothing forward. */
    private async readBufferedReleaseReadiness(
        trackKey: string,
        seq: number,
        nowMs: number
    ): Promise<ALInboundDeliveryReadiness> {
        const read = await this.admissionStore.readBufferedRelease({ trackKey, seq, nowMs });
        if (read === undefined) {
            return READY_WITHOUT_OBSERVATION;
        }
        const plan = this.dependencies.planIncomingMessage(
            read.snapshot.msg,
            read.source,
            computeALInboundBufferedReleasePlanningObservations(read)
        );
        const ready = !shouldRetryALInboundDelivery(plan) && await this.isLocalDeliveryReady(read.snapshot.msg, plan);
        return ready ? READY_WITHOUT_OBSERVATION : NOT_READY;
    }

    /** The surface a dispatch or a forward decides on: the retained message and its stored planning state. */
    private async readStoredDeliveryObservation(
        reference: ALInboundMessageReference,
        nowMs: number
    ): Promise<ALInboundDeliveryObservation> {
        const msg = await this.readAdmittedMessage(reference);
        const read = await this.admissionStore.readStoredPlanningState({ msg, nowMs });
        return {
            msg,
            source: read.source,
            plan: this.dependencies.planIncomingMessage(
                msg,
                read.source,
                computeALInboundStoredPlanningObservations(read)
            )
        };
    }

    private async isLocalDeliveryReady(msg: ALMessage, plan: ALMessageHandlingPlan): Promise<boolean> {
        const readiness = await this.orderedDelivery.readiness(msg);
        if (readiness.kind === 'waiting') {
            return false;
        }
        return readiness.kind !== 'ready' || plan.dropReason !== undefined || !plan.localDelivery.enabled ||
            (this.dependencies.canDispatchMessage?.(msg) ?? true);
    }

    /**
     * `observed` is the eligibility read's own surface for this row, so a claim that carries one
     * re-reads nothing: only the entry's expiry and the plan's retry intent can have moved inside
     * the claim window, and both are re-decided below against a fresh clock reading.
     */
    async deliver(
        effect: ALPersistedInboundEffect,
        observed: ALInboundDeliveryObservation | undefined
    ): Promise<'completed' | 'retry'> {
        const nowMs = this.dependencies.clock.nowMs();
        if (effect.expireAtTimestamp <= nowMs) {
            throw new NonRetryableException('Inbound work expired before delivery');
        }

        switch (effect.payload.kind) {
            case 'admit-message':
                throw new NonRetryableException('Pending admission must run before admitted delivery');
            case 'admit-control':
                throw new NonRetryableException('Pending control admission must run before admitted delivery');
            case 'dispatch-local':
                return await this.dispatchAdmittedMessage(
                    observed ?? await this.readStoredDeliveryObservation(effect.payload.message, nowMs),
                    effect.expireAtTimestamp
                );
            case 'send-control':
                await this.dependencies.sendControlMessage(effect.payload.msg);
                return 'completed';
            case 'forward-message':
                return await this.forwardAdmittedMessage(
                    observed ?? await this.readStoredDeliveryObservation(effect.payload.message, nowMs),
                    effect.payload.fromPeerId,
                    effect.expireAtTimestamp
                );
            case 'release-buffered':
                return await this.releaseBufferedMessage(
                    { trackKey: effect.payload.trackKey, seq: effect.payload.seq, effectId: effect.effectId },
                    effect.expireAtTimestamp
                );
        }
    }

    /** A release commits its own ordering progress first; the message it frees reaches the page after. */
    private async releaseBufferedMessage(
        input: ALInboundOrderedDelivery.ReleaseInput,
        expireAtTimestamp: number
    ): Promise<'completed' | 'retry'> {
        const release = await this.orderedDelivery.release(input);
        if (typeof release === 'string') {
            return release;
        }
        if (this.shutdown.signal.aborted) {
            return 'retry';
        }
        return await this.dispatchAdmittedMessage(
            await this.readStoredDeliveryObservation(release.message, this.dependencies.clock.nowMs()),
            expireAtTimestamp
        );
    }

    /** Delivery reads the one retained copy; a missing owner row is storage corruption, not a retry. */
    private async readAdmittedMessage(reference: ALInboundMessageReference): Promise<ALMessage> {
        const msg = await this.admissionStore.readInboundMessage(reference);
        if (msg === undefined) {
            throw new ALAdmissionCorruptionError(
                JSON.stringify(reference),
                new TypeError('Inbound message owner row is missing')
            );
        }
        return msg;
    }

    private async dispatchAdmittedMessage(
        observed: ALInboundDeliveryObservation,
        expireAtTimestamp: number
    ): Promise<'completed' | 'retry'> {
        const { msg, plan, source } = observed;
        if (this.shutdown.signal.aborted || shouldRetryALInboundDelivery(plan)) {
            return 'retry';
        }
        const entry = toALInboundDispatchEntry(
            this.dependencies.effectPreparation.createInboxEntry(msg),
            msg,
            expireAtTimestamp
        );
        if (entry.audit.expiryTs.epochMilliseconds <= this.dependencies.clock.nowMs()) {
            throw new NonRetryableException('Inbound message expired before delivery');
        }
        if (plan.dropReason || !plan.localDelivery.enabled) {
            return await this.orderedDelivery.complete(msg);
        }

        const ordered = await this.readOrderedDispatchOutcome(msg);
        if (ordered !== 'dispatch') {
            return ordered;
        }
        if (this.shutdown.signal.aborted || this.dependencies.canDispatchMessage?.(msg) === false) {
            return 'retry';
        }
        if (entry.audit.expiryTs.epochMilliseconds <= this.dependencies.clock.nowMs()) {
            throw new NonRetryableException('Inbound message expired before delivery');
        }
        const dispatched = await this.dependencies.dispatchInboxEntry(entry, plan, source);
        if (dispatched === 'retry') {
            return 'retry';
        }
        return await this.orderedDelivery.complete(msg);
    }

    /**
     * The one decision an eligibility read cannot hand forward: a predecessor can land between that
     * read and the claim, so an ordered message asks the track again at the moment it would dispatch.
     */
    private async readOrderedDispatchOutcome(msg: ALMessage): Promise<'completed' | 'retry' | 'dispatch'> {
        const readiness = await this.orderedDelivery.readiness(msg);
        if (readiness.kind === 'waiting') {
            return 'retry';
        }
        if (readiness.kind === 'completed') {
            return 'completed';
        }
        return readiness.kind === 'resync-required'
            ? await this.orderedDelivery.reject(msg, readiness.completedThrough)
            : 'dispatch';
    }

    private async forwardAdmittedMessage(
        observed: ALInboundDeliveryObservation,
        fromPeerId: string,
        expireAtTimestamp: number
    ): Promise<'completed' | 'retry'> {
        const { msg, plan } = observed;
        if (this.shutdown.signal.aborted || shouldRetryALInboundDelivery(plan)) {
            return 'retry';
        }
        if (expireAtTimestamp <= this.dependencies.clock.nowMs()) {
            throw new NonRetryableException('Inbound message expired before forwarding');
        }
        if (!plan.dropReason && plan.forwarding.enabled) {
            const forwarded = await this.dependencies.forwardMessage?.(msg, fromPeerId, plan);
            if (forwarded === 'retry') {
                return 'retry';
            }
        }
        return 'completed';
    }
}
