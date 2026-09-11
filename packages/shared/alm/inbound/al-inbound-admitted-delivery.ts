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

    async readReadiness(effect: ALPersistedInboundEffect, nowMs: number): Promise<boolean> {
        if (this.shutdown.signal.aborted) {
            return false;
        }
        const payload = effect.payload;
        if (payload.kind === 'send-control' || payload.kind === 'admit-message' || payload.kind === 'admit-control') {
            return true;
        }
        if (payload.kind === 'release-buffered') {
            const read = await this.admissionStore.readBufferedRelease({
                trackKey: payload.trackKey,
                seq: payload.seq,
                nowMs
            });
            if (read === undefined) {
                return true;
            }
            const plan = this.dependencies.planIncomingMessage(
                read.snapshot.msg,
                read.source,
                computeALInboundBufferedReleasePlanningObservations(read)
            );
            return !shouldRetryALInboundDelivery(plan) && await this.isLocalDeliveryReady(read.snapshot.msg, plan);
        }
        const msg = await this.readAdmittedMessage(payload.message);
        const read = await this.admissionStore.readStoredPlanningState({ msg, nowMs });
        const plan = this.dependencies.planIncomingMessage(
            msg,
            read.source,
            computeALInboundStoredPlanningObservations(read)
        );
        return !shouldRetryALInboundDelivery(plan) &&
            (payload.kind === 'forward-message' || await this.isLocalDeliveryReady(msg, plan));
    }

    private async isLocalDeliveryReady(msg: ALMessage, plan: ALMessageHandlingPlan): Promise<boolean> {
        const readiness = await this.orderedDelivery.readiness(msg);
        if (readiness.kind === 'waiting') {
            return false;
        }
        return readiness.kind !== 'ready' || plan.dropReason !== undefined || !plan.localDelivery.enabled ||
            (this.dependencies.canDispatchMessage?.(msg) ?? true);
    }

    async deliver(
        effect: ALPersistedInboundEffect
    ): Promise<'completed' | 'retry'> {
        if (effect.expireAtTimestamp <= this.dependencies.clock.nowMs()) {
            throw new NonRetryableException('Inbound work expired before delivery');
        }

        switch (effect.payload.kind) {
            case 'admit-message':
                throw new NonRetryableException('Pending admission must run before admitted delivery');
            case 'admit-control':
                throw new NonRetryableException('Pending control admission must run before admitted delivery');
            case 'dispatch-local':
                return await this.dispatchAdmittedMessage(effect.payload.message, effect.expireAtTimestamp);
            case 'send-control':
                await this.dependencies.sendControlMessage(effect.payload.msg);
                return 'completed';
            case 'forward-message':
                return await this.forwardAdmittedMessage(
                    await this.readAdmittedMessage(effect.payload.message),
                    effect.payload.fromPeerId,
                    effect.expireAtTimestamp
                );
            case 'release-buffered': {
                const release = await this.orderedDelivery.release({
                    trackKey: effect.payload.trackKey,
                    seq: effect.payload.seq,
                    effectId: effect.effectId
                });
                if (typeof release === 'string') {
                    return release;
                }
                if (this.shutdown.signal.aborted) {
                    return 'retry';
                }
                return await this.dispatchAdmittedMessage(release.message, effect.expireAtTimestamp);
            }
        }
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
        reference: ALInboundMessageReference,
        expireAtTimestamp: number
    ): Promise<'completed' | 'retry'> {
        if (this.shutdown.signal.aborted) {
            return 'retry';
        }
        const msg = await this.readAdmittedMessage(reference);
        const entry = toALInboundDispatchEntry(
            this.dependencies.effectPreparation.createInboxEntry(msg),
            msg,
            expireAtTimestamp
        );
        const read = await this.admissionStore.readStoredPlanningState({ msg, nowMs: this.dependencies.clock.nowMs() });
        const source = read.source;
        const plan = this.dependencies.planIncomingMessage(
            msg,
            source,
            computeALInboundStoredPlanningObservations(read)
        );

        if (this.shutdown.signal.aborted || shouldRetryALInboundDelivery(plan)) {
            return 'retry';
        }

        if (entry.audit.expiryTs.epochMilliseconds <= this.dependencies.clock.nowMs()) {
            throw new NonRetryableException('Inbound message expired before delivery');
        }
        if (plan.dropReason || !plan.localDelivery.enabled) {
            return await this.orderedDelivery.complete(msg);
        }

        const readiness = await this.orderedDelivery.readiness(msg);
        if (readiness.kind === 'waiting') {
            return 'retry';
        }
        if (readiness.kind === 'completed') {
            return 'completed';
        }
        if (readiness.kind === 'resync-required') {
            return await this.orderedDelivery.reject(msg, readiness.completedThrough);
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

    private async forwardAdmittedMessage(
        msg: ALMessage,
        fromPeerId: string,
        expireAtTimestamp: number
    ): Promise<'completed' | 'retry'> {
        const read = await this.admissionStore.readStoredPlanningState({ msg, nowMs: this.dependencies.clock.nowMs() });
        const plan = this.dependencies.planIncomingMessage(
            msg,
            read.source,
            computeALInboundStoredPlanningObservations(read)
        );
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
