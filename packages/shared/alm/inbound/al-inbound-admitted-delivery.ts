import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import { NonRetryableException } from '../../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import type { ALStoreDurability } from '../al-runtime-stores.ts';
import type { ALInboundAdmissionStore } from './al-inbound-admission-store.ts';
import type { ALInboundMessageReference } from './al-inbound-canonical-message.ts';
import { shouldRetryALInboundDelivery } from './al-inbound-effect-intent.ts';
import { toALInboundDispatchEntry } from './al-inbound-message-deadline.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';
import { ALInboundOrderedDelivery } from './al-inbound-ordered-delivery.ts';
import {
    computeALInboundBufferedReleasePlanningObservations,
    computeALInboundStoredPlanningObservations
} from './al-inbound-planner-snapshot.ts';
import {
    recordALInboundDiagnostic,
    toALInboundClaimIdentity,
    type ALInboundDispatchDisposition
} from './al-inbound-runtime-diagnostics.ts';
import { isAuthorizedStoredWsClientDelivery } from './al-inbound-source-validation.ts';
import type { ALPersistedInboundEffect } from './al-inbound-work-entry.ts';

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

/** One forward row as it runs: the forward its admission wrote, or a retried copy owed to `retryPeerIds` only. */
interface ALInboundAdmittedForward {
    readonly observed: ALInboundDeliveryObservation;
    readonly fromPeerId: string;
    readonly retryPeerIds: readonly string[] | undefined;
    readonly attemptIdentity: string;
    readonly expireAtTimestamp: number;
}

const NOT_READY: ALInboundDeliveryReadiness = { ready: false, observed: undefined };
const READY_WITHOUT_OBSERVATION: ALInboundDeliveryReadiness = { ready: true, observed: undefined };

export namespace ALInboundAdmittedDelivery {
    export interface Dependencies extends
        Pick<
            ALInboundMessageRuntime.Dependencies,
            | 'admissionStore'
            | 'planIncomingMessage'
            | 'dispatchInboxEntry'
            | 'canDispatchMessage'
            | 'forwardMessage'
            | 'forwardRetriedCopy'
            | 'clock'
            | 'effectPreparation'
            | 'diagnostics'
            | 'effectWorkerId'
        > {
        readonly lane: ALStoreDurability;
    }
}

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
        switch (payload.kind) {
            case 'send-control':
            case 'admit-message':
            case 'admit-control':
                return READY_WITHOUT_OBSERVATION;
            case 'release-buffered':
                return await this.readBufferedReleaseReadiness(payload.trackKey, payload.seq, nowMs);
        }
        const observed = await this.readStoredDeliveryObservation(
            payload.message,
            nowMs,
            toRetriedForwardingPeerId(effect)
        );
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
        if (!isAuthorizedStoredWsClientDelivery(read.snapshot.msg, read.source)) {
            return READY_WITHOUT_OBSERVATION;
        }
        const plan = this.dependencies.planIncomingMessage(
            read.snapshot.msg,
            read.source,
            computeALInboundBufferedReleasePlanningObservations(read)
        );
        return {
            ready: !shouldRetryALInboundDelivery(plan) && await this.isLocalDeliveryReady(read.snapshot.msg, plan),
            observed: undefined
        };
    }

    /**
     * The surface a dispatch or a forward decides on: the one retained message and the stored
     * planning state it is planned against, from one read session. A missing retained copy is
     * storage corruption, not a retry. A retried copy is planned against the peer that sent it,
     * which a re-parented relay row names in place of the first arrival (R-S2c-ii-12).
     */
    private async readStoredDeliveryObservation(
        reference: ALInboundMessageReference,
        nowMs: number,
        retriedFromPeerId: string | undefined
    ): Promise<ALInboundDeliveryObservation> {
        const read = await this.admissionStore.readDeliverySurface(reference, nowMs);
        if (read === undefined) {
            throw new ALAdmissionCorruptionError(
                JSON.stringify(reference),
                new TypeError('Inbound message owner row is missing')
            );
        }
        if (!isAuthorizedStoredWsClientDelivery(read.msg, read.source)) {
            throw new NonRetryableException('Stored WS client scope does not authorize delivery');
        }
        const source = retriedFromPeerId === undefined || read.source.kind === 'trusted-server'
            ? read.source
            : { ...read.source, peerId: retriedFromPeerId };
        return {
            msg: read.msg,
            source,
            plan: this.dependencies.planIncomingMessage(
                read.msg,
                source,
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
            this.dependencies.canDispatchMessage?.(msg) !== false;
    }

    /**
     * `observed` is the eligibility read's own surface for this row. What that read decided stands as
     * of the page it was taken from; only the two things that must be decided later than it are
     * decided again -- every expiry, against a fresh clock reading, and an ordered message's
     * predecessor, which can land after the page was read. A claim carrying no observation reads the
     * surface for itself, and the plan's retry intent is gated below for it, where the eligibility
     * read would have gated a carried one.
     */
    async deliver(
        effect: ALPersistedInboundEffect,
        observed: ALInboundDeliveryObservation | undefined
    ): Promise<'completed' | 'retry'> {
        if (this.shutdown.signal.aborted) {
            this.recordDispatchDecision(effect, observed, 'shutdown');
            return 'retry';
        }
        const nowMs = this.dependencies.clock.nowMs();
        if (effect.expireAtTimestamp <= nowMs) {
            this.recordDispatchDecision(effect, observed, 'expired');
            throw new NonRetryableException('Inbound work expired before delivery');
        }

        switch (effect.payload.kind) {
            case 'admit-message':
                throw new NonRetryableException('Pending admission must run before admitted delivery');
            case 'admit-control':
                throw new NonRetryableException('Pending control admission must run before admitted delivery');
            case 'dispatch-local':
                return await this.dispatchAdmittedMessage(
                    observed ?? await this.readStoredDeliveryObservation(effect.payload.message, nowMs, undefined),
                    effect
                );
            case 'send-control':
                throw new NonRetryableException(
                    'A control send runs in the control round of its batch, not in delivery'
                );
            case 'forward-message':
                return await this.forwardAdmittedMessage({
                    observed: observed ?? await this.readStoredDeliveryObservation(
                        effect.payload.message,
                        nowMs,
                        toRetriedForwardingPeerId(effect)
                    ),
                    fromPeerId: effect.payload.fromPeerId,
                    retryPeerIds: effect.payload.retryPeerIds,
                    attemptIdentity: effect.effectId,
                    expireAtTimestamp: effect.expireAtTimestamp
                });
            case 'release-buffered':
                return await this.releaseBufferedMessage(
                    { trackKey: effect.payload.trackKey, seq: effect.payload.seq, effectId: effect.effectId },
                    effect
                );
        }
    }

    /** A release commits its own ordering progress first; the message it frees reaches the page after. */
    private async releaseBufferedMessage(
        input: ALInboundOrderedDelivery.ReleaseInput,
        effect: ALPersistedInboundEffect
    ): Promise<'completed' | 'retry'> {
        const release = await this.orderedDelivery.release(input);
        if (typeof release === 'string') {
            return release;
        }
        if (this.shutdown.signal.aborted) {
            return 'retry';
        }
        return await this.dispatchAdmittedMessage(
            await this.readStoredDeliveryObservation(release.message, this.dependencies.clock.nowMs(), undefined),
            effect
        );
    }

    private async dispatchAdmittedMessage(
        observed: ALInboundDeliveryObservation,
        effect: ALPersistedInboundEffect
    ): Promise<'completed' | 'retry'> {
        const { msg, plan, source } = observed;
        if (this.shutdown.signal.aborted) {
            this.recordDispatchDecision(effect, observed, 'shutdown');
            return 'retry';
        }
        if (shouldRetryALInboundDelivery(plan)) {
            this.recordDispatchDecision(effect, observed, 'plan-retry');
            return 'retry';
        }
        const entry = toALInboundDispatchEntry(
            this.dependencies.effectPreparation.createInboxEntry(msg),
            msg,
            effect.expireAtTimestamp
        );
        this.requireDispatchTime(entry.audit.expiryTs.epochMilliseconds, effect, observed);
        if (plan.dropReason) {
            this.recordDispatchDecision(effect, observed, 'plan-dropped');
            return await this.orderedDelivery.complete(msg);
        }
        if (!plan.localDelivery.enabled) {
            this.recordDispatchDecision(effect, observed, 'local-disabled');
            return await this.orderedDelivery.complete(msg);
        }
        const ordered = await this.readOrderedDispatchOutcome(msg);
        if (ordered !== 'dispatch') {
            this.recordDispatchDecision(
                effect,
                observed,
                ordered === 'completed' ? 'ordering-completed' : 'ordering-retry'
            );
            return ordered;
        }
        if (this.shutdown.signal.aborted || this.dependencies.canDispatchMessage?.(msg) === false) {
            this.recordDispatchDecision(
                effect,
                observed,
                this.shutdown.signal.aborted ? 'shutdown' : 'consumer-unavailable'
            );
            return 'retry';
        }
        this.requireDispatchTime(entry.audit.expiryTs.epochMilliseconds, effect, observed);
        let dispatched: void | 'completed' | 'retry';
        try {
            dispatched = await this.dependencies.dispatchInboxEntry(entry, plan, source);
        }
        catch (error) {
            this.recordDispatchDecision(effect, observed, 'port-threw');
            throw error;
        }
        if (dispatched === 'retry') {
            this.recordDispatchDecision(effect, observed, 'port-retry');
            return 'retry';
        }
        this.recordDispatchDecision(effect, observed, 'port-returned');
        return await this.orderedDelivery.complete(msg);
    }

    private requireDispatchTime(
        expiresAtMs: number,
        effect: ALPersistedInboundEffect,
        observed: ALInboundDeliveryObservation
    ): void {
        if (expiresAtMs <= this.dependencies.clock.nowMs()) {
            this.recordDispatchDecision(effect, observed, 'expired');
            throw new NonRetryableException('Inbound message expired before delivery');
        }
    }

    private recordDispatchDecision(
        effect: ALPersistedInboundEffect,
        observed: ALInboundDeliveryObservation | undefined,
        disposition: ALInboundDispatchDisposition
    ): void {
        if (effect.payload.kind !== 'dispatch-local' && effect.payload.kind !== 'release-buffered') {
            return;
        }
        recordALInboundDiagnostic(this.dependencies.diagnostics, {
            kind: 'dispatch-decision',
            lane: this.dependencies.lane,
            workerId: this.dependencies.effectWorkerId,
            effectId: effect.effectId,
            msgId: observed?.msg.id.msgId ??
                toALInboundClaimIdentity(effect.payload).msgId,
            typeId: observed?.msg.payload.typeId ?? null,
            carrier: effect.carrier,
            attempts: effect.attempts,
            atEpochMs: this.dependencies.clock.nowMs(),
            disposition
        });
    }

    /**
     * The one decision an eligibility read cannot hand forward: a predecessor can land between that
     * read and the claim, so an ordered message asks the track again at the moment it would dispatch.
     */
    private async readOrderedDispatchOutcome(msg: ALMessage): Promise<'completed' | 'retry' | 'dispatch'> {
        const readiness = await this.orderedDelivery.readiness(msg);
        switch (readiness.kind) {
            case 'waiting':
                return 'retry';
            case 'completed':
                return 'completed';
            case 'resync-required':
                return await this.orderedDelivery.reject(msg, readiness.completedThrough);
            case 'ready':
                return 'dispatch';
        }
    }

    private async forwardAdmittedMessage(forward: ALInboundAdmittedForward): Promise<'completed' | 'retry'> {
        const { msg, plan } = forward.observed;
        if (this.shutdown.signal.aborted || shouldRetryALInboundDelivery(plan)) {
            return 'retry';
        }
        if (forward.expireAtTimestamp <= this.dependencies.clock.nowMs()) {
            throw new NonRetryableException('Inbound message expired before forwarding');
        }
        if (plan.dropReason || !plan.forwarding.enabled) {
            return 'completed';
        }
        const forwarded = forward.retryPeerIds === undefined
            ? await this.dependencies.forwardMessage?.({
                msg,
                fromPeerId: forward.fromPeerId,
                plan,
                source: forward.observed.source
            })
            : await this.dependencies.forwardRetriedCopy?.({
                msg,
                fromPeerId: forward.fromPeerId,
                toPeerIds: forward.retryPeerIds,
                attemptIdentity: forward.attemptIdentity
            });
        return forwarded === 'retry' ? 'retry' : 'completed';
    }
}

/** Only a retried forward substitutes its current parent for the stored arrival peer. */
function toRetriedForwardingPeerId(effect: ALPersistedInboundEffect): string | undefined {
    const payload = effect.payload;
    return payload.kind === 'forward-message' && payload.retryPeerIds !== undefined ? payload.fromPeerId : undefined;
}
