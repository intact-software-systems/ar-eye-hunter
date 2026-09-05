import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '../../al-contracts/al-runtime.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { NOT_COMPLETED_RETRYABLE_STATUSES } from '../../queuebox/ResourceEntry.ts';
import type { ALInboundAdmissionStore, ALPersistedInboundEffect } from './al-inbound-admission-store.ts';
import { shouldDeferALInboundLocalDelivery } from './al-inbound-effect-intent.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';
import {
    computeALInboundBufferedReleasePlanningObservations,
    computeALInboundStoredPlanningObservations
} from './al-inbound-planner-snapshot.ts';
import { computeALInboundBufferedRelease } from './compute-al-inbound-admission.ts';
import { readALInboundEffectFacts } from './prepare-al-inbound-commit-bundle.ts';
import { validateALInboundCommitBundle } from './validate-al-inbound-commit-bundle.ts';

export namespace ALInboundAdmittedDelivery {
    export interface Dependencies extends
        Pick<
            ALInboundMessageRuntime.Dependencies,
            | 'admissionStore'
            | 'inbox'
            | 'planIncomingMessage'
            | 'readStoredEntry'
            | 'dispatchInboxEntry'
            | 'sendControlMessage'
            | 'forwardMessage'
            | 'clock'
            | 'effectPreparation'
        > {}
}

export class ALInboundAdmittedDelivery {
    private readonly dependencies: ALInboundAdmittedDelivery.Dependencies;
    private readonly admissionStore: ALInboundAdmissionStore;
    private disposed = false;

    constructor(dependencies: ALInboundAdmittedDelivery.Dependencies) {
        this.dependencies = dependencies;
        this.admissionStore = dependencies.admissionStore;
    }

    dispose(): void {
        this.disposed = true;
    }

    async deliver(
        effect: ALPersistedInboundEffect
    ): Promise<'completed' | 'retry'> {
        if (effect.expireAtTimestamp <= this.dependencies.clock.nowMs()) {
            if (effect.payload.kind === 'dispatch-local' || effect.payload.kind === 'enqueue-inbox') {
                return await this.completeOrderedDelivery(this.dependencies.readStoredEntry(effect.payload.entry));
            }
            return 'completed';
        }

        switch (effect.payload.kind) {
            case 'dispatch-local':
                return await this.dispatchAdmittedEntry(effect.payload.entry);
            case 'enqueue-inbox':
                await this.dependencies.inbox.enqueueIfAbsent(effect.payload.entry);
                return 'completed';
            case 'send-control':
                await this.dependencies.sendControlMessage(effect.payload.msg);
                return 'completed';
            case 'forward-message':
                return await this.forwardAdmittedMessage(effect.payload.msg, effect.payload.fromPeerId);
            case 'release-buffered':
                return await this.commitBufferedRelease(
                    effect.payload.trackKey,
                    effect.payload.seq
                );
        }
    }

    async dispatchAdmittedEntry(entry: ResourceEntry): Promise<'completed' | 'retry'> {
        if (this.disposed) {
            return 'retry';
        }
        const msg = this.dependencies.readStoredEntry(entry);
        const read = await this.admissionStore.readStoredPlanningState({ msg, nowMs: this.dependencies.clock.nowMs() });
        const source = read.source;
        const plan = this.dependencies.planIncomingMessage(
            msg,
            source,
            computeALInboundStoredPlanningObservations(read)
        );

        if (this.disposed || ALInboundAdmittedDelivery.shouldRetryAdmittedDelivery(plan)) {
            return 'retry';
        }

        if (plan.dropReason || !plan.localDelivery.enabled) {
            return await this.completeOrderedDelivery(msg);
        }

        if (await this.hasUndeliveredPredecessor(msg)) {
            return 'retry';
        }
        if (this.disposed) {
            return 'retry';
        }
        const dispatched = await this.dependencies.dispatchInboxEntry(entry, plan, source);
        if (dispatched === 'retry') {
            return 'retry';
        }
        return await this.completeOrderedDelivery(msg);
    }

    private async commitBufferedRelease(trackKey: string, seq: number): Promise<'completed' | 'retry'> {
        const read = await this.admissionStore.readBufferedRelease({
            trackKey,
            seq,
            nowMs: this.dependencies.clock.nowMs()
        });
        if (!read) {
            return 'completed';
        }
        const plan = this.dependencies.planIncomingMessage(
            read.snapshot.msg,
            read.source,
            computeALInboundBufferedReleasePlanningObservations(read)
        );
        if (
            ALInboundAdmittedDelivery.shouldRetryAdmittedDelivery(plan) ||
            (!plan.dropReason && await this.hasUndeliveredPredecessor(read.snapshot.msg))
        ) {
            return 'retry';
        }
        const facts = readALInboundEffectFacts(read.snapshot.msg, read.nowMs, this.dependencies.effectPreparation);
        const computed = computeALInboundBufferedRelease({ read, plan, facts });
        const validated = validateALInboundCommitBundle(computed);
        if (validated.left) {
            return 'completed';
        }
        if (this.disposed) {
            return 'retry';
        }
        const status = await this.admissionStore.commitBundle(validated.right!);
        return status === 'conflict' ? 'retry' : 'completed';
    }

    private async hasUndeliveredPredecessor(msg: ALMessage): Promise<boolean> {
        const seq = msg.ordering?.seq;
        const trackKey = toALOrderingTrackKey(msg);
        if (seq === undefined || trackKey === undefined) {
            return false;
        }
        const predecessors = await this.admissionStore.readDeliveryPredecessors(trackKey, seq);
        for (const predecessor of predecessors) {
            if (predecessor.kind === 'effect') {
                return true;
            }
            const entry = await this.dependencies.inbox.getItem(predecessor.key);
            if (
                entry && NOT_COMPLETED_RETRYABLE_STATUSES.has(entry.status) &&
                entry.audit.expiryTs.epochMilliseconds > this.dependencies.clock.nowMs()
            ) {
                const queued = this.dependencies.readStoredEntry(entry);
                if (
                    queued.id.msgId === predecessor.msg.id.msgId && queued.id.senderId === predecessor.msg.id.senderId
                ) {
                    return true;
                }
            }
            if (await this.completeOrderedDelivery(predecessor.msg) === 'retry') {
                return true;
            }
        }
        return false;
    }

    private async completeOrderedDelivery(msg: ALMessage): Promise<'completed' | 'retry'> {
        const trackKey = toALOrderingTrackKey(msg);
        const seq = msg.ordering?.seq;
        if (trackKey === undefined || seq === undefined) {
            return 'completed';
        }
        const read = await this.admissionStore.readBufferedRelease({
            trackKey,
            seq,
            nowMs: this.dependencies.clock.nowMs()
        });
        if (!read || read.snapshot.msg.id.msgId !== msg.id.msgId) {
            return 'completed';
        }
        const status = await this.admissionStore.commitMutations({
            senderId: msg.id.senderId,
            expectedVersion: read.clientRecord?.version,
            versionExpireAtTimestamp: read.nowMs + read.retention.versionTtlMs,
            mutations: [{ kind: 'delete-buffered', trackKey, seq }]
        });
        return status === 'conflict' ? 'retry' : 'completed';
    }

    private async forwardAdmittedMessage(msg: ALMessage, fromPeerId: string): Promise<'completed' | 'retry'> {
        const read = await this.admissionStore.readStoredPlanningState({ msg, nowMs: this.dependencies.clock.nowMs() });
        const plan = this.dependencies.planIncomingMessage(
            msg,
            read.source,
            computeALInboundStoredPlanningObservations(read)
        );
        if (this.disposed || ALInboundAdmittedDelivery.shouldRetryAdmittedDelivery(plan)) {
            return 'retry';
        }
        if (!plan.dropReason && plan.forwarding.enabled) {
            const forwarded = await this.dependencies.forwardMessage?.(msg, fromPeerId, plan);
            if (forwarded === 'retry') {
                return 'retry';
            }
        }
        return 'completed';
    }

    private static shouldRetryAdmittedDelivery(plan: ALMessageHandlingPlan): boolean {
        return plan.dropReason === 'not-yet-in-sync' ||
            (Boolean(plan.dropReason) && plan.nack.reason === 'overloaded') ||
            (!plan.dropReason && shouldDeferALInboundLocalDelivery(plan));
    }
}
