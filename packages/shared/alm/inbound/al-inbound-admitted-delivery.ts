import type { ALMessage } from '../../al-contracts/al-contract.ts';
import type { ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '../../al-contracts/al-runtime.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { NOT_COMPLETED_RETRYABLE_STATUSES } from '../../queuebox/ResourceEntry.ts';
import {
    RetryableConflictError,
    tryWithPolicy,
    type TryWithPolicy
} from '../../resilience/TryWith.ts';
import type { ALInboundAdmissionStore, ALPersistedInboundEffect } from './al-inbound-admission-store.ts';
import { shouldDeferALInboundLocalDelivery } from './al-inbound-effect-intent.ts';
import type { ALInboundMessageRuntime } from './al-inbound-message-runtime.ts';
import { computeALInboundBufferedRelease } from './compute-al-inbound-admission.ts';
import { prepareALInboundCommitBundle } from './prepare-al-inbound-commit-bundle.ts';

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
        > {
        readonly commitRetryPolicy: TryWithPolicy;
    }
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
                await this.completeOrderedDelivery(effect.payload.msg);
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
                return await this.releaseBufferedMessageWithAdmission(
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
        const plan = await this.admissionStore.planStoredEntry(
            msg,
            this.dependencies.planIncomingMessage
        );

        if (this.disposed || ALInboundAdmittedDelivery.shouldRetryAdmittedDelivery(plan)) {
            return 'retry';
        }

        if (plan.dropReason || !plan.localDelivery.enabled) {
            await this.completeOrderedDelivery(msg);
            return 'completed';
        }

        if (await this.hasUndeliveredPredecessor(msg)) {
            return 'retry';
        }
        if (this.disposed) {
            return 'retry';
        }
        await this.dependencies.dispatchInboxEntry(entry, plan);
        await this.completeOrderedDelivery(msg);
        return 'completed';
    }

    private async releaseBufferedMessageWithAdmission(
        trackKey: string,
        seq: number
    ): Promise<'completed' | 'retry'> {
        try {
            return await tryWithPolicy(
                () => this.commitBufferedRelease(trackKey, seq),
                this.dependencies.commitRetryPolicy
            );
        }
        catch (error) {
            throw new Error(
                `Failed to release buffered inbound message after retries: ${trackKey}:${seq}`,
                { cause: error }
            );
        }
    }

    private async commitBufferedRelease(trackKey: string, seq: number): Promise<'completed' | 'retry'> {
        const read = await this.admissionStore.readBufferedRelease(trackKey, seq);
        if (!read) {
            return 'completed';
        }
        const plan = await this.admissionStore.planStoredEntry(
            read.snapshot.msg,
            this.dependencies.planIncomingMessage
        );
        if (
            ALInboundAdmittedDelivery.shouldRetryAdmittedDelivery(plan) ||
            (!plan.dropReason && await this.hasUndeliveredPredecessor(read.snapshot.msg))
        ) {
            return 'retry';
        }
        const computed = computeALInboundBufferedRelease(read, plan);
        const bundle = prepareALInboundCommitBundle(computed, this.dependencies.effectPreparation);
        const status = await this.admissionStore.commitBundle(bundle);
        if (status === 'conflict') {
            throw new RetryableConflictError('Buffered inbound release commit conflict');
        }
        return 'completed';
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
            await this.completeOrderedDelivery(predecessor.msg);
        }
        return false;
    }

    private async completeOrderedDelivery(msg: ALMessage): Promise<void> {
        const trackKey = toALOrderingTrackKey(msg);
        const seq = msg.ordering?.seq;
        if (trackKey === undefined || seq === undefined) {
            return;
        }
        await tryWithPolicy(async () => {
            const read = await this.admissionStore.readBufferedRelease(trackKey, seq);
            if (!read || read.snapshot.msg.id.msgId !== msg.id.msgId) {
                return;
            }
            const status = await this.admissionStore.commitMutations({
                senderId: msg.id.senderId,
                expectedVersion: read.clientRecord?.version,
                mutations: [{ kind: 'delete-buffered', trackKey, seq }]
            });
            if (status === 'conflict') {
                throw new RetryableConflictError('Ordered delivery completion conflict');
            }
        }, this.dependencies.commitRetryPolicy);
    }

    private async forwardAdmittedMessage(msg: ALMessage, fromPeerId: string): Promise<'completed' | 'retry'> {
        const plan = await this.admissionStore.planStoredEntry(
            msg,
            (message, _senderId, stores) => this.dependencies.planIncomingMessage(message, fromPeerId, stores)
        );
        if (this.disposed || ALInboundAdmittedDelivery.shouldRetryAdmittedDelivery(plan)) {
            return 'retry';
        }
        if (!plan.dropReason && plan.forwarding.enabled) {
            await this.dependencies.forwardMessage?.(msg, fromPeerId, plan);
        }
        return 'completed';
    }

    private static shouldRetryAdmittedDelivery(plan: ALMessageHandlingPlan): boolean {
        return plan.dropReason === 'not-yet-in-sync' ||
            (Boolean(plan.dropReason) && plan.nack.reason === 'overloaded') ||
            (!plan.dropReason && shouldDeferALInboundLocalDelivery(plan));
    }
}
