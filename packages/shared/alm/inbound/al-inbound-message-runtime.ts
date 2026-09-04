import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { isALControlTypeId, type ALControlAcceptance } from '../../al-contracts/al-control.ts';
import type { ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import {
    RetryableConflictError,
    RetryPolicies,
    tryWithPolicy
} from '../../resilience/TryWith.ts';
import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import type {
    ALInboundAdmissionStore,
    ALInboundPlanner
} from './al-inbound-admission-store.ts';
import { ALInboundAdmittedDelivery } from './al-inbound-admitted-delivery.ts';
import { ALInboundDurableEffectWorker } from './al-inbound-durable-effect-worker.ts';
import { computeALInboundAdmission } from './compute-al-inbound-admission.ts';
import { readALInboundComputationFacts } from './read-al-inbound-computation-facts.ts';

export interface ALInboundRuntimeStores {
    readonly admissionStore: ALInboundAdmissionStore;
}

export namespace ALInboundMessageRuntime {
    export interface Clock {
        nowMs(): number;
    }

    export interface Scheduler {
        /** Runs the callback once after the delay; the returned operation cancels it before invocation. */
        schedule(callback: () => void, delayMs: number): () => void;
    }

    export interface Resources {
        readonly admissionStore: ALInboundAdmissionStore;
        readonly selfPeerId: string;
        readonly inboxEntryTypeId: string;
        readonly effectWorkerId: string;
        readonly clock: Clock;
        readonly scheduler: Scheduler;
    }

    export interface Dependencies extends Resources {
        readonly inbox: QueueBoxResourceEntryRepository;
        readonly planIncomingMessage: ALInboundPlanner;
        readonly readStoredEntry: (entry: ResourceEntry) => Readonly<ALMessage>;
        readonly dispatchInboxEntry: (entry: ResourceEntry, plan?: ALMessageHandlingPlan) => Promise<void>;
        readonly sendControlMessage: (msg: ALMessage) => Promise<void>;
        readonly onControlMessage?: (msg: ALMessage, acceptance: ALControlAcceptance) => Promise<void>;
        readonly forwardMessage?: (msg: ALMessage, fromPeerId: string, plan: ALMessageHandlingPlan) => Promise<void>;
        /** Absence means the configured transport can forward every message. */
        readonly canForwardMessage?: (msg: ALMessage) => boolean;
    }
}

export class ALInboundMessageRuntime {
    private static readonly COMMIT_RETRY_POLICY = RetryPolicies.optimisticCommit(
        'al-inbound-commit'
    );

    private readonly admissionStore: ALInboundAdmissionStore;
    private readonly readyPromise: Promise<void>;
    private readonly commitQueuesBySenderId = new Map<string, Promise<void>>();

    private readonly delivery: ALInboundAdmittedDelivery;
    private readonly effects: ALInboundDurableEffectWorker;
    private disposed = false;

    private readonly dependencies: ALInboundMessageRuntime.Dependencies;

    constructor(dependencies: ALInboundMessageRuntime.Dependencies) {
        this.dependencies = dependencies;
        this.admissionStore = dependencies.admissionStore;
        this.readyPromise = this.admissionStore.ready();
        this.delivery = new ALInboundAdmittedDelivery({
            ...dependencies,
            commitRetryPolicy: ALInboundMessageRuntime.COMMIT_RETRY_POLICY
        });
        this.effects = new ALInboundDurableEffectWorker({ ...dependencies, delivery: this.delivery });
    }

    async ready(): Promise<void> {
        await this.readyPromise;

        await this.effects.startOnce();
    }

    dispose(): void {
        this.disposed = true;
        this.effects.dispose();
        this.delivery.dispose();
    }

    async handleIncomingMessage(
        msg: ALMessage,
        fromPeerId: string,
        planIncomingMessage: ALInboundPlanner = this.dependencies.planIncomingMessage
    ): Promise<void> {
        await this.ready();

        if (this.disposed) {
            return;
        }

        if (isALControlTypeId(msg.payload.typeId)) {
            const acceptance = await this.acceptControlMessageWithRetry(msg);
            const waitForEffects = !this.effects.hasActiveDrain();
            const effectDrain = this.effects.start();
            if (waitForEffects) {
                await effectDrain;
            }
            if (!this.disposed) {
                await this.dependencies.onControlMessage?.(msg, acceptance);
            }
            return;
        }

        await this.withSenderCommitQueue(
            msg.id.senderId,
            () => this.admitIncomingMessage(msg, fromPeerId, planIncomingMessage)
        );
    }

    private async acceptControlMessageWithRetry(
        msg: ALMessage
    ): Promise<ALControlAcceptance> {
        return await tryWithPolicy(
            async () => {
                try {
                    return await this.admissionStore.acceptControlMessage(msg);
                }
                catch (error) {
                    if (error instanceof ALAdmissionBackendConflictError) {
                        throw new RetryableConflictError(
                            'Inbound control-message admission conflict',
                            { cause: error }
                        );
                    }
                    throw error;
                }
            },
            ALInboundMessageRuntime.COMMIT_RETRY_POLICY
        );
    }

    private async admitIncomingMessage(
        msg: ALMessage,
        fromPeerId: string,
        planIncomingMessage: ALInboundPlanner
    ): Promise<void> {
        if (this.disposed) {
            return;
        }
        try {
            await tryWithPolicy(
                () => this.commitIncomingMessage(msg, fromPeerId, planIncomingMessage),
                ALInboundMessageRuntime.COMMIT_RETRY_POLICY
            );
        }
        catch (error) {
            if (error instanceof ALAdmissionCorruptionError) {
                throw error;
            }
            throw new Error(
                `Failed to commit inbound message after retries: ${msg.id.msgId}`,
                { cause: error }
            );
        }
    }

    private async commitIncomingMessage(
        msg: ALMessage,
        fromPeerId: string,
        planIncomingMessage: ALInboundPlanner
    ): Promise<void> {
        const read = await this.admissionStore.readIncomingMessage(
            msg,
            fromPeerId,
            planIncomingMessage
        );
        const canForward = !read.plan.dropReason && this.dependencies.forwardMessage !== undefined &&
            (this.dependencies.canForwardMessage?.(msg) ?? true);
        const bundle = computeALInboundAdmission(
            read,
            canForward,
            readALInboundComputationFacts(this.dependencies)
        );
        const status = await this.admissionStore.commitBundle(bundle);
        if (status === 'conflict') {
            throw new RetryableConflictError('Inbound commit conflict');
        }
        await this.effects.start();
    }

    private async withSenderCommitQueue<T>(
        senderId: string,
        task: () => Promise<T>
    ): Promise<T> {
        const previous = this.commitQueuesBySenderId.get(senderId) ?? Promise.resolve();
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.catch(() => undefined).then(() => gate);
        this.commitQueuesBySenderId.set(senderId, tail);

        await previous.catch(() => undefined);

        try {
            return await task();
        }
        finally {
            release?.();
            if (this.commitQueuesBySenderId.get(senderId) === tail) {
                this.commitQueuesBySenderId.delete(senderId);
            }
        }
    }

    async dispatchStoredEntry(entry: ResourceEntry): Promise<'completed' | 'retry'> {
        await this.ready();
        return await this.delivery.dispatchAdmittedEntry(entry);
    }
}
