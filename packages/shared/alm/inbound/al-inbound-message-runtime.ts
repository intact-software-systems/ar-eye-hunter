import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { isALControlTypeId, type ALControlAcceptance } from '../../al-contracts/al-control.ts';
import { decodeALMessageValue, type ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import { type ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { Either } from '../../resilience/Either.ts';
import type { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
import { AL_WORK_PROBE_EVERY_ROUND, ALWorkHandler } from '../work/al-work-handler.ts';
import { createALWorkQueuePort, type ALWorkClaim, type ALWorkOutcome } from '../work/al-work-queue-port.ts';
import type {
    ALInboundAdmissionStore,
    ALInboundPlanner
} from './al-inbound-admission-store.ts';
import { ALInboundAdmittedDelivery } from './al-inbound-admitted-delivery.ts';
import { ALInboundMessageAdmission } from './al-inbound-message-admission.ts';
import type { ALInboundPendingAdmission } from './al-inbound-pending-admission.ts';
import {
    toALInboundAdmissionDiagnostics,
    type ALInboundRuntimeDiagnosticsSink
} from './al-inbound-runtime-diagnostics.ts';
import { AL_INBOUND_WORK_LEASE_MS, decodeALInboundWorkEntry, toALInboundWorkType } from './al-inbound-work-entry.ts';
import { ALInboundControlAdmission } from './control/al-inbound-control-admission.ts';
import {
    type ALInboundEffectPreparationDependencies
} from './prepare-al-inbound-commit-bundle.ts';
import {
    AL_INBOUND_WORK_PAGE_SIZE,
    createALInboundWorkSelector,
    type ALInboundWorkSelector
} from './read-al-inbound-work-selection.ts';
import { validateALInboundMessage } from './validate-al-inbound-message.ts';

export interface ALInboundRuntimeStores {
    readonly admissionStore: ALInboundAdmissionStore;
    readonly workQueue: QueueBoxResourceEntryRepository;
}

export namespace ALInboundMessageRuntime {
    export type Source =
        | { readonly kind: 'rtc-peer'; readonly peerId: string; }
        | { readonly kind: 'ws-client'; readonly peerId: string; readonly groupRecipientPeerIds?: readonly string[]; }
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
        readonly workQueue: QueueBoxResourceEntryRepository;
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
        readonly diagnostics: ALInboundRuntimeDiagnosticsSink | undefined;
    }
}

export class ALInboundMessageRuntime {
    private readonly admissionStore: ALInboundAdmissionStore;
    private readonly readyPromise: Promise<void>;

    private readonly admission: ALInboundMessageAdmission;
    private readonly controlAdmission: ALInboundControlAdmission;
    private readonly delivery: ALInboundAdmittedDelivery;
    private readonly workSelector: ALInboundWorkSelector;
    private readonly work: ALWorkHandler;
    private disposed = false;

    private readonly dependencies: ALInboundMessageRuntime.Dependencies;

    constructor(dependencies: ALInboundMessageRuntime.Dependencies) {
        this.dependencies = dependencies;
        this.admissionStore = dependencies.admissionStore;
        this.readyPromise = this.admissionStore.ready();
        const workPort = createALWorkQueuePort({
            queue: dependencies.workQueue,
            workTypes: new Set([toALInboundWorkType(this.admissionStore.namespace)]),
            leaseMs: AL_INBOUND_WORK_LEASE_MS,
            nowMs: () => dependencies.clock.nowMs(),
            random: dependencies.random
        });
        this.admission = new ALInboundMessageAdmission({ ...dependencies, workPort });
        this.controlAdmission = new ALInboundControlAdmission({
            admissionStore: this.admissionStore,
            port: workPort,
            clock: dependencies.clock,
            newControlId: dependencies.effectPreparation.newControlId,
            retention: this.admissionStore.retention
        });
        this.delivery = new ALInboundAdmittedDelivery(dependencies);
        this.workSelector = createALInboundWorkSelector({
            delivery: this.delivery,
            namespace: this.admissionStore.namespace,
            nowMs: () => dependencies.clock.nowMs()
        });
        this.work = new ALWorkHandler({
            workerId: dependencies.effectWorkerId,
            port: workPort,
            queueEngine: dependencies.queueEngine,
            ownsQueueEngine: dependencies.ownsQueueEngine,
            clock: dependencies.clock,
            pageSize: AL_INBOUND_WORK_PAGE_SIZE,
            // The rotation answers readiness: work the eligibility rules defer must not report as due.
            readNextReadyAtMs: (port) => this.workSelector.readNextReadyAtMs(port),
            // The rotation advances one status per probe, so an answer of its own never stands.
            readinessMemoryMs: AL_WORK_PROBE_EVERY_ROUND,
            selectReady: (port, pageSize) => this.workSelector.selectReady(port, pageSize),
            runClaim: (claim) => this.runInboundClaim(claim),
            diagnostics: (event) =>
                dependencies.diagnostics?.({
                    kind: 'effect-drain',
                    workerId: event.workerId,
                    durationMs: event.durationMs,
                    claimedCount: event.claimedCount,
                    completedCount: event.completedCount,
                    rescheduledCount: event.rescheduledCount,
                    rejectedCount: event.rejectedCount
                })
        });
        if (dependencies.ownsQueueEngine) {
            void this.ready().catch((error) => console.error('Inbound QueueBox startup failed', error));
        }
    }

    async ready(): Promise<void> {
        await this.readyPromise;

        await this.work.ready();
    }

    dispose(): void {
        this.disposed = true;
        this.admission.dispose();
        this.work.dispose();
        this.delivery.dispose();
    }

    async admitIncomingMessage(
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
        const admitted = await this.admitDecodedMessage(msg, source, planIncomingMessage);
        this.recordAdmissionOutcome(msg, admitted);
        return admitted;
    }

    /** A value that never decoded has no identity to record; every identity that does gets one event. */
    private recordAdmissionOutcome(
        msg: ALMessage,
        admitted: Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>
    ): void {
        this.dependencies.diagnostics?.({
            kind: 'admission-outcome',
            workerId: this.dependencies.effectWorkerId,
            msgId: msg.id.msgId,
            typeId: msg.payload.typeId,
            ...toALInboundAdmissionDiagnostics(admitted)
        });
    }

    private async admitDecodedMessage(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source,
        planIncomingMessage: ALInboundPlanner
    ): Promise<Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>> {
        const validated = validateALInboundMessage(msg, source, this.dependencies.effectPreparation.selfPeerId);
        if (validated.left) {
            return Either.ofLeft(validated.left);
        }
        await this.ready();
        if (this.disposed) {
            return Either.ofRight({ kind: 'disposed' });
        }
        if (isALControlTypeId(msg.payload.typeId)) {
            return Either.ofRight(await this.admitControlMessage(msg));
        }
        const attempt = await this.admission.attempt(msg, source, planIncomingMessage);
        if (attempt.left) {
            return Either.ofLeft(attempt.left);
        }
        const result = attempt.right!;
        if (result.kind === 'conflict') {
            return Either.ofRight(await this.retainConflictedAdmission(result.pending));
        }
        if (result.wroteWork) {
            this.commitWork();
        }
        return Either.ofRight(result.acceptance);
    }

    /** A conflict the plan does not retain wrote nothing, so it announces no commit. */
    private async retainConflictedAdmission(
        pending: ALInboundPendingAdmission | undefined
    ): Promise<ALInboundMessageRuntime.Acceptance> {
        if (pending === undefined) {
            return { kind: 'not-admitted', reason: 'conflict' };
        }
        const acceptance = await this.admission.retainPending(pending);
        this.commitWork();
        return acceptance;
    }

    private async admitControlMessage(msg: ALMessage): Promise<ALInboundMessageRuntime.Acceptance> {
        const admitted = await this.controlAdmission.admit(msg);
        // A control message the runtime does not handle, or rejects, wrote nothing to announce.
        if (admitted.kind === 'committed' || admitted.kind === 'pending-control') {
            this.commitWork();
        }
        if (admitted.kind === 'pending-control') {
            return { kind: 'pending-admission' };
        }
        const acceptance: ALControlAcceptance = admitted.kind === 'committed'
            ? admitted.acceptance
            : { handled: false, completedPendingAcks: [] };
        if (!this.disposed) {
            await this.dependencies.onControlMessage?.(msg, acceptance);
        }
        return { kind: 'control', handled: acceptance.handled };
    }

    /** A commit lands behind the running rotation; the worker restarts it and never waits for delivery. */
    private commitWork(): void {
        this.workSelector.restartScan();
        this.work.committed();
    }

    /** A replay writes its own follow-on work; the rotation and the engine's schedule pick it up. */
    private async runInboundClaim(claim: ALWorkClaim): Promise<ALWorkOutcome> {
        const effect = decodeALInboundWorkEntry(claim.entry, this.admissionStore.namespace);
        const payload = effect.payload;
        if (payload.kind === 'admit-message') {
            return toALInboundReplayOutcome(
                await this.admission.replay(payload),
                this.dependencies.clock.nowMs()
            );
        }
        if (payload.kind === 'admit-control') {
            const replayed = await this.controlAdmission.replay(payload);
            if (replayed.acceptance !== undefined && !this.disposed) {
                await this.dependencies.onControlMessage?.(payload.msg, replayed.acceptance);
            }
            return replayed.outcome;
        }
        return { status: await this.delivery.deliver(effect) };
    }
}

function toALInboundReplayOutcome(
    result: ALInboundMessageAdmission.ReplayResult,
    nowMs: number
): ALWorkOutcome {
    if (typeof result === 'string') {
        return { status: result };
    }
    return result.kind === 'not-ready'
        ? { status: 'not-ready', readyAtMs: nowMs + result.retryAfterMs }
        : { status: 'non-retryable' };
}
