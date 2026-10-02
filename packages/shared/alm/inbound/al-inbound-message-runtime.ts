import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { isALControlTypeId } from '../../al-contracts/al-control-type-ids.ts';
import { type ALControlAcceptance } from '../../al-contracts/al-control.ts';
import { decodeALMessageValue, type ALMessageRejection } from '../../al-contracts/al-message-persistence-validation.ts';
import { type ALMessageHandlingPlan } from '../../al-contracts/al-policy.ts';
import type { StateScope } from '../../api/state-types.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import type { ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { Either } from '../../resilience/Either.ts';
import type { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
import type { ALDeliveryCarrier } from '../delivery/al-delivery-lifecycle.ts';
import type { ALStorageHealth } from '../storage/al-storage-health.ts';
import type { ALStorageReadiness } from '../storage/al-storage-readiness.ts';
import type { ALStorageRecoveryLane, ALStorageRecoveryReporter } from '../storage/al-storage-recovery-reporter.ts';
import type { ALStorageUnavailable } from '../storage/al-storage-unavailable.ts';
import type { ALVolatileSessionBudget } from '../volatile-budget/al-volatile-session-budget.ts';
import type { ALDurableWorkOwnership } from '../work/al-durable-work-ownership.ts';
import type { ALInboundAdmissionStore, ALInboundPlanner } from './al-inbound-admission-store.ts';
import {
    toALInboundAdmissionDiagnostics,
    type ALInboundRuntimeDiagnosticsSink
} from './al-inbound-runtime-diagnostics.ts';
import { toALDeliveryCarrier } from './al-inbound-source-validation.ts';
import type { ALInboundControlAdmissionResult } from './control/al-inbound-control-admission.ts';
import { isALOriginAcknowledgement } from './control/is-al-origin-acknowledgement.ts';
import { admitALInboundVolatileBudget } from './lane/admit-al-inbound-volatile-budget.ts';
import { ALInboundStoreLane } from './lane/al-inbound-store-lane.ts';
import { resolveALInboundStoreDurability } from './lane/resolve-al-inbound-store-durability.ts';
import {
    type ALInboundEffectPreparationDependencies
} from './prepare-al-inbound-commit-bundle.ts';
import {
    toALInboundReceiver,
    validateALInboundMessage,
    type ALInboundReceiver
} from './validate-al-inbound-message.ts';

export interface ALInboundRuntimeStores {
    readonly admissionStore: ALInboundAdmissionStore;
    readonly workQueue: QueueBoxResourceEntryRepository;
    /** Records the storage failures and the commits of the lanes over this pair; absent where no storage failure reaches. */
    readonly storageHealth?: ALStorageHealth;
    /**
     * Creates one carrier lane's recovery reporter: both carriers' lanes share the session's pair, and each
     * reports its own first work batch. Absent for a pair that recovers nothing (memory, PostgreSQL).
     */
    readonly createStorageRecovery?: (lane: ALStorageRecoveryLane) => ALStorageRecoveryReporter;
}

/** The session's inbound memory pair: nothing in it survives the document, and each lane over it sweeps it. */
export interface ALVolatileInboundRuntimeStores extends ALInboundRuntimeStores {
    evictExpired(): void;
    readonly budget: ALVolatileSessionBudget | undefined;
}

export namespace ALInboundMessageRuntime {
    export type Source =
        | {
            readonly kind: 'rtc-peer';
            readonly peerId: string;
            readonly groupRecipientPeerIds?: readonly string[];
            readonly snapshotVersion?: number;
        }
        | {
            readonly kind: 'ws-client';
            readonly peerId: string;
            readonly authenticatedScope: StateScope;
            readonly groupRecipientPeerIds?: readonly string[];
        }
        | { readonly kind: 'trusted-server'; };

    export type Acceptance =
        | { readonly kind: 'admitted' | 'duplicate' | 'resync-required' | 'disposed' | 'pending-admission'; }
        | { readonly kind: 'not-admitted'; readonly reason: string; }
        | { readonly kind: 'control'; readonly handled: boolean; };

    /** What ingress decided; a control its store could not persist is answered as an unhandled control. */
    export type Admission =
        | Acceptance
        | { readonly kind: 'unpersisted-control'; readonly unavailable: ALStorageUnavailable; };

    /** A control the store could not persist, so it wrote nothing. */
    export type UnpersistedControl = Readonly<{ kind: 'storage-unavailable'; }> & ALStorageUnavailable;

    export type PendingAuthority =
        | { readonly kind: 'authorized'; readonly source: Source; }
        | { readonly kind: 'retry'; readonly retryAfterMs: number; }
        | { readonly kind: 'rejected'; };

    export interface Clock {
        nowMs(): number;
    }

    export interface Resources {
        /** The durable pair, and the only one of a runtime without `volatileStores`. */
        readonly admissionStore: ALInboundAdmissionStore;
        readonly workQueue: QueueBoxResourceEntryRepository;
        /** The health of the durable pair; `undefined` for a pair no storage failure reaches (memory, PostgreSQL). */
        readonly storageHealth: ALStorageHealth | undefined;
        /** The durable pair's recovery, one reporter per lane; `undefined` for a pair that recovers nothing (memory, PostgreSQL). */
        readonly createStorageRecovery: ((lane: ALStorageRecoveryLane) => ALStorageRecoveryReporter) | undefined;
        /** The memory pair a volatile message goes to; `undefined` keeps one backend for every message. */
        readonly volatileStores: ALVolatileInboundRuntimeStores | undefined;
        readonly effectPreparation: ALInboundEffectPreparationDependencies;
        readonly effectWorkerId: string;
        readonly clock: Clock;
        readonly random: () => number;
        readonly queueEngine: InboxOutboxEngine;
        readonly ownsQueueEngine: boolean;
        /** Which runtime of the session drains the durable pair; only the durable lane takes it. */
        readonly durableWorkOwnership: ALDurableWorkOwnership;
    }

    /** A retried copy of an admitted message, owed to these child hops only, sent as its own attempt. */
    export interface RetriedCopy {
        readonly msg: ALMessage;
        readonly fromPeerId: string;
        readonly toPeerIds: readonly string[];
        readonly attemptIdentity: string;
    }

    export interface ForwardMessageInputDto {
        readonly msg: ALMessage;
        readonly fromPeerId: string;
        readonly plan: ALMessageHandlingPlan;
        readonly source: Source;
    }

    export interface Dependencies extends Resources {
        /** The carrier this runtime admits from and delivers on; it claims only that carrier's work rows. */
        readonly carrier: ALDeliveryCarrier;
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
        /** Sends the control messages of one batch as one outbound admission, or a single one alone. */
        readonly sendControlMessages: (msgs: readonly ALMessage[]) => Promise<void>;
        /** Answers `storage-unavailable` when the outbound store could not persist the control: a replay claim retries. */
        readonly onControlMessage?: (
            msg: ALMessage,
            acceptance: ALControlAcceptance
        ) => Promise<void | UnpersistedControl>;
        readonly forwardMessage?: (input: ForwardMessageInputDto) => Promise<void | 'completed' | 'retry'>;
        /** Absence means a retried copy of an admitted message is never forwarded again. */
        readonly forwardRetriedCopy?: (copy: RetriedCopy) => Promise<void | 'completed' | 'retry'>;
        /** Absence means the configured transport can forward every message. */
        readonly canForwardMessage?: (msg: ALMessage) => boolean;
        /** Absence means no relay here ever loses its recorded parent, so only the origin re-parents a row. */
        readonly isRoomPeerPresent?: (msg: ALMessage, peerId: string) => boolean;
        /** Absence means this runtime relays origin-addressed controls for no peer. */
        readonly readRelayedAckRejection?: ALInboundReceiver['readRelayedAckRejection'];
        readonly diagnostics: ALInboundRuntimeDiagnosticsSink | undefined;
    }
}

/**
 * One carrier's inbound owner. It validates every arrival and routes it to a store lane; each lane
 * admits, retains and delivers over its own store pair.
 *
 * - A data message goes to the lane `resolveALInboundStoreDurability(msg)` names: `durable` exactly
 *   when the envelope's normalized durability is `local-inbox`. The decision reads the envelope alone,
 *   so every copy and retry of one message resolves to the same lane.
 * - An acknowledgement of a message this peer originated is `not-handled` and reads no store: the
 *   origin keeps no inbound decision surface for its own message.
 * - Any other control goes to the volatile lane first, and to the durable lane when that lane answers
 *   `not-handled`, which writes nothing: a control about a durable message costs one memory read
 *   before its IndexedDB admission. A control the memory lane handles never reaches IndexedDB; a late
 *   or unresolved one (its rows swept, or from a peer its owner index does not name) costs one IndexedDB read.
 * - Duplicate detection is per lane: a msgId the memory lane admitted is invisible to the IndexedDB
 *   lane, and the reverse. The lane is fixed by the envelope, so a copy of one message always meets
 *   its first admission.
 * - An ordering or supersedence track whose messages declare different durabilities is split between
 *   the lanes; no caller declares one that way.
 * - The volatile lane's worker id is `${effectWorkerId}/volatile`. It sweeps its expired rows from its
 *   own work round, at most once per `AL_VOLATILE_STORE_EVICTION_INTERVAL_MS` of its clock.
 */
export class ALInboundMessageRuntime {
    private readonly durable: ALInboundStoreLane;
    private readonly volatile: ALInboundStoreLane | undefined;
    private disposed = false;

    private readonly dependencies: ALInboundMessageRuntime.Dependencies;

    constructor(dependencies: ALInboundMessageRuntime.Dependencies) {
        this.dependencies = dependencies;
        this.durable = new ALInboundStoreLane({
            lane: 'durable',
            stores: dependencies,
            workerId: dependencies.effectWorkerId,
            evictExpired: undefined,
            durableWorkOwnership: dependencies.durableWorkOwnership,
            runtime: dependencies
        });
        this.volatile = dependencies.volatileStores === undefined ? undefined : new ALInboundStoreLane({
            lane: 'volatile',
            stores: dependencies.volatileStores,
            workerId: `${dependencies.effectWorkerId}/volatile`,
            evictExpired: dependencies.volatileStores.evictExpired,
            durableWorkOwnership: undefined,
            runtime: dependencies
        });
        if (dependencies.ownsQueueEngine) {
            void this.ready().catch((error) => console.error('Inbound QueueBox startup failed', error));
        }
    }

    /** What the storage of the durable lane answered; the memory pair of the volatile lane is always ready. */
    async ready(): Promise<ALStorageReadiness.Outcome> {
        const [durable] = await Promise.all([this.durable.ready(), this.volatile?.ready()]);
        return durable;
    }

    dispose(): void {
        this.disposed = true;
        this.durable.dispose();
        this.volatile?.dispose();
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
        this.recordAdmissionOutcome(msg, source, admitted);
        return admitted.mapRight(toALInboundAcceptance);
    }

    /** A value that never decoded has no identity to record; every identity that does gets one event. */
    private recordAdmissionOutcome(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source,
        admitted: Either<ALMessageRejection, ALInboundMessageRuntime.Admission>
    ): void {
        this.dependencies.diagnostics?.({
            kind: 'admission-outcome',
            workerId: this.dependencies.effectWorkerId,
            msgId: msg.id.msgId,
            typeId: msg.payload.typeId,
            carrier: toALDeliveryCarrier(source),
            ...toALInboundAdmissionDiagnostics(admitted)
        });
    }

    private async admitDecodedMessage(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source,
        planIncomingMessage: ALInboundPlanner
    ): Promise<Either<ALMessageRejection, ALInboundMessageRuntime.Admission>> {
        const validated = validateALInboundMessage(
            msg,
            source,
            toALInboundReceiver(
                this.dependencies.effectPreparation.selfPeerId,
                this.dependencies.readRelayedAckRejection
            )
        );
        if (validated.left) {
            return Either.ofLeft(validated.left);
        }
        await this.ready();
        if (this.disposed) {
            return Either.ofRight({ kind: 'disposed' });
        }
        if (isALControlTypeId(msg.payload.typeId)) {
            return Either.ofRight(await this.admitControlMessage(msg, source));
        }
        const lane = this.resolveDataLane(msg);
        const admitted = await lane.admitData(msg, source, planIncomingMessage);
        if (lane === this.volatile) {
            admitALInboundVolatileBudget({
                msg,
                acceptance: admitted.right,
                budget: this.dependencies.volatileStores?.budget,
                nowMs: this.dependencies.clock.nowMs()
            });
        }
        return admitted;
    }

    /** The lane the envelope's durability names, or the only lane of a runtime with one backend. */
    private resolveDataLane(msg: ALMessage): ALInboundStoreLane {
        return this.volatile === undefined || resolveALInboundStoreDurability(msg) === 'durable'
            ? this.durable
            : this.volatile;
    }

    private async admitControlMessage(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source
    ): Promise<ALInboundMessageRuntime.Admission> {
        const admitted = isALOriginAcknowledgement(msg, this.dependencies.effectPreparation.selfPeerId)
            ? { kind: 'not-handled' as const }
            : await this.admitControlInLanes(msg, source);
        if (admitted.kind === 'pending-control') {
            return { kind: 'pending-admission' };
        }
        const acceptance: ALControlAcceptance = admitted.kind === 'committed'
            ? admitted.acceptance
            : { handled: false, completedPendingAcks: [] };
        const handedOver = this.disposed ? undefined : await this.dependencies.onControlMessage?.(msg, acceptance);
        const unpersisted = admitted.kind === 'storage-unavailable' ? admitted : handedOver || undefined;
        return unpersisted === undefined
            ? { kind: 'control', handled: acceptance.handled }
            : { kind: 'unpersisted-control', unavailable: { cause: unpersisted.cause, detail: unpersisted.detail } };
    }

    /** Memory first, so a control the memory lane handles never reaches IndexedDB. */
    private async admitControlInLanes(
        msg: ALMessage,
        source: ALInboundMessageRuntime.Source
    ): Promise<ALInboundControlAdmissionResult> {
        const volatile = await this.volatile?.admitControl(msg, source);
        return volatile === undefined || volatile.kind === 'not-handled'
            ? await this.durable.admitControl(msg, source)
            : volatile;
    }
}

/** The carrier reads a control its store could not persist as one it did not handle. */
function toALInboundAcceptance(admission: ALInboundMessageRuntime.Admission): ALInboundMessageRuntime.Acceptance {
    return admission.kind === 'unpersisted-control' ? { kind: 'control', handled: false } : admission;
}
