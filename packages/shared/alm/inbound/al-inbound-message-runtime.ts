import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { isALControlTypeId, type ALControlAcceptance } from '../../al-contracts/al-control.ts';
import { decodeALMessageValue, type ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import { type ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { Either } from '../../resilience/Either.ts';
import type { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import type {
    ALInboundAdmissionStore,
    ALInboundPlanner
} from './al-inbound-admission-store.ts';
import { ALInboundAdmittedDelivery } from './al-inbound-admitted-delivery.ts';
import { ALInboundMessageAdmission } from './al-inbound-message-admission.ts';
import { ALInboundWorkHandler } from './al-inbound-work-handler.ts';
import {
    type ALInboundEffectPreparationDependencies
} from './prepare-al-inbound-commit-bundle.ts';
import { validateALInboundMessage } from './validate-al-inbound-message.ts';

export interface ALInboundRuntimeStores {
    readonly admissionStore: ALInboundAdmissionStore;
}

export namespace ALInboundMessageRuntime {
    export type Source =
        | { readonly kind: 'rtc-peer'; readonly peerId: string; }
        | { readonly kind: 'ws-client'; readonly peerId: string; readonly roomRecipientPeerIds?: readonly string[]; }
        | { readonly kind: 'trusted-server'; };

    export type Acceptance =
        | { readonly kind: 'admitted' | 'duplicate' | 'resync-required' | 'disposed' | 'pending-admission'; }
        | { readonly kind: 'not-admitted'; readonly reason: string; }
        | { readonly kind: 'control'; readonly handled: boolean; };

    export type PendingAuthority =
        | { readonly kind: 'authorized'; readonly source: Source; }
        | { readonly kind: 'retry'; readonly retryAfterMs: number; }
        | { readonly kind: 'rejected'; };

    export interface Clock {
        nowMs(): number;
    }

    export interface Resources {
        readonly admissionStore: ALInboundAdmissionStore;
        readonly effectPreparation: ALInboundEffectPreparationDependencies;
        readonly effectWorkerId: string;
        readonly clock: Clock;
        readonly random: () => number;
        readonly queueEngine: InboxOutboxEngine;
        readonly ownsQueueEngine: boolean;
    }

    export interface Dependencies extends Resources {
        readonly planIncomingMessage: ALInboundPlanner;
        /** Rechecks asynchronous ingress authority before pending data enters conditional admission. */
        readonly readPendingAdmissionAuthority?: (msg: ALMessage, source: Source) => Promise<PendingAuthority>;
        readonly readStoredEntry: (entry: ResourceEntry) => Readonly<ALMessage>;
        readonly dispatchInboxEntry: (
            entry: ResourceEntry,
            plan: ALMessageHandlingPlan,
            source: Source
        ) => Promise<void | 'completed' | 'retry'>;
        /** Absence means the supplied dispatcher is ready for every local message. */
        readonly canDispatchMessage?: (msg: ALMessage) => boolean;
        readonly sendControlMessage: (msg: ALMessage) => Promise<void>;
        readonly onControlMessage?: (msg: ALMessage, acceptance: ALControlAcceptance) => Promise<void>;
        readonly forwardMessage?: (
            msg: ALMessage,
            fromPeerId: string,
            plan: ALMessageHandlingPlan
        ) => Promise<void | 'completed' | 'retry'>;
        /** Absence means the configured transport can forward every message. */
        readonly canForwardMessage?: (msg: ALMessage) => boolean;
    }
}

export class ALInboundMessageRuntime {
    private readonly admissionStore: ALInboundAdmissionStore;
    private readonly readyPromise: Promise<void>;

    private readonly admission: ALInboundMessageAdmission;
    private readonly delivery: ALInboundAdmittedDelivery;
    private readonly effects: ALInboundWorkHandler;
    private disposed = false;

    private readonly dependencies: ALInboundMessageRuntime.Dependencies;

    constructor(dependencies: ALInboundMessageRuntime.Dependencies) {
        this.dependencies = dependencies;
        this.admissionStore = dependencies.admissionStore;
        this.readyPromise = this.admissionStore.ready();
        this.admission = new ALInboundMessageAdmission(dependencies);
        this.delivery = new ALInboundAdmittedDelivery(dependencies);
        this.effects = new ALInboundWorkHandler({
            ...dependencies,
            delivery: this.delivery,
            admission: this.admission
        });
        if (dependencies.ownsQueueEngine) {
            void this.ready().catch((error) => console.error('Inbound QueueBox startup failed', error));
        }
    }

    async ready(): Promise<void> {
        await this.readyPromise;

        await this.effects.startOnce();
    }

    dispose(): void {
        this.disposed = true;
        this.admission.dispose();
        this.effects.dispose();
        this.delivery.dispose();
    }

    async handleIncomingMessage(
        value: unknown,
        source: ALInboundMessageRuntime.Source,
        planIncomingMessage: ALInboundPlanner = this.dependencies.planIncomingMessage
    ): Promise<Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>> {
        if (this.disposed) {
            return Either.ofRight({ kind: 'disposed' });
        }
        const decoded = decodeALMessageValue(value);
        if (decoded.left) {
            return Either.ofLeft(decoded.left);
        }
        const msg = decoded.right!;
        const validated = validateALInboundMessage(msg, source, this.dependencies.effectPreparation.selfPeerId);
        if (validated.left) {
            return Either.ofLeft(validated.left);
        }
        await this.ready();
        if (this.disposed) {
            return Either.ofRight({ kind: 'disposed' });
        }
        if (isALControlTypeId(msg.payload.typeId)) {
            return Either.ofRight(await this.handleControlMessage(msg));
        }
        const attempt = await this.admission.attempt(msg, source, planIncomingMessage);
        if (attempt.left) {
            return Either.ofLeft(attempt.left);
        }
        const result = attempt.right!;
        const acceptance = result.kind === 'completed' ? result.acceptance : result.pending === undefined
            ? { kind: 'not-admitted' as const, reason: 'conflict' }
            : await this.admission.retainPending(result.pending);
        await this.effects.committed();
        return Either.ofRight(acceptance);
    }

    private async handleControlMessage(msg: ALMessage): Promise<ALInboundMessageRuntime.Acceptance> {
        let acceptance: ALControlAcceptance;
        try {
            acceptance = await this.admissionStore.acceptControlMessage(msg);
        }
        catch (error) {
            if (error instanceof ALAdmissionBackendConflictError) {
                return { kind: 'not-admitted', reason: 'conflict' };
            }
            throw error;
        }
        const waitForEffects = !this.effects.hasActiveDrain();
        const effectDrain = this.effects.committed();
        if (waitForEffects) {
            await effectDrain;
        }
        if (!this.disposed) {
            await this.dependencies.onControlMessage?.(msg, acceptance);
        }
        return { kind: 'control', handled: acceptance.handled };
    }
}
