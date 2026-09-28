import type { ALMessage } from '../../al-contracts/al-contract.ts';
import { decodeALControlMessage, type ALReceiptPayload } from '../../al-contracts/al-control.ts';
import type {
    ALAckAlgo,
    ALReceiptMode,
    ALRepairAlgo,
    ALSupersedenceAlgo
} from '../../al-contracts/al-policy.ts';
import type { StateScope } from '../../api/state-types.ts';
import type { QueueBoxResourceEntryRepository } from '../../queuebox/queue-box-types.ts';
import type { ResourceInboxResilience } from '../../queuebox/resource-inbox/resource-inbox-resilience.ts';
import type { Key, ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import type { InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
import type { ALStoreDurability } from '../al-runtime-stores.ts';
import type {
    ALDeliveryAdmissionVerdict,
    ALDeliveryCarrier,
    ALDeliverySettlement,
    ALDeliverySettlementSink
} from '../delivery/al-delivery-lifecycle.ts';
import type { ALWorkReadinessProbeCause } from '../work/al-work-handler.ts';
import type {
    ALOutboundAdmissionStore,
    ALOutboundPlanner,
    ALOutboundPreparedMessageDecoder
} from './admission/al-outbound-admission-store.ts';
import type { ALOutboundDispatchAdmission } from './al-outbound-dispatch-admission.ts';
import { controlTargetMsgId, type ALOutboundControlSource } from './compute-al-outbound-control-admission.ts';
import type { ALOutboundComputedDto } from './compute-al-outbound-dispatch.ts';
import type { ALOutboundControlAdmissionResult } from './control/al-outbound-control-admission.ts';
import { ALOutboundSendControls, type ALOutboundCancelOutcome } from './lane/al-outbound-send-controls.ts';
import { ALOutboundStoreLane } from './lane/al-outbound-store-lane.ts';

export type {
    ALOutboundControlAdmission,
    ALOutboundControlAdmissionResult
} from './control/al-outbound-control-admission.ts';
export type { ALOutboundCancelOutcome, ALOutboundHandOverOutcome } from './lane/al-outbound-send-controls.ts';

export type ALOutboundDispatchPhase = 'immediate' | 'dequeue';

/** Carrier-owned first-dequeue authority; a later stored admission always wins over this read. */
export interface ALOutboundDequeueAuthority {
    readonly admittedAudience: readonly string[] | undefined;
    readonly recipientScope: StateScope | undefined;
}

/** Runs once per dequeue attempt before dispatch admission; failures return to the existing work owner. */
export type ALOutboundDequeueAuthorityReader = (
    message: ALMessage,
    entry: ResourceEntry
) => Promise<ALOutboundDequeueAuthority | undefined>;

export interface ALOutboundSettledSendResult {
    readonly status: 'sent' | 'no-targets' | 'not-ready' | 'failed' | 'cancelled' | 'expired' | 'superseded';
    /** Whether the carrier handed the bytes to its transport; a refusal before that never did. */
    readonly submissionAttempted: boolean;
    readonly reason?: string;
    readonly retryAfterMs?: number;
}

export type ALOutboundPreparedSendResult =
    | ALOutboundSettledSendResult
    | Readonly<{
        status: 'queued';
        /** The transport retains this attempt until exactly one local terminal outcome. */
        settled: Promise<ALOutboundSettledSendResult>;
    }>;

export interface ALOutboundAckTrackingPlan {
    readonly enabled: boolean;
    readonly timeoutMs: number;
    readonly maxAttempts: number;
    readonly expectedPeerIds: readonly string[];
    /** How a re-plan updates a retained receipt's expected set; absent merges. */
    readonly expectedPeerIdsUpdate?: 'merge' | 'replace';
    /**
     * The next hops this dispatch sends through: the local hop view a `receiver` receipt states beside its
     * recipients. Under `hop` and `subtree` they are the expected peers; a WS origin names no hop.
     */
    readonly nextHopPeerIds: readonly string[];
    /** The send's resolved ack algorithm: what the receipt it tracks counts. */
    readonly mode: ALReceiptMode;
}

export interface ALOutboundRepairTrackingPlan {
    readonly enabled: boolean;
    readonly algo: ALRepairAlgo;
    readonly maxAttempts: number;
}

export interface ALOutboundRetryTrackingPlan {
    readonly enabled: boolean;
    readonly maxAttempts: number;
    readonly retryDelayMs?: number;
}

export interface ALOutboundSupersedenceTrackingPlan {
    readonly enabled: boolean;
    readonly algo: ALSupersedenceAlgo;
    readonly key?: string;
    readonly replacesMsgId?: string;
}

export type ALOutboundRepairTrigger = 'ack-timeout' | 'nack' | 'repair';

export interface ALOutboundRepairRequest {
    readonly referenceKey?: Key;
    readonly admittedAudience?: readonly string[];
    readonly recipientScope?: StateScope;
    readonly trigger: ALOutboundRepairTrigger;
    readonly repair: ALOutboundRepairTrackingPlan;
    readonly requestedByPeerId?: string;
    readonly failedPeerIds: readonly string[];
    /** The next hops whose subtree the receipt saw complete; empty for a retry no receipt timed out. */
    readonly completedHopPeerIds: readonly string[];
    readonly orderingTrackKey?: string;
    readonly missingSeqs: readonly number[];
}

/** Why a planner dropped the message. `rtc-room-snapshot-admission.ts` sets its two shared values from `ALMessageDropReasonCode`; `'planner-drop'` covers a drop that fits no other code. */
export type ALOutboundDropReasonCode =
    | 'unauthorized'
    | 'unsupported'
    | 'not-yet-in-sync'
    | 'no-route'
    | 'superseded'
    | 'expired'
    | 'duplicate'
    | 'planner-drop';

export interface ALOutboundDispatchPlan<TPrepared> {
    readonly msg: ALMessage;
    readonly dropReason?: string;
    /** Required so every planner states its drop code; `undefined` means the plan is not dropping the message. */
    readonly dropReasonCode: ALOutboundDropReasonCode | undefined;
    readonly persist: boolean;
    readonly preparedMessages: readonly TPrepared[];
    readonly ackTracking?: ALOutboundAckTrackingPlan;
    /**
     * Independent current-hop observations for planners whose default receipt policy may change on replay.
     * Absent means the planner supplies only ackTracking; no extra topology observation is available.
     */
    readonly receiptNextHopPeerIds?: readonly string[];
    readonly retryTracking?: ALOutboundRetryTrackingPlan;
    readonly repairTracking?: ALOutboundRepairTrackingPlan;
    readonly supersedenceTracking?: ALOutboundSupersedenceTrackingPlan;
    /**
     * The audience a server admitted the message to, carried beside the message rather than on the wire,
     * where a large room would exceed the collection limit. The owner keeps it with the captured policy and
     * hands it to its planners on every later plan. Absent when nothing admitted the message to an audience.
     */
    readonly admittedAudience?: readonly string[];
    readonly recipientScope?: StateScope;
}

export interface ALOutboundRuntimeStores<TPrepared> {
    readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
    readonly workQueue: QueueBoxResourceEntryRepository;
}

/** The memory pair of a carrier runtime: nothing in it survives the document, and its lane sweeps it. */
export interface ALVolatileOutboundRuntimeStores<TPrepared> extends ALOutboundRuntimeStores<TPrepared> {
    evictExpired(): void;
}

/** The call path that asked for a commit, so its wait and its hold are charged to the work behind it. */
export type ALOutboundCommitOrigin = 'send' | 'drain' | 'repair';

/** What the write transaction returned, or that the admission settled before opening one. */
export type ALOutboundCommitBundleOutcome = 'committed' | 'conflict' | 'expired' | 'not-attempted';

export type ALOutboundRuntimeDiagnosticsEvent =
    | Readonly<{
        kind: 'sender-queue-wait';
        senderId: string;
        origin: ALOutboundCommitOrigin;
        queued: boolean;
        /** `none` when this commit found the sender's queue empty. */
        queuedBehindOrigin: ALOutboundCommitOrigin | 'none';
        durationMs: number;
    }>
    | Readonly<{
        kind: 'browser-lock-wait';
        senderId: string;
        origin: ALOutboundCommitOrigin;
        lockName: string;
        available: boolean;
        durationMs: number;
    }>
    | Readonly<{
        kind: 'browser-lock-hold';
        senderId: string;
        origin: ALOutboundCommitOrigin;
        lockName: string;
        available: boolean;
        durationMs: number;
    }>
    | Readonly<{
        kind: 'commit-phases';
        /** The store pair this commit read and wrote; only the IndexedDB lane's timings describe the runner. */
        lane: ALStoreDurability;
        senderId: string;
        /** The message this commit admitted, so one signaling offer can be followed across the phases. */
        msgId: string;
        /** The message's payload type: which lane the commit belongs to (RTC signaling, app traffic, control). */
        typeId: string;
        origin: ALOutboundCommitOrigin;
        readDurationMs: number;
        /** Admission-store round trips observed while this commit's read chain ran. */
        readOperationCount: number;
        commitDurationMs: number;
        commitOutcome: ALOutboundCommitBundleOutcome;
    }>
    | Readonly<{
        kind: 'control-admission';
        /** The control message's own id: the join key to the inbound `admission-outcome` that routed it. */
        msgId: string;
        typeId: string;
        /** The outbound message this control answers. */
        targetMsgId: string;
        outcome: ALOutboundControlAdmissionResult['kind'];
        /** The rejection's reasons, or `none` for every other outcome. */
        reason: string;
        /**
         * The receipt's phase, present exactly when the control is a WS server receipt: no other control has one,
         * so absence means "not a receipt" rather than a missing phase.
         */
        phase?: ALReceiptPayload['phase'];
    }>
    | Readonly<{
        kind: 'effect-drain';
        lane: ALStoreDurability;
        workerId: string;
        durationMs: number;
        claimedCount: number;
        completedCount: number;
        rescheduledCount: number;
        rejectedCount: number;
    }>
    | Readonly<{
        kind: 'readiness-probe';
        lane: ALStoreDurability;
        workerId: string;
        /** Which invalidation emptied this owner's readiness memory, or that it had none yet. */
        cause: ALWorkReadinessProbeCause;
        /** The answer storage gave: when work is next due, or `none` for no work at all. */
        readyAtMs: number | 'none';
        /** What that storage read cost: the page read the batch behind a "due now" answer then reuses. */
        durationMs: number;
    }>;

export type ALOutboundRuntimeDiagnosticsSink = (
    event: ALOutboundRuntimeDiagnosticsEvent
) => void;

/** Every settlement variant without the two fields the runtime stamps for its owners. */
type ALOutboundUnstampedSettlement<TSettlement> = TSettlement extends ALDeliverySettlement ?
    Omit<TSettlement, 'carrier' | 'atMs'> :
    never;

/** One delivery fact as the owner that observed it states it, before the runtime stamps it. */
export type ALOutboundSettlementFact = ALOutboundUnstampedSettlement<ALDeliverySettlement>;

/**
 * The already-guarded sink an outbound owner states one delivery fact to. The runtime owns the only
 * guard, so a sink that throws never reaches the work that stated the fact.
 */
export type ALOutboundSettlementEmitter = (fact: ALOutboundSettlementFact) => void;

export interface ALOutboundEnqueueResult {
    readonly verdict: ALDeliveryAdmissionVerdict;
    readonly message: ALMessage;
    readonly entry?: ResourceEntry;
    readonly entries: readonly ResourceEntry[];
    readonly reason?: string;
    /** The receipt this carrier tracks for what it admitted; `none` for a verdict that admitted nothing (R-S3a-4). */
    readonly trackedReceiptAlgo: ALAckAlgo;
}

export namespace ALOutboundMessageRuntime {
    /** An admitted message sent again with this plan, as one repair attempt of its own identity. */
    export interface Retransmission<TPrepared> {
        readonly msg: ALMessage;
        readonly plan: ALOutboundDispatchPlan<TPrepared>;
        readonly attemptIdentity: string;
    }

    export type PendingAdmissionAuthority =
        | Readonly<{ status: 'authorized'; }>
        | Readonly<{ status: 'rejected'; reason: string; }>
        | Readonly<{ status: 'not-ready'; reason: string; retryAfterMs: number; }>;
    export interface SendLifecycle {
        readonly canonicalMessage: ALMessage;
        /** This message's own signal: `cancel(msgId)` aborts it directly; disposal aborts every live one. */
        readonly signal: AbortSignal;
        readonly expiresAtMs: number | undefined;
        readonly leaseUntilMs: number | undefined;
    }

    export interface Clock {
        nowMs(): number;
    }

    export interface BrowserLocks {
        /** Holds the named exclusive lock until the single callback invocation settles. */
        request<T>(name: string, options: Readonly<{ mode: 'exclusive'; }>, callback: () => Promise<T>): Promise<T>;
    }

    export interface Resources<TPrepared> {
        /** The durable pair, and the only one of a runtime without `volatileStores`. */
        readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
        readonly workQueue: QueueBoxResourceEntryRepository;
        /** The memory pair a volatile admission goes to; `undefined` keeps one backend for every admission. */
        readonly volatileStores: ALVolatileOutboundRuntimeStores<TPrepared> | undefined;
        readonly effectWorkerId: string;
        readonly clock: Clock;
        readonly random: () => number;
        readonly queueEngine: InboxOutboxEngine;
        readonly ownsQueueEngine: boolean;
        readonly browserLocks: BrowserLocks | undefined;
    }

    export interface DequeueSource {
        /** Foreign queue types whose rows this owner admits and dispatches. */
        readonly types: ReadonlySet<string>;
        readonly resilience: ResourceInboxResilience;
    }

    export interface Dependencies<TPrepared> extends Resources<TPrepared> {
        /** Which transport this owner drives; every settlement it states is stamped with it. */
        readonly carrier: ALDeliveryCarrier;
        readonly dequeue: DequeueSource;
        readonly readPendingAdmissionAuthority?: (
            msg: ALMessage,
            preparedMessages: readonly TPrepared[]
        ) => Promise<PendingAdmissionAuthority>;
        readonly toOutboxEntry: (msg: ALMessage) => ResourceEntry;
        readonly readMessageFromEntry: (entry: ResourceEntry) => ALMessage;
        readonly planOutgoingMessage: ALOutboundPlanner<TPrepared>;
        readonly planDequeuedMessage: ALOutboundPlanner<TPrepared>;
        readonly readDequeueAuthority?: ALOutboundDequeueAuthorityReader;
        readonly afterDequeueAdmission:
            | ((msg: ALMessage, entry: ResourceEntry) => void | Promise<void>)
            | undefined;
        readonly decodePreparedMessage: ALOutboundPreparedMessageDecoder<TPrepared>;
        readonly sendPreparedMessage: (
            prepared: TPrepared,
            phase: ALOutboundDispatchPhase,
            lifecycle: SendLifecycle
        ) => Promise<ALOutboundPreparedSendResult>;
        readonly planRepairMessage:
            | ((
                msg: ALMessage,
                request: ALOutboundRepairRequest
            ) => Promise<ALOutboundDispatchPlan<TPrepared> | undefined>)
            | undefined;
        readonly diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
        readonly settlements: ALDeliverySettlementSink | undefined;
    }
}

/**
 * One carrier's outbound owner. It routes every admission to a store lane and keeps what spans them:
 * cancellation, the settlement guard and disposal.
 *
 * - An admission (`enqueueIfAbsent`, each member of `enqueueAllIfAbsent`) goes to the lane its plan's
 *   `persist` names: the durability decision (`shouldPersistOutbox`) on every browser planner. The plan
 *   is computed once and handed to that lane's admission of the same message, so the admission never
 *   plans the message twice. The lane over the memory pair states no admission durable.
 * - Members with different durability plans stay in one logical enqueue group but route to separate store lanes.
 *   Each lane may commit its members together or individually; there is no cross-store atomicity.
 * - A control, a receipt and a retransmission go to the volatile lane when it owns the target
 *   message (a memory read), else to the durable lane.
 * - `cancel(msgId)` and `handOver(msgId)` are runtime-wide: one set of send controls serves both lanes.
 * - Only the durable lane admits foreign dequeue rows. The volatile lane names none and takes no
 *   browser lock, since Web Locks guard cross-tab IndexedDB commits and memory is per tab.
 * - The volatile lane's worker id is `${effectWorkerId}/volatile`. It sweeps its expired rows from its
 *   own work round, at most once per `AL_VOLATILE_STORE_EVICTION_INTERVAL_MS` of its clock.
 * - An ordering or supersedence track whose messages declare different durabilities is split between
 *   the lanes; no caller declares one that way.
 * - Duplicate detection is per lane: a msgId the memory lane admitted is invisible to the IndexedDB lane,
 *   and the reverse. That is sound because a message's durability is fixed by its policy, so the same
 *   msgId always resolves to the same lane. A caller that re-sent one msgId under another durability
 *   would get a second copy in the other lane, whose receipt never completes, because every control
 *   for that id goes to the memory lane first. No caller does this.
 */
export class ALOutboundMessageRuntime<TPrepared> {
    private readonly sendControls = new ALOutboundSendControls();
    private readonly durable: ALOutboundStoreLane<TPrepared>;
    private readonly volatile: ALOutboundStoreLane<TPrepared> | undefined;
    private disposed = false;
    private readonly dependencies: ALOutboundMessageRuntime.Dependencies<TPrepared>;

    constructor(dependencies: ALOutboundMessageRuntime.Dependencies<TPrepared>) {
        this.dependencies = dependencies;
        const settlements: ALOutboundSettlementEmitter = (fact) => this.emitSettlement(fact);
        this.durable = new ALOutboundStoreLane({
            lane: 'durable',
            stores: dependencies,
            workerId: dependencies.effectWorkerId,
            dequeueTypes: dependencies.dequeue.types,
            browserLocks: dependencies.browserLocks,
            evictExpired: undefined,
            runtime: dependencies,
            sendControls: this.sendControls,
            settlements
        });
        this.volatile = dependencies.volatileStores === undefined ? undefined : new ALOutboundStoreLane({
            lane: 'volatile',
            stores: dependencies.volatileStores,
            workerId: `${dependencies.effectWorkerId}/volatile`,
            dequeueTypes: new Set<string>(),
            browserLocks: undefined,
            evictExpired: dependencies.volatileStores.evictExpired,
            runtime: dependencies,
            sendControls: this.sendControls,
            settlements
        });
    }

    async ready(): Promise<void> {
        await Promise.all([this.durable.ready(), this.volatile?.ready()]);
    }

    dispose(): void {
        this.disposed = true;
        this.durable.dispose();
        this.volatile?.dispose();
        this.sendControls.dispose();
    }

    get sendSignal(): AbortSignal {
        return this.sendControls.signal;
    }

    /**
     * Cancels one message for this owner's lifetime. A message the owner never admitted is still
     * remembered, so a row later claimed for it completes without sending; a message with a live
     * attempt has that attempt's transport signal aborted. Idempotent: only the first call states the
     * `cancelled` settlement.
     */
    cancel(msgId: string): ALOutboundCancelOutcome {
        const outcome = this.sendControls.cancel(msgId);
        if (outcome === 'cancelled') {
            this.emitSettlement({ kind: 'cancelled', msgId });
        }
        return outcome;
    }

    /**
     * Hands one message to another carrier's owner (D56): aborts its live attempt, completes every later
     * effect of it silently and ends its receipt row, and states no settlement -- the message is not
     * cancelled. Idempotent; a message already cancelled or handed over is left as it is.
     */
    async handOver(msgId: string): Promise<void> {
        if (this.sendControls.handOver(msgId) === 'already-ended') {
            return;
        }
        await this.ready();
        if (this.disposed) {
            return;
        }
        await (await this.readLaneForMessage(msgId)).endReceipt(msgId);
    }

    async enqueueIfAbsent(
        msg: ALMessage,
        dispatchPlan?: ALOutboundDispatchPlan<TPrepared>
    ): Promise<ALOutboundEnqueueResult> {
        if (this.disposed) {
            return ALOutboundMessageRuntime.toDisposedEnqueueResult(msg);
        }
        await this.ready();
        if (this.disposed) {
            return ALOutboundMessageRuntime.toDisposedEnqueueResult(msg);
        }
        const admission = dispatchPlan === undefined
            ? this.planAdmission(msg)
            : { lane: this.resolveLaneForPlan(dispatchPlan), planner: () => dispatchPlan };
        const computed = await admission.lane.commit(
            this.toEnqueueDispatch(msg, admission.planner, dispatchPlan !== undefined)
        );
        return ALOutboundMessageRuntime.toEnqueueResult(computed, msg);
    }

    async retransmitAdmittedMessage(
        retransmission: ALOutboundMessageRuntime.Retransmission<TPrepared>
    ): Promise<ALOutboundEnqueueResult> {
        await this.ready();
        if (this.disposed) {
            return ALOutboundMessageRuntime.toDisposedEnqueueResult(retransmission.msg);
        }
        const lane = await this.readLaneForMessage(retransmission.msg.id.msgId);
        const computed = await lane.commit({
            msg: retransmission.msg,
            planner: () => retransmission.plan,
            intent: 'repair',
            phase: 'immediate',
            origin: 'repair',
            options: { attemptIdentity: retransmission.attemptIdentity }
        });
        return ALOutboundMessageRuntime.toEnqueueResult(computed, retransmission.msg);
    }

    /** One sender's logical group; each message is planned once, commits may split by lane or member, and results keep input order. */
    async enqueueAllIfAbsent(msgs: readonly ALMessage[]): Promise<readonly ALOutboundEnqueueResult[]> {
        if (this.disposed) {
            return msgs.map((msg) => ALOutboundMessageRuntime.toDisposedEnqueueResult(msg));
        }
        await this.ready();
        if (this.disposed) {
            return msgs.map((msg) => ALOutboundMessageRuntime.toDisposedEnqueueResult(msg));
        }
        const planned = msgs.map((msg) => {
            const { lane, planner } = this.planAdmission(msg);
            return { lane, dispatch: this.toEnqueueDispatch(msg, planner, false) };
        });
        const lanes = [...new Set(planned.map(({ lane }) => lane))];
        const members = lanes.map((lane) =>
            planned.filter((member) => member.lane === lane).map(({ dispatch }) => dispatch)
        );
        // Every lane commits its members before a throw of one of them is rethrown, as one group does.
        const settled = await Promise.allSettled(lanes.map((lane, index) => lane.commitAll(members[index]!)));
        const computed = new Map<ALOutboundDispatchAdmission.Input<TPrepared>, ALOutboundComputedDto<TPrepared>>();
        for (const [index, outcome] of settled.entries()) {
            if (outcome.status === 'rejected') {
                throw outcome.reason;
            }
            members[index]!.forEach((dispatch, position) => computed.set(dispatch, outcome.value[position]!));
        }
        return planned.map(({ dispatch }) =>
            ALOutboundMessageRuntime.toEnqueueResult(computed.get(dispatch)!, dispatch.msg)
        );
    }

    /** The source decides trust: only the trusted server of a WS client speaks for a relay it does not name. */
    async acceptControlMessage(
        msg: ALMessage,
        source: ALOutboundControlSource
    ): Promise<ALOutboundControlAdmissionResult> {
        await this.ready();
        if (this.disposed) {
            return { kind: 'not-handled' };
        }
        return await (await this.readLaneForControl(msg)).acceptControlMessage(msg, source);
    }

    /** A server receipt control about a message this owner originated; it writes the receipt row, never work. */
    async acceptReceipt(control: ALMessage): Promise<ALOutboundControlAdmissionResult> {
        await this.ready();
        if (this.disposed) {
            return { kind: 'not-handled' };
        }
        return await (await this.readLaneForControl(control)).acceptReceipt(control);
    }

    /**
     * Plans the message once, for the lane its plan names. A planner that throws is left to the durable
     * lane's admission, which plans it again and states that failure where a single send always has.
     */
    private planAdmission(msg: ALMessage): ALOutboundPlannedAdmission<TPrepared> {
        const planOutgoingMessage = this.dependencies.planOutgoingMessage;
        try {
            const plan = planOutgoingMessage(msg);
            return { lane: this.resolveLaneForPlan(plan), planner: toPlannedOnce(msg, plan, planOutgoingMessage) };
        }
        catch {
            return { lane: this.durable, planner: planOutgoingMessage };
        }
    }

    /** The lane a durable plan names, or the only lane of a runtime with one backend. */
    private resolveLaneForPlan(plan: ALOutboundDispatchPlan<TPrepared>): ALOutboundStoreLane<TPrepared> {
        return plan.persist || this.volatile === undefined ? this.durable : this.volatile;
    }

    /** A memory read, so a control about a volatile message never reaches IndexedDB. */
    private async readLaneForMessage(msgId: string): Promise<ALOutboundStoreLane<TPrepared>> {
        return this.volatile !== undefined && await this.volatile.ownsMessage(msgId) ? this.volatile : this.durable;
    }

    /** An undecodable control goes to the durable lane, which answers it `not-handled`. */
    private async readLaneForControl(control: ALMessage): Promise<ALOutboundStoreLane<TPrepared>> {
        const decoded = decodeALControlMessage(control).right;
        return decoded === undefined ? this.durable : await this.readLaneForMessage(controlTargetMsgId(decoded));
    }

    private toEnqueueDispatch(
        msg: ALMessage,
        planner: ALOutboundPlanner<TPrepared>,
        explicitPlan: boolean
    ): ALOutboundDispatchAdmission.Input<TPrepared> {
        return {
            msg,
            planner,
            intent: 'enqueue',
            phase: 'immediate',
            origin: 'send',
            options: { explicitPlan }
        };
    }

    private static toEnqueueResult<TPrepared>(
        computed: ALOutboundComputedDto<TPrepared>,
        msg: ALMessage
    ): ALOutboundEnqueueResult {
        return {
            verdict: computed.verdict,
            message: computed.msg ?? msg,
            entry: computed.entries[0],
            entries: computed.entries,
            reason: computed.reason,
            trackedReceiptAlgo: computed.trackedReceiptAlgo
        };
    }

    private static toDisposedEnqueueResult(msg: ALMessage): ALOutboundEnqueueResult {
        return {
            verdict: { kind: 'skipped', reason: 'disposed', detail: 'Outbound runtime is disposed.' },
            message: msg,
            entries: [],
            reason: 'Outbound runtime is disposed.',
            trackedReceiptAlgo: 'none'
        };
    }

    /** The one guard over every settlement this owner states: a throwing sink changes no work. */
    private emitSettlement(fact: ALOutboundSettlementFact): void {
        try {
            this.dependencies.settlements?.({
                ...fact,
                carrier: this.dependencies.carrier,
                atMs: this.dependencies.clock.nowMs()
            });
        }
        catch (error) {
            console.error('AL outbound delivery settlement sink failed', error);
        }
    }
}

/** The lane one admission goes to and the planner its admission reads the plan through. */
interface ALOutboundPlannedAdmission<TPrepared> {
    readonly lane: ALOutboundStoreLane<TPrepared>;
    readonly planner: ALOutboundPlanner<TPrepared>;
}

/** The plan the router already made for this message, so its admission does not plan it twice. */
function toPlannedOnce<TPrepared>(
    planned: ALMessage,
    plan: ALOutboundDispatchPlan<TPrepared>,
    planner: ALOutboundPlanner<TPrepared>
): ALOutboundPlanner<TPrepared> {
    return (msg, authority) =>
        msg === planned && authority === undefined
            ? plan
            : planner(msg, authority);
}
