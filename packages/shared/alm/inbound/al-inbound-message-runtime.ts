import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodeALControlMessage, isALControlTypeId, type ALControlAcceptance } from '../../al-contracts/al-control.ts';
import { decodeALMessageValue, type ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import type { ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { Either } from '../../resilience/Either.ts';
import { ALAdmissionBackendConflictError } from '../ALAdmissionBackendConflictError.ts';
import type {
    ALInboundAdmissionStore,
    ALInboundPlanner
} from './al-inbound-admission-store.ts';
import { ALInboundAdmittedDelivery } from './al-inbound-admitted-delivery.ts';
import { ALInboundDurableEffectWorker } from './al-inbound-durable-effect-worker.ts';
import { computeALInboundPlanningObservations } from './al-inbound-planner-snapshot.ts';
import { computeALInboundAdmission } from './compute-al-inbound-admission.ts';
import {
    readALInboundEffectFacts,
    type ALInboundEffectPreparationDependencies
} from './prepare-al-inbound-commit-bundle.ts';
import { validateALInboundCommitBundle } from './validate-al-inbound-commit-bundle.ts';

export interface ALInboundRuntimeStores {
    readonly admissionStore: ALInboundAdmissionStore;
}

export namespace ALInboundMessageRuntime {
    export type Source =
        | { readonly kind: 'rtc-peer'; readonly peerId: string; }
        | { readonly kind: 'ws-client'; readonly peerId: string; readonly roomRecipientPeerIds?: readonly string[]; }
        | { readonly kind: 'trusted-server'; };

    export type Acceptance =
        | { readonly kind: 'admitted' | 'duplicate' | 'resync-required' | 'disposed'; }
        | { readonly kind: 'not-admitted'; readonly reason: string; }
        | { readonly kind: 'control'; readonly handled: boolean; };

    export interface Clock {
        nowMs(): number;
    }

    export interface Scheduler {
        /** Runs the callback once after the delay; the returned operation cancels it before invocation. */
        schedule(callback: () => void, delayMs: number): () => void;
    }

    export interface Resources {
        readonly admissionStore: ALInboundAdmissionStore;
        readonly effectPreparation: ALInboundEffectPreparationDependencies;
        readonly effectWorkerId: string;
        readonly clock: Clock;
        readonly scheduler: Scheduler;
    }

    export interface Dependencies extends Resources {
        readonly inbox: QueueBoxResourceEntryRepository;
        readonly planIncomingMessage: ALInboundPlanner;
        readonly readStoredEntry: (entry: ResourceEntry) => Readonly<ALMessage>;
        readonly dispatchInboxEntry: (
            entry: ResourceEntry,
            plan: ALMessageHandlingPlan,
            source: Source
        ) => Promise<void | 'completed' | 'retry'>;
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

    private readonly delivery: ALInboundAdmittedDelivery;
    private readonly effects: ALInboundDurableEffectWorker;
    private disposed = false;

    private readonly dependencies: ALInboundMessageRuntime.Dependencies;

    constructor(dependencies: ALInboundMessageRuntime.Dependencies) {
        this.dependencies = dependencies;
        this.admissionStore = dependencies.admissionStore;
        this.readyPromise = this.admissionStore.ready();
        this.delivery = new ALInboundAdmittedDelivery(dependencies);
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
        return await this.commitIncomingMessage(msg, source, planIncomingMessage);
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
        const effectDrain = this.effects.start();
        if (waitForEffects) {
            await effectDrain;
        }
        if (!this.disposed) {
            await this.dependencies.onControlMessage?.(msg, acceptance);
        }
        return { kind: 'control', handled: acceptance.handled };
    }

    private async commitIncomingMessage(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source,
        planIncomingMessage: ALInboundPlanner
    ): Promise<Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>> {
        const nowMs = this.dependencies.clock.nowMs();
        const prePlan = planIncomingMessage(msg, source, { nowMs });
        const facts = readALInboundEffectFacts(msg, nowMs, this.dependencies.effectPreparation);
        const read = await this.admissionStore.readIncomingMessage({ msg, source, nowMs, prePlan });
        if (this.disposed) {
            return Either.ofRight({ kind: 'disposed' });
        }
        const plan = planIncomingMessage(msg, source, computeALInboundPlanningObservations(read));
        const canForward = !plan.dropReason && this.dependencies.forwardMessage !== undefined &&
            (this.dependencies.canForwardMessage?.(msg) ?? true);
        const computed = computeALInboundAdmission({ read, plan, canForward, facts });
        const validated = validateALInboundCommitBundle(computed);
        if (validated.left) {
            return Either.ofLeft(validated.left);
        }
        const status = await this.admissionStore.commitBundle(validated.right!);
        if (status === 'conflict') {
            return Either.ofRight({ kind: 'not-admitted', reason: 'conflict' });
        }
        await this.effects.start();
        if (plan.orderingRuntime.status === 'resync-required') {
            return Either.ofRight({ kind: 'resync-required' });
        }
        if (plan.dropReason?.startsWith('Duplicate message')) {
            return Either.ofRight({ kind: 'duplicate' });
        }
        return Either.ofRight(
            plan.dropReason
                ? { kind: 'not-admitted', reason: plan.dropReason }
                : { kind: 'admitted' }
        );
    }

    async dispatchStoredEntry(entry: ResourceEntry): Promise<'completed' | 'retry'> {
        await this.ready();
        return await this.delivery.dispatchAdmittedEntry(entry);
    }
}

export function validateALInboundMessage(
    msg: ALMessage,
    source: ALInboundMessageRuntime.Source,
    selfPeerId: string
): Either<ALMessageRejection, ALMessage> {
    if (
        source.kind !== 'trusted-server' &&
        (source.kind === 'ws-client' || msg.targets?.mode === 'unicast') &&
        msg.id.senderId !== source.peerId
    ) {
        return Either.ofLeft({ code: 'unauthorized', message: 'AL origin does not match the authenticated peer' });
    }
    if (source.kind === 'rtc-peer' && msg.targets?.mode === 'unicast' && msg.targets.toPeerId !== selfPeerId) {
        return Either.ofLeft({
            code: 'unauthorized',
            message: 'Direct RTC envelope is addressed to another recipient'
        });
    }
    if (msg.targets?.mode === 'multicast' && msg.targets.membershipEpoch !== undefined) {
        return Either.ofLeft({ code: 'unsupported', message: 'Authoritative membership fencing is not implemented' });
    }
    if (msg.payload.typeId.startsWith('al.control.')) {
        const control = decodeALControlMessage(msg);
        if (control.left) {
            return Either.ofLeft(control.left);
        }
        if (control.right!.payload.toPeerId !== selfPeerId) {
            return Either.ofLeft({ code: 'unauthorized', message: 'Control is addressed to another local receiver' });
        }
    }
    return Either.ofRight(msg);
}
